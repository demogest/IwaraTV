import { open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { AppError, isAppError } from "./app-error";
import {
  DOWNLOAD_SEGMENT_FLOOR_BYTES,
  downloadStatePath,
  legacySegmentPaths,
  MAX_DOWNLOAD_CONNECTIONS,
  partialDownloadPath
} from "./download-files";
import { delay, discardBody, mergeHeaders, type HttpFetch } from "./http";
import { SegmentPlan, type Segment } from "./segment-plan";

/** Live view of a multi-connection download. */
export interface TransferDetail {
  /** Connections currently assigned a range. */
  connections: number;
  /** Byte ranges `[first, last]` still missing, in file order. */
  missing: Array<[number, number]>;
}

export type ProgressCallback = (bytesWritten: number, totalBytes: number | undefined, detail?: TransferDetail) => void;

export interface TransferOptions {
  fetch: HttpFetch;
  url: string;
  filePath: string;
  headers: Record<string, string>;
  maxConnections: number;
  minSplitBytes: number;
  onProgress: ProgressCallback;
  signal?: AbortSignal;
  /** A connection that receives nothing for this long is dropped and retried. */
  stallTimeoutMs?: number;
  /** Wait before the first retry of a range; doubles with each further attempt. */
  retryDelayMs?: number;
}

const STALL_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 15_000;
/** Failed attempts in a row, with no new data, before a range gives up. */
const MAX_ATTEMPTS = 6;
const STATE_SAVE_INTERVAL_MS = 1_000;
const PROGRESS_INTERVAL_MS = 100;
const STATE_VERSION = 1;
const STALLED = Symbol("stalled");
// File system failures that another attempt won't fix.
const FATAL_FS_CODES = new Set(["ENOSPC", "EDQUOT", "EFBIG", "EACCES", "EPERM", "EROFS", "EBADF", "EISDIR", "ENOENT", "EMFILE", "EIO"]);

interface DownloadProbe {
  totalBytes?: number;
  acceptsRanges: boolean;
}

interface SavedState {
  version: number;
  totalBytes: number;
  missing: Array<[number, number]>;
}

/**
 * Downloads `url` to `filePath`. When the server accepts ranges, several
 * connections fill one `.part` file in place; a connection that finishes early
 * takes over half of the largest range still in progress, dropped or stalled
 * connections retry from where they stopped, and `.part.json` records the
 * missing ranges so a later attempt resumes. Without ranges the file streams
 * over one connection. Returns the number of bytes in the finished file.
 */
export async function transferToFile(options: TransferOptions): Promise<number> {
  const probe = await probeDownload(options).catch((error: unknown) => {
    if (options.signal?.aborted) {
      throw error;
    }
    return undefined;
  });
  if (probe?.totalBytes && probe.acceptsRanges) {
    const split = probe.totalBytes >= Math.max(options.minSplitBytes, DOWNLOAD_SEGMENT_FLOOR_BYTES);
    const connections = split ? Math.min(Math.max(Math.round(options.maxConnections), 1), MAX_DOWNLOAD_CONNECTIONS) : 1;
    return downloadRanges(options, probe.totalBytes, connections);
  }
  const totalBytes = await collapseToPrefix(options.filePath, probe?.totalBytes);
  return downloadSingle(options, totalBytes);
}

async function probeDownload({ fetch, url, headers, signal }: TransferOptions): Promise<DownloadProbe> {
  const response = await fetch(url, { headers: mergeHeaders(headers, { Range: "bytes=0-0" }), signal });
  await discardBody(response);
  if (response.status === 206) {
    const range = responseRange(response);
    return {
      // Content-Length is only the probe's body length, never the file size.
      totalBytes: range?.start === 0 && range.end === 0 ? range.total : undefined,
      acceptsRanges: range?.start === 0 && range.end === 0
    };
  }
  if (!response.ok) {
    throw httpError(response.status);
  }
  return {
    totalBytes: numberHeader(response, "content-length"),
    acceptsRanges: false
  };
}

async function downloadSingle(options: TransferOptions, totalBytes: number | undefined): Promise<number> {
  const { fetch, url, filePath, headers, onProgress, signal } = options;
  const partPath = partialDownloadPath(filePath);
  let existingBytes = await fileSize(partPath);
  if (existingBytes > 0 && totalBytes !== undefined && existingBytes >= totalBytes) {
    // Size alone cannot verify a plain prefix, especially after the source shrinks.
    await rm(partPath, { force: true });
    existingBytes = 0;
  }

  let response = await fetch(url, {
    headers: existingBytes > 0 ? mergeHeaders(headers, { Range: `bytes=${existingBytes}-` }) : headers,
    signal
  });
  if (response.status === 416 && existingBytes > 0) {
    // Even bytes */N with N === existingBytes doesn't verify the old content.
    // Retry once without Range; never turn an unsatisfied range into success.
    await discardBody(response);
    await rm(partPath, { force: true });
    existingBytes = 0;
    totalBytes = undefined;
    response = await fetch(url, { headers, signal });
  }
  if (response.status !== 200 && response.status !== 206) {
    await discardBody(response);
    throw httpError(response.status);
  }

  const appending = existingBytes > 0 && response.status === 206;
  let expectedTotal = numberHeader(response, "content-length") ?? totalBytes;
  if (response.status === 206) {
    const range = responseRange(response);
    const contentLength = numberHeader(response, "content-length");
    if (!range || range.start !== (appending ? existingBytes : 0) || range.end !== range.total - 1
      || (totalBytes !== undefined && range.total !== totalBytes)
      || (contentLength !== undefined && contentLength !== range.end - range.start + 1)) {
      await discardBody(response);
      await rm(partPath, { force: true });
      throw new AppError("DOWNLOAD_FAILED", "The server returned an unexpected resume range.", { reason: "changed" });
    }
    expectedTotal = range.total;
  }
  let bytesWritten = appending ? existingBytes : 0;
  onProgress(bytesWritten, expectedTotal);
  try {
    bytesWritten = await writeBody(response, partPath, appending, bytesWritten, (written) => onProgress(written, expectedTotal), signal, expectedTotal);
  } catch (error) {
    if (isAppError(error) && error.details?.reason === "changed") {
      await rm(partPath, { force: true });
    }
    throw error;
  }

  if (bytesWritten === 0) {
    await rm(partPath, { force: true });
    throw new AppError("DOWNLOAD_FAILED", "The download finished without writing any data.", { reason: "empty" });
  }
  if (expectedTotal !== undefined && bytesWritten !== expectedTotal) {
    throw new AppError("DOWNLOAD_FAILED", "The connection closed before the file was complete.", { reason: "incomplete" });
  }
  signal?.throwIfAborted();
  await rename(partPath, filePath);
  return bytesWritten;
}

async function downloadRanges(options: TransferOptions, totalBytes: number, connections: number): Promise<number> {
  const { filePath, onProgress } = options;
  const partPath = partialDownloadPath(filePath);
  const statePath = downloadStatePath(filePath);
  const stallTimeoutMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;

  await removeLegacySegments(filePath);
  const plan = new SegmentPlan(totalBytes, await resumableRanges(partPath, statePath, totalBytes), connections, DOWNLOAD_SEGMENT_FLOOR_BYTES);
  let saving = Promise.resolve();
  const saveState = () => {
    const state: SavedState = { version: STATE_VERSION, totalBytes, missing: plan.missing() };
    saving = saving.catch(() => undefined).then(() => writeState(statePath, state));
    return saving;
  };
  // The state file comes first: a `.part` without one is read as a plain prefix.
  await saveState();
  const handle = await open(partPath, (await fileStat(partPath)) ? "r+" : "w+");

  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (force || now - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = now;
      onProgress(plan.doneBytes, totalBytes, { connections: plan.busyCount, missing: plan.missing() });
    }
  };

  // Stops every connection as soon as one hits an error that retrying won't fix.
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  /** Fetches the rest of `segment`, stopping early if another connection took over its tail. */
  const receive = async (segment: Segment): Promise<void> => {
    const request = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => request.abort(STALLED), stallTimeoutMs);
    };
    try {
      watch();
      // Work stealing can shorten segment.end while the response is in flight.
      const start = segment.next;
      const end = segment.end;
      const response = await options.fetch(options.url, {
        headers: mergeHeaders(options.headers, { Range: `bytes=${start}-${end}` }),
        signal: AbortSignal.any([signal, request.signal])
      });
      checkRangeResponse(response, start, end, totalBytes);
      const reader = response.body?.getReader();
      try {
        while (reader && segment.next <= segment.end) {
          watch();
          const { done, value } = await reader.read();
          clearTimeout(timer);
          if (done) {
            break;
          }
          const piece = value.subarray(0, segment.end - segment.next + 1);
          await handle.write(piece, 0, piece.byteLength, segment.next);
          plan.advance(segment, piece.byteLength);
          report();
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
      if (segment.next <= segment.end) {
        throw new AppError("DOWNLOAD_FAILED", "The connection closed before its range was complete.", { reason: "incomplete" });
      }
    } catch (error) {
      if (request.signal.reason === STALLED && !signal.aborted) {
        throw new AppError("DOWNLOAD_FAILED", "The server stopped sending data.", { reason: "stalled" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Returns false when the server pushed back and the other connections can carry on without this one. */
  const fetchRange = async (segment: Segment): Promise<boolean> => {
    let attempts = 0;
    while (segment.next <= segment.end) {
      const before = segment.next;
      try {
        await receive(segment);
      } catch (error) {
        if (signal.aborted || !isRetryable(error)) {
          throw error;
        }
        attempts = segment.next > before ? 1 : attempts + 1;
        if (isThrottled(error) && plan.busyCount > 1) {
          return false;
        }
        if (attempts >= MAX_ATTEMPTS) {
          throw finalError(error);
        }
        await delay(Math.min(retryDelayMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS), signal);
      }
    }
    return true;
  };

  const connection = async () => {
    for (let segment = plan.claim(); segment; segment = plan.claim()) {
      const keepGoing = await fetchRange(segment).finally(() => plan.release(segment));
      if (!keepGoing) {
        return;
      }
    }
  };

  report(true);
  const saver = setInterval(() => void saveState().catch(() => undefined), STATE_SAVE_INTERVAL_MS);
  let failure: unknown;
  try {
    if ((await handle.stat()).size !== totalBytes) {
      await handle.truncate(totalBytes);
    }
    const results = await Promise.allSettled(
      Array.from({ length: connections }, () =>
        connection().catch((error: unknown) => {
          controller.abort(error);
          throw error;
        })
      )
    );
    // The others were stopped because of the first fatal error; report that one.
    failure = controller.signal.aborted
      ? controller.signal.reason
      : results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(saver);
    await handle.close();
  }

  if (failure !== undefined || !plan.complete) {
    await saveState().catch(() => undefined);
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (isAppError(failure) && failure.details?.reason === "changed") {
      // All workers and state writes have stopped. None of these bytes are safe
      // to reuse once the server contradicts the expected representation.
      await removePartialArtifacts(filePath);
      if (failure.details.status === 200) {
        return downloadSingle(options, undefined);
      }
    }
    throw failure ?? new AppError("DOWNLOAD_FAILED", "Some ranges were never downloaded.", { reason: "incomplete" });
  }
  await saving.catch(() => undefined);
  await rename(partPath, filePath);
  await rm(statePath, { force: true });
  report(true);
  return totalBytes;
}

function responseRange(response: Response): { start: number; end: number; total: number } | undefined {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range")?.trim() ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
    ? { start, end, total }
    : undefined;
}

function checkRangeResponse(response: Response, start: number, end: number, totalBytes: number): void {
  if (response.status !== 206) {
    void discardBody(response);
    // A full 200 body or "range not satisfiable" means the file isn't the one we started.
    throw response.status === 200 || response.status === 416
      ? new AppError("DOWNLOAD_FAILED", `The server no longer serves the expected range (HTTP ${response.status}).`, { status: response.status, reason: "changed" })
      : httpError(response.status);
  }
  const range = responseRange(response);
  const contentLength = numberHeader(response, "content-length");
  if (!range || range.start !== start || range.end !== end || range.total !== totalBytes
    || (contentLength !== undefined && contentLength !== end - start + 1)) {
    void discardBody(response);
    throw new AppError("DOWNLOAD_FAILED", "The server returned an unexpected download range.", { reason: "changed" });
  }
}

function isRetryable(error: unknown): boolean {
  if (isAppError(error)) {
    const status = typeof error.details?.status === "number" ? error.details.status : undefined;
    return error.details?.reason === "stalled"
      || error.details?.reason === "incomplete"
      || (error.details?.reason === "http" && status !== undefined && (status === 408 || status === 429 || status >= 500));
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return !(typeof code === "string" && FATAL_FS_CODES.has(code));
}

function isThrottled(error: unknown): boolean {
  return isAppError(error) && (error.details?.status === 429 || error.details?.status === 503);
}

/** The error to report once a range has used up its retries. */
function finalError(error: unknown): unknown {
  if (isAppError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("DOWNLOAD_FAILED", `The connection kept failing: ${message}`, { reason: "network" });
}

/**
 * Missing ranges to resume from: the saved state when it matches this file, a
 * plain `.part` prefix left by a single-connection download, or everything.
 */
async function resumableRanges(partPath: string, statePath: string, totalBytes: number): Promise<Array<[number, number]>> {
  const everything: Array<[number, number]> = [[0, totalBytes - 1]];
  const part = await fileStat(partPath);
  const saved = await readState(statePath);
  if (!saved && await fileStat(statePath)) {
    // A damaged sidecar must not turn a preallocated sparse file into a prefix.
    await rm(partPath, { force: true });
    return everything;
  }
  if (saved) {
    // Everything outside the missing ranges must already be inside the file.
    const last = saved.missing.at(-1);
    const doneUntil = last && last[1] === totalBytes - 1 ? last[0] : totalBytes;
    if (part && saved.totalBytes === totalBytes && (!last || last[1] < totalBytes) && doneUntil <= part.size) {
      return saved.missing;
    }
    await rm(partPath, { force: true });
    return everything;
  }
  if (part && part.size < totalBytes) {
    return [[part.size, totalBytes - 1]];
  }
  await rm(partPath, { force: true });
  return everything;
}

/** Before a single-connection download: keeps only the contiguous start of a multi-connection `.part`. */
async function collapseToPrefix(filePath: string, totalBytes?: number): Promise<number | undefined> {
  await removeLegacySegments(filePath);
  const statePath = downloadStatePath(filePath);
  const saved = await readState(statePath);
  if (!saved) {
    if (await fileStat(statePath)) {
      await removePartialArtifacts(filePath);
    }
    return totalBytes;
  }
  if (totalBytes !== undefined && saved.totalBytes !== totalBytes) {
    await removePartialArtifacts(filePath);
    return totalBytes;
  }
  const partPath = partialDownloadPath(filePath);
  const part = await fileStat(partPath);
  if (part) {
    await truncate(partPath, Math.min(saved.missing[0]?.[0] ?? saved.totalBytes, part.size));
  }
  await rm(statePath, { force: true });
  return totalBytes ?? saved.totalBytes;
}

async function readState(statePath: string): Promise<SavedState | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return undefined;
  }
  const state = value as Partial<SavedState> | null;
  if (
    state?.version !== STATE_VERSION
    || !Number.isSafeInteger(state.totalBytes)
    || state.totalBytes! <= 0
    || !Array.isArray(state.missing)
    || !state.missing.every((range, index, all) =>
      Array.isArray(range)
      && range.length === 2
      && Number.isSafeInteger(range[0])
      && Number.isSafeInteger(range[1])
      && range[0] >= (index === 0 ? 0 : all[index - 1]![1] + 1)
      && range[0] <= range[1]
      && range[1] < state.totalBytes!)
  ) {
    return undefined;
  }
  return state as SavedState;
}

async function writeState(statePath: string, state: SavedState): Promise<void> {
  const tempPath = `${statePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(state));
  await rename(tempPath, statePath);
}

async function removeLegacySegments(filePath: string): Promise<void> {
  await Promise.all(legacySegmentPaths(filePath).map((segmentPath) => rm(segmentPath, { force: true })));
}

async function writeBody(
  response: Response,
  filePath: string,
  append: boolean,
  initialBytes: number,
  onBytes: (bytesWritten: number) => void,
  signal?: AbortSignal,
  expectedTotal?: number
): Promise<number> {
  const handle = await open(filePath, append ? "a" : "w");
  let bytesWritten = initialBytes;
  try {
    if (!response.body) {
      return bytesWritten;
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal?.throwIfAborted();
      if (expectedTotal !== undefined && bytesWritten + chunk.byteLength > expectedTotal) {
        throw new AppError("DOWNLOAD_FAILED", "The server sent more data than expected.", { reason: "changed" });
      }
      await handle.write(chunk);
      bytesWritten += chunk.byteLength;
      onBytes(bytesWritten);
    }
  } finally {
    await handle.close();
  }
  return bytesWritten;
}

/** Removes a finished download and any leftover partial files. */
export async function removeDownloadArtifacts(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await removePartialArtifacts(filePath);
}

/** Removes only partial files, never a finished file at the same path. */
export async function removePartialArtifacts(filePath: string): Promise<void> {
  await rm(partialDownloadPath(filePath), { force: true });
  await rm(downloadStatePath(filePath), { force: true });
  await rm(`${downloadStatePath(filePath)}.tmp`, { force: true });
  await removeLegacySegments(filePath);
}

async function fileStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function numberHeader(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function httpError(status: number): AppError {
  return new AppError("DOWNLOAD_FAILED", `Download request failed: HTTP ${status}`, { status, reason: "http" });
}

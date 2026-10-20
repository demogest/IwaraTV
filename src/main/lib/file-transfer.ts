import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm, stat, truncate } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { AppError } from "./app-error";
import {
  DOWNLOAD_SEGMENT_FLOOR_BYTES,
  downloadSegments,
  MAX_DOWNLOAD_CONNECTIONS,
  partialDownloadPath,
  segmentPartPath,
  totalBytesFromContentRange,
  type DownloadSegment
} from "./download-files";
import { discardBody, mergeHeaders, type HttpFetch } from "./http";

export type ProgressCallback = (bytesWritten: number, totalBytes: number | undefined) => void;

export interface TransferOptions {
  fetch: HttpFetch;
  url: string;
  filePath: string;
  headers: Record<string, string>;
  maxConnections: number;
  minSplitBytes: number;
  onProgress: ProgressCallback;
  signal?: AbortSignal;
}

interface DownloadProbe {
  totalBytes?: number;
  acceptsRanges: boolean;
}

/**
 * Downloads `url` to `filePath`, resuming from `.part` files when present and
 * splitting large files into parallel ranged requests when the server allows.
 * Returns the number of bytes in the finished file.
 */
export async function transferToFile(options: TransferOptions): Promise<number> {
  const probe = await probeDownload(options).catch((error: unknown) => {
    if (options.signal?.aborted) {
      throw error;
    }
    return undefined;
  });
  const connections = Math.min(Math.max(Math.round(options.maxConnections), 1), MAX_DOWNLOAD_CONNECTIONS);
  if (
    probe?.totalBytes
    && probe.acceptsRanges
    && connections > 1
    && probe.totalBytes >= Math.max(options.minSplitBytes, DOWNLOAD_SEGMENT_FLOOR_BYTES)
  ) {
    return downloadSegmented(options, probe.totalBytes, connections);
  }
  return downloadSingle(options, probe?.totalBytes);
}

async function probeDownload({ fetch, url, headers, signal }: TransferOptions): Promise<DownloadProbe> {
  const response = await fetch(url, { headers: mergeHeaders(headers, { Range: "bytes=0-0" }), signal });
  await discardBody(response);
  if (response.status === 206) {
    return {
      totalBytes: totalBytesFromContentRange(response.headers.get("content-range")) ?? numberHeader(response, "content-length"),
      acceptsRanges: true
    };
  }
  if (!response.ok) {
    throw httpError(response.status);
  }
  return {
    totalBytes: numberHeader(response, "content-length"),
    acceptsRanges: response.headers.get("accept-ranges")?.toLowerCase() === "bytes"
  };
}

async function downloadSingle(options: TransferOptions, totalBytes: number | undefined): Promise<number> {
  const { fetch, url, filePath, headers, onProgress, signal } = options;
  const partPath = partialDownloadPath(filePath);
  const existingBytes = await fileSize(partPath);
  if (existingBytes > 0 && totalBytes !== undefined && existingBytes >= totalBytes) {
    await rename(partPath, filePath);
    onProgress(existingBytes, totalBytes);
    return existingBytes;
  }

  const response = await fetch(url, {
    headers: existingBytes > 0 ? mergeHeaders(headers, { Range: `bytes=${existingBytes}-` }) : headers,
    signal
  });
  if (response.status === 416 && existingBytes > 0) {
    // The partial file already holds everything the server has.
    await discardBody(response);
    await rename(partPath, filePath);
    onProgress(existingBytes, existingBytes);
    return existingBytes;
  }
  if (!response.ok) {
    await discardBody(response);
    throw httpError(response.status);
  }

  const appending = existingBytes > 0 && response.status === 206;
  let bytesWritten = appending ? existingBytes : 0;
  const expectedTotal = totalBytes ?? (appending ? undefined : numberHeader(response, "content-length"));
  onProgress(bytesWritten, expectedTotal);
  bytesWritten = await writeBody(response, partPath, appending, bytesWritten, (written) => onProgress(written, expectedTotal), signal);

  if (bytesWritten === 0) {
    await rm(partPath, { force: true });
    throw new AppError("DOWNLOAD_FAILED", "The download finished without writing any data.", { reason: "empty" });
  }
  await rename(partPath, filePath);
  return bytesWritten;
}

async function downloadSegmented(options: TransferOptions, totalBytes: number, connections: number): Promise<number> {
  const { filePath, onProgress } = options;
  const segments = downloadSegments(totalBytes, connections);
  let progressBytes = 0;
  for (const segment of segments) {
    progressBytes += Math.min(await fileSize(segmentPartPath(filePath, segment.index)), segmentLength(segment));
  }
  onProgress(progressBytes, totalBytes);

  // Stop sibling segments as soon as one fails; finished bytes stay on disk for resume.
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const results = await Promise.allSettled(
    segments.map((segment) =>
      downloadSegment(options, segment, signal, (delta) => {
        progressBytes += delta;
        onProgress(Math.min(progressBytes, totalBytes), totalBytes);
      }).catch((error: unknown) => {
        controller.abort(error);
        throw error;
      })
    )
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    throw options.signal?.aborted ? options.signal.reason : failure.reason;
  }

  await mergeSegments(filePath, segments);
  onProgress(totalBytes, totalBytes);
  return totalBytes;
}

async function downloadSegment(
  options: TransferOptions,
  segment: DownloadSegment,
  signal: AbortSignal,
  onDelta: (bytes: number) => void
): Promise<void> {
  const partPath = segmentPartPath(options.filePath, segment.index);
  const expectedLength = segmentLength(segment);
  let existingLength = await fileSize(partPath);
  if (existingLength > expectedLength) {
    await truncate(partPath, expectedLength);
    existingLength = expectedLength;
  }
  if (existingLength === expectedLength) {
    return;
  }

  const response = await options.fetch(options.url, {
    headers: mergeHeaders(options.headers, { Range: `bytes=${segment.start + existingLength}-${segment.end}` }),
    signal
  });
  if (response.status !== 206) {
    await discardBody(response);
    throw new AppError("DOWNLOAD_FAILED", `Segment request failed: HTTP ${response.status}`, { status: response.status, reason: "http" });
  }

  let lastReported = existingLength;
  const written = await writeBody(response, partPath, existingLength > 0, existingLength, (current) => {
    onDelta(current - lastReported);
    lastReported = current;
  }, signal);
  if (written !== expectedLength) {
    throw new AppError("DOWNLOAD_FAILED", `Segment ${segment.index + 1} is incomplete: ${written} / ${expectedLength} bytes.`, { reason: "incomplete" });
  }
}

async function writeBody(
  response: Response,
  filePath: string,
  append: boolean,
  initialBytes: number,
  onBytes: (bytesWritten: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const handle = await open(filePath, append ? "a" : "w");
  let bytesWritten = initialBytes;
  try {
    if (!response.body) {
      return bytesWritten;
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal?.throwIfAborted();
      await handle.write(chunk);
      bytesWritten += chunk.byteLength;
      onBytes(bytesWritten);
    }
  } finally {
    await handle.close();
  }
  return bytesWritten;
}

/** Joins the segments into `.part` first, so an interrupted merge never looks like a finished file. */
async function mergeSegments(filePath: string, segments: DownloadSegment[]): Promise<void> {
  const mergedPath = partialDownloadPath(filePath);
  const output = createWriteStream(mergedPath);
  try {
    for (const segment of segments) {
      await pipeline(createReadStream(segmentPartPath(filePath, segment.index)), output, { end: false });
    }
  } finally {
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }
  await rename(mergedPath, filePath);
  for (const segment of segments) {
    await rm(segmentPartPath(filePath, segment.index), { force: true });
  }
}

/** Removes a finished download and any leftover partial files. */
export async function removeDownloadArtifacts(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await removePartialArtifacts(filePath);
}

/** Removes only `.part` files, never a finished file at the same path. */
export async function removePartialArtifacts(filePath: string): Promise<void> {
  await rm(partialDownloadPath(filePath), { force: true });
  for (let index = 0; index < MAX_DOWNLOAD_CONNECTIONS; index += 1) {
    await rm(segmentPartPath(filePath, index), { force: true });
  }
}

function segmentLength(segment: DownloadSegment): number {
  return segment.end - segment.start + 1;
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

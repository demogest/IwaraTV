import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadStatePath, legacySegmentPaths, partialDownloadPath } from "../src/main/lib/download-files";
import { transferToFile, type TransferDetail } from "../src/main/lib/file-transfer";
import type { HttpFetch } from "../src/main/lib/http";
import { DownloadManager, type DownloadEngine } from "../src/main/services/download-manager";
import type { DownloadPlan } from "../src/main/services/iwara-client";
import type { DownloadState, VideoFormat } from "../src/shared/types";
import { tempDir } from "./helpers";

const PAYLOAD = randomBytes(3 * 1024 * 1024 + 123);
// Large enough that a free connection takes over part of a slow one.
const BIG = randomBytes(8 * 1024 * 1024);
const MIB = 1024 * 1024;
let server: Server;
let baseUrl = "";
const requests: Array<{ path: string; range?: string; status?: number }> = [];
// Ranges that already failed once on the flaky paths.
const failedOnce = new Set<string>();
const activeByPath = new Map<string, number>();

/** Sends `body` in `chunk`-byte pieces every `intervalMs`. */
function sendSlowly(response: ServerResponse, body: Buffer, chunk: number, intervalMs: number) {
  let offset = 0;
  const timer = setInterval(() => {
    const piece = body.subarray(offset, offset + chunk);
    offset += piece.length;
    if (offset >= body.length) {
      clearInterval(timer);
      response.end(piece);
    } else {
      response.write(piece);
    }
  }, intervalMs);
  response.on("close", () => clearInterval(timer));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const range = request.headers.range;
    const entry: { path: string; range?: string; status?: number } = { path: url.pathname, range };
    requests.push(entry);
    const payload = url.pathname.startsWith("/big") ? BIG : PAYLOAD;
    if (url.pathname === "/forbidden") {
      response.writeHead(403).end();
      return;
    }
    if (url.pathname === "/no-range" || !range) {
      response.writeHead(200, { "Content-Length": payload.length, "Accept-Ranges": url.pathname === "/no-range" ? "none" : "bytes" });
      response.end(payload);
      return;
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : payload.length - 1;
    if (start >= payload.length) {
      response.writeHead(416, { "Content-Range": `bytes */${payload.length}` }).end();
      return;
    }
    const probe = range === "bytes=0-0";
    if (!probe && url.pathname === "/expired") {
      entry.status = 403;
      response.writeHead(403).end();
      return;
    }
    if (!probe && url.pathname === "/one-at-a-time") {
      // Allows a single connection; extra ones are turned away.
      if ((activeByPath.get(url.pathname) ?? 0) > 0) {
        entry.status = 503;
        response.writeHead(503).end();
        return;
      }
      activeByPath.set(url.pathname, 1);
      response.on("close", () => activeByPath.set(url.pathname, 0));
    }
    const body = payload.subarray(start, end + 1);
    entry.status = 206;
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${payload.length}`,
      "Content-Length": body.length,
      "Accept-Ranges": "bytes"
    });
    // Retries resume mid-range, so a range is known by its end.
    const key = `${url.pathname} ${end}`;
    if (!probe && url.pathname === "/flaky" && !failedOnce.has(key)) {
      // Drops the connection halfway through the first attempt at each range.
      failedOnce.add(key);
      response.write(body.subarray(0, Math.floor(body.length / 2)), () => response.destroy());
      return;
    }
    if (!probe && url.pathname === "/stall" && !failedOnce.has(key)) {
      // Sends a little, then goes quiet on the first attempt at each range.
      failedOnce.add(key);
      response.write(body.subarray(0, 1000));
      return;
    }
    if (!probe && url.pathname === "/big-slow-tail" && start === BIG.length / 2) {
      sendSlowly(response, body, 64 * 1024, 10);
      return;
    }
    if (!probe && (url.pathname === "/slow" || url.pathname === "/one-at-a-time")) {
      sendSlowly(response, body, 16 * 1024, 20);
      return;
    }
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const nodeFetch: HttpFetch = (url, init) => fetch(url, init);

function transfer(filePath: string, urlPath: string, options: { maxConnections?: number; signal?: AbortSignal; stallTimeoutMs?: number } = {}) {
  const progress: number[] = [];
  const details: TransferDetail[] = [];
  return {
    progress,
    details,
    result: transferToFile({
      fetch: nodeFetch,
      url: `${baseUrl}${urlPath}`,
      filePath,
      headers: {},
      maxConnections: options.maxConnections ?? 1,
      minSplitBytes: MIB,
      onProgress: (bytes, _total, detail) => {
        progress.push(bytes);
        if (detail) {
          details.push(detail);
        }
      },
      signal: options.signal,
      stallTimeoutMs: options.stallTimeoutMs,
      retryDelayMs: 5
    })
  };
}

function rangeRequests(urlPath: string) {
  return requests.filter((request) => request.path === urlPath && request.range && request.range !== "bytes=0-0");
}

function leftovers(filePath: string): string[] {
  return [partialDownloadPath(filePath), downloadStatePath(filePath), ...legacySegmentPaths(filePath)].filter((file) => existsSync(file));
}

describe("transferToFile", () => {
  it("downloads with a single connection", async () => {
    const filePath = path.join(tempDir("dl-single"), "video.mp4");
    const { result, progress } = transfer(filePath, "/video", { maxConnections: 1 });
    expect(await result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(leftovers(filePath)).toEqual([]);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
  });

  it("fills one file from parallel ranged requests", async () => {
    const filePath = path.join(tempDir("dl-segmented"), "video.mp4");
    requests.length = 0;
    const { result, details } = transfer(filePath, "/segmented", { maxConnections: 4 });
    expect(await result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    // 3 MiB with 1 MiB minimum pieces: three connections.
    expect(rangeRequests("/segmented")).toHaveLength(3);
    expect(details.at(-1)).toEqual({ connections: 0, missing: [] });
    expect(leftovers(filePath)).toEqual([]);
  });

  it("takes over half of a slow connection's range", async () => {
    const filePath = path.join(tempDir("dl-steal"), "video.mp4");
    requests.length = 0;
    expect(await transfer(filePath, "/big-slow-tail", { maxConnections: 2 }).result).toBe(BIG.length);
    expect(readFileSync(filePath).equals(BIG)).toBe(true);
    const starts = rangeRequests("/big-slow-tail").map((request) => Number(/bytes=(\d+)-/.exec(request.range!)![1]));
    expect(starts.slice(0, 2).sort((a, b) => a - b)).toEqual([0, BIG.length / 2]);
    // The fast connection moved on to the back of the slow one's range.
    expect(starts.length).toBeGreaterThan(2);
    expect(starts.slice(2).every((start) => start > BIG.length / 2)).toBe(true);
  });

  it("retries a dropped connection from where it stopped", async () => {
    const filePath = path.join(tempDir("dl-flaky"), "video.mp4");
    requests.length = 0;
    expect(await transfer(filePath, "/flaky", { maxConnections: 3 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    const ranges = rangeRequests("/flaky").map((request) => request.range);
    expect(ranges).toHaveLength(6);
    expect(ranges.some((range) => range?.startsWith("bytes=0-"))).toBe(true);
    // Retries continue after the half that arrived.
    expect(ranges.filter((range) => range?.startsWith("bytes=0-"))).toHaveLength(1);
  });

  it("drops a stalled connection and tries again", async () => {
    const filePath = path.join(tempDir("dl-stall"), "video.mp4");
    requests.length = 0;
    expect(await transfer(filePath, "/stall", { maxConnections: 2, stallTimeoutMs: 150 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(rangeRequests("/stall").length).toBeGreaterThan(2);
  });

  it("carries on with fewer connections when the server turns extra ones away", async () => {
    const filePath = path.join(tempDir("dl-limit"), "video.mp4");
    requests.length = 0;
    expect(await transfer(filePath, "/one-at-a-time", { maxConnections: 3 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(rangeRequests("/one-at-a-time").some((request) => request.status === 503)).toBe(true);
  });

  it("fails at once when the link is refused, keeping what it has", async () => {
    const filePath = path.join(tempDir("dl-expired"), "video.mp4");
    requests.length = 0;
    await expect(transfer(filePath, "/expired", { maxConnections: 3 }).result).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      details: { status: 403, reason: "http" }
    });
    expect(rangeRequests("/expired").length).toBeLessThanOrEqual(3);
    expect(existsSync(downloadStatePath(filePath))).toBe(true);
  });

  it("saves the missing ranges when canceled and resumes them later", async () => {
    const filePath = path.join(tempDir("dl-cancel-resume"), "video.mp4");
    const controller = new AbortController();
    const first = transfer(filePath, "/slow", { maxConnections: 3, signal: controller.signal });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if ((first.progress.at(-1) ?? 0) > 200 * 1024) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    expect(first.details.at(-1)!.connections).toBe(3);
    expect(first.details.at(-1)!.missing).toHaveLength(3);
    controller.abort(new Error("stop"));
    await expect(first.result).rejects.toThrow("stop");
    const saved = JSON.parse(readFileSync(downloadStatePath(filePath), "utf8")) as { missing: Array<[number, number]> };
    const missingBytes = saved.missing.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    expect(missingBytes).toBeLessThan(PAYLOAD.length);
    expect(saved.missing.length).toBe(3);

    requests.length = 0;
    const second = transfer(filePath, "/video", { maxConnections: 3 });
    expect(await second.result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(second.progress[0]).toBe(PAYLOAD.length - missingBytes);
    const resumedStarts = rangeRequests("/video").map((request) => Number(/bytes=(\d+)-/.exec(request.range!)![1]));
    expect(resumedStarts.sort((a, b) => a - b)).toEqual(saved.missing.map(([start]) => start));
    expect(leftovers(filePath)).toEqual([]);
  });

  it("continues a single-connection .part file with several connections", async () => {
    const filePath = path.join(tempDir("dl-resume-prefix"), "video.mp4");
    writeFileSync(partialDownloadPath(filePath), PAYLOAD.subarray(0, 4096));
    requests.length = 0;
    const { result, progress } = transfer(filePath, "/prefix", { maxConnections: 3 });
    expect(await result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(progress[0]).toBe(4096);
    expect(rangeRequests("/prefix").every((request) => !request.range!.startsWith("bytes=0-"))).toBe(true);
  });

  it("resumes a single-connection download from its .part file", async () => {
    const filePath = path.join(tempDir("dl-resume-single"), "video.mp4");
    writeFileSync(partialDownloadPath(filePath), PAYLOAD.subarray(0, 4096));
    requests.length = 0;
    expect(await transfer(filePath, "/single-resume", { maxConnections: 1 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(rangeRequests("/single-resume").map((request) => request.range)).toEqual([`bytes=4096-${PAYLOAD.length - 1}`]);
  });

  it("starts over when only part files from older versions exist", async () => {
    const filePath = path.join(tempDir("dl-legacy"), "video.mp4");
    for (const legacyPath of legacySegmentPaths(filePath).slice(0, 3)) {
      writeFileSync(legacyPath, Buffer.from("old segment"));
    }
    expect(await transfer(filePath, "/legacy", { maxConnections: 4 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(leftovers(filePath)).toEqual([]);
  });

  it("restarts cleanly when the server ignores ranges", async () => {
    const filePath = path.join(tempDir("dl-norange"), "video.mp4");
    writeFileSync(partialDownloadPath(filePath), Buffer.from("stale data"));
    expect(await transfer(filePath, "/no-range", { maxConnections: 4 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
  });

  it("keeps only the finished start of a multi-connection .part when ranges stop working", async () => {
    const filePath = path.join(tempDir("dl-collapse"), "video.mp4");
    const partial = Buffer.alloc(PAYLOAD.length);
    PAYLOAD.copy(partial, 0, 0, 5000);
    writeFileSync(partialDownloadPath(filePath), partial);
    writeFileSync(downloadStatePath(filePath), JSON.stringify({ version: 1, totalBytes: PAYLOAD.length, missing: [[5000, PAYLOAD.length - 1]] }));
    requests.length = 0;
    expect(await transfer(filePath, "/no-range", { maxConnections: 4 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(requests.find((request) => request.path === "/no-range" && request.range !== "bytes=0-0")?.range).toBe("bytes=5000-");
    expect(leftovers(filePath)).toEqual([]);
  });

  it("reports HTTP errors with a download error code", async () => {
    const filePath = path.join(tempDir("dl-403"), "video.mp4");
    await expect(transfer(filePath, "/forbidden").result).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { status: 403 } });
  });

  it("stops when aborted and keeps partial data", async () => {
    const filePath = path.join(tempDir("dl-abort"), "video.mp4");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(transfer(filePath, "/video", { signal: controller.signal }).result).rejects.toThrow("stop");
  });
});

// --- DownloadManager ------------------------------------------------------------

function format(): VideoFormat {
  return { id: "Source", label: "Source", url: "https://x.iwara.tv/v.mp4", qualityRank: 4000 };
}

function fakeEngine(directory: string, options: { fail?: (videoId: string) => boolean; hold?: boolean } = {}) {
  const releases = new Map<string, () => void>();
  const engine: DownloadEngine = {
    async prepare(request) {
      return {
        path: path.join(directory, `${request.videoId}.mp4`),
        format: format(),
        video: { id: request.videoId, title: `Video ${request.videoId}`, tags: [], numViews: 0, numLikes: 0, numComments: 0, formats: [format()] },
        fallbackFrom: request.quality === "2160" ? "2160" : undefined
      } satisfies DownloadPlan;
    },
    async transfer(plan, onProgress, signal) {
      onProgress(10, 100);
      if (options.hold) {
        await new Promise<void>((resolve, reject) => {
          releases.set(plan.video.id, resolve);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (options.fail?.(plan.video.id)) {
        throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
      }
      writeFileSync(plan.path, "video");
      onProgress(100, 100);
      return 100;
    }
  };
  return { engine, release: (id: string) => releases.get(id)?.() };
}

function waitFor(manager: DownloadManager, predicate: (state: DownloadState) => boolean): Promise<DownloadState> {
  return new Promise((resolve) => {
    if (predicate(manager.state())) {
      resolve(manager.state());
      return;
    }
    const stop = manager.onChange((state) => {
      if (predicate(state)) {
        stop();
        resolve(state);
      }
    });
  });
}

describe("DownloadManager", () => {
  it("completes downloads and persists history", async () => {
    const dir = tempDir("manager-complete");
    const manager = new DownloadManager(dir, fakeEngine(dir).engine);
    const task = manager.start({ videoId: "a", quality: "2160" });
    expect(manager.start({ videoId: "a", quality: "2160" }).id).toBe(task.id);
    const state = await waitFor(manager, (current) => current.history.length === 1);
    expect(state.history[0]).toMatchObject({ id: task.id, status: "completed", bytesWritten: 100, fallbackFrom: "2160" });
    expect(new DownloadManager(dir, fakeEngine(dir).engine).state().history[0]!.id).toBe(task.id);
  });

  it("limits concurrency and processes the queue in order", async () => {
    const dir = tempDir("manager-queue");
    const { engine, release } = fakeEngine(dir, { hold: true });
    const manager = new DownloadManager(dir, engine, () => 2);
    manager.start({ videoId: "a" });
    manager.start({ videoId: "b" });
    manager.start({ videoId: "c" });
    await waitFor(manager, (state) => state.active.filter((task) => task.status === "downloading").length === 2);
    expect(manager.state().active.find((task) => task.videoId === "c")!.status).toBe("queued");
    release("a");
    await waitFor(manager, (state) => state.active.find((task) => task.videoId === "c")?.status === "downloading");
    release("b");
    release("c");
    await waitFor(manager, (state) => state.history.length === 3);
  });

  it("applies a new concurrency limit to the waiting queue", async () => {
    const dir = tempDir("manager-limit");
    const { engine, release } = fakeEngine(dir, { hold: true });
    let limit = 1;
    const manager = new DownloadManager(dir, engine, () => limit);
    manager.start({ videoId: "a" });
    manager.start({ videoId: "b" });
    manager.start({ videoId: "c" });
    await waitFor(manager, (state) => state.active.some((task) => task.status === "downloading"));
    expect(manager.state().active.filter((task) => task.status === "queued")).toHaveLength(2);
    limit = 3;
    manager.pump();
    await waitFor(manager, (state) => state.active.every((task) => task.status === "downloading"));
    release("a");
    release("b");
    release("c");
    await waitFor(manager, (state) => state.history.length === 3);
  });

  it("shows connections and missing ranges only while downloading", async () => {
    const dir = tempDir("manager-live");
    let finish: () => void = () => undefined;
    const engine: DownloadEngine = {
      prepare: fakeEngine(dir).engine.prepare,
      async transfer(plan, onProgress) {
        onProgress(40, 100, { connections: 3, missing: [[40, 99]] });
        await new Promise<void>((resolve) => (finish = resolve));
        writeFileSync(plan.path, "video");
        return 100;
      }
    };
    const manager = new DownloadManager(dir, engine);
    manager.start({ videoId: "a" });
    const running = await waitFor(manager, (state) => state.active[0]?.connections === 3);
    expect(running.active[0]).toMatchObject({ bytesWritten: 40, totalBytes: 100, missingRanges: [[40, 99]] });
    finish();
    const done = await waitFor(manager, (state) => state.history.length === 1);
    expect(done.history[0]).not.toHaveProperty("connections");
    expect(done.history[0]).not.toHaveProperty("missingRanges");
    expect(done.history[0]).not.toHaveProperty("bytesPerSecond");
  });

  it("cancels, then resumes the same task on retry", async () => {
    const dir = tempDir("manager-cancel");
    const { engine, release } = fakeEngine(dir, { hold: true });
    const manager = new DownloadManager(dir, engine);
    const task = manager.start({ videoId: "a" });
    await waitFor(manager, (state) => state.active[0]?.status === "downloading");
    manager.cancel(task.id);
    const canceled = await waitFor(manager, (state) => state.history[0]?.status === "canceled");
    expect(canceled.active).toHaveLength(0);

    expect(manager.retry(task.id).id).toBe(task.id);
    expect(manager.state().history).toHaveLength(0);
    await waitFor(manager, (state) => state.active[0]?.status === "downloading");
    release("a");
    const done = await waitFor(manager, (state) => state.history[0]?.status === "completed");
    expect(done.history).toHaveLength(1);
  });

  it("records failures with an error code", async () => {
    const dir = tempDir("manager-fail");
    const manager = new DownloadManager(dir, fakeEngine(dir, { fail: () => true }).engine);
    manager.start({ videoId: "a" });
    const state = await waitFor(manager, (current) => current.history.length === 1);
    expect(state.history[0]).toMatchObject({ status: "failed", errorCode: "NETWORK_ERROR", error: "boom" });
  });

  it("only deletes files that belong to the removed record", async () => {
    const dir = tempDir("manager-delete");
    const manager = new DownloadManager(dir, fakeEngine(dir, { fail: (id) => id === "b" }).engine);
    manager.start({ videoId: "a" });
    await waitFor(manager, (state) => state.history.length === 1);
    const completed = manager.state().history[0]!;
    // A failed record that points at a path now holding a finished file.
    manager.start({ videoId: "b" });
    await waitFor(manager, (state) => state.history.length === 2);
    const failed = manager.state().history.find((task) => task.status === "failed")!;
    writeFileSync(failed.path!, "someone else's finished file");
    writeFileSync(partialDownloadPath(failed.path!), "partial");

    await manager.delete({ id: failed.id, deleteFile: true });
    expect(existsSync(failed.path!)).toBe(true);
    expect(existsSync(partialDownloadPath(failed.path!))).toBe(false);

    await expect(manager.delete({ id: "missing", deleteFile: true })).resolves.toBeDefined();
    await manager.delete({ id: completed.id, deleteFile: false });
    expect(existsSync(completed.path!)).toBe(true);
  });

  it("never deletes partial files that a running download is resuming", async () => {
    const dir = tempDir("manager-resume-delete");
    let attempts = 0;
    const { engine, release } = fakeEngine(dir, { hold: true, fail: () => ++attempts === 1 });
    const manager = new DownloadManager(dir, engine);
    const first = manager.start({ videoId: "a" });
    await waitFor(manager, (state) => state.active[0]?.status === "downloading");
    release("a");
    await waitFor(manager, (state) => state.history[0]?.status === "failed");
    // Downloading again resumes the same .part file; removing the old record must not delete it.
    manager.start({ videoId: "a" });
    const running = await waitFor(manager, (state) => state.active[0]?.status === "downloading");
    writeFileSync(partialDownloadPath(running.active[0]!.path!), "in progress");
    await manager.delete({ id: first.id, deleteFile: true });
    expect(existsSync(partialDownloadPath(running.active[0]!.path!))).toBe(true);
    release("a");
    await waitFor(manager, (state) => state.history[0]?.status === "completed");
  });

  it("gives concurrent downloads of the same file different paths", async () => {
    const dir = tempDir("manager-same-path");
    const releases: Array<() => void> = [];
    const engine: DownloadEngine = {
      async prepare(request, _signal, inUse) {
        // Both qualities fall back to the same format, as a real engine would.
        const base = path.join(dir, "a - Source.mp4");
        const target = inUse.has(base) ? path.join(dir, "a - Source (1).mp4") : base;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { path: target, format: format(), video: { id: request.videoId, title: "A", tags: [], numViews: 0, numLikes: 0, numComments: 0, formats: [format()] } };
      },
      async transfer(plan) {
        await new Promise<void>((resolve) => releases.push(resolve));
        writeFileSync(plan.path, "video");
        return 5;
      }
    };
    const manager = new DownloadManager(dir, engine);
    manager.start({ videoId: "a", quality: "1080" });
    manager.start({ videoId: "a", quality: "Source" });
    const state = await waitFor(manager, (current) => current.active.filter((task) => task.status === "downloading").length === 2);
    expect(new Set(state.active.map((task) => task.path)).size).toBe(2);
    releases.forEach((resolve) => resolve());
    await waitFor(manager, (current) => current.history.length === 2);
  });

  it("refuses to delete active downloads and records them as canceled on shutdown", async () => {
    const dir = tempDir("manager-shutdown");
    const { engine } = fakeEngine(dir, { hold: true });
    const manager = new DownloadManager(dir, engine);
    const task = manager.start({ videoId: "a" });
    await waitFor(manager, (state) => state.active[0]?.status === "downloading");
    await expect(manager.delete({ id: task.id, deleteFile: true })).rejects.toMatchObject({ code: "DOWNLOAD_ACTIVE" });
    manager.shutdown();
    const restored = new DownloadManager(dir, engine).state();
    expect(restored.active).toHaveLength(0);
    expect(restored.history[0]).toMatchObject({ id: task.id, status: "canceled" });
  });

  it("clears finished records without touching files", async () => {
    const dir = tempDir("manager-clear");
    const manager = new DownloadManager(dir, fakeEngine(dir).engine);
    manager.start({ videoId: "a" });
    const state = await waitFor(manager, (current) => current.history.length === 1);
    expect(manager.clearFinished().history).toHaveLength(0);
    expect(existsSync(state.history[0]!.path!)).toBe(true);
  });
});

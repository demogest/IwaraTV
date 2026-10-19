import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { partialDownloadPath, segmentPartPath } from "../src/main/lib/download-files";
import { transferToFile } from "../src/main/lib/file-transfer";
import type { HttpFetch } from "../src/main/lib/http";
import { DownloadManager, type DownloadEngine } from "../src/main/services/download-manager";
import type { DownloadPlan } from "../src/main/services/iwara-client";
import type { DownloadState, VideoFormat } from "../src/shared/types";
import { tempDir } from "./helpers";

const PAYLOAD = randomBytes(3 * 1024 * 1024 + 123);
let server: Server;
let baseUrl = "";
const requests: Array<{ path: string; range?: string }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const range = request.headers.range;
    requests.push({ path: url.pathname, range });
    if (url.pathname === "/forbidden") {
      response.writeHead(403).end();
      return;
    }
    if (url.pathname === "/no-range" || !range) {
      response.writeHead(200, { "Content-Length": PAYLOAD.length, "Accept-Ranges": url.pathname === "/no-range" ? "none" : "bytes" });
      response.end(PAYLOAD);
      return;
    }
    const match = /bytes=(\d+)-(\d*)/.exec(range)!;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : PAYLOAD.length - 1;
    if (start >= PAYLOAD.length) {
      response.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` }).end();
      return;
    }
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}`,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes"
    });
    response.end(PAYLOAD.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const nodeFetch: HttpFetch = (url, init) => fetch(url, init);

function transfer(filePath: string, urlPath: string, options: { maxConnections?: number; signal?: AbortSignal } = {}) {
  const progress: number[] = [];
  return {
    progress,
    result: transferToFile({
      fetch: nodeFetch,
      url: `${baseUrl}${urlPath}`,
      filePath,
      headers: {},
      maxConnections: options.maxConnections ?? 1,
      minSplitBytes: 1024 * 1024,
      onProgress: (bytes) => progress.push(bytes),
      signal: options.signal
    })
  };
}

describe("transferToFile", () => {
  it("downloads with a single connection", async () => {
    const filePath = path.join(tempDir("dl-single"), "video.mp4");
    const { result, progress } = transfer(filePath, "/video", { maxConnections: 1 });
    expect(await result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(existsSync(partialDownloadPath(filePath))).toBe(false);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
  });

  it("splits large files across parallel ranged requests", async () => {
    const filePath = path.join(tempDir("dl-segmented"), "video.mp4");
    requests.length = 0;
    expect(await transfer(filePath, "/segmented", { maxConnections: 4 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(requests.filter((request) => request.path === "/segmented" && request.range !== "bytes=0-0")).toHaveLength(3);
    for (let index = 0; index < 8; index += 1) {
      expect(existsSync(segmentPartPath(filePath, index))).toBe(false);
    }
  });

  it("resumes segments from existing part files", async () => {
    const filePath = path.join(tempDir("dl-resume-seg"), "video.mp4");
    // First segment fully present, second partially.
    const segmentSize = Math.ceil(PAYLOAD.length / 3);
    writeFileSync(segmentPartPath(filePath, 0), PAYLOAD.subarray(0, segmentSize));
    writeFileSync(segmentPartPath(filePath, 1), PAYLOAD.subarray(segmentSize, segmentSize + 1000));
    requests.length = 0;
    expect(await transfer(filePath, "/resume", { maxConnections: 3 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(requests.some((request) => request.range === `bytes=${segmentSize + 1000}-${segmentSize * 2 - 1}`)).toBe(true);
    expect(requests.some((request) => request.range?.startsWith("bytes=0-") && request.range !== "bytes=0-0")).toBe(false);
  });

  it("resumes a single-connection download from its .part file", async () => {
    const filePath = path.join(tempDir("dl-resume-single"), "video.mp4");
    writeFileSync(partialDownloadPath(filePath), PAYLOAD.subarray(0, 4096));
    requests.length = 0;
    expect(await transfer(filePath, "/single-resume", { maxConnections: 1 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
    expect(requests.some((request) => request.range === "bytes=4096-")).toBe(true);
  });

  it("restarts cleanly when the server ignores ranges", async () => {
    const filePath = path.join(tempDir("dl-norange"), "video.mp4");
    writeFileSync(partialDownloadPath(filePath), Buffer.from("stale data"));
    expect(await transfer(filePath, "/no-range", { maxConnections: 4 }).result).toBe(PAYLOAD.length);
    expect(readFileSync(filePath).equals(PAYLOAD)).toBe(true);
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
    const manager = new DownloadManager(dir, engine, 2);
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

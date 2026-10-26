import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadStatePath, partialDownloadPath } from "../src/main/lib/download-files";
import { transferToFile } from "../src/main/lib/file-transfer";
import { tempDir } from "./helpers";

const DATA = randomBytes(3 * 1024 * 1024 + 123);
const PREFIX = 4096;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function full(response: ServerResponse, data = DATA) {
  response.writeHead(200, { "Content-Length": data.length }).end(data);
}

function ranged(response: ServerResponse, start: number, end = DATA.length - 1, total = DATA.length) {
  const body = DATA.subarray(start, end + 1);
  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Length": body.length
  }).end(body);
}

async function fixture(reply: (request: IncomingMessage, response: ServerResponse, index: number) => void, maxConnections = 3) {
  const filePath = path.join(tempDir("resume-integrity"), "video.mp4");
  const ranges: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    reply(request, response, ranges.length - 1);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const progress: Array<[number, number | undefined]> = [];
  return {
    filePath,
    ranges,
    progress,
    run: () => transferToFile({
      fetch: (url, init) => fetch(url, init),
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/video`,
      filePath,
      headers: {},
      maxConnections,
      minSplitBytes: 1024 * 1024,
      retryDelayMs: 1,
      onProgress: (bytes, total) => progress.push([bytes, total])
    })
  };
}

function seed(filePath: string, data: Buffer, totalBytes?: number, missing?: Array<[number, number]>) {
  writeFileSync(partialDownloadPath(filePath), data);
  if (totalBytes !== undefined) {
    writeFileSync(downloadStatePath(filePath), JSON.stringify({ version: 1, totalBytes, missing }));
  }
}

function expectFinished(filePath: string, data = DATA) {
  expect(readFileSync(filePath).equals(data)).toBe(true);
  expect(existsSync(partialDownloadPath(filePath))).toBe(false);
  expect(existsSync(downloadStatePath(filePath))).toBe(false);
}

describe("single-stream resume integrity", () => {
  it.each([0, 100])("redownloads an unverified part at or above the reported size (+%i)", async (extra) => {
    const test = await fixture((_request, response) => full(response));
    seed(test.filePath, Buffer.alloc(DATA.length + extra, 0xaa));
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges).toEqual(["bytes=0-0", undefined]);
  });

  it.each([undefined, "nonsense", "bytes */100", `bytes */${PREFIX}`, `bytes */${DATA.length}`])(
    "does not promote a part on 416 (Content-Range: %s)", async (contentRange) => {
      const test = await fixture((_request, response, index) => {
        if (index === 0) response.writeHead(503).end(); // No usable probe size.
        else if (index === 1) response.writeHead(416, contentRange ? { "Content-Range": contentRange } : {}).end();
        else full(response);
      });
      seed(test.filePath, Buffer.alloc(PREFIX, 0xaa));
      expect(await test.run()).toBe(DATA.length);
      expectFinished(test.filePath);
      expect(test.ranges).toEqual(["bytes=0-0", `bytes=${PREFIX}-`, undefined]);
    }
  );

  it("does not retry a full-request 416 indefinitely or create a final file", async () => {
    const test = await fixture((_request, response, index) => response.writeHead(index === 0 ? 503 : 416).end());
    seed(test.filePath, DATA.subarray(0, PREFIX));
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { status: 416 } });
    expect(existsSync(test.filePath)).toBe(false);
    expect(test.ranges).toHaveLength(3);
  });

  it("resumes a valid 206 after a failed probe using Content-Range's total", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) response.writeHead(503).end();
      else ranged(response, PREFIX);
    });
    seed(test.filePath, DATA.subarray(0, PREFIX));
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.progress.at(-1)).toEqual([DATA.length, DATA.length]);
  });

  it.each([undefined, "garbage", `bytes 0-${DATA.length - 1}/${DATA.length}`, `bytes ${PREFIX}-${DATA.length - 1}/*`])(
    "rejects an unverifiable resumed 206 before appending (%s)", async (contentRange) => {
      const test = await fixture((_request, response, index) => {
        if (index === 0) response.writeHead(503).end();
        else response.writeHead(206, contentRange ? { "Content-Range": contentRange } : {}).end(DATA.subarray(PREFIX));
      });
      seed(test.filePath, DATA.subarray(0, PREFIX));
      await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { reason: "changed" } });
      expect(existsSync(test.filePath)).toBe(false);
    }
  );

  it.each([-100, 100])("rejects a changed 206 total before mixing old and new bytes (%i)", async (difference) => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) full(response);
      else ranged(response, PREFIX, DATA.length - 1, DATA.length + difference);
    });
    seed(test.filePath, Buffer.alloc(PREFIX, 0xaa));
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { reason: "changed" } });
    expect(existsSync(test.filePath)).toBe(false);
  });

  it("overwrites the old prefix when Range is ignored and uses the full response's new size", async () => {
    const updated = DATA.subarray(0, DATA.length - 500);
    const test = await fixture((_request, response, index) => full(response, index === 0 ? DATA : updated));
    seed(test.filePath, Buffer.alloc(PREFIX, 0xaa));
    expect(await test.run()).toBe(updated.length);
    expectFinished(test.filePath, updated);
    expect(test.progress.at(-1)).toEqual([updated.length, updated.length]);
  });

  it.each([-100, 100])("does not complete a chunked full body with the wrong probed length (%i)", async (difference) => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) full(response);
      else {
        response.writeHead(200, { "Transfer-Encoding": "chunked" });
        response.end(Buffer.alloc(DATA.length + difference));
      }
    });
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(existsSync(test.filePath)).toBe(false);
  });

  it("does not complete a short resumed body even if it ends normally", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) response.writeHead(503).end();
      else response.writeHead(206, { "Content-Range": `bytes ${PREFIX}-${DATA.length - 1}/${DATA.length}` })
        .end(DATA.subarray(PREFIX, PREFIX + 100));
    });
    seed(test.filePath, DATA.subarray(0, PREFIX));
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { reason: "incomplete" } });
    expect(existsSync(test.filePath)).toBe(false);
    expect(readFileSync(partialDownloadPath(test.filePath)).equals(DATA.subarray(0, PREFIX + 100))).toBe(true);
  });

  it("accepts a complete chunked body when the server supplies no size", async () => {
    const test = await fixture((_request, response) => response.writeHead(200, { "Transfer-Encoding": "chunked" }).end(DATA));
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
  });

  it("does not trust Accept-Ranges when the actual probe is ignored", async () => {
    const test = await fixture((_request, response) => response.writeHead(200, {
      "Accept-Ranges": "bytes", "Content-Length": DATA.length
    }).end(DATA));
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges).toEqual(["bytes=0-0", undefined]);
  });
});

describe("range state and single-stream fallback integrity", () => {
  it.each([-100, 100])("discards a sparse prefix if the saved total changed during fallback (%i)", async (difference) => {
    const test = await fixture((request, response, index) => {
      if (index === 0 || !request.headers.range) full(response);
      else ranged(response, Number(/bytes=(\d+)-/.exec(request.headers.range)![1]));
    });
    seed(test.filePath, Buffer.alloc(DATA.length + difference, 0xaa), DATA.length + difference, [[PREFIX, DATA.length + difference - 1]]);
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges).toEqual(["bytes=0-0", undefined]);
  });

  it("retains a valid contiguous prefix when a probe fails, excluding sparse holes", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) response.writeHead(503).end();
      else ranged(response, PREFIX);
    });
    const sparse = Buffer.alloc(DATA.length);
    DATA.copy(sparse, 0, 0, PREFIX);
    seed(test.filePath, sparse, DATA.length, [[PREFIX, DATA.length - 1]]);
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges[1]).toBe(`bytes=${PREFIX}-`);
  });

  it("still checks the saved total when the fallback probe fails", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) response.writeHead(503).end();
      else ranged(response, PREFIX);
    });
    seed(test.filePath, Buffer.alloc(DATA.length + 100, 0xaa), DATA.length + 100, [[PREFIX, DATA.length + 99]]);
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { reason: "changed" } });
    expect(existsSync(test.filePath)).toBe(false);
  });

  it.each([false, true])("never treats corrupt range metadata as a complete plain prefix (ranged=%s)", async (supportsRanges) => {
    const test = await fixture((request, response) => {
      if (!supportsRanges || !request.headers.range) full(response);
      else {
        const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range)!;
        ranged(response, Number(match[1]), match[2] ? Number(match[2]) : undefined);
      }
    });
    seed(test.filePath, Buffer.alloc(DATA.length, 0xaa));
    writeFileSync(downloadStatePath(test.filePath), "{broken json");
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
  });

  it("falls back in the same attempt when ranges are ignored after a successful probe", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) ranged(response, 0, 0);
      else full(response);
    });
    seed(test.filePath, Buffer.alloc(DATA.length, 0xaa), DATA.length, [[PREFIX, DATA.length - 1]]);
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges).toContain(undefined);
  });

  it.each([416, "missing", "wrong start", "wrong total"])("does not publish or reuse invalid ranged data (%s)", async (failure) => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) ranged(response, 0, 0);
      else if (failure === 416) response.writeHead(416, { "Content-Range": "bytes */100" }).end();
      else if (failure === "missing") response.writeHead(206).end(DATA);
      else ranged(response, failure === "wrong start" ? 1 : 0, DATA.length - 1, failure === "wrong total" ? DATA.length + 100 : DATA.length);
    });
    await expect(test.run()).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", details: { reason: "changed" } });
    expect(existsSync(test.filePath)).toBe(false);
    expect(existsSync(partialDownloadPath(test.filePath))).toBe(false);
    expect(existsSync(downloadStatePath(test.filePath))).toBe(false);
  });

  it("does not mistake a probe's one-byte Content-Length for the full resource size", async () => {
    const test = await fixture((_request, response, index) => {
      if (index === 0) response.writeHead(206, { "Content-Length": 1 }).end(DATA.subarray(0, 1));
      else full(response);
    });
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
  });

  it.each([0, 100])("redownloads an unverified complete or oversized plain part with ranges (+%i)", async (extra) => {
    const test = await fixture((request, response) => {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range!)!;
      ranged(response, Number(match[1]), Number(match[2]));
    });
    seed(test.filePath, Buffer.alloc(DATA.length + extra, 0xaa));
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
    expect(test.ranges.length).toBeGreaterThan(1);
  });

  it("can restart after a ranged 416 without retaining stale bytes or a sidecar", async () => {
    let changed = false;
    const test = await fixture((request, response, index) => {
      if (index === 0) ranged(response, 0, 0);
      else if (!changed) response.writeHead(416, { "Content-Range": "bytes */100" }).end();
      else {
        const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range!)!;
        ranged(response, Number(match[1]), Number(match[2]));
      }
    });
    seed(test.filePath, Buffer.alloc(PREFIX, 0xaa));
    await expect(test.run()).rejects.toMatchObject({ details: { reason: "changed" } });
    changed = true;
    expect(await test.run()).toBe(DATA.length);
    expectFinished(test.filePath);
  });

  it("validates the originally requested end when work stealing occurs before headers arrive", async () => {
    const data = randomBytes(8 * 1024 * 1024);
    const slowStart = data.length / 2;
    const test = await fixture((request, response) => {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range!)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const reply = () => response.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
        "Content-Length": end - start + 1
      }).end(data.subarray(start, end + 1));
      if (start === slowStart) setTimeout(reply, 100);
      else reply();
    }, 2);
    expect(await test.run()).toBe(data.length);
    expectFinished(test.filePath, data);
    expect(test.ranges.length).toBeGreaterThan(3);
  });
});

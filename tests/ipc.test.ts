import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS, isEventChannel, isInvokeChannel } from "../src/shared/ipc";
import { AppError } from "../src/main/lib/app-error";
import { createHandlers, validators } from "../src/main/ipc-handlers";
import type { Backend } from "../src/main/backend";

const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => registered.set(channel, handler)
  }
}));

/** A backend whose every method records its call and echoes its arguments. */
function recordingBackend() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend = new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "getVideo") {
        throw new AppError("VIDEO_NOT_FOUND", "gone");
      }
      return { method, args };
    }
  }) as Backend;
  return { backend, calls };
}

const validVideo = { id: "abc", title: "T", tags: ["a"], numViews: 1, numLikes: 2, numComments: 3 };

describe("IPC contract", () => {
  it("has exactly one handler and one validator per channel", () => {
    const handlers = createHandlers(recordingBackend().backend);
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(Object.keys(validators).sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length);
  });

  it("recognizes only declared channels", () => {
    expect(isInvokeChannel("settings:get")).toBe(true);
    expect(isInvokeChannel("settings:get ")).toBe(false);
    expect(isInvokeChannel("constructor")).toBe(false);
    expect(isInvokeChannel("__proto__")).toBe(false);
    expect(isEventChannel("downloads:changed")).toBe(true);
    expect(isEventChannel("toString")).toBe(false);
    expect(EVENT_CHANNELS.every((channel) => !isInvokeChannel(channel))).toBe(true);
  });
});

describe("IPC validators", () => {
  const reject = (channel: keyof typeof validators, ...args: unknown[]) =>
    expect(() => validators[channel](args)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

  it("rejects malformed requests", () => {
    reject("iwara:list-videos", undefined);
    reject("iwara:list-videos", { sort: "random" });
    reject("iwara:list-videos", { sort: "date", page: -1 });
    reject("iwara:list-videos", { sort: "date", page: 1.5 });
    reject("iwara:list-videos", { sort: "date", tags: "a,b" });
    reject("iwara:list-videos", { sort: "date", tags: Array(51).fill("x") });
    reject("iwara:list-videos", { sort: "date", subscribedOnly: "yes" });
    reject("iwara:get-video", 42);
    reject("iwara:get-video", "x".repeat(501));
    reject("iwara:send-comment", { videoId: "a", body: "x".repeat(10_001) });
    reject("iwara:set-author-following", { authorId: "a", following: 1 });
    reject("downloads:delete", { id: "a" });
    reject("favorites:add", { title: "missing id" });
    reject("favorites:add", { ...validVideo, tags: [1] });
    reject("favorites:restore", { video: validVideo });
    reject("player:play", { videoId: "a", mode: "vlc" });
    reject("settings:update", null);
    reject("settings:update", { evil: {} });
    reject("settings:update", { player: "mpv" });
    reject("settings:update", { history: {} });
    reject("system:open-external", { url: "https://x" });
    reject("system:select-directory", { title: 5 });
  });

  it("keeps only known fields", () => {
    const [request] = validators["iwara:list-videos"]([{ sort: "date", page: 2, rating: "general", extra: "dropped", tags: ["a"] }]);
    expect(request).toEqual({
      sort: "date",
      page: 2,
      rating: "general",
      query: undefined,
      tags: ["a"],
      followedOnly: undefined,
      subscribedOnly: undefined,
      searchOnly: undefined,
      userId: undefined
    });
    expect(validators["downloads:delete"]([{ id: "d1", deleteFile: true, path: "/etc/passwd" }])).toEqual([{ id: "d1", deleteFile: true }]);
    expect(validators["player:play"]([{ videoId: "v", quality: null }])).toEqual([{ videoId: "v", quality: undefined, mode: undefined }]);
    expect(validators["favorites:add"]([{ id: "v", title: "t" }])[0]).toMatchObject({ tags: [], numViews: 0 });
    expect(validators["settings:get"](["ignored"])).toEqual([]);
  });

  it("validates every channel's happy path", () => {
    const samples: { [C in keyof typeof validators]: unknown[] } = {
      "iwara:list-videos": [{ sort: "date" }],
      "iwara:get-video": ["abc"],
      "iwara:diagnose-video": ["abc"],
      "iwara:list-comments": [{ videoId: "abc", page: 0 }],
      "iwara:send-comment": [{ videoId: "abc", body: "hi" }],
      "iwara:set-author-following": [{ authorId: "u", following: true }],
      "iwara:sniff-x-version-salt": [],
      "iwara:speed-test-video": ["abc"],
      "downloads:list": [],
      "downloads:start": [{ videoId: "abc" }],
      "downloads:retry": ["d"],
      "downloads:cancel": ["d"],
      "downloads:delete": [{ id: "d", deleteFile: false }],
      "downloads:clear-finished": [],
      "downloads:open-file": ["d"],
      "downloads:show-in-folder": ["d"],
      "downloads:open-directory": [],
      "favorites:list": [],
      "favorites:add": [validVideo],
      "favorites:restore": [{ video: validVideo, favoritedAt: "2026-01-01T00:00:00Z" }],
      "favorites:remove": ["abc"],
      "favorites:backup": [],
      "favorites:export": [],
      "favorites:import": [],
      "player:play": [{ videoId: "abc", mode: "external" }],
      "player:probe": [],
      "player:test-mpv": [],
      "settings:get": [],
      "settings:update": [{ ui: { theme: "dark" } }],
      "auth:state": [],
      "auth:open-verification": [],
      "auth:sign-out": [],
      "system:select-executable": [{ title: "Pick" }],
      "system:select-directory": [{ title: "Pick", currentPath: "/tmp" }],
      "system:open-external": ["https://www.iwara.tv/"],
      "system:write-clipboard": ["text"],
      "system:app-info": []
    };
    for (const channel of INVOKE_CHANNELS) {
      expect(() => validators[channel](samples[channel]), channel).not.toThrow();
    }
  });
});

describe("registerIpc", () => {
  beforeEach(() => registered.clear());

  async function setup(trusted: boolean) {
    const { registerIpc } = await import("../src/main/ipc");
    const { backend, calls } = recordingBackend();
    registerIpc(createHandlers(backend), validators, () => trusted);
    return { calls, invoke: (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args) };
  }

  it("registers every channel and wraps results in an envelope", async () => {
    const { invoke, calls } = await setup(true);
    expect([...registered.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect(await invoke("favorites:remove", "abc")).toEqual({ ok: true, data: { method: "removeFavorite", args: ["abc"] } });
    expect(calls).toEqual([{ method: "removeFavorite", args: ["abc"] }]);
  });

  it("returns error codes instead of throwing", async () => {
    const { invoke, calls } = await setup(true);
    expect(await invoke("iwara:get-video", "abc")).toEqual({ ok: false, error: { code: "VIDEO_NOT_FOUND", message: "gone", details: undefined } });
    expect(await invoke("player:play", { videoId: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(calls.map((call) => call.method)).toEqual(["getVideo"]);
  });

  it("refuses untrusted senders before validating or calling the backend", async () => {
    const { invoke, calls } = await setup(false);
    expect(await invoke("system:open-external", "https://example.com")).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(calls).toEqual([]);
  });
});

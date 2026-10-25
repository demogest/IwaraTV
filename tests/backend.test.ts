import { describe, expect, it, vi } from "vitest";
import { Backend, type PlatformPort, type SessionPort } from "../src/main/backend";
import type { HttpFetch } from "../src/main/lib/http";
import { PlayerService } from "../src/main/services/player-service";
import { makeJwt, rawVideo, tempDir } from "./helpers";

const FILE_URL = "https://files.iwara.tv/file/abc-file?expires=1700000000&hash=h";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(options: { token?: string; speedTestFails?: boolean; clipboard?: string } = {}) {
  const requests: string[] = [];
  const mediaHeaders: Array<Record<string, string>> = [];
  const fetch: HttpFetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === "api.iwara.tv" && url.pathname === "/video/abcdef123/related") {
      return json({ results: [rawVideo({ id: "abcdef123" }), rawVideo({ id: "other1" }), rawVideo({ id: "hidden1", tags: [{ id: "blocked" }] })] });
    }
    if (url.hostname === "api.iwara.tv" && url.pathname === "/video/abcdef123") {
      return json({ ...rawVideo({ id: "abcdef123", title: "Clip" }), fileUrl: FILE_URL });
    }
    if (url.hostname === "api.iwara.tv" && url.pathname === "/user") {
      return json({ user: { username: "demo_user", avatar: { id: "av" } } });
    }
    if (url.hostname === "files.iwara.tv") {
      return json([
        { name: "540", src: { view: "//jade.iwara.tv/540" } },
        { name: "Source", src: { view: "//jade.iwara.tv/source" } }
      ]);
    }
    if (url.hostname === "jade.iwara.tv" && url.pathname === "/source" && init.headers?.Range === "bytes=0-9") {
      mediaHeaders.push(init.headers);
      return new Response(new Uint8Array(10), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-9/100", "x-internal": "drop me" } });
    }
    if (url.hostname.endsWith(".iwara.tv") && url.pathname !== "/") {
      return options.speedTestFails || url.hostname !== "kafka.iwara.tv"
        ? new Response("", { status: 503 })
        : new Response(new Uint8Array(1024), { status: 200 });
    }
    return json({ message: "errors.notFound" }, 404);
  };

  const session: SessionPort = {
    fetch,
    token: async () => options.token,
    pageFetch: async () => {
      throw new Error("unused");
    },
    snapshot: async () => ({
      cookieCount: options.token ? 3 : 0,
      token: options.token ? { key: "localStorage.accessToken", value: options.token, username: "from-jwt" } : undefined,
      verificationWindowOpen: false
    }),
    tokenExpiry: () => (options.token ? new Date("2030-01-01T00:00:00Z") : undefined),
    openVerificationWindow: async () => undefined,
    captureVideoNetwork: async () => {
      throw new Error("unused");
    },
    signOut: vi.fn(async () => undefined),
    onChange: () => () => undefined
  };

  const platform: PlatformPort = {
    openPath: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    writeClipboard: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => options.clipboard ?? ""),
    setDownloadProgress: vi.fn(),
    notifyDownload: vi.fn(),
    pickFile: vi.fn(async () => undefined),
    pickDirectory: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => undefined),
    appInfo: () => ({ name: "IwaraTV", version: "0.0.0", electron: "0", chrome: "0", node: "0", platform: "linux", userDataPath: "/" }) as never,
    platform: "linux"
  };

  const player = new PlayerService({ platform: "freebsd" as NodeJS.Platform, env: { PATH: "" } });
  const launch = vi.spyOn(player, "launch").mockResolvedValue();
  vi.spyOn(player, "requirePlayer").mockReturnValue("/usr/bin/mpv");

  const events: string[] = [];
  const backend = new Backend({
    userDataPath: tempDir("backend"),
    defaultDownloadDirectory: tempDir("backend-downloads"),
    session,
    player,
    platform,
    emit: (channel) => events.push(channel)
  });
  backend.updateSettings({
    iwara: { autoSniffXVersionSalt: false },
    mediaSpeed: { candidateHosts: ["kafka.iwara.tv", "down.iwara.tv"] },
    player: { preferredMode: "mpv" }
  });
  return { backend, requests, launch, platform, session, events, mediaHeaders };
}

describe("Backend.play", () => {
  it("picks the preferred quality, routes to the fastest host and records history", async () => {
    const { backend, launch } = setup();
    backend.updateSettings({ player: { preferredQuality: "540" }, mediaSpeed: { autoTest: true, replaceLinks: true } });

    const result = await backend.play({ videoId: "abcdef123" });
    expect(result).toMatchObject({ ok: true, mode: "mpv", playerPath: "/usr/bin/mpv", fallbackFrom: undefined });
    expect(result.format.label).toBe("540");
    expect(new URL(result.format.url).hostname).toBe("kafka.iwara.tv");
    const [, args] = launch.mock.calls[0]!;
    expect(args.slice(-2)).toEqual(["--", result.format.url]);
    expect(args).toContain("--title=Clip");

    const settings = backend.getSettings();
    expect(settings.mediaSpeed.rankedHosts[0]).toBe("kafka.iwara.tv");
    expect(settings.mediaSpeed.candidateHosts).toContain("jade.iwara.tv");
    expect(settings.history[0]).toMatchObject({ video: { id: "abcdef123" }, formatId: "540", mode: "mpv" });
    expect(settings.history[0]!.video).not.toHaveProperty("formats");
  });

  it("falls back to the best quality and still plays when the speed test fails", async () => {
    const { backend } = setup({ speedTestFails: true });
    backend.updateSettings({ mediaSpeed: { autoTest: true, replaceLinks: true } });
    const result = await backend.play({ videoId: "abcdef123", quality: "1080" });
    expect(result.format.label).toBe("Source");
    expect(result.fallbackFrom).toBe("1080");
    expect(new URL(result.format.url).hostname).toBe("jade.iwara.tv");
  });

  it("does not record history when the player cannot start", async () => {
    const { backend, launch } = setup();
    launch.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: "PLAYER_LAUNCH_FAILED" }));
    await expect(backend.play({ videoId: "abcdef123" })).rejects.toThrow("nope");
    expect(backend.getSettings().history).toEqual([]);
  });
});

describe("Backend built-in player", () => {
  it("returns a stream URL instead of launching a player", async () => {
    const { backend, launch } = setup();
    const result = await backend.play({ videoId: "abcdef123", mode: "builtin" });
    expect(launch).not.toHaveBeenCalled();
    expect(result.mode).toBe("builtin");
    expect(result.resumeAt).toBeUndefined();
    expect(result.playerPath).toBeUndefined();
    expect(result.streamUrl).toMatch(/^iwara-media:\/\/stream\/[0-9a-f-]{36}$/);
    expect(backend.getSettings().history[0]).toMatchObject({ video: { id: "abcdef123" }, mode: "builtin" });
  });

  it("proxies only registered streams, with Range and the Iwara referrer", async () => {
    const { backend, mediaHeaders } = setup();
    const { streamUrl } = await backend.play({ videoId: "abcdef123", mode: "builtin" });
    const response = await backend.streamMedia(streamUrl!, "bytes=0-9");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-9/100");
    expect(response.headers.get("x-internal")).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(10);
    expect(mediaHeaders[0]).toMatchObject({ Range: "bytes=0-9", Referer: "https://www.iwara.tv/" });

    expect((await backend.streamMedia("iwara-media://stream/not-a-token", null)).status).toBe(404);
    expect((await backend.streamMedia("iwara-media://other/" + streamUrl!.split("/").at(-1), null)).status).toBe(404);
  });

  it("resumes where the viewer stopped, but not near the start or end", async () => {
    const { backend } = setup();
    await backend.play({ videoId: "abcdef123", mode: "builtin" });
    backend.reportProgress({ videoId: "abcdef123", positionSeconds: 312.4, durationSeconds: 600 });
    expect((await backend.play({ videoId: "abcdef123", mode: "builtin" })).resumeAt).toBe(312);
    // Playing again keeps the saved position in history.
    expect(backend.getSettings().history[0]).toMatchObject({ positionSeconds: 312, durationSeconds: 600 });

    backend.reportProgress({ videoId: "abcdef123", positionSeconds: 590, durationSeconds: 600 });
    expect((await backend.play({ videoId: "abcdef123", mode: "builtin" })).resumeAt).toBeUndefined();
    backend.reportProgress({ videoId: "abcdef123", positionSeconds: 8, durationSeconds: 600 });
    expect((await backend.play({ videoId: "abcdef123", mode: "builtin" })).resumeAt).toBeUndefined();
    // Progress for a video that was never played is ignored.
    backend.reportProgress({ videoId: "unknown", positionSeconds: 100, durationSeconds: 600 });
    expect(backend.getSettings().history.some((entry) => entry.video.id === "unknown")).toBe(false);
  });
});

describe("Backend extras", () => {
  it("lists related videos without the video itself or blocked tags", async () => {
    const { backend } = setup();
    backend.updateSettings({ tagPreferences: { blockedTags: ["blocked"] } });
    expect((await backend.listRelated("abcdef123")).map((video) => video.id)).toEqual(["other1"]);
  });

  it("recognizes only Iwara video links on the clipboard", async () => {
    expect(await setup({ clipboard: " https://www.iwara.tv/video/AbCdEf12345/slug " }).backend.clipboardVideo()).toBe("AbCdEf12345");
    expect(await setup({ clipboard: "AbCdEf12345" }).backend.clipboardVideo()).toBeUndefined();
    expect(await setup({ clipboard: "my password is hunter2" }).backend.clipboardVideo()).toBeUndefined();
    expect(await setup({ clipboard: "https://evil.example/iwara.tv/video/AbCdEf12345" }).backend.clipboardVideo()).toBeUndefined();
  });

  it("mirrors downloads to the taskbar and notifies when they end", async () => {
    const { backend, platform } = setup();
    backend.startDownload({ videoId: "abcdef123" });
    await vi.waitFor(() => expect(backend.listDownloads().history).toHaveLength(1));
    expect(platform.setDownloadProgress).toHaveBeenCalledWith("indeterminate", 1);
    expect(platform.setDownloadProgress).toHaveBeenLastCalledWith(undefined, 0);
    expect(platform.notifyDownload).toHaveBeenCalledExactlyOnceWith("failed", "Clip");

    backend.updateSettings({ download: { notifyOnComplete: false } });
    backend.startDownload({ videoId: "abcdef123" });
    await vi.waitFor(() => expect(backend.listDownloads().history).toHaveLength(2));
    expect(platform.notifyDownload).toHaveBeenCalledOnce();
  });
});

describe("Backend auth and system", () => {
  it("summarizes the session for the UI", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const { backend } = setup({ token });
    expect(await backend.authState()).toMatchObject({
      status: "signed-in",
      username: "demo_user",
      avatarUrl: "https://i.iwara.tv/image/avatar/av/av.jpg",
      siteCookieCount: 3,
      tokenExpiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(await setup().backend.authState()).toMatchObject({ status: "anonymous", siteTokenReady: false });
  });

  it("signs out through the session", async () => {
    const { backend, session } = setup();
    await backend.signOut();
    expect(session.signOut).toHaveBeenCalledOnce();
  });

  it("only opens web links externally", async () => {
    const { backend, platform } = setup();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "not a url"]) {
      await expect(backend.openExternal(url)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await backend.openExternal("https://www.iwara.tv/video/abc");
    expect(platform.openExternal).toHaveBeenCalledExactlyOnceWith("https://www.iwara.tv/video/abc");
  });

  it("refuses to open downloads that do not exist", async () => {
    const { backend } = setup();
    await expect(backend.openDownloadFile("missing")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(backend.showDownloadInFolder("missing")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("pushes change events to the renderer", () => {
    const { backend, events } = setup();
    backend.addFavorite({ id: "a", title: "A", tags: [], numViews: 0, numLikes: 0, numComments: 0 });
    expect(events).toContain("settings:changed");
    expect(events).toContain("favorites:changed");
  });
});

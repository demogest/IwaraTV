import { describe, expect, it, vi } from "vitest";
import { Backend, type PlatformPort, type SessionPort } from "../src/main/backend";
import type { HttpFetch } from "../src/main/lib/http";
import { PlayerService } from "../src/main/services/player-service";
import { makeJwt, rawVideo, tempDir } from "./helpers";

const FILE_URL = "https://files.iwara.tv/file/abc-file?expires=1700000000&hash=h";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(options: { token?: string; speedTestFails?: boolean } = {}) {
  const requests: string[] = [];
  const fetch: HttpFetch = async (input) => {
    const url = new URL(input);
    requests.push(`${url.hostname}${url.pathname}`);
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
    writeClipboard: vi.fn(),
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
  backend.updateSettings({ iwara: { autoSniffXVersionSalt: false }, mediaSpeed: { candidateHosts: ["kafka.iwara.tv", "down.iwara.tv"] } });
  return { backend, requests, launch, platform, session, events };
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

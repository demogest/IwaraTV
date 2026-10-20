import { describe, expect, it, vi } from "vitest";
import type { HttpFetch, HttpRequestInit } from "../src/main/lib/http";
import { buildXVersion } from "../src/main/lib/x-version";
import { IwaraClient, type IwaraSessionBridge } from "../src/main/services/iwara-client";
import { createDefaultSettings } from "../src/shared/defaults";
import { makeJwt, rawVideo, tempDir } from "./helpers";

type Handler = (url: URL, init: HttpRequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes: Array<[string | RegExp, Handler]>) {
  const calls: Array<{ url: URL; init: HttpRequestInit }> = [];
  const fetch: HttpFetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
    const route = routes.find(([pattern]) => (typeof pattern === "string" ? key === pattern : pattern.test(key)));
    if (!route) {
      return json({ message: "errors.notFound" }, 404);
    }
    return route[1](url, init);
  };
  return { fetch, calls };
}

function client(routes: Array<[string | RegExp, Handler]>, options: { token?: string; pageFetch?: IwaraSessionBridge["pageFetch"] } = {}) {
  const { fetch, calls } = fakeFetch(routes);
  const session: IwaraSessionBridge = {
    token: async () => options.token,
    pageFetch: options.pageFetch ?? (async () => {
      throw new Error("no page");
    })
  };
  return { client: new IwaraClient({ fetch, session, salt: () => "test-salt" }), calls };
}

const preferences = () => createDefaultSettings().tagPreferences;
const page = (count: number, start = 0, extra: Record<string, unknown> = {}) =>
  Array.from({ length: count }, (_, index) => rawVideo({ id: `video${start + index}`, ...extra }));

describe("IwaraClient lists", () => {
  it("builds feed requests and reports whether more pages exist", async () => {
    const { client: api, calls } = client([["GET https://api.iwara.tv/videos", () => json({ count: 33, limit: 32, results: page(32) })]]);
    const result = await api.listVideos({ sort: "trending", page: 0, rating: "general", tags: ["Koikatsu"] }, preferences());
    expect(result.results).toHaveLength(32);
    expect(result.hasMore).toBe(true);
    const params = Object.fromEntries(calls[0]!.url.searchParams);
    expect(params).toMatchObject({ sort: "trending", rating: "general", page: "0", limit: "32", subscribed: "false", tags: "koikatsu" });
    expect(calls[0]!.init.headers).toMatchObject({ Accept: "application/json", "X-Site": "www.iwara.tv" });
  });

  it("scans several pages to fill a page when tags are blocked", async () => {
    const { client: api, calls } = client([
      ["GET https://api.iwara.tv/videos", (url) => {
        const pageIndex = Number(url.searchParams.get("page"));
        return json({ results: page(32, pageIndex * 32, pageIndex === 0 ? { tags: [{ id: "blocked" }] } : {}) });
      }]
    ]);
    const prefs = { ...preferences(), blockedTags: ["blocked"], requestDelayMs: 0 };
    const result = await api.listVideos({ sort: "date", page: 0 }, prefs);
    expect(result.blockedCount).toBe(32);
    expect(result.results).toHaveLength(32);
    expect(result.scannedPages).toBe(2);
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["0", "1"]);
  });

  it("retries transient failures and surfaces persistent ones as errors", async () => {
    let attempts = 0;
    const flaky = client([["GET https://api.iwara.tv/videos", () => (++attempts < 2 ? json({}, 503) : json({ results: page(3) }))]]);
    const ok = await flaky.client.listVideos({ sort: "date" }, preferences());
    expect(ok.results).toHaveLength(3);
    expect(ok.hasMore).toBe(false);
    expect(ok.networkDiagnostics?.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);

    // A single-page feed that keeps failing must not look like an empty feed.
    const broken = client([["GET https://api.iwara.tv/videos", () => json({}, 403)]]);
    await expect(broken.client.listVideos({ sort: "date", tags: ["x"] }, preferences())).rejects.toMatchObject({ code: "HTTP_ERROR" });
    expect(broken.calls).toHaveLength(1);
  });

  it("requires a session for subscriptions and sends the token", async () => {
    const anonymous = client([]);
    await expect(anonymous.client.listVideos({ sort: "date", subscribedOnly: true }, preferences())).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });

    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const signedIn = client([["GET https://api.iwara.tv/videos", () => json({ count: 10, results: page(10) })]], { token });
    const result = await signedIn.client.listVideos({ sort: "date", subscribedOnly: true }, preferences());
    expect(result.limit).toBe(24);
    expect(signedIn.calls[0]!.url.searchParams.get("subscribed")).toBe("true");
    expect(signedIn.calls[0]!.url.searchParams.has("sort")).toBe(false);
    expect(signedIn.calls[0]!.init.headers?.Authorization).toBe(`Bearer ${token}`);

    const expired = client([], { token: makeJwt({ exp: 1 }) });
    await expect(expired.client.listVideos({ sort: "date", subscribedOnly: true }, preferences())).rejects.toMatchObject({ code: "LOGIN_EXPIRED" });
  });

  it("searches with totals", async () => {
    const { client: api, calls } = client([["GET https://api.iwara.tv/search", () => json({ count: 7327, limit: 32, results: page(32) })]]);
    const result = await api.listVideos({ sort: "relevance", query: " miku ", searchOnly: true }, preferences());
    expect(result).toMatchObject({ total: 7327, hasMore: true, query: "miku" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ type: "videos", query: "miku", sort: "relevance" });
    expect((await api.listVideos({ sort: "relevance", query: "  ", searchOnly: true }, preferences())).results).toEqual([]);
  });

  it("merges followed-tag feeds newest first", async () => {
    const { client: api } = client([
      ["GET https://api.iwara.tv/videos", (url) => {
        const tag = url.searchParams.get("tags");
        return json({ results: [rawVideo({ id: `${tag}-1`, createdAt: tag === "a" ? "2026-01-02T00:00:00Z" : "2026-01-03T00:00:00Z" })] });
      }]
    ]);
    const result = await api.listVideos({ sort: "date", followedOnly: true }, { ...preferences(), followedTags: ["a", "b"], requestDelayMs: 0 });
    expect(result.results.map((video) => video.id)).toEqual(["b-1", "a-1"]);
    expect((await api.listVideos({ sort: "date", followedOnly: true }, preferences())).results).toEqual([]);
  });
});

describe("IwaraClient videos", () => {
  const fileUrl = "https://files.iwara.tv/file/abc-file?expires=1700000000&hash=h";
  const fileList = [
    { name: "360", src: { view: "//a.iwara.tv/360" } },
    { name: "Source", src: { view: "//a.iwara.tv/source" } }
  ];

  it("signs the file-list request and sorts formats", async () => {
    const { client: api, calls } = client([
      ["GET https://api.iwara.tv/video/abcdef123", () => json({ ...rawVideo({ id: "abcdef123" }), fileUrl })],
      ["GET https://files.iwara.tv/file/abc-file", () => json(fileList)]
    ]);
    const video = await api.getVideo("https://www.iwara.tv/video/abcdef123/slug");
    expect(video.formats.map((format) => format.label)).toEqual(["360", "Source"]);
    const fileCall = calls.find((call) => call.url.hostname === "files.iwara.tv")!;
    expect(fileCall.init.headers?.["X-Version"]).toBe(buildXVersion(fileUrl, "test-salt"));
    expect(fileCall.url.searchParams.get("download")).toBe("Iwara - Sample video [abcdef123].mp4");
  });

  it("uses a media token when signed in", async () => {
    const userToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const mediaToken = makeJwt({ media: true, exp: Math.floor(Date.now() / 1000) + 3600 });
    const { client: api, calls } = client(
      [
        ["POST https://api.iwara.tv/user/token", () => json({ accessToken: mediaToken })],
        ["GET https://api.iwara.tv/video/abcdef123", () => json({ ...rawVideo({ id: "abcdef123" }), fileUrl })],
        ["GET https://files.iwara.tv/file/abc-file", () => json(fileList)]
      ],
      { token: userToken }
    );
    await api.getVideo("abcdef123");
    await api.getVideo("abcdef123");
    expect(calls.filter((call) => call.url.pathname === "/user/token")).toHaveLength(1);
    expect(calls.find((call) => call.url.hostname === "files.iwara.tv")!.init.headers?.Authorization).toBe(`Bearer ${mediaToken}`);
  });

  it("maps Iwara error messages to specific error codes", async () => {
    const { client: api } = client([
      ["GET https://api.iwara.tv/video/private123", () => json({ message: "errors.privateVideo" }, 403)],
      ["GET https://api.iwara.tv/video/okprivate1", () => json({ message: "errors.privateVideo" })],
      ["GET https://api.iwara.tv/video/embed12345", () => json({ ...rawVideo({ id: "embed12345" }), embedUrl: "https://youtube.com/x" })],
      ["GET https://api.iwara.tv/video/nofile1234", () => json(rawVideo({ id: "nofile1234" }))]
    ]);
    await expect(api.getVideo("missing123")).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
    await expect(api.getVideo("private123")).rejects.toMatchObject({ code: "PRIVATE_VIDEO" });
    await expect(api.getVideo("okprivate1")).rejects.toMatchObject({ code: "PRIVATE_VIDEO" });
    await expect(api.getVideo("bad id!")).rejects.toMatchObject({ code: "INVALID_VIDEO_ID" });
    await expect(api.getVideo("nofile1234")).rejects.toMatchObject({ code: "NO_FORMATS" });
    expect(await api.getVideo("embed12345")).toMatchObject({ formats: [], embedUrl: "https://youtube.com/x" });
  });

  it("uses the page-context response when Cloudflare challenges the app", async () => {
    const challenge = () => new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } });
    const pageFetch = vi.fn(async () => ({ status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ results: page(2) }) }));
    const { client: api } = client([["GET https://api.iwara.tv/videos", challenge]], { pageFetch });
    // The Rust client kept the original 403 status here and failed anyway.
    const result = await api.listVideos({ sort: "date" }, preferences());
    expect(result.results).toHaveLength(2);
    expect(pageFetch).toHaveBeenCalledOnce();

    const { client: blocked } = client([["GET https://api.iwara.tv/video/abcdef123", challenge]]);
    await expect(blocked.getVideo("abcdef123")).rejects.toMatchObject({ code: "CLOUDFLARE_CHALLENGE" });
  });

  it("speed-tests hosts without reading more than the sample size", async () => {
    const sample = 64 * 1024;
    let delivered = 0;
    const endless = () => new Response(new ReadableStream({
      pull(controller) {
        delivered += 16 * 1024;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (delivered > 50 * 1024 * 1024) {
          controller.close();
        }
      }
    }), { status: 200 });
    const { client: api } = client([
      [/GET https:\/\/(jade|kafka)\.iwara\.tv\//, endless],
      [/GET https:\/\/down\.iwara\.tv\//, () => new Response("", { status: 404 })]
    ]);
    const settings = { ...createDefaultSettings().mediaSpeed, testBytes: sample, candidateHosts: ["kafka.iwara.tv", "down.iwara.tv"] };
    const report = await api.speedTestHosts(
      { ...rawVideo(), id: "v", title: "v", tags: [], numViews: 0, numLikes: 0, numComments: 0, formats: [{ id: "Source", label: "Source", url: "https://jade.iwara.tv/view?x=1", qualityRank: 4000 }] } as never,
      settings
    );
    expect(report.results.map((result) => [result.host, result.ok])).toEqual([["jade.iwara.tv", true], ["kafka.iwara.tv", true], ["down.iwara.tv", false]]);
    expect(report.results[0]!.bytesRead).toBe(sample);
    expect(delivered).toBeLessThan(1024 * 1024);
  });

  it("prepares downloads in the configured folder with host routing", async () => {
    const directory = tempDir("client-download");
    const { client: api } = client([
      ["GET https://api.iwara.tv/video/abcdef123", () => json({ ...rawVideo({ id: "abcdef123", title: "A/B" }), fileUrl })],
      ["GET https://files.iwara.tv/file/abc-file", () => json(fileList)]
    ]);
    const speed = { ...createDefaultSettings().mediaSpeed, replaceLinks: true, rankedHosts: ["kafka.iwara.tv"] };
    const plan = await api.prepareDownload({ videoId: "abcdef123", quality: "1080" }, { ...createDefaultSettings().download, directory }, speed);
    expect(plan.format.label).toBe("Source");
    expect(plan.fallbackFrom).toBe("1080");
    expect(new URL(plan.format.url).hostname).toBe("kafka.iwara.tv");
    expect(plan.path.startsWith(directory)).toBe(true);
    expect(plan.path).toContain("A_B [abcdef123] - Source.mp4");
    await expect(api.prepareDownload({ videoId: "abcdef123" }, { ...createDefaultSettings().download, directory: undefined }, speed)).rejects.toMatchObject({
      code: "DOWNLOAD_DIRECTORY_REQUIRED"
    });
  });
});

describe("IwaraClient comments, follows and salt", () => {
  it("pages comments and loads replies", async () => {
    const { client: api, calls } = client([
      ["GET https://api.iwara.tv/video/abcdef123/comments", () => json({ count: 45, limit: 20, results: [{ id: "c1", body: "hi", numReplies: 2 }] })]
    ]);
    const first = await api.listVideoComments({ videoId: "abcdef123", page: 1, parentId: "p1" });
    expect(first).toMatchObject({ page: 1, limit: 20, total: 45, hasMore: true, parentId: "p1" });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ page: "1", limit: "20", parent: "p1" });
  });

  it("requires sign-in to comment and sends replies with their parent", async () => {
    const { client: anonymous } = client([]);
    await expect(anonymous.sendVideoComment({ videoId: "abcdef123", body: "hi" })).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    await expect(anonymous.sendVideoComment({ videoId: "abcdef123", body: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const { client: api, calls } = client(
      [
        ["POST https://api.iwara.tv/user/token", () => json({ accessToken: token })],
        ["POST https://api.iwara.tv/video/abcdef123/comments", (_url, init) => json({ id: "new", body: JSON.parse(init.body!).body })]
      ],
      { token }
    );
    expect(await api.sendVideoComment({ videoId: "abcdef123", body: " hello ", parentId: "p1" })).toMatchObject({ id: "new", body: "hello" });
    expect(JSON.parse(calls.at(-1)!.init.body!)).toEqual({ body: "hello", parent: "p1" });
  });

  it("follows and unfollows authors on the apiq host", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const { client: api, calls } = client(
      [
        ["POST https://api.iwara.tv/user/token", () => json({ accessToken: token })],
        [/(POST|DELETE) https:\/\/apiq\.iwara\.tv\/user\/u1\/followers/, () => new Response(null, { status: 204 })]
      ],
      { token }
    );
    expect(await api.setAuthorFollowing({ authorId: "u1", following: true })).toEqual({ authorId: "u1", following: true });
    await api.setAuthorFollowing({ authorId: "u1", following: false });
    expect(calls.filter((call) => call.url.hostname === "apiq.iwara.tv").map((call) => call.init.method)).toEqual(["POST", "DELETE"]);
    await expect(client([]).client.setAuthorFollowing({ authorId: "u1", following: true })).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  });

  it("never sends the session token outside iwara.tv", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const { client: api, calls } = client(
      [
        ["POST https://api.iwara.tv/user/token", () => json({ accessToken: token })],
        ["GET https://api.iwara.tv/video/abcdef123", () => json({ ...rawVideo({ id: "abcdef123" }), fileUrl: "https://evil.example/file/x?expires=1&hash=h" })],
        ["GET https://www.iwara.tv/", () => new Response(`<script src="https://static.cloudflareinsights.com/beacon.min.js"></script><script src="/main.js"></script>`)],
        ["GET https://www.iwara.tv/main.js", () => new Response(`const fileUrl = 1; const s = "AbCdEfGhIjKlMnOpQrStUvWx12345678"; headers["X-Version"] = s;`)]
      ],
      { token }
    );
    await expect(api.getVideo("abcdef123")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await api.sniffXVersionSalt();
    const offsite = calls.filter((call) => !call.url.hostname.endsWith("iwara.tv"));
    expect(offsite).toEqual([]);
    // Public pages and scripts are fetched without credentials.
    expect(calls.filter((call) => call.url.hostname === "www.iwara.tv").every((call) => !call.init.headers?.Authorization)).toBe(true);
  });

  it("sniffs the X-Version salt from the website", async () => {
    const salt = "AbCdEfGhIjKlMnOpQrStUvWx12345678";
    const { client: api } = client([
      ["GET https://www.iwara.tv/", () => new Response(`<script src="/main.1a2b.js"></script>`)],
      ["GET https://www.iwara.tv/main.1a2b.js", () => new Response(`h=sha1(fileUrl+"_${salt}");headers["X-Version"]=h`)]
    ]);
    expect(await api.sniffXVersionSalt()).toMatchObject({ salt, sourceUrl: "https://www.iwara.tv/main.1a2b.js" });

    const { client: none } = client([["GET https://www.iwara.tv/", () => new Response("<html></html>")]]);
    await expect(none.sniffXVersionSalt()).rejects.toMatchObject({ code: "SALT_NOT_FOUND" });
  });
});

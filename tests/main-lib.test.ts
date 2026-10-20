import path from "node:path";
import { describe, expect, it } from "vitest";
import { downloadExtension, downloadSegments, sanitizeFileStem, totalBytesFromContentRange, uniqueDownloadPath } from "../src/main/lib/download-files";
import {
  chooseVideoFormat,
  durationSeconds,
  extractAuthProfile,
  formatsFromJson,
  mapVideoComment,
  mapVideoSummary,
  plainText,
  safeUrl,
  summarizeJsonResponse
} from "../src/main/lib/iwara-parse";
import { findJwt, findToken, findUsernameInStorageValue, isJwtExpired, isLikelyJwt, usernameFromJwt } from "../src/main/lib/jwt";
import { mergeJson } from "../src/main/lib/json-file";
import { serializeError, AppError } from "../src/main/lib/app-error";
import { buildXVersion, extractXVersionSaltFromScript, scriptUrlsFromHtml } from "../src/main/lib/x-version";
import { thumbnailFrameUrl } from "../src/shared/thumbnails";
import { makeJwt, rawVideo } from "./helpers";

describe("X-Version", () => {
  it("builds the X-Version hash", () => {
    expect(buildXVersion("https://files.iwara.tv/file/video-file-id?expires=1700000000")).toBe("6fedab7f968b4133d7a3857bbb9567799185b222");
  });

  it("rejects file URLs without the signing parameters", () => {
    expect(() => buildXVersion("https://files.iwara.tv/file/video-file-id")).toThrow(AppError);
    expect(() => buildXVersion("not a url")).toThrow(AppError);
  });

  it("sniffs the salt from the frontend script", () => {
    const salt = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";
    const script = `const decoy = "AAAAAAAAAAAAAAAAAAAAAAAAa1"; const h = SHA1(fileUrl + expires + "_${salt}"); headers["X-Version"] = h;`;
    expect(extractXVersionSaltFromScript(script)).toBe(salt);
    expect(extractXVersionSaltFromScript("no salt here")).toBeUndefined();
  });

  it("orders script URLs with main bundles first", () => {
    const html = `<script src="/vendor.js"></script><script defer src="/main.abc123.js?v=1"></script><script src="https://cdn.example/x.js"></script>`;
    expect(scriptUrlsFromHtml(html, "https://www.iwara.tv/")[0]).toBe("https://www.iwara.tv/main.abc123.js?v=1");
  });
});

describe("JWT and session token capture", () => {
  const token = makeJwt({ username: "demo_user", exp: Math.floor(Date.now() / 1000) + 3600 });

  it("recognizes JWTs and ignores other dotted strings", () => {
    expect(isLikelyJwt(token)).toBe(true);
    // The Rust implementation accepted any dotted triple, e.g. hostnames and versions.
    expect(findJwt("https://www.iwara.tv/")).toBeUndefined();
    expect(findJwt(JSON.stringify({ version: "2.1.0" }))).toBeUndefined();
    expect(findJwt(`{"theme":"dark","settings":{"flags":[true,false],"version":1}}`)).toBeUndefined();
  });

  it("finds JWTs inside nested and stringified JSON values", () => {
    expect(findJwt(JSON.stringify({ auth: { accessToken: token } }))).toBe(token);
    expect(findJwt(JSON.stringify({ persisted: JSON.stringify({ token }) }))).toBe(token);
  });

  it("reads usernames and expiry from claims", () => {
    expect(usernameFromJwt(makeJwt({ user: { username: "nested" } }))).toBe("nested");
    expect(isJwtExpired(makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 }), 0)).toBe(true);
    expect(isJwtExpired(token, 120)).toBe(false);
    expect(isJwtExpired(makeJwt({}), 120)).toBe(false);
  });

  it("finds usernames inside profile storage values", () => {
    expect(findUsernameInStorageValue(`{"profile":{"username":"demo_user"}}`)).toBe("demo_user");
  });

  it("attaches the storage username to the captured token", () => {
    const captured = findToken({ localStorage: { auth: `{"user":{"name":"Demo Name"}}`, token: makeJwt({}) } });
    expect(captured?.username).toBe("Demo Name");
  });

  it("prefers the access token over the refresh token", () => {
    const refresh = makeJwt({ kind: "refresh" });
    const access = makeJwt({ kind: "access" });
    const captured = findToken({ localStorage: { token: refresh, accessToken: access } });
    expect(captured?.key).toBe("localStorage.accessToken");
    expect(captured?.value).toBe(access);
  });
});

describe("Iwara response mapping", () => {
  it("maps a live-shaped video summary", () => {
    const video = mapVideoSummary(rawVideo());
    expect(video).toMatchObject({
      id: "0bmwbE50acZY4B",
      description: "First line\nSecond & third",
      uploaderUsername: "jtvkq",
      uploaderFollowing: false,
      tags: ["koikatsu", "Mind_Break"],
      durationSeconds: 494,
      numViews: 63
    });
    // The selected frame, not always thumbnail-00 as before.
    expect(video.thumbnailUrl).toBe("https://i.iwara.tv/image/thumbnail/a283691e-4be7-4f7b-9f90-11a922a06fb6/thumbnail-09.jpg");
    expect(video.thumbnailFramesBase).toBe("https://i.iwara.tv/image/thumbnail/a283691e-4be7-4f7b-9f90-11a922a06fb6/");
    expect(thumbnailFrameUrl(video.thumbnailFramesBase!, 3)).toBe(`${video.thumbnailFramesBase}thumbnail-03.jpg`);
    expect(video.uploaderAvatarUrl).toBe(
      "https://i.iwara.tv/image/avatar/1511e132-d973-4181-8e1e-e3e8aadadc6d/1511e132-d973-4181-8e1e-e3e8aadadc6d.jpg"
    );
  });

  it("prefers the custom thumbnail and tolerates missing fields", () => {
    expect(mapVideoSummary(rawVideo({ customThumbnail: { id: "custom-1" } })).thumbnailUrl).toBe(
      "https://i.iwara.tv/image/thumbnail/custom-1/custom-1.jpg"
    );
    const empty = mapVideoSummary({});
    expect(empty).toMatchObject({ id: "", title: "Untitled", tags: [], numViews: 0 });
    expect(empty.thumbnailUrl).toBeUndefined();
  });

  it("maps comments and file lists", () => {
    expect(mapVideoComment({ id: "c1", body: "hi", numReplies: 2, user: { name: "A", avatar: { id: "x" } } })).toMatchObject({
      id: "c1",
      body: "hi",
      numReplies: 2,
      authorAvatarUrl: "https://i.iwara.tv/image/avatar/x/x.jpg"
    });
    expect(mapVideoComment({ id: "empty", body: "  " })).toBeUndefined();

    const formats = formatsFromJson([
      { name: "Source", type: "video/mp4", src: { view: "//a.iwara.tv/view", download: "//a.iwara.tv/download" } },
      { name: "540", src: { view: "https://a.iwara.tv/540" } },
      { name: "preview", src: "https://a.iwara.tv/p" },
      { name: "broken" }
    ]);
    expect(formats.map((format) => [format.label, format.qualityRank, format.url])).toEqual([
      ["Source", 4000, "https://a.iwara.tv/download"],
      ["540", 540, "https://a.iwara.tv/540"],
      ["preview", 1, "https://a.iwara.tv/p"]
    ]);
    // Formats outside https://*.iwara.tv never reach the player or get the session token.
    expect(formatsFromJson([
      { name: "Source", src: { view: "https://evil.example/v.mp4" } },
      { name: "540", src: { view: "http://a.iwara.tv/540" } },
      { name: "360", src: { view: "--script=x.lua" } },
      { name: "720", src: { view: "https://iwara.tv.evil.example/v" } }
    ])).toEqual([]);
    expect(chooseVideoFormat(formats, "540")?.label).toBe("540");
    expect(chooseVideoFormat(formats, "2160")?.label).toBe("Source");
    expect(summarizeJsonResponse(`{"results":[]}`).responseShape).toBe("object(results)");
  });

  it("normalizes durations, text and diagnostics URLs", () => {
    expect(durationSeconds(494)).toBe(494);
    expect(durationSeconds(494_000)).toBe(494);
    expect(durationSeconds("1:02:03")).toBe(3723);
    expect(durationSeconds("3:05")).toBe(185);
    expect(durationSeconds("abc")).toBeUndefined();
    expect(plainText("<p>a</p><p>b</p>\n\n\n\nc")).toBe("a\nb\n\nc");
    expect(safeUrl("https://files.iwara.tv/file/x?expires=1&hash=secret")).toBe("https://files.iwara.tv/file/x?...");
  });

  it("extracts the username and avatar from the current-user response", () => {
    const profile = extractAuthProfile({
      balance: 0,
      user: { id: "user-id", name: "demo_user", username: "demo_user", avatar: { id: "e8532034-73e1-48d3-ad31-344ae7aa7768" } },
      profile: { user: null }
    });
    expect(profile.username).toBe("demo_user");
    expect(profile.avatarUrl).toBe(
      "https://i.iwara.tv/image/avatar/e8532034-73e1-48d3-ad31-344ae7aa7768/e8532034-73e1-48d3-ad31-344ae7aa7768.jpg"
    );
  });
});

describe("download planning", () => {
  it("splits download segments without gaps", () => {
    const total = 10 * 1024 * 1024;
    const segments = downloadSegments(total, 4);
    expect(segments).toHaveLength(4);
    expect(segments[0]!.start).toBe(0);
    expect(segments.at(-1)!.end).toBe(total - 1);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index - 1]!.end + 1).toBe(segments[index]!.start);
    }
    expect(downloadSegments(1500, 8)).toEqual([{ index: 0, start: 0, end: 1499 }]);
  });

  it("parses the total size from Content-Range", () => {
    expect(totalBytesFromContentRange("bytes 0-0/12345")).toBe(12_345);
    expect(totalBytesFromContentRange("bytes */987")).toBe(987);
    expect(totalBytesFromContentRange("bytes 0-0/*")).toBeUndefined();
  });

  it("skips paths that running downloads have claimed", async () => {
    const format = { id: "Source", label: "Source", url: "https://a.iwara.tv/v.mp4", qualityRank: 4000 };
    const first = await uniqueDownloadPath("/downloads", "Title", "abc", format);
    expect(first).toBe(path.join("/downloads", "Title [abc] - Source.mp4"));
    expect(await uniqueDownloadPath("/downloads", "Title", "abc", format, new Set([first]))).toBe(path.join("/downloads", "Title [abc] - Source (1).mp4"));
  });

  it("produces safe file names", () => {
    expect(sanitizeFileStem(`a<b>:c"d/e\\f|g?h*i`)).toBe("a_b__c_d_e_f_g_h_i");
    expect(sanitizeFileStem("...")).toBe("Iwara Video");
    expect(sanitizeFileStem("CON")).toBe("Iwara Video CON");
    expect([...sanitizeFileStem("长".repeat(300))]).toHaveLength(150);
    expect(downloadExtension({ id: "x", label: "x", url: "https://a.iwara.tv/v.webm?x=1", qualityRank: 0 })).toBe("webm");
    expect(downloadExtension({ id: "x", label: "x", url: "https://a.iwara.tv/v", ext: "../exe", qualityRank: 0 })).toBe("mp4");
    // Only video containers: a server-chosen .bat/.hta would run when opened.
    for (const name of ["x.bat", "x.hta", "x.scr", "x.command", "x.exe"]) {
      expect(downloadExtension({ id: "x", label: "x", url: `https://a.iwara.tv/${name}`, qualityRank: 0 })).toBe("mp4");
    }
    expect(downloadExtension({ id: "x", label: "x", url: "https://a.iwara.tv/v", ext: "WEBM", qualityRank: 0 })).toBe("webm");
  });
});

describe("helpers", () => {
  it("deep-merges JSON onto defaults", () => {
    expect(mergeJson({ a: { b: 1, c: 2 }, list: [1] }, { a: { b: 5 }, list: [2, 3], extra: true })).toEqual({
      a: { b: 5, c: 2 },
      list: [2, 3],
      extra: true
    });
  });

  it("serializes errors with codes", () => {
    expect(serializeError(new AppError("MPV_NOT_FOUND", "x"))).toMatchObject({ code: "MPV_NOT_FOUND" });
    expect(serializeError(Object.assign(new Error("gone"), { code: "ENOENT" })).code).toBe("FILE_NOT_FOUND");
    expect(serializeError(new TypeError("fetch failed")).code).toBe("NETWORK_ERROR");
    expect(serializeError("weird").code).toBe("UNKNOWN");
  });
});

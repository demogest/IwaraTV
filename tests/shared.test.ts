import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/shared/csp";
import { buildMediaHostCandidates, normalizeMediaHostList, replaceMediaUrlHost } from "../src/shared/media-hosts";
import { buildExternalPlayerArgs, splitTemplateArgs, templateIncludesUrl } from "../src/shared/player-template";
import { normalizeTagList, splitTagInput } from "../src/shared/tags";
import { classifyOmniboxInput, parseIwaraVideoId } from "../src/shared/video-id";

describe("video IDs", () => {
  it("parses bare IDs and video page URLs", () => {
    expect(parseIwaraVideoId("abc123XYZ")).toBe("abc123XYZ");
    expect(parseIwaraVideoId("https://www.iwara.tv/video/7rr1s5u30B2RtG/title")).toBe("7rr1s5u30B2RtG");
    expect(parseIwaraVideoId("https://iwara.tv/videos/AbCdEf123")).toBe("AbCdEf123");
    expect(parseIwaraVideoId("not a video")).toBeUndefined();
    expect(parseIwaraVideoId("abc")).toBeUndefined();
  });

  it("decides between opening a video and searching", () => {
    expect(classifyOmniboxInput("  ")).toEqual({ kind: "empty" });
    expect(classifyOmniboxInput("https://www.iwara.tv/video/7rr1s5u30B2RtG")).toEqual({ kind: "video", videoId: "7rr1s5u30B2RtG" });
    expect(classifyOmniboxInput("miku dance")).toEqual({ kind: "search", query: "miku dance" });
    expect(classifyOmniboxInput("7rr1s5u30B2RtG")).toMatchObject({ kind: "ambiguous", preferVideo: true });
    expect(classifyOmniboxInput("blender")).toMatchObject({ kind: "ambiguous", preferVideo: false });
  });
});

describe("media hosts", () => {
  it("builds safe media host replacement candidates", () => {
    expect(normalizeMediaHostList(["https://jade.iwara.tv/view", " kafka.iwara.tv ", "example.com", "evil.iwara.tv.example.com"])).toEqual([
      "jade.iwara.tv",
      "kafka.iwara.tv"
    ]);
    expect(replaceMediaUrlHost("//jade.iwara.tv/view?hash=abc&path=2026", "kafka.iwara.tv")).toBe(
      "https://kafka.iwara.tv/view?hash=abc&path=2026"
    );
    expect(buildMediaHostCandidates("//jade.iwara.tv/view?hash=abc", ["kafka.iwara.tv", "jade.iwara.tv"])).toEqual([
      { host: "jade.iwara.tv", url: "https://jade.iwara.tv/view?hash=abc" },
      { host: "kafka.iwara.tv", url: "https://kafka.iwara.tv/view?hash=abc" }
    ]);
  });
});

describe("external player templates", () => {
  it("splits and expands templates", () => {
    expect(splitTemplateArgs(`--play "{url}" --title '{title}'`)).toEqual(["--play", "{url}", "--title", "{title}"]);
    expect(
      buildExternalPlayerArgs(`--url "{url}" --name "{title}" --headers "{headers}"`, {
        url: "https://media.example/video.mp4",
        title: "Demo Title",
        headers: "Referer: https://www.iwara.tv/"
      })
    ).toEqual(["--url", "https://media.example/video.mp4", "--name", "Demo Title", "--headers", "Referer: https://www.iwara.tv/"]);
    expect(templateIncludesUrl("--play {url}")).toBe(true);
    expect(templateIncludesUrl("--empty")).toBe(false);
  });

  it("defaults to {url}, keeps escapes and rejects unclosed quotes", () => {
    expect(splitTemplateArgs("   ")).toEqual(["{url}"]);
    expect(splitTemplateArgs(String.raw`a\ b "c d" ""`)).toEqual(["a b", "c d", ""]);
    expect(() => splitTemplateArgs(`--title "{title}`)).toThrow(/unclosed quote/);
  });
});

describe("tags", () => {
  it("normalizes and splits tag input", () => {
    expect(normalizeTagList([" Koikatsu", "koikatsu", "", "MMD"])).toEqual(["koikatsu", "mmd"]);
    expect(splitTagInput("blender, MMD；dance、4k\nmusic")).toEqual(["blender", "mmd", "dance", "4k", "music"]);
  });
});

describe("content security policy", () => {
  it("is strict in production and only relaxes what the dev server needs", () => {
    const production = contentSecurityPolicy({ dev: false });
    expect(production).toContain("script-src 'self';");
    expect(production).not.toContain("unsafe-eval");
    expect(production).toContain("object-src 'none'");
    expect(production).toContain("connect-src 'self';");
    expect(contentSecurityPolicy({ dev: true })).toContain("script-src 'self' 'unsafe-inline'");
  });
});

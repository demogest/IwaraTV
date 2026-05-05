import { describe, expect, it } from "vitest";
import {
  buildXVersion,
  chooseVideoFormat,
  extractXVersionSaltFromScript,
  parseIwaraVideoId,
  qualityRank,
  withIwaraDownloadName
} from "../src/shared/iwara-utils";
import { buildMediaHostCandidates, normalizeMediaHostList, replaceMediaUrlHost } from "../src/shared/media-speed-utils";
import type { VideoFormat } from "../src/shared/types";

describe("iwara utilities", () => {
  it("parses video ids and URLs", () => {
    expect(parseIwaraVideoId("abc123XYZ")).toBe("abc123XYZ");
    expect(parseIwaraVideoId("https://www.iwara.tv/video/7rr1s5u30B2RtG/title")).toBe("7rr1s5u30B2RtG");
    expect(parseIwaraVideoId("https://iwara.tv/videos/k2ayoueezfkx6gvq")).toBe("k2ayoueezfkx6gvq");
  });

  it("builds the known X-Version hash shape", () => {
    const hash = buildXVersion("https://files.iwara.tv/file/video-file-id?expires=1700000000");
    expect(hash).toHaveLength(40);
    expect(hash).toBe("6fedab7f968b4133d7a3857bbb9567799185b222");
  });

  it("matches the current web app X-Version salt", () => {
    const hash = buildXVersion("https://filesq.iwara.tv/file/ac85c86f-a2aa-4b91-95f8-69f268920929?expires=1777962801804");
    expect(hash).toBe("5f1267ba367e35cabf53755f4310381e9846a133");
  });

  it("can use and sniff the X-Version salt", () => {
    const fileUrl = "https://filesq.iwara.tv/file/ac85c86f-a2aa-4b91-95f8-69f268920929?expires=1777962801804";
    const salt = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";
    expect(buildXVersion(fileUrl, salt)).toBe("5f1267ba367e35cabf53755f4310381e9846a133");
    expect(extractXVersionSaltFromScript(`const h = SHA1(fileUrl + expires + "_${salt}"); headers["X-Version"] = h;`)).toBe(salt);
  });

  it("adds the web app download name before requesting file variants", () => {
    const url = withIwaraDownloadName(
      "https://filesq.iwara.tv/file/ac85c86f-a2aa-4b91-95f8-69f268920929?expires=1777962801804",
      "Demo Title",
      "abc123"
    );
    expect(new URL(url).searchParams.get("download")).toBe("Iwara - Demo Title [abc123].mp4");
  });

  it("ranks and selects quality", () => {
    const formats: VideoFormat[] = [
      { id: "preview", label: "preview", url: "https://example.test/p.mp4", qualityRank: qualityRank("preview") },
      { id: "540", label: "540", url: "https://example.test/540.mp4", qualityRank: qualityRank("540") },
      { id: "Source", label: "Source", url: "https://example.test/source.mp4", qualityRank: qualityRank("Source") }
    ];

    expect(chooseVideoFormat(formats)?.id).toBe("Source");
    expect(chooseVideoFormat(formats, "540")?.id).toBe("540");
  });

  it("builds safe media host replacement candidates", () => {
    expect(normalizeMediaHostList(["https://jade.iwara.tv/view", " kafka.iwara.tv ", "example.com"])).toEqual([
      "jade.iwara.tv",
      "kafka.iwara.tv"
    ]);
    expect(replaceMediaUrlHost("//jade.iwara.tv/view?hash=abc&path=2026", "kafka.iwara.tv")).toBe(
      "https://kafka.iwara.tv/view?hash=abc&path=2026"
    );
    expect(buildMediaHostCandidates("//jade.iwara.tv/view?hash=abc", ["kafka.iwara.tv"])).toEqual([
      { host: "jade.iwara.tv", url: "https://jade.iwara.tv/view?hash=abc" },
      { host: "kafka.iwara.tv", url: "https://kafka.iwara.tv/view?hash=abc" }
    ]);
  });
});

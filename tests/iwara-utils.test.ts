import { describe, expect, it } from "vitest";
import { buildXVersion, chooseVideoFormat, parseIwaraVideoId, qualityRank } from "../src/shared/iwara-utils";
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
    expect(hash).toBe("e477352e5d18dbd0545cf841fc1ded12ec4a73b2");
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
});

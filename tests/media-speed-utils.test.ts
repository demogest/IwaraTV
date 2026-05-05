import { describe, expect, it } from "vitest";
import { buildMediaHostCandidates, normalizeMediaHostList, replaceMediaUrlHost } from "../src/lib/media-speed-utils";

describe("media speed utilities", () => {
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

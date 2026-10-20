import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNotes } from "../src/renderer/components/ReleaseNotes";
import { createTranslator, resolveLocale, type TranslationKey } from "../src/renderer/i18n";
import { en } from "../src/renderer/i18n/en";
import { ja } from "../src/renderer/i18n/ja";
import { zhCN } from "../src/renderer/i18n/zh-CN";
import { zhTW } from "../src/renderer/i18n/zh-TW";
import { LOCALES } from "../src/shared/locales";
import { describeErrorCode } from "../src/renderer/lib/errors";
import { formatBytes, formatDuration, formatRemaining, qualityLabel, relativeTime } from "../src/renderer/lib/format";
import { playLabel, playerName } from "../src/renderer/lib/player";
import { addRecentSearch, clearRecentSearches, readRecentSearches, removeRecentSearch } from "../src/renderer/lib/recent-searches";
import { APP_ERROR_CODES } from "../src/shared/errors";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(path, [value]);
    } else if ("other" in value && typeof value.other === "string") {
      result.set(path, Object.values(value) as string[]);
    } else {
      for (const [childPath, texts] of leaves(value, path)) {
        result.set(childPath, texts);
      }
    }
  }
  return result;
}

const placeholders = (texts: string[]) => [...new Set(texts.flatMap((text) => text.match(/\{\w+\}/g) ?? []))].sort();

describe("translations", () => {
  const english = leaves(en as unknown as Tree);
  const others = { "zh-CN": zhCN, "zh-TW": zhTW, ja } as const;

  it.each(Object.entries(others))("%s covers the same keys as English", (_locale, dictionary) => {
    expect([...leaves(dictionary as unknown as Tree).keys()].sort()).toEqual([...english.keys()].sort());
  });

  it.each(Object.entries(others))("%s uses the same placeholders as English", (_locale, dictionary) => {
    const translated = leaves(dictionary as unknown as Tree);
    const mismatched = [...english].filter(([key, texts]) => placeholders(texts).join() !== placeholders(translated.get(key) ?? []).join());
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it("have no empty strings", () => {
    for (const dictionary of [en, ...Object.values(others)]) {
      for (const [key, texts] of leaves(dictionary as unknown as Tree)) {
        expect(texts.every((text) => text.trim().length > 0), key).toBe(true);
      }
    }
  });

  it("use local quotation marks and no stray CJK spacing", () => {
    for (const [locale, dictionary] of Object.entries(others)) {
      for (const [key, texts] of leaves(dictionary as unknown as Tree)) {
        for (const text of texts) {
          // Taiwan and Japan quote with 「」; a Chinese or Japanese name never sits between spaces.
          if (locale !== "zh-CN") {
            expect(text, `${locale} ${key}`).not.toMatch(/[“”]/);
          }
          expect(text, `${locale} ${key}`).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff] [\u3040-\u30ff\u4e00-\u9fff]+ [\u3040-\u30ff\u4e00-\u9fff]/);
        }
      }
    }
  });

  it("describe every backend error code", () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      for (const code of APP_ERROR_CODES) {
        const description = describeErrorCode(code, "details", t);
        expect(description.title, `${locale} ${code}`).not.toMatch(/^errors\./);
        expect(description.detail, `${locale} ${code}`).not.toMatch(/^errors\./);
      }
    }
  });

  it("formats plurals and numbers per locale", () => {
    const t = createTranslator("en");
    expect(t("nav.activeDownloads", { count: 1 })).toBe("1 active download");
    expect(t("nav.activeDownloads", { count: 1200 })).toBe("1,200 active downloads");
    expect(createTranslator("zh-CN")("nav.activeDownloads", { count: 2 })).not.toContain("{count}");
    expect(t("missing.key" as TranslationKey)).toBe("missing.key");
  });

  it("resolves the system language", () => {
    expect(resolveLocale("system", ["zh-CN", "en"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-TW", "en"])).toBe("zh-TW");
    expect(resolveLocale("system", ["zh-Hant-HK"])).toBe("zh-TW");
    expect(resolveLocale("system", ["zh-SG"])).toBe("zh-CN");
    expect(resolveLocale("system", ["ja-JP", "zh-CN"])).toBe("ja");
    expect(resolveLocale("system", ["de-DE", "en-US", "ja"])).toBe("en");
    expect(resolveLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("ja", ["en"])).toBe("ja");
  });

  it("explains main-process errors in the user's language", () => {
    const zh = createTranslator("zh-TW");
    expect(describeErrorCode("UPDATE_INVALID", "The update information's signature isn't valid.", zh, { reason: "signature" }).detail)
      .toBe("更新資訊的簽章無效，未安裝任何內容。");
    expect(describeErrorCode("HTTP_ERROR", "Request failed: HTTP 503", createTranslator("ja"), { reason: "status", status: 503 }).detail)
      .toContain("HTTP 503");
    // Unknown reasons fall back to the English message.
    expect(describeErrorCode("DOWNLOAD_FAILED", "disk full", zh, { reason: "nope" }).detail).toBe("disk full");
    expect(describeErrorCode("UNKNOWN", "boom", zh).detail).toBe("boom");
  });
});

describe("format helpers", () => {
  it("formats durations and remaining time", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3723.4)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatRemaining(1000, 10)).toBe("1:40");
    expect(formatRemaining(1000, 0)).toBeUndefined();
    expect(formatRemaining(0, 10)).toBeUndefined();
  });

  it("formats byte sizes", () => {
    expect(formatBytes(undefined, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(1536, "en")).toBe("2 KB");
    expect(formatBytes(5.25 * 1024 * 1024, "en")).toBe("5.3 MB");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(relativeTime("2026-10-16T12:00:00Z", "en", now)).toBe("3 days ago");
    expect(relativeTime("2026-10-19T11:59:40Z", "en", now)).toBe("this minute");
    expect(relativeTime(undefined, "en", now)).toBe("");
    expect(relativeTime("garbage", "en", now)).toBe("");
  });

  it("labels qualities", () => {
    const t = createTranslator("en");
    expect(qualityLabel("540", t)).toBe("540p");
    expect(qualityLabel("Source", t)).toBe("Source");
    expect(qualityLabel("preview", t)).toBe("Preview");
    expect(qualityLabel("Source", createTranslator("zh-CN"))).toBe("原画");
  });
});

describe("player labels", () => {
  it("names each player mode", () => {
    const t = createTranslator("en");
    expect(playLabel("builtin", t)).toBe("Play here");
    expect(playLabel("mpv", t)).toBe("Play in MPV");
    expect(playLabel("external", t)).toBe("Play in external player");
    const zh = createTranslator("zh-CN");
    expect(playLabel("mpv", zh)).toBe("用 MPV 播放");
    expect(playLabel("external", zh)).toBe("用外部播放器播放");
    expect(playerName("builtin", createTranslator("zh-CN"))).toBe("IwaraTV");
  });
});

describe("recent searches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the latest eight unique searches", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
    for (const query of ["a", "b", "A ", "  ", "c", "d", "e", "f", "g", "h", "i"]) {
      addRecentSearch(query);
    }
    expect(readRecentSearches()).toEqual(["i", "h", "g", "f", "e", "d", "c", "A"]);
    removeRecentSearch("g");
    expect(readRecentSearches()).not.toContain("g");
    clearRecentSearches();
    expect(readRecentSearches()).toEqual([]);
  });

  it("works without storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(() => addRecentSearch("x")).not.toThrow();
    expect(readRecentSearches()).toEqual([]);
  });
});

describe("release notes", () => {
  it("keeps headings, lists and paragraphs from the Markdown the release job ships", () => {
    const notes = [
      "## IwaraTV 2.1",
      "",
      "> **Heads up.** Read this",
      "> before updating.",
      "",
      "- **Built-in updates** — see [the docs](https://example.com).",
      "- A wrapped",
      "  list item",
      "",
      "### ⚠️ Breaking changes",
      "* `Node 24` required"
    ].join("\n");
    expect(parseNotes(notes)).toEqual([
      { kind: "heading", text: "IwaraTV 2.1" },
      { kind: "paragraph", text: "**Heads up.** Read this before updating." },
      { kind: "list", items: ["**Built-in updates** — see [the docs](https://example.com).", "A wrapped list item"] },
      { kind: "heading", text: "⚠️ Breaking changes" },
      { kind: "list", items: ["`Node 24` required"] }
    ]);
  });
});

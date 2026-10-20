import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNotes } from "../src/renderer/components/ReleaseNotes";
import { createTranslator, resolveLocale, type TranslationKey } from "../src/renderer/i18n";
import { en } from "../src/renderer/i18n/en";
import { zhCN } from "../src/renderer/i18n/zh-CN";
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
  const chinese = leaves(zhCN as unknown as Tree);

  it("cover the same keys in both languages", () => {
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("use the same placeholders in both languages", () => {
    const mismatched = [...english].filter(([key, texts]) => placeholders(texts).join() !== placeholders(chinese.get(key) ?? []).join());
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it("have no empty strings", () => {
    for (const [key, texts] of [...english, ...chinese]) {
      expect(texts.every((text) => text.trim().length > 0), key).toBe(true);
    }
  });

  it("describe every backend error code", () => {
    for (const locale of ["en", "zh-CN"] as const) {
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
    expect(resolveLocale("system", ["zh-TW", "en"])).toBe("zh-CN");
    expect(resolveLocale("system", ["de-DE", "en-US"])).toBe("en");
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
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
    expect(qualityLabel("540")).toBe("540p");
    expect(qualityLabel("Source")).toBe("Source");
    expect(qualityLabel("preview")).toBe("Preview");
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

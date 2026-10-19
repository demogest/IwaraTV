import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyData, tauriDataDirectory } from "../src/main/lib/migration";
import { FavoriteStore } from "../src/main/services/favorite-store";
import { normalizeSettings, SettingsStore } from "../src/main/services/settings-store";
import { createDefaultSettings } from "../src/shared/defaults";
import type { VideoSummary } from "../src/shared/types";
import { tempDir } from "./helpers";

function video(id: string, title: string, extra: Partial<VideoSummary> = {}): VideoSummary {
  return { id, title, tags: [], numViews: 0, numLikes: 0, numComments: 0, ...extra };
}

describe("SettingsStore", () => {
  it("normalizes tag preferences (blocked wins over followed)", () => {
    const settings = createDefaultSettings();
    settings.tagPreferences = { followedTags: ["Koikatsu", "muted"], blockedTags: [" muted "], maxScanPages: 99, requestDelayMs: 2000 };
    const normalized = normalizeSettings(settings).tagPreferences;
    expect(normalized).toEqual({ followedTags: ["koikatsu"], blockedTags: ["muted"], maxScanPages: 10, requestDelayMs: 1500 });
  });

  it("loads a Tauri-era settings file and fills in new defaults", () => {
    const dir = tempDir("settings-legacy");
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        player: { preferredMode: "external", externalPlayerArgs: "--play {url}", externalPlayerPath: "C:\\Player.exe" },
        mediaSpeed: { candidateHosts: ["https://jade.iwara.tv/x", "bad.example.com"] },
        history: [{ video: video("a", "A"), formatId: "Source", playedAt: "2026-01-01T00:00:00Z", mode: "mpv" }, { broken: true }]
      })
    );
    const settings = new SettingsStore(dir, "/downloads/IwaraTV").get();
    expect(settings.player).toMatchObject({ preferredMode: "external", externalPlayerArgs: "--play {url}", preferredQuality: "Source" });
    expect(settings.mediaSpeed.candidateHosts).toEqual(["jade.iwara.tv"]);
    expect(settings.ui).toEqual({ language: "system", theme: "system", rating: "all" });
    expect(settings.download.directory).toBe("/downloads/IwaraTV");
    expect(settings.history).toHaveLength(1);
  });

  it("keeps a cleared optional value across restarts", () => {
    const dir = tempDir("settings-clear");
    new SettingsStore(dir).update({ player: { preferredQuality: null }, download: { defaultQuality: null } });
    const reloaded = new SettingsStore(dir).get();
    expect(reloaded.player.preferredQuality).toBeUndefined();
    expect(reloaded.download.defaultQuality).toBeUndefined();
  });

  it("falls back to the default download folder when cleared", () => {
    const store = new SettingsStore(tempDir("settings-dir"), "/default/IwaraTV");
    expect(store.update({ download: { directory: "  " } }).download.directory).toBe("/default/IwaraTV");
  });

  it("ignores unknown keys, coerces bad values and notifies listeners", () => {
    const store = new SettingsStore(tempDir("settings-patch"));
    const seen: string[] = [];
    store.onChange((settings) => seen.push(settings.ui.theme));
    const next = store.update({
      ui: { theme: "light", language: "fr" as never },
      player: { preferredMode: "vlc" as never, bogus: 1 } as never,
      download: { maxConnections: 99 }
    });
    expect(next.ui).toMatchObject({ theme: "light", language: "system" });
    expect(next.player.preferredMode).toBe("mpv");
    expect(next.player).not.toHaveProperty("bogus");
    expect(next.download.maxConnections).toBe(8);
    expect(seen).toEqual(["light"]);
  });

  it("keeps playback history unique and bounded", () => {
    const store = new SettingsStore(tempDir("settings-history"));
    for (let index = 0; index < 120; index += 1) {
      store.addHistory({ video: video(`v${index % 110}`, "x"), formatId: "Source", playedAt: new Date().toISOString(), mode: "mpv" });
    }
    const history = store.get().history;
    expect(history).toHaveLength(100);
    expect(history[0]!.video.id).toBe("v9");
    expect(new Set(history.map((item) => item.video.id)).size).toBe(100);
  });

  it("ranks media hosts by measured speed", () => {
    const store = new SettingsStore(tempDir("settings-rank"));
    const next = store.updateMediaHostRanking(
      [
        { host: "slow.iwara.tv", url: "", ok: true, bytesPerSecond: 10 },
        { host: "down.iwara.tv", url: "", ok: false },
        { host: "fast.iwara.tv", url: "", ok: true, bytesPerSecond: 100 }
      ],
      "2026-01-01T00:00:00Z"
    );
    expect(next.mediaSpeed.rankedHosts).toEqual(["fast.iwara.tv", "slow.iwara.tv"]);
    expect(next.mediaSpeed.candidateHosts).toContain("down.iwara.tv");
  });
});

describe("FavoriteStore", () => {
  it("deduplicates and refreshes video metadata on add", () => {
    const store = new FavoriteStore(tempDir("fav-add"));
    const first = store.add(video("a", "First"));
    const favoritedAt = first.items[0]!.favoritedAt;
    const second = store.add(video("a", "Second"));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.favoritedAt).toBe(favoritedAt);
    expect(second.items[0]!.video.title).toBe("Second");
  });

  it("restores a removed favorite with its original timestamp (undo)", () => {
    const store = new FavoriteStore(tempDir("fav-undo"));
    store.add(video("a", "A"));
    const removed = store.state().items[0]!;
    store.remove("a");
    expect(store.state().items).toHaveLength(0);
    expect(store.restore({ ...removed, favoritedAt: "2020-01-01T00:00:00Z" }).items[0]!.favoritedAt).toBe("2020-01-01T00:00:00Z");
  });

  it("merges duplicates and adds new items on import", async () => {
    const dir = tempDir("fav-import");
    const store = new FavoriteStore(dir);
    store.add(video("a", "Local"));
    const importPath = path.join(dir, "import.json");
    writeFileSync(
      importPath,
      JSON.stringify({
        schemaVersion: 1,
        exportedAt: "2020-01-01T00:00:00Z",
        items: [
          { video: video("a", "Incoming", { uploaderName: "Uploader" }), favoritedAt: "2020-01-01T00:00:00Z", note: "keep" },
          { video: video("b", "New"), favoritedAt: "2021-01-01T00:00:00Z" },
          { video: { title: "no id" }, favoritedAt: "2021-01-01T00:00:00Z" }
        ]
      })
    );
    const report = await store.importFromPath(importPath);
    expect(report).toMatchObject({ imported: 1, merged: 1, skipped: 1, total: 2 });
    const merged = report.state.items.find((item) => item.video.id === "a")!;
    expect(merged.favoritedAt).toBe("2020-01-01T00:00:00Z");
    expect(merged.video.title).toBe("Local");
    expect(merged.video.uploaderName).toBe("Uploader");
    expect(merged.note).toBe("keep");
    // Persisted for the next launch.
    expect(new FavoriteStore(dir).state().items).toHaveLength(2);
  });

  it("rejects files that are not favorites exports", async () => {
    const dir = tempDir("fav-invalid");
    writeFileSync(path.join(dir, "bad.json"), "{ nope");
    writeFileSync(path.join(dir, "other.json"), JSON.stringify({ hello: "world" }));
    const store = new FavoriteStore(dir);
    await expect(store.importFromPath(path.join(dir, "bad.json"))).rejects.toMatchObject({ code: "FAVORITES_FILE_INVALID" });
    await expect(store.importFromPath(path.join(dir, "other.json"))).rejects.toMatchObject({ code: "FAVORITES_FILE_INVALID" });
  });

  it("exports in the documented format", () => {
    const dir = tempDir("fav-export");
    const store = new FavoriteStore(dir);
    store.add(video("a", "A"));
    const result = store.exportToPath(path.join(dir, "out.json"));
    const exported = JSON.parse(readFileSync(result.path!, "utf8"));
    expect(exported).toMatchObject({ schemaVersion: 1, items: [{ video: { id: "a" } }] });
  });
});

describe("legacy data migration", () => {
  it("locates the Tauri data directory per platform", () => {
    expect(tauriDataDirectory("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toContain("local.iwaratv.player");
    expect(tauriDataDirectory("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Application Support/local.iwaratv.player");
    expect(tauriDataDirectory("linux", {}, "/home/u")).toBe("/home/u/.local/share/local.iwaratv.player");
    expect(tauriDataDirectory("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/local.iwaratv.player");
  });

  it("copies data once and keeps a backup of files it replaces", () => {
    const source = tempDir("migrate-src");
    const target = tempDir("migrate-dst");
    writeFileSync(path.join(source, "settings.json"), `{"from":"tauri"}`);
    writeFileSync(path.join(source, "favorites.json"), `{"items":[]}`);
    writeFileSync(path.join(target, "settings.json"), `{"from":"old-electron"}`);

    expect(migrateLegacyData(target, source)).toBe(source);
    expect(readFileSync(path.join(target, "settings.json"), "utf8")).toBe(`{"from":"tauri"}`);
    expect(readFileSync(path.join(target, "settings.pre-migration.json"), "utf8")).toBe(`{"from":"old-electron"}`);
    expect(existsSync(path.join(target, "downloads.json"))).toBe(false);

    writeFileSync(path.join(source, "settings.json"), `{"from":"tauri-later"}`);
    expect(migrateLegacyData(target, source)).toBeUndefined();
    expect(readFileSync(path.join(target, "settings.json"), "utf8")).toBe(`{"from":"tauri"}`);
  });

  it("does nothing on a fresh install", () => {
    const target = path.join(tempDir("migrate-fresh"), "nested");
    mkdirSync(target, { recursive: true });
    expect(migrateLegacyData(target, path.join(target, "missing"))).toBeUndefined();
    expect(existsSync(path.join(target, ".migration.json"))).toBe(true);
  });
});

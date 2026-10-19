import path from "node:path";
import { createDefaultSettings, HISTORY_LIMIT } from "../../shared/defaults";
import { normalizeMediaHostList } from "../../shared/media-hosts";
import { normalizeTagList } from "../../shared/tags";
import type {
  AppSettings,
  LanguagePreference,
  MediaSpeedCandidateResult,
  PlaybackHistoryItem,
  PlayerMode,
  RatingFilter,
  SettingsPatch,
  ThemePreference
} from "../../shared/types";
import { isRecord, mergeJson, readJsonFile, writeJsonFileAtomic } from "../lib/json-file";

type Listener = (settings: AppSettings) => void;

export class SettingsStore {
  private readonly filePath: string;
  private readonly defaults: AppSettings;
  private settings: AppSettings;
  private readonly listeners = new Set<Listener>();

  constructor(userDataPath: string, defaultDownloadDirectory?: string) {
    this.filePath = path.join(userDataPath, "settings.json");
    this.defaults = createDefaultSettings();
    this.defaults.download.directory = defaultDownloadDirectory;
    this.settings = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: SettingsPatch): AppSettings {
    const next = structuredClone(this.settings);
    applyPatch(next, patch);
    return this.commit(normalizeSettings(next, this.defaults));
  }

  reset(): AppSettings {
    const next = structuredClone(this.defaults);
    next.history = this.settings.history;
    return this.commit(next);
  }

  addHistory(item: PlaybackHistoryItem): AppSettings {
    const next = structuredClone(this.settings);
    next.history = [item, ...next.history.filter((entry) => entry.video.id !== item.video.id)].slice(0, HISTORY_LIMIT);
    return this.commit(next);
  }

  addMediaHosts(hosts: Array<string | undefined>): AppSettings {
    const merged = normalizeMediaHostList([
      ...this.settings.mediaSpeed.candidateHosts,
      ...hosts.filter((host): host is string => Boolean(host))
    ]);
    if (merged.join("\n") === this.settings.mediaSpeed.candidateHosts.join("\n")) {
      return this.get();
    }
    const next = structuredClone(this.settings);
    next.mediaSpeed.candidateHosts = merged;
    return this.commit(next);
  }

  updateMediaHostRanking(results: readonly MediaSpeedCandidateResult[], testedAt: string): AppSettings {
    const next = structuredClone(this.settings);
    const ranked = results
      .filter((result) => result.ok)
      .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))
      .map((result) => result.host);
    next.mediaSpeed.candidateHosts = normalizeMediaHostList([
      ...next.mediaSpeed.candidateHosts,
      ...results.map((result) => result.host)
    ]);
    next.mediaSpeed.rankedHosts = normalizeMediaHostList(ranked);
    next.mediaSpeed.lastTestedAt = testedAt;
    return this.commit(next);
  }

  private commit(next: AppSettings): AppSettings {
    writeJsonFileAtomic(this.filePath, toPersisted(next));
    this.settings = next;
    const snapshot = this.get();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private load(): AppSettings {
    const raw = readJsonFile(this.filePath);
    if (!isRecord(raw)) {
      return structuredClone(this.defaults);
    }
    return normalizeSettings(mergeJson(structuredClone(this.defaults), raw) as AppSettings, this.defaults);
  }
}

function applyPatch(settings: AppSettings, patch: SettingsPatch): void {
  if (!isRecord(patch)) {
    return;
  }
  for (const section of ["player", "iwara", "mediaSpeed", "download", "tagPreferences", "ui"] as const) {
    const sectionPatch = patch[section];
    if (!isRecord(sectionPatch)) {
      continue;
    }
    const target = settings[section] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(sectionPatch)) {
      if (!(key in target) && !OPTIONAL_KEYS.has(`${section}.${key}`)) {
        continue;
      }
      if (value === null) {
        delete target[key];
      } else if (value !== undefined) {
        target[key] = value;
      }
    }
  }
  if (Array.isArray(patch.history)) {
    settings.history = patch.history;
  }
}

/**
 * Cleared optional values are stored as explicit `null`; a missing key would
 * otherwise be filled from the defaults again on the next launch.
 */
function toPersisted(settings: AppSettings): Record<string, unknown> {
  const persisted = structuredClone(settings) as unknown as Record<string, Record<string, unknown>>;
  for (const key of OPTIONAL_KEYS) {
    const [section, name] = key.split(".") as [string, string];
    const target = persisted[section];
    if (target && target[name] === undefined) {
      target[name] = null;
    }
  }
  return persisted;
}

const OPTIONAL_KEYS = new Set([
  "player.mpvPath",
  "player.externalPlayerPath",
  "player.preferredQuality",
  "iwara.lastSaltSniffAt",
  "iwara.lastSaltSource",
  "mediaSpeed.lastTestedAt",
  "download.directory",
  "download.defaultQuality"
]);

const PLAYER_MODES: PlayerMode[] = ["mpv", "external"];
const LANGUAGES: LanguagePreference[] = ["system", "zh-CN", "en"];
const THEMES: ThemePreference[] = ["system", "dark", "light"];
const RATINGS: RatingFilter[] = ["all", "general", "ecchi"];

/** Coerces every field into a valid value so a hand-edited or old file can't break the app. */
export function normalizeSettings(settings: AppSettings, defaults: AppSettings = createDefaultSettings()): AppSettings {
  const player = settings.player;
  const iwara = settings.iwara;
  const media = settings.mediaSpeed;
  const download = settings.download;
  const tags = settings.tagPreferences;
  const ui = settings.ui;
  const blockedTags = normalizeTagList(stringArray(tags.blockedTags));
  const blocked = new Set(blockedTags);

  return {
    player: dropUndefined({
      preferredMode: oneOf(player.preferredMode, PLAYER_MODES, defaults.player.preferredMode),
      mpvPath: optionalText(player.mpvPath),
      externalPlayerPath: optionalText(player.externalPlayerPath),
      externalPlayerArgs: typeof player.externalPlayerArgs === "string" ? player.externalPlayerArgs : defaults.player.externalPlayerArgs,
      preferredQuality: optionalText(player.preferredQuality)
    }),
    iwara: dropUndefined({
      xVersionSalt: optionalText(iwara.xVersionSalt) ?? defaults.iwara.xVersionSalt,
      autoSniffXVersionSalt: typeof iwara.autoSniffXVersionSalt === "boolean" ? iwara.autoSniffXVersionSalt : defaults.iwara.autoSniffXVersionSalt,
      lastSaltSniffAt: optionalText(iwara.lastSaltSniffAt),
      lastSaltSource: optionalText(iwara.lastSaltSource)
    }),
    mediaSpeed: dropUndefined({
      autoTest: typeof media.autoTest === "boolean" ? media.autoTest : defaults.mediaSpeed.autoTest,
      replaceLinks: typeof media.replaceLinks === "boolean" ? media.replaceLinks : defaults.mediaSpeed.replaceLinks,
      candidateHosts: normalizeMediaHostList(stringArray(media.candidateHosts)),
      rankedHosts: normalizeMediaHostList(stringArray(media.rankedHosts)),
      lastTestedAt: optionalText(media.lastTestedAt),
      testBytes: clampInteger(media.testBytes, 64 * 1024, 4 * 1024 * 1024, defaults.mediaSpeed.testBytes),
      timeoutMs: clampInteger(media.timeoutMs, 1000, 30_000, defaults.mediaSpeed.timeoutMs)
    }),
    download: dropUndefined({
      directory: optionalText(download.directory) ?? defaults.download.directory,
      defaultQuality: optionalText(download.defaultQuality),
      maxConnections: clampInteger(download.maxConnections, 1, 8, defaults.download.maxConnections),
      minSplitBytes: clampInteger(download.minSplitBytes, 1024 * 1024, 256 * 1024 * 1024, defaults.download.minSplitBytes)
    }),
    tagPreferences: {
      followedTags: normalizeTagList(stringArray(tags.followedTags)).filter((tag) => !blocked.has(tag)),
      blockedTags,
      maxScanPages: clampInteger(tags.maxScanPages, 1, 10, defaults.tagPreferences.maxScanPages),
      requestDelayMs: clampInteger(tags.requestDelayMs, 0, 1500, defaults.tagPreferences.requestDelayMs)
    },
    ui: {
      language: oneOf(ui?.language, LANGUAGES, defaults.ui.language),
      theme: oneOf(ui?.theme, THEMES, defaults.ui.theme),
      rating: oneOf(ui?.rating, RATINGS, defaults.ui.rating)
    },
    history: Array.isArray(settings.history)
      ? settings.history.filter((item) => isRecord(item) && isRecord(item.video) && typeof item.video.id === "string").slice(0, HISTORY_LIMIT)
      : []
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(numeric, min), max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function dropUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

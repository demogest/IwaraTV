import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeMediaHostList } from "../../shared/media-speed-utils";
import { DEFAULT_X_VERSION_SALT } from "../../shared/iwara-utils";
import type { AppSettings, MediaSpeedCandidateResult, PlaybackHistoryItem, TagPreferences } from "../../shared/types";

export const DEFAULT_MEDIA_SPEED_SETTINGS = {
  autoTest: false,
  replaceLinks: false,
  candidateHosts: [
    "jade.iwara.tv",
    "kafka.iwara.tv",
    "bronya.iwara.tv",
    "camellya.iwara.tv"
  ],
  rankedHosts: [],
  testBytes: 524288,
  timeoutMs: 4500
} satisfies AppSettings["mediaSpeed"];

const DEFAULT_TAG_PREFERENCES: TagPreferences = {
  followedTags: [],
  blockedTags: [],
  maxScanPages: 5,
  requestDelayMs: 250
};

const DEFAULT_SETTINGS: AppSettings = {
  player: {
    preferredMode: "mpv",
    externalPlayerArgs: "{url}",
    preferredQuality: "Source"
  },
  iwara: {
    xVersionSalt: DEFAULT_X_VERSION_SALT,
    autoSniffXVersionSalt: true
  },
  mediaSpeed: DEFAULT_MEDIA_SPEED_SETTINGS,
  tagPreferences: DEFAULT_TAG_PREFERENCES,
  history: []
};

export class SettingsStore {
  private readonly filePath: string;
  private settings: AppSettings;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "settings.json");
    this.settings = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  update(partial: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...partial,
      player: {
        ...this.settings.player,
        ...partial.player
      },
      iwara: {
        ...this.settings.iwara,
        ...partial.iwara
      },
      mediaSpeed: {
        ...this.settings.mediaSpeed,
        ...partial.mediaSpeed
      },
      tagPreferences: normalizeTagPreferences({
        ...this.settings.tagPreferences,
        ...partial.tagPreferences
      }),
      history: partial.history ?? this.settings.history
    };
    this.save();
    return this.get();
  }

  addHistory(item: PlaybackHistoryItem): AppSettings {
    const withoutDuplicate = this.settings.history.filter((entry) => entry.video.id !== item.video.id);
    this.settings.history = [item, ...withoutDuplicate].slice(0, 100);
    this.save();
    return this.get();
  }

  addMediaHosts(hosts: string[]): AppSettings {
    const merged = normalizeMediaHostList([...this.settings.mediaSpeed.candidateHosts, ...hosts]);
    if (merged.join("\n") === this.settings.mediaSpeed.candidateHosts.join("\n")) {
      return this.get();
    }

    this.settings.mediaSpeed.candidateHosts = merged;
    this.save();
    return this.get();
  }

  updateMediaHostRanking(results: MediaSpeedCandidateResult[], testedAt: string): AppSettings {
    const rankedHosts = normalizeMediaHostList(
      results
        .filter((result) => result.ok)
        .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))
        .map((result) => result.host)
    );
    const observedHosts = normalizeMediaHostList(results.map((result) => result.host));

    this.settings.mediaSpeed = {
      ...this.settings.mediaSpeed,
      candidateHosts: normalizeMediaHostList([...this.settings.mediaSpeed.candidateHosts, ...observedHosts]),
      rankedHosts,
      lastTestedAt: testedAt
    };
    this.save();
    return this.get();
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        player: {
          ...DEFAULT_SETTINGS.player,
          ...raw.player
        },
        iwara: {
          ...DEFAULT_SETTINGS.iwara,
          ...raw.iwara
        },
        mediaSpeed: {
          ...DEFAULT_SETTINGS.mediaSpeed,
          ...raw.mediaSpeed
        },
        tagPreferences: normalizeTagPreferences({
          ...DEFAULT_SETTINGS.tagPreferences,
          ...raw.tagPreferences
        }),
        history: Array.isArray(raw.history) ? raw.history : []
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
  }
}

function normalizeTagPreferences(preferences: TagPreferences): TagPreferences {
  const blockedTags = normalizeTagList(preferences.blockedTags);
  const blocked = new Set(blockedTags);
  return {
    followedTags: normalizeTagList(preferences.followedTags).filter((tag) => !blocked.has(tag)),
    blockedTags,
    maxScanPages: clampInteger(preferences.maxScanPages, 1, 10, DEFAULT_TAG_PREFERENCES.maxScanPages),
    requestDelayMs: clampInteger(preferences.requestDelayMs, 0, 1500, DEFAULT_TAG_PREFERENCES.requestDelayMs)
  };
}

function normalizeTagList(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numeric)));
}

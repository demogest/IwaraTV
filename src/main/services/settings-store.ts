import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppSettings, PlaybackHistoryItem } from "../../shared/types";

const DEFAULT_SETTINGS: AppSettings = {
  player: {
    preferredMode: "mpv",
    externalPlayerArgs: "{url}",
    preferredQuality: "Source"
  },
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


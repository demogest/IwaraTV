import type { AppSettings, AuthState, DownloadState, FavoriteState } from "./types";

export const DEFAULT_X_VERSION_SALT = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";

export const QUALITY_OPTIONS = ["Source", "2160", "1440", "1080", "720", "540", "360", "Preview"] as const;

export const HISTORY_LIMIT = 100;

/** Upper limits of the download settings. */
export const MAX_DOWNLOAD_CONNECTIONS = 16;
export const MAX_CONCURRENT_DOWNLOADS = 5;

/** Defaults without machine-specific values (the main process fills in the download folder). */
export function createDefaultSettings(): AppSettings {
  return {
    player: {
      // Works everywhere without installing anything; MPV and external players are opt-in.
      preferredMode: "builtin",
      externalPlayerArgs: "{url}",
      preferredQuality: "Source"
    },
    iwara: {
      xVersionSalt: DEFAULT_X_VERSION_SALT,
      autoSniffXVersionSalt: true
    },
    mediaSpeed: {
      autoTest: false,
      replaceLinks: false,
      candidateHosts: ["jade.iwara.tv", "kafka.iwara.tv", "bronya.iwara.tv", "camellya.iwara.tv"],
      rankedHosts: [],
      testBytes: 524_288,
      timeoutMs: 4_500
    },
    download: {
      defaultQuality: "Source",
      maxConnections: 8,
      minSplitBytes: 16 * 1024 * 1024,
      maxConcurrent: 2,
      notifyOnComplete: true
    },
    tagPreferences: {
      followedTags: [],
      blockedTags: [],
      maxScanPages: 5,
      requestDelayMs: 250
    },
    ui: {
      language: "system",
      theme: "system",
      rating: "all",
      density: "comfortable"
    },
    updates: {
      autoCheck: true,
      autoDownload: true
    },
    history: []
  };
}

export const EMPTY_AUTH_STATE: AuthState = {
  status: "anonymous",
  siteSessionReady: false,
  siteCookieCount: 0,
  siteTokenReady: false,
  verificationWindowOpen: false
};

export const EMPTY_DOWNLOAD_STATE: DownloadState = { active: [], history: [] };

export const EMPTY_FAVORITE_STATE: FavoriteState = { items: [] };

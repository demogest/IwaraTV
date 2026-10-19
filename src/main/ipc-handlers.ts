// Channel → handler and channel → argument validator tables. Kept free of
// Electron imports so they can be unit-tested.

import type { InvokeArgs, InvokeChannel, InvokeResult } from "../shared/ipc";
import type {
  FavoriteItem,
  ListVideosRequest,
  PlayerMode,
  RatingFilter,
  SettingsPatch,
  VideoSort,
  VideoSummary
} from "../shared/types";
import type { Backend } from "./backend";
import { AppError } from "./lib/app-error";
import { isRecord } from "./lib/json-file";

export type Handlers = {
  [C in InvokeChannel]: (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>;
};

export type Validators = {
  [C in InvokeChannel]: (args: unknown[]) => InvokeArgs<C>;
};

export function createHandlers(backend: Backend): Handlers {
  return {
    "iwara:list-videos": (request) => backend.listVideos(request),
    "iwara:get-video": (idOrUrl) => backend.getVideo(idOrUrl),
    "iwara:diagnose-video": (idOrUrl) => backend.diagnoseVideo(idOrUrl),
    "iwara:list-comments": (request) => backend.listComments(request),
    "iwara:send-comment": (request) => backend.sendComment(request),
    "iwara:set-author-following": (request) => backend.setAuthorFollowing(request),
    "iwara:sniff-x-version-salt": () => backend.sniffXVersionSalt(),
    "iwara:speed-test-video": (idOrUrl) => backend.speedTestVideo(idOrUrl),

    "downloads:list": () => backend.listDownloads(),
    "downloads:start": (request) => backend.startDownload(request),
    "downloads:retry": (id) => backend.retryDownload(id),
    "downloads:cancel": (id) => backend.cancelDownload(id),
    "downloads:delete": (request) => backend.deleteDownload(request),
    "downloads:clear-finished": () => backend.clearFinishedDownloads(),
    "downloads:open-file": (id) => backend.openDownloadFile(id),
    "downloads:show-in-folder": (id) => backend.showDownloadInFolder(id),
    "downloads:open-directory": () => backend.openDownloadDirectory(),

    "favorites:list": () => backend.listFavorites(),
    "favorites:add": (video) => backend.addFavorite(video),
    "favorites:restore": (item) => backend.restoreFavorite(item),
    "favorites:remove": (videoId) => backend.removeFavorite(videoId),
    "favorites:backup": () => backend.backupFavorites(),
    "favorites:export": () => backend.exportFavorites(),
    "favorites:import": () => backend.importFavorites(),

    "player:play": (request) => backend.play(request),
    "player:probe": () => backend.probePlayers(),
    "player:test-mpv": () => backend.testMpv(),

    "settings:get": () => backend.getSettings(),
    "settings:update": (patch) => backend.updateSettings(patch),

    "auth:state": () => backend.authState(),
    "auth:open-verification": () => backend.openVerification(),
    "auth:sign-out": () => backend.signOut(),

    "system:select-executable": (request) => backend.selectExecutable(request),
    "system:select-directory": (request) => backend.selectDirectory(request),
    "system:open-external": (url) => backend.openExternal(url),
    "system:write-clipboard": (text) => backend.writeClipboard(text),
    "system:app-info": () => backend.appInfo()
  };
}

// --- Validation ----------------------------------------------------------------

function invalid(message: string): never {
  throw new AppError("INVALID_INPUT", message);
}

function str(value: unknown, name: string, maxLength = 2048): string {
  if (typeof value !== "string" || value.length > maxLength) {
    invalid(`${name} must be a string of at most ${maxLength} characters.`);
  }
  return value;
}

function optStr(value: unknown, name: string, maxLength = 2048): string | undefined {
  return value === undefined || value === null ? undefined : str(value, name, maxLength);
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    invalid(`${name} must be a boolean.`);
  }
  return value;
}

function optBool(value: unknown, name: string): boolean | undefined {
  return value === undefined ? undefined : bool(value, name);
}

function int(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`${name} must be an object.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) {
    invalid(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function stringList(value: unknown, name: string, maxItems = 200): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    invalid(`${name} must be a list of at most ${maxItems} strings.`);
  }
  return value.map((item, index) => str(item, `${name}[${index}]`, 200));
}

const SORTS: VideoSort[] = ["date", "trending", "popularity", "relevance", "views", "likes"];
const RATINGS: RatingFilter[] = ["all", "general", "ecchi"];
const MODES: PlayerMode[] = ["mpv", "external"];

function listVideosRequest(value: unknown): ListVideosRequest {
  const raw = obj(value, "request");
  return {
    sort: oneOf(raw.sort, SORTS, "sort"),
    page: raw.page === undefined ? undefined : int(raw.page, "page", 0, 100_000),
    rating: raw.rating === undefined ? undefined : oneOf(raw.rating, RATINGS, "rating"),
    query: optStr(raw.query, "query", 500),
    tags: raw.tags === undefined ? undefined : stringList(raw.tags, "tags", 50),
    followedOnly: optBool(raw.followedOnly, "followedOnly"),
    subscribedOnly: optBool(raw.subscribedOnly, "subscribedOnly"),
    searchOnly: optBool(raw.searchOnly, "searchOnly"),
    userId: optStr(raw.userId, "userId", 200)
  };
}

function videoSummary(value: unknown): VideoSummary {
  const raw = obj(value, "video");
  str(raw.id, "video.id", 200);
  str(raw.title, "video.title", 2000);
  if (raw.tags !== undefined) {
    stringList(raw.tags, "video.tags", 500);
  }
  return {
    ...(raw as unknown as VideoSummary),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    numViews: typeof raw.numViews === "number" ? raw.numViews : 0,
    numLikes: typeof raw.numLikes === "number" ? raw.numLikes : 0,
    numComments: typeof raw.numComments === "number" ? raw.numComments : 0
  };
}

function favoriteItem(value: unknown): FavoriteItem {
  const raw = obj(value, "item");
  return {
    video: videoSummary(raw.video),
    favoritedAt: str(raw.favoritedAt, "favoritedAt", 64),
    ...(raw.note === undefined ? {} : { note: str(raw.note, "note", 5000) })
  };
}

function settingsPatch(value: unknown): SettingsPatch {
  const raw = obj(value, "patch");
  for (const [key, section] of Object.entries(raw)) {
    if (key === "history") {
      if (!Array.isArray(section)) {
        invalid("history must be a list.");
      }
      continue;
    }
    if (!["player", "iwara", "mediaSpeed", "download", "tagPreferences", "ui"].includes(key)) {
      invalid(`Unknown settings section: ${key}.`);
    }
    obj(section, key);
  }
  // Field-level coercion happens in SettingsStore.normalizeSettings.
  return raw as SettingsPatch;
}

function selectPathRequest(value: unknown) {
  const raw = obj(value, "request");
  return { title: str(raw.title, "title", 200), currentPath: optStr(raw.currentPath, "currentPath", 4096) };
}

const none = (): [] => [];

export const validators: Validators = {
  "iwara:list-videos": ([request]) => [listVideosRequest(request)],
  "iwara:get-video": ([idOrUrl]) => [str(idOrUrl, "idOrUrl", 500)],
  "iwara:diagnose-video": ([idOrUrl]) => [str(idOrUrl, "idOrUrl", 500)],
  "iwara:list-comments": ([request]) => {
    const raw = obj(request, "request");
    return [{
      videoId: str(raw.videoId, "videoId", 200),
      page: raw.page === undefined ? undefined : int(raw.page, "page", 0, 100_000),
      parentId: optStr(raw.parentId, "parentId", 200)
    }];
  },
  "iwara:send-comment": ([request]) => {
    const raw = obj(request, "request");
    return [{
      videoId: str(raw.videoId, "videoId", 200),
      body: str(raw.body, "body", 10_000),
      parentId: optStr(raw.parentId, "parentId", 200)
    }];
  },
  "iwara:set-author-following": ([request]) => {
    const raw = obj(request, "request");
    return [{ authorId: str(raw.authorId, "authorId", 200), following: bool(raw.following, "following") }];
  },
  "iwara:sniff-x-version-salt": none,
  "iwara:speed-test-video": ([idOrUrl]) => [str(idOrUrl, "idOrUrl", 500)],

  "downloads:list": none,
  "downloads:start": ([request]) => {
    const raw = obj(request, "request");
    return [{ videoId: str(raw.videoId, "videoId", 200), quality: optStr(raw.quality, "quality", 50) }];
  },
  "downloads:retry": ([id]) => [str(id, "id", 200)],
  "downloads:cancel": ([id]) => [str(id, "id", 200)],
  "downloads:delete": ([request]) => {
    const raw = obj(request, "request");
    return [{ id: str(raw.id, "id", 200), deleteFile: bool(raw.deleteFile, "deleteFile") }];
  },
  "downloads:clear-finished": none,
  "downloads:open-file": ([id]) => [str(id, "id", 200)],
  "downloads:show-in-folder": ([id]) => [str(id, "id", 200)],
  "downloads:open-directory": none,

  "favorites:list": none,
  "favorites:add": ([video]) => [videoSummary(video)],
  "favorites:restore": ([item]) => [favoriteItem(item)],
  "favorites:remove": ([videoId]) => [str(videoId, "videoId", 200)],
  "favorites:backup": none,
  "favorites:export": none,
  "favorites:import": none,

  "player:play": ([request]) => {
    const raw = obj(request, "request");
    return [{
      videoId: str(raw.videoId, "videoId", 500),
      quality: optStr(raw.quality, "quality", 50),
      mode: raw.mode === undefined ? undefined : oneOf(raw.mode, MODES, "mode")
    }];
  },
  "player:probe": none,
  "player:test-mpv": none,

  "settings:get": none,
  "settings:update": ([patch]) => [settingsPatch(patch)],

  "auth:state": none,
  "auth:open-verification": none,
  "auth:sign-out": none,

  "system:select-executable": ([request]) => [selectPathRequest(request)],
  "system:select-directory": ([request]) => [selectPathRequest(request)],
  "system:open-external": ([url]) => [str(url, "url", 4096)],
  "system:write-clipboard": ([text]) => [str(text, "text", 100_000)],
  "system:app-info": none
};

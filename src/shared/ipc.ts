import type { SerializedAppError } from "./errors";
import type {
  AppInfo,
  AppSettings,
  AuthorFollowRequest,
  AuthorFollowResult,
  AppNavigateRequest,
  AuthState,
  DownloadDeleteRequest,
  DownloadState,
  DownloadTask,
  DownloadVideoRequest,
  FavoriteFileResult,
  FavoriteImportResult,
  FavoriteItem,
  FavoriteState,
  IwaraVideoDiagnostics,
  ListCommentsRequest,
  ListVideosRequest,
  MediaSpeedTestReport,
  PlaybackProgress,
  PlayerDiagnostics,
  PlayerProbe,
  PlayRequest,
  PlayResult,
  SelectPathRequest,
  SelectPathResult,
  SendVideoCommentRequest,
  SettingsPatch,
  VideoComment,
  VideoCommentsResult,
  VideoDetail,
  VideoListResult,
  VideoSummary,
  XVersionSaltReport
} from "./types";

/**
 * Request/response channels. Every entry must have exactly one handler in the
 * main process (see src/main/ipc.ts); the preload bridge only forwards
 * channels listed here.
 */
export interface IpcInvokeContract {
  "iwara:list-videos": { args: [request: ListVideosRequest]; result: VideoListResult };
  "iwara:get-video": { args: [idOrUrl: string]; result: VideoDetail };
  "iwara:diagnose-video": { args: [idOrUrl: string]; result: IwaraVideoDiagnostics };
  "iwara:list-comments": { args: [request: ListCommentsRequest]; result: VideoCommentsResult };
  "iwara:send-comment": { args: [request: SendVideoCommentRequest]; result: VideoComment };
  "iwara:set-author-following": { args: [request: AuthorFollowRequest]; result: AuthorFollowResult };
  "iwara:sniff-x-version-salt": { args: []; result: XVersionSaltReport };
  "iwara:speed-test-video": { args: [idOrUrl: string]; result: MediaSpeedTestReport };
  "iwara:list-related": { args: [videoId: string]; result: VideoSummary[] };

  "downloads:list": { args: []; result: DownloadState };
  "downloads:start": { args: [request: DownloadVideoRequest]; result: DownloadTask };
  "downloads:retry": { args: [id: string]; result: DownloadTask };
  "downloads:cancel": { args: [id: string]; result: DownloadState };
  "downloads:delete": { args: [request: DownloadDeleteRequest]; result: DownloadState };
  "downloads:clear-finished": { args: []; result: DownloadState };
  "downloads:open-file": { args: [id: string]; result: void };
  "downloads:show-in-folder": { args: [id: string]; result: void };
  "downloads:open-directory": { args: []; result: void };

  "favorites:list": { args: []; result: FavoriteState };
  "favorites:add": { args: [video: VideoSummary]; result: FavoriteState };
  "favorites:restore": { args: [item: FavoriteItem]; result: FavoriteState };
  "favorites:remove": { args: [videoId: string]; result: FavoriteState };
  "favorites:backup": { args: []; result: FavoriteFileResult };
  "favorites:export": { args: []; result: FavoriteFileResult };
  "favorites:import": { args: []; result: FavoriteImportResult };

  "player:play": { args: [request: PlayRequest]; result: PlayResult };
  "player:probe": { args: []; result: PlayerDiagnostics };
  "player:test-mpv": { args: []; result: PlayerProbe };
  "player:report-progress": { args: [progress: PlaybackProgress]; result: void };

  "settings:get": { args: []; result: AppSettings };
  "settings:update": { args: [patch: SettingsPatch]; result: AppSettings };

  "auth:state": { args: []; result: AuthState };
  "auth:open-verification": { args: []; result: AuthState };
  "auth:sign-out": { args: []; result: AuthState };

  "system:select-executable": { args: [request: SelectPathRequest]; result: SelectPathResult };
  "system:select-directory": { args: [request: SelectPathRequest]; result: SelectPathResult };
  "system:open-external": { args: [url: string]; result: void };
  "system:write-clipboard": { args: [text: string]; result: void };
  "system:app-info": { args: []; result: AppInfo };
  /** The Iwara video ID from a link on the clipboard, if there is one (nothing else is read back). */
  "system:clipboard-video": { args: []; result: string | undefined };
}

/** Push events sent from the main process to the app window. */
export interface IpcEventContract {
  "downloads:changed": DownloadState;
  "auth:changed": AuthState;
  "settings:changed": AppSettings;
  "favorites:changed": FavoriteState;
  /** Asks the window to show a section, e.g. after clicking a notification. */
  "app:navigate": AppNavigateRequest;
}

export type InvokeChannel = keyof IpcInvokeContract;
export type EventChannel = keyof IpcEventContract;
export type InvokeArgs<C extends InvokeChannel> = IpcInvokeContract[C]["args"];
export type InvokeResult<C extends InvokeChannel> = IpcInvokeContract[C]["result"];

export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: SerializedAppError };

// Runtime lists used by the preload allowlist and by tests. The satisfies
// clauses make TypeScript fail if a contract entry is added without updating
// the list (and vice versa).
const invokeChannelRecord = {
  "iwara:list-videos": true,
  "iwara:get-video": true,
  "iwara:diagnose-video": true,
  "iwara:list-comments": true,
  "iwara:send-comment": true,
  "iwara:set-author-following": true,
  "iwara:sniff-x-version-salt": true,
  "iwara:speed-test-video": true,
  "iwara:list-related": true,
  "downloads:list": true,
  "downloads:start": true,
  "downloads:retry": true,
  "downloads:cancel": true,
  "downloads:delete": true,
  "downloads:clear-finished": true,
  "downloads:open-file": true,
  "downloads:show-in-folder": true,
  "downloads:open-directory": true,
  "favorites:list": true,
  "favorites:add": true,
  "favorites:restore": true,
  "favorites:remove": true,
  "favorites:backup": true,
  "favorites:export": true,
  "favorites:import": true,
  "player:play": true,
  "player:probe": true,
  "player:test-mpv": true,
  "player:report-progress": true,
  "settings:get": true,
  "settings:update": true,
  "auth:state": true,
  "auth:open-verification": true,
  "auth:sign-out": true,
  "system:select-executable": true,
  "system:select-directory": true,
  "system:open-external": true,
  "system:write-clipboard": true,
  "system:app-info": true,
  "system:clipboard-video": true
} as const satisfies Record<InvokeChannel, true>;

const eventChannelRecord = {
  "downloads:changed": true,
  "auth:changed": true,
  "settings:changed": true,
  "favorites:changed": true,
  "app:navigate": true
} as const satisfies Record<EventChannel, true>;

export const INVOKE_CHANNELS = Object.keys(invokeChannelRecord) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(eventChannelRecord) as EventChannel[];

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === "string" && Object.hasOwn(invokeChannelRecord, value);
}

export function isEventChannel(value: unknown): value is EventChannel {
  return typeof value === "string" && Object.hasOwn(eventChannelRecord, value);
}

/** The object the preload script exposes as `window.iwaraTV`. */
export interface IwaraTVBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<IpcResponse<InvokeResult<C>>>;
  on<E extends EventChannel>(channel: E, listener: (payload: IpcEventContract[E]) => void): () => void;
  platform: string;
}

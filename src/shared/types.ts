import type { AppErrorCode } from "./errors";

// Data shapes shared by the Electron main process, the preload bridge and the
// renderer. Everything here must be structured-clone friendly.

export type VideoSort = "date" | "trending" | "popularity" | "relevance" | "views" | "likes";
export type RatingFilter = "all" | "general" | "ecchi";
export type PlayerMode = "mpv" | "external";
export type LanguagePreference = "system" | "zh-CN" | "en";
export type ThemePreference = "system" | "dark" | "light";

export interface VideoSummary {
  id: string;
  title: string;
  description?: string;
  uploaderId?: string;
  uploaderName?: string;
  uploaderUsername?: string;
  uploaderAvatarUrl?: string;
  uploaderFollowing?: boolean;
  thumbnailUrl?: string;
  rating?: string;
  tags: string[];
  numViews: number;
  numLikes: number;
  numComments: number;
  durationSeconds?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface VideoFormat {
  id: string;
  label: string;
  url: string;
  mimeType?: string;
  ext?: string;
  height?: number;
  qualityRank: number;
}

export interface VideoComment {
  id: string;
  body: string;
  authorName?: string;
  authorUsername?: string;
  authorAvatarUrl?: string;
  createdAt?: string;
  numLikes: number;
  numReplies: number;
}

export interface VideoDetail extends VideoSummary {
  formats: VideoFormat[];
  embedUrl?: string;
}

export interface ListCommentsRequest {
  videoId: string;
  page?: number;
  /** Loads replies to this comment instead of top-level comments. */
  parentId?: string;
}

export interface VideoCommentsResult {
  videoId: string;
  parentId?: string;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  comments: VideoComment[];
  fetchedAt: string;
}

export interface IwaraRuntimeSettings {
  xVersionSalt: string;
  autoSniffXVersionSalt: boolean;
  lastSaltSniffAt?: string;
  lastSaltSource?: string;
}

export interface MediaSpeedSettings {
  autoTest: boolean;
  replaceLinks: boolean;
  candidateHosts: string[];
  rankedHosts: string[];
  lastTestedAt?: string;
  testBytes: number;
  timeoutMs: number;
}

export interface TagPreferences {
  followedTags: string[];
  blockedTags: string[];
  maxScanPages: number;
  requestDelayMs: number;
}

export interface DownloadSettings {
  directory?: string;
  defaultQuality?: string;
  maxConnections: number;
  minSplitBytes: number;
}

export interface UiSettings {
  language: LanguagePreference;
  theme: ThemePreference;
  rating: RatingFilter;
}

export interface MediaSpeedCandidateResult {
  host: string;
  url: string;
  ok: boolean;
  elapsedMs?: number;
  bytesRead?: number;
  bytesPerSecond?: number;
  error?: string;
}

export interface MediaSpeedTestReport {
  videoId: string;
  title?: string;
  sampleFormatId?: string;
  sampleFormatLabel?: string;
  sampleHost?: string;
  testedAt: string;
  replaceLinks: boolean;
  fastestHost?: string;
  results: MediaSpeedCandidateResult[];
}

export interface XVersionSaltReport {
  salt: string;
  sourceUrl: string;
  checkedAt: string;
}

export interface IwaraFileProbe {
  label: string;
  url: string;
  ok: boolean;
  status?: number;
  formatLabels: string[];
  error?: string;
}

export interface IwaraNetworkEntry {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  formatLabels: string[];
  formats?: VideoFormat[];
  xVersion?: string;
  hasAuthorization?: boolean;
  responseShape?: string;
  error?: string;
}

export interface IwaraNetworkCapture {
  pageUrl: string;
  entries: IwaraNetworkEntry[];
  timedOut: boolean;
}

export interface IwaraVideoDiagnostics {
  videoId: string;
  title?: string;
  fileUrl?: string;
  appFormatLabels: string[];
  probes: IwaraFileProbe[];
  network?: IwaraNetworkCapture;
}

export interface VideoListNetworkAttempt {
  endpoint: string;
  page: number;
  attempt: number;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  resultCount?: number;
  error?: string;
}

export interface VideoListNetworkDiagnostics {
  attempts: VideoListNetworkAttempt[];
}

export interface VideoListResult {
  sort: VideoSort;
  page: number;
  limit: number;
  query?: string;
  tags: string[];
  scannedPages?: number;
  blockedCount?: number;
  partialFailures?: string[];
  total?: number;
  /** False when the API indicated that no further pages exist. */
  hasMore: boolean;
  networkDiagnostics?: VideoListNetworkDiagnostics;
  results: VideoSummary[];
}

export interface PlayerSettings {
  preferredMode: PlayerMode;
  mpvPath?: string;
  externalPlayerPath?: string;
  externalPlayerArgs: string;
  preferredQuality?: string;
}

export interface PlaybackHistoryItem {
  video: VideoSummary;
  formatId: string;
  playedAt: string;
  mode: PlayerMode;
}

export interface FavoriteItem {
  video: VideoSummary;
  favoritedAt: string;
  note?: string;
}

export interface FavoriteState {
  items: FavoriteItem[];
}

export interface FavoriteFileResult {
  canceled: boolean;
  path?: string;
  count: number;
}

export interface FavoriteImportResult {
  canceled: boolean;
  path?: string;
  imported: number;
  merged: number;
  skipped: number;
  total: number;
  state: FavoriteState;
}

export interface AppSettings {
  player: PlayerSettings;
  iwara: IwaraRuntimeSettings;
  mediaSpeed: MediaSpeedSettings;
  download: DownloadSettings;
  tagPreferences: TagPreferences;
  ui: UiSettings;
  history: PlaybackHistoryItem[];
}

/**
 * Partial settings update. `null` clears an optional value; `undefined`
 * leaves it untouched.
 */
export type SettingsPatch = {
  [K in keyof Omit<AppSettings, "history">]?: {
    [P in keyof AppSettings[K]]?: undefined extends AppSettings[K][P]
      ? AppSettings[K][P] | null
      : AppSettings[K][P];
  };
} & {
  history?: PlaybackHistoryItem[];
};

export type AuthStatus = "signed-in" | "verified" | "anonymous";

export interface AuthState {
  status: AuthStatus;
  username?: string;
  avatarUrl?: string;
  siteSessionReady: boolean;
  siteCookieCount: number;
  siteTokenReady: boolean;
  siteTokenKey?: string;
  tokenExpiresAt?: string;
  verificationWindowOpen: boolean;
}

export interface ListVideosRequest {
  sort: VideoSort;
  page?: number;
  rating?: RatingFilter;
  query?: string;
  tags?: string[];
  followedOnly?: boolean;
  subscribedOnly?: boolean;
  searchOnly?: boolean;
  userId?: string;
}

export interface SendVideoCommentRequest {
  videoId: string;
  body: string;
  parentId?: string;
}

export interface AuthorFollowRequest {
  authorId: string;
  following: boolean;
}

export interface AuthorFollowResult {
  authorId: string;
  following: boolean;
}

export interface PlayRequest {
  videoId: string;
  quality?: string;
  mode?: PlayerMode;
}

export interface PlayResult {
  ok: true;
  mode: PlayerMode;
  playerPath: string;
  format: VideoFormat;
  video: VideoDetail;
  fallbackFrom?: string;
}

export interface DownloadVideoRequest {
  videoId: string;
  quality?: string;
}

export type DownloadTaskStatus = "queued" | "downloading" | "completed" | "failed" | "canceled";

export interface DownloadTask {
  id: string;
  videoId: string;
  requestedQuality?: string;
  status: DownloadTaskStatus;
  video?: VideoSummary;
  format?: VideoFormat;
  path?: string;
  directory?: string;
  bytesWritten: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  fallbackFrom?: string;
  error?: string;
  errorCode?: AppErrorCode;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DownloadState {
  active: DownloadTask[];
  history: DownloadTask[];
}

export interface DownloadDeleteRequest {
  id: string;
  deleteFile: boolean;
}

export type PlayerProbeCode =
  | "found"
  | "not-found"
  | "launch-ok"
  | "launch-failed"
  | "not-configured"
  | "missing-url-placeholder"
  | "invalid-template";

export interface PlayerProbe {
  ok: boolean;
  code: PlayerProbeCode;
  configuredPath?: string;
  resolvedPath?: string;
  /** Untranslated technical detail, e.g. a process exit code or OS error. */
  detail?: string;
}

export interface PlayerDiagnostics {
  mpv: PlayerProbe;
  external: PlayerProbe;
  externalArgsPreview: string[];
  externalTemplateHasUrl: boolean;
}

export interface SelectPathRequest {
  title: string;
  currentPath?: string;
}

export interface SelectPathResult {
  canceled: boolean;
  path?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  userDataPath: string;
  systemLocale: string;
  migratedFrom?: string;
}

export type VideoSort = "date" | "trending" | "popularity";
export type RatingFilter = "all" | "general" | "ecchi";
export type PlayerMode = "mpv" | "external";

export interface VideoSummary {
  id: string;
  title: string;
  description?: string;
  uploaderName?: string;
  uploaderUsername?: string;
  thumbnailUrl?: string;
  rating?: string;
  tags: string[];
  numViews: number;
  numLikes: number;
  numComments: number;
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

export interface VideoDetail extends VideoSummary {
  formats: VideoFormat[];
  embedUrl?: string;
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

export interface VideoListResult {
  sort: VideoSort;
  page: number;
  limit: number;
  total?: number;
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

export interface AppSettings {
  player: PlayerSettings;
  history: PlaybackHistoryItem[];
}

export interface AuthState {
  loggedIn: boolean;
  email?: string;
  hasMediaToken: boolean;
  encryptionAvailable: boolean;
  siteSessionReady?: boolean;
  siteCookieCount?: number;
  siteTokenReady?: boolean;
  siteTokenKey?: string;
  browserUserAgent?: string;
  warning?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ListVideosRequest {
  sort: VideoSort;
  page?: number;
  rating?: RatingFilter;
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

export interface PlayerProbe {
  ok: boolean;
  label: string;
  configuredPath?: string;
  resolvedPath?: string;
  message: string;
}

export interface PlayerDiagnostics {
  mpv: PlayerProbe;
  external: PlayerProbe;
  externalArgsPreview: string[];
  externalTemplateHasUrl: boolean;
}

export interface SelectExecutableRequest {
  title: string;
  currentPath?: string;
}

export interface SelectExecutableResult {
  canceled: boolean;
  path?: string;
}

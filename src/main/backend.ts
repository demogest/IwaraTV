import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventChannel, IpcEventContract } from "../shared/ipc";
import { MEDIA_STREAM_SCHEME, mediaUrlHost } from "../shared/media-hosts";
import { parseIwaraVideoId } from "../shared/video-id";
import type {
  AppInfo,
  AppSettings,
  AuthorFollowRequest,
  AuthorFollowResult,
  AuthState,
  DownloadDeleteRequest,
  DownloadState,
  DownloadTask,
  DownloadVideoRequest,
  FavoriteFileResult,
  FavoriteImportResult,
  FavoriteItem,
  FavoriteState,
  IwaraNetworkCapture,
  IwaraVideoDiagnostics,
  ListCommentsRequest,
  ListVideosRequest,
  MediaSpeedTestReport,
  PlaybackHistoryItem,
  PlaybackProgress,
  PlayerDiagnostics,
  PlayerProbe,
  PlayRequest,
  PlayResult,
  SelectPathRequest,
  SelectPathResult,
  SendVideoCommentRequest,
  SettingsPatch,
  UpdateState,
  VideoComment,
  VideoCommentsResult,
  VideoDetail,
  VideoFormat,
  VideoListResult,
  VideoSummary,
  XVersionSaltReport
} from "../shared/types";
import { AppError } from "./lib/app-error";
import { transferToFile } from "./lib/file-transfer";
import { mergeHeaders, type HttpFetch } from "./lib/http";
import { chooseVideoFormat } from "./lib/iwara-parse";
import type { CapturedToken } from "./lib/jwt";
import { DownloadManager } from "./services/download-manager";
import { FavoriteStore } from "./services/favorite-store";
import { IwaraClient, type IwaraSessionBridge } from "./services/iwara-client";
import type { PlayerService } from "./services/player-service";
import { SettingsStore } from "./services/settings-store";
import { UpdateService, type UpdateEnvironment } from "./services/update-service";
import { GITHUB_SOURCE } from "./lib/update-manifest";

const SALT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STREAMS = 16;
const STREAM_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/** Electron-specific session features the backend uses. */
export interface SessionPort extends IwaraSessionBridge {
  fetch: HttpFetch;
  snapshot(): Promise<{ cookieCount: number; token?: CapturedToken; verificationWindowOpen: boolean }>;
  tokenExpiry(): Date | undefined;
  openVerificationWindow(): Promise<void>;
  captureVideoNetwork(idOrUrl: string): Promise<IwaraNetworkCapture>;
  signOut(): Promise<void>;
  onChange(listener: () => void): () => void;
}

/** OS integration (dialogs, shell, clipboard), injected so the backend stays testable. */
export interface PlatformPort {
  openPath(filePath: string): Promise<void>;
  showItemInFolder(filePath: string): void;
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  pickFile(options: { title: string; defaultPath?: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  pickDirectory(options: { title: string; defaultPath?: string }): Promise<string | undefined>;
  saveFile(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  appInfo(): AppInfo;
  readClipboard(): Promise<string>;
  /** Taskbar/dock progress: 0–1, "indeterminate" while sizes are unknown, undefined when idle. */
  setDownloadProgress(progress: number | "indeterminate" | undefined, activeCount: number): void;
  /** A system notification for a finished download; the platform skips it while the app is focused. */
  notifyDownload(outcome: "completed" | "failed", title: string): void;
  platform: NodeJS.Platform;
}

/** How this install finds, fetches and applies updates (see UpdateService). */
export interface UpdatePort {
  environment: UpdateEnvironment;
  fetch: HttpFetch;
  install(filePath: string): Promise<void>;
}

export interface BackendOptions {
  userDataPath: string;
  defaultDownloadDirectory?: string;
  session: SessionPort;
  player: PlayerService;
  platform: PlatformPort;
  /** Omitted in tests: updates then report a development build that never checks. */
  updates?: UpdatePort;
  emit: <E extends EventChannel>(channel: E, payload: IpcEventContract[E]) => void;
}

export class Backend {
  readonly settings: SettingsStore;
  readonly favorites: FavoriteStore;
  readonly downloads: DownloadManager;
  readonly client: IwaraClient;
  readonly updates: UpdateService;
  private readonly session: SessionPort;
  private readonly player: PlayerService;
  private readonly platform: PlatformPort;
  private saltSniff?: Promise<void>;
  private readonly streams = new Map<string, string>();
  private activeDownloadIds = new Set<string>();

  constructor(options: BackendOptions) {
    this.session = options.session;
    this.player = options.player;
    this.platform = options.platform;
    this.settings = new SettingsStore(options.userDataPath, options.defaultDownloadDirectory);
    this.favorites = new FavoriteStore(options.userDataPath);
    this.client = new IwaraClient({
      fetch: options.session.fetch,
      session: options.session,
      salt: () => this.settings.get().iwara.xVersionSalt
    });
    this.downloads = new DownloadManager(options.userDataPath, {
      prepare: async (request, _signal, inUse) => {
        await this.maybeSniffSalt();
        const settings = this.settings.get();
        const plan = await this.client.prepareDownload(request, settings.download, settings.mediaSpeed, inUse);
        this.rememberHosts(plan.video.formats);
        return plan;
      },
      transfer: async (plan, onProgress, signal) => {
        const settings = this.settings.get();
        return transferToFile({
          fetch: this.session.fetch,
          url: plan.format.url,
          filePath: plan.path,
          headers: await this.client.mediaRequestHeaders(),
          maxConnections: settings.download.maxConnections,
          minSplitBytes: settings.download.minSplitBytes,
          onProgress,
          signal
        });
      }
    }, () => this.settings.get().download.maxConcurrent);

    const updates = options.updates ?? offlineUpdates(options.userDataPath, options.platform.appInfo().version);
    this.updates = new UpdateService({
      environment: updates.environment,
      fetch: updates.fetch,
      install: updates.install,
      settings: {
        get: () => this.settings.get().updates,
        update: (patch) => this.settings.update({ updates: patch })
      },
      emit: (state) => options.emit("updates:changed", state)
    });

    this.settings.onChange((settings) => {
      options.emit("settings:changed", settings);
      // A higher limit starts waiting downloads right away.
      this.downloads.pump();
    });
    this.favorites.onChange((state) => options.emit("favorites:changed", state));
    this.downloads.onChange((state) => {
      options.emit("downloads:changed", state);
      this.trackDownloads(state);
    });
    this.activeDownloadIds = new Set(this.downloads.state().active.map((task) => task.id));
    this.session.onChange(() => {
      void this.authState().then((state) => options.emit("auth:changed", state)).catch(() => undefined);
    });
  }

  shutdown(): void {
    this.updates.stop();
    this.downloads.shutdown();
  }

  // --- Iwara -------------------------------------------------------------------

  listVideos(request: ListVideosRequest): Promise<VideoListResult> {
    return this.client.listVideos(request, this.settings.get().tagPreferences);
  }

  async getVideo(idOrUrl: string): Promise<VideoDetail> {
    await this.maybeSniffSalt();
    const video = await this.client.getVideo(idOrUrl);
    this.rememberHosts(video.formats);
    return this.client.routeVideoFormats(video, this.settings.get().mediaSpeed);
  }

  async diagnoseVideo(idOrUrl: string): Promise<IwaraVideoDiagnostics> {
    await this.maybeSniffSalt();
    const network = await this.session.captureVideoNetwork(idOrUrl).catch(() => undefined);
    const report = await this.client.diagnoseVideo(idOrUrl, network);
    this.rememberHosts(report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? []);
    return report;
  }

  listComments(request: ListCommentsRequest): Promise<VideoCommentsResult> {
    return this.client.listVideoComments(request);
  }

  sendComment(request: SendVideoCommentRequest): Promise<VideoComment> {
    return this.client.sendVideoComment(request);
  }

  setAuthorFollowing(request: AuthorFollowRequest): Promise<AuthorFollowResult> {
    return this.client.setAuthorFollowing(request);
  }

  async sniffXVersionSalt(): Promise<XVersionSaltReport> {
    const report = await this.client.sniffXVersionSalt();
    this.settings.update({ iwara: { xVersionSalt: report.salt, lastSaltSniffAt: report.checkedAt, lastSaltSource: report.sourceUrl } });
    return report;
  }

  listRelated(videoId: string): Promise<VideoSummary[]> {
    return this.client.listRelatedVideos(videoId, this.settings.get().tagPreferences);
  }

  async speedTestVideo(idOrUrl: string): Promise<MediaSpeedTestReport> {
    const report = await this.client.speedTestVideo(idOrUrl, this.settings.get().mediaSpeed);
    this.settings.updateMediaHostRanking(report.results, report.testedAt);
    return report;
  }

  // --- Playback ----------------------------------------------------------------

  async play(request: PlayRequest): Promise<PlayResult> {
    await this.maybeSniffSalt();
    let video = await this.client.getVideo(request.videoId);
    this.rememberHosts(video.formats);
    let settings = this.settings.get();
    if (settings.mediaSpeed.autoTest && !settings.mediaSpeed.rankedHosts.length && video.formats.length) {
      try {
        const report = await this.client.speedTestHosts(video, settings.mediaSpeed);
        settings = this.settings.updateMediaHostRanking(report.results, report.testedAt);
      } catch {
        // A failed speed test must not block playback; the original links still work.
      }
    }
    video = this.client.routeVideoFormats(video, settings.mediaSpeed);

    const requestedQuality = request.quality ?? settings.player.preferredQuality;
    const format = chooseVideoFormat(video.formats, requestedQuality);
    if (!format) {
      throw new AppError("NO_FORMATS", "No playable quality was found.");
    }
    const mode = request.mode ?? settings.player.preferredMode;
    const fallbackFrom = requestedQuality && requestedQuality !== format.id ? requestedQuality : undefined;
    if (mode === "builtin") {
      const previous = settings.history.find((entry) => entry.video.id === video.id);
      this.settings.addHistory({ video: summaryOf(video), formatId: format.id, mode, playedAt: new Date().toISOString() });
      return {
        ok: true,
        mode,
        streamUrl: this.registerStream(format.url),
        resumeAt: resumePosition(previous),
        format,
        video,
        fallbackFrom
      };
    }
    const playerPath = this.player.requirePlayer(mode, settings.player);
    await this.player.launch(playerPath, this.player.buildArgs(mode, settings.player, format.url, video.title));
    this.settings.addHistory({ video: summaryOf(video), formatId: format.id, mode, playedAt: new Date().toISOString() });

    return { ok: true, mode, playerPath, format, video, fallbackFrom };
  }

  reportProgress(progress: PlaybackProgress): void {
    this.settings.updateHistoryProgress(progress);
  }

  /**
   * Serves an `iwara-media://stream/<token>` request from the built-in player:
   * the media is fetched through the Iwara session (referrer, token, Range)
   * and streamed back. Only URLs registered by play() are reachable.
   */
  async streamMedia(requestUrl: string, range: string | null, signal?: AbortSignal): Promise<Response> {
    let token: string | undefined;
    try {
      const parsed = new URL(requestUrl);
      token = parsed.hostname === "stream" ? parsed.pathname.slice(1) : undefined;
    } catch {
      token = undefined;
    }
    const url = token ? this.streams.get(token) : undefined;
    if (!url) {
      return new Response("Not found", { status: 404 });
    }
    let upstream: Response;
    try {
      const headers = mergeHeaders(await this.client.mediaRequestHeaders(), range ? { Range: range } : undefined);
      upstream = await this.session.fetch(url, { headers, signal });
    } catch {
      return new Response("Upstream error", { status: 502 });
    }
    const headers = new Headers();
    for (const name of STREAM_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "video/mp4");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  probePlayers(): PlayerDiagnostics {
    return this.player.probe(this.settings.get().player);
  }

  testMpv(): Promise<PlayerProbe> {
    return this.player.testMpv(this.settings.get().player);
  }

  // --- Downloads ---------------------------------------------------------------

  listDownloads(): DownloadState {
    return this.downloads.state();
  }

  startDownload(request: DownloadVideoRequest): DownloadTask {
    return this.downloads.start({
      videoId: request.videoId,
      quality: request.quality ?? this.settings.get().download.defaultQuality
    });
  }

  retryDownload(id: string): DownloadTask {
    return this.downloads.retry(id);
  }

  cancelDownload(id: string): DownloadState {
    return this.downloads.cancel(id);
  }

  deleteDownload(request: DownloadDeleteRequest): Promise<DownloadState> {
    return this.downloads.delete(request);
  }

  clearFinishedDownloads(): DownloadState {
    return this.downloads.clearFinished();
  }

  async openDownloadFile(id: string): Promise<void> {
    const filePath = this.downloads.task(id)?.path;
    if (!filePath || !existsSync(filePath)) {
      throw new AppError("FILE_NOT_FOUND", "The downloaded file no longer exists.");
    }
    await this.platform.openPath(filePath);
  }

  async showDownloadInFolder(id: string): Promise<void> {
    const task = this.downloads.task(id);
    const filePath = task?.path;
    if (filePath && existsSync(filePath)) {
      this.platform.showItemInFolder(filePath);
      return;
    }
    const directory = task?.directory ?? (filePath ? path.dirname(filePath) : undefined);
    if (!directory || !existsSync(directory)) {
      throw new AppError("FILE_NOT_FOUND", "The download folder no longer exists.");
    }
    await this.platform.openPath(directory);
  }

  async openDownloadDirectory(): Promise<void> {
    const directory = this.settings.get().download.directory;
    if (!directory) {
      throw new AppError("DOWNLOAD_DIRECTORY_REQUIRED", "Choose a download folder in Settings first.");
    }
    await mkdir(directory, { recursive: true });
    await this.platform.openPath(directory);
  }

  // --- Favorites ---------------------------------------------------------------

  listFavorites(): FavoriteState {
    return this.favorites.state();
  }

  addFavorite(video: VideoSummary): FavoriteState {
    return this.favorites.add(summaryOf(video));
  }

  restoreFavorite(item: FavoriteItem): FavoriteState {
    return this.favorites.restore(item);
  }

  removeFavorite(videoId: string): FavoriteState {
    return this.favorites.remove(videoId);
  }

  backupFavorites(): FavoriteFileResult {
    return this.favorites.exportToPath(this.favorites.backupPath());
  }

  async exportFavorites(): Promise<FavoriteFileResult> {
    const selected = await this.platform.saveFile({
      title: "Export favorites",
      defaultPath: "iwaratv-favorites.json",
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (!selected) {
      return { canceled: true, count: this.favorites.state().items.length };
    }
    return this.favorites.exportToPath(path.extname(selected) ? selected : `${selected}.json`);
  }

  async importFavorites(): Promise<FavoriteImportResult> {
    const selected = await this.platform.pickFile({
      title: "Import favorites",
      filters: [{ name: "JSON", extensions: ["json"] }, { name: "All Files", extensions: ["*"] }]
    });
    if (!selected) {
      const state = this.favorites.state();
      return { canceled: true, imported: 0, merged: 0, skipped: 0, total: state.items.length, state };
    }
    return this.favorites.importFromPath(selected);
  }

  // --- Settings ----------------------------------------------------------------

  getSettings(): AppSettings {
    return this.settings.get();
  }

  updateSettings(patch: SettingsPatch): AppSettings {
    return this.settings.update(patch);
  }

  // --- Auth --------------------------------------------------------------------

  async authState(): Promise<AuthState> {
    const snapshot = await this.session.snapshot();
    const token = snapshot.token;
    let avatarUrl: string | undefined;
    let username = token?.username;
    if (token) {
      try {
        const profile = await this.client.currentUserProfile();
        avatarUrl = profile.avatarUrl;
        username = profile.username ?? username;
      } catch {
        // Profile details are cosmetic; the session itself is still usable.
      }
    }
    const expiry = this.session.tokenExpiry();
    return {
      status: token ? "signed-in" : snapshot.cookieCount > 0 ? "verified" : "anonymous",
      username,
      avatarUrl,
      siteSessionReady: snapshot.cookieCount > 0,
      siteCookieCount: snapshot.cookieCount,
      siteTokenReady: Boolean(token),
      siteTokenKey: token?.key,
      tokenExpiresAt: expiry?.toISOString(),
      verificationWindowOpen: snapshot.verificationWindowOpen
    };
  }

  async openVerification(): Promise<AuthState> {
    await this.session.openVerificationWindow();
    return this.authState();
  }

  async signOut(): Promise<AuthState> {
    this.client.clearCredentials();
    await this.session.signOut();
    return this.authState();
  }

  // --- Updates -----------------------------------------------------------------

  updateState(): UpdateState {
    return this.updates.getState();
  }

  checkForUpdates(): Promise<UpdateState> {
    return this.updates.check();
  }

  downloadUpdate(): Promise<UpdateState> {
    return this.updates.download();
  }

  installUpdate(): Promise<UpdateState> {
    return this.updates.install();
  }

  skipUpdate(version: string): UpdateState {
    return this.updates.skip(version);
  }

  // --- System ------------------------------------------------------------------

  async selectExecutable(request: SelectPathRequest): Promise<SelectPathResult> {
    const filters = this.platform.platform === "win32"
      // Players are started without a shell, so .cmd/.bat scripts can't be used.
      ? [{ name: "Programs", extensions: ["exe"] }, { name: "All Files", extensions: ["*"] }]
      : [{ name: "All Files", extensions: ["*"] }];
    const selected = await this.platform.pickFile({
      title: request.title,
      defaultPath: request.currentPath ? path.dirname(request.currentPath) : undefined,
      filters
    });
    return selected ? { canceled: false, path: resolveMacAppBundle(selected) } : { canceled: true };
  }

  async selectDirectory(request: SelectPathRequest): Promise<SelectPathResult> {
    const selected = await this.platform.pickDirectory({ title: request.title, defaultPath: request.currentPath });
    return selected ? { canceled: false, path: selected } : { canceled: true };
  }

  async openExternal(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError("INVALID_INPUT", "Not a valid URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new AppError("INVALID_INPUT", "Only web links can be opened.");
    }
    await this.platform.openExternal(parsed.toString());
  }

  async writeClipboard(text: string): Promise<void> {
    await this.platform.writeClipboard(text);
  }

  /** Only a link to an Iwara video is recognized; any other clipboard text stays in the main process. */
  async clipboardVideo(): Promise<string | undefined> {
    const text = (await this.platform.readClipboard()).trim().slice(0, 2048);
    return /^https?:\/\/(?:www\.)?iwara\.tv\/video\//i.test(text) ? parseIwaraVideoId(text) : undefined;
  }

  appInfo(): AppInfo {
    return this.platform.appInfo();
  }

  // --- Internals ---------------------------------------------------------------

  /** Refreshes the X-Version salt at most once a day; failures fall back to the stored salt. */
  private maybeSniffSalt(): Promise<void> {
    const { iwara } = this.settings.get();
    const last = iwara.lastSaltSniffAt ? Date.parse(iwara.lastSaltSniffAt) : Number.NaN;
    if (!iwara.autoSniffXVersionSalt || (Number.isFinite(last) && Date.now() - last < SALT_MAX_AGE_MS)) {
      return Promise.resolve();
    }
    this.saltSniff ??= this.sniffXVersionSalt()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.saltSniff = undefined;
      });
    return this.saltSniff;
  }

  private registerStream(url: string): string {
    const token = randomUUID();
    this.streams.set(token, url);
    while (this.streams.size > MAX_STREAMS) {
      this.streams.delete(this.streams.keys().next().value!);
    }
    return `${MEDIA_STREAM_SCHEME}://stream/${token}`;
  }

  /** Mirrors download progress to the taskbar and announces finished downloads. */
  private trackDownloads(state: DownloadState): void {
    const active = state.active;
    const sized = active.filter((task) => task.totalBytes);
    const total = sized.reduce((sum, task) => sum + (task.totalBytes ?? 0), 0);
    const written = sized.reduce((sum, task) => sum + task.bytesWritten, 0);
    this.platform.setDownloadProgress(
      !active.length ? undefined : sized.length === active.length && total > 0 ? Math.min(written / total, 1) : "indeterminate",
      active.length
    );

    if (this.settings.get().download.notifyOnComplete) {
      for (const task of state.history) {
        if (this.activeDownloadIds.has(task.id) && (task.status === "completed" || task.status === "failed")) {
          this.platform.notifyDownload(task.status, task.video?.title ?? task.videoId);
        }
      }
    }
    this.activeDownloadIds = new Set(active.map((task) => task.id));
  }

  private rememberHosts(formats: readonly VideoFormat[]): void {
    this.settings.addMediaHosts(formats.map((format) => mediaUrlHost(format.url)));
  }
}

/** Updates for a backend without an update port (tests): a development build that can't reach GitHub. */
function offlineUpdates(userDataPath: string, currentVersion: string): UpdatePort {
  return {
    environment: {
      currentVersion,
      installKind: "dev",
      strategy: "none",
      downloadDirectory: path.join(userDataPath, "updates"),
      ownsDownloadDirectory: true,
      source: GITHUB_SOURCE
    },
    fetch: () => Promise.reject(new AppError("UPDATE_CHECK_FAILED", "Update checks are turned off in this build.", { reason: "disabled" })),
    install: () => Promise.reject(new AppError("UPDATE_INSTALL_FAILED", "This build can't install updates.", { reason: "devBuild" }))
  };
}

/** Continue where the viewer stopped, unless that was the very start or the end. */
function resumePosition(entry: PlaybackHistoryItem | undefined): number | undefined {
  const position = entry?.positionSeconds ?? 0;
  const duration = entry?.durationSeconds ?? 0;
  return position >= 15 && (!duration || position < duration - 20) ? position : undefined;
}

function summaryOf(video: VideoSummary | VideoDetail): VideoSummary {
  const { formats: _formats, embedUrl: _embedUrl, ...summary } = video as VideoDetail;
  return summary;
}

/** On macOS a picked `Foo.app` bundle is resolved to the executable inside it. */
function resolveMacAppBundle(selected: string): string {
  if (!selected.endsWith(".app")) {
    return selected;
  }
  try {
    const macOsDir = path.join(selected, "Contents", "MacOS");
    const names = readdirSync(macOsDir).filter((name) => statSync(path.join(macOsDir, name)).isFile());
    const bundleName = path.basename(selected, ".app").toLowerCase();
    const match = names.find((name) => name.toLowerCase() === bundleName) ?? names[0];
    return match ? path.join(macOsDir, match) : selected;
  } catch {
    return selected;
  }
}

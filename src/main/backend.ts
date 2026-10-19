import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventChannel, IpcEventContract } from "../shared/ipc";
import { mediaUrlHost } from "../shared/media-hosts";
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
  VideoFormat,
  VideoListResult,
  VideoSummary,
  XVersionSaltReport
} from "../shared/types";
import { AppError } from "./lib/app-error";
import { transferToFile } from "./lib/file-transfer";
import type { HttpFetch } from "./lib/http";
import { chooseVideoFormat } from "./lib/iwara-parse";
import type { CapturedToken } from "./lib/jwt";
import { DownloadManager } from "./services/download-manager";
import { FavoriteStore } from "./services/favorite-store";
import { IwaraClient, type IwaraSessionBridge } from "./services/iwara-client";
import type { PlayerService } from "./services/player-service";
import { SettingsStore } from "./services/settings-store";

const SALT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  writeClipboard(text: string): void;
  pickFile(options: { title: string; defaultPath?: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  pickDirectory(options: { title: string; defaultPath?: string }): Promise<string | undefined>;
  saveFile(options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | undefined>;
  appInfo(): AppInfo;
  platform: NodeJS.Platform;
}

export interface BackendOptions {
  userDataPath: string;
  defaultDownloadDirectory?: string;
  session: SessionPort;
  player: PlayerService;
  platform: PlatformPort;
  emit: <E extends EventChannel>(channel: E, payload: IpcEventContract[E]) => void;
}

export class Backend {
  readonly settings: SettingsStore;
  readonly favorites: FavoriteStore;
  readonly downloads: DownloadManager;
  readonly client: IwaraClient;
  private readonly session: SessionPort;
  private readonly player: PlayerService;
  private readonly platform: PlatformPort;
  private saltSniff?: Promise<void>;

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
    });

    this.settings.onChange((settings) => options.emit("settings:changed", settings));
    this.favorites.onChange((state) => options.emit("favorites:changed", state));
    this.downloads.onChange((state) => options.emit("downloads:changed", state));
    this.session.onChange(() => {
      void this.authState().then((state) => options.emit("auth:changed", state)).catch(() => undefined);
    });
  }

  shutdown(): void {
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
    const playerPath = this.player.requirePlayer(mode, settings.player);
    await this.player.launch(playerPath, this.player.buildArgs(mode, settings.player, format.url, video.title));
    this.settings.addHistory({ video: summaryOf(video), formatId: format.id, mode, playedAt: new Date().toISOString() });

    return {
      ok: true,
      mode,
      playerPath,
      format,
      video,
      fallbackFrom: requestedQuality && requestedQuality !== format.id ? requestedQuality : undefined
    };
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

  writeClipboard(text: string): void {
    this.platform.writeClipboard(text);
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

  private rememberHosts(formats: readonly VideoFormat[]): void {
    this.settings.addMediaHosts(formats.map((format) => mediaUrlHost(format.url)));
  }
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createDefaultSettings, EMPTY_AUTH_STATE, EMPTY_DOWNLOAD_STATE, EMPTY_FAVORITE_STATE } from "../../shared/defaults";
import { normalizeTag, normalizeTagList } from "../../shared/tags";
import type {
  AppInfo,
  AppSettings,
  AuthState,
  DownloadState,
  DownloadTask,
  FavoriteState,
  PlayerMode,
  SettingsPatch,
  VideoSummary
} from "../../shared/types";
import { useI18n } from "../i18n";
import { ApiError, hasBridge, invoke, subscribe, toApiError } from "../lib/api";
import { describeError, describeErrorCode, recoveryLabel, type ErrorDescription, type RecoveryAction } from "../lib/errors";
import { formatDuration, qualityLabel } from "../lib/format";
import { useConfirm } from "./confirm";
import { useNavigationActions, type AuthorRef } from "./navigation";
import { useToasts } from "./toasts";

export interface VideoRef {
  id: string;
  title?: string;
  thumbnailUrl?: string;
}

/** What the built-in player on a video page should play. */
export interface InlinePlayback {
  videoId: string;
  streamUrl: string;
  formatId: string;
  /** Position to start from, in seconds. */
  startAt: number;
  /** Changes on every (re)start so the player reloads even for the same video. */
  nonce: number;
}

export interface PlayOptions {
  quality?: string;
  mode?: PlayerMode;
  /** Built-in player: start here instead of the saved position (e.g. after switching quality). */
  startAt?: number;
}

const LAUNCH_ERRORS = new Set(["MPV_NOT_FOUND", "EXTERNAL_PLAYER_NOT_FOUND", "EXTERNAL_PLAYER_TEMPLATE", "PLAYER_LAUNCH_FAILED"]);
let inlineNonce = 0;

interface AppStateValue {
  ready: boolean;
  settings: AppSettings;
  auth: AuthState;
  authLoading: boolean;
  favorites: FavoriteState;
  favoriteIds: ReadonlySet<string>;
  downloadStatus(videoId: string): "idle" | "active" | "completed";
  appInfo?: AppInfo;
  isBusy(key: string): boolean;
  isFollowing(authorId: string | undefined, fallback?: boolean): boolean;
  inline?: InlinePlayback;
  /** Fraction (0–1) of the video watched in the built-in player, if any. */
  watchProgress(videoId: string): number | undefined;

  updateSettings(patch: SettingsPatch): Promise<AppSettings | undefined>;
  play(video: VideoRef, options?: PlayOptions): Promise<void>;
  /** Stops the built-in player (only if it is playing `videoId`, when given). */
  closeInline(videoId?: string): void;
  reportProgress(videoId: string, positionSeconds: number, durationSeconds: number): void;
  download(video: VideoRef, quality?: string): Promise<void>;
  toggleFavorite(video: VideoSummary): Promise<void>;
  setAuthorFollowing(author: AuthorRef, following: boolean): Promise<void>;
  toggleFollowTag(tag: string): Promise<void>;
  toggleBlockTag(tag: string): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refreshAuth(): Promise<void>;
  reportError(error: unknown, retry?: () => void): void;
  runRecovery(action: RecoveryAction, retry?: () => void): void;
  copyText(text: string): Promise<void>;
  openExternal(url: string): void;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);
const DownloadsContext = createContext<DownloadState>(EMPTY_DOWNLOAD_STATE);

export function AppStateProvider({ children, onUiChange }: { children: ReactNode; onUiChange?: (ui: AppSettings["ui"]) => void }) {
  const { t } = useI18n();
  const { push: pushToast } = useToasts();
  const toasts = useMemo(() => ({ push: pushToast }), [pushToast]);
  const confirm = useConfirm();
  const navigation = useNavigationActions();
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings);
  const [auth, setAuth] = useState<AuthState>(EMPTY_AUTH_STATE);
  const [authLoading, setAuthLoading] = useState(true);
  const [favorites, setFavorites] = useState<FavoriteState>(EMPTY_FAVORITE_STATE);
  const [downloads, setDownloads] = useState<DownloadState>(EMPTY_DOWNLOAD_STATE);
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [followOverrides, setFollowOverrides] = useState<Record<string, boolean>>({});
  const [inline, setInline] = useState<InlinePlayback>();
  const previousDownloads = useRef<DownloadState>(EMPTY_DOWNLOAD_STATE);
  const previousAuth = useRef<AuthState | undefined>(undefined);

  const busyRef = useRef(new Set<string>());
  const withBusy = useCallback(async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current.has(key)) {
      return undefined;
    }
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      return await task();
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  }, []);

  // --- Errors & recovery ------------------------------------------------------

  const runRecoveryRef = useRef<(action: RecoveryAction, retry?: () => void) => void>(() => undefined);

  const showError = useCallback((description: ErrorDescription, retry?: () => void) => {
    const recovery = description.action;
    const action = recovery && (recovery !== "retry" || retry)
      ? { label: recoveryLabel(recovery, t), onClick: () => runRecoveryRef.current(recovery, retry) }
      : undefined;
    toasts.push({ tone: "error", title: description.title, detail: description.detail, action });
  }, [t, toasts]);

  const reportError = useCallback((error: unknown, retry?: () => void) => {
    showError(describeError(error, t), retry);
  }, [showError, t]);

  const signIn = useCallback(async () => {
    try {
      const state = await invoke("auth:open-verification");
      setAuth(state);
      if (state.status !== "signed-in") {
        toasts.push({ tone: "info", title: t("settings.account.waiting"), key: "auth" });
      }
    } catch (error) {
      reportError(error);
    }
  }, [t, toasts, reportError]);

  const runRecovery = useCallback((action: RecoveryAction, retry?: () => void) => {
    switch (action) {
      case "settings-playback":
        navigation.openSettings("playback");
        break;
      case "settings-downloads":
        navigation.openSettings("downloads");
        break;
      case "sign-in":
      case "verify":
        void signIn();
        break;
      case "retry":
        retry?.();
        break;
    }
  }, [navigation, signIn]);
  runRecoveryRef.current = runRecovery;
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;

  // --- Initial load and push events ------------------------------------------

  useEffect(() => {
    if (!hasBridge()) {
      return;
    }
    const unsubscribers = [
      subscribe("settings:changed", setSettings),
      subscribe("favorites:changed", setFavorites),
      subscribe("downloads:changed", setDownloads),
      subscribe("auth:changed", (state) => {
        setAuth(state);
        setAuthLoading(false);
      }),
      // e.g. a "download finished" notification was clicked.
      subscribe("app:navigate", ({ section }) => navigation.goTo(section))
    ];
    void Promise.all([invoke("settings:get"), invoke("favorites:list"), invoke("downloads:list"), invoke("system:app-info")])
      .then(([loadedSettings, loadedFavorites, loadedDownloads, info]) => {
        setSettings(loadedSettings);
        setFavorites(loadedFavorites);
        setDownloads(loadedDownloads);
        previousDownloads.current = loadedDownloads;
        setAppInfo(info);
      })
      .catch((error: unknown) => reportErrorRef.current(error))
      .finally(() => setReady(true));
    void invoke("auth:state")
      .then(setAuth)
      .catch(() => undefined)
      .finally(() => setAuthLoading(false));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  // Language and theme live above this provider.
  const onUiChangeRef = useRef(onUiChange);
  onUiChangeRef.current = onUiChange;
  useEffect(() => {
    if (ready) {
      onUiChangeRef.current?.(settings.ui);
    }
  }, [ready, settings.ui]);

  // Announce finished downloads.
  useEffect(() => {
    const before = previousDownloads.current;
    previousDownloads.current = downloads;
    const wasActive = new Set(before.active.map((task) => task.id));
    for (const task of downloads.history) {
      if (!wasActive.has(task.id)) {
        continue;
      }
      const title = task.video?.title ?? task.videoId;
      if (task.status === "completed") {
        toasts.push({
          tone: "success",
          key: `download:${task.videoId}`,
          title: t("downloads.completedToast", { title }),
          action: { label: t("downloads.showInFolder"), onClick: () => void invoke("downloads:show-in-folder", task.id).catch(reportError) }
        });
      } else if (task.status === "failed") {
        const description = describeErrorCode(task.errorCode ?? "DOWNLOAD_FAILED", task.error ?? "", t);
        toasts.push({
          tone: "error",
          key: `download:${task.videoId}`,
          title: t("downloads.failedToast", { title }),
          detail: description.detail,
          action: description.action && description.action !== "retry"
            ? { label: recoveryLabel(description.action, t), onClick: () => runRecovery(description.action!) }
            : { label: t("downloads.resume"), onClick: () => void invoke("downloads:retry", task.id).catch(reportError) }
        });
      }
    }
  }, [downloads, t, toasts, reportError, runRecovery]);

  // Announce a successful sign-in (not the session restored at launch).
  useEffect(() => {
    if (authLoading) {
      return;
    }
    const before = previousAuth.current;
    previousAuth.current = auth;
    if (before && before.status !== "signed-in" && auth.status === "signed-in") {
      toasts.push({ tone: "success", key: "auth", title: t("settings.account.signedInToast", { name: auth.username ?? t("account.signedIn") }) });
    }
  }, [auth, authLoading, t, toasts]);

  // --- Actions ----------------------------------------------------------------

  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    try {
      const next = await invoke("settings:update", patch);
      setSettings(next);
      return next;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }, [reportError]);

  const play = useCallback(async (video: VideoRef, options: PlayOptions = {}): Promise<void> => {
    await withBusy(`play:${video.id}`, async () => {
      try {
        const result = await invoke("player:play", { videoId: video.id, quality: options.quality, mode: options.mode });
        if (result.mode === "builtin" && result.streamUrl) {
          const videoId = result.video.id;
          const resumeAt = options.startAt === undefined ? result.resumeAt : undefined;
          setInline({ videoId, streamUrl: result.streamUrl, formatId: result.format.id, startAt: options.startAt ?? resumeAt ?? 0, nonce: ++inlineNonce });
          navigation.openVideo(videoId, { title: result.video.title, thumbnailUrl: result.video.thumbnailUrl ?? video.thumbnailUrl });
          if (result.fallbackFrom) {
            toasts.push({
              tone: "info",
              key: `play:${videoId}`,
              title: t("player.fallbackHere", { requested: qualityLabel(result.fallbackFrom), quality: qualityLabel(result.format.label) })
            });
          }
          if (resumeAt) {
            toasts.push({
              tone: "info",
              key: `resume:${videoId}`,
              title: t("player.resumed", { time: formatDuration(resumeAt) }),
              action: {
                label: t("player.startOver"),
                onClick: () => setInline((current) => (current?.videoId === videoId ? { ...current, startAt: 0, nonce: ++inlineNonce } : current))
              }
            });
          }
          return;
        }
        const player = result.mode === "mpv" ? t("player.mpv") : t("player.external");
        toasts.push({
          tone: "success",
          title: result.fallbackFrom
            ? t("player.startedFallback", { player, requested: qualityLabel(result.fallbackFrom), quality: qualityLabel(result.format.label) })
            : t("player.started", { player, quality: qualityLabel(result.format.label) }),
          detail: result.video.title
        });
      } catch (error) {
        const mode = options.mode ?? settings.player.preferredMode;
        if (mode !== "builtin" && LAUNCH_ERRORS.has(toApiError(error).code)) {
          // The local player is missing or broken: offer the built-in one right away.
          const description = describeError(error, t);
          toasts.push({
            tone: "error",
            title: description.title,
            detail: description.detail,
            action: { label: t("player.playHereInstead"), onClick: () => void play(video, { ...options, mode: "builtin" }) }
          });
          return;
        }
        reportError(error, () => void play(video, options));
      }
    });
  }, [withBusy, t, toasts, reportError, navigation, settings.player.preferredMode]);

  const closeInline = useCallback((videoId?: string) => {
    setInline((current) => (!videoId || current?.videoId === videoId ? undefined : current));
  }, []);

  const reportProgress = useCallback((videoId: string, positionSeconds: number, durationSeconds: number) => {
    // Best effort: losing one position update is harmless.
    void invoke("player:report-progress", { videoId, positionSeconds, durationSeconds }).catch(() => undefined);
  }, []);

  const progressMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of settings.history) {
      if (entry.positionSeconds && entry.durationSeconds) {
        map.set(entry.video.id, Math.min(entry.positionSeconds / entry.durationSeconds, 1));
      }
    }
    return map;
  }, [settings.history]);
  const watchProgress = useCallback((videoId: string) => progressMap.get(videoId), [progressMap]);

  const download = useCallback(async (video: VideoRef, quality?: string) => {
    await withBusy(`download:${video.id}`, async () => {
      try {
        const task = await invoke("downloads:start", { videoId: video.id, quality });
        setDownloads((current) => current.active.some((item) => item.id === task.id)
          ? current
          : { ...current, active: [task, ...current.active] });
        toasts.push({
          tone: "info",
          key: `download:${video.id}`,
          title: t("downloads.queuedToast", { title: video.title ?? video.id }),
          action: { label: t("downloads.view"), onClick: () => navigation.goTo("downloads") }
        });
      } catch (error) {
        reportError(error, () => void download(video, quality));
      }
    });
  }, [withBusy, t, toasts, navigation, reportError]);

  const favoriteIds = useMemo(() => new Set(favorites.items.map((item) => item.video.id)), [favorites]);

  const toggleFavorite = useCallback(async (video: VideoSummary) => {
    await withBusy(`favorite:${video.id}`, async () => {
      try {
        const existing = favorites.items.find((item) => item.video.id === video.id);
        if (existing) {
          setFavorites(await invoke("favorites:remove", video.id));
          toasts.push({
            tone: "info",
            key: `favorite:${video.id}`,
            title: t("favorites.removed", { title: video.title }),
            action: {
              label: t("common.undo"),
              onClick: () => void invoke("favorites:restore", existing).then(setFavorites).catch(reportError)
            }
          });
        } else {
          setFavorites(await invoke("favorites:add", video));
          toasts.push({ tone: "success", key: `favorite:${video.id}`, title: t("favorites.added", { title: video.title }) });
        }
      } catch (error) {
        reportError(error);
      }
    });
  }, [withBusy, favorites, t, toasts, reportError]);

  const isFollowing = useCallback(
    (authorId: string | undefined, fallback?: boolean) => (authorId && authorId in followOverrides ? followOverrides[authorId]! : fallback === true),
    [followOverrides]
  );

  const setAuthorFollowing = useCallback(async (author: AuthorRef, following: boolean) => {
    if (auth.status !== "signed-in") {
      reportError(new ApiError({ code: "LOGIN_REQUIRED", message: "" }));
      return;
    }
    await withBusy(`follow:${author.id}`, async () => {
      try {
        const result = await invoke("iwara:set-author-following", { authorId: author.id, following });
        setFollowOverrides((current) => ({ ...current, [result.authorId]: result.following }));
        const name = author.name ?? author.username ?? t("common.unknownAuthor");
        toasts.push({ tone: "success", key: `follow:${result.authorId}`, title: result.following ? t("author.followed", { name }) : t("author.unfollowed", { name }) });
      } catch (error) {
        reportError(error, () => void setAuthorFollowing(author, following));
      }
    });
  }, [auth.status, withBusy, t, toasts, reportError]);

  const toggleFollowTag = useCallback(async (rawTag: string) => {
    const tag = normalizeTag(rawTag);
    const { followedTags, blockedTags } = settings.tagPreferences;
    const following = followedTags.includes(tag);
    const next = await updateSettings({
      tagPreferences: following
        ? { followedTags: followedTags.filter((item) => item !== tag) }
        : { followedTags: normalizeTagList([...followedTags, tag]), blockedTags: blockedTags.filter((item) => item !== tag) }
    });
    if (next) {
      toasts.push({ tone: "success", key: `tag:${tag}`, title: following ? t("tags.unfollowed", { tag }) : t("tags.followed", { tag }) });
    }
  }, [settings.tagPreferences, updateSettings, toasts, t]);

  const toggleBlockTag = useCallback(async (rawTag: string) => {
    const tag = normalizeTag(rawTag);
    const { followedTags, blockedTags } = settings.tagPreferences;
    const blocked = blockedTags.includes(tag);
    const next = await updateSettings({
      tagPreferences: blocked
        ? { blockedTags: blockedTags.filter((item) => item !== tag) }
        : { blockedTags: normalizeTagList([...blockedTags, tag]), followedTags: followedTags.filter((item) => item !== tag) }
    });
    if (next) {
      toasts.push({ tone: "success", key: `tag:${tag}`, title: blocked ? t("tags.unblocked", { tag }) : t("tags.blocked", { tag }) });
    }
  }, [settings.tagPreferences, updateSettings, toasts, t]);

  const signOut = useCallback(async () => {
    const result = await confirm({
      title: t("settings.account.signOutTitle"),
      body: t("settings.account.signOutBody"),
      confirmLabel: t("settings.account.signOutConfirm"),
      tone: "danger"
    });
    if (result !== "confirm") {
      return;
    }
    try {
      setAuth(await invoke("auth:sign-out"));
      setFollowOverrides({});
      toasts.push({ tone: "success", key: "auth", title: t("settings.account.signedOut") });
    } catch (error) {
      reportError(error);
    }
  }, [confirm, t, toasts, reportError]);

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      setAuth(await invoke("auth:state"));
    } catch (error) {
      reportError(error);
    } finally {
      setAuthLoading(false);
    }
  }, [reportError]);

  const copyText = useCallback(async (text: string) => {
    try {
      await invoke("system:write-clipboard", text);
      toasts.push({ tone: "success", title: t("common.copied") });
    } catch (error) {
      reportError(error);
    }
  }, [toasts, t, reportError]);

  const openExternal = useCallback((url: string) => {
    void invoke("system:open-external", url).catch(reportError);
  }, [reportError]);

  // Only changes when a video starts/finishes downloading, not on progress ticks.
  const statusSignature = [
    ...downloads.active.map((task) => `a:${task.videoId}`),
    ...downloads.history.filter((task: DownloadTask) => task.status === "completed").map((task) => `c:${task.videoId}`)
  ].join("|");
  const downloadStatusMap = useMemo(() => {
    const map = new Map<string, "active" | "completed">();
    for (const entry of statusSignature.split("|")) {
      const [kind, videoId] = [entry.slice(0, 1), entry.slice(2)];
      if (videoId && (kind === "a" || !map.has(videoId))) {
        map.set(videoId, kind === "a" ? "active" : "completed");
      }
    }
    return map;
  }, [statusSignature]);
  const downloadStatus = useCallback((videoId: string) => downloadStatusMap.get(videoId) ?? "idle", [downloadStatusMap]);
  const isBusy = useCallback((key: string) => busy.has(key), [busy]);

  const value = useMemo<AppStateValue>(() => ({
    ready,
    settings,
    auth,
    authLoading,
    favorites,
    favoriteIds,
    downloadStatus,
    appInfo,
    isBusy,
    isFollowing,
    inline,
    watchProgress,
    updateSettings,
    play,
    closeInline,
    reportProgress,
    download,
    toggleFavorite,
    setAuthorFollowing,
    toggleFollowTag,
    toggleBlockTag,
    signIn,
    signOut,
    refreshAuth,
    reportError,
    runRecovery,
    copyText,
    openExternal
  }), [
    ready, settings, auth, authLoading, favorites, favoriteIds, downloadStatus, appInfo, isBusy, isFollowing,
    inline, watchProgress, updateSettings, play, closeInline, reportProgress, download, toggleFavorite, setAuthorFollowing, toggleFollowTag, toggleBlockTag,
    signIn, signOut, refreshAuth, reportError, runRecovery, copyText, openExternal
  ]);

  return (
    <AppStateContext.Provider value={value}>
      <DownloadsContext.Provider value={downloads}>{children}</DownloadsContext.Provider>
    </AppStateContext.Provider>
  );
}

/** Live download state (changes on every progress update). */
export function useDownloads(): DownloadState {
  return useContext(DownloadsContext);
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) {
    throw new Error("useAppState must be used inside AppStateProvider");
  }
  return value;
}

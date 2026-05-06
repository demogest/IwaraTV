import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bell,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  ClipboardCopy,
  CornerDownRight,
  Clock3,
  Download,
  ExternalLink,
  Flame,
  FolderOpen,
  Gauge,
  Heart,
  History,
  Link2,
  Loader2,
  LogIn,
  MessageCircle,
  MonitorPlay,
  Play,
  RefreshCw,
  Search,
  Settings,
  Send,
  Shield,
  Star,
  Tag,
  Trash2,
  TrendingUp,
  UserRound,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { type CSSProperties, FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AuthState,
  DownloadResult,
  DownloadState,
  DownloadTask,
  FavoriteState,
  IwaraVideoDiagnostics,
  MediaSpeedTestReport,
  PlayerDiagnostics,
  PlayerMode,
  PlayerProbe,
  VideoComment,
  VideoCommentsResult,
  VideoDetail,
  VideoListNetworkAttempt,
  VideoListResult,
  VideoSort,
  VideoSummary,
  XVersionSaltReport
} from "./lib/types";
import { normalizeMediaHostList } from "./lib/media-speed-utils";
import logoMarkUrl from "./assets/iwara-tv-mark.svg";
import { classifyIssue, type UiIssue } from "./lib/issue-utils";

type MainSection = "browse" | "search" | "subscriptions" | "favorites" | "downloads" | "history" | "settings";
type AppSection = MainSection | "detail";
type FeedTabKey = Extract<VideoSort, "date" | "trending" | "popularity"> | "followed";
type SearchSort = Extract<VideoSort, "relevance" | "date" | "views" | "likes">;
type DownloadButtonState = "idle" | "downloading" | "completed";
interface ActiveAuthor {
  id: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  following?: boolean;
}
interface VideoFilters {
  query: string;
  tags: string[];
}

const sectionTabs: Array<{ section: MainSection; label: string; Icon: LucideIcon }> = [
  { section: "browse", label: "浏览", Icon: MonitorPlay },
  { section: "search", label: "搜索", Icon: Search },
  { section: "subscriptions", label: "订阅", Icon: Bell },
  { section: "favorites", label: "收藏", Icon: Star },
  { section: "downloads", label: "下载", Icon: Download },
  { section: "history", label: "历史", Icon: History },
  { section: "settings", label: "设置", Icon: Settings }
];

const initialMainSectionScroll: Record<MainSection, number> = {
  browse: 0,
  search: 0,
  subscriptions: 0,
  favorites: 0,
  downloads: 0,
  history: 0,
  settings: 0
};

const feedTabs: Array<{ key: FeedTabKey; label: string; Icon: LucideIcon }> = [
  { key: "date", label: "最新", Icon: Clock3 },
  { key: "trending", label: "当前人气", Icon: Flame },
  { key: "popularity", label: "流行视频", Icon: TrendingUp },
  { key: "followed", label: "关注标签", Icon: Heart }
];

const searchSortTabs: Array<{ key: SearchSort; label: string; Icon: LucideIcon }> = [
  { key: "relevance", label: "相关", Icon: Search },
  { key: "date", label: "最新", Icon: Clock3 },
  { key: "views", label: "播放", Icon: TrendingUp },
  { key: "likes", label: "喜欢", Icon: Heart }
];

const qualityOptions = ["Source", "2160", "1440", "1080", "720", "540", "360", "Preview"];
const TOAST_AUTO_DISMISS_MS = 3000;

const defaultSettings: AppSettings = {
  player: {
    preferredMode: "mpv",
    externalPlayerArgs: "{url}",
    preferredQuality: "Source"
  },
  iwara: {
    xVersionSalt: "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN",
    autoSniffXVersionSalt: true
  },
  mediaSpeed: {
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
  },
  download: {
    defaultQuality: "Source",
    maxConnections: 4,
    minSplitBytes: 16777216
  },
  tagPreferences: {
    followedTags: [],
    blockedTags: [],
    maxScanPages: 5,
    requestDelayMs: 250
  },
  history: []
};

const defaultAuth: AuthState = {
  loggedIn: false,
  hasMediaToken: false,
  encryptionAvailable: false
};

const defaultDownloadState: DownloadState = {
  active: [],
  history: []
};

const defaultFavoriteState: FavoriteState = {
  items: []
};

export function App() {
  const api = window.iwaraTV;
  const [activeSection, setActiveSection] = useState<AppSection>("browse");
  const [detailReturnSection, setDetailReturnSection] = useState<MainSection>("browse");
  const [activeFeedTab, setActiveFeedTab] = useState<FeedTabKey>("date");
  const [feeds, setFeeds] = useState<Partial<Record<FeedTabKey, VideoListResult>>>({});
  const [searchFeed, setSearchFeed] = useState<VideoListResult | undefined>();
  const [subscriptionFeed, setSubscriptionFeed] = useState<VideoListResult | undefined>();
  const [authorFeed, setAuthorFeed] = useState<VideoListResult | undefined>();
  const [activeAuthor, setActiveAuthor] = useState<ActiveAuthor | undefined>();
  const [filters, setFilters] = useState<VideoFilters>({ query: "", tags: [] });
  const [searchFilters, setSearchFilters] = useState<VideoFilters>({ query: "", tags: [] });
  const [searchSort, setSearchSort] = useState<SearchSort>("relevance");
  const [tagInput, setTagInput] = useState("");
  const [searchTagInput, setSearchTagInput] = useState("");
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [downloads, setDownloads] = useState<DownloadState>(defaultDownloadState);
  const [favorites, setFavorites] = useState<FavoriteState>(defaultFavoriteState);
  const [auth, setAuth] = useState<AuthState>(defaultAuth);
  const [diagnostics, setDiagnostics] = useState<PlayerDiagnostics | undefined>();
  const [mpvTest, setMpvTest] = useState<PlayerProbe | undefined>();
  const [videoDiagnostics, setVideoDiagnostics] = useState<IwaraVideoDiagnostics | undefined>();
  const [commentsResult, setCommentsResult] = useState<VideoCommentsResult | undefined>();
  const [speedReport, setSpeedReport] = useState<MediaSpeedTestReport | undefined>();
  const [saltReport, setSaltReport] = useState<XVersionSaltReport | undefined>();
  const [selectedVideo, setSelectedVideo] = useState<VideoDetail | undefined>();
  const [selectedQuality, setSelectedQuality] = useState<string | undefined>();
  const [urlInput, setUrlInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [issue, setIssue] = useState<UiIssue | undefined>();
  const [loadingFeed, setLoadingFeed] = useState(false);
  const loadingFeedRef = useRef(false);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const loadingSearchRef = useRef(false);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const loadingSubscriptionsRef = useRef(false);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingVideoId, setLoadingVideoId] = useState<string | undefined>();
  const [loadingVideoTitle, setLoadingVideoTitle] = useState<string | undefined>();
  const [quickPlayingId, setQuickPlayingId] = useState<string | undefined>();
  const [downloadingVideoId, setDownloadingVideoId] = useState<string | undefined>();
  const [downloadActionId, setDownloadActionId] = useState<string | undefined>();
  const [favoriteActionId, setFavoriteActionId] = useState<string | undefined>();
  const [favoriteFileBusy, setFavoriteFileBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [authorFollowBusyId, setAuthorFollowBusyId] = useState<string | undefined>();
  const [probing, setProbing] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [diagnosingVideo, setDiagnosingVideo] = useState(false);
  const [speedTesting, setSpeedTesting] = useState(false);
  const [saltSniffing, setSaltSniffing] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = useState<string | undefined>();
  const [submittingComment, setSubmittingComment] = useState(false);
  const [avatarImageReady, setAvatarImageReady] = useState(Boolean(auth.avatarUrl));
  const workspaceRef = useRef<HTMLElement | null>(null);
  const mainSectionScrollRef = useRef<Record<MainSection, number>>({ ...initialMainSectionScroll });
  const activeSectionRef = useRef<AppSection>("browse");
  const scrollRestoreFrameRef = useRef<number | undefined>(undefined);
  const videoOpenRequestRef = useRef(0);
  activeSectionRef.current = activeSection;

  const activeFeed = feeds[activeFeedTab];
  const hasApi = Boolean(api);
  const canLoadSubscriptions = Boolean(auth.loggedIn || auth.siteTokenReady);
  const canFollowAuthors = canLoadSubscriptions;
  const showDetailPage = activeSection === "detail";
  const activeNavSection = showDetailPage ? detailReturnSection : activeSection;
  const authDisplayName = auth.username
    ?? auth.email
    ?? (auth.siteTokenReady ? "网页登录" : auth.siteSessionReady ? "已验证会话" : "匿名");
  const authStatusLabel = auth.username
    ?? (auth.siteTokenReady ? "网页登录就绪" : auth.siteSessionReady ? "会话已验证" : auth.loggedIn ? "API 已登录" : "未验证");
  const showAvatarLogo = Boolean(auth.avatarUrl && avatarImageReady);
  const brandLogoSource = showAvatarLogo ? auth.avatarUrl! : logoMarkUrl;
  const brandLogoClassName = showAvatarLogo ? "brand-logo brand-avatar" : "brand-logo";
  const sortedFormats = useMemo(
    () => [...(selectedVideo?.formats ?? [])].sort((a, b) => b.qualityRank - a.qualityRank),
    [selectedVideo]
  );
  const activeDownloadVideoIds = useMemo(
    () => new Set(downloads.active.map((task) => task.videoId)),
    [downloads.active]
  );
  const completedDownloadVideoIds = useMemo(
    () => new Set(downloads.history.filter((task) => task.status === "completed").map((task) => task.videoId)),
    [downloads.history]
  );
  const favoriteVideoIds = useMemo(
    () => new Set(favorites.items.map((item) => item.video.id)),
    [favorites.items]
  );

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    if (activeSection === "detail") {
      workspace.scrollTop = 0;
      workspace.scrollLeft = 0;
    } else {
      restoreMainSectionScroll(activeSection);
    }
  }, [activeSection]);

  useEffect(() => {
    return () => {
      if (scrollRestoreFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }

    void api.settings.get().then(setSettings).catch(handleError);
    void refreshDownloads(false);
    void refreshFavorites(false);
    void api.player.probe().then(setDiagnostics).catch(handleError);
    void api.auth.state().then(setAuth).catch(handleError);
  }, [api]);

  useEffect(() => {
    if (!api) {
      return;
    }

    const intervalMs = activeSection === "downloads" || downloads.active.length ? 1200 : 5000;
    const timer = window.setInterval(() => {
      void refreshDownloads(false);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [api, activeSection, downloads.active.length]);

  useEffect(() => {
    setAvatarImageReady(Boolean(auth.avatarUrl));
  }, [auth.avatarUrl]);

  useEffect(() => {
    if (!issue) {
      return;
    }

    const timer = window.setTimeout(() => {
      setIssue(undefined);
    }, TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [issue]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timer = window.setTimeout(() => {
      setStatus("");
    }, TOAST_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!api || activeSection !== "browse" || loadingFeed || feeds[activeFeedTab]) {
      return;
    }

    void loadFeed(activeFeedTab);
  }, [activeSection, activeFeedTab, feeds, api, loadingFeed]);

  useEffect(() => {
    if (!api || activeSection !== "subscriptions" || !canLoadSubscriptions || loadingSubscriptions || subscriptionFeed) {
      return;
    }

    void loadSubscriptionFeed();
  }, [activeSection, api, canLoadSubscriptions, loadingSubscriptions, subscriptionFeed]);

  useEffect(() => {
    if (!api || !selectedVideo) {
      return;
    }

    void loadComments(selectedVideo.id);
  }, [api, selectedVideo?.id]);

  async function loadFeed(tab: FeedTabKey, page = feeds[tab]?.page ?? 0, nextFilters = filters) {
    if (!api || loadingFeedRef.current) {
      return;
    }

    const sort: VideoSort = tab === "followed" ? "date" : tab;
    loadingFeedRef.current = true;
    setLoadingFeed(true);
    clearMessages();
    try {
      const result = await api.iwara.listVideos({
        sort,
        page,
        rating: "all",
        query: nextFilters.query,
        tags: nextFilters.tags,
        followedOnly: tab === "followed"
      });
      setFeeds((current) => ({ ...current, [tab]: result }));
    } catch (err) {
      handleError(err);
    } finally {
      loadingFeedRef.current = false;
      setLoadingFeed(false);
    }
  }

  async function loadSearch(page = searchFeed?.page ?? 0, nextFilters = searchFilters, nextSort = searchSort) {
    if (!api || loadingSearchRef.current) {
      return;
    }

    const normalized = {
      query: nextFilters.query.trim(),
      tags: normalizeTagTokens(nextFilters.tags)
    };
    if (!normalized.query) {
      setSearchFeed(undefined);
      setSearchFilters(normalized);
      return;
    }

    loadingSearchRef.current = true;
    setLoadingSearch(true);
    clearMessages();
    try {
      const result = await api.iwara.listVideos({
        sort: nextSort,
        page,
        rating: "all",
        query: normalized.query,
        tags: normalized.tags,
        searchOnly: true
      });
      setSearchFeed(result);
      setSearchFilters(normalized);
      setSearchSort(nextSort);
    } catch (err) {
      handleError(err);
    } finally {
      loadingSearchRef.current = false;
      setLoadingSearch(false);
    }
  }

  async function loadSubscriptionFeed(page = subscriptionFeed?.page ?? 0) {
    if (!api || loadingSubscriptionsRef.current) {
      return;
    }

    if (!canLoadSubscriptions) {
      setSubscriptionFeed(undefined);
      setIssue(classifyIssue("查看订阅视频需要先登录 Iwara。"));
      return;
    }

    loadingSubscriptionsRef.current = true;
    setLoadingSubscriptions(true);
    clearMessages();
    try {
      const result = await api.iwara.listVideos({
        sort: "date",
        page,
        rating: "all",
        subscribedOnly: true
      });
      setSubscriptionFeed(result);
    } catch (err) {
      handleError(err);
    } finally {
      loadingSubscriptionsRef.current = false;
      setLoadingSubscriptions(false);
    }
  }

  async function loadAuthorFeed(author: ActiveAuthor, page = 0, nextFilters = filters) {
    if (!api) {
      return;
    }

    setActiveSection("browse");
    setActiveAuthor(author);
    setLoadingFeed(true);
    clearMessages();
    try {
      const result = await api.iwara.listVideos({
        sort: "date",
        page,
        rating: "all",
        query: nextFilters.query,
        tags: nextFilters.tags,
        userId: author.id
      });
      setAuthorFeed(result);
    } catch (err) {
      handleError(err);
    } finally {
      setLoadingFeed(false);
    }
  }

  async function openVideo(idOrUrl: string, title?: string) {
    const target = idOrUrl.trim();
    if (!api || !target) {
      return;
    }

    const requestId = beginVideoOpenRequest();
    const returnSection = activeSection === "detail" ? detailReturnSection : activeSection;
    if (activeSection !== "detail") {
      rememberMainSectionScroll(activeSection);
    }
    setDetailReturnSection(returnSection);
    setActiveSection("detail");
    setSelectedVideo(undefined);
    setLoadingVideoId(target);
    setLoadingVideoTitle(title);
    clearMessages();
    try {
      const video = await api.iwara.getVideo(target);
      if (!isCurrentVideoOpenRequest(requestId)) {
        return;
      }
      const loadedSettings = await api.settings.get();
      if (!isCurrentVideoOpenRequest(requestId)) {
        return;
      }
      const currentAuth = await api.auth.state().catch(() => auth);
      if (!isCurrentVideoOpenRequest(requestId)) {
        return;
      }
      setSettings(loadedSettings);
      setAuth(currentAuth);
      setSelectedVideo(video);
      setVideoDiagnostics(undefined);
      setCommentsResult(undefined);
      setReplyingTo(undefined);
      setReplyDrafts({});
      setCommentDraft("");
      setSpeedReport(undefined);
      let formats = video.formats;
      if (currentAuth.siteTokenReady && bestQualityRank(formats) <= 360) {
        const report = await api.iwara.diagnoseVideo(video.id);
        if (!isCurrentVideoOpenRequest(requestId)) {
          return;
        }
        setSettings(await api.settings.get());
        if (!isCurrentVideoOpenRequest(requestId)) {
          return;
        }
        const capturedFormats = report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? [];
        setVideoDiagnostics(report);
        if (bestQualityRank(capturedFormats) > bestQualityRank(formats)) {
          formats = capturedFormats;
          setSelectedVideo({ ...video, formats });
          setStatus(`已通过网页抓包补全：${formatLabelsText(formats.map((format) => format.label))}。`);
        }
      }
      if (loadedSettings.mediaSpeed.autoTest && !loadedSettings.mediaSpeed.rankedHosts.length && formats.length) {
        try {
          const report = await api.iwara.speedTestVideo(video.id);
          if (!isCurrentVideoOpenRequest(requestId)) {
            return;
          }
          setSettings(await api.settings.get());
          if (!isCurrentVideoOpenRequest(requestId)) {
            return;
          }
          setSpeedReport(report);
          setStatus(report.fastestHost ? `已完成全局线路测速，最快线路：${report.fastestHost}。` : "全局线路测速完成，没有可用线路。");
        } catch (err) {
          if (!isCurrentVideoOpenRequest(requestId)) {
            return;
          }
          setStatus(`全局线路测速失败，不影响播放：${errorText(err)}。`);
        }
      }
      const preferred = formats.find((format) => format.id === loadedSettings.player.preferredQuality);
      const best = bestFormat(formats);
      setSelectedQuality(preferred?.id ?? best?.id);
    } catch (err) {
      if (isCurrentVideoOpenRequest(requestId)) {
        handleError(err);
      }
    } finally {
      if (isCurrentVideoOpenRequest(requestId)) {
        setLoadingVideoId(undefined);
        setLoadingVideoTitle(undefined);
      }
    }
  }

  async function quickPlay(video: VideoSummary) {
    if (!api) {
      return;
    }

    setQuickPlayingId(video.id);
    clearMessages();
    try {
      const result = await api.player.play({
        videoId: video.id,
        mode: settings.player.preferredMode
      });
      setStatus(playStatus(result));
      setSettings(await api.settings.get());
      await refreshDiagnostics();
    } catch (err) {
      handleError(err);
    } finally {
      setQuickPlayingId(undefined);
    }
  }

  async function playVideo(mode: PlayerMode = settings.player.preferredMode) {
    if (!api || !selectedVideo) {
      return;
    }

    setPlaying(true);
    clearMessages();
    try {
      const result = await api.player.play({
        videoId: selectedVideo.id,
        quality: selectedQuality,
        mode
      });
      setStatus(playStatus(result));
      setSettings(await api.settings.get());
      await refreshDiagnostics();
    } catch (err) {
      handleError(err);
    } finally {
      setPlaying(false);
    }
  }

  async function refreshDownloads(reportError = true) {
    if (!api) {
      return;
    }

    try {
      setDownloads(await api.downloads.list());
    } catch (err) {
      if (reportError) {
        handleError(err);
      }
    }
  }

  async function refreshFavorites(reportError = true) {
    if (!api) {
      return;
    }

    try {
      setFavorites(await api.favorites.list());
    } catch (err) {
      if (reportError) {
        handleError(err);
      }
    }
  }

  async function downloadVideo(video: VideoSummary, quality?: string) {
    if (!api || downloadingVideoId === video.id || activeDownloadVideoIds.has(video.id)) {
      return;
    }

    setDownloadingVideoId(video.id);
    clearMessages();
    try {
      const task = await api.downloads.start({ videoId: video.id, quality });
      await refreshDownloads(false);
      setStatus(`已开始下载：${downloadTaskTitle(task)}。`);
    } catch (err) {
      handleError(err);
    } finally {
      setDownloadingVideoId(undefined);
    }
  }

  function closeDetailPanel(nextSection: MainSection = detailReturnSection) {
    invalidateVideoOpenRequest();
    setSelectedVideo(undefined);
    setSelectedQuality(undefined);
    setVideoDiagnostics(undefined);
    setCommentsResult(undefined);
    setReplyingTo(undefined);
    setReplyDrafts({});
    setCommentDraft("");
    setSpeedReport(undefined);
    setLoadingVideoId(undefined);
    setLoadingVideoTitle(undefined);
    setActiveSection(nextSection);
  }

  function rememberMainSectionScroll(section: MainSection) {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    mainSectionScrollRef.current[section] = workspace.scrollTop;
  }

  function rememberActiveMainSectionScroll() {
    const section = activeSectionRef.current;
    if (section !== "detail") {
      rememberMainSectionScroll(section);
    }
  }

  function restoreMainSectionScroll(section: MainSection) {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const top = mainSectionScrollRef.current[section] ?? 0;
    workspace.scrollTop = top;
    workspace.scrollLeft = 0;

    if (scrollRestoreFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
    }

    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = undefined;
      if (workspaceRef.current !== workspace || activeSectionRef.current !== section) {
        return;
      }

      workspace.scrollTop = top;
      workspace.scrollLeft = 0;
    });
  }

  function handleWorkspaceScroll() {
    const workspace = workspaceRef.current;
    const section = activeSectionRef.current;
    if (!workspace || section === "detail") {
      return;
    }

    mainSectionScrollRef.current[section] = workspace.scrollTop;
  }

  function beginVideoOpenRequest() {
    videoOpenRequestRef.current += 1;
    return videoOpenRequestRef.current;
  }

  function invalidateVideoOpenRequest() {
    videoOpenRequestRef.current += 1;
  }

  function isCurrentVideoOpenRequest(requestId: number) {
    return videoOpenRequestRef.current === requestId;
  }

  async function setAuthorFollowing(author: ActiveAuthor, following: boolean) {
    if (!api || authorFollowBusyId) {
      return;
    }

    if (!canFollowAuthors) {
      setIssue(classifyIssue("关注作者需要先登录 Iwara。"));
      return;
    }

    setAuthorFollowBusyId(author.id);
    clearMessages();
    try {
      const result = await api.iwara.setAuthorFollowing({ authorId: author.id, following });
      updateAuthorFollowing(result.authorId, result.following);
      const label = author.name ?? author.username ?? "作者";
      setStatus(result.following ? `已关注作者：${label}。` : `已取消关注作者：${label}。`);
    } catch (err) {
      handleError(err);
    } finally {
      setAuthorFollowBusyId(undefined);
    }
  }

  async function toggleAuthorFollowFromVideo(video: VideoDetail) {
    if (!video.uploaderId) {
      return;
    }

    await setAuthorFollowing({
      id: video.uploaderId,
      name: video.uploaderName,
      username: video.uploaderUsername,
      avatarUrl: video.uploaderAvatarUrl,
      following: video.uploaderFollowing
    }, video.uploaderFollowing !== true);
  }

  async function toggleAuthorFollowFromProfile(author: ActiveAuthor, currentFollowing?: boolean) {
    await setAuthorFollowing(author, currentFollowing !== true);
  }

  function updateAuthorFollowing(authorId: string, following: boolean) {
    setSelectedVideo((current) => updateVideoAuthorFollowing(current, authorId, following));
    setActiveAuthor((current) => current?.id === authorId ? { ...current, following } : current);
    setFeeds((current) => updateFeedCollectionAuthorFollowing(current, authorId, following));
    setSearchFeed((current) => updateFeedAuthorFollowing(current, authorId, following));
    setSubscriptionFeed((current) => updateFeedAuthorFollowing(current, authorId, following));
    setAuthorFeed((current) => updateFeedAuthorFollowing(current, authorId, following));
  }

  async function openAuthorProfile(video: VideoDetail) {
    if (!video.uploaderId) {
      return;
    }

    closeDetailPanel("browse");
    await loadAuthorFeed({
      id: video.uploaderId,
      name: video.uploaderName,
      username: video.uploaderUsername,
      avatarUrl: video.uploaderAvatarUrl,
      following: video.uploaderFollowing
    });
  }

  function showMainFeed(tab: FeedTabKey = activeFeedTab) {
    setActiveAuthor(undefined);
    setAuthorFeed(undefined);
    setActiveFeedTab(tab);
  }

  async function applyFilters(nextFilters: VideoFilters) {
    const normalized = {
      query: nextFilters.query.trim(),
      tags: normalizeTagTokens(nextFilters.tags)
    };
    setFilters(normalized);
    setFeeds((current) => ({ ...current, [activeFeedTab]: undefined }));
    if (activeAuthor) {
      await loadAuthorFeed(activeAuthor, 0, normalized);
    } else {
      await loadFeed(activeFeedTab, 0, normalized);
    }
  }

  async function applyTagFromDetail(tag: string) {
    closeDetailPanel("browse");
    await addTagFilter(tag);
  }

  async function addTagFilter(tag: string) {
    const tags = normalizeTagTokens([...filters.tags, tag]);
    setTagInput("");
    await applyFilters({ ...filters, tags });
  }

  async function removeTagFilter(tag: string) {
    await applyFilters({ ...filters, tags: filters.tags.filter((current) => current !== tag) });
  }

  async function clearFilters() {
    setTagInput("");
    await applyFilters({ query: "", tags: [] });
  }

  async function applySearchFilters(nextFilters: VideoFilters) {
    const normalized = {
      query: nextFilters.query.trim(),
      tags: normalizeTagTokens(nextFilters.tags)
    };
    setSearchFeed(undefined);
    if (normalized.query) {
      await loadSearch(0, normalized, searchSort);
    } else {
      setSearchFilters(normalized);
    }
  }

  async function changeSearchSort(sort: SearchSort) {
    setSearchSort(sort);
    setSearchFeed(undefined);
    if (searchFilters.query.trim()) {
      await loadSearch(0, searchFilters, sort);
    }
  }

  async function addSearchTagFilter(tag: string) {
    const tags = normalizeTagTokens([...searchFilters.tags, tag]);
    setSearchTagInput("");
    await applySearchFilters({ ...searchFilters, tags });
  }

  async function removeSearchTagFilter(tag: string) {
    await applySearchFilters({ ...searchFilters, tags: searchFilters.tags.filter((current) => current !== tag) });
  }

  async function clearSearchFilters() {
    setSearchTagInput("");
    await applySearchFilters({ query: "", tags: [] });
  }

  async function loadComments(videoId: string) {
    if (!api) {
      return;
    }

    setLoadingComments(true);
    try {
      setCommentsResult(await api.iwara.listComments({ videoId }));
    } catch (err) {
      setCommentsResult({
        videoId,
        comments: [],
        total: 0,
        fetchedAt: new Date().toISOString()
      });
      setIssue(classifyIssue(err));
    } finally {
      setLoadingComments(false);
    }
  }

  async function submitComment(parentId?: string) {
    if (!api || !selectedVideo || submittingComment) {
      return;
    }

    const body = (parentId ? replyDrafts[parentId] : commentDraft)?.trim();
    if (!body) {
      return;
    }

    setSubmittingComment(true);
    clearMessages();
    try {
      await api.iwara.sendComment({ videoId: selectedVideo.id, body, parentId });
      if (parentId) {
        setReplyDrafts((current) => ({ ...current, [parentId]: "" }));
        setReplyingTo(undefined);
      } else {
        setCommentDraft("");
      }
      await loadComments(selectedVideo.id);
      setStatus(parentId ? "回复已发送。" : "评论已发送。");
    } catch (err) {
      handleError(err);
    } finally {
      setSubmittingComment(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await openVideo(urlInput);
  }

  async function updatePlayerSettings(partial: Partial<AppSettings["player"]>): Promise<AppSettings | undefined> {
    if (!api) {
      return undefined;
    }

    const next = await api.settings.update({ player: { ...settings.player, ...partial } });
    setSettings(next);
    return next;
  }

  async function updateIwaraSettings(partial: Partial<AppSettings["iwara"]>): Promise<AppSettings | undefined> {
    if (!api) {
      return undefined;
    }

    const next = await api.settings.update({ iwara: { ...settings.iwara, ...partial } });
    setSettings(next);
    return next;
  }

  async function updateMediaSpeedSettings(partial: Partial<AppSettings["mediaSpeed"]>): Promise<AppSettings | undefined> {
    if (!api) {
      return undefined;
    }

    const next = await api.settings.update({
      mediaSpeed: {
        ...settings.mediaSpeed,
        ...partial,
        candidateHosts: partial.candidateHosts
          ? normalizeMediaHostList(partial.candidateHosts)
          : settings.mediaSpeed.candidateHosts
      }
    });
    setSettings(next);
    return next;
  }

  async function updateDownloadSettings(partial: Partial<AppSettings["download"]>): Promise<AppSettings | undefined> {
    if (!api) {
      return undefined;
    }

    const next = await api.settings.update({ download: { ...settings.download, ...partial } });
    setSettings(next);
    return next;
  }

  async function updateTagPreferences(partial: Partial<AppSettings["tagPreferences"]>): Promise<AppSettings | undefined> {
    if (!api) {
      return undefined;
    }

    const next = await api.settings.update({
      tagPreferences: {
        ...settings.tagPreferences,
        ...partial,
        followedTags: partial.followedTags
          ? normalizeTagTokens(partial.followedTags)
          : settings.tagPreferences.followedTags,
        blockedTags: partial.blockedTags
          ? normalizeTagTokens(partial.blockedTags)
          : settings.tagPreferences.blockedTags
      }
    });
    setSettings(next);
    return next;
  }

  async function followTag(tag: string) {
    const normalized = normalizeTagTokens([tag])[0];
    if (!normalized) {
      return;
    }

    await updateTagPreferences({
      followedTags: [...settings.tagPreferences.followedTags, normalized],
      blockedTags: settings.tagPreferences.blockedTags.filter((blockedTag) => blockedTag !== normalized)
    });
    setStatus(`已关注标签：${normalized}。`);
  }

  async function blockTag(tag: string) {
    const normalized = normalizeTagTokens([tag])[0];
    if (!normalized) {
      return;
    }

    await updateTagPreferences({
      blockedTags: [...settings.tagPreferences.blockedTags, normalized],
      followedTags: settings.tagPreferences.followedTags.filter((followedTag) => followedTag !== normalized)
    });
    setStatus(`已屏蔽标签：${normalized}。`);
  }

  async function sniffXVersionSalt() {
    if (!api) {
      return;
    }

    setSaltSniffing(true);
    clearMessages();
    try {
      const report = await api.iwara.sniffXVersionSalt();
      setSaltReport(report);
      setSettings(await api.settings.get());
      setStatus(`已嗅探到 X-Version 盐值：${report.salt}。`);
    } catch (err) {
      handleError(err);
    } finally {
      setSaltSniffing(false);
    }
  }

  async function exportMediaHosts() {
    if (!api) {
      return;
    }

    clearMessages();
    const hosts = normalizeMediaHostList(settings.mediaSpeed.candidateHosts);
    await api.system.writeClipboard(hosts.join("\n"));
    setStatus(`已导出 ${hosts.length} 个 CDN 域名到剪贴板。`);
  }

  async function speedTestSelectedVideo() {
    if (!api || !selectedVideo) {
      return;
    }

    setSpeedTesting(true);
    clearMessages();
    try {
      const report = await api.iwara.speedTestVideo(selectedVideo.id);
      const nextSettings = await api.settings.get();
      setSettings(nextSettings);
      setSpeedReport(report);
      setStatus(report.fastestHost
        ? `全局测速完成，最快线路：${report.fastestHost}。${nextSettings.mediaSpeed.replaceLinks ? "播放会按设置替换到最快线路。" : "当前未开启链接替换。"}`
        : "全局测速完成，没有可用线路。");
    } catch (err) {
      handleError(err);
    } finally {
      setSpeedTesting(false);
    }
  }

  async function chooseExecutable(kind: "mpv" | "external") {
    if (!api) {
      return;
    }

    const selected = await api.system.selectExecutable({
      title: kind === "mpv" ? "选择 mpv.exe" : "选择外部播放器",
      currentPath: kind === "mpv" ? settings.player.mpvPath : settings.player.externalPlayerPath
    });

    if (selected.canceled || !selected.path) {
      return;
    }

    await updatePlayerSettings(kind === "mpv" ? { mpvPath: selected.path } : { externalPlayerPath: selected.path });
    await refreshDiagnostics();
  }

  async function chooseDownloadDirectory() {
    if (!api) {
      return;
    }

    const selected = await api.system.selectDirectory({
      title: "选择下载保存文件夹",
      currentPath: settings.download.directory
    });

    if (selected.canceled || !selected.path) {
      return;
    }

    await updateDownloadSettings({ directory: selected.path });
    setStatus(`下载保存路径已设置为：${selected.path}`);
  }

  async function refreshDiagnostics() {
    if (!api) {
      return;
    }

    setProbing(true);
    try {
      setDiagnostics(await api.player.probe());
    } catch (err) {
      handleError(err);
    } finally {
      setProbing(false);
    }
  }

  async function testMpv() {
    if (!api) {
      return;
    }

    setProbing(true);
    clearMessages();
    try {
      const result = await api.player.testMpv();
      setMpvTest(result);
      setStatus(result.message);
    } catch (err) {
      handleError(err);
    } finally {
      setProbing(false);
    }
  }

  async function diagnoseSelectedVideo() {
    if (!api || !selectedVideo) {
      return;
    }

    setDiagnosingVideo(true);
    clearMessages();
    try {
      const report = await api.iwara.diagnoseVideo(selectedVideo.id);
      setSettings(await api.settings.get());
      const capturedFormats = report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? [];
      if (capturedFormats.length) {
        const best = bestFormat(capturedFormats);
        setSelectedVideo({ ...selectedVideo, formats: capturedFormats });
        setSelectedQuality(best?.id);
      }
      setVideoDiagnostics(report);
      setStatus(
        capturedFormats.length
          ? `抓包诊断完成，已用网页响应补全：${formatLabelsText(capturedFormats.map((format) => format.label))}。`
          : `抓包诊断完成：应用 API ${formatLabelsText(report.appFormatLabels)}。`
      );
    } catch (err) {
      handleError(err);
    } finally {
      setDiagnosingVideo(false);
    }
  }

  async function clearHistory() {
    if (!api) {
      return;
    }

    const next = await api.settings.update({ history: [] });
    setSettings(next);
  }

  async function toggleFavorite(video: VideoSummary) {
    if (!api || favoriteActionId) {
      return;
    }

    setFavoriteActionId(video.id);
    clearMessages();
    try {
      const isFavorite = favoriteVideoIds.has(video.id);
      const next = isFavorite
        ? await api.favorites.remove(video.id)
        : await api.favorites.add(video);
      setFavorites(next);
      setStatus(isFavorite ? `已取消收藏：${video.title}。` : `已加入收藏：${video.title}。`);
    } catch (err) {
      handleError(err);
    } finally {
      setFavoriteActionId(undefined);
    }
  }

  async function backupFavorites() {
    if (!api || favoriteFileBusy) {
      return;
    }

    setFavoriteFileBusy(true);
    clearMessages();
    try {
      const result = await api.favorites.backup();
      if (!result.canceled) {
        setStatus(`已备份 ${result.count} 条收藏：${result.path ?? ""}`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      setFavoriteFileBusy(false);
    }
  }

  async function exportFavorites() {
    if (!api || favoriteFileBusy) {
      return;
    }

    setFavoriteFileBusy(true);
    clearMessages();
    try {
      const result = await api.favorites.exportFile();
      if (!result.canceled) {
        setStatus(`已导出 ${result.count} 条收藏：${result.path ?? ""}`);
      }
    } catch (err) {
      handleError(err);
    } finally {
      setFavoriteFileBusy(false);
    }
  }

  async function importFavorites() {
    if (!api || favoriteFileBusy) {
      return;
    }

    setFavoriteFileBusy(true);
    clearMessages();
    try {
      const result = await api.favorites.importFile();
      if (result.canceled) {
        return;
      }
      setFavorites(result.state);
      setStatus(`已导入 ${result.imported} 条，合并 ${result.merged} 条，当前共 ${result.total} 条收藏。`);
    } catch (err) {
      handleError(err);
    } finally {
      setFavoriteFileBusy(false);
    }
  }

  function downloadStateForVideo(videoId: string): DownloadButtonState {
    if (downloadingVideoId === videoId || activeDownloadVideoIds.has(videoId)) {
      return "downloading";
    }

    if (completedDownloadVideoIds.has(videoId)) {
      return "completed";
    }

    return "idle";
  }

  async function retryDownload(id: string) {
    if (!api || downloadActionId) {
      return;
    }

    setDownloadActionId(id);
    clearMessages();
    try {
      const task = await api.downloads.retry(id);
      await refreshDownloads(false);
      setStatus(`已重新开始下载：${downloadTaskTitle(task)}。`);
    } catch (err) {
      handleError(err);
    } finally {
      setDownloadActionId(undefined);
    }
  }

  async function deleteDownload(id: string) {
    if (!api || downloadActionId) {
      return;
    }

    setDownloadActionId(id);
    clearMessages();
    try {
      setDownloads(await api.downloads.delete({ id, deleteFile: true }));
      setStatus("已删除下载记录和本地文件。");
    } catch (err) {
      handleError(err);
    } finally {
      setDownloadActionId(undefined);
    }
  }

  async function openDownloadFile(id: string) {
    if (!api || downloadActionId) {
      return;
    }

    setDownloadActionId(id);
    clearMessages();
    try {
      await api.downloads.openFile(id);
    } catch (err) {
      handleError(err);
    } finally {
      setDownloadActionId(undefined);
    }
  }

  async function openDownloadFolder(id: string) {
    if (!api || downloadActionId) {
      return;
    }

    setDownloadActionId(id);
    clearMessages();
    try {
      await api.downloads.openFolder(id);
    } catch (err) {
      handleError(err);
    } finally {
      setDownloadActionId(undefined);
    }
  }

  async function refreshAuthState() {
    if (!api) {
      return;
    }

    setSessionBusy(true);
    clearMessages();
    try {
      setAuth(await api.auth.state());
      setStatus("会话状态已刷新。");
    } catch (err) {
      handleError(err);
    } finally {
      setSessionBusy(false);
    }
  }

  async function openIwaraSession() {
    if (!api) {
      return;
    }

    setSessionBusy(true);
    clearMessages();
    try {
      const initialAuth = await api.auth.openIwaraSession();
      setAuth(initialAuth);
      if (initialAuth.siteTokenReady) {
        setStatus("网页登录就绪。");
        return;
      }

      setStatus("已打开 Iwara 验证窗口，正在等待网页登录状态。");
      const ready = await waitForSessionReady(45000);
      setStatus(ready ? "网页登录就绪，验证窗口会自动关闭。" : "验证窗口仍在等待登录或 Cloudflare 验证。完成后应用会在刷新会话时复用它。");
    } catch (err) {
      handleError(err);
    } finally {
      setSessionBusy(false);
    }
  }

  async function waitForSessionReady(timeoutMs: number): Promise<boolean> {
    if (!api) {
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(1200);
      const nextAuth = await api.auth.state();
      setAuth(nextAuth);
      if (nextAuth.siteTokenReady) {
        return true;
      }
    }

    return false;
  }

  async function handleIssueAction(target: UiIssue) {
    if (target.action === "settings") {
      setActiveSection("settings");
      return;
    }

    if (target.action === "login") {
      setActiveSection("settings");
      return;
    }

    if (target.action === "open-iwara") {
      await openIwaraSession();
      return;
    }

    if (selectedVideo) {
      await openVideo(selectedVideo.id);
    } else if (activeSection === "search") {
      await loadSearch(searchFeed?.page ?? 0, searchFilters, searchSort);
    } else if (activeSection === "subscriptions") {
      await loadSubscriptionFeed(subscriptionFeed?.page ?? 0);
    } else if (activeSection === "downloads") {
      await refreshDownloads();
    } else if (activeSection === "favorites") {
      await refreshFavorites();
    } else {
      await loadFeed(activeFeedTab, activeFeed?.page ?? 0);
    }
  }

  function clearMessages() {
    setIssue(undefined);
    setStatus("");
  }

  function handleError(err: unknown) {
    setStatus("");
    setIssue(classifyIssue(err));
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img
              alt=""
              className={brandLogoClassName}
              onError={() => setAvatarImageReady(false)}
              referrerPolicy="no-referrer"
              src={brandLogoSource}
            />
          </div>
          <div>
            <h1>IwaraTV</h1>
            <span>{authDisplayName}</span>
          </div>
        </div>

        <nav className="nav-list">
          {sectionTabs.map(({ section, label, Icon }) => (
            <button
              className={activeNavSection === section ? "nav-button active" : "nav-button"}
              key={section}
              onClick={() => {
                if (activeSection === "detail") {
                  closeDetailPanel(section);
                  return;
                }
                rememberActiveMainSectionScroll();
                setActiveSection(section);
              }}
              type="button"
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <section
        className={showDetailPage ? "workspace detail-route" : "workspace"}
        onScroll={handleWorkspaceScroll}
        ref={workspaceRef}
      >
        <header className="topbar">
          <form className="url-form" onSubmit={handleSubmit}>
            <Search size={18} />
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="Iwara 视频链接或 ID"
            />
            <button disabled={!hasApi || !urlInput.trim() || Boolean(loadingVideoId)} type="submit">
              {loadingVideoId === urlInput.trim() ? <Loader2 className="spin" size={18} /> : <ExternalLink size={18} />}
              打开
            </button>
          </form>

          <button
            className="auth-pill"
            onClick={() => {
              if (activeSection === "detail") {
                closeDetailPanel("settings");
                return;
              }
              rememberActiveMainSectionScroll();
              setActiveSection("settings");
            }}
            type="button"
          >
            {auth.siteTokenReady || auth.loggedIn ? <Star size={16} /> : <LogIn size={16} />}
            {authStatusLabel}
          </button>
        </header>

        {!hasApi && (
          <div className="notice warning">
            当前是浏览器预览。运行桌面版后可以连接 Tauri 命令、启动 MPV 和保存设置。
          </div>
        )}

        <FeedbackToastLayer
          issue={issue}
          onDismissIssue={() => setIssue(undefined)}
          onDismissStatus={() => setStatus("")}
          onIssueAction={(target) => {
            void handleIssueAction(target);
          }}
          status={status}
        />

        {showDetailPage ? (
          <VideoDetailRoute
            playing={playing}
            selectedQuality={selectedQuality}
            sortedFormats={sortedFormats}
            diagnostics={videoDiagnostics}
            diagnosing={diagnosingVideo}
            downloadState={selectedVideo ? downloadStateForVideo(selectedVideo.id) : "idle"}
            favorite={selectedVideo ? favoriteVideoIds.has(selectedVideo.id) : false}
            favoriteBusy={Boolean(selectedVideo && favoriteActionId === selectedVideo.id)}
            authorFollowBusy={Boolean(selectedVideo && authorFollowBusyId === selectedVideo.uploaderId)}
            canFollowAuthor={canFollowAuthors}
            video={selectedVideo}
            loadingVideoId={loadingVideoId}
            loadingVideoTitle={loadingVideoTitle}
            backLabel={sectionLabel(detailReturnSection)}
            onBack={() => closeDetailPanel()}
            onDiagnose={diagnoseSelectedVideo}
            onBlockTag={blockTag}
            onCommentDraftChange={setCommentDraft}
            onFilterTag={applyTagFromDetail}
            onFollowTag={followTag}
            onOpenAuthor={openAuthorProfile}
            onToggleAuthorFollow={toggleAuthorFollowFromVideo}
            onPlay={playVideo}
            onDownload={() => selectedVideo && downloadVideo(selectedVideo, selectedQuality)}
            onToggleFavorite={() => selectedVideo && toggleFavorite(selectedVideo)}
            onQualityChange={setSelectedQuality}
            onRefreshComments={() => selectedVideo && loadComments(selectedVideo.id)}
            onReplyDraftChange={(commentId, value) => setReplyDrafts((current) => ({ ...current, [commentId]: value }))}
            onReplyToggle={(commentId) => setReplyingTo((current) => current === commentId ? undefined : commentId)}
            onSubmitComment={submitComment}
            commentDraft={commentDraft}
            comments={commentsResult}
            loadingComments={loadingComments}
            replyDrafts={replyDrafts}
            replyingTo={replyingTo}
            submittingComment={submittingComment}
            tagPreferences={settings.tagPreferences}
          />
        ) : (
        <div className="content-grid">
          <section className="primary-panel">
            {activeSection === "browse" && (
              <BrowseView
                activeAuthor={activeAuthor}
                activeFeed={activeAuthor ? authorFeed : activeFeed}
                activeFeedTab={activeFeedTab}
                authorFollowBusyId={authorFollowBusyId}
                canFollowAuthor={canFollowAuthors}
                downloadStateForVideo={downloadStateForVideo}
                favoriteActionId={favoriteActionId}
                favoriteVideoIds={favoriteVideoIds}
                hasApi={hasApi}
                filters={filters}
                loadingFeed={loadingFeed}
                loadingVideoId={loadingVideoId}
                onOpen={openVideo}
                onAddTag={addTagFilter}
                onBackToFeeds={() => showMainFeed()}
                onClearFilters={clearFilters}
                onDownload={(video) => downloadVideo(video)}
                onToggleFavorite={toggleFavorite}
                onFilterChange={(partial) => setFilters((current) => ({ ...current, ...partial }))}
                onFilterSubmit={() => applyFilters(filters)}
                onPage={(page) => activeAuthor ? loadAuthorFeed(activeAuthor, page) : loadFeed(activeFeedTab, page)}
                onQuickPlay={quickPlay}
                onRefresh={() => activeAuthor ? loadAuthorFeed(activeAuthor, authorFeed?.page ?? 0) : loadFeed(activeFeedTab, activeFeed?.page ?? 0)}
                onRemoveTag={removeTagFilter}
                onFeedTabChange={showMainFeed}
                onToggleAuthorFollow={toggleAuthorFollowFromProfile}
                quickPlayingId={quickPlayingId}
                tagInput={tagInput}
                onTagInputChange={setTagInput}
              />
            )}

            {activeSection === "search" && (
              <SearchView
                downloadStateForVideo={downloadStateForVideo}
                favoriteActionId={favoriteActionId}
                favoriteVideoIds={favoriteVideoIds}
                filters={searchFilters}
                hasApi={hasApi}
                loading={loadingSearch}
                loadingVideoId={loadingVideoId}
                onAddTag={addSearchTagFilter}
                onClearFilters={clearSearchFilters}
                onDownload={(video) => downloadVideo(video)}
                onToggleFavorite={toggleFavorite}
                onFilterChange={(partial) => setSearchFilters((current) => ({ ...current, ...partial }))}
                onFilterSubmit={() => applySearchFilters(searchFilters)}
                onOpen={openVideo}
                onPage={(page) => loadSearch(page, searchFilters, searchSort)}
                onQuickPlay={quickPlay}
                onRefresh={() => loadSearch(searchFeed?.page ?? 0, searchFilters, searchSort)}
                onRemoveTag={removeSearchTagFilter}
                onSortChange={changeSearchSort}
                quickPlayingId={quickPlayingId}
                result={searchFeed}
                sort={searchSort}
                tagInput={searchTagInput}
                onTagInputChange={setSearchTagInput}
              />
            )}

            {activeSection === "subscriptions" && (
              <SubscriptionView
                downloadStateForVideo={downloadStateForVideo}
                favoriteActionId={favoriteActionId}
                favoriteVideoIds={favoriteVideoIds}
                feed={subscriptionFeed}
                hasApi={hasApi}
                isLoggedIn={canLoadSubscriptions}
                loading={loadingSubscriptions}
                loadingVideoId={loadingVideoId}
                onDownload={(video) => downloadVideo(video)}
                onToggleFavorite={toggleFavorite}
                onLogin={openIwaraSession}
                onOpen={openVideo}
                onPage={loadSubscriptionFeed}
                onQuickPlay={quickPlay}
                onRefresh={() => loadSubscriptionFeed(subscriptionFeed?.page ?? 0)}
                quickPlayingId={quickPlayingId}
              />
            )}

            {activeSection === "favorites" && (
              <FavoritesView
                downloadStateForVideo={downloadStateForVideo}
                favoriteActionId={favoriteActionId}
                favoriteFileBusy={favoriteFileBusy}
                favorites={favorites}
                hasApi={hasApi}
                loadingVideoId={loadingVideoId}
                onBackup={backupFavorites}
                onDownload={(video) => downloadVideo(video)}
                onExport={exportFavorites}
                onImport={importFavorites}
                onOpen={openVideo}
                onQuickPlay={quickPlay}
                onRefresh={() => refreshFavorites()}
                onToggleFavorite={toggleFavorite}
                quickPlayingId={quickPlayingId}
              />
            )}

            {activeSection === "history" && (
              <HistoryView
                history={settings.history}
                loadingVideoId={loadingVideoId}
                onClear={clearHistory}
                onOpen={(video) => void openVideo(video.id, video.title)}
              />
            )}

            {activeSection === "downloads" && (
              <DownloadsView
                actionId={downloadActionId}
                downloads={downloads}
                hasApi={hasApi}
                onDelete={deleteDownload}
                onOpenFile={openDownloadFile}
                onOpenFolder={openDownloadFolder}
                onOpenVideo={(videoId, title) => void openVideo(videoId, title)}
                onRefresh={() => refreshDownloads()}
                onRetry={retryDownload}
              />
            )}

            {activeSection === "settings" && (
              <SettingsView
                auth={auth}
                diagnostics={diagnostics}
                download={settings.download}
                hasApi={hasApi}
                mpvTest={mpvTest}
                onChooseDownloadDirectory={chooseDownloadDirectory}
                onChooseExternal={() => chooseExecutable("external")}
                onChooseMpv={() => chooseExecutable("mpv")}
                onOpenIwaraSession={openIwaraSession}
                onProbe={refreshDiagnostics}
                onRefreshAuth={refreshAuthState}
                onExportMediaHosts={exportMediaHosts}
                onSniffXVersionSalt={sniffXVersionSalt}
                onSpeedTest={speedTestSelectedVideo}
                onTestMpv={testMpv}
                onUpdateDownload={updateDownloadSettings}
                onUpdateIwara={updateIwaraSettings}
                onUpdateMediaSpeed={updateMediaSpeedSettings}
                onUpdatePlayer={updatePlayerSettings}
                onUpdateTagPreferences={updateTagPreferences}
                iwara={settings.iwara}
                saltReport={saltReport}
                saltSniffing={saltSniffing}
                player={settings.player}
                probing={probing}
                selectedVideo={selectedVideo}
                sessionBusy={sessionBusy}
                speedReport={speedReport}
                speedSettings={settings.mediaSpeed}
                speedTesting={speedTesting}
                tagPreferences={settings.tagPreferences}
              />
            )}
          </section>
        </div>
        )}
      </section>
    </main>
  );
}

function VideoDetailRoute({
  playing,
  selectedQuality,
  sortedFormats,
  diagnostics,
  diagnosing,
  downloadState,
  favorite,
  favoriteBusy,
  authorFollowBusy,
  canFollowAuthor,
  video,
  loadingVideoId,
  loadingVideoTitle,
  backLabel,
  onBack,
  onDiagnose,
  onBlockTag,
  onCommentDraftChange,
  onFilterTag,
  onFollowTag,
  onOpenAuthor,
  onToggleAuthorFollow,
  onDownload,
  onToggleFavorite,
  onPlay,
  onQualityChange,
  onRefreshComments,
  onReplyDraftChange,
  onReplyToggle,
  onSubmitComment,
  commentDraft,
  comments,
  loadingComments,
  replyDrafts,
  replyingTo,
  submittingComment,
  tagPreferences
}: {
  playing: boolean;
  selectedQuality?: string;
  sortedFormats: VideoDetail["formats"];
  diagnostics?: IwaraVideoDiagnostics;
  diagnosing: boolean;
  downloadState: DownloadButtonState;
  favorite: boolean;
  favoriteBusy: boolean;
  authorFollowBusy: boolean;
  canFollowAuthor: boolean;
  video?: VideoDetail;
  loadingVideoId?: string;
  loadingVideoTitle?: string;
  backLabel: string;
  onBack: () => void;
  onDiagnose: () => void;
  onBlockTag: (tag: string) => void;
  onCommentDraftChange: (value: string) => void;
  onFilterTag: (tag: string) => void;
  onFollowTag: (tag: string) => void;
  onOpenAuthor: (video: VideoDetail) => void;
  onToggleAuthorFollow: (video: VideoDetail) => void;
  onDownload: () => void;
  onToggleFavorite: () => void;
  onPlay: (mode: PlayerMode) => void;
  onQualityChange: (quality: string) => void;
  onRefreshComments: () => void;
  onReplyDraftChange: (commentId: string, value: string) => void;
  onReplyToggle: (commentId: string) => void;
  onSubmitComment: (parentId?: string) => void;
  commentDraft: string;
  comments?: VideoCommentsResult;
  loadingComments: boolean;
  replyDrafts: Record<string, string>;
  replyingTo?: string;
  submittingComment: boolean;
  tagPreferences: AppSettings["tagPreferences"];
}) {
  const heading = video?.title ?? (loadingVideoId ? "正在打开视频" : "视频详情");

  return (
    <div className="detail-page">
      <div className="detail-page-header">
        <button className="secondary-button compact" onClick={onBack} type="button">
          <ArrowLeft size={17} />
          返回{backLabel}
        </button>
        <div>
          <p>视频详情</p>
          <h2>{heading}</h2>
        </div>
      </div>

      {loadingVideoId && !video ? (
        <DetailLoadingState idOrUrl={loadingVideoId} title={loadingVideoTitle} />
      ) : video ? (
        <DetailPanel
          playing={playing}
          selectedQuality={selectedQuality}
          sortedFormats={sortedFormats}
          diagnostics={diagnostics}
          diagnosing={diagnosing}
          downloadState={downloadState}
          favorite={favorite}
          favoriteBusy={favoriteBusy}
          authorFollowBusy={authorFollowBusy}
          canFollowAuthor={canFollowAuthor}
          video={video}
          onDiagnose={onDiagnose}
          onBlockTag={onBlockTag}
          onClose={onBack}
          onCommentDraftChange={onCommentDraftChange}
          onFilterTag={onFilterTag}
          onFollowTag={onFollowTag}
          onOpenAuthor={onOpenAuthor}
          onToggleAuthorFollow={onToggleAuthorFollow}
          onPlay={onPlay}
          onDownload={onDownload}
          onToggleFavorite={onToggleFavorite}
          onQualityChange={onQualityChange}
          onRefreshComments={onRefreshComments}
          onReplyDraftChange={onReplyDraftChange}
          onReplyToggle={onReplyToggle}
          onSubmitComment={onSubmitComment}
          commentDraft={commentDraft}
          comments={comments}
          loadingComments={loadingComments}
          replyDrafts={replyDrafts}
          replyingTo={replyingTo}
          submittingComment={submittingComment}
          tagPreferences={tagPreferences}
        />
      ) : (
        <EmptyState Icon={AlertTriangle} title="视频没有打开" actionLabel={`返回${backLabel}`} onAction={onBack} />
      )}
    </div>
  );
}

function DetailLoadingState({ idOrUrl, title }: { idOrUrl: string; title?: string }) {
  return (
    <div className="detail-loading-state">
      <Loader2 className="spin" size={36} />
      <h3>正在打开视频</h3>
      <p>{title ?? idOrUrl}</p>
    </div>
  );
}

function SearchView({
  downloadStateForVideo,
  favoriteActionId,
  favoriteVideoIds,
  filters,
  hasApi,
  loading,
  loadingVideoId,
  onAddTag,
  onClearFilters,
  onDownload,
  onToggleFavorite,
  onFilterChange,
  onFilterSubmit,
  onOpen,
  onPage,
  onQuickPlay,
  onRefresh,
  onRemoveTag,
  onSortChange,
  onTagInputChange,
  quickPlayingId,
  result,
  sort,
  tagInput
}: {
  downloadStateForVideo: (videoId: string) => DownloadButtonState;
  favoriteActionId?: string;
  favoriteVideoIds: Set<string>;
  filters: VideoFilters;
  hasApi: boolean;
  loading: boolean;
  loadingVideoId?: string;
  onAddTag: (tag: string) => void;
  onClearFilters: () => void;
  onDownload: (video: VideoSummary) => void;
  onToggleFavorite: (video: VideoSummary) => void;
  onFilterChange: (partial: Partial<VideoFilters>) => void;
  onFilterSubmit: () => void;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onQuickPlay: (video: VideoSummary) => void;
  onRefresh: () => void;
  onRemoveTag: (tag: string) => void;
  onSortChange: (sort: SearchSort) => void;
  onTagInputChange: (value: string) => void;
  quickPlayingId?: string;
  result?: VideoListResult;
  sort: SearchSort;
  tagInput: string;
}) {
  const videos = result?.results ?? [];
  const hasQuery = Boolean(filters.query.trim());
  const hasFilters = Boolean(hasQuery || filters.tags.length);

  return (
    <>
      <div className="section-header">
        <div>
          <p>全站检索</p>
          <h2>搜索</h2>
        </div>
        <button
          className="icon-text-button"
          disabled={!hasApi || !hasQuery || loading}
          onClick={onRefresh}
          type="button"
        >
          {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          刷新
        </button>
      </div>

      <div className="feed-tabs" role="tablist">
        {searchSortTabs.map(({ key, label, Icon }) => (
          <button
            aria-selected={sort === key}
            className={sort === key ? "feed-tab active" : "feed-tab"}
            disabled={loading}
            key={key}
            onClick={() => onSortChange(key)}
            role="tab"
            type="button"
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>

      <form
        className="filter-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onFilterSubmit();
        }}
      >
        <label className="filter-field search-filter">
          <Search size={17} />
          <input
            value={filters.query}
            onChange={(event) => onFilterChange({ query: event.target.value })}
            placeholder="搜索视频关键词"
          />
        </label>
        <label className="filter-field tag-filter">
          <Tag size={17} />
          <input
            value={tagInput}
            onChange={(event) => onTagInputChange(event.target.value)}
            placeholder="本地标签筛选，例如 blender"
          />
          <button
            className="secondary-button compact"
            disabled={!tagInput.trim()}
            onClick={() => onAddTag(tagInput)}
            type="button"
          >
            添加
          </button>
        </label>
        <button className="primary-button" disabled={!hasApi || !hasQuery || loading} type="submit">
          搜索
        </button>
        <button className="secondary-button" disabled={!hasFilters || loading} onClick={onClearFilters} type="button">
          清除
        </button>
      </form>

      {filters.tags.length ? (
        <div className="active-filter-tags">
          {filters.tags.map((tag) => (
            <button key={tag} onClick={() => onRemoveTag(tag)} type="button">
              {tag}
              <X size={13} />
            </button>
          ))}
        </div>
      ) : null}

      <ListScanSummary result={result} />

      {loading && !videos.length ? (
        <SkeletonGrid />
      ) : videos.length ? (
        <>
          <div className="list-scan-summary">
            {result?.total ? <span>共 {compactNumber(result.total)} 个结果</span> : null}
            <span>关键词：{result?.query ?? filters.query.trim()}</span>
            <span>排序：{searchSortLabel(result?.sort ?? sort)}</span>
          </div>
          <div className="video-grid">
            {videos.map((video) => (
              <VideoCard
                downloadState={downloadStateForVideo(video.id)}
                favorite={favoriteVideoIds.has(video.id)}
                favoriteBusy={favoriteActionId === video.id}
                key={video.id}
                loading={loadingVideoId === video.id}
                onDownload={() => onDownload(video)}
                onToggleFavorite={() => onToggleFavorite(video)}
                onOpen={() => onOpen(video.id)}
                onQuickPlay={() => onQuickPlay(video)}
                quickPlaying={quickPlayingId === video.id}
                video={video}
              />
            ))}
          </div>

          <div className="pager">
            <button
              disabled={!hasApi || loading || (result?.page ?? 0) <= 0}
              onClick={() => onPage(Math.max((result?.page ?? 0) - 1, 0))}
              type="button"
            >
              上一页
            </button>
            <span>第 {(result?.page ?? 0) + 1} 页</span>
            <button
              disabled={!hasApi || loading}
              onClick={() => onPage((result?.page ?? 0) + 1)}
              type="button"
            >
              下一页
            </button>
          </div>
        </>
      ) : (
        <EmptyState
          Icon={Search}
          title={hasQuery ? "没有搜索结果" : "输入关键词搜索视频"}
          actionLabel={hasQuery ? "重新搜索" : undefined}
          disabled={!hasApi || loading}
          onAction={hasQuery ? onRefresh : undefined}
        />
      )}
    </>
  );
}

function BrowseView({
  activeAuthor,
  activeFeed,
  activeFeedTab,
  authorFollowBusyId,
  canFollowAuthor,
  downloadStateForVideo,
  favoriteActionId,
  favoriteVideoIds,
  filters,
  hasApi,
  loadingFeed,
  loadingVideoId,
  onAddTag,
  onBackToFeeds,
  onClearFilters,
  onDownload,
  onToggleFavorite,
  onFilterChange,
  onFilterSubmit,
  onOpen,
  onPage,
  onQuickPlay,
  onRefresh,
  onRemoveTag,
  onFeedTabChange,
  onTagInputChange,
  onToggleAuthorFollow,
  quickPlayingId,
  tagInput
}: {
  activeAuthor?: ActiveAuthor;
  activeFeed?: VideoListResult;
  activeFeedTab: FeedTabKey;
  authorFollowBusyId?: string;
  canFollowAuthor: boolean;
  downloadStateForVideo: (videoId: string) => DownloadButtonState;
  favoriteActionId?: string;
  favoriteVideoIds: Set<string>;
  filters: VideoFilters;
  hasApi: boolean;
  loadingFeed: boolean;
  loadingVideoId?: string;
  onAddTag: (tag: string) => void;
  onBackToFeeds: () => void;
  onClearFilters: () => void;
  onDownload: (video: VideoSummary) => void;
  onToggleFavorite: (video: VideoSummary) => void;
  onFilterChange: (partial: Partial<VideoFilters>) => void;
  onFilterSubmit: () => void;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onQuickPlay: (video: VideoSummary) => void;
  onRefresh: () => void;
  onRemoveTag: (tag: string) => void;
  onFeedTabChange: (tab: FeedTabKey) => void;
  onTagInputChange: (value: string) => void;
  onToggleAuthorFollow: (author: ActiveAuthor, currentFollowing?: boolean) => void;
  quickPlayingId?: string;
  tagInput: string;
}) {
  const videos = activeFeed?.results ?? [];
  const hasFilters = Boolean(filters.query.trim() || filters.tags.length);
  const activeAuthorFollowing = activeAuthor
    ? activeAuthor.following ?? videos.find((video) => video.uploaderId === activeAuthor.id)?.uploaderFollowing
    : undefined;
  const authorFollowBusy = Boolean(activeAuthor && authorFollowBusyId === activeAuthor.id);

  return (
    <>
      <div className="section-header">
        <div>
          <p>{activeAuthor ? "作者主页" : "视频源"}</p>
          <h2>{activeAuthor ? (activeAuthor.name ?? activeAuthor.username ?? "作者视频") : feedTitle(activeFeedTab)}</h2>
          {activeAuthor?.username && <span className="section-subtitle">@{activeAuthor.username}</span>}
        </div>
        <div className="section-header-actions">
          {activeAuthor && (
            <button
              className={activeAuthorFollowing ? "secondary-button compact author-follow-button active" : "secondary-button compact author-follow-button"}
              disabled={!hasApi || !canFollowAuthor || authorFollowBusy}
              onClick={() => onToggleAuthorFollow(activeAuthor, activeAuthorFollowing)}
              title={canFollowAuthor ? undefined : "登录后关注作者"}
              type="button"
            >
              {authorFollowBusy ? <Loader2 className="spin" size={17} /> : activeAuthorFollowing ? <CheckCircle2 size={17} /> : <Heart size={17} />}
              {activeAuthorFollowing ? "已关注" : "关注"}
            </button>
          )}
          {activeAuthor && (
            <button className="secondary-button compact" onClick={onBackToFeeds} type="button">
              <ArrowLeft size={17} />
              返回
            </button>
          )}
          <button
            className="icon-text-button"
            disabled={!hasApi || loadingFeed}
            onClick={onRefresh}
            type="button"
          >
            {loadingFeed ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            刷新
          </button>
        </div>
      </div>

      {!activeAuthor && (
        <div className="feed-tabs" role="tablist">
          {feedTabs.map(({ key, label, Icon }) => (
            <button
              aria-selected={activeFeedTab === key}
              className={activeFeedTab === key ? "feed-tab active" : "feed-tab"}
              key={key}
              onClick={() => onFeedTabChange(key)}
              role="tab"
              type="button"
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
      )}

      <form
        className="filter-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onFilterSubmit();
        }}
      >
        <label className="filter-field search-filter">
          <Search size={17} />
          <input
            value={filters.query}
            onChange={(event) => onFilterChange({ query: event.target.value })}
            placeholder="搜索标题、作者或关键词"
          />
        </label>
        <label className="filter-field tag-filter">
          <Tag size={17} />
          <input
            value={tagInput}
            onChange={(event) => onTagInputChange(event.target.value)}
            placeholder="按标签筛选，例如 breeding"
          />
          <button
            className="secondary-button compact"
            disabled={!tagInput.trim()}
            onClick={() => onAddTag(tagInput)}
            type="button"
          >
            添加
          </button>
        </label>
        <button className="primary-button" disabled={!hasApi || loadingFeed} type="submit">
          搜索
        </button>
        <button className="secondary-button" disabled={!hasFilters || loadingFeed} onClick={onClearFilters} type="button">
          清除
        </button>
      </form>

      {filters.tags.length ? (
        <div className="active-filter-tags">
          {filters.tags.map((tag) => (
            <button key={tag} onClick={() => onRemoveTag(tag)} type="button">
              {tag}
              <X size={13} />
            </button>
          ))}
        </div>
      ) : null}

      <ListScanSummary result={activeFeed} />

      {loadingFeed && !videos.length ? (
        <SkeletonGrid />
      ) : videos.length ? (
        <>
          <div className="video-grid">
            {videos.map((video) => (
              <VideoCard
                downloadState={downloadStateForVideo(video.id)}
                favorite={favoriteVideoIds.has(video.id)}
                favoriteBusy={favoriteActionId === video.id}
                key={video.id}
                loading={loadingVideoId === video.id}
                onDownload={() => onDownload(video)}
                onToggleFavorite={() => onToggleFavorite(video)}
                onOpen={() => onOpen(video.id)}
                onQuickPlay={() => onQuickPlay(video)}
                quickPlaying={quickPlayingId === video.id}
                video={video}
              />
            ))}
          </div>

          <div className="pager">
            <button
              disabled={!hasApi || loadingFeed || (activeFeed?.page ?? 0) <= 0}
              onClick={() => onPage(Math.max((activeFeed?.page ?? 0) - 1, 0))}
              type="button"
            >
              上一页
            </button>
            <span>第 {(activeFeed?.page ?? 0) + 1} 页</span>
            <button
              disabled={!hasApi || loadingFeed}
              onClick={() => onPage((activeFeed?.page ?? 0) + 1)}
              type="button"
            >
              下一页
            </button>
          </div>
        </>
      ) : (
        <EmptyState
          Icon={Search}
          title="这里还没有视频"
          actionLabel="重新加载"
          disabled={!hasApi || loadingFeed}
          onAction={onRefresh}
        />
      )}
    </>
  );
}

function SubscriptionView({
  downloadStateForVideo,
  favoriteActionId,
  favoriteVideoIds,
  feed,
  hasApi,
  isLoggedIn,
  loading,
  loadingVideoId,
  onDownload,
  onToggleFavorite,
  onLogin,
  onOpen,
  onPage,
  onQuickPlay,
  onRefresh,
  quickPlayingId
}: {
  downloadStateForVideo: (videoId: string) => DownloadButtonState;
  favoriteActionId?: string;
  favoriteVideoIds: Set<string>;
  feed?: VideoListResult;
  hasApi: boolean;
  isLoggedIn: boolean;
  loading: boolean;
  loadingVideoId?: string;
  onDownload: (video: VideoSummary) => void;
  onToggleFavorite: (video: VideoSummary) => void;
  onLogin: () => void;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onQuickPlay: (video: VideoSummary) => void;
  onRefresh: () => void;
  quickPlayingId?: string;
}) {
  const videos = feed?.results ?? [];
  const authorOptions = useMemo(() => subscriptionAuthors(videos), [videos]);
  const [activeAuthorId, setActiveAuthorId] = useState("all");
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const activeAuthor = authorOptions.find((author) => author.id === activeAuthorId);
  const visibleVideos = activeAuthor
    ? videos.filter((video) => subscriptionAuthorId(video) === activeAuthor.id)
    : videos;

  useEffect(() => {
    if (activeAuthorId !== "all" && !authorOptions.some((author) => author.id === activeAuthorId)) {
      setActiveAuthorId("all");
    }
  }, [activeAuthorId, authorOptions]);

  return (
    <>
      <div className="section-header">
        <div>
          <p>订阅动态</p>
          <h2>订阅视频</h2>
        </div>
        <button
          className="icon-text-button"
          disabled={!hasApi || !isLoggedIn || loading}
          onClick={onRefresh}
          type="button"
        >
          {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          刷新
        </button>
      </div>

      {isLoggedIn && <ListScanSummary result={feed} />}

      {!isLoggedIn ? (
        <EmptyState
          Icon={LogIn}
          title="登录后查看订阅视频"
          actionLabel="打开 Iwara 验证窗口"
          disabled={!hasApi || loading}
          onAction={onLogin}
        />
      ) : loading && !videos.length ? (
        <SkeletonGrid />
      ) : videos.length ? (
        <>
          <div className={authorsExpanded ? "author-filter-bar expanded" : "author-filter-bar"} role="tablist">
            <button
              aria-selected={activeAuthorId === "all"}
              className={authorFilterButtonClass(activeAuthorId === "all", authorsExpanded)}
              disabled={loading}
              onClick={() => setActiveAuthorId("all")}
              role="tab"
              title="所有作者"
              type="button"
            >
              <AuthorAvatar label="所有作者" />
              {authorsExpanded && (
                <span className="author-filter-name">
                  所有作者
                </span>
              )}
            </button>
            {authorOptions.map((author) => (
              <button
                aria-selected={activeAuthorId === author.id}
                className={authorFilterButtonClass(activeAuthorId === author.id, authorsExpanded)}
                disabled={loading}
                key={author.id}
                onClick={() => setActiveAuthorId(author.id)}
                role="tab"
                title={author.label}
                type="button"
              >
                <AuthorAvatar label={author.label} url={author.avatarUrl} />
                {authorsExpanded && (
                  <span className="author-filter-name">
                    {author.label}
                  </span>
                )}
              </button>
            ))}
            <button
              aria-label={authorsExpanded ? "收起作者名称" : "展开作者名称"}
              className="author-filter-toggle"
              onClick={() => setAuthorsExpanded((current) => !current)}
              title={authorsExpanded ? "收起作者名称" : "展开作者名称"}
              type="button"
            >
              {authorsExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
          </div>

          <div className="list-scan-summary">
            {feed?.total ? <span>共 {compactNumber(feed.total)} 个订阅视频</span> : null}
            <span>每页 {feed?.limit ?? 24} 个</span>
            <span>{activeAuthor ? `当前页筛选：${visibleVideos.length} / ${videos.length}` : `当前页：${videos.length} 个`}</span>
          </div>
          {visibleVideos.length ? (
            <div className="video-grid">
              {visibleVideos.map((video) => (
                <VideoCard
                  downloadState={downloadStateForVideo(video.id)}
                  favorite={favoriteVideoIds.has(video.id)}
                  favoriteBusy={favoriteActionId === video.id}
                  key={video.id}
                  loading={loadingVideoId === video.id}
                  onDownload={() => onDownload(video)}
                  onToggleFavorite={() => onToggleFavorite(video)}
                  onOpen={() => onOpen(video.id)}
                  onQuickPlay={() => onQuickPlay(video)}
                  quickPlaying={quickPlayingId === video.id}
                  video={video}
                />
              ))}
            </div>
          ) : (
            <EmptyState Icon={UserRound} title="这个作者在当前页没有视频" />
          )}

          <div className="pager">
            <button
              disabled={!hasApi || loading || (feed?.page ?? 0) <= 0}
              onClick={() => onPage(Math.max((feed?.page ?? 0) - 1, 0))}
              type="button"
            >
              上一页
            </button>
            <span>第 {(feed?.page ?? 0) + 1} 页</span>
            <button
              disabled={!hasApi || loading}
              onClick={() => onPage((feed?.page ?? 0) + 1)}
              type="button"
            >
              下一页
            </button>
          </div>
        </>
      ) : (
        <EmptyState
          Icon={Bell}
          title="还没有订阅视频"
          actionLabel="重新加载"
          disabled={!hasApi || loading}
          onAction={onRefresh}
        />
      )}
    </>
  );
}

function AuthorAvatar({ label, url }: { label: string; url?: string }) {
  const [imageReady, setImageReady] = useState(Boolean(url));

  useEffect(() => {
    setImageReady(Boolean(url));
  }, [url]);

  return (
    <span className="author-avatar" aria-hidden="true">
      {url && imageReady ? (
        <img alt="" src={url} onError={() => setImageReady(false)} />
      ) : (
        <span>{authorInitial(label)}</span>
      )}
    </span>
  );
}

function authorFilterButtonClass(active: boolean, expanded: boolean): string {
  return [
    "author-filter-button",
    active ? "active" : "",
    expanded ? "expanded" : ""
  ].filter(Boolean).join(" ");
}

function ListScanSummary({ result }: { result?: VideoListResult }) {
  const attempts = result?.networkDiagnostics?.attempts ?? [];
  if (!result || (!result.scannedPages && !result.blockedCount && !result.partialFailures?.length && !attempts.length)) {
    return null;
  }

  return (
    <>
      <div className="list-scan-summary">
        {result.scannedPages ? <span>已扫描 {result.scannedPages} 页</span> : null}
        {result.blockedCount ? <span>已隐藏 {result.blockedCount} 个屏蔽标签视频</span> : null}
        {result.partialFailures?.length ? <span>{result.partialFailures.length} 个请求失败，已显示部分结果</span> : null}
      </div>
      {attempts.length ? <NetworkDiagnostics attempts={attempts} /> : null}
    </>
  );
}

function NetworkDiagnostics({ attempts }: { attempts: VideoListNetworkAttempt[] }) {
  const retryCount = attempts.filter((attempt) => attempt.attempt > 1).length;
  const failedCount = attempts.filter((attempt) => !attempt.ok).length;
  const totalElapsed = attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0);
  const lastAttempt = attempts.at(-1);
  const statusText = retryCount
    ? `已自动重试 ${retryCount} 次`
    : failedCount
      ? `${failedCount} 次失败`
      : "连接正常";

  return (
    <details className="network-diagnostics">
      <summary>
        {failedCount ? <AlertTriangle size={15} /> : <Gauge size={15} />}
        <span>网络诊断：{statusText}</span>
        <span>{totalElapsed} ms</span>
        {lastAttempt?.status ? <span>HTTP {lastAttempt.status}</span> : null}
      </summary>
      <div className="network-attempt-list">
        {attempts.map((attempt, index) => (
          <span className={attempt.ok ? "network-attempt ok" : "network-attempt failed"} key={`${attempt.endpoint}-${attempt.page}-${attempt.attempt}-${index}`}>
            {attempt.endpoint} 第 {attempt.page + 1} 页 / 第 {attempt.attempt} 次：
            {attempt.ok ? `HTTP ${attempt.status ?? "-"}，${attempt.resultCount ?? 0} 个，${attempt.elapsedMs} ms` : `${attempt.error ?? "请求失败"}，${attempt.elapsedMs} ms`}
          </span>
        ))}
      </div>
    </details>
  );
}

function DetailPanel({
  playing,
  selectedQuality,
  sortedFormats,
  diagnostics,
  diagnosing,
  downloadState,
  favorite,
  favoriteBusy,
  authorFollowBusy,
  canFollowAuthor,
  video,
  onDiagnose,
  onBlockTag,
  onClose,
  onCommentDraftChange,
  onFilterTag,
  onFollowTag,
  onOpenAuthor,
  onToggleAuthorFollow,
  onDownload,
  onToggleFavorite,
  onPlay,
  onQualityChange,
  onRefreshComments,
  onReplyDraftChange,
  onReplyToggle,
  onSubmitComment,
  commentDraft,
  comments,
  loadingComments,
  replyDrafts,
  replyingTo,
  submittingComment,
  tagPreferences
}: {
  playing: boolean;
  selectedQuality?: string;
  sortedFormats: VideoDetail["formats"];
  diagnostics?: IwaraVideoDiagnostics;
  diagnosing: boolean;
  downloadState: DownloadButtonState;
  favorite: boolean;
  favoriteBusy: boolean;
  authorFollowBusy: boolean;
  canFollowAuthor: boolean;
  video: VideoDetail;
  onDiagnose: () => void;
  onBlockTag: (tag: string) => void;
  onClose: () => void;
  onCommentDraftChange: (value: string) => void;
  onFilterTag: (tag: string) => void;
  onFollowTag: (tag: string) => void;
  onOpenAuthor: (video: VideoDetail) => void;
  onToggleAuthorFollow: (video: VideoDetail) => void;
  onDownload: () => void;
  onToggleFavorite: () => void;
  onPlay: (mode: PlayerMode) => void;
  onQualityChange: (quality: string) => void;
  onRefreshComments: () => void;
  onReplyDraftChange: (commentId: string, value: string) => void;
  onReplyToggle: (commentId: string) => void;
  onSubmitComment: (parentId?: string) => void;
  commentDraft: string;
  comments?: VideoCommentsResult;
  loadingComments: boolean;
  replyDrafts: Record<string, string>;
  replyingTo?: string;
  submittingComment: boolean;
  tagPreferences: AppSettings["tagPreferences"];
}) {
  const authorName = video.uploaderName ?? video.uploaderUsername ?? "Unknown";
  const displayedComments = comments?.comments ?? [];
  const followedTags = new Set(tagPreferences.followedTags);
  const blockedTags = new Set(tagPreferences.blockedTags);
  const authorFollowing = video.uploaderFollowing === true;

  return (
    <aside className="detail-panel">
      <div className="detail-art">
        <button aria-label="关闭视频预览" className="detail-close-button" onClick={onClose} type="button">
          <X size={18} />
        </button>
        {video.thumbnailUrl ? (
          <img alt={video.title} src={video.thumbnailUrl} />
        ) : (
          <div className="empty-art">NO IMAGE</div>
        )}
      </div>
      <div className="detail-body">
        <div className="detail-author-row">
          <div>
            <p className="eyebrow">作者</p>
            <strong>{authorName}</strong>
            {video.uploaderUsername && <span>@{video.uploaderUsername}</span>}
          </div>
          <div className="detail-author-actions">
            <button
              className={favorite ? "secondary-button compact favorite-button active" : "secondary-button compact favorite-button"}
              disabled={favoriteBusy}
              onClick={onToggleFavorite}
              type="button"
            >
              {favoriteBusy ? <Loader2 className="spin" size={17} /> : <Star size={17} />}
              {favorite ? "已收藏" : "收藏"}
            </button>
            <button
              className={authorFollowing ? "secondary-button compact author-follow-button active" : "secondary-button compact author-follow-button"}
              disabled={!video.uploaderId || !canFollowAuthor || authorFollowBusy}
              onClick={() => onToggleAuthorFollow(video)}
              title={canFollowAuthor ? undefined : "登录后关注作者"}
              type="button"
            >
              {authorFollowBusy ? <Loader2 className="spin" size={17} /> : authorFollowing ? <CheckCircle2 size={17} /> : <Heart size={17} />}
              {authorFollowing ? "已关注" : "关注"}
            </button>
            <button
              className="secondary-button compact"
              disabled={!video.uploaderId}
              onClick={() => onOpenAuthor(video)}
              type="button"
            >
              <UserRound size={17} />
              主页
            </button>
          </div>
        </div>
        <h2>{video.title}</h2>
        <div className="metric-row">
          <span>{compactNumber(video.numViews)} 观看</span>
          <span>{compactNumber(video.numLikes)} 喜欢</span>
          {video.durationSeconds ? <span>{formatDuration(video.durationSeconds)}</span> : null}
          <span>{formatDate(video.createdAt)}</span>
        </div>

        <div className="detail-section">
          <strong>简介</strong>
          <p className="detail-description">{video.description ?? "没有简介。"}</p>
        </div>

        <div className="detail-section">
          <strong>
            <Tag size={15} />
            标签
          </strong>
          {video.tags.length ? (
            <div className="tag-list">
              {video.tags.map((tag) => (
                <span className="tag-action-group" key={tag}>
                  <button onClick={() => onFilterTag(tag)} type="button">
                    {tag}
                  </button>
                  <button
                    aria-label={`关注 ${tag}`}
                    className={followedTags.has(normalizeTagLabel(tag)) ? "tag-mini-button active" : "tag-mini-button"}
                    disabled={blockedTags.has(normalizeTagLabel(tag))}
                    onClick={() => onFollowTag(tag)}
                    type="button"
                  >
                    <Star size={12} />
                  </button>
                  <button
                    aria-label={`屏蔽 ${tag}`}
                    className={blockedTags.has(normalizeTagLabel(tag)) ? "tag-mini-button danger active" : "tag-mini-button danger"}
                    onClick={() => onBlockTag(tag)}
                    type="button"
                  >
                    <Ban size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="subtle">没有标签。</p>
          )}
        </div>

        {sortedFormats.length ? (
          <div className="quality-panel">
            <label className="field-label">
              清晰度
              <select value={selectedQuality ?? ""} onChange={(event) => onQualityChange(event.target.value)}>
                {sortedFormats.map((format) => (
                  <option key={format.id} value={format.id}>
                    {format.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="inline-warning">没有可用直链清晰度。</div>
        )}

        <div className="play-row">
          <button className="primary-button" disabled={playing || !sortedFormats.length} onClick={() => onPlay("mpv")} type="button">
            {playing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            MPV
          </button>
          <button className="secondary-button" disabled={playing || !sortedFormats.length} onClick={() => onPlay("external")} type="button">
            <ExternalLink size={18} />
            外部
          </button>
          <button className="secondary-button" disabled={downloadState !== "idle" || !sortedFormats.length} onClick={onDownload} type="button">
            <DownloadButtonContent state={downloadState} size={18} />
          </button>
        </div>

        <button className="secondary-button" disabled={diagnosing} onClick={onDiagnose} type="button">
          {diagnosing ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
          抓包诊断
        </button>

        {diagnostics && <VideoDiagnosticsPanel diagnostics={diagnostics} />}

        <div className="detail-section">
          <strong>
            <MessageCircle size={15} />
            评论 {compactNumber(comments?.total ?? video.numComments)}
          </strong>
          <CommentComposer
            disabled={submittingComment}
            onChange={onCommentDraftChange}
            onSubmit={() => onSubmitComment()}
            placeholder="写一条评论"
            value={commentDraft}
          />
          <button className="secondary-button compact" disabled={loadingComments} onClick={onRefreshComments} type="button">
            {loadingComments ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            刷新评论
          </button>
          {loadingComments && !displayedComments.length ? (
            <div className="inline-warning">正在加载完整评论区。</div>
          ) : displayedComments.length ? (
            <CommentList
              comments={displayedComments}
              loading={submittingComment}
              onDraftChange={onReplyDraftChange}
              onReplyToggle={onReplyToggle}
              onSubmit={onSubmitComment}
              replyDrafts={replyDrafts}
              replyingTo={replyingTo}
            />
          ) : (
            <p className="subtle">还没有评论。</p>
          )}
        </div>
      </div>
    </aside>
  );
}

function CommentComposer({
  disabled,
  onChange,
  onSubmit,
  placeholder,
  value
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  value: string;
}) {
  return (
    <div className="comment-composer">
      <textarea
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        value={value}
      />
      <button className="primary-button" disabled={disabled || !value.trim()} onClick={onSubmit} type="button">
        {disabled ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
        发送
      </button>
    </div>
  );
}

function CommentList({
  comments,
  loading,
  onDraftChange,
  onReplyToggle,
  onSubmit,
  replyDrafts,
  replyingTo,
  depth = 0
}: {
  comments: VideoComment[];
  loading: boolean;
  onDraftChange: (commentId: string, value: string) => void;
  onReplyToggle: (commentId: string) => void;
  onSubmit: (parentId?: string) => void;
  replyDrafts: Record<string, string>;
  replyingTo?: string;
  depth?: number;
}) {
  return (
    <div className={depth ? "comment-list replies" : "comment-list"}>
      {comments.map((comment) => (
        <article className="comment-item" key={comment.id}>
          <div className="comment-meta">
            <strong>{comment.authorName ?? comment.authorUsername ?? "Unknown"}</strong>
            <span>{formatDate(comment.createdAt)}</span>
          </div>
          <p>{comment.body}</p>
          <div className="comment-actions">
            <small>
              {compactNumber(comment.numLikes)} 喜欢
              {comment.numReplies ? ` · ${compactNumber(comment.numReplies)} 回复` : ""}
            </small>
            <button className="comment-reply-button" onClick={() => onReplyToggle(comment.id)} type="button">
              <CornerDownRight size={14} />
              回复
            </button>
          </div>
          {replyingTo === comment.id && (
            <CommentComposer
              disabled={loading}
              onChange={(value) => onDraftChange(comment.id, value)}
              onSubmit={() => onSubmit(comment.id)}
              placeholder={`回复 ${comment.authorName ?? comment.authorUsername ?? "评论"}`}
              value={replyDrafts[comment.id] ?? ""}
            />
          )}
          {comment.replies.length ? (
            <CommentList
              comments={comment.replies}
              depth={depth + 1}
              loading={loading}
              onDraftChange={onDraftChange}
              onReplyToggle={onReplyToggle}
              onSubmit={onSubmit}
              replyDrafts={replyDrafts}
              replyingTo={replyingTo}
            />
          ) : null}
        </article>
      ))}
    </div>
  );
}

function VideoDiagnosticsPanel({ diagnostics }: { diagnostics: IwaraVideoDiagnostics }) {
  const networkFormats = diagnostics.network?.entries.filter((entry) => entry.formatLabels.length) ?? [];

  return (
    <div className="diagnostics-panel">
      <strong>API 对比</strong>
      <div className="diagnostics-list">
        <span>应用解析：{formatLabelsText(diagnostics.appFormatLabels)}</span>
        {diagnostics.probes.map((probe) => (
          <span key={probe.label}>
            {probe.label}：{probe.ok ? `${probe.status ?? "-"} · ${formatLabelsText(probe.formatLabels)}` : probe.error}
          </span>
        ))}
        {networkFormats.length ? (
          networkFormats.map((entry) => (
            <span key={`${entry.method}-${entry.url}-${entry.status}`}>
              网页抓包：{entry.status ?? "-"} · {entry.xVersion ? `X ${entry.xVersion.slice(0, 8)}` : "X -"} · {entry.hasAuthorization ? "Bearer" : "无授权"} · {entry.responseShape ?? entry.resourceType ?? "response"} · {formatLabelsText(entry.formatLabels)}
            </span>
          ))
        ) : (
          <span>
            网页抓包：{diagnostics.network?.timedOut ? "未在 18 秒内捕获文件列表。" : "未捕获到文件列表响应。"}
          </span>
        )}
      </div>
    </div>
  );
}

function SpeedReportPanel({ report }: { report: MediaSpeedTestReport }) {
  const sorted = report.results
    .slice()
    .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0));

  return (
    <div className="speed-report-panel">
      <strong>
        <Link2 size={15} />
        {report.fastestHost ? `最快线路：${report.fastestHost}` : "没有可用线路"}
      </strong>
      <div className="speed-report-list">
        <span>样本：{report.sampleFormatLabel ?? "未知清晰度"} · {report.sampleHost ?? "未知来源"}</span>
        {sorted.map((result) => (
          <span key={result.host}>
            {result.host}：{result.ok ? formatSpeed(result.bytesPerSecond) : result.error ?? "不可用"}
          </span>
        ))}
      </div>
    </div>
  );
}

function DownloadButtonContent({ state, size }: { state: DownloadButtonState; size: number }) {
  if (state === "downloading") {
    return (
      <>
        <Loader2 className="spin" size={size} />
        下载中
      </>
    );
  }

  if (state === "completed") {
    return (
      <>
        <CheckCircle2 size={size} />
        已完成
      </>
    );
  }

  return (
    <>
      <Download size={size} />
      下载
    </>
  );
}

function VideoCard({
  video,
  downloadState,
  favorite,
  favoriteBusy,
  loading,
  quickPlaying,
  onDownload,
  onToggleFavorite,
  onOpen,
  onQuickPlay
}: {
  video: VideoSummary;
  downloadState: DownloadButtonState;
  favorite: boolean;
  favoriteBusy: boolean;
  loading: boolean;
  quickPlaying: boolean;
  onDownload: () => void;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onQuickPlay: () => void;
}) {
  return (
    <article className="video-card">
      <button className="thumb-button" onClick={onOpen} type="button">
        <div className="thumb">
          {video.thumbnailUrl ? <img alt={video.title} src={video.thumbnailUrl} /> : <div className="empty-art">NO IMAGE</div>}
          {video.durationSeconds ? <span className="duration-badge">{formatDuration(video.durationSeconds)}</span> : null}
          {loading && <Loader2 className="card-loader spin" size={24} />}
        </div>
      </button>
      <div className="video-copy">
        <button className="video-title-button" onClick={onOpen} type="button">
          {video.title}
        </button>
        <p>{video.uploaderName ?? video.uploaderUsername ?? "Unknown"}</p>
        <div className="video-card-footer">
          <span>{compactNumber(video.numViews)} 观看</span>
          <span>{compactNumber(video.numLikes)} 喜欢</span>
          {video.durationSeconds ? <span>{formatDuration(video.durationSeconds)}</span> : null}
          <button
            aria-label={favorite ? "取消收藏" : "收藏"}
            className={favorite ? "quick-play-button favorite-button active" : "quick-play-button favorite-button"}
            disabled={favoriteBusy}
            onClick={onToggleFavorite}
            title={favorite ? "取消收藏" : "收藏"}
            type="button"
          >
            {favoriteBusy ? <Loader2 className="spin" size={16} /> : <Star size={16} />}
          </button>
          <button className="quick-play-button" disabled={downloadState !== "idle"} onClick={onDownload} type="button">
            <DownloadButtonContent state={downloadState} size={16} />
          </button>
          <button className="quick-play-button" onClick={onQuickPlay} type="button">
            {quickPlaying ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            播放
          </button>
        </div>
      </div>
    </article>
  );
}

function FavoritesView({
  downloadStateForVideo,
  favoriteActionId,
  favoriteFileBusy,
  favorites,
  hasApi,
  loadingVideoId,
  onBackup,
  onDownload,
  onExport,
  onImport,
  onOpen,
  onQuickPlay,
  onRefresh,
  onToggleFavorite,
  quickPlayingId
}: {
  downloadStateForVideo: (videoId: string) => DownloadButtonState;
  favoriteActionId?: string;
  favoriteFileBusy: boolean;
  favorites: FavoriteState;
  hasApi: boolean;
  loadingVideoId?: string;
  onBackup: () => void;
  onDownload: (video: VideoSummary) => void;
  onExport: () => void;
  onImport: () => void;
  onOpen: (id: string) => void;
  onQuickPlay: (video: VideoSummary) => void;
  onRefresh: () => void;
  onToggleFavorite: (video: VideoSummary) => void;
  quickPlayingId?: string;
}) {
  const items = favorites.items;

  return (
    <>
      <div className="section-header">
        <div>
          <p>本地收藏</p>
          <h2>收藏</h2>
        </div>
        <div className="section-header-actions">
          <button className="secondary-button compact" disabled={!hasApi || favoriteFileBusy} onClick={onBackup} type="button">
            {favoriteFileBusy ? <Loader2 className="spin" size={17} /> : <Shield size={17} />}
            备份
          </button>
          <button className="secondary-button compact" disabled={!hasApi || favoriteFileBusy} onClick={onExport} type="button">
            <Download size={17} />
            导出
          </button>
          <button className="secondary-button compact" disabled={!hasApi || favoriteFileBusy} onClick={onImport} type="button">
            <FolderOpen size={17} />
            导入
          </button>
          <button className="icon-text-button" disabled={!hasApi || favoriteFileBusy} onClick={onRefresh} type="button">
            <RefreshCw size={18} />
            刷新
          </button>
        </div>
      </div>

      {items.length ? (
        <>
          <div className="list-scan-summary">
            <span>{items.length} 条收藏</span>
            <span>最近收藏：{formatDate(items[0]?.favoritedAt)}</span>
          </div>
          <div className="video-grid">
            {items.map((item) => (
              <VideoCard
                downloadState={downloadStateForVideo(item.video.id)}
                favorite
                favoriteBusy={favoriteActionId === item.video.id}
                key={`${item.video.id}-${item.favoritedAt}`}
                loading={loadingVideoId === item.video.id}
                onDownload={() => onDownload(item.video)}
                onToggleFavorite={() => onToggleFavorite(item.video)}
                onOpen={() => onOpen(item.video.id)}
                onQuickPlay={() => onQuickPlay(item.video)}
                quickPlaying={quickPlayingId === item.video.id}
                video={item.video}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          Icon={Star}
          title="还没有本地收藏"
          actionLabel="导入收藏"
          disabled={!hasApi || favoriteFileBusy}
          onAction={onImport}
        />
      )}
    </>
  );
}

function HistoryView({
  history,
  loadingVideoId,
  onClear,
  onOpen
}: {
  history: AppSettings["history"];
  loadingVideoId?: string;
  onClear: () => void;
  onOpen: (video: VideoSummary) => void;
}) {
  return (
    <>
      <div className="section-header">
        <div>
          <p>播放记录</p>
          <h2>历史</h2>
        </div>
        <button className="icon-text-button" disabled={!history.length} onClick={onClear} type="button">
          <Trash2 size={18} />
          清空
        </button>
      </div>
      {history.length ? (
        <div className="history-list">
          {history.map((item) => {
            const loading = loadingVideoId === item.video.id;

            return (
              <button
                className={loading ? "history-item loading" : "history-item"}
                disabled={Boolean(loadingVideoId)}
                key={`${item.video.id}-${item.playedAt}`}
                onClick={() => onOpen(item.video)}
                type="button"
              >
                <span className="history-item-copy">
                  <span>{item.video.title}</span>
                  <small>{item.mode.toUpperCase()} · {item.formatId} · {formatDate(item.playedAt)}</small>
                </span>
                {loading && (
                  <span className="history-item-loader">
                    <Loader2 className="spin" size={17} />
                    打开中
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState Icon={History} title="还没有播放历史" />
      )}
    </>
  );
}

function DownloadsView({
  actionId,
  downloads,
  hasApi,
  onDelete,
  onOpenFile,
  onOpenFolder,
  onOpenVideo,
  onRefresh,
  onRetry
}: {
  actionId?: string;
  downloads: DownloadState;
  hasApi: boolean;
  onDelete: (id: string) => void;
  onOpenFile: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onOpenVideo: (videoId: string, title?: string) => void;
  onRefresh: () => void;
  onRetry: (id: string) => void;
}) {
  const active = downloads.active;
  const history = downloads.history;

  return (
    <>
      <div className="section-header">
        <div>
          <p>下载管理</p>
          <h2>下载</h2>
        </div>
        <button className="icon-text-button" disabled={!hasApi} onClick={onRefresh} type="button">
          <RefreshCw size={18} />
          刷新
        </button>
      </div>

      <div className="downloads-grid">
        <section className="downloads-section">
          <div className="downloads-section-heading">
            <h3>当前任务</h3>
            <span>{active.length} 个</span>
          </div>
          {active.length ? (
            <div className="download-list">
              {active.map((task) => (
                <DownloadTaskItem
                  actionId={actionId}
                  key={task.id}
                  task={task}
                  onDelete={onDelete}
                  onOpenFile={onOpenFile}
                  onOpenFolder={onOpenFolder}
                  onOpenVideo={onOpenVideo}
                  onRetry={onRetry}
                />
              ))}
            </div>
          ) : (
            <EmptyState Icon={Download} title="没有正在下载的任务" />
          )}
        </section>

        <section className="downloads-section">
          <div className="downloads-section-heading">
            <h3>下载历史</h3>
            <span>{history.length} 条</span>
          </div>
          {history.length ? (
            <div className="download-list">
              {history.map((task) => (
                <DownloadTaskItem
                  actionId={actionId}
                  key={task.id}
                  task={task}
                  onDelete={onDelete}
                  onOpenFile={onOpenFile}
                  onOpenFolder={onOpenFolder}
                  onOpenVideo={onOpenVideo}
                  onRetry={onRetry}
                />
              ))}
            </div>
          ) : (
            <EmptyState Icon={History} title="还没有下载历史" />
          )}
        </section>
      </div>
    </>
  );
}

function DownloadTaskItem({
  actionId,
  task,
  onDelete,
  onOpenFile,
  onOpenFolder,
  onOpenVideo,
  onRetry
}: {
  actionId?: string;
  task: DownloadTask;
  onDelete: (id: string) => void;
  onOpenFile: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onOpenVideo: (videoId: string, title?: string) => void;
  onRetry: (id: string) => void;
}) {
  const progress = downloadProgressPercent(task);
  const busy = actionId === task.id;
  const isActive = task.status === "queued" || task.status === "downloading";
  const canOpenFile = task.status === "completed" && Boolean(task.path);
  const canOpenFolder = Boolean(task.path);
  const canRetry = !isActive;
  const canDelete = !isActive;

  return (
    <article className={`download-item ${task.status}`}>
      {task.video?.thumbnailUrl ? (
        <button className="download-thumb" onClick={() => onOpenVideo(task.videoId, task.video?.title)} type="button">
          <img alt={downloadTaskTitle(task)} src={task.video.thumbnailUrl} />
        </button>
      ) : (
        <button className="download-thumb empty" onClick={() => onOpenVideo(task.videoId, task.video?.title)} type="button">
          <Download size={22} />
        </button>
      )}
      <div className="download-main">
        <button className="download-title" onClick={() => onOpenVideo(task.videoId, task.video?.title)} type="button">
          {downloadTaskTitle(task)}
        </button>
        <div className="download-meta">
          <span>{downloadStatusLabel(task.status)}</span>
          {task.format?.label ? <span>{task.format.label}</span> : task.requestedQuality ? <span>{task.requestedQuality}</span> : null}
          <span>{formatBytes(task.bytesWritten)}{task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ""}</span>
          <span>{formatFullDate(task.updatedAt)}</span>
        </div>
        {progress !== undefined && (
          <div className="download-progress" aria-label={`下载进度 ${Math.round(progress)}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
        {task.path && <code className="download-path">{task.path}</code>}
        {task.error && <div className="download-error">{task.error}</div>}
      </div>
      <div className="download-actions">
        <button className="secondary-button compact" disabled={!canOpenFile || busy} onClick={() => onOpenFile(task.id)} type="button">
          {busy && canOpenFile ? <Loader2 className="spin" size={16} /> : <ExternalLink size={16} />}
          打开
        </button>
        <button className="secondary-button compact" disabled={!canOpenFolder || busy} onClick={() => onOpenFolder(task.id)} type="button">
          <FolderOpen size={16} />
          文件夹
        </button>
        <button className="secondary-button compact" disabled={!canRetry || busy} onClick={() => onRetry(task.id)} type="button">
          {busy && canRetry ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          重试
        </button>
        <button className="secondary-button compact danger-button" disabled={!canDelete || busy} onClick={() => onDelete(task.id)} type="button">
          <Trash2 size={16} />
          删除
        </button>
      </div>
    </article>
  );
}

function SettingsView({
  auth,
  diagnostics,
  download,
  hasApi,
  mpvTest,
  onChooseDownloadDirectory,
  onChooseExternal,
  onChooseMpv,
  onOpenIwaraSession,
  onProbe,
  onRefreshAuth,
  onExportMediaHosts,
  onSniffXVersionSalt,
  onSpeedTest,
  onTestMpv,
  onUpdateDownload,
  onUpdateIwara,
  onUpdateMediaSpeed,
  onUpdatePlayer,
  onUpdateTagPreferences,
  iwara,
  saltReport,
  saltSniffing,
  player,
  probing,
  selectedVideo,
  sessionBusy,
  speedReport,
  speedSettings,
  speedTesting,
  tagPreferences
}: {
  auth: AuthState;
  diagnostics?: PlayerDiagnostics;
  download: AppSettings["download"];
  hasApi: boolean;
  mpvTest?: PlayerProbe;
  onChooseDownloadDirectory: () => void;
  onChooseExternal: () => void;
  onChooseMpv: () => void;
  onOpenIwaraSession: () => void;
  onProbe: () => void;
  onRefreshAuth: () => void;
  onExportMediaHosts: () => void;
  onSniffXVersionSalt: () => void;
  onSpeedTest: () => void;
  onTestMpv: () => void;
  onUpdateDownload: (partial: Partial<AppSettings["download"]>) => void;
  onUpdateIwara: (partial: Partial<AppSettings["iwara"]>) => void;
  onUpdateMediaSpeed: (partial: Partial<AppSettings["mediaSpeed"]>) => void;
  onUpdatePlayer: (partial: Partial<AppSettings["player"]>) => void;
  onUpdateTagPreferences: (partial: Partial<AppSettings["tagPreferences"]>) => void;
  iwara: AppSettings["iwara"];
  saltReport?: XVersionSaltReport;
  saltSniffing: boolean;
  player: AppSettings["player"];
  probing: boolean;
  selectedVideo?: VideoDetail;
  sessionBusy: boolean;
  speedReport?: MediaSpeedTestReport;
  speedSettings: AppSettings["mediaSpeed"];
  speedTesting: boolean;
  tagPreferences: AppSettings["tagPreferences"];
}) {
  return (
    <>
      <div className="section-header">
        <div>
          <p>本地播放</p>
          <h2>设置</h2>
        </div>
        <button className="icon-text-button" disabled={!hasApi || probing} onClick={onProbe} type="button">
          {probing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          检测
        </button>
      </div>

      <div className="settings-grid">
        <section className="settings-block">
          <h3>Iwara 会话</h3>
          <div className={auth.siteTokenReady ? "probe-line ok" : "probe-line bad"}>
            {auth.siteTokenReady ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <span>
              {auth.siteTokenReady
                ? `已检测到网页登录 token（${auth.siteTokenKey ?? "storage"}）。`
                : auth.siteSessionReady
                  ? `只有 Iwara cookie（${auth.siteCookieCount ?? 0} 个），还没有网页登录 token。`
                  : "尚未完成应用内 Iwara 验证。"}
            </span>
          </div>
          <div className="settings-actions">
            <button className="primary-button" disabled={!hasApi || sessionBusy} onClick={onOpenIwaraSession} type="button">
              {sessionBusy ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
              打开 Iwara 验证窗口
            </button>
            <button className="secondary-button" disabled={!hasApi || sessionBusy} onClick={onRefreshAuth} type="button">
              <RefreshCw size={18} />
              刷新会话
            </button>
          </div>
          <p className="subtle">
            在弹出的应用内窗口完成 Cloudflare 验证并登录；检测到网页登录 token 后窗口会自动关闭，应用请求会复用抓取到的 token 和 cookie。
          </p>
          {auth.warning && <p className="subtle">{auth.warning}</p>}
        </section>

        <section className="settings-block compact-block">
          <h3>播放偏好</h3>
          <label className="field-label">
            默认播放器
            <select
              value={player.preferredMode}
              onChange={(event) => onUpdatePlayer({ preferredMode: event.target.value as PlayerMode })}
            >
              <option value="mpv">内置 MPV</option>
              <option value="external">外部播放器</option>
            </select>
          </label>
        </section>

        <section className="settings-block">
          <h3>下载偏好</h3>
          <label className="field-label">
            默认清晰度
            <select
              value={download.defaultQuality ?? ""}
              onChange={(event) => onUpdateDownload({ defaultQuality: event.target.value || undefined })}
            >
              <option value="">最高可用</option>
              {qualityOptions.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            保存路径
            <div className="path-row">
              <input
                value={download.directory ?? ""}
                onChange={(event) => onUpdateDownload({ directory: event.target.value || undefined })}
                placeholder="选择视频下载保存文件夹"
              />
              <button className="secondary-button compact" disabled={!hasApi} onClick={onChooseDownloadDirectory} type="button">
                <FolderOpen size={17} />
                选择
              </button>
            </div>
          </label>
          <div className="speed-options">
            <label className="field-label">
              分片连接
              <select
                value={download.maxConnections}
                onChange={(event) => onUpdateDownload({ maxConnections: Number(event.target.value) })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={4}>4</option>
                <option value={6}>6</option>
                <option value={8}>8</option>
              </select>
            </label>
            <label className="field-label">
              分片阈值
              <select
                value={download.minSplitBytes}
                onChange={(event) => onUpdateDownload({ minSplitBytes: Number(event.target.value) })}
              >
                <option value={1048576}>1 MB</option>
                <option value={8388608}>8 MB</option>
                <option value={16777216}>16 MB</option>
                <option value={33554432}>32 MB</option>
                <option value={67108864}>64 MB</option>
              </select>
            </label>
          </div>
          <p className="subtle">
            详情页下载会使用当前选择的清晰度；视频卡片会使用默认清晰度。支持断点续传，文件足够大且服务端支持 Range 时会启用分片下载。
          </p>
        </section>

        <section className="settings-block">
          <h3>Iwara 解析</h3>
          <label className="toggle-row">
            <input
              checked={iwara.autoSniffXVersionSalt}
              onChange={(event) => onUpdateIwara({ autoSniffXVersionSalt: event.target.checked })}
              type="checkbox"
            />
            <span>打开视频前自动嗅探 X-Version 盐值</span>
          </label>
          <label className="field-label">
            X-Version 盐值
            <input
              value={iwara.xVersionSalt}
              onChange={(event) => onUpdateIwara({ xVersionSalt: event.target.value.trim() })}
              placeholder="从 Iwara 前端脚本自动嗅探"
            />
          </label>
          <div className="settings-actions">
            <button className="secondary-button" disabled={!hasApi || saltSniffing} onClick={onSniffXVersionSalt} type="button">
              {saltSniffing ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
              嗅探盐值
            </button>
          </div>
          <div className="probe-line ok">
            <CheckCircle2 size={17} />
            <span>
              当前盐值：{iwara.xVersionSalt}
              {iwara.lastSaltSniffAt ? ` · ${formatFullDate(iwara.lastSaltSniffAt)}` : ""}
            </span>
          </div>
          {saltReport && (
            <code className="args-preview">
              {saltReport.sourceUrl}
            </code>
          )}
          <p className="subtle">
            应用会从 Iwara 网页前端脚本里识别生成 X-Version 的盐值；站点更新后可手动刷新。
          </p>
        </section>

        <section className="settings-block">
          <h3>Iwara 视频线路</h3>
          <label className="toggle-row">
            <input
              checked={speedSettings.autoTest}
              onChange={(event) => onUpdateMediaSpeed({ autoTest: event.target.checked })}
              type="checkbox"
            />
            <span>域名池未测速时自动测速一次</span>
          </label>
          <label className="toggle-row">
            <input
              checked={speedSettings.replaceLinks}
              onChange={(event) => onUpdateMediaSpeed({ replaceLinks: event.target.checked })}
              type="checkbox"
            />
            <span>播放时替换为测速最快 CDN 域名</span>
          </label>
          <label className="field-label">
            域名池
            <textarea
              rows={5}
              value={speedSettings.candidateHosts.join("\n")}
              onChange={(event) => onUpdateMediaSpeed({ candidateHosts: event.target.value.split(/[\s,;]+/).filter(Boolean) })}
              placeholder="自动发现，也可粘贴：jade.iwara.tv&#10;kafka.iwara.tv"
            />
          </label>
          {speedSettings.rankedHosts.length ? (
            <div className="probe-line ok">
              <Gauge size={17} />
              <span>
                当前排序：{speedSettings.rankedHosts.join(" / ")}
                {speedSettings.lastTestedAt ? ` · ${formatFullDate(speedSettings.lastTestedAt)}` : ""}
              </span>
            </div>
          ) : (
            <div className="probe-line bad">
              <AlertTriangle size={17} />
              <span>域名池还没有测速排序，需先打开一个视频作为测速样本。</span>
            </div>
          )}
          <div className="speed-options">
            <label className="field-label">
              读取量
              <select
                value={speedSettings.testBytes}
                onChange={(event) => onUpdateMediaSpeed({ testBytes: Number(event.target.value) })}
              >
                <option value={262144}>256 KB</option>
                <option value={524288}>512 KB</option>
                <option value={1048576}>1 MB</option>
              </select>
            </label>
            <label className="field-label">
              超时
              <select
                value={speedSettings.timeoutMs}
                onChange={(event) => onUpdateMediaSpeed({ timeoutMs: Number(event.target.value) })}
              >
                <option value={3000}>3 秒</option>
                <option value={4500}>4.5 秒</option>
                <option value={7000}>7 秒</option>
              </select>
            </label>
          </div>
          <button className="secondary-button" disabled={!hasApi || !selectedVideo || speedTesting} onClick={onSpeedTest} type="button">
            {speedTesting ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
            用当前视频全局测速
          </button>
          <button className="secondary-button" disabled={!hasApi || !speedSettings.candidateHosts.length} onClick={onExportMediaHosts} type="button">
            <ClipboardCopy size={18} />
            导出域名池
          </button>
          <p className="subtle">
            当前视频、网页抓包和测速结果里发现的新媒体域名会自动加入这里。替换功能只改最终播放直链的域名；如遇到 403 或播放失败，关闭替换即可回到原始链接。
          </p>
          {speedReport && <SpeedReportPanel report={speedReport} />}
        </section>

        <section className="settings-block">
          <h3>标签偏好</h3>
          <label className="field-label">
            关注标签
            <textarea
              rows={4}
              value={tagPreferences.followedTags.join("\n")}
              onChange={(event) => onUpdateTagPreferences({ followedTags: event.target.value.split(/[\s,;，；]+/).filter(Boolean) })}
              placeholder="每行一个标签，例如 breeding"
            />
          </label>
          <label className="field-label">
            屏蔽标签
            <textarea
              rows={4}
              value={tagPreferences.blockedTags.join("\n")}
              onChange={(event) => onUpdateTagPreferences({ blockedTags: event.target.value.split(/[\s,;，；]+/).filter(Boolean) })}
              placeholder="命中这些标签的视频会被隐藏"
            />
          </label>
          <div className="speed-options">
            <label className="field-label">
              扫描页数
              <select
                value={tagPreferences.maxScanPages}
                onChange={(event) => onUpdateTagPreferences({ maxScanPages: Number(event.target.value) })}
              >
                <option value={3}>3 页</option>
                <option value={5}>5 页</option>
                <option value={8}>8 页</option>
                <option value={10}>10 页</option>
              </select>
            </label>
            <label className="field-label">
              请求间隔
              <select
                value={tagPreferences.requestDelayMs}
                onChange={(event) => onUpdateTagPreferences({ requestDelayMs: Number(event.target.value) })}
              >
                <option value={0}>不等待</option>
                <option value={250}>250 ms</option>
                <option value={500}>500 ms</option>
                <option value={1000}>1 秒</option>
              </select>
            </label>
          </div>
          <div className="probe-line ok">
            <Shield size={17} />
            <span>屏蔽标签优先于关注标签。保存时若同一标签同时出现，会保留在屏蔽列表并从关注列表移除。</span>
          </div>
        </section>

        <section className="settings-block">
          <h3>内置 MPV</h3>
          <label className="field-label">
            MPV 路径
            <div className="path-row">
              <input
                value={player.mpvPath ?? ""}
                onChange={(event) => onUpdatePlayer({ mpvPath: event.target.value || undefined })}
                placeholder="自动使用打包内置 MPV，也可手动指定 mpv.exe"
              />
              <button className="secondary-button compact" disabled={!hasApi} onClick={onChooseMpv} type="button">
                <FolderOpen size={17} />
                选择
              </button>
            </div>
          </label>
          <ProbeLine probe={diagnostics?.mpv} />
          {mpvTest && <ProbeLine probe={mpvTest} />}
          <button className="secondary-button" disabled={!hasApi || probing} onClick={onTestMpv} type="button">
            <MonitorPlay size={18} />
            测试 MPV
          </button>
        </section>

        <section className="settings-block">
          <h3>外部播放器</h3>
          <label className="field-label">
            播放器路径
            <div className="path-row">
              <input
                value={player.externalPlayerPath ?? ""}
                onChange={(event) => onUpdatePlayer({ externalPlayerPath: event.target.value || undefined })}
                placeholder="例如 PotPlayerMini64.exe"
              />
              <button className="secondary-button compact" disabled={!hasApi} onClick={onChooseExternal} type="button">
                <FolderOpen size={17} />
                选择
              </button>
            </div>
          </label>
          <label className="field-label">
            启动参数
            <input
              value={player.externalPlayerArgs}
              onChange={(event) => onUpdatePlayer({ externalPlayerArgs: event.target.value })}
            />
          </label>
          <ProbeLine probe={diagnostics?.external} />
          {diagnostics?.externalArgsPreview.length ? (
            <code className="args-preview">{diagnostics.externalArgsPreview.join(" ")}</code>
          ) : null}
        </section>
      </div>
    </>
  );
}

function FeedbackToastLayer({
  issue,
  status,
  onIssueAction,
  onDismissIssue,
  onDismissStatus
}: {
  issue?: UiIssue;
  status: string;
  onIssueAction: (issue: UiIssue) => void;
  onDismissIssue: () => void;
  onDismissStatus: () => void;
}) {
  if (!issue && !status) {
    return null;
  }

  const toastTimingStyle = {
    "--toast-duration": `${TOAST_AUTO_DISMISS_MS}ms`
  } as CSSProperties;
  const issueToastKey = issue ? `${issue.title}-${issue.detail}-${issue.actionLabel}` : undefined;

  return (
    <div aria-atomic="true" aria-live="polite" className="toast-region">
      {issue && (
        <div className="toast-card danger" key={issueToastKey} role="alert" style={toastTimingStyle}>
          <ToastProgress />
          <AlertTriangle className="toast-icon" size={20} />
          <div className="toast-copy">
            <strong>{issue.title}</strong>
            <span>{issue.detail}</span>
          </div>
          <button
            className="secondary-button compact"
            onClick={() => onIssueAction(issue)}
            type="button"
          >
            {issue.actionLabel}
          </button>
          <button aria-label="关闭提示" className="toast-close-button" onClick={onDismissIssue} type="button">
            <X size={16} />
          </button>
        </div>
      )}
      {status && (
        <div className="toast-card success" key={status} role="status" style={toastTimingStyle}>
          <ToastProgress />
          <CheckCircle2 className="toast-icon" size={20} />
          <div className="toast-copy">
            <span>{status}</span>
          </div>
          <button aria-label="关闭提示" className="toast-close-button" onClick={onDismissStatus} type="button">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function ToastProgress() {
  return (
    <span aria-hidden="true" className="toast-progress">
      <span className="toast-progress-segment top" />
      <span className="toast-progress-segment right" />
      <span className="toast-progress-segment bottom" />
      <span className="toast-progress-segment left" />
    </span>
  );
}

function ProbeLine({ probe }: { probe?: PlayerProbe }) {
  if (!probe) {
    return null;
  }

  return (
    <div className={probe.ok ? "probe-line ok" : "probe-line bad"}>
      {probe.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
      <span>{probe.message}</span>
    </div>
  );
}

function EmptyState({
  Icon,
  title,
  actionLabel,
  disabled,
  onAction
}: {
  Icon: LucideIcon;
  title: string;
  actionLabel?: string;
  disabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <Icon size={32} />
      <h3>{title}</h3>
      {actionLabel && onAction && (
        <button className="secondary-button" disabled={disabled} onClick={onAction} type="button">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="video-grid">
      {Array.from({ length: 8 }).map((_, index) => (
        <div className="skeleton-card" key={index}>
          <div />
          <span />
          <small />
        </div>
      ))}
    </div>
  );
}

function updateVideoAuthorFollowing<T extends VideoSummary | undefined>(
  video: T,
  authorId: string,
  following: boolean
): T {
  if (!video || video.uploaderId !== authorId) {
    return video;
  }

  return { ...video, uploaderFollowing: following } as T;
}

function updateFeedAuthorFollowing(
  feed: VideoListResult | undefined,
  authorId: string,
  following: boolean
): VideoListResult | undefined {
  if (!feed) {
    return feed;
  }

  return {
    ...feed,
    results: feed.results.map((video) => updateVideoAuthorFollowing(video, authorId, following))
  };
}

function updateFeedCollectionAuthorFollowing(
  feeds: Partial<Record<FeedTabKey, VideoListResult>>,
  authorId: string,
  following: boolean
): Partial<Record<FeedTabKey, VideoListResult>> {
  const next = { ...feeds };
  for (const key of Object.keys(next) as FeedTabKey[]) {
    next[key] = updateFeedAuthorFollowing(next[key], authorId, following);
  }

  return next;
}

function sectionLabel(section: MainSection): string {
  switch (section) {
    case "browse":
      return "浏览";
    case "search":
      return "搜索";
    case "subscriptions":
      return "订阅";
    case "favorites":
      return "收藏";
    case "downloads":
      return "下载";
    case "history":
      return "历史";
    case "settings":
      return "设置";
    default:
      return "浏览";
  }
}

function feedTitle(tab: FeedTabKey): string {
  if (tab === "followed") {
    return "关注标签";
  }

  return tab === "date" ? "刚刚发布" : tab === "trending" ? "正在升温" : "长期热门";
}

function subscriptionAuthors(videos: VideoSummary[]): Array<{ id: string; label: string; avatarUrl?: string }> {
  const authors = new Map<string, { id: string; label: string; avatarUrl?: string }>();
  for (const video of videos) {
    const id = subscriptionAuthorId(video);
    const current = authors.get(id);
    if (current) {
      current.avatarUrl = current.avatarUrl ?? video.uploaderAvatarUrl;
    } else {
      authors.set(id, {
        id,
        label: subscriptionAuthorLabel(video),
        avatarUrl: video.uploaderAvatarUrl
      });
    }
  }

  return [...authors.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function subscriptionAuthorId(video: VideoSummary): string {
  return video.uploaderId ?? `author:${video.uploaderUsername ?? video.uploaderName ?? "unknown"}`;
}

function subscriptionAuthorLabel(video: VideoSummary): string {
  if (video.uploaderName && video.uploaderUsername && video.uploaderName !== video.uploaderUsername) {
    return `${video.uploaderName} (@${video.uploaderUsername})`;
  }

  return video.uploaderName ?? video.uploaderUsername ?? "未知作者";
}

function authorInitial(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}

function searchSortLabel(sort: VideoSort): string {
  switch (sort) {
    case "relevance":
      return "相关";
    case "date":
      return "最新";
    case "views":
      return "播放";
    case "likes":
      return "喜欢";
    default:
      return "相关";
  }
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(value);
}

function formatDate(value?: string): string {
  if (!value) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatFullDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  const padded = (value: number) => value.toString().padStart(2, "0");

  return hours > 0
    ? `${hours}:${padded(minutes)}:${padded(rest)}`
    : `${minutes}:${padded(rest)}`;
}

function playStatus(result: { mode: PlayerMode; format: { label: string }; fallbackFrom?: string }): string {
  const player = result.mode === "mpv" ? "MPV" : "外部播放器";
  const fallback = result.fallbackFrom ? `，${result.fallbackFrom} 不可用，已改用 ${result.format.label}` : `：${result.format.label}`;
  return `已启动 ${player}${fallback}`;
}

function downloadTaskTitle(task: DownloadTask): string {
  return task.video?.title ?? task.videoId;
}

function downloadStatusLabel(status: DownloadTask["status"]): string {
  switch (status) {
    case "queued":
      return "等待中";
    case "downloading":
      return "下载中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "下载";
  }
}

function downloadProgressPercent(task: DownloadTask): number | undefined {
  if (!task.totalBytes || task.totalBytes <= 0) {
    return task.status === "completed" ? 100 : undefined;
  }

  return Math.min(Math.max((task.bytesWritten / task.totalBytes) * 100, 0), 100);
}

function downloadStatus(result: DownloadResult): string {
  const fallback = result.fallbackFrom ? `，${result.fallbackFrom} 不可用，已改用 ${result.format.label}` : "";
  return `已下载 ${result.format.label}${fallback}：${formatBytes(result.bytesWritten)}。${result.path}`;
}

function formatLabelsText(labels: string[]): string {
  return labels.length ? labels.join(" / ") : "无清晰度";
}

function formatSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond) {
    return "未知速度";
  }

  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  }

  return `${Math.max(Math.round(bytesPerSecond / 1024), 1)} KB/s`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${Math.max(Math.round(value / 1024), 1)} KB`;
  }

  return `${Math.round(value)} B`;
}

function normalizeTagTokens(tags: string[]): string[] {
  return [...new Set(
    tags
      .flatMap((tag) => tag.split(/[\s,;，；]+/))
      .map(normalizeTagLabel)
      .filter(Boolean)
  )];
}

function normalizeTagLabel(tag: string): string {
  return tag.trim().toLowerCase();
}

function bestFormat(formats: VideoDetail["formats"]) {
  return formats.slice().sort((a, b) => b.qualityRank - a.qualityRank)[0];
}

function bestQualityRank(formats: VideoDetail["formats"]) {
  return formats.reduce((best, format) => Math.max(best, format.qualityRank), 0);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

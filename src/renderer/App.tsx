import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Flame,
  FolderOpen,
  Gauge,
  History,
  Link2,
  Loader2,
  LogIn,
  MonitorPlay,
  Play,
  RefreshCw,
  Search,
  Settings,
  Star,
  Trash2,
  TrendingUp
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  AuthState,
  IwaraVideoDiagnostics,
  MediaSpeedTestReport,
  PlayerDiagnostics,
  PlayerMode,
  PlayerProbe,
  VideoDetail,
  VideoListResult,
  VideoSort,
  VideoSummary
} from "../shared/types";
import { replaceMediaUrlHost } from "../shared/media-speed-utils";
import logoMarkUrl from "./assets/iwara-tv-mark.svg";
import { classifyIssue, type UiIssue } from "./issue-utils";

type AppSection = "browse" | "history" | "settings";

const sectionTabs: Array<{ section: AppSection; label: string; Icon: LucideIcon }> = [
  { section: "browse", label: "浏览", Icon: MonitorPlay },
  { section: "history", label: "历史", Icon: History },
  { section: "settings", label: "设置", Icon: Settings }
];

const feedTabs: Array<{ sort: VideoSort; label: string; Icon: LucideIcon }> = [
  { sort: "date", label: "最新", Icon: Clock3 },
  { sort: "trending", label: "当前人气", Icon: Flame },
  { sort: "popularity", label: "流行视频", Icon: TrendingUp }
];

const defaultSettings: AppSettings = {
  player: {
    preferredMode: "mpv",
    externalPlayerArgs: "{url}",
    preferredQuality: "Source"
  },
  mediaSpeed: {
    autoTest: false,
    replaceLinks: true,
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
  history: []
};

const defaultAuth: AuthState = {
  loggedIn: false,
  hasMediaToken: false,
  encryptionAvailable: false
};

export function App() {
  const bridge = window.iwaraTV;
  const [activeSection, setActiveSection] = useState<AppSection>("browse");
  const [activeSort, setActiveSort] = useState<VideoSort>("date");
  const [feeds, setFeeds] = useState<Partial<Record<VideoSort, VideoListResult>>>({});
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [auth, setAuth] = useState<AuthState>(defaultAuth);
  const [diagnostics, setDiagnostics] = useState<PlayerDiagnostics | undefined>();
  const [mpvTest, setMpvTest] = useState<PlayerProbe | undefined>();
  const [videoDiagnostics, setVideoDiagnostics] = useState<IwaraVideoDiagnostics | undefined>();
  const [speedReport, setSpeedReport] = useState<MediaSpeedTestReport | undefined>();
  const [selectedVideo, setSelectedVideo] = useState<VideoDetail | undefined>();
  const [selectedQuality, setSelectedQuality] = useState<string | undefined>();
  const [urlInput, setUrlInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [issue, setIssue] = useState<UiIssue | undefined>();
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [loadingVideoId, setLoadingVideoId] = useState<string | undefined>();
  const [quickPlayingId, setQuickPlayingId] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);
  const [probing, setProbing] = useState(false);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [diagnosingVideo, setDiagnosingVideo] = useState(false);
  const [speedTesting, setSpeedTesting] = useState(false);

  const activeFeed = feeds[activeSort];
  const hasBridge = Boolean(bridge);
  const showDetailPanel = activeSection === "browse" && Boolean(selectedVideo);
  const sortedFormats = useMemo(
    () => [...(selectedVideo?.formats ?? [])].sort((a, b) => b.qualityRank - a.qualityRank),
    [selectedVideo]
  );

  useEffect(() => {
    if (!bridge) {
      return;
    }

    void Promise.all([bridge.settings.get(), bridge.auth.state(), bridge.player.probe()])
      .then(([loadedSettings, loadedAuth, loadedDiagnostics]) => {
        setSettings(loadedSettings);
        setAuth(loadedAuth);
        setDiagnostics(loadedDiagnostics);
      })
      .catch(handleError);
  }, [bridge]);

  useEffect(() => {
    if (!bridge || activeSection !== "browse" || feeds[activeSort]) {
      return;
    }

    void loadFeed(activeSort);
  }, [activeSection, activeSort, feeds, bridge]);

  async function loadFeed(sort: VideoSort, page = feeds[sort]?.page ?? 0) {
    if (!bridge) {
      return;
    }

    setLoadingFeed(true);
    clearMessages();
    try {
      const result = await bridge.iwara.listVideos({ sort, page, rating: "all" });
      setFeeds((current) => ({ ...current, [sort]: result }));
    } catch (err) {
      handleError(err);
    } finally {
      setLoadingFeed(false);
    }
  }

  async function openVideo(idOrUrl: string) {
    if (!bridge || !idOrUrl.trim()) {
      return;
    }

    setLoadingVideoId(idOrUrl);
    clearMessages();
    try {
      const video = await bridge.iwara.getVideo(idOrUrl);
      setSettings(await bridge.settings.get());
      setSelectedVideo(video);
      setVideoDiagnostics(undefined);
      setSpeedReport(undefined);
      let formats = video.formats;
      if (auth.siteTokenReady && bestQualityRank(formats) <= 360) {
        const report = await bridge.iwara.diagnoseVideo(video.id);
        setSettings(await bridge.settings.get());
        const capturedFormats = report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? [];
        setVideoDiagnostics(report);
        if (bestQualityRank(capturedFormats) > bestQualityRank(formats)) {
          formats = capturedFormats;
          setSelectedVideo({ ...video, formats });
          setStatus(`已通过网页抓包补全：${formatLabelsText(formats.map((format) => format.label))}。`);
        }
      }
      if (settings.mediaSpeed.autoTest && !settings.mediaSpeed.rankedHosts.length && formats.length) {
        const report = await bridge.iwara.speedTestVideo(video.id);
        setSettings(await bridge.settings.get());
        setSpeedReport(report);
        if (report.fastestHost && settings.mediaSpeed.replaceLinks) {
          formats = routeFormatsByHost(formats, report.fastestHost);
          setSelectedVideo({ ...video, formats });
          setStatus(`已完成全局线路测速，最快线路：${report.fastestHost}。`);
        }
      }
      const preferred = formats.find((format) => format.id === settings.player.preferredQuality);
      const best = bestFormat(formats);
      setSelectedQuality(preferred?.id ?? best?.id);
    } catch (err) {
      handleError(err);
    } finally {
      setLoadingVideoId(undefined);
    }
  }

  async function quickPlay(video: VideoSummary) {
    if (!bridge) {
      return;
    }

    setQuickPlayingId(video.id);
    clearMessages();
    try {
      const result = await bridge.player.play({
        videoId: video.id,
        mode: settings.player.preferredMode
      });
      setSelectedVideo(result.video);
      setSelectedQuality(result.format.id);
      setStatus(playStatus(result));
      setSettings(await bridge.settings.get());
      await refreshDiagnostics();
    } catch (err) {
      handleError(err);
    } finally {
      setQuickPlayingId(undefined);
    }
  }

  async function playVideo(mode: PlayerMode = settings.player.preferredMode) {
    if (!bridge || !selectedVideo) {
      return;
    }

    setPlaying(true);
    clearMessages();
    try {
      const result = await bridge.player.play({
        videoId: selectedVideo.id,
        quality: selectedQuality,
        mode
      });
      setStatus(playStatus(result));
      setSettings(await bridge.settings.get());
      await refreshDiagnostics();
    } catch (err) {
      handleError(err);
    } finally {
      setPlaying(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setActiveSection("browse");
    await openVideo(urlInput);
  }

  async function updatePlayerSettings(partial: Partial<AppSettings["player"]>): Promise<AppSettings | undefined> {
    if (!bridge) {
      return undefined;
    }

    const next = await bridge.settings.update({ player: { ...settings.player, ...partial } });
    setSettings(next);
    return next;
  }

  async function updateMediaSpeedSettings(partial: Partial<AppSettings["mediaSpeed"]>): Promise<AppSettings | undefined> {
    if (!bridge) {
      return undefined;
    }

    const next = await bridge.settings.update({ mediaSpeed: { ...settings.mediaSpeed, ...partial } });
    setSettings(next);
    return next;
  }

  async function speedTestSelectedVideo() {
    if (!bridge || !selectedVideo) {
      return;
    }

    setSpeedTesting(true);
    clearMessages();
    try {
      const report = await bridge.iwara.speedTestVideo(selectedVideo.id);
      setSettings(await bridge.settings.get());
      setSpeedReport(report);
      if (report.fastestHost && settings.mediaSpeed.replaceLinks) {
        const formats = routeFormatsByHost(selectedVideo.formats, report.fastestHost);
        setSelectedVideo({ ...selectedVideo, formats });
        setSelectedQuality((current) => current ?? bestFormat(formats)?.id);
      }
      setStatus(report.fastestHost
        ? `全局测速完成，最快线路：${report.fastestHost}。`
        : "全局测速完成，没有可用线路。");
    } catch (err) {
      handleError(err);
    } finally {
      setSpeedTesting(false);
    }
  }

  async function chooseExecutable(kind: "mpv" | "external") {
    if (!bridge) {
      return;
    }

    const selected = await bridge.system.selectExecutable({
      title: kind === "mpv" ? "选择 mpv.exe" : "选择外部播放器",
      currentPath: kind === "mpv" ? settings.player.mpvPath : settings.player.externalPlayerPath
    });

    if (selected.canceled || !selected.path) {
      return;
    }

    await updatePlayerSettings(kind === "mpv" ? { mpvPath: selected.path } : { externalPlayerPath: selected.path });
    await refreshDiagnostics();
  }

  async function refreshDiagnostics() {
    if (!bridge) {
      return;
    }

    setProbing(true);
    try {
      setDiagnostics(await bridge.player.probe());
    } catch (err) {
      handleError(err);
    } finally {
      setProbing(false);
    }
  }

  async function testMpv() {
    if (!bridge) {
      return;
    }

    setProbing(true);
    clearMessages();
    try {
      const result = await bridge.player.testMpv();
      setMpvTest(result);
      setStatus(result.message);
    } catch (err) {
      handleError(err);
    } finally {
      setProbing(false);
    }
  }

  async function diagnoseSelectedVideo() {
    if (!bridge || !selectedVideo) {
      return;
    }

    setDiagnosingVideo(true);
    clearMessages();
    try {
      const report = await bridge.iwara.diagnoseVideo(selectedVideo.id);
      setSettings(await bridge.settings.get());
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
    if (!bridge) {
      return;
    }

    const next = await bridge.settings.update({ history: [] });
    setSettings(next);
  }

  async function refreshAuthState() {
    if (!bridge) {
      return;
    }

    setSessionBusy(true);
    clearMessages();
    try {
      setAuth(await bridge.auth.state());
      setStatus("会话状态已刷新。");
    } catch (err) {
      handleError(err);
    } finally {
      setSessionBusy(false);
    }
  }

  async function openIwaraSession() {
    if (!bridge) {
      return;
    }

    setSessionBusy(true);
    clearMessages();
    try {
      setAuth(await bridge.auth.openIwaraSession());
      setStatus("已打开 Iwara 验证窗口。完成验证或登录后，回到这里刷新会话再重试。");
    } catch (err) {
      handleError(err);
    } finally {
      setSessionBusy(false);
    }
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
    } else {
      await loadFeed(activeSort, activeFeed?.page ?? 0);
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
            <img alt="" className="brand-logo" src={logoMarkUrl} />
          </div>
          <div>
            <h1>IwaraTV</h1>
            <span>{auth.loggedIn ? auth.email : "匿名"}</span>
          </div>
        </div>

        <nav className="nav-list">
          {sectionTabs.map(({ section, label, Icon }) => (
            <button
              className={activeSection === section ? "nav-button active" : "nav-button"}
              key={section}
              onClick={() => setActiveSection(section)}
              type="button"
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <form className="url-form" onSubmit={handleSubmit}>
            <Search size={18} />
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="Iwara 视频链接或 ID"
            />
            <button disabled={!hasBridge || !urlInput.trim() || Boolean(loadingVideoId)} type="submit">
              {loadingVideoId === urlInput ? <Loader2 className="spin" size={18} /> : <ExternalLink size={18} />}
              打开
            </button>
          </form>

          <button className="auth-pill" onClick={() => setActiveSection("settings")} type="button">
            {auth.siteTokenReady || auth.loggedIn ? <Star size={16} /> : <LogIn size={16} />}
            {auth.siteTokenReady ? "登录就绪" : auth.siteSessionReady ? "已验证" : auth.loggedIn ? "已登录" : "未验证"}
          </button>
        </header>

        {!hasBridge && (
          <div className="notice warning">
            当前是浏览器预览。运行桌面版后可以连接 Electron IPC、启动 MPV 和保存设置。
          </div>
        )}

        {issue && <ActionNotice issue={issue} onAction={() => handleIssueAction(issue)} />}
        {status && <div className="notice success">{status}</div>}

        <div className={showDetailPanel ? "content-grid with-detail" : "content-grid"}>
          <section className="primary-panel">
            {activeSection === "browse" && (
              <BrowseView
                activeFeed={activeFeed}
                activeSort={activeSort}
                hasBridge={hasBridge}
                loadingFeed={loadingFeed}
                loadingVideoId={loadingVideoId}
                onOpen={openVideo}
                onPage={(page) => loadFeed(activeSort, page)}
                onQuickPlay={quickPlay}
                onRefresh={() => loadFeed(activeSort, activeFeed?.page ?? 0)}
                onSortChange={setActiveSort}
                quickPlayingId={quickPlayingId}
              />
            )}

            {activeSection === "history" && (
              <HistoryView
                history={settings.history}
                onClear={clearHistory}
                onOpen={(id) => {
                  setActiveSection("browse");
                  void openVideo(id);
                }}
              />
            )}

            {activeSection === "settings" && (
              <SettingsView
                auth={auth}
                diagnostics={diagnostics}
                hasBridge={hasBridge}
                mpvTest={mpvTest}
                onChooseExternal={() => chooseExecutable("external")}
                onChooseMpv={() => chooseExecutable("mpv")}
                onOpenIwaraSession={openIwaraSession}
                onProbe={refreshDiagnostics}
                onRefreshAuth={refreshAuthState}
                onSpeedTest={speedTestSelectedVideo}
                onTestMpv={testMpv}
                onUpdateMediaSpeed={updateMediaSpeedSettings}
                onUpdatePlayer={updatePlayerSettings}
                player={settings.player}
                probing={probing}
                selectedVideo={selectedVideo}
                sessionBusy={sessionBusy}
                speedReport={speedReport}
                speedSettings={settings.mediaSpeed}
                speedTesting={speedTesting}
              />
            )}
          </section>

          {showDetailPanel && selectedVideo && (
            <DetailPanel
              siteSessionReady={Boolean(auth.siteTokenReady)}
              playing={playing}
              selectedQuality={selectedQuality}
              sortedFormats={sortedFormats}
              diagnostics={videoDiagnostics}
              diagnosing={diagnosingVideo}
              video={selectedVideo}
              onDiagnose={diagnoseSelectedVideo}
              onPlay={playVideo}
              onQualityChange={setSelectedQuality}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function BrowseView({
  activeFeed,
  activeSort,
  hasBridge,
  loadingFeed,
  loadingVideoId,
  onOpen,
  onPage,
  onQuickPlay,
  onRefresh,
  onSortChange,
  quickPlayingId
}: {
  activeFeed?: VideoListResult;
  activeSort: VideoSort;
  hasBridge: boolean;
  loadingFeed: boolean;
  loadingVideoId?: string;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onQuickPlay: (video: VideoSummary) => void;
  onRefresh: () => void;
  onSortChange: (sort: VideoSort) => void;
  quickPlayingId?: string;
}) {
  const videos = activeFeed?.results ?? [];

  return (
    <>
      <div className="section-header">
        <div>
          <p>视频源</p>
          <h2>{feedTitle(activeSort)}</h2>
        </div>
        <button
          className="icon-text-button"
          disabled={!hasBridge || loadingFeed}
          onClick={onRefresh}
          type="button"
        >
          {loadingFeed ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          刷新
        </button>
      </div>

      <div className="feed-tabs" role="tablist">
        {feedTabs.map(({ sort, label, Icon }) => (
          <button
            aria-selected={activeSort === sort}
            className={activeSort === sort ? "feed-tab active" : "feed-tab"}
            key={sort}
            onClick={() => onSortChange(sort)}
            role="tab"
            type="button"
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </div>

      {loadingFeed && !videos.length ? (
        <SkeletonGrid />
      ) : videos.length ? (
        <>
          <div className="video-grid">
            {videos.map((video) => (
              <VideoCard
                key={video.id}
                loading={loadingVideoId === video.id}
                onOpen={() => onOpen(video.id)}
                onQuickPlay={() => onQuickPlay(video)}
                quickPlaying={quickPlayingId === video.id}
                video={video}
              />
            ))}
          </div>

          <div className="pager">
            <button
              disabled={!hasBridge || loadingFeed || (activeFeed?.page ?? 0) <= 0}
              onClick={() => onPage(Math.max((activeFeed?.page ?? 0) - 1, 0))}
              type="button"
            >
              上一页
            </button>
            <span>第 {(activeFeed?.page ?? 0) + 1} 页</span>
            <button
              disabled={!hasBridge || loadingFeed}
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
          disabled={!hasBridge || loadingFeed}
          onAction={onRefresh}
        />
      )}
    </>
  );
}

function DetailPanel({
  siteSessionReady,
  playing,
  selectedQuality,
  sortedFormats,
  diagnostics,
  diagnosing,
  video,
  onDiagnose,
  onPlay,
  onQualityChange
}: {
  siteSessionReady: boolean;
  playing: boolean;
  selectedQuality?: string;
  sortedFormats: VideoDetail["formats"];
  diagnostics?: IwaraVideoDiagnostics;
  diagnosing: boolean;
  video: VideoDetail;
  onDiagnose: () => void;
  onPlay: (mode: PlayerMode) => void;
  onQualityChange: (quality: string) => void;
}) {
  return (
    <aside className="detail-panel">
      <div className="detail-art">
        {video.thumbnailUrl ? (
          <img alt={video.title} src={video.thumbnailUrl} />
        ) : (
          <div className="empty-art">NO IMAGE</div>
        )}
      </div>
      <div className="detail-body">
        <p className="eyebrow">{video.uploaderName ?? video.uploaderUsername ?? "Unknown"}</p>
        <h2>{video.title}</h2>
        <div className="metric-row">
          <span>{compactNumber(video.numViews)} 观看</span>
          <span>{compactNumber(video.numLikes)} 喜欢</span>
          <span>{formatDate(video.createdAt)}</span>
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
            <p className="subtle">
              Iwara 当前只返回：{sortedFormats.map((format) => format.label).join(" / ")}。
              {siteSessionReady
                ? "如果网页版也没有更高清晰度，通常是视频源或站点转码限制。"
                : "如果网页版有 Source/540，请先在设置里完成应用内验证后重新打开视频。"}
            </p>
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
        </div>

        <button className="secondary-button" disabled={diagnosing} onClick={onDiagnose} type="button">
          {diagnosing ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
          抓包诊断
        </button>

        {diagnostics && <VideoDiagnosticsPanel diagnostics={diagnostics} />}
      </div>
    </aside>
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

function VideoCard({
  video,
  loading,
  quickPlaying,
  onOpen,
  onQuickPlay
}: {
  video: VideoSummary;
  loading: boolean;
  quickPlaying: boolean;
  onOpen: () => void;
  onQuickPlay: () => void;
}) {
  return (
    <article className="video-card">
      <button className="thumb-button" onClick={onOpen} type="button">
        <div className="thumb">
          {video.thumbnailUrl ? <img alt={video.title} src={video.thumbnailUrl} /> : <div className="empty-art">NO IMAGE</div>}
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
          <button className="quick-play-button" onClick={onQuickPlay} type="button">
            {quickPlaying ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            播放
          </button>
        </div>
      </div>
    </article>
  );
}

function HistoryView({
  history,
  onClear,
  onOpen
}: {
  history: AppSettings["history"];
  onClear: () => void;
  onOpen: (id: string) => void;
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
          {history.map((item) => (
            <button className="history-item" key={`${item.video.id}-${item.playedAt}`} onClick={() => onOpen(item.video.id)} type="button">
              <span>{item.video.title}</span>
              <small>{item.mode.toUpperCase()} · {item.formatId} · {formatDate(item.playedAt)}</small>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState Icon={History} title="还没有播放历史" />
      )}
    </>
  );
}

function SettingsView({
  auth,
  diagnostics,
  hasBridge,
  mpvTest,
  onChooseExternal,
  onChooseMpv,
  onOpenIwaraSession,
  onProbe,
  onRefreshAuth,
  onSpeedTest,
  onTestMpv,
  onUpdateMediaSpeed,
  onUpdatePlayer,
  player,
  probing,
  selectedVideo,
  sessionBusy,
  speedReport,
  speedSettings,
  speedTesting
}: {
  auth: AuthState;
  diagnostics?: PlayerDiagnostics;
  hasBridge: boolean;
  mpvTest?: PlayerProbe;
  onChooseExternal: () => void;
  onChooseMpv: () => void;
  onOpenIwaraSession: () => void;
  onProbe: () => void;
  onRefreshAuth: () => void;
  onSpeedTest: () => void;
  onTestMpv: () => void;
  onUpdateMediaSpeed: (partial: Partial<AppSettings["mediaSpeed"]>) => void;
  onUpdatePlayer: (partial: Partial<AppSettings["player"]>) => void;
  player: AppSettings["player"];
  probing: boolean;
  selectedVideo?: VideoDetail;
  sessionBusy: boolean;
  speedReport?: MediaSpeedTestReport;
  speedSettings: AppSettings["mediaSpeed"];
  speedTesting: boolean;
}) {
  return (
    <>
      <div className="section-header">
        <div>
          <p>本地播放</p>
          <h2>设置</h2>
        </div>
        <button className="icon-text-button" disabled={!hasBridge || probing} onClick={onProbe} type="button">
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
            <button className="primary-button" disabled={!hasBridge || sessionBusy} onClick={onOpenIwaraSession} type="button">
              {sessionBusy ? <Loader2 className="spin" size={18} /> : <LogIn size={18} />}
              打开 Iwara 验证窗口
            </button>
            <button className="secondary-button" disabled={!hasBridge || sessionBusy} onClick={onRefreshAuth} type="button">
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
            <span>测速后替换为最快可用链接</span>
          </label>
          <label className="field-label">
            域名池
            <input
              value={speedSettings.candidateHosts.join(", ")}
              onChange={(event) => onUpdateMediaSpeed({ candidateHosts: event.target.value.split(",").map((host) => host.trim()).filter(Boolean) })}
              placeholder="自动发现，也可手动追加：jade.iwara.tv, kafka.iwara.tv"
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
          <button className="secondary-button" disabled={!hasBridge || !selectedVideo || speedTesting} onClick={onSpeedTest} type="button">
            {speedTesting ? <Loader2 className="spin" size={18} /> : <Gauge size={18} />}
            测速当前视频
          </button>
          <p className="subtle">
            当前视频、网页抓包和测速结果里发现的新媒体域名会自动加入这里。全局测速只用当前视频的一条直链作为样本；之后所有视频按全局最快线路替换。
          </p>
          {speedReport && <SpeedReportPanel report={speedReport} />}
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
              <button className="secondary-button compact" disabled={!hasBridge} onClick={onChooseMpv} type="button">
                <FolderOpen size={17} />
                选择
              </button>
            </div>
          </label>
          <ProbeLine probe={diagnostics?.mpv} />
          {mpvTest && <ProbeLine probe={mpvTest} />}
          <button className="secondary-button" disabled={!hasBridge || probing} onClick={onTestMpv} type="button">
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
              <button className="secondary-button compact" disabled={!hasBridge} onClick={onChooseExternal} type="button">
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

function ActionNotice({ issue, onAction }: { issue: UiIssue; onAction: () => void }) {
  return (
    <div className="notice danger action-notice">
      <AlertTriangle size={20} />
      <div>
        <strong>{issue.title}</strong>
        <span>{issue.detail}</span>
      </div>
      <button className="secondary-button compact" onClick={onAction} type="button">
        {issue.actionLabel}
      </button>
    </div>
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

function feedTitle(sort: VideoSort): string {
  return sort === "date" ? "刚刚发布" : sort === "trending" ? "正在升温" : "长期热门";
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

function playStatus(result: { mode: PlayerMode; format: { label: string }; fallbackFrom?: string }): string {
  const player = result.mode === "mpv" ? "MPV" : "外部播放器";
  const fallback = result.fallbackFrom ? `，${result.fallbackFrom} 不可用，已改用 ${result.format.label}` : `：${result.format.label}`;
  return `已启动 ${player}${fallback}`;
}

function formatLabelsText(labels: string[]): string {
  return labels.length ? labels.join(" / ") : "无清晰度";
}

function routeFormatsByHost(formats: VideoDetail["formats"], fastestHost: string) {
  return formats.map((format) => {
    const routedUrl = replaceMediaUrlHost(format.url, fastestHost);
    return routedUrl ? { ...format, url: routedUrl } : format;
  });
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

function bestFormat(formats: VideoDetail["formats"]) {
  return formats.slice().sort((a, b) => b.qualityRank - a.qualityRank)[0];
}

function bestQualityRank(formats: VideoDetail["formats"]) {
  return formats.reduce((best, format) => Math.max(best, format.qualityRank), 0);
}

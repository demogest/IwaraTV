import {
  Clock3,
  ExternalLink,
  Flame,
  History,
  Loader2,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  Search,
  Settings,
  Star,
  Trash2,
  TrendingUp
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  AuthState,
  PlayerMode,
  VideoDetail,
  VideoListResult,
  VideoSort,
  VideoSummary
} from "../shared/types";

const feedTabs: Array<{ sort: VideoSort; label: string; Icon: typeof Clock3 }> = [
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
  history: []
};

const defaultAuth: AuthState = {
  loggedIn: false,
  hasMediaToken: false,
  encryptionAvailable: false
};

export function App() {
  const bridge = window.iwaraTV;
  const [activeView, setActiveView] = useState<VideoSort | "history" | "settings">("date");
  const [feeds, setFeeds] = useState<Partial<Record<VideoSort, VideoListResult>>>({});
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [auth, setAuth] = useState<AuthState>(defaultAuth);
  const [selectedVideo, setSelectedVideo] = useState<VideoDetail | undefined>();
  const [selectedQuality, setSelectedQuality] = useState<string | undefined>();
  const [urlInput, setUrlInput] = useState("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [loadingVideoId, setLoadingVideoId] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });

  const activeFeed = isVideoSort(activeView) ? feeds[activeView] : undefined;
  const activeSort = isVideoSort(activeView) ? activeView : "date";
  const hasBridge = Boolean(bridge);

  useEffect(() => {
    if (!bridge) {
      return;
    }

    void Promise.all([bridge.settings.get(), bridge.auth.state()])
      .then(([loadedSettings, loadedAuth]) => {
        setSettings(loadedSettings);
        setAuth(loadedAuth);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !isVideoSort(activeView) || feeds[activeView]) {
      return;
    }

    void loadFeed(activeView);
  }, [activeView, feeds, bridge]);

  useEffect(() => {
    if (bridge && !feeds.date) {
      void loadFeed("date");
    }
  }, [bridge]);

  const sortedFormats = useMemo(
    () => [...(selectedVideo?.formats ?? [])].sort((a, b) => b.qualityRank - a.qualityRank),
    [selectedVideo]
  );

  async function loadFeed(sort: VideoSort, page = feeds[sort]?.page ?? 0) {
    if (!bridge) {
      return;
    }

    setLoadingFeed(true);
    setError("");
    try {
      const result = await bridge.iwara.listVideos({ sort, page, rating: "all" });
      setFeeds((current) => ({ ...current, [sort]: result }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingFeed(false);
    }
  }

  async function openVideo(idOrUrl: string) {
    if (!bridge || !idOrUrl.trim()) {
      return;
    }

    setLoadingVideoId(idOrUrl);
    setError("");
    setStatus("");
    try {
      const video = await bridge.iwara.getVideo(idOrUrl);
      setSelectedVideo(video);
      const preferred = video.formats.find((format) => format.id === settings.player.preferredQuality);
      const best = [...video.formats].sort((a, b) => b.qualityRank - a.qualityRank)[0];
      setSelectedQuality(preferred?.id ?? best?.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingVideoId(undefined);
    }
  }

  async function playVideo(mode: PlayerMode = settings.player.preferredMode) {
    if (!bridge || !selectedVideo) {
      return;
    }

    setPlaying(true);
    setError("");
    setStatus("");
    try {
      const result = await bridge.player.play({
        videoId: selectedVideo.id,
        quality: selectedQuality,
        mode
      });
      setStatus(`已启动 ${result.mode === "mpv" ? "MPV" : "外部播放器"}：${result.format.label}`);
      setSettings(await bridge.settings.get());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPlaying(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await openVideo(urlInput);
  }

  async function updatePlayerSettings(partial: Partial<AppSettings["player"]>) {
    if (!bridge) {
      return;
    }

    const next = await bridge.settings.update({ player: { ...settings.player, ...partial } });
    setSettings(next);
  }

  async function clearHistory() {
    if (!bridge) {
      return;
    }

    const next = await bridge.settings.update({ history: [] });
    setSettings(next);
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!bridge) {
      return;
    }

    setError("");
    try {
      setAuth(await bridge.auth.login(loginForm));
      setLoginForm((current) => ({ ...current, password: "" }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function logout() {
    if (!bridge) {
      return;
    }

    setAuth(await bridge.auth.logout());
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">IT</div>
          <div>
            <h1>IwaraTV</h1>
            <span>{auth.loggedIn ? auth.email : "匿名"}</span>
          </div>
        </div>

        <nav className="nav-list">
          {feedTabs.map(({ sort, label, Icon }) => (
            <button
              className={activeView === sort ? "nav-button active" : "nav-button"}
              key={sort}
              onClick={() => setActiveView(sort)}
              type="button"
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
          <button
            className={activeView === "history" ? "nav-button active" : "nav-button"}
            onClick={() => setActiveView("history")}
            type="button"
          >
            <History size={18} />
            历史
          </button>
          <button
            className={activeView === "settings" ? "nav-button active" : "nav-button"}
            onClick={() => setActiveView("settings")}
            type="button"
          >
            <Settings size={18} />
            设置
          </button>
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

          <div className="auth-pill">
            {auth.loggedIn ? <Star size={16} /> : <LogIn size={16} />}
            {auth.loggedIn ? "已登录" : "匿名模式"}
          </div>
        </header>

        {!hasBridge && (
          <div className="notice warning">
            当前是浏览器预览。运行桌面版后可以连接 Electron IPC、启动 MPV 和保存设置。
          </div>
        )}

        {error && <div className="notice danger">{error}</div>}
        {status && <div className="notice success">{status}</div>}

        <div className="content-grid">
          <section className="primary-panel">
            {isVideoSort(activeView) && (
              <>
                <div className="section-header">
                  <div>
                    <p>{feedTabs.find((tab) => tab.sort === activeSort)?.label}</p>
                    <h2>{feedTitle(activeSort)}</h2>
                  </div>
                  <button
                    className="icon-text-button"
                    disabled={!hasBridge || loadingFeed}
                    onClick={() => loadFeed(activeSort, activeFeed?.page ?? 0)}
                    type="button"
                  >
                    {loadingFeed ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                    刷新
                  </button>
                </div>

                <div className="video-grid">
                  {(activeFeed?.results ?? []).map((video) => (
                    <VideoCard
                      key={video.id}
                      loading={loadingVideoId === video.id}
                      onOpen={() => openVideo(video.id)}
                      video={video}
                    />
                  ))}
                </div>

                <div className="pager">
                  <button
                    disabled={!hasBridge || loadingFeed || (activeFeed?.page ?? 0) <= 0}
                    onClick={() => loadFeed(activeSort, Math.max((activeFeed?.page ?? 0) - 1, 0))}
                    type="button"
                  >
                    上一页
                  </button>
                  <span>第 {(activeFeed?.page ?? 0) + 1} 页</span>
                  <button
                    disabled={!hasBridge || loadingFeed}
                    onClick={() => loadFeed(activeSort, (activeFeed?.page ?? 0) + 1)}
                    type="button"
                  >
                    下一页
                  </button>
                </div>
              </>
            )}

            {activeView === "history" && (
              <HistoryView history={settings.history} onClear={clearHistory} onOpen={(id) => openVideo(id)} />
            )}

            {activeView === "settings" && (
              <SettingsView
                auth={auth}
                loginForm={loginForm}
                onLogin={login}
                onLogout={logout}
                onLoginFormChange={setLoginForm}
                onUpdatePlayer={updatePlayerSettings}
                player={settings.player}
              />
            )}
          </section>

          <aside className="detail-panel">
            {selectedVideo ? (
              <>
                <div className="detail-art">
                  {selectedVideo.thumbnailUrl ? (
                    <img alt={selectedVideo.title} src={selectedVideo.thumbnailUrl} />
                  ) : (
                    <div className="empty-art">NO IMAGE</div>
                  )}
                </div>
                <div className="detail-body">
                  <p className="eyebrow">{selectedVideo.uploaderName ?? selectedVideo.uploaderUsername ?? "Unknown"}</p>
                  <h2>{selectedVideo.title}</h2>
                  <div className="metric-row">
                    <span>{compactNumber(selectedVideo.numViews)} 观看</span>
                    <span>{compactNumber(selectedVideo.numLikes)} 喜欢</span>
                    <span>{formatDate(selectedVideo.createdAt)}</span>
                  </div>

                  <label className="field-label">
                    清晰度
                    <select
                      disabled={!sortedFormats.length}
                      value={selectedQuality ?? ""}
                      onChange={(event) => setSelectedQuality(event.target.value)}
                    >
                      {sortedFormats.map((format) => (
                        <option key={format.id} value={format.id}>
                          {format.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="play-row">
                    <button className="primary-button" disabled={playing || !sortedFormats.length} onClick={() => playVideo("mpv")} type="button">
                      {playing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
                      MPV
                    </button>
                    <button className="secondary-button" disabled={playing || !sortedFormats.length} onClick={() => playVideo("external")} type="button">
                      <ExternalLink size={18} />
                      外部
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-detail">
                <Play size={34} />
                <h2>选择视频</h2>
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function VideoCard({ video, loading, onOpen }: { video: VideoSummary; loading: boolean; onOpen: () => void }) {
  return (
    <button className="video-card" onClick={onOpen} type="button">
      <div className="thumb">
        {video.thumbnailUrl ? <img alt={video.title} src={video.thumbnailUrl} /> : <div className="empty-art">NO IMAGE</div>}
        {loading && <Loader2 className="card-loader spin" size={24} />}
      </div>
      <div className="video-copy">
        <h3>{video.title}</h3>
        <p>{video.uploaderName ?? video.uploaderUsername ?? "Unknown"}</p>
        <div>
          <span>{compactNumber(video.numViews)} 观看</span>
          <span>{compactNumber(video.numLikes)} 喜欢</span>
        </div>
      </div>
    </button>
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
      <div className="history-list">
        {history.map((item) => (
          <button className="history-item" key={`${item.video.id}-${item.playedAt}`} onClick={() => onOpen(item.video.id)} type="button">
            <span>{item.video.title}</span>
            <small>{item.mode.toUpperCase()} · {item.formatId} · {formatDate(item.playedAt)}</small>
          </button>
        ))}
      </div>
    </>
  );
}

function SettingsView({
  auth,
  loginForm,
  onLogin,
  onLogout,
  onLoginFormChange,
  onUpdatePlayer,
  player
}: {
  auth: AuthState;
  loginForm: { email: string; password: string };
  onLogin: (event: FormEvent) => void;
  onLogout: () => void;
  onLoginFormChange: (value: { email: string; password: string }) => void;
  onUpdatePlayer: (partial: Partial<AppSettings["player"]>) => void;
  player: AppSettings["player"];
}) {
  return (
    <>
      <div className="section-header">
        <div>
          <p>本地播放</p>
          <h2>设置</h2>
        </div>
      </div>

      <div className="settings-grid">
        <section className="settings-block">
          <h3>播放器</h3>
          <label className="field-label">
            默认模式
            <select
              value={player.preferredMode}
              onChange={(event) => onUpdatePlayer({ preferredMode: event.target.value as PlayerMode })}
            >
              <option value="mpv">MPV</option>
              <option value="external">外部播放器</option>
            </select>
          </label>
          <label className="field-label">
            MPV 路径
            <input
              value={player.mpvPath ?? ""}
              onChange={(event) => onUpdatePlayer({ mpvPath: event.target.value || undefined })}
              placeholder="vendor/mpv/mpv.exe 或自定义路径"
            />
          </label>
          <label className="field-label">
            外部播放器路径
            <input
              value={player.externalPlayerPath ?? ""}
              onChange={(event) => onUpdatePlayer({ externalPlayerPath: event.target.value || undefined })}
              placeholder="例如 PotPlayerMini64.exe"
            />
          </label>
          <label className="field-label">
            外部播放器参数
            <input
              value={player.externalPlayerArgs}
              onChange={(event) => onUpdatePlayer({ externalPlayerArgs: event.target.value })}
            />
          </label>
        </section>

        <section className="settings-block">
          <h3>登录</h3>
          {auth.loggedIn ? (
            <div className="login-state">
              <span>{auth.email}</span>
              <button className="secondary-button" onClick={onLogout} type="button">
                <LogOut size={18} />
                退出
              </button>
            </div>
          ) : (
            <form className="login-form" onSubmit={onLogin}>
              <input
                autoComplete="username"
                value={loginForm.email}
                onChange={(event) => onLoginFormChange({ ...loginForm, email: event.target.value })}
                placeholder="邮箱"
              />
              <input
                autoComplete="current-password"
                type="password"
                value={loginForm.password}
                onChange={(event) => onLoginFormChange({ ...loginForm, password: event.target.value })}
                placeholder="密码"
              />
              <button className="primary-button" type="submit">
                <LogIn size={18} />
                登录
              </button>
            </form>
          )}
          {auth.warning && <p className="subtle">{auth.warning}</p>}
        </section>
      </div>
    </>
  );
}

function isVideoSort(value: string): value is VideoSort {
  return value === "date" || value === "trending" || value === "popularity";
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

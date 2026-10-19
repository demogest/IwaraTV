import {
  ArrowUpRight,
  Ban,
  ChevronDown,
  CircleCheck,
  Copy,
  Download,
  Ellipsis,
  Eye,
  Film,
  Gauge,
  Heart,
  MessageCircle,
  Play,
  RefreshCw,
  Search,
  Star,
  Tag,
  UserCheck,
  UserPlus,
  Wrench
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeTag } from "../../shared/tags";
import type { IwaraVideoDiagnostics, MediaSpeedTestReport, PlayerMode, VideoDetail, VideoFormat } from "../../shared/types";
import { iwaraVideoPageUrl } from "../../shared/video-id";
import { ListError } from "../components/ListStatus";
import { MenuButton } from "../components/MenuButton";
import { Avatar, Segmented, Spinner, View } from "../components/primitives";
import { useI18n } from "../i18n";
import { invoke } from "../lib/api";
import { compactNumber, formatDate, formatDuration, formatSpeed, qualityLabel } from "../lib/format";
import { useAppState } from "../state/app-state";
import { useNavigationActions } from "../state/navigation";
import { useToasts } from "../state/toasts";
import { Comments } from "./Comments";

function bestRank(formats: readonly VideoFormat[]): number {
  return formats.reduce((best, format) => Math.max(best, format.qualityRank), 0);
}

function sortFormats(formats: readonly VideoFormat[]): VideoFormat[] {
  return [...formats].sort((a, b) => b.qualityRank - a.qualityRank);
}

interface DetailState {
  video?: VideoDetail;
  error?: unknown;
  loading: boolean;
}

function useVideoDetail(videoId: string) {
  const app = useAppState();
  const { t } = useI18n();
  const { push } = useToasts();
  const [state, setState] = useState<DetailState>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [diagnostics, setDiagnostics] = useState<IwaraVideoDiagnostics>();
  const signedIn = app.auth.status === "signed-in";

  useEffect(() => {
    let current = true;
    setState((previous) => ({ video: previous.video?.id === videoId ? previous.video : undefined, loading: true }));
    void invoke("iwara:get-video", videoId)
      .then(async (video) => {
        if (!current) {
          return;
        }
        setState({ video, loading: false });
        // Some qualities are only served to the signed-in website. When the
        // API returned only low qualities, compare with a hidden page load.
        if (signedIn && video.formats.length && bestRank(video.formats) <= 360) {
          const report = await invoke("iwara:diagnose-video", video.id).catch(() => undefined);
          const captured = report?.network?.entries.flatMap((entry) => entry.formats ?? []) ?? [];
          if (current && report) {
            setDiagnostics(report);
            if (bestRank(captured) > bestRank(video.formats)) {
              setState({ video: { ...video, formats: captured }, loading: false });
              push({ tone: "success", title: t("video.formatsImproved", { labels: sortFormats(captured).map((format) => qualityLabel(format.label)).join(" / ") }) });
            }
          }
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setState({ error, loading: false });
        }
      });
    return () => {
      current = false;
    };
    // Re-run only for a different video or an explicit retry.
  }, [videoId, attempt]);

  const replaceFormats = useCallback((formats: VideoFormat[]) => {
    setState((previous) => (previous.video ? { ...previous, video: { ...previous.video, formats } } : previous));
  }, []);

  return { ...state, diagnostics, setDiagnostics, replaceFormats, retry: () => setAttempt((value) => value + 1) };
}

export function VideoView({ active, videoId, title: previewTitle, thumbnailUrl: previewThumbnail }: {
  active: boolean;
  videoId: string;
  title?: string;
  thumbnailUrl?: string;
}) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const detail = useVideoDetail(videoId);
  const video = detail.video;
  const formats = useMemo(() => sortFormats(video?.formats ?? []), [video]);
  const preferred = app.settings.player.preferredQuality;
  const [quality, setQuality] = useState<string>();
  const selectedQuality = quality && formats.some((format) => format.id === quality)
    ? quality
    : (formats.find((format) => format.id === preferred) ?? formats[0])?.id;
  const title = video?.title ?? previewTitle ?? "";
  const thumbnail = video?.thumbnailUrl ?? previewThumbnail;

  if (detail.error && !video) {
    return (
      <View active={active} label={t("video.openFailed")}>
        <ListError error={detail.error} onRetry={detail.retry} />
      </View>
    );
  }

  const preferredMode = app.settings.player.preferredMode;
  const playerName = (mode: PlayerMode) => (mode === "mpv" ? t("player.mpv") : t("player.external"));
  const playing = app.isBusy(`play:${videoId}`);
  const play = (mode?: PlayerMode) => void app.play({ id: videoId, title }, { quality: selectedQuality, mode });

  return (
    <View active={active} label={title || t("video.loading")}>
      <div className="video-page">
        <div className="video-page__main">
          <div className="hero">
            {thumbnail && <div aria-hidden="true" className="hero__backdrop" style={{ backgroundImage: `url("${thumbnail}")` }} />}
            {thumbnail ? (
              <img alt="" className="hero__image" referrerPolicy="no-referrer" src={thumbnail} />
            ) : (
              <div className="video-card__placeholder">
                <Film aria-hidden="true" size={40} />
              </div>
            )}
            <button
              aria-busy={playing}
              aria-label={t("video.playIn", { player: playerName(preferredMode) })}
              className="hero__play"
              disabled={!formats.length || playing}
              onClick={() => play()}
              title={t("video.playIn", { player: playerName(preferredMode) })}
              type="button"
            >
              {playing || detail.loading ? <Spinner size={30} /> : <Play aria-hidden="true" fill="currentColor" size={32} />}
            </button>
            {video?.durationSeconds ? <span className="hero__duration">{formatDuration(video.durationSeconds)}</span> : null}
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {title ? <h1 className="video-title">{title}</h1> : <div className="skeleton" style={{ height: 28, width: "70%" }} />}
            {video ? (
              <div className="video-stats">
                <span className="video-stats__item" title={t("common.views", { count: video.numViews })}>
                  <Eye aria-hidden="true" size={15} />
                  {compactNumber(video.numViews, locale)}
                </span>
                <span className="video-stats__item" title={t("common.likes", { count: video.numLikes })}>
                  <Heart aria-hidden="true" size={15} />
                  {compactNumber(video.numLikes, locale)}
                </span>
                <span className="video-stats__item" title={t("common.commentsCount", { count: video.numComments })}>
                  <MessageCircle aria-hidden="true" size={15} />
                  {compactNumber(video.numComments, locale)}
                </span>
                {video.createdAt && <span className="video-stats__item">{t("video.published", { date: formatDate(video.createdAt, locale) })}</span>}
                {video.rating === "ecchi" && <span className="badge badge--warning">{t("rating.ecchi")}</span>}
              </div>
            ) : (
              <div className="skeleton" style={{ height: 16, width: "40%" }} />
            )}
          </div>

          <ActionBar
            formats={formats}
            onPlay={play}
            playerName={playerName}
            playing={playing}
            selectedQuality={selectedQuality}
            title={title}
            video={video}
            videoId={videoId}
          />

          {video && formats.length > 0 && (
            <div className="quality-picker">
              <span className="quality-picker__label" id={`quality-${videoId}`}>{t("video.quality")}</span>
              <Segmented
                label={t("video.quality")}
                onChange={setQuality}
                options={formats.map((format) => ({ value: format.id, label: qualityLabel(format.label) }))}
                value={selectedQuality ?? ""}
              />
            </div>
          )}
          {video && !formats.length && (
            <div className="inline-notice inline-notice--warning">
              <Film aria-hidden="true" size={16} />
              <span>{video.embedUrl ? t("video.embedOnly") : t("video.noFormats")}</span>
              {video.embedUrl && /^https?:\/\//.test(video.embedUrl) && (
                <button className="button button--sm" onClick={() => app.openExternal(video.embedUrl!)} style={{ marginLeft: "auto" }} type="button">
                  {t("video.openEmbed")}
                  <ArrowUpRight aria-hidden="true" size={14} />
                </button>
              )}
            </div>
          )}

          {video && <Description text={video.description} />}
          {video && <Tags tags={video.tags} />}
          {video && <Comments total={video.numComments} videoId={video.id} />}
        </div>

        <aside className="video-page__side">
          {video ? (
            <AuthorCard video={video} />
          ) : (
            <div className="panel">
              <div className="skeleton" style={{ height: 48, width: "100%" }} />
            </div>
          )}
          {video && (
            <Troubleshooting
              diagnostics={detail.diagnostics}
              onDiagnostics={detail.setDiagnostics}
              onFormats={detail.replaceFormats}
              video={video}
            />
          )}
          {!video && detail.loading && <p className="subtle">{t("video.loading")}</p>}
        </aside>
      </div>
    </View>
  );
}

function ActionBar({
  video,
  videoId,
  title,
  formats,
  selectedQuality,
  playing,
  playerName,
  onPlay
}: {
  video?: VideoDetail;
  videoId: string;
  title: string;
  formats: VideoFormat[];
  selectedQuality?: string;
  playing: boolean;
  playerName: (mode: PlayerMode) => string;
  onPlay: (mode?: PlayerMode) => void;
}) {
  const { t } = useI18n();
  const app = useAppState();
  const preferredMode = app.settings.player.preferredMode;
  const favorite = app.favoriteIds.has(videoId);
  const downloadStatus = app.downloadStatus(videoId);
  const downloadBusy = app.isBusy(`download:${videoId}`) || downloadStatus === "active";
  const pageUrl = iwaraVideoPageUrl(videoId);

  return (
    <div className="action-bar">
      <div className="button-group">
        <button className="button button--primary button--lg" disabled={!formats.length || playing} onClick={() => onPlay()} type="button">
          {playing ? <Spinner /> : <Play aria-hidden="true" fill="currentColor" size={16} />}
          {t("video.playIn", { player: playerName(preferredMode) })}
        </button>
        <MenuButton
          className="button button--primary button--lg button--icon"
          items={(["mpv", "external"] as PlayerMode[]).map((mode) => ({
            label: t("video.playIn", { player: playerName(mode) }),
            Icon: Play,
            onSelect: () => onPlay(mode),
            disabled: !formats.length
          }))}
          label={t("video.playOptions")}
          align="start"
        >
          <ChevronDown aria-hidden="true" size={16} />
        </MenuButton>
      </div>
      <button
        aria-busy={downloadBusy}
        className="button button--lg"
        disabled={!formats.length || downloadBusy}
        onClick={() => void app.download({ id: videoId, title }, selectedQuality)}
        type="button"
      >
        {downloadBusy ? <Spinner /> : downloadStatus === "completed" ? <CircleCheck aria-hidden="true" size={16} /> : <Download aria-hidden="true" size={16} />}
        {downloadBusy ? t("video.downloading") : downloadStatus === "completed" ? t("video.downloaded") : t("video.download")}
        {!downloadBusy && selectedQuality ? <span className="badge">{qualityLabel(selectedQuality)}</span> : null}
      </button>
      <button
        aria-pressed={favorite}
        className="button button--lg"
        disabled={!video || app.isBusy(`favorite:${videoId}`)}
        onClick={() => video && void app.toggleFavorite(video)}
        type="button"
      >
        <Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} size={16} />
        {favorite ? t("video.favorited") : t("video.favorite")}
      </button>
      <MenuButton
        className="button button--lg button--icon"
        items={[
          { label: t("common.openOnIwara"), Icon: ArrowUpRight, onSelect: () => app.openExternal(pageUrl) },
          { label: t("common.copyLink"), Icon: Copy, onSelect: () => void app.copyText(pageUrl) }
        ]}
        label={t("common.more")}
      >
        <Ellipsis aria-hidden="true" size={18} />
      </MenuButton>
    </div>
  );
}

function Description({ text }: { text?: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const long = Boolean(text && (text.length > 360 || text.split("\n").length > 6));
  return (
    <section className="panel" aria-label={t("video.description")}>
      <h2 className="panel__title">{t("video.description")}</h2>
      {text ? (
        <>
          <p className={long && !expanded ? "description description--clamped" : "description"}>{text}</p>
          {long && (
            <button aria-expanded={expanded} className="button button--ghost button--sm" onClick={() => setExpanded((value) => !value)} style={{ justifySelf: "start" }} type="button">
              {expanded ? t("common.showLess") : t("common.showMore")}
            </button>
          )}
        </>
      ) : (
        <p className="subtle">{t("video.noDescription")}</p>
      )}
    </section>
  );
}

function Tags({ tags }: { tags: string[] }) {
  const { t } = useI18n();
  const app = useAppState();
  const navigation = useNavigationActions();
  const followed = new Set(app.settings.tagPreferences.followedTags);
  const blocked = new Set(app.settings.tagPreferences.blockedTags);

  return (
    <section className="panel" aria-label={t("video.tags")}>
      <h2 className="panel__title">
        <Tag aria-hidden="true" size={16} />
        {t("video.tags")}
      </h2>
      {tags.length ? (
        <div className="chip-list">
          {tags.map((tag) => {
            const key = normalizeTag(tag);
            const isFollowed = followed.has(key);
            const isBlocked = blocked.has(key);
            return (
              <MenuButton
                align="start"
                className={isBlocked ? "chip chip--danger" : isFollowed ? "chip chip--accent" : "chip"}
                items={[
                  { label: t("video.tagFilter"), Icon: Search, onSelect: () => navigation.browseTag(tag) },
                  "separator",
                  { label: isFollowed ? t("video.tagUnfollow") : t("video.tagFollow"), Icon: Heart, onSelect: () => void app.toggleFollowTag(tag) },
                  { label: isBlocked ? t("video.tagUnblock") : t("video.tagBlock"), Icon: Ban, danger: !isBlocked, onSelect: () => void app.toggleBlockTag(tag) }
                ]}
                key={tag}
                label={t("video.tagMenu", { tag })}
              >
                {isFollowed && <Heart aria-hidden="true" fill="currentColor" size={11} />}
                {isBlocked && <Ban aria-hidden="true" size={11} />}
                {tag}
              </MenuButton>
            );
          })}
        </div>
      ) : (
        <p className="subtle">{t("video.noTags")}</p>
      )}
    </section>
  );
}

function AuthorCard({ video }: { video: VideoDetail }) {
  const { t } = useI18n();
  const app = useAppState();
  const navigation = useNavigationActions();
  const name = video.uploaderName ?? video.uploaderUsername ?? t("common.unknownAuthor");
  const following = app.isFollowing(video.uploaderId, video.uploaderFollowing);
  const busy = Boolean(video.uploaderId && app.isBusy(`follow:${video.uploaderId}`));
  const signedIn = app.auth.status === "signed-in";
  const author = video.uploaderId
    ? { id: video.uploaderId, name: video.uploaderName, username: video.uploaderUsername, avatarUrl: video.uploaderAvatarUrl, following }
    : undefined;

  return (
    <section aria-label={t("author.title")} className="panel author-card">
      <div className="author-card__head">
        <Avatar name={name} size={48} url={video.uploaderAvatarUrl} />
        <div className="author-card__copy">
          <button className="author-card__name" disabled={!author} onClick={() => author && navigation.openAuthor(author)} type="button">
            {name}
          </button>
          {video.uploaderUsername && <span className="author-card__handle">@{video.uploaderUsername}</span>}
        </div>
      </div>
      <div className="author-card__actions">
        <button
          aria-pressed={following}
          className={following ? "button" : "button button--primary"}
          disabled={!author || busy}
          onClick={() => author && void app.setAuthorFollowing(author, !following)}
          title={signedIn ? undefined : t("video.followSignIn")}
          type="button"
        >
          {busy ? <Spinner /> : following ? <UserCheck aria-hidden="true" size={16} /> : <UserPlus aria-hidden="true" size={16} />}
          {following ? t("video.following") : t("video.follow")}
        </button>
        <button className="button" disabled={!author} onClick={() => author && navigation.openAuthor(author)} type="button">
          {t("video.viewVideos")}
        </button>
      </div>
    </section>
  );
}

function Troubleshooting({
  video,
  diagnostics,
  onDiagnostics,
  onFormats
}: {
  video: VideoDetail;
  diagnostics?: IwaraVideoDiagnostics;
  onDiagnostics: (report: IwaraVideoDiagnostics) => void;
  onFormats: (formats: VideoFormat[]) => void;
}) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const [diagnosing, setDiagnosing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [speed, setSpeed] = useState<MediaSpeedTestReport>();
  const labels = (values: string[]) => (values.length ? values.map(qualityLabel).join(" / ") : t("video.noFormatsLabel"));

  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const report = await invoke("iwara:diagnose-video", video.id);
      onDiagnostics(report);
      const captured = report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? [];
      if (bestRank(captured) > bestRank(video.formats)) {
        onFormats(captured);
      }
    } catch (error) {
      app.reportError(error, () => void diagnose());
    } finally {
      setDiagnosing(false);
    }
  };

  const speedTest = async () => {
    setTesting(true);
    try {
      setSpeed(await invoke("iwara:speed-test-video", video.id));
    } catch (error) {
      app.reportError(error, () => void speedTest());
    } finally {
      setTesting(false);
    }
  };

  const networkEntries = diagnostics?.network?.entries.filter((entry) => entry.formatLabels.length) ?? [];

  return (
    <details className="disclosure" open={Boolean(diagnostics || speed) || undefined}>
      <summary>
        <Wrench aria-hidden="true" size={15} />
        {t("video.advanced")}
      </summary>
      <div className="disclosure__content">
        <p className="subtle">{t("video.advancedHint")}</p>
        <button className="button" disabled={diagnosing} onClick={() => void diagnose()} title={t("video.diagnoseHint")} type="button">
          {diagnosing ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
          {t("video.diagnose")}
        </button>
        {diagnostics && (
          <ul className="kv-list">
            <li>{t("video.diagnosticsApp", { labels: labels(diagnostics.appFormatLabels) })}</li>
            {diagnostics.probes.map((probe) => (
              <li className={probe.ok ? undefined : "is-error"} key={probe.label}>
                {t("video.diagnosticsProbe", {
                  label: probe.label,
                  result: probe.ok ? `HTTP ${probe.status ?? "—"} · ${labels(probe.formatLabels)}` : probe.error ?? "—"
                })}
              </li>
            ))}
            {networkEntries.length ? (
              networkEntries.map((entry, index) => (
                <li key={`${entry.url}-${index}`}>
                  {t("video.diagnosticsNetwork", {
                    status: entry.status ?? "—",
                    auth: entry.hasAuthorization ? t("video.withAuth") : t("video.withoutAuth"),
                    labels: labels(entry.formatLabels)
                  })}
                </li>
              ))
            ) : (
              <li>{diagnostics.network?.timedOut ? t("video.diagnosticsTimedOut") : t("video.diagnosticsNetworkNone")}</li>
            )}
          </ul>
        )}
        <button className="button" disabled={testing || !video.formats.length} onClick={() => void speedTest()} type="button">
          {testing ? <Spinner /> : <Gauge aria-hidden="true" size={16} />}
          {t("video.speedTest")}
        </button>
        {speed && (
          <ul className="kv-list">
            <li>{speed.fastestHost ? t("video.speedFastest", { host: speed.fastestHost }) : t("video.speedNone")}</li>
            {[...speed.results]
              .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))
              .map((result) => (
                <li className={result.ok ? undefined : "is-error"} key={result.host}>
                  {t("video.hostResult", { host: result.host, result: result.ok ? formatSpeed(result.bytesPerSecond, locale) : result.error ?? "—" })}
                </li>
              ))}
          </ul>
        )}
      </div>
    </details>
  );
}

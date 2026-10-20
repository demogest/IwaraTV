import { CircleCheck, Download, Eye, Film, Heart, Play, Star } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { PREVIEW_FRAME_COUNT, thumbnailFrameUrl } from "../../shared/thumbnails";
import type { VideoSummary } from "../../shared/types";
import { useI18n } from "../i18n";
import { compactNumber, formatDuration, relativeTime } from "../lib/format";
import { playLabel } from "../lib/player";
import { useAppState } from "../state/app-state";
import { useNavigationActions } from "../state/navigation";
import { Avatar, Spinner } from "./primitives";

interface VideoCardProps {
  video: VideoSummary;
  /** Hide the author link (e.g. on the author's own page). */
  hideAuthor?: boolean;
  /** Quick play continues in the built-in player (Continue watching). */
  resume?: boolean;
}

const HOVER_DELAY_MS = 350;
const FRAME_INTERVAL_MS = 650;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Cycles Iwara's preview frames while the pointer rests on a card. Each frame
 * is decoded before it is shown, so there is no blank flash; a frame that
 * fails to load ends the cycle, so videos with fewer frames still work.
 */
function useFramePreview(base: string | undefined) {
  const [frame, setFrame] = useState<number>();
  const count = useRef(PREVIEW_FRAME_COUNT);
  const timer = useRef<number | undefined>(undefined);
  const running = useRef(false);

  const stop = () => {
    running.current = false;
    window.clearTimeout(timer.current);
    setFrame(undefined);
  };
  const start = () => {
    if (!base || running.current || prefersReducedMotion()) {
      return;
    }
    running.current = true;
    let shown = -1;
    const advance = (delay: number) => {
      const next = (shown + 1) % count.current;
      const image = new Image();
      image.referrerPolicy = "no-referrer";
      image.src = thumbnailFrameUrl(base, next);
      const decoded = image.decode();
      timer.current = window.setTimeout(() => {
        decoded.then(
          () => {
            if (running.current) {
              shown = next;
              setFrame(next);
              advance(FRAME_INTERVAL_MS);
            }
          },
          () => {
            if (!running.current) {
              return;
            }
            if (next === 0) {
              stop();
            } else {
              // Fewer frames than expected: loop over the ones that exist.
              count.current = next;
              shown = -1;
              advance(0);
            }
          }
        );
      }, delay);
    };
    advance(HOVER_DELAY_MS);
  };
  useEffect(() => () => {
    running.current = false;
    window.clearTimeout(timer.current);
  }, []);

  return { frame, count: count.current, src: base && frame !== undefined ? thumbnailFrameUrl(base, frame) : undefined, start, stop };
}

function VideoCardView({ video, hideAuthor, resume }: VideoCardProps) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const navigation = useNavigationActions();
  const favorite = app.favoriteIds.has(video.id);
  const downloadStatus = app.downloadStatus(video.id);
  const playing = app.isBusy(`play:${video.id}`);
  const favoriteBusy = app.isBusy(`favorite:${video.id}`);
  const downloadBusy = app.isBusy(`download:${video.id}`) || downloadStatus === "active";
  const authorName = video.uploaderName ?? video.uploaderUsername ?? t("common.unknownAuthor");
  const open = () => navigation.openVideo(video.id, { title: video.title, thumbnailUrl: video.thumbnailUrl });
  const openAuthor = video.uploaderId
    ? () => navigation.openAuthor({
        id: video.uploaderId!,
        name: video.uploaderName,
        username: video.uploaderUsername,
        avatarUrl: video.uploaderAvatarUrl,
        following: video.uploaderFollowing
      })
    : undefined;
  const age = relativeTime(video.createdAt, locale);
  const preview = useFramePreview(video.thumbnailFramesBase);
  const progress = app.watchProgress(video.id);
  const playMode = resume ? "builtin" : app.settings.player.preferredMode;

  return (
    <article className="video-card">
      <div className="video-card__media" onMouseEnter={preview.start} onMouseLeave={preview.stop}>
        <button aria-label={video.title} className="video-card__thumb" onClick={open} tabIndex={-1} type="button">
          {video.thumbnailUrl || preview.src ? (
            <img
              alt=""
              decoding="async"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={preview.src ?? video.thumbnailUrl}
            />
          ) : (
            <span className="video-card__placeholder">
              <Film aria-hidden="true" size={28} />
            </span>
          )}
        </button>
        <div className="video-card__flags">
          {downloadStatus === "completed" && (
            <span className="video-card__flag video-card__flag--accent">
              <CircleCheck aria-hidden="true" size={12} />
              {t("video.downloaded")}
            </span>
          )}
        </div>
        {video.durationSeconds ? (
          <span className="video-card__duration">{formatDuration(video.durationSeconds)}</span>
        ) : null}
        {preview.frame !== undefined ? (
          <span aria-hidden="true" className="video-card__frames">
            <span style={{ width: `${((preview.frame + 1) / preview.count) * 100}%` }} />
          </span>
        ) : progress ? (
          <span aria-hidden="true" className="watch-progress">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        ) : null}
        <div className="video-card__actions">
          <button
            aria-busy={favoriteBusy}
            aria-label={favorite ? t("video.favorited") : t("video.favorite")}
            aria-pressed={favorite}
            className="video-card__action"
            disabled={favoriteBusy}
            onClick={() => void app.toggleFavorite(video)}
            title={favorite ? t("video.favorited") : t("video.favorite")}
            type="button"
          >
            <Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} size={16} />
          </button>
          <button
            aria-busy={downloadBusy}
            aria-label={downloadStatus === "completed" ? t("video.downloaded") : downloadBusy ? t("video.downloading") : t("video.download")}
            className="video-card__action"
            disabled={downloadBusy}
            onClick={() => void app.download(video)}
            title={downloadStatus === "completed" ? t("video.downloaded") : t("video.download")}
            type="button"
          >
            {downloadBusy ? <Spinner /> : downloadStatus === "completed" ? <CircleCheck aria-hidden="true" size={16} /> : <Download aria-hidden="true" size={16} />}
          </button>
        </div>
        <button
          aria-busy={playing}
          aria-label={resume ? t("history.resume") : playLabel(playMode, t)}
          className="video-card__play"
          disabled={playing}
          onClick={() => void app.play(video, resume ? { mode: "builtin" } : undefined)}
          type="button"
        >
          {playing ? <Spinner size={14} /> : <Play aria-hidden="true" fill="currentColor" size={14} />}
          {resume ? t("history.resume") : t("video.play")}
        </button>
      </div>
      <div className="video-card__body" style={hideAuthor ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
        {!hideAuthor && (
          <button
            aria-label={authorName}
            className="video-card__author-avatar"
            disabled={!openAuthor}
            onClick={openAuthor}
            tabIndex={-1}
            type="button"
          >
            <Avatar name={authorName} size={32} url={video.uploaderAvatarUrl} />
          </button>
        )}
        <div className="video-card__text">
          <button className="video-card__title" onClick={open} title={video.title} type="button">
            {video.title}
          </button>
          {!hideAuthor && (
            <button className="video-card__author" disabled={!openAuthor} onClick={openAuthor} type="button">
              {authorName}
            </button>
          )}
          <div className="video-card__stats">
            <span className="video-card__stat" title={t("common.views", { count: video.numViews })}>
              <Eye aria-hidden="true" size={13} />
              {compactNumber(video.numViews, locale)}
            </span>
            <span className="video-card__stat" title={t("common.likes", { count: video.numLikes })}>
              <Heart aria-hidden="true" size={13} />
              {compactNumber(video.numLikes, locale)}
            </span>
            {age && <span className="video-card__stat">{age}</span>}
          </div>
        </div>
      </div>
    </article>
  );
}

export const VideoCard = memo(VideoCardView);

export function VideoGrid({ videos, hideAuthor, resume, className }: { videos: VideoSummary[]; hideAuthor?: boolean; resume?: boolean; className?: string }) {
  return (
    <div className={className ? `video-grid ${className}` : "video-grid"}>
      {videos.map((video) => (
        <VideoCard hideAuthor={hideAuthor} key={video.id} resume={resume} video={video} />
      ))}
    </div>
  );
}

export function VideoGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div aria-busy="true" className="video-grid">
      {Array.from({ length: count }, (_, index) => (
        <div aria-hidden="true" className="video-card video-card--skeleton" key={index}>
          <div className="video-card__media skeleton" />
          <div className="video-card__body">
            <div className="skeleton" style={{ width: 32, height: 32, borderRadius: "50%" }} />
            <div className="video-card__text">
              <div className="skeleton skeleton-line" style={{ width: "92%" }} />
              <div className="skeleton skeleton-line" style={{ width: "60%" }} />
              <div className="skeleton skeleton-line" style={{ width: "40%" }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

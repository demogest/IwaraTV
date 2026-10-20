import { Eye, Film } from "lucide-react";
import { memo } from "react";
import type { VideoSummary } from "../../shared/types";
import { useI18n } from "../i18n";
import { compactNumber, formatDuration, relativeTime } from "../lib/format";
import { useAppState } from "../state/app-state";
import { useNavigationActions } from "../state/navigation";

/** A compact video entry for side lists (related videos, more from the author). */
function VideoRowView({ video }: { video: VideoSummary }) {
  const { t, locale } = useI18n();
  const navigation = useNavigationActions();
  const progress = useAppState().watchProgress(video.id);
  const open = () => navigation.openVideo(video.id, { title: video.title, thumbnailUrl: video.thumbnailUrl });
  const age = relativeTime(video.createdAt, locale);

  return (
    <li className="video-row">
      <button className="video-row__link" onClick={open} title={video.title} type="button">
        <span className="video-row__thumb">
          {video.thumbnailUrl ? (
            <img alt="" decoding="async" loading="lazy" referrerPolicy="no-referrer" src={video.thumbnailUrl} />
          ) : (
            <Film aria-hidden="true" size={20} />
          )}
          {video.durationSeconds ? <span className="video-row__duration">{formatDuration(video.durationSeconds)}</span> : null}
          {progress ? (
            <span aria-hidden="true" className="watch-progress">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          ) : null}
        </span>
        <span className="video-row__text">
          <span className="video-row__title">{video.title}</span>
          <span className="video-row__meta">{video.uploaderName ?? video.uploaderUsername ?? t("common.unknownAuthor")}</span>
          <span className="video-row__meta">
            <Eye aria-hidden="true" size={12} />
            {compactNumber(video.numViews, locale)}
            {age && <span aria-hidden="true">·</span>}
            {age}
          </span>
        </span>
      </button>
    </li>
  );
}

export const VideoRow = memo(VideoRowView);

export function VideoRowSkeleton() {
  return (
    <li aria-hidden="true" className="video-row">
      <span className="video-row__link">
        <span className="video-row__thumb skeleton" />
        <span className="video-row__text">
          <span className="skeleton skeleton-line" style={{ width: "90%" }} />
          <span className="skeleton skeleton-line" style={{ width: "55%" }} />
        </span>
      </span>
    </li>
  );
}

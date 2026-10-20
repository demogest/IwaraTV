import { RotateCcw, TriangleAlert, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { InlinePlayback } from "../state/app-state";

const PROGRESS_INTERVAL_MS = 10_000;
const SEEK_STEP_SECONDS = 5;
const VOLUME_KEY = "iwaratv.playerVolume";

function storedVolume(): { volume: number; muted: boolean } | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { volume?: unknown; muted?: unknown } | null;
    return raw && typeof raw.volume === "number" ? { volume: Math.min(Math.max(raw.volume, 0), 1), muted: raw.muted === true } : undefined;
  } catch {
    return undefined;
  }
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)));
}

/** Controls where Space and arrows already mean something (press, move between options). */
function ownsNavigationKeys(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (["BUTTON", "SUMMARY", "A", "VIDEO"].includes(element.tagName) || element.getAttribute("role") === "radio"));
}

interface InlinePlayerProps {
  playback: InlinePlayback;
  /** False while another view covers this one; playback pauses. */
  active: boolean;
  poster?: string;
  label: string;
  onClose(): void;
  onRetry(position: number): void;
  onProgress(positionSeconds: number, durationSeconds: number): void;
}

/**
 * The built-in player: a native <video> streaming from the main process's
 * `iwara-media://` proxy. Remembers volume, reports the position for resuming,
 * and adds YouTube-style keys (Space/K, ←/→, F, M) while the page is shown.
 */
export const InlinePlayer = forwardRef<HTMLVideoElement | null, InlinePlayerProps>(function InlinePlayer(
  { playback, active, poster, label, onClose, onRetry, onProgress },
  ref
) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const position = useRef({ current: playback.startAt, duration: 0 });
  const lastReport = useRef(0);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useImperativeHandle<HTMLVideoElement | null, HTMLVideoElement | null>(ref, () => videoRef.current, [playback.nonce]);

  const report = (force: boolean) => {
    const { current, duration } = position.current;
    if (duration <= 0 || (!force && Date.now() - lastReport.current < PROGRESS_INTERVAL_MS)) {
      return;
    }
    lastReport.current = Date.now();
    onProgressRef.current(current, duration);
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    setFailed(false);
    position.current = { current: playback.startAt, duration: 0 };
  }, [playback.nonce, playback.startAt]);

  // Save the position when leaving the page or switching to another video.
  useEffect(() => () => reportRef.current(true), [playback.videoId]);

  useEffect(() => {
    if (!active) {
      videoRef.current?.pause();
    }
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector("dialog[open]")) {
        return;
      }
      // Keep Space/arrows for a focused control (buttons, quality options, the <video> itself).
      const ownKeys = ownsNavigationKeys(event.target);
      switch (event.key) {
        case " ":
        case "k":
        case "K":
          if (ownKeys && event.key === " ") {
            return;
          }
          event.preventDefault();
          void (video.paused ? video.play().catch(() => undefined) : video.pause());
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (ownKeys) {
            return;
          }
          event.preventDefault();
          video.currentTime = Math.max(0, video.currentTime + (event.key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS));
          break;
        case "f":
        case "F":
          event.preventDefault();
          void (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()).catch(() => undefined);
          break;
        case "m":
        case "M":
          event.preventDefault();
          video.muted = !video.muted;
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return (
    <div className="player">
      <video
        aria-label={label}
        autoPlay
        className="player__video"
        controls
        key={playback.nonce}
        onEnded={() => report(true)}
        onError={() => setFailed(true)}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          const saved = storedVolume();
          if (saved) {
            video.volume = saved.volume;
            video.muted = saved.muted;
          }
          position.current.duration = Number.isFinite(video.duration) ? video.duration : 0;
          if (playback.startAt > 0 && playback.startAt < video.duration) {
            video.currentTime = playback.startAt;
          }
        }}
        onPause={() => report(true)}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          position.current = { current: video.ended ? video.duration : video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0 };
          report(false);
        }}
        onVolumeChange={(event) => {
          try {
            localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: event.currentTarget.volume, muted: event.currentTarget.muted }));
          } catch {
            // Remembering the volume is optional.
          }
        }}
        playsInline
        poster={poster}
        preload="auto"
        ref={videoRef}
        src={playback.streamUrl}
      />
      {failed && (
        <div className="player__error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <strong>{t("video.playerError")}</strong>
          <span>{t("video.playerErrorHint")}</span>
          <button className="button button--primary" onClick={() => onRetry(position.current.current)} type="button">
            <RotateCcw aria-hidden="true" size={16} />
            {t("actions.retry")}
          </button>
        </div>
      )}
      <button aria-label={t("video.closePlayer")} className="player__close" onClick={onClose} title={t("video.closePlayer")} type="button">
        <X aria-hidden="true" size={18} />
      </button>
    </div>
  );
});

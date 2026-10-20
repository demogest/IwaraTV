import { CircleArrowUp, ExternalLink, FolderOpen, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { UpdateState } from "../../shared/types";
import { useI18n, type TranslationKey } from "../i18n";
import { describeErrorCode } from "../lib/errors";
import { formatBytes, formatDate } from "../lib/format";
import { useAppState } from "../state/app-state";
import { useUpdates } from "../state/updates";
import { Spinner } from "./primitives";
import { ReleaseNotes } from "./ReleaseNotes";

/** What the main button does once the file is downloaded, by install type. */
function finishLabel(state: UpdateState): TranslationKey {
  if (state.strategy === "automatic") {
    return "updates.restart";
  }
  if (state.installKind === "deb") {
    return "updates.openInstaller";
  }
  return state.installKind === "dmg" ? "updates.openDiskImage" : "updates.showFile";
}

export function UpdateDialog() {
  const { t, locale } = useI18n();
  const app = useAppState();
  const updates = useUpdates();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { state, dialogOpen } = updates;
  const update = state.update;
  const open = dialogOpen && Boolean(update);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  }, [open]);

  const progress = state.progress;
  const percent = progress && progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  const error = state.status === "error" && state.error ? describeErrorCode(state.error.code, state.error.message, t, state.error.details) : undefined;
  const canDownload = Boolean(update?.fileName) && state.strategy !== "none";
  const howTo = state.strategy === "automatic" ? "updates.readyAutomatic" : (`updates.howTo.${state.installKind}` as TranslationKey);

  return (
    <dialog
      aria-labelledby="update-title"
      className="dialog dialog--wide"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          updates.closeDialog();
        }
      }}
      onClose={updates.closeDialog}
      ref={dialogRef}
    >
      {open && update && (
        <div className="dialog__panel update-dialog">
          <div className="update-dialog__head">
            <span className="update-dialog__icon">
              <CircleArrowUp aria-hidden="true" size={22} />
            </span>
            <div className="update-dialog__heading">
              <h2 className="dialog__title" id="update-title">{t("updates.title", { version: update.version })}</h2>
              <span className="subtle update-dialog__meta">
                {[
                  t("updates.meta", { current: state.currentVersion }),
                  update.publishedAt ? t("updates.released", { date: formatDate(update.publishedAt, locale) }) : undefined
                ].filter(Boolean).join(" · ")}
                {" · "}
                <button className="update-dialog__link" onClick={() => app.openExternal(update.releaseUrl)} type="button">
                  {t("updates.fullNotes")}
                  <ExternalLink aria-hidden="true" size={12} />
                </button>
              </span>
            </div>
            <button aria-label={t("common.close")} className="button button--ghost button--icon" onClick={updates.closeDialog} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </div>

          {update.breaking && (
            <div className="inline-notice inline-notice--warning" role="note">
              <TriangleAlert aria-hidden="true" size={16} />
              <span>
                <strong>{t("updates.breakingTitle")}.</strong> {t("updates.breakingBody")}
              </span>
            </div>
          )}

          <section aria-label={t("updates.notes")} className="update-dialog__notes">
            {update.notes ? <ReleaseNotes hideTitle markdown={update.notes} /> : <p className="subtle">{t("updates.noNotes")}</p>}
          </section>

          {state.status === "downloading" && (
            <div className="update-dialog__progress">
              <div aria-label={t("updates.downloading")} aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="progress" role="progressbar">
                <div className="progress__bar" style={{ width: `${percent}%` }} />
              </div>
              <span className="subtle">
                {t("updates.progress", {
                  received: formatBytes(progress?.received ?? 0, locale),
                  total: formatBytes(progress?.total ?? update.size, locale)
                })}
              </span>
            </div>
          )}
          {state.status === "ready" && (
            <div className="inline-notice inline-notice--success" role="status">
              <CircleArrowUp aria-hidden="true" size={16} />
              <span>{t(howTo)}</span>
            </div>
          )}
          {!canDownload && <p className="subtle">{t("updates.noFile")}</p>}
          {error && (
            <div className="inline-notice inline-notice--danger" role="alert">
              <TriangleAlert aria-hidden="true" size={16} />
              <span>
                <strong>{error.title}.</strong> {error.detail}
              </span>
            </div>
          )}

          <div className="dialog__actions update-dialog__actions">
            {state.status !== "ready" && state.status !== "downloading" && !update.skipped && (
              <button className="button button--ghost update-dialog__skip" disabled={updates.busy} onClick={() => void updates.skip()} type="button">
                {t("updates.skip")}
              </button>
            )}
            <button className="button" onClick={updates.closeDialog} type="button">
              {t("updates.later")}
            </button>
            {state.status === "ready" ? (
              <button autoFocus className="button button--primary" disabled={updates.busy} onClick={() => void updates.install()} type="button">
                {state.strategy === "automatic" ? <RotateCw aria-hidden="true" size={16} /> : <FolderOpen aria-hidden="true" size={16} />}
                {t(finishLabel(state))}
              </button>
            ) : state.status === "downloading" ? (
              <button className="button button--primary" disabled type="button">
                <Spinner />
                {t("updates.downloadingShort", { percent })}
              </button>
            ) : canDownload ? (
              <button autoFocus className="button button--primary" disabled={updates.busy} onClick={() => void updates.download()} type="button">
                {updates.busy ? <Spinner /> : <CircleArrowUp aria-hidden="true" size={16} />}
                {update.size ? t("updates.downloadSize", { size: formatBytes(update.size, locale) }) : t("updates.download")}
              </button>
            ) : (
              <button autoFocus className="button button--primary" onClick={() => app.openExternal(update.releaseUrl)} type="button">
                <ExternalLink aria-hidden="true" size={16} />
                {t("updates.viewRelease")}
              </button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

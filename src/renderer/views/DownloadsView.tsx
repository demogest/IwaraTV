import { CircleStop, Download, Ellipsis, FolderOpen, Play, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { DownloadTask } from "../../shared/types";
import { EmptyList } from "../components/ListStatus";
import { MenuButton } from "../components/MenuButton";
import { PageHeader, Tabs, View } from "../components/primitives";
import { useI18n, type TranslationKey } from "../i18n";
import { invoke } from "../lib/api";
import { describeErrorCode } from "../lib/errors";
import { formatBytes, formatDateTime, formatRemaining, formatSpeed, qualityLabel } from "../lib/format";
import { useAppState, useDownloads } from "../state/app-state";
import { useConfirm } from "../state/confirm";
import { useNavigationActions } from "../state/navigation";
import { useToasts } from "../state/toasts";

type Filter = "all" | "active" | "completed" | "failed";

export function DownloadsView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const downloads = useDownloads();
  const confirm = useConfirm();
  const { push } = useToasts();
  const [filter, setFilter] = useState<Filter>("all");
  const folder = app.settings.download.directory;

  const counts = useMemo(() => ({
    active: downloads.active.length,
    completed: downloads.history.filter((task) => task.status === "completed").length,
    failed: downloads.history.filter((task) => task.status === "failed" || task.status === "canceled").length
  }), [downloads]);

  const tasks = useMemo(() => {
    switch (filter) {
      case "active":
        return downloads.active;
      case "completed":
        return downloads.history.filter((task) => task.status === "completed");
      case "failed":
        return downloads.history.filter((task) => task.status === "failed" || task.status === "canceled");
      default:
        return [...downloads.active, ...downloads.history];
    }
  }, [downloads, filter]);

  const act = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) {
        push({ tone: "success", title: success });
      }
    } catch (error) {
      app.reportError(error);
    }
  };

  const remove = async (task: DownloadTask) => {
    if (task.status !== "completed") {
      await act(() => invoke("downloads:delete", { id: task.id, deleteFile: true }), t("downloads.removedToast"));
      return;
    }
    const result = await confirm({
      title: t("downloads.deleteTitle"),
      body: t("downloads.deleteBody", { title: task.video?.title ?? task.videoId }),
      confirmLabel: t("downloads.deleteFile"),
      secondaryLabel: t("downloads.removeOnly"),
      tone: "danger"
    });
    if (result === "confirm") {
      await act(() => invoke("downloads:delete", { id: task.id, deleteFile: true }), t("downloads.deletedToast"));
    } else if (result === "secondary") {
      await act(() => invoke("downloads:delete", { id: task.id, deleteFile: false }), t("downloads.removedToast"));
    }
  };

  const clearList = async () => {
    const result = await confirm({
      title: t("downloads.clearTitle"),
      body: t("downloads.clearBody"),
      confirmLabel: t("downloads.clearList")
    });
    if (result === "confirm") {
      await act(() => invoke("downloads:clear-finished"));
    }
  };

  return (
    <View active={active} label={t("downloads.title")}>
      <PageHeader
        subtitle={folder ? t("downloads.subtitle", { folder }) : t("downloads.subtitleNoFolder")}
        title={t("downloads.title")}
      >
        <button className="button" onClick={() => void act(() => invoke("downloads:open-directory"))} type="button">
          <FolderOpen aria-hidden="true" size={16} />
          {t("downloads.openFolder")}
        </button>
        <button className="button button--ghost" disabled={!downloads.history.length} onClick={() => void clearList()} type="button">
          <Trash2 aria-hidden="true" size={16} />
          {t("downloads.clearList")}
        </button>
      </PageHeader>

      <Tabs
        idPrefix="downloads"
        label={t("downloads.title")}
        onChange={setFilter}
        options={[
          { value: "all", label: t("downloads.filterAll") },
          { value: "active", label: t("downloads.filterActive"), count: counts.active },
          { value: "completed", label: t("downloads.filterCompleted"), count: counts.completed },
          { value: "failed", label: t("downloads.filterFailed"), count: counts.failed }
        ]}
        value={filter}
      />

      <div aria-labelledby={`downloads-tab-${filter}`} id="downloads-panel" role="tabpanel" style={{ paddingTop: 20 }}>
        {tasks.length ? (
          <ul className="row-list">
            {tasks.map((task) => (
              <DownloadRow key={task.id} onAction={act} onRemove={remove} task={task} />
            ))}
          </ul>
        ) : downloads.active.length + downloads.history.length === 0 ? (
          <EmptyList Icon={Download} body={t("downloads.emptyBody")} title={t("downloads.emptyTitle")} />
        ) : (
          <EmptyList Icon={Download} title={t("downloads.emptyFiltered")} />
        )}
      </div>
    </View>
  );
}

function DownloadRow({
  task,
  onAction,
  onRemove
}: {
  task: DownloadTask;
  onAction: (action: () => Promise<unknown>, success?: string) => Promise<void>;
  onRemove: (task: DownloadTask) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const navigation = useNavigationActions();
  const title = task.video?.title ?? task.videoId;
  const isActive = task.status === "queued" || task.status === "downloading";
  const percent = task.totalBytes ? Math.min(100, (task.bytesWritten / task.totalBytes) * 100) : undefined;
  const remaining = task.totalBytes ? formatRemaining(task.totalBytes - task.bytesWritten, task.bytesPerSecond) : undefined;
  const open = () => navigation.openVideo(task.videoId, { title: task.video?.title, thumbnailUrl: task.video?.thumbnailUrl });
  const errorText = task.status === "failed"
    ? describeErrorCode(task.errorCode ?? "DOWNLOAD_FAILED", task.error ?? "", t).detail
    : undefined;
  const statusTone = task.status === "completed" ? "badge--accent" : task.status === "failed" ? "badge--danger" : task.status === "canceled" ? "" : "badge--info";

  return (
    <li className="row">
      <button aria-label={title} className="row__thumb" onClick={open} tabIndex={-1} type="button">
        {task.video?.thumbnailUrl ? (
          <img alt="" loading="lazy" referrerPolicy="no-referrer" src={task.video.thumbnailUrl} />
        ) : (
          <span className="row__thumb-placeholder">
            <Download aria-hidden="true" size={20} />
          </span>
        )}
      </button>
      <div className="row__main">
        <button className="row__title" onClick={open} title={title} type="button">
          {title}
        </button>
        <div className="row__meta">
          <span className={`badge ${statusTone}`}>{t(`downloads.status.${task.status}` as TranslationKey)}</span>
          {(task.format?.label ?? task.requestedQuality) && <span>{qualityLabel(task.format?.label ?? task.requestedQuality!)}</span>}
          {!isActive && task.totalBytes ? <span>{formatBytes(task.totalBytes, locale)}</span> : null}
          {task.fallbackFrom && task.format && (
            <span>{t("downloads.fallback", { requested: qualityLabel(task.fallbackFrom), actual: qualityLabel(task.format.label) })}</span>
          )}
          {!isActive && <span>{formatDateTime(task.completedAt ?? task.updatedAt, locale)}</span>}
        </div>
        {isActive && (
          <div className="row__progress">
            <div
              aria-label={title}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
              className={percent === undefined ? "progress progress--indeterminate" : "progress"}
              role="progressbar"
            >
              <div className="progress__bar" style={{ width: `${percent ?? 0}%` }} />
            </div>
            <div className="row__progress-meta">
              <span>
                {formatBytes(task.bytesWritten, locale)}
                {task.totalBytes ? ` / ${formatBytes(task.totalBytes, locale)}` : ""}
                {percent !== undefined ? ` · ${Math.floor(percent)}%` : ""}
              </span>
              <span>
                {task.status === "downloading" && formatSpeed(task.bytesPerSecond, locale)}
                {remaining ? ` · ${t("downloads.remaining", { time: remaining })}` : ""}
              </span>
            </div>
          </div>
        )}
        {task.path && task.status === "completed" && <span className="row__path" title={task.path}>{task.path}</span>}
        {errorText && <span className="row__error">{errorText}</span>}
      </div>
      <div className="row__actions">
        {isActive && (
          <button className="button button--sm" onClick={() => void onAction(() => invoke("downloads:cancel", task.id), t("downloads.canceledToast"))} type="button">
            <CircleStop aria-hidden="true" size={15} />
            {t("downloads.cancel")}
          </button>
        )}
        {task.status === "completed" && (
          <>
            <button className="button button--sm button--primary" onClick={() => void onAction(() => invoke("downloads:open-file", task.id))} type="button">
              <Play aria-hidden="true" size={14} />
              {t("downloads.playFile")}
            </button>
            <button className="button button--sm" onClick={() => void onAction(() => invoke("downloads:show-in-folder", task.id))} type="button">
              <FolderOpen aria-hidden="true" size={15} />
              {t("downloads.showInFolder")}
            </button>
          </>
        )}
        {(task.status === "failed" || task.status === "canceled") && (
          <button className="button button--sm" onClick={() => void onAction(() => invoke("downloads:retry", task.id), t("downloads.resumed", { title }))} type="button">
            <RotateCcw aria-hidden="true" size={15} />
            {t("downloads.resume")}
          </button>
        )}
        {!isActive && (
          <MenuButton
            className="button button--sm button--ghost button--icon"
            items={[
              {
                label: task.status === "completed" ? t("downloads.delete") : t("downloads.remove"),
                Icon: Trash2,
                danger: true,
                onSelect: () => void onRemove(task)
              }
            ]}
            label={t("common.more")}
          >
            <Ellipsis aria-hidden="true" size={16} />
          </MenuButton>
        )}
      </div>
    </li>
  );
}

import { Ellipsis, History, Play, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { PlaybackHistoryItem } from "../../shared/types";
import { EmptyList } from "../components/ListStatus";
import { MenuButton } from "../components/MenuButton";
import { PageHeader, Spinner, View } from "../components/primitives";
import { useI18n, type TranslationKey } from "../i18n";
import { formatDate, formatTime, qualityLabel } from "../lib/format";
import { useAppState } from "../state/app-state";
import { useConfirm } from "../state/confirm";
import { useNavigationActions } from "../state/navigation";

type Group = "today" | "yesterday" | "thisWeek" | "older";

function groupOf(playedAt: string, now = new Date()): Group {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = Date.parse(playedAt);
  if (time >= startOfToday) {
    return "today";
  }
  if (time >= startOfToday - 86_400_000) {
    return "yesterday";
  }
  return time >= startOfToday - 6 * 86_400_000 ? "thisWeek" : "older";
}

export function HistoryView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const confirm = useConfirm();
  const history = app.settings.history;

  const groups = useMemo(() => {
    const result = new Map<Group, PlaybackHistoryItem[]>();
    for (const item of history) {
      const group = groupOf(item.playedAt);
      result.set(group, [...(result.get(group) ?? []), item]);
    }
    return (["today", "yesterday", "thisWeek", "older"] as Group[])
      .filter((group) => result.has(group))
      .map((group) => ({ group, items: result.get(group)! }));
  }, [history]);

  const clear = async () => {
    const result = await confirm({
      title: t("history.clearTitle"),
      body: t("history.clearBody", { count: history.length }),
      confirmLabel: t("history.clear"),
      tone: "danger"
    });
    if (result === "confirm") {
      await app.updateSettings({ history: [] });
    }
  };

  return (
    <View active={active} label={t("history.title")}>
      <PageHeader subtitle={t("history.subtitle")} title={t("history.title")}>
        <button className="button button--ghost" disabled={!history.length} onClick={() => void clear()} type="button">
          <Trash2 aria-hidden="true" size={16} />
          {t("history.clear")}
        </button>
      </PageHeader>

      {groups.length ? (
        groups.map(({ group, items }) => (
          <section aria-label={t(`history.${group}` as TranslationKey)} className="history-group" key={group}>
            <h2 className="history-group__title">{t(`history.${group}` as TranslationKey)}</h2>
            <ul className="row-list">
              {items.map((item) => (
                <HistoryRow item={item} key={`${item.video.id}-${item.playedAt}`} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <EmptyList Icon={History} body={t("history.emptyBody")} title={t("history.emptyTitle")} />
      )}
    </View>
  );
}

function HistoryRow({ item }: { item: PlaybackHistoryItem }) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const navigation = useNavigationActions();
  const { video } = item;
  const playing = app.isBusy(`play:${video.id}`);
  const open = () => navigation.openVideo(video.id, { title: video.title, thumbnailUrl: video.thumbnailUrl });
  const player = item.mode === "mpv" ? t("player.mpv") : t("player.external");
  const when = groupOf(item.playedAt) === "older" ? `${formatDate(item.playedAt, locale)} ${formatTime(item.playedAt, locale)}` : formatTime(item.playedAt, locale);

  return (
    <li className="row row--compact">
      <button aria-label={video.title} className="row__thumb" onClick={open} tabIndex={-1} type="button">
        {video.thumbnailUrl ? <img alt="" loading="lazy" referrerPolicy="no-referrer" src={video.thumbnailUrl} /> : <span className="row__thumb-placeholder" />}
      </button>
      <div className="row__main">
        <button className="row__title" onClick={open} title={video.title} type="button">
          {video.title}
        </button>
        <div className="row__meta">
          {video.uploaderName && <span>{video.uploaderName}</span>}
          <span>{when}</span>
          <span>{t("history.playedWith", { quality: qualityLabel(item.formatId), player })}</span>
        </div>
      </div>
      <div className="row__actions">
        <button
          aria-busy={playing}
          className="button button--sm"
          disabled={playing}
          onClick={() => void app.play(video, { quality: item.formatId, mode: item.mode })}
          type="button"
        >
          {playing ? <Spinner size={14} /> : <Play aria-hidden="true" size={14} />}
          {t("history.playAgain")}
        </button>
        <MenuButton
          className="button button--sm button--ghost button--icon"
          items={[
            {
              label: t("history.removeItem"),
              Icon: Trash2,
              danger: true,
              onSelect: () => void app.updateSettings({
                history: app.settings.history.filter((entry) => !(entry.video.id === video.id && entry.playedAt === item.playedAt))
              })
            }
          ]}
          label={t("common.more")}
        >
          <Ellipsis aria-hidden="true" size={16} />
        </MenuButton>
      </div>
    </li>
  );
}

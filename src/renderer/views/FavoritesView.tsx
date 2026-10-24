import { Download, Ellipsis, FolderOpen, Search, Shield, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyList } from "../components/ListStatus";
import { MenuButton } from "../components/MenuButton";
import { PageHeader, View, ViewHeader } from "../components/primitives";
import { VideoGrid } from "../components/VideoCard";
import { useI18n } from "../i18n";
import { invoke } from "../lib/api";
import { useAppState } from "../state/app-state";
import { useToasts } from "../state/toasts";

type FavoriteSort = "recent" | "title" | "views";

export function FavoritesView({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const { push } = useToasts();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<FavoriteSort>("recent");
  const items = app.favorites.items;

  const videos = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? items.filter(({ video }) =>
          [video.title, video.uploaderName, video.uploaderUsername, ...video.tags].some((value) => value?.toLowerCase().includes(needle))
        )
      : items;
    const sorted = [...matching];
    if (sort === "title") {
      sorted.sort((a, b) => a.video.title.localeCompare(b.video.title, locale));
    } else if (sort === "views") {
      sorted.sort((a, b) => b.video.numViews - a.video.numViews);
    }
    return sorted.map((item) => item.video);
  }, [items, filter, sort, locale]);

  const runFileAction = async (action: "backup" | "export" | "import") => {
    try {
      if (action === "backup") {
        const result = await invoke("favorites:backup");
        push({ tone: "success", title: t("favorites.backupDone", { count: result.count }), detail: result.path });
      } else if (action === "export") {
        const result = await invoke("favorites:export");
        if (!result.canceled) {
          push({ tone: "success", title: t("favorites.exportDone", { count: result.count }), detail: result.path });
        }
      } else {
        const result = await invoke("favorites:import");
        if (!result.canceled) {
          push({
            tone: "success",
            title: t("favorites.importDone", { imported: result.imported, merged: result.merged, skipped: result.skipped, total: result.total })
          });
        }
      }
    } catch (error) {
      app.reportError(error);
    }
  };

  return (
    <View active={active} label={t("favorites.title")}>
      <ViewHeader>
        <PageHeader
          subtitle={items.length ? `${t("favorites.subtitle")} · ${t("favorites.count", { count: items.length })}` : t("favorites.subtitle")}
          title={t("favorites.title")}
        >
          <button className="button" onClick={() => void runFileAction("import")} type="button">
            <FolderOpen aria-hidden="true" size={16} />
            {t("favorites.import")}
          </button>
          <MenuButton
            items={[
              { label: t("favorites.backup"), Icon: Shield, onSelect: () => void runFileAction("backup"), disabled: !items.length },
              { label: t("favorites.export"), Icon: Download, onSelect: () => void runFileAction("export"), disabled: !items.length }
            ]}
            label={t("common.more")}
          >
            <Ellipsis aria-hidden="true" size={18} />
          </MenuButton>
        </PageHeader>

        {items.length > 0 && (
          <div className="toolbar">
            <div className="input-with-icon toolbar__grow">
              <Search aria-hidden="true" size={16} />
              <input
                aria-label={t("favorites.filter")}
                className="input"
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("favorites.filter")}
                type="search"
                value={filter}
              />
            </div>
            <label className="toolbar__label" htmlFor="favorites-sort">
              {t("favorites.sortLabel")}
            </label>
            <select className="select" id="favorites-sort" onChange={(event) => setSort(event.target.value as FavoriteSort)} style={{ width: "auto" }} value={sort}>
              <option value="recent">{t("favorites.sortRecent")}</option>
              <option value="title">{t("favorites.sortTitle")}</option>
              <option value="views">{t("favorites.sortViews")}</option>
            </select>
          </div>
        )}
      </ViewHeader>

      {items.length ? (
        videos.length ? (
          <VideoGrid videos={videos} />
        ) : (
          <EmptyList Icon={Search} title={t("favorites.noMatches", { query: filter.trim() })} />
        )
      ) : (
        <EmptyList Icon={Star} body={t("favorites.emptyBody")} title={t("favorites.emptyTitle")}>
          <button className="button" onClick={() => void runFileAction("import")} type="button">
            <FolderOpen aria-hidden="true" size={16} />
            {t("favorites.importAction")}
          </button>
        </EmptyList>
      )}
    </View>
  );
}

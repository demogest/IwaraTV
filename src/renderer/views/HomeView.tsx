import { Compass, History, House, PlayCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PlaybackHistoryItem } from "../../shared/types";
import { EmptyList } from "../components/ListStatus";
import { PageHeader, View, ViewHeader } from "../components/primitives";
import { VideoGrid } from "../components/VideoCard";
import { useI18n } from "../i18n";
import { clearRecentSearches, readRecentSearches, removeRecentSearch } from "../lib/recent-searches";
import { useAppState } from "../state/app-state";
import { useNavigationActions } from "../state/navigation";

/** One row of cards; wider windows show more of them. */
const SHELF_SIZE = 8;

/** Started in the built-in player but not finished. */
function inProgress(entry: PlaybackHistoryItem): boolean {
  const fraction = entry.positionSeconds && entry.durationSeconds ? entry.positionSeconds / entry.durationSeconds : 0;
  return fraction > 0.02 && fraction < 0.95;
}

/** Everything recent in one place: unfinished videos, what was played lately and recent searches. */
export function HomeView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const navigation = useNavigationActions();
  const history = app.settings.history;
  const [searches, setSearches] = useState<string[]>(readRecentSearches);

  // Searches are saved by the top bar; pick up new ones whenever Home is shown again.
  useEffect(() => {
    if (active) {
      setSearches(readRecentSearches());
    }
  }, [active]);

  const { continueWatching, recentlyPlayed } = useMemo(() => {
    const unfinished = history.filter(inProgress);
    const unfinishedIds = new Set(unfinished.map((entry) => entry.video.id));
    return {
      continueWatching: unfinished.slice(0, SHELF_SIZE).map((entry) => entry.video),
      recentlyPlayed: history.filter((entry) => !unfinishedIds.has(entry.video.id)).slice(0, SHELF_SIZE).map((entry) => entry.video)
    };
  }, [history]);

  const viewHistory = (
    <button className="button button--ghost button--sm" onClick={() => navigation.goTo("history")} type="button">
      {t("home.viewHistory")}
    </button>
  );
  const empty = !continueWatching.length && !recentlyPlayed.length && !searches.length;

  return (
    <View active={active} label={t("home.title")}>
      <ViewHeader>
        <PageHeader subtitle={t("home.subtitle")} title={t("home.title")} />
      </ViewHeader>

      {empty ? (
        <EmptyList Icon={House} body={t("home.emptyBody")} title={t("home.emptyTitle")}>
          <button className="button button--primary" onClick={() => navigation.goTo("browse")} type="button">
            <Compass aria-hidden="true" size={16} />
            {t("home.browse")}
          </button>
          <button className="button" onClick={() => navigation.goTo("search")} type="button">
            <Search aria-hidden="true" size={16} />
            {t("home.search")}
          </button>
        </EmptyList>
      ) : (
        <>
          {continueWatching.length > 0 && (
            <section aria-labelledby="home-continue" className="shelf">
              <div className="shelf__header">
                <h2 className="shelf__title" id="home-continue">
                  <PlayCircle aria-hidden="true" size={17} />
                  {t("home.continueWatching")}
                </h2>
                {viewHistory}
              </div>
              <VideoGrid className="video-grid--shelf" resume videos={continueWatching} />
            </section>
          )}

          {recentlyPlayed.length > 0 && (
            <section aria-labelledby="home-recent" className="shelf">
              <div className="shelf__header">
                <h2 className="shelf__title" id="home-recent">
                  <History aria-hidden="true" size={17} />
                  {t("home.recentlyPlayed")}
                </h2>
                {!continueWatching.length && viewHistory}
              </div>
              <VideoGrid className="video-grid--shelf" videos={recentlyPlayed} />
            </section>
          )}

          {searches.length > 0 && (
            <section aria-labelledby="home-searches" className="shelf">
              <div className="shelf__header">
                <h2 className="shelf__title" id="home-searches">
                  <Search aria-hidden="true" size={17} />
                  {t("home.recentSearches")}
                </h2>
                <button
                  className="button button--ghost button--sm"
                  onClick={() => {
                    clearRecentSearches();
                    setSearches([]);
                  }}
                  type="button"
                >
                  {t("common.clear")}
                </button>
              </div>
              <div className="chip-list">
                {searches.map((query) => (
                  <span className="chip chip--search" key={query}>
                    <button className="chip__label" onClick={() => navigation.searchFor(query)} type="button">
                      {query}
                    </button>
                    <button
                      aria-label={t("omnibox.removeRecent", { query })}
                      className="chip__remove"
                      onClick={() => {
                        removeRecentSearch(query);
                        setSearches(readRecentSearches());
                      }}
                      title={t("omnibox.removeRecent", { query })}
                      type="button"
                    >
                      <X aria-hidden="true" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </View>
  );
}

import { RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitTagInput } from "../../shared/tags";
import type { ListVideosRequest, VideoSort } from "../../shared/types";
import { ChipInput } from "../components/ChipInput";
import { EmptyList, ListError, ListMeta, Pager } from "../components/ListStatus";
import { PageHeader, Segmented, Spinner, View, ViewHeader } from "../components/primitives";
import { VideoGrid, VideoGridSkeleton } from "../components/VideoCard";
import { useFrozenWhileHidden } from "../hooks/useFrozenWhileHidden";
import { scrollToTop } from "../hooks/useScrollMemory";
import { useVideoList } from "../hooks/useVideoList";
import { useI18n } from "../i18n";
import { useAppState } from "../state/app-state";
import { useNavigation } from "../state/navigation";
import { addRecentSearch } from "../lib/recent-searches";

type SearchSort = Extract<VideoSort, "relevance" | "date" | "views" | "likes">;

export function SearchView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const navigation = useNavigation();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [tags, setTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Remember what was searched for the top bar's suggestions.
  useEffect(() => addRecentSearch(query), [query]);

  const searchRequest = navigation.searchRequest;
  useEffect(() => {
    if (searchRequest) {
      setDraft(searchRequest.value);
      setQuery(searchRequest.value);
      setPage(0);
    }
  }, [searchRequest]);

  useEffect(() => {
    if (active && !searchRequest) {
      inputRef.current?.focus();
    }
    // Only when the view is first shown without a query.
  }, [active]);

  const request = useMemo<ListVideosRequest | undefined>(
    () => (query.trim() && app.ready ? { sort, page, query: query.trim(), tags, searchOnly: true } : undefined),
    [query, sort, page, tags, app.ready]
  );
  const list = useVideoList(useFrozenWhileHidden(request, active), useFrozenWhileHidden(app.settings.tagPreferences.blockedTags.join(","), active));
  const videos = list.data?.results ?? [];

  const goToPage = (next: number) => {
    setPage(next);
    scrollToTop(contentRef.current);
  };

  return (
    <View active={active} label={t("search.title")} refreshing={list.refreshing}>
      <ViewHeader>
        <PageHeader subtitle={t("search.subtitle")} title={t("search.title")}>
          <button className="button" disabled={!request || list.loading} onClick={list.reload} type="button">
            {list.loading || list.refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
            {t("common.refresh")}
          </button>
        </PageHeader>

        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
            setPage(0);
          }}
          role="search"
        >
          <div className="input-with-icon toolbar__grow">
            <Search aria-hidden="true" size={16} />
            <input
              aria-label={t("search.placeholder")}
              className="input"
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("search.placeholder")}
              ref={inputRef}
              type="search"
              value={draft}
            />
          </div>
          <button className="button button--primary" disabled={!draft.trim()} type="submit">
            {t("search.submit")}
          </button>
        </form>

        <div className="toolbar">
          <Segmented<SearchSort>
            label={t("search.sortLabel")}
            onChange={(next) => {
              setSort(next);
              setPage(0);
            }}
            options={[
              { value: "relevance", label: t("search.relevance") },
              { value: "date", label: t("search.date") },
              { value: "views", label: t("search.views") },
              { value: "likes", label: t("search.likes") }
            ]}
            value={sort}
          />
          <div className="toolbar__grow">
            <ChipInput
              label={t("browse.tagFilterLabel")}
              onChange={(next) => {
                setTags(next);
                setPage(0);
              }}
              placeholder={t("browse.tagFilter")}
              removeLabel={(tag) => `${t("common.remove")} ${tag}`}
              split={splitTagInput}
              values={tags}
            />
          </div>
        </div>
      </ViewHeader>

      <div ref={contentRef}>
        {!request ? (
          <EmptyList Icon={Search} body={t("search.promptBody")} title={t("search.promptTitle")} />
        ) : list.error && !videos.length ? (
          <ListError error={list.error} onRetry={list.reload} />
        ) : list.loading || !list.data ? (
          <VideoGridSkeleton />
        ) : videos.length ? (
          <>
            <ListMeta result={list.data}>
              {list.data.total ? <span className="list-meta__item">{t("search.results", { count: list.data.total })}</span> : null}
            </ListMeta>
            <VideoGrid videos={videos} />
            <Pager hasMore={list.data.hasMore} onPage={goToPage} page={page} />
          </>
        ) : (
          <EmptyList body={t("search.noResultsBody")} title={t("search.noResultsTitle", { query })} />
        )}
      </div>
    </View>
  );
}

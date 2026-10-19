import { Clock3, Flame, Heart, RefreshCw, Tag, TrendingUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeTagList, splitTagInput } from "../../shared/tags";
import type { ListVideosRequest, RatingFilter, VideoSort } from "../../shared/types";
import { ChipInput } from "../components/ChipInput";
import { EmptyList, ListError, ListMeta, Pager } from "../components/ListStatus";
import { PageHeader, Segmented, Spinner, Tabs, View } from "../components/primitives";
import { VideoGrid, VideoGridSkeleton } from "../components/VideoCard";
import { useFrozenWhileHidden } from "../hooks/useFrozenWhileHidden";
import { scrollToTop } from "../hooks/useScrollMemory";
import { useVideoList } from "../hooks/useVideoList";
import { useI18n } from "../i18n";
import { useAppState } from "../state/app-state";
import { useNavigation } from "../state/navigation";

type FeedTab = "latest" | "trending" | "popular" | "followed";

const SORT_BY_TAB: Record<FeedTab, VideoSort> = { latest: "date", trending: "trending", popular: "popularity", followed: "date" };

export function BrowseView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const navigation = useNavigation();
  const [tab, setTab] = useState<FeedTab>("latest");
  const [pages, setPages] = useState<Record<FeedTab, number>>({ latest: 0, trending: 0, popular: 0, followed: 0 });
  const [tags, setTags] = useState<string[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const rating = app.settings.ui.rating;
  const { followedTags, blockedTags } = app.settings.tagPreferences;
  const page = pages[tab];

  // "Browse videos with this tag" from a video page.
  const tagRequest = navigation.browseTagRequest;
  useEffect(() => {
    if (tagRequest) {
      setTags(normalizeTagList([tagRequest.value]));
      setTab((current) => (current === "followed" ? "latest" : current));
      setPages({ latest: 0, trending: 0, popular: 0, followed: 0 });
    }
  }, [tagRequest]);

  const followedMissing = tab === "followed" && followedTags.length === 0;
  const request = useMemo<ListVideosRequest | undefined>(
    () => !app.ready || followedMissing
      ? undefined
      : { sort: SORT_BY_TAB[tab], page, rating, tags, followedOnly: tab === "followed" || undefined },
    [app.ready, followedMissing, tab, page, rating, tags]
  );
  const cacheScope = `${blockedTags.join(",")}|${tab === "followed" ? followedTags.join(",") : ""}`;
  const list = useVideoList(useFrozenWhileHidden(request, active), useFrozenWhileHidden(cacheScope, active));

  const setPage = (next: number) => {
    setPages((current) => ({ ...current, [tab]: next }));
    scrollToTop(contentRef.current);
  };
  const setFilterTags = (next: string[]) => {
    setTags(next);
    setPages({ latest: 0, trending: 0, popular: 0, followed: 0 });
  };

  const subtitles: Record<FeedTab, string> = {
    latest: t("browse.subtitleLatest"),
    trending: t("browse.subtitleTrending"),
    popular: t("browse.subtitlePopular"),
    followed: t("browse.subtitleFollowed")
  };
  const videos = list.data?.results ?? [];

  return (
    <View active={active} label={t("browse.title")} refreshing={list.refreshing}>
      <PageHeader subtitle={subtitles[tab]} title={t("browse.title")}>
        <button className="button" disabled={list.loading || followedMissing} onClick={list.reload} type="button">
          {list.loading || list.refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
          {t("common.refresh")}
        </button>
      </PageHeader>

      <Tabs
        idPrefix="browse"
        label={t("browse.title")}
        onChange={setTab}
        options={[
          { value: "latest", label: t("feed.latest"), Icon: Clock3 },
          { value: "trending", label: t("feed.trending"), Icon: Flame },
          { value: "popular", label: t("feed.popular"), Icon: TrendingUp },
          { value: "followed", label: t("feed.followed"), Icon: Heart, count: followedTags.length || undefined }
        ]}
        value={tab}
      />

      <div aria-labelledby={`browse-tab-${tab}`} id="browse-panel" ref={contentRef} role="tabpanel" style={{ paddingTop: 20 }}>
        <div className="toolbar">
          <Segmented<RatingFilter>
            label={t("rating.label")}
            onChange={(next) => {
              void app.updateSettings({ ui: { rating: next } });
              setPages({ latest: 0, trending: 0, popular: 0, followed: 0 });
            }}
            options={[
              { value: "all", label: t("rating.all") },
              { value: "general", label: t("rating.general") },
              { value: "ecchi", label: t("rating.ecchi") }
            ]}
            value={rating}
          />
          <div className="toolbar__grow">
            <ChipInput
              label={t("browse.tagFilterLabel")}
              onChange={setFilterTags}
              placeholder={t("browse.tagFilter")}
              removeLabel={(tag) => `${t("common.remove")} ${tag}`}
              split={splitTagInput}
              values={tags}
            />
          </div>
        </div>

        {followedMissing ? (
          <EmptyList Icon={Tag} body={t("browse.followedEmptyBody")} title={t("browse.followedEmptyTitle")}>
            <button className="button button--primary" onClick={() => navigation.openSettings("content")} type="button">
              {t("browse.manageTags")}
            </button>
          </EmptyList>
        ) : list.error && !videos.length ? (
          <ListError error={list.error} onRetry={list.reload} />
        ) : list.loading || (!list.data && !list.error) ? (
          <VideoGridSkeleton />
        ) : videos.length ? (
          <>
            <ListMeta result={list.data} />
            <VideoGrid videos={videos} />
            <Pager disabled={list.loading} hasMore={list.data?.hasMore ?? false} onPage={setPage} page={page} />
          </>
        ) : (
          <EmptyList body={t("browse.emptyBody")} title={t("browse.emptyTitle")}>
            {tags.length > 0 && (
              <button className="button" onClick={() => setFilterTags([])} type="button">
                {t("common.clear")}
              </button>
            )}
          </EmptyList>
        )}
      </div>
    </View>
  );
}

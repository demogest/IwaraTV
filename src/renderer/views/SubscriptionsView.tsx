import { Bell, LogIn, RefreshCw, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ListVideosRequest, VideoSummary } from "../../shared/types";
import { EmptyList, ListError, ListMeta, Pager } from "../components/ListStatus";
import { Avatar, PageHeader, Spinner, View } from "../components/primitives";
import { VideoGrid, VideoGridSkeleton } from "../components/VideoCard";
import { useFrozenWhileHidden } from "../hooks/useFrozenWhileHidden";
import { scrollToTop } from "../hooks/useScrollMemory";
import { useVideoList } from "../hooks/useVideoList";
import { useI18n } from "../i18n";
import { useAppState } from "../state/app-state";

interface AuthorOption {
  id: string;
  name: string;
  avatarUrl?: string;
  count: number;
}

function authorKey(video: VideoSummary): string {
  return video.uploaderId ?? `name:${video.uploaderUsername ?? video.uploaderName ?? "?"}`;
}

export function SubscriptionsView({ active }: { active: boolean }) {
  const { t } = useI18n();
  const app = useAppState();
  const [page, setPage] = useState(0);
  const [author, setAuthor] = useState("all");
  const contentRef = useRef<HTMLDivElement>(null);
  const signedIn = app.auth.status === "signed-in";

  const request = useMemo<ListVideosRequest | undefined>(
    () => (signedIn && app.ready ? { sort: "date", page, subscribedOnly: true } : undefined),
    [signedIn, app.ready, page]
  );
  const list = useVideoList(useFrozenWhileHidden(request, active), useFrozenWhileHidden(app.settings.tagPreferences.blockedTags.join(","), active));
  const videos = list.data?.results ?? [];

  const authors = useMemo<AuthorOption[]>(() => {
    const map = new Map<string, AuthorOption>();
    for (const video of videos) {
      const key = authorKey(video);
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        existing.avatarUrl ??= video.uploaderAvatarUrl;
      } else {
        map.set(key, {
          id: key,
          name: video.uploaderName ?? video.uploaderUsername ?? t("common.unknownAuthor"),
          avatarUrl: video.uploaderAvatarUrl,
          count: 1
        });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [videos, t]);

  useEffect(() => {
    if (author !== "all" && !authors.some((option) => option.id === author)) {
      setAuthor("all");
    }
  }, [author, authors]);

  const visible = author === "all" ? videos : videos.filter((video) => authorKey(video) === author);

  return (
    <View active={active} label={t("subscriptions.title")} refreshing={list.refreshing}>
      <PageHeader subtitle={t("subscriptions.subtitle")} title={t("subscriptions.title")}>
        {signedIn && (
          <button className="button" disabled={list.loading} onClick={list.reload} type="button">
            {list.loading || list.refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
            {t("common.refresh")}
          </button>
        )}
      </PageHeader>

      <div ref={contentRef}>
        {!signedIn ? (
          app.authLoading ? (
            <VideoGridSkeleton count={8} />
          ) : (
            <EmptyList Icon={LogIn} body={t("subscriptions.signedOutBody")} title={t("subscriptions.signedOutTitle")}>
              <button className="button button--primary" onClick={() => void app.signIn()} type="button">
                <LogIn aria-hidden="true" size={16} />
                {t("subscriptions.signIn")}
              </button>
            </EmptyList>
          )
        ) : list.error && !videos.length ? (
          <ListError error={list.error} onRetry={list.reload} />
        ) : list.loading || !list.data ? (
          <VideoGridSkeleton />
        ) : videos.length ? (
          <>
            <div aria-label={t("subscriptions.authorFilter")} className="author-strip" role="radiogroup">
              <button aria-checked={author === "all"} className="author-strip__item" onClick={() => setAuthor("all")} role="radio" type="button">
                <span className="avatar" style={{ width: 30, height: 30 }}>
                  <Users aria-hidden="true" size={15} />
                </span>
                <span>{t("subscriptions.allAuthors")}</span>
              </button>
              {authors.map((option) => (
                <button
                  aria-checked={author === option.id}
                  className="author-strip__item"
                  key={option.id}
                  onClick={() => setAuthor(option.id)}
                  role="radio"
                  title={option.name}
                  type="button"
                >
                  <Avatar name={option.name} size={30} url={option.avatarUrl} />
                  <span>{option.name}</span>
                </button>
              ))}
            </div>
            <ListMeta result={list.data} />
            {visible.length ? <VideoGrid videos={visible} /> : <EmptyList Icon={UserRound} title={t("subscriptions.filteredEmpty")} />}
            <Pager
              hasMore={list.data.hasMore}
              onPage={(next) => {
                setPage(next);
                scrollToTop(contentRef.current);
              }}
              page={page}
            />
          </>
        ) : (
          <EmptyList Icon={Bell} body={t("subscriptions.emptyBody")} title={t("subscriptions.emptyTitle")} />
        )}
      </div>
    </View>
  );
}

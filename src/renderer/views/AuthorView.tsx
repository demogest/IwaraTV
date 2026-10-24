import { ArrowUpRight, RefreshCw, UserCheck, UserPlus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { splitTagInput } from "../../shared/tags";
import type { ListVideosRequest } from "../../shared/types";
import { iwaraProfilePageUrl } from "../../shared/video-id";
import { ChipInput } from "../components/ChipInput";
import { EmptyList, ListError, ListMeta, Pager } from "../components/ListStatus";
import { Avatar, Spinner, View, ViewHeader } from "../components/primitives";
import { VideoGrid, VideoGridSkeleton } from "../components/VideoCard";
import { useFrozenWhileHidden } from "../hooks/useFrozenWhileHidden";
import { scrollToTop } from "../hooks/useScrollMemory";
import { useVideoList } from "../hooks/useVideoList";
import { useI18n } from "../i18n";
import { useAppState } from "../state/app-state";
import type { AuthorRef } from "../state/navigation";

export function AuthorView({ active, author }: { active: boolean; author: AuthorRef }) {
  const { t } = useI18n();
  const app = useAppState();
  const [page, setPage] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);

  const request = useMemo<ListVideosRequest | undefined>(
    () => (app.ready ? { sort: "date", page, userId: author.id, tags } : undefined),
    [app.ready, page, author.id, tags]
  );
  const list = useVideoList(useFrozenWhileHidden(request, active), useFrozenWhileHidden(app.settings.tagPreferences.blockedTags.join(","), active));
  const videos = list.data?.results ?? [];

  // Fill in details the list knows better than the link we came from.
  const sample = videos.find((video) => video.uploaderId === author.id);
  const name = author.name ?? sample?.uploaderName ?? author.username ?? t("common.unknownAuthor");
  const username = author.username ?? sample?.uploaderUsername;
  const avatarUrl = author.avatarUrl ?? sample?.uploaderAvatarUrl;
  const following = app.isFollowing(author.id, author.following ?? sample?.uploaderFollowing);
  const busy = app.isBusy(`follow:${author.id}`);

  return (
    <View active={active} label={name} refreshing={list.refreshing}>
      <ViewHeader>
        <header className="author-hero">
          <Avatar name={name} size={84} url={avatarUrl} />
          <div className="author-hero__copy">
            <span className="subtle">{t("author.title")}</span>
            <h1 className="author-hero__name">{name}</h1>
            {username && <span className="muted">@{username}</span>}
          </div>
          <div className="author-hero__actions">
            <button
              aria-pressed={following}
              className={following ? "button" : "button button--primary"}
              disabled={busy}
              onClick={() => void app.setAuthorFollowing({ ...author, name, username, avatarUrl }, !following)}
              title={app.auth.status === "signed-in" ? undefined : t("video.followSignIn")}
              type="button"
            >
              {busy ? <Spinner /> : following ? <UserCheck aria-hidden="true" size={16} /> : <UserPlus aria-hidden="true" size={16} />}
              {following ? t("video.following") : t("video.follow")}
            </button>
            {username && (
              <button className="button" onClick={() => app.openExternal(iwaraProfilePageUrl(username))} type="button">
                {t("author.openProfile")}
                <ArrowUpRight aria-hidden="true" size={15} />
              </button>
            )}
            <button aria-label={t("common.refresh")} className="button button--icon" disabled={list.loading} onClick={list.reload} title={t("common.refresh")} type="button">
              {list.loading || list.refreshing ? <Spinner /> : <RefreshCw aria-hidden="true" size={16} />}
            </button>
          </div>
        </header>

        <div className="toolbar">
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
        {list.error && !videos.length ? (
          <ListError error={list.error} onRetry={list.reload} />
        ) : list.loading || !list.data ? (
          <VideoGridSkeleton />
        ) : videos.length ? (
          <>
            <ListMeta result={list.data} />
            <VideoGrid hideAuthor videos={videos} />
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
          <EmptyList body={t("browse.emptyBody")} title={t("browse.emptyTitle")} />
        )}
      </div>
    </View>
  );
}

import { CornerDownRight, LogIn, MessageCircle, RefreshCw, Send } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { VideoComment } from "../../shared/types";
import { Avatar, Spinner } from "../components/primitives";
import { useI18n } from "../i18n";
import { invoke } from "../lib/api";
import { compactNumber, modKey, relativeTime } from "../lib/format";
import { useAppState } from "../state/app-state";
import { useToasts } from "../state/toasts";

interface Thread {
  items: VideoComment[];
  page: number;
  hasMore: boolean;
  total: number;
  loading: boolean;
  error?: unknown;
}

const EMPTY_THREAD: Thread = { items: [], page: -1, hasMore: false, total: 0, loading: false };

export function Comments({ videoId, total: initialTotal }: { videoId: string; total: number }) {
  const { t, locale } = useI18n();
  const app = useAppState();
  const [thread, setThread] = useState<Thread>({ ...EMPTY_THREAD, total: initialTotal });
  const [replies, setReplies] = useState<Record<string, Thread & { open: boolean }>>({});
  const [replyTo, setReplyTo] = useState<string>();

  const loadPage = useCallback(async (page: number) => {
    setThread((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await invoke("iwara:list-comments", { videoId, page });
      setThread((current) => ({
        items: page === 0 ? result.comments : [...current.items, ...result.comments.filter((comment) => !current.items.some((item) => item.id === comment.id))],
        page,
        hasMore: result.hasMore,
        total: result.total,
        loading: false
      }));
    } catch (error) {
      setThread((current) => ({ ...current, loading: false, error }));
    }
  }, [videoId]);

  useEffect(() => {
    setThread({ ...EMPTY_THREAD, total: initialTotal });
    setReplies({});
    void loadPage(0);
  }, [videoId, initialTotal, loadPage]);

  const loadReplies = async (parentId: string, page: number) => {
    setReplies((current) => ({ ...current, [parentId]: { ...(current[parentId] ?? EMPTY_THREAD), open: true, loading: true } }));
    try {
      const result = await invoke("iwara:list-comments", { videoId, parentId, page });
      setReplies((current) => {
        const previous = current[parentId] ?? { ...EMPTY_THREAD, open: true };
        return {
          ...current,
          [parentId]: {
            items: page === 0 ? result.comments : [...previous.items, ...result.comments],
            page,
            hasMore: result.hasMore,
            total: result.total,
            loading: false,
            open: true
          }
        };
      });
    } catch (error) {
      setReplies((current) => ({ ...current, [parentId]: { ...(current[parentId] ?? EMPTY_THREAD), open: true, loading: false, error } }));
    }
  };

  const onPosted = (comment: VideoComment, parentId?: string) => {
    if (parentId) {
      setReplies((current) => {
        const previous = current[parentId] ?? { ...EMPTY_THREAD, page: 0, open: true };
        return { ...current, [parentId]: { ...previous, open: true, items: [...previous.items, comment], total: previous.total + 1 } };
      });
      setThread((current) => ({
        ...current,
        items: current.items.map((item) => (item.id === parentId ? { ...item, numReplies: item.numReplies + 1 } : item))
      }));
      setReplyTo(undefined);
    } else {
      setThread((current) => ({ ...current, items: [comment, ...current.items], total: current.total + 1 }));
    }
  };

  return (
    <section aria-label={t("comments.title")} className="panel comments">
      <h2 className="panel__title">
        <MessageCircle aria-hidden="true" size={16} />
        {t("comments.title")}
        <span className="panel__title-count">{compactNumber(thread.total, locale)}</span>
        <button
          aria-label={t("common.refresh")}
          className="button button--ghost button--icon button--sm"
          disabled={thread.loading}
          onClick={() => void loadPage(0)}
          style={{ marginLeft: "auto" }}
          title={t("common.refresh")}
          type="button"
        >
          {thread.loading ? <Spinner size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
        </button>
      </h2>

      {app.auth.status === "signed-in" ? (
        <Composer onPosted={(comment) => onPosted(comment)} placeholder={t("comments.placeholder")} videoId={videoId} />
      ) : (
        <div className="inline-notice">
          <LogIn aria-hidden="true" size={16} />
          <span style={{ flex: 1 }}>{t("comments.signInPrompt")}</span>
          <button className="button button--sm" onClick={() => void app.signIn()} type="button">
            {t("account.signIn")}
          </button>
        </div>
      )}

      {thread.error && !thread.items.length ? (
        <div className="inline-notice inline-notice--danger">
          <span style={{ flex: 1 }}>{t("comments.loadFailed")}</span>
          <button className="button button--sm" onClick={() => void loadPage(Math.max(thread.page, 0))} type="button">
            {t("common.retry")}
          </button>
        </div>
      ) : thread.page < 0 && thread.loading ? (
        <CommentSkeleton />
      ) : thread.items.length ? (
        <ul className="comment-list">
          {thread.items.map((comment) => {
            const replyThread = replies[comment.id];
            return (
              <li key={comment.id}>
                <CommentItem comment={comment}>
                  <div className="comment__actions">
                    {app.auth.status === "signed-in" && (
                      <button
                        aria-expanded={replyTo === comment.id}
                        className="button button--ghost button--sm"
                        onClick={() => setReplyTo((current) => (current === comment.id ? undefined : comment.id))}
                        type="button"
                      >
                        <CornerDownRight aria-hidden="true" size={14} />
                        {t("comments.reply")}
                      </button>
                    )}
                    {comment.numReplies > 0 && (
                      <button
                        aria-expanded={Boolean(replyThread?.open)}
                        className="button button--ghost button--sm"
                        disabled={replyThread?.loading}
                        onClick={() => {
                          if (replyThread?.open) {
                            setReplies((current) => ({ ...current, [comment.id]: { ...replyThread, open: false } }));
                          } else if (replyThread && replyThread.page >= 0) {
                            setReplies((current) => ({ ...current, [comment.id]: { ...replyThread, open: true } }));
                          } else {
                            void loadReplies(comment.id, 0);
                          }
                        }}
                        type="button"
                      >
                        {replyThread?.loading ? <Spinner size={13} /> : null}
                        {replyThread?.open ? t("comments.hideReplies") : t("comments.viewReplies", { count: comment.numReplies })}
                      </button>
                    )}
                  </div>
                  {replyTo === comment.id && (
                    <Composer
                      autoFocus
                      onPosted={(reply) => onPosted(reply, comment.id)}
                      parentId={comment.id}
                      placeholder={t("comments.replyPlaceholder", { name: comment.authorName ?? comment.authorUsername ?? "" })}
                      videoId={videoId}
                    />
                  )}
                  {replyThread?.open && replyThread.items.length > 0 && (
                    <ul className="comment-list comment__replies">
                      {replyThread.items.map((reply) => (
                        <li key={reply.id}>
                          <CommentItem comment={reply} small />
                        </li>
                      ))}
                      {replyThread.hasMore && (
                        <li>
                          <button
                            className="button button--ghost button--sm"
                            disabled={replyThread.loading}
                            onClick={() => void loadReplies(comment.id, replyThread.page + 1)}
                            type="button"
                          >
                            {replyThread.loading && <Spinner size={13} />}
                            {t("comments.loadMoreReplies")}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </CommentItem>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="subtle">{t("comments.empty")}</p>
      )}

      {thread.hasMore && (
        <button className="button" disabled={thread.loading} onClick={() => void loadPage(thread.page + 1)} style={{ justifySelf: "center" }} type="button">
          {thread.loading && <Spinner />}
          {t("comments.loadMore")}
        </button>
      )}
    </section>
  );
}

function CommentItem({ comment, small, children }: { comment: VideoComment; small?: boolean; children?: ReactNode }) {
  const { t, locale } = useI18n();
  const name = comment.authorName ?? comment.authorUsername ?? t("common.unknownAuthor");
  return (
    <article className="comment">
      <Avatar name={name} size={small ? 28 : 36} url={comment.authorAvatarUrl} />
      <div className="comment__main">
        <div className="comment__meta">
          <span className="comment__author">{name}</span>
          {comment.authorUsername && comment.authorUsername !== name && <span className="comment__time">@{comment.authorUsername}</span>}
          <time className="comment__time" dateTime={comment.createdAt} title={comment.createdAt}>
            {relativeTime(comment.createdAt, locale)}
          </time>
        </div>
        <p className="comment__body">{comment.body}</p>
        {children}
      </div>
    </article>
  );
}

function Composer({
  videoId,
  parentId,
  placeholder,
  onPosted,
  autoFocus
}: {
  videoId: string;
  parentId?: string;
  placeholder: string;
  onPosted: (comment: VideoComment) => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const app = useAppState();
  const { push } = useToasts();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    try {
      const comment = await invoke("iwara:send-comment", { videoId, body, parentId });
      setDraft("");
      onPosted(comment);
      push({ tone: "success", title: parentId ? t("comments.replyPosted") : t("comments.posted") });
    } catch (error) {
      app.reportError(error, () => void send());
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Avatar name={app.auth.username} size={parentId ? 28 : 36} url={app.auth.avatarUrl} />
      <div className="composer__box">
        <textarea
          aria-label={placeholder}
          autoFocus={autoFocus}
          className="textarea"
          disabled={sending}
          maxLength={5000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          rows={parentId ? 2 : 2}
          value={draft}
        />
        {(draft.trim() || parentId) && (
          <div className="composer__footer">
            <span className="subtle">{t("comments.sendHint", { keys: `${modKey()}+Enter` })}</span>
            <button className="button button--primary button--sm" disabled={!draft.trim() || sending} type="submit">
              {sending ? <Spinner size={14} /> : <Send aria-hidden="true" size={14} />}
              {t("comments.send")}
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

function CommentSkeleton() {
  return (
    <div aria-busy="true" className="comment-list">
      {[0, 1, 2].map((index) => (
        <div aria-hidden="true" className="comment" key={index}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: "50%" }} />
          <div className="comment__main">
            <div className="skeleton skeleton-line" style={{ width: "30%" }} />
            <div className="skeleton skeleton-line" style={{ width: "85%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

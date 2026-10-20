import { ChevronLeft, ChevronRight, Gauge, RefreshCw, SearchX, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { VideoListResult } from "../../shared/types";
import { useI18n } from "../i18n";
import { describeError, recoveryLabel } from "../lib/errors";
import { useAppState } from "../state/app-state";
import { StateMessage } from "./primitives";

export function Pager({
  page,
  hasMore,
  disabled,
  onPage
}: {
  page: number;
  hasMore: boolean;
  disabled?: boolean;
  onPage: (page: number) => void;
}) {
  const { t } = useI18n();
  if (page === 0 && !hasMore) {
    return null;
  }
  return (
    <nav aria-label={t("common.page", { page: page + 1 })} className="pager">
      <button className="button" disabled={disabled || page <= 0} onClick={() => onPage(page - 1)} type="button">
        <ChevronLeft aria-hidden="true" size={16} />
        {t("common.previous")}
      </button>
      <span aria-current="page" className="pager__label">{t("common.page", { page: page + 1 })}</span>
      <button className="button" disabled={disabled || !hasMore} onClick={() => onPage(page + 1)} type="button">
        {t("common.next")}
        <ChevronRight aria-hidden="true" size={16} />
      </button>
    </nav>
  );
}

/** Scan/blocked/partial-failure notes plus collapsible network details. */
export function ListMeta({ result, children }: { result?: VideoListResult; children?: ReactNode }) {
  const { t } = useI18n();
  const attempts = result?.networkDiagnostics?.attempts ?? [];
  const retries = attempts.filter((attempt) => attempt.attempt > 1).length;
  const showScan = Boolean(result && (result.scannedPages ?? 0) > 1);
  const notes = [
    showScan && <span className="list-meta__item" key="scan">{t("listNotice.scanned", { count: result!.scannedPages! })}</span>,
    result?.blockedCount ? <span className="list-meta__item" key="blocked">{t("listNotice.blocked", { count: result.blockedCount })}</span> : null,
    result?.partialFailures?.length ? (
      <span className="list-meta__item list-meta__item--warning" key="partial">
        <TriangleAlert aria-hidden="true" size={14} />
        {t("listNotice.partial")}
      </span>
    ) : null,
    retries ? <span className="list-meta__item" key="retries">{t("listNotice.retries", { count: retries })}</span> : null
  ].filter(Boolean);

  if (!children && !notes.length) {
    return null;
  }

  return (
    <div className="list-meta">
      {children}
      {notes}
      {(result?.partialFailures?.length || retries > 0) && attempts.length ? (
        <details>
          <summary>
            <Gauge aria-hidden="true" size={13} /> {t("listNotice.network")}
          </summary>
          <ul className="kv-list" style={{ marginTop: 8 }}>
            {attempts.map((attempt, index) => (
              <li className={attempt.ok ? undefined : "is-error"} key={`${attempt.endpoint}-${attempt.page}-${attempt.attempt}-${index}`}>
                {attempt.ok
                  ? t("listNotice.attemptOk", {
                      endpoint: attempt.endpoint,
                      page: attempt.page + 1,
                      attempt: attempt.attempt,
                      status: attempt.status ?? "—",
                      count: attempt.resultCount ?? 0,
                      ms: attempt.elapsedMs
                    })
                  : t("listNotice.attemptFailed", {
                      endpoint: attempt.endpoint,
                      page: attempt.page + 1,
                      attempt: attempt.attempt,
                      error: attempt.error ?? "",
                      ms: attempt.elapsedMs
                    })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Full-width error with the right recovery action (retry, sign in, settings…). */
export function ListError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  const app = useAppState();
  const description = describeError(error, t);
  const recovery = description.action && description.action !== "retry" ? description.action : undefined;
  return (
    <StateMessage Icon={TriangleAlert} body={description.detail} title={description.title} tone="error">
      <button className="button button--primary" onClick={onRetry} type="button">
        <RefreshCw aria-hidden="true" size={16} />
        {t("common.retry")}
      </button>
      {recovery && (
        <button className="button" onClick={() => app.runRecovery(recovery, onRetry)} type="button">
          {recoveryLabel(recovery, t)}
        </button>
      )}
    </StateMessage>
  );
}

export function EmptyList({ title, body, Icon = SearchX, children }: { title: string; body?: string; Icon?: LucideIcon; children?: ReactNode }) {
  return (
    <StateMessage Icon={Icon} body={body} title={title}>
      {children}
    </StateMessage>
  );
}

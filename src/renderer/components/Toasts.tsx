import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { useToasts, type Toast } from "../state/toasts";

const ICONS = { success: CircleCheck, error: TriangleAlert, info: Info };

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useI18n();
  const Icon = ICONS[toast.tone];
  const remaining = useRef(toast.duration ?? 0);
  const startedAt = useRef(Date.now());
  const timer = useRef<number | undefined>(undefined);

  const start = () => {
    if (toast.duration === null) {
      return;
    }
    startedAt.current = Date.now();
    timer.current = window.setTimeout(onDismiss, remaining.current);
  };
  const pause = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      remaining.current -= Date.now() - startedAt.current;
    }
  };

  useEffect(() => {
    start();
    return pause;
    // The toast's timing is fixed for its lifetime.
  }, []);

  return (
    <div
      className={`toast toast--${toast.tone}`}
      onBlur={start}
      onFocus={pause}
      onMouseEnter={pause}
      onMouseLeave={start}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="toast__icon" size={18} />
      <div className="toast__copy">
        <span className="toast__title">{toast.title}</span>
        {toast.detail && <span className="toast__detail">{toast.detail}</span>}
      </div>
      <div className="toast__actions">
        {toast.action && (
          <button
            className="button button--sm"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            type="button"
          >
            {toast.action.label}
          </button>
        )}
        <button aria-label={t("common.dismiss")} className="button button--ghost button--icon button--sm" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={15} />
        </button>
      </div>
      {toast.duration !== null && <span aria-hidden="true" className="toast__timer" style={{ animationDuration: `${toast.duration}ms` }} />}
    </div>
  );
}

export function ToastRegion() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" aria-relevant="additions" className="toast-region">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={() => dismiss(toast.id)} toast={toast} />
      ))}
    </div>
  );
}

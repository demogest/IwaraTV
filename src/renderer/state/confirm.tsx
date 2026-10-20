import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

export type ConfirmResult = "confirm" | "secondary" | "cancel";

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  /** Optional middle action, e.g. "Remove from list" next to "Delete file". */
  secondaryLabel?: string;
  tone?: "danger" | "default";
}

type Confirm = (options: ConfirmOptions) => Promise<ConfirmResult>;

const ConfirmContext = createContext<Confirm | undefined>(undefined);

/** Promise-based confirmation dialog built on the native <dialog> element (focus trap, Esc, inert background). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resolverRef = useRef<((result: ConfirmResult) => void) | undefined>(undefined);
  const [options, setOptions] = useState<ConfirmOptions | undefined>();

  const confirm = useCallback<Confirm>((next) => {
    resolverRef.current?.("cancel");
    setOptions(next);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (options && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [options]);

  const finish = (result: ConfirmResult) => {
    resolverRef.current?.(result);
    resolverRef.current = undefined;
    dialogRef.current?.close();
    setOptions(undefined);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog
        aria-describedby={options?.body ? "confirm-body" : undefined}
        aria-labelledby="confirm-title"
        className="dialog"
        onCancel={(event) => {
          event.preventDefault();
          finish("cancel");
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            finish("cancel");
          }
        }}
        ref={dialogRef}
      >
        {options && (
          <div className="dialog__panel">
            <h2 className="dialog__title" id="confirm-title">{options.title}</h2>
            {options.body && <p className="dialog__body" id="confirm-body">{options.body}</p>}
            <div className="dialog__actions">
              <button autoFocus className="button button--ghost" onClick={() => finish("cancel")} type="button">
                {t("common.cancel")}
              </button>
              {options.secondaryLabel && (
                <button className="button" onClick={() => finish("secondary")} type="button">
                  {options.secondaryLabel}
                </button>
              )}
              <button
                className={options.tone === "danger" ? "button button--danger" : "button button--primary"}
                onClick={() => finish("confirm")}
                type="button"
              >
                {options.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const value = useContext(ConfirmContext);
  if (!value) {
    throw new Error("useConfirm must be used inside ConfirmProvider");
  }
  return value;
}

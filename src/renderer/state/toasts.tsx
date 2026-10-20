import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
  action?: ToastAction;
  /** Toasts with the same key replace each other, e.g. "queued" → "downloaded". */
  key?: string;
  /** Auto-dismiss delay in ms; `null` keeps the toast until dismissed. */
  duration: number | null;
}

export type ToastInput = Omit<Toast, "id" | "duration"> & { duration?: number | null };

interface ToastValue {
  toasts: Toast[];
  push(toast: ToastInput): number;
  dismiss(id: number): void;
}

const MAX_TOASTS = 3;
const DEFAULT_DURATION = 4500;
const ToastContext = createContext<ToastValue | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    // Errors stay until dismissed so they can be read and acted on.
    const duration = input.duration !== undefined ? input.duration : input.tone === "error" ? null : DEFAULT_DURATION;
    setToasts((current) => {
      const deduped = current.filter((toast) =>
        !(toast.title === input.title && toast.detail === input.detail) && !(input.key && toast.key === input.key)
      );
      return [...deduped, { ...input, id, duration }].slice(-MAX_TOASTS);
    });
    return id;
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToasts must be used inside ToastProvider");
  }
  return value;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UpdateState } from "../../shared/types";
import { useI18n } from "../i18n";
import { hasBridge, invoke, subscribe } from "../lib/api";
import { useAppState } from "./app-state";
import { useToasts } from "./toasts";

interface UpdatesValue {
  state: UpdateState;
  /** An update worth pointing at in the sidebar: found, not skipped. */
  visible: boolean;
  busy: boolean;
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  skip(): Promise<void>;
}

const INITIAL: UpdateState = { status: "idle", currentVersion: "", installKind: "dev", strategy: "none", signedOnly: false };
const UpdatesContext = createContext<UpdatesValue | undefined>(undefined);

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const app = useAppState();
  const { push } = useToasts();
  const [state, setState] = useState<UpdateState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const announced = useRef(new Set<string>());
  const autoDownload = app.settings.updates.autoDownload;
  const reportError = app.reportError;

  useEffect(() => {
    if (!hasBridge()) {
      return;
    }
    const unsubscribe = subscribe("updates:changed", setState);
    void invoke("updates:state").then(setState).catch(() => undefined);
    return unsubscribe;
  }, []);

  const run = useCallback(async (task: () => Promise<UpdateState>, retry?: () => void) => {
    setBusy(true);
    try {
      setState(await task());
    } catch (error) {
      reportError(error, retry);
    } finally {
      setBusy(false);
    }
  }, [reportError]);

  const check = useCallback(() => run(() => invoke("updates:check")), [run]);
  const download = useCallback(() => run(() => invoke("updates:download")), [run]);
  const install = useCallback(() => run(() => invoke("updates:install")), [run]);
  const skip = useCallback(async () => {
    const version = state.update?.version;
    if (!version) {
      return;
    }
    await run(() => invoke("updates:skip", version));
    setDialogOpen(false);
    push({ tone: "info", title: t("updates.skipped", { version }), key: "update" });
  }, [push, run, state.update?.version, t]);

  // One reminder per version and stage, and none while the dialog already shows it.
  const update = state.update;
  useEffect(() => {
    if (!update || update.skipped || dialogOpen) {
      return;
    }
    const waitsForUser = state.strategy !== "automatic" || update.breaking || !autoDownload;
    const stage = state.status === "ready" && state.strategy === "automatic"
      ? "ready"
      : state.status === "available" && waitsForUser
        ? "available"
        : undefined;
    const id = `${update.version}:${stage}`;
    if (!stage || announced.current.has(id)) {
      return;
    }
    announced.current.add(id);
    if (stage === "ready") {
      push({
        tone: "success",
        key: "update",
        title: t("updates.toastReady", { version: update.version }),
        detail: t("updates.toastReadyDetail"),
        action: { label: t("updates.restart"), onClick: () => void install() },
        duration: null
      });
    } else {
      push({
        tone: "info",
        key: "update",
        title: t("updates.toastAvailable", { version: update.version }),
        action: { label: t("updates.details"), onClick: () => setDialogOpen(true) },
        duration: 10_000
      });
    }
  }, [autoDownload, dialogOpen, install, push, state.status, state.strategy, t, update]);

  const visible = Boolean(update && !update.skipped && ["available", "downloading", "ready"].includes(state.status));
  const value = useMemo<UpdatesValue>(() => ({
    state,
    visible,
    busy,
    dialogOpen,
    openDialog: () => setDialogOpen(true),
    closeDialog: () => setDialogOpen(false),
    check,
    download,
    install,
    skip
  }), [busy, check, dialogOpen, download, install, skip, state, visible]);

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates(): UpdatesValue {
  const value = useContext(UpdatesContext);
  if (!value) {
    throw new Error("useUpdates must be used inside UpdatesProvider");
  }
  return value;
}

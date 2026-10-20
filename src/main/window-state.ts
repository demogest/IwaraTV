import path from "node:path";
import { screen, type BrowserWindow, type Rectangle } from "electron";
import { isRecord, readJsonFile, writeJsonFileAtomic } from "./lib/json-file";

export interface WindowState {
  bounds?: Rectangle;
  maximized: boolean;
}

const DEFAULT_SIZE = { width: 1320, height: 860 };

export function loadWindowState(userDataPath: string): WindowState & { width: number; height: number } {
  const raw = readJsonFile(path.join(userDataPath, "window-state.json"));
  const bounds = isRecord(raw) && isRecord(raw.bounds) ? (raw.bounds as unknown as Rectangle) : undefined;
  const maximized = isRecord(raw) && raw.maximized === true;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    return { ...DEFAULT_SIZE, maximized };
  }
  // Ignore saved positions that are no longer on any connected display.
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const visible = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  return visible
    ? { bounds, width: bounds.width, height: bounds.height, maximized }
    : { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height), maximized };
}

export function trackWindowState(window: BrowserWindow, userDataPath: string): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    if (window.isDestroyed()) {
      return;
    }
    const state: WindowState = {
      bounds: window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds(),
      maximized: window.isMaximized()
    };
    try {
      writeJsonFileAtomic(path.join(userDataPath, "window-state.json"), state);
    } catch {
      // Window placement is a convenience; never fail on it.
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("close", () => {
    clearTimeout(timer);
    save();
  });
}

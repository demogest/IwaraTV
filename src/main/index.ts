import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  net,
  Notification,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from "electron";
import { contentSecurityPolicy } from "../shared/csp";
import { MEDIA_STREAM_SCHEME } from "../shared/media-hosts";
import type { EventChannel, IpcEventContract } from "../shared/ipc";
import type { AppSettings } from "../shared/types";
import { Backend, type PlatformPort, type UpdatePort } from "./backend";
import { registerIpc } from "./ipc";
import { createHandlers, validators } from "./ipc-handlers";
import { AppError } from "./lib/app-error";
import { migrateLegacyData } from "./lib/migration";
import { createInstaller, resolveUpdateEnvironment, type InstallContext } from "./lib/update-install";
import { folderSource, GITHUB_SOURCE } from "./lib/update-manifest";
import { IwaraSessionService } from "./services/iwara-session";
import { PlayerService } from "./services/player-service";
import { loadWindowState, trackWindowState } from "./window-state";

const APP_SCHEME = "app";
const APP_HOST = "iwaratv";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const DEV_SERVER_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const BACKGROUND = { dark: "#0e1014", light: "#f5f6f8" };

let mainWindow: BrowserWindow | undefined;
let backend: Backend | undefined;
let iwaraSession: IwaraSessionService | undefined;
let migratedFrom: string | undefined;
let quitting = false;
const notifications = new Set<Notification>();

app.setName("IwaraTV");
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  // `stream` lets <video> seek with Range requests through the handler.
  { scheme: MEDIA_STREAM_SCHEME, privileges: { standard: true, secure: true, stream: true } }
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    } else if (backend && !quitting) {
      // Launching again must always show a window, never hand off to an invisible process.
      createMainWindow(app.getPath("userData"));
    }
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.whenReady().then(start).catch((error: unknown) => {
    dialog.showErrorBox("IwaraTV", `IwaraTV could not start.\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    app.exit(1);
  });

  app.on("before-quit", () => {
    quitting = true;
    backend?.shutdown();
    iwaraSession?.dispose();
    // Anything else still open is a hidden Iwara page; none of them may hold the app open.
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== mainWindow && !window.isDestroyed()) {
        window.destroy();
      }
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}

function start(): void {
  const userDataPath = app.getPath("userData");
  migratedFrom = migrateLegacyData(userDataPath);

  registerAppProtocol();
  lockDownSession(session.defaultSession);

  iwaraSession = new IwaraSessionService(() => mainWindow);
  backend = new Backend({
    userDataPath,
    defaultDownloadDirectory: path.join(app.getPath("downloads"), "IwaraTV"),
    session: iwaraSession,
    player: new PlayerService({
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      appRoot: app.isPackaged ? undefined : app.getAppPath()
    }),
    platform: electronPlatform(),
    updates: electronUpdates(),
    emit
  });
  registerIpc(createHandlers(backend), validators, isTrustedSender);
  const streams = backend;
  protocol.handle(MEDIA_STREAM_SCHEME, (request) => streams.streamMedia(request.url, request.headers.get("range"), request.signal));

  const settings = backend.getSettings();
  applyUiSettings(settings);
  backend.settings.onChange(applyUiSettings);
  createMainWindow(userDataPath);
  backend.updates.start();
}

function createMainWindow(userDataPath: string): void {
  const state = loadWindowState(userDataPath);
  const window = new BrowserWindow({
    ...state.bounds,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "IwaraTV",
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), "build", "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });
  mainWindow = window;

  if (state.maximized) {
    window.maximize();
  }
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = undefined;
    // Closing the main window quits the app: hidden Iwara helper pages count as
    // windows and would otherwise keep the process (and its single-instance lock) alive.
    app.quit();
  });
  trackWindowState(window, userDataPath);

  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openLinkInBrowser(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openLinkInBrowser(url);
    }
  });
  contents.on("context-menu", (_event, params) => {
    const labels = menuLabels();
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo", label: labels.undo, enabled: params.editFlags.canUndo },
          { role: "redo", label: labels.redo, enabled: params.editFlags.canRedo },
          { type: "separator" },
          { role: "cut", label: labels.cut, enabled: params.editFlags.canCut },
          { role: "copy", label: labels.copy, enabled: params.editFlags.canCopy },
          { role: "paste", label: labels.paste, enabled: params.editFlags.canPaste },
          { type: "separator" },
          { role: "selectAll", label: labels.selectAll }
        ]
      : params.selectionText.trim()
        ? [{ role: "copy", label: labels.copy }]
        : [];
    if (template.length) {
      Menu.buildFromTemplate(template).popup({ window });
    }
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

/** Serves the built renderer from `app://iwaratv/` instead of `file://`. */
function registerAppProtocol(): void {
  const rendererRoot = path.join(__dirname, "../renderer");
  const policy = `${contentSecurityPolicy({ dev: false })}; frame-ancestors 'none'`;
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      return new Response("Not found", { status: 404 });
    }
    let relative: string;
    try {
      relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const filePath = path.normalize(path.join(rendererRoot, relative));
    if (!filePath.startsWith(rendererRoot + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    const response = await net.fetch(pathToFileURL(filePath).toString());
    if (!response.ok || !filePath.endsWith(".html")) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", policy);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}

function lockDownSession(target: Electron.Session): void {
  // Only fullscreen, and only for the app's own window (the built-in player's fullscreen button).
  target.setPermissionRequestHandler((contents, permission, callback) =>
    callback(permission === "fullscreen" && Boolean(mainWindow) && contents === mainWindow?.webContents)
  );
  target.setPermissionCheckHandler(() => false);
}

function isAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Compare scheme and host explicitly: Node reports origin "null" for custom schemes.
  const expected = new URL(DEV_SERVER_URL ?? `${APP_ORIGIN}/`);
  return parsed.protocol === expected.protocol && parsed.host === expected.host;
}

/** Only the app's own top-level page may call the backend. */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(mainWindow && event.sender === mainWindow.webContents && frame && !frame.parent && isAppUrl(frame.url));
}

/** Hands http(s) links to the system browser; anything else is dropped. */
function openIfWebUrl(url: string): Promise<void> {
  return /^https?:\/\//i.test(url) ? shell.openExternal(url) : Promise.resolve();
}

function openLinkInBrowser(url: string): void {
  openIfWebUrl(url).catch((error: unknown) => console.warn("Could not open link:", error));
}

function emit<E extends EventChannel>(channel: E, payload: IpcEventContract[E]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

let currentLanguage: "zh-CN" | "en" = "en";

function applyUiSettings(settings: AppSettings): void {
  nativeTheme.themeSource = settings.ui.theme;
  const resolved = settings.ui.language === "system"
    ? (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en")
    : settings.ui.language;
  if (resolved !== currentLanguage || !Menu.getApplicationMenu()) {
    currentLanguage = resolved;
    applyApplicationMenu();
  }
  mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light);
}

function menuLabels() {
  return currentLanguage === "zh-CN"
    ? { undo: "撤销", redo: "重做", cut: "剪切", copy: "复制", paste: "粘贴", selectAll: "全选" }
    : { undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All" };
}

/** macOS needs an application menu for standard shortcuts (copy/paste, quit). */
function applyApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const labels = menuLabels();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        role: "editMenu",
        submenu: [
          { role: "undo", label: labels.undo },
          { role: "redo", label: labels.redo },
          { type: "separator" },
          { role: "cut", label: labels.cut },
          { role: "copy", label: labels.copy },
          { role: "paste", label: labels.paste },
          { role: "selectAll", label: labels.selectAll }
        ]
      },
      {
        role: "viewMenu",
        submenu: app.isPackaged
          ? [{ role: "togglefullscreen" }]
          : [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }]
      },
      { role: "windowMenu" }
    ])
  );
}

/**
 * Update checks go to GitHub through their own in-memory session: no cookies,
 * no cache, nothing shared with the Iwara session. Development builds can point
 * IWARATV_UPDATE_URL at a local folder (and pin IWARATV_UPDATE_PUBLIC_KEY) for testing.
 */
function electronUpdates(): UpdatePort {
  const devUrl = app.isPackaged ? undefined : process.env.IWARATV_UPDATE_URL;
  const publicKey = devUrl ? process.env.IWARATV_UPDATE_PUBLIC_KEY ?? "" : __UPDATE_PUBLIC_KEY__;
  const context: InstallContext = {
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    env: process.env,
    version: app.getVersion(),
    paths: { userData: app.getPath("userData"), downloads: app.getPath("downloads"), temp: app.getPath("temp") },
    exists: existsSync,
    writable(directory) {
      try {
        accessSync(directory, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
  };
  const environment = resolveUpdateEnvironment(context, {
    source: devUrl ? folderSource(devUrl) : GITHUB_SOURCE,
    publicKey: publicKey.trim() ? publicKey : undefined
  });
  const updateSession = session.fromPartition("iwaratv-updates");
  updateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  return {
    environment,
    fetch: (url, init) => updateSession.fetch(url, { ...init, credentials: "omit", cache: "no-store" }),
    install: createInstaller(environment, context, {
      spawnDetached: (command, args) => new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
      relaunch: (execPath) => app.relaunch({ execPath, args: [] }),
      quit: () => app.quit(),
      openPath: async (filePath) => {
        const error = await shell.openPath(filePath);
        if (error) {
          throw new AppError("UPDATE_INSTALL_FAILED", error);
        }
      },
      showItemInFolder: (filePath) => shell.showItemInFolder(filePath)
    })
  };
}

function electronPlatform(): PlatformPort {
  const ownerWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
  return {
    platform: process.platform,
    async openPath(filePath) {
      const error = await shell.openPath(filePath);
      if (error) {
        throw new AppError("FILE_NOT_FOUND", error);
      }
    },
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
    openExternal: (url) => openIfWebUrl(url),
    writeClipboard: (text) => clipboard.writeText(text),
    readClipboard: () => clipboard.readText(),
    setDownloadProgress(progress, activeCount) {
      ownerWindow()?.setProgressBar(progress === undefined ? -1 : progress === "indeterminate" ? 2 : progress);
      app.setBadgeCount(activeCount);
    },
    notifyDownload(outcome, title) {
      const owner = ownerWindow();
      if (!Notification.isSupported() || owner?.isFocused()) {
        return;
      }
      const labels = currentLanguage === "zh-CN"
        ? { completed: "下载完成", failed: "下载失败" }
        : { completed: "Download finished", failed: "Download failed" };
      const notification = new Notification({ title: labels[outcome], body: title });
      // Keep a reference until it's gone, or the click handler can be collected.
      notifications.add(notification);
      const release = () => notifications.delete(notification);
      notification.on("close", release);
      notification.on("click", () => {
        release();
        const window = ownerWindow();
        if (window) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.show();
          window.focus();
          emit("app:navigate", { section: "downloads" });
        }
      });
      notification.show();
    },
    async pickFile({ title, defaultPath, filters }) {
      const options: Electron.OpenDialogOptions = { title, defaultPath, filters, properties: ["openFile"] };
      const owner = ownerWindow();
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
    async pickDirectory({ title, defaultPath }) {
      const options: Electron.OpenDialogOptions = { title, defaultPath, properties: ["openDirectory", "createDirectory"] };
      const owner = ownerWindow();
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
    async saveFile({ title, defaultPath, filters }) {
      const options: Electron.SaveDialogOptions = { title, defaultPath, filters };
      const owner = ownerWindow();
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    },
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath("userData"),
      systemLocale: app.getLocale(),
      migratedFrom
    })
  };
}

import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { registerIpc } from "./ipc";
import { AuthStore } from "./services/auth-store";
import { IwaraClient } from "./services/iwara-client";
import { IwaraSessionService } from "./services/iwara-session";
import { PlayerService } from "./services/player-service";
import { SettingsStore } from "./services/settings-store";

let mainWindow: BrowserWindow | undefined;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "IwaraTV",
    backgroundColor: "#111317",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
  const settingsStore = new SettingsStore(app.getPath("userData"));
  const authStore = new AuthStore(app.getPath("userData"));
  const iwaraSessionService = new IwaraSessionService();
  const iwaraClient = new IwaraClient(
    authStore,
    (url) => iwaraSessionService.headersFor(url),
    () => iwaraSessionService.token()
  );
  const playerService = new PlayerService(iwaraClient, settingsStore);

  registerIpc(iwaraClient, playerService, settingsStore, iwaraSessionService);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

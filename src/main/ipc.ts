import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  AppSettings,
  ListVideosRequest,
  LoginRequest,
  PlayRequest,
  SelectExecutableRequest,
  SelectExecutableResult
} from "../shared/types";
import { IwaraClient } from "./services/iwara-client";
import { IwaraSessionService } from "./services/iwara-session";
import { PlayerService } from "./services/player-service";
import { SettingsStore } from "./services/settings-store";

export function registerIpc(
  iwaraClient: IwaraClient,
  playerService: PlayerService,
  settingsStore: SettingsStore,
  iwaraSessionService: IwaraSessionService
): void {
  ipcMain.handle("iwara:listVideos", (_event, request: ListVideosRequest) => iwaraClient.listVideos(request));
  ipcMain.handle("iwara:getVideo", (_event, payload: { idOrUrl: string }) => iwaraClient.getVideo(payload.idOrUrl));
  ipcMain.handle("iwara:diagnoseVideo", async (event, payload: { idOrUrl: string }) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return iwaraClient.diagnoseVideo(payload.idOrUrl, () => iwaraSessionService.captureVideoNetwork(payload.idOrUrl, owner));
  });
  ipcMain.handle("player:play", (_event, request: PlayRequest) => playerService.play(request));
  ipcMain.handle("player:probe", () => playerService.probe());
  ipcMain.handle("player:testMpv", () => playerService.testMpv());
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:update", (_event, partial: Partial<AppSettings>) => settingsStore.update(partial));
  ipcMain.handle("auth:state", async () => ({ ...iwaraClient.authState(), ...(await iwaraSessionService.state()) }));
  ipcMain.handle("auth:login", (_event, request: LoginRequest) => iwaraClient.login(request));
  ipcMain.handle("auth:logout", () => iwaraClient.logout());
  ipcMain.handle("auth:openIwaraSession", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return { ...iwaraClient.authState(), ...(await iwaraSessionService.openVerificationWindow(owner)) };
  });
  ipcMain.handle("system:selectExecutable", async (event, request: SelectExecutableRequest): Promise<SelectExecutableResult> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: request.title,
      defaultPath: request.currentPath,
      properties: ["openFile"],
      filters: [
        { name: "Executable", extensions: ["exe", "cmd", "bat"] },
        { name: "All Files", extensions: ["*"] }
      ]
    } satisfies Electron.OpenDialogOptions;
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);

    return {
      canceled: result.canceled,
      path: result.filePaths[0]
    };
  });
  ipcMain.handle("system:openExternal", (_event, url: string) => shell.openExternal(url));
}

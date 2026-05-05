import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mediaUrlHost } from "../shared/media-speed-utils";
import type {
  AppSettings,
  MediaSpeedTestReport,
  VideoDetail,
  VideoFormat,
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
  const rememberMediaHosts = (formats: VideoFormat[]) => {
    settingsStore.addMediaHosts(formats.map((format) => mediaUrlHost(format.url)).filter((host): host is string => Boolean(host)));
  };
  const withRememberedHosts = (video: VideoDetail) => {
    rememberMediaHosts(video.formats);
    return iwaraClient.routeVideoFormats(video, settingsStore.get().mediaSpeed);
  };
  const rememberSpeedReportHosts = (report: MediaSpeedTestReport) => {
    settingsStore.updateMediaHostRanking(report.results, report.testedAt);
    return report;
  };

  ipcMain.handle("iwara:listVideos", (_event, request: ListVideosRequest) => iwaraClient.listVideos(request));
  ipcMain.handle("iwara:getVideo", async (_event, payload: { idOrUrl: string }) => withRememberedHosts(await iwaraClient.getVideo(payload.idOrUrl)));
  ipcMain.handle("iwara:diagnoseVideo", async (event, payload: { idOrUrl: string }) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const report = await iwaraClient.diagnoseVideo(payload.idOrUrl, () => iwaraSessionService.captureVideoNetwork(payload.idOrUrl, owner));
    rememberMediaHosts(report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? []);
    return report;
  });
  ipcMain.handle("iwara:speedTestVideo", async (_event, payload: { idOrUrl: string }) => {
    const settings = settingsStore.get();
    return rememberSpeedReportHosts(await iwaraClient.speedTestVideo(payload.idOrUrl, settings.mediaSpeed));
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

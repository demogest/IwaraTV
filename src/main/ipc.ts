import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { mediaUrlHost } from "../shared/media-speed-utils";
import type {
  AppSettings,
  MediaSpeedTestReport,
  VideoDetail,
  VideoFormat,
  ListVideosRequest,
  ListVideoCommentsRequest,
  LoginRequest,
  PlayRequest,
  SendVideoCommentRequest,
  SelectExecutableRequest,
  SelectExecutableResult,
  XVersionSaltReport
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
    return video;
  };
  const rememberSpeedReportHosts = (report: MediaSpeedTestReport) => {
    settingsStore.updateMediaHostRanking(report.results, report.testedAt);
    return report;
  };
  const updateXVersionSalt = (report: XVersionSaltReport) => {
    const current = settingsStore.get().iwara;
    settingsStore.update({
      iwara: {
        ...current,
        xVersionSalt: report.salt,
        lastSaltSniffAt: report.checkedAt,
        lastSaltSource: report.sourceUrl
      }
    });
    return report;
  };
  const maybeSniffXVersionSalt = async () => {
    const current = settingsStore.get().iwara;
    if (!current.autoSniffXVersionSalt || isFreshIsoDate(current.lastSaltSniffAt, 24 * 60 * 60 * 1000)) {
      return;
    }

    try {
      updateXVersionSalt(await iwaraClient.sniffXVersionSalt());
    } catch {
      // Salt sniffing is opportunistic; playback should still try the stored salt.
    }
  };

  ipcMain.handle("iwara:listVideos", (_event, request: ListVideosRequest) => iwaraClient.listVideos(request));
  ipcMain.handle("iwara:getVideo", async (_event, payload: { idOrUrl: string }) => {
    await maybeSniffXVersionSalt();
    const video = withRememberedHosts(await iwaraClient.getVideo(payload.idOrUrl));
    return iwaraClient.routeVideoFormats(video, settingsStore.get().mediaSpeed);
  });
  ipcMain.handle("iwara:diagnoseVideo", async (event, payload: { idOrUrl: string }) => {
    await maybeSniffXVersionSalt();
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const report = await iwaraClient.diagnoseVideo(payload.idOrUrl, () => iwaraSessionService.captureVideoNetwork(payload.idOrUrl, owner));
    rememberMediaHosts(report.network?.entries.flatMap((entry) => entry.formats ?? []) ?? []);
    return report;
  });
  ipcMain.handle("iwara:sniffXVersionSalt", async () => updateXVersionSalt(await iwaraClient.sniffXVersionSalt()));
  ipcMain.handle("iwara:listComments", (_event, request: ListVideoCommentsRequest) => iwaraClient.listVideoComments(request.videoId));
  ipcMain.handle("iwara:sendComment", (_event, request: SendVideoCommentRequest) => iwaraClient.sendVideoComment(request));
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
  ipcMain.handle("system:writeClipboard", (_event, text: string) => clipboard.writeText(text));
}

function isFreshIsoDate(value: string | undefined, maxAgeMs: number): boolean {
  if (!value) {
    return false;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

import { ipcMain } from "electron";
import type { AppSettings, ListVideosRequest, LoginRequest, PlayRequest } from "../shared/types";
import { IwaraClient } from "./services/iwara-client";
import { PlayerService } from "./services/player-service";
import { SettingsStore } from "./services/settings-store";

export function registerIpc(
  iwaraClient: IwaraClient,
  playerService: PlayerService,
  settingsStore: SettingsStore
): void {
  ipcMain.handle("iwara:listVideos", (_event, request: ListVideosRequest) => iwaraClient.listVideos(request));
  ipcMain.handle("iwara:getVideo", (_event, payload: { idOrUrl: string }) => iwaraClient.getVideo(payload.idOrUrl));
  ipcMain.handle("player:play", (_event, request: PlayRequest) => playerService.play(request));
  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:update", (_event, partial: Partial<AppSettings>) => settingsStore.update(partial));
  ipcMain.handle("auth:state", () => iwaraClient.authState());
  ipcMain.handle("auth:login", (_event, request: LoginRequest) => iwaraClient.login(request));
  ipcMain.handle("auth:logout", () => iwaraClient.logout());
}


import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  AuthState,
  ListVideosRequest,
  LoginRequest,
  IwaraVideoDiagnostics,
  MediaSpeedTestReport,
  PlayerDiagnostics,
  PlayerProbe,
  PlayRequest,
  PlayResult,
  SelectExecutableRequest,
  SelectExecutableResult,
  VideoDetail,
  VideoListResult
} from "../shared/types";

const api = {
  iwara: {
    listVideos: (request: ListVideosRequest) => ipcRenderer.invoke("iwara:listVideos", request) as Promise<VideoListResult>,
    getVideo: (idOrUrl: string) => ipcRenderer.invoke("iwara:getVideo", { idOrUrl }) as Promise<VideoDetail>,
    diagnoseVideo: (idOrUrl: string) => ipcRenderer.invoke("iwara:diagnoseVideo", { idOrUrl }) as Promise<IwaraVideoDiagnostics>,
    speedTestVideo: (idOrUrl: string) => ipcRenderer.invoke("iwara:speedTestVideo", { idOrUrl }) as Promise<MediaSpeedTestReport>
  },
  player: {
    play: (request: PlayRequest) => ipcRenderer.invoke("player:play", request) as Promise<PlayResult>,
    probe: () => ipcRenderer.invoke("player:probe") as Promise<PlayerDiagnostics>,
    testMpv: () => ipcRenderer.invoke("player:testMpv") as Promise<PlayerProbe>
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
    update: (partial: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", partial) as Promise<AppSettings>
  },
  auth: {
    state: () => ipcRenderer.invoke("auth:state") as Promise<AuthState>,
    login: (request: LoginRequest) => ipcRenderer.invoke("auth:login", request) as Promise<AuthState>,
    logout: () => ipcRenderer.invoke("auth:logout") as Promise<AuthState>,
    openIwaraSession: () => ipcRenderer.invoke("auth:openIwaraSession") as Promise<AuthState>
  },
  system: {
    selectExecutable: (request: SelectExecutableRequest) =>
      ipcRenderer.invoke("system:selectExecutable", request) as Promise<SelectExecutableResult>,
    openExternal: (url: string) => ipcRenderer.invoke("system:openExternal", url) as Promise<void>
  }
};

contextBridge.exposeInMainWorld("iwaraTV", api);

export type IwaraTVBridge = typeof api;

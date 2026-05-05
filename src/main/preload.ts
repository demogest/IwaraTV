import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  AuthState,
  ListVideosRequest,
  LoginRequest,
  PlayRequest,
  PlayResult,
  VideoDetail,
  VideoListResult
} from "../shared/types";

const api = {
  iwara: {
    listVideos: (request: ListVideosRequest) => ipcRenderer.invoke("iwara:listVideos", request) as Promise<VideoListResult>,
    getVideo: (idOrUrl: string) => ipcRenderer.invoke("iwara:getVideo", { idOrUrl }) as Promise<VideoDetail>
  },
  player: {
    play: (request: PlayRequest) => ipcRenderer.invoke("player:play", request) as Promise<PlayResult>
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get") as Promise<AppSettings>,
    update: (partial: Partial<AppSettings>) => ipcRenderer.invoke("settings:update", partial) as Promise<AppSettings>
  },
  auth: {
    state: () => ipcRenderer.invoke("auth:state") as Promise<AuthState>,
    login: (request: LoginRequest) => ipcRenderer.invoke("auth:login", request) as Promise<AuthState>,
    logout: () => ipcRenderer.invoke("auth:logout") as Promise<AuthState>
  }
};

contextBridge.exposeInMainWorld("iwaraTV", api);

export type IwaraTVBridge = typeof api;


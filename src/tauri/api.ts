import type {
  AppSettings,
  AuthorFollowRequest,
  AuthorFollowResult,
  AuthState,
  DownloadDeleteRequest,
  DownloadResult,
  DownloadState,
  DownloadTask,
  DownloadVideoRequest,
  IwaraVideoDiagnostics,
  ListVideoCommentsRequest,
  ListVideosRequest,
  LoginRequest,
  MediaSpeedTestReport,
  PlayerDiagnostics,
  PlayerProbe,
  PlayRequest,
  PlayResult,
  SendVideoCommentRequest,
  SelectExecutableRequest,
  SelectExecutableResult,
  SelectDirectoryRequest,
  SelectDirectoryResult,
  VideoComment,
  VideoCommentsResult,
  VideoDetail,
  VideoListResult,
  XVersionSaltReport
} from "../lib/types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriGlobal {
  core?: {
    invoke?: Invoke;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

const commandMap = {
  listVideos: "iwara_list_videos",
  getVideo: "iwara_get_video",
  diagnoseVideo: "iwara_diagnose_video",
  setAuthorFollowing: "iwara_set_author_following",
  listComments: "iwara_list_comments",
  sendComment: "iwara_send_comment",
  sniffXVersionSalt: "iwara_sniff_x_version_salt",
  speedTestVideo: "iwara_speed_test_video",
  downloadVideo: "iwara_download_video",
  downloadsList: "downloads_list",
  downloadsStart: "downloads_start",
  downloadsRetry: "downloads_retry",
  downloadsDelete: "downloads_delete",
  downloadsOpenFile: "downloads_open_file",
  downloadsOpenFolder: "downloads_open_folder",
  play: "player_play",
  probe: "player_probe",
  testMpv: "player_test_mpv",
  getSettings: "settings_get",
  updateSettings: "settings_update",
  authState: "auth_state",
  login: "auth_login",
  logout: "auth_logout",
  openIwaraSession: "auth_open_iwara_session",
  selectExecutable: "system_select_executable",
  selectDirectory: "system_select_directory",
  openExternal: "system_open_external",
  writeClipboard: "system_write_clipboard"
} as const;

function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    return Promise.reject(new Error("Tauri API is not available."));
  }

  return invoke<T>(command, args);
}

export const tauriApi = {
  iwara: {
    listVideos: (request: ListVideosRequest) => tauriInvoke<VideoListResult>(commandMap.listVideos, { request }),
    getVideo: (idOrUrl: string) => tauriInvoke<VideoDetail>(commandMap.getVideo, { idOrUrl }),
    diagnoseVideo: (idOrUrl: string) => tauriInvoke<IwaraVideoDiagnostics>(commandMap.diagnoseVideo, { idOrUrl }),
    setAuthorFollowing: (request: AuthorFollowRequest) =>
      tauriInvoke<AuthorFollowResult>(commandMap.setAuthorFollowing, { request }),
    listComments: (request: ListVideoCommentsRequest) =>
      tauriInvoke<VideoCommentsResult>(commandMap.listComments, { request }),
    sendComment: (request: SendVideoCommentRequest) => tauriInvoke<VideoComment>(commandMap.sendComment, { request }),
    sniffXVersionSalt: () => tauriInvoke<XVersionSaltReport>(commandMap.sniffXVersionSalt),
    speedTestVideo: (idOrUrl: string) => tauriInvoke<MediaSpeedTestReport>(commandMap.speedTestVideo, { idOrUrl }),
    downloadVideo: (request: DownloadVideoRequest) => tauriInvoke<DownloadResult>(commandMap.downloadVideo, { request })
  },
  downloads: {
    list: () => tauriInvoke<DownloadState>(commandMap.downloadsList),
    start: (request: DownloadVideoRequest) => tauriInvoke<DownloadTask>(commandMap.downloadsStart, { request }),
    retry: (id: string) => tauriInvoke<DownloadTask>(commandMap.downloadsRetry, { id }),
    delete: (request: DownloadDeleteRequest) => tauriInvoke<DownloadState>(commandMap.downloadsDelete, { request }),
    openFile: (id: string) => tauriInvoke<void>(commandMap.downloadsOpenFile, { id }),
    openFolder: (id: string) => tauriInvoke<void>(commandMap.downloadsOpenFolder, { id })
  },
  player: {
    play: (request: PlayRequest) => tauriInvoke<PlayResult>(commandMap.play, { request }),
    probe: () => tauriInvoke<PlayerDiagnostics>(commandMap.probe),
    testMpv: () => tauriInvoke<PlayerProbe>(commandMap.testMpv)
  },
  settings: {
    get: () => tauriInvoke<AppSettings>(commandMap.getSettings),
    update: (partial: Partial<AppSettings>) => tauriInvoke<AppSettings>(commandMap.updateSettings, { partial })
  },
  auth: {
    state: () => tauriInvoke<AuthState>(commandMap.authState),
    login: (request: LoginRequest) => tauriInvoke<AuthState>(commandMap.login, { request }),
    logout: () => tauriInvoke<AuthState>(commandMap.logout),
    openIwaraSession: () => tauriInvoke<AuthState>(commandMap.openIwaraSession)
  },
  system: {
    selectExecutable: (request: SelectExecutableRequest) =>
      tauriInvoke<SelectExecutableResult>(commandMap.selectExecutable, { request }),
    selectDirectory: (request: SelectDirectoryRequest) =>
      tauriInvoke<SelectDirectoryResult>(commandMap.selectDirectory, { request }),
    openExternal: (url: string) => tauriInvoke<void>(commandMap.openExternal, { url }),
    writeClipboard: (text: string) => tauriInvoke<void>(commandMap.writeClipboard, { text })
  }
};

export function installTauriApi(): void {
  if (!window.iwaraTV && window.__TAURI__?.core?.invoke) {
    window.iwaraTV = tauriApi;
  }
}

export type IwaraTVApi = typeof tauriApi;
export { commandMap };

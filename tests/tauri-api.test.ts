import { describe, expect, it } from "vitest";
import { commandMap } from "../src/tauri/api";

describe("Tauri command API mapping", () => {
  it("keeps web API calls routed through internal Tauri commands", () => {
    expect(commandMap).toEqual({
      authState: "auth_state",
      diagnoseVideo: "iwara_diagnose_video",
      downloadsDelete: "downloads_delete",
      downloadsList: "downloads_list",
      downloadsOpenFile: "downloads_open_file",
      downloadsOpenFolder: "downloads_open_folder",
      downloadsRetry: "downloads_retry",
      downloadsStart: "downloads_start",
      downloadVideo: "iwara_download_video",
      favoritesAdd: "favorites_add",
      favoritesBackup: "favorites_backup",
      favoritesExport: "favorites_export",
      favoritesImport: "favorites_import",
      favoritesList: "favorites_list",
      favoritesRemove: "favorites_remove",
      getSettings: "settings_get",
      listVideos: "iwara_list_videos",
      getVideo: "iwara_get_video",
      listComments: "iwara_list_comments",
      login: "auth_login",
      logout: "auth_logout",
      openExternal: "system_open_external",
      openIwaraSession: "auth_open_iwara_session",
      play: "player_play",
      probe: "player_probe",
      selectDirectory: "system_select_directory",
      selectExecutable: "system_select_executable",
      setAuthorFollowing: "iwara_set_author_following",
      sendComment: "iwara_send_comment",
      sniffXVersionSalt: "iwara_sniff_x_version_salt",
      speedTestVideo: "iwara_speed_test_video",
      testMpv: "player_test_mpv",
      updateSettings: "settings_update",
      writeClipboard: "system_write_clipboard"
    });
  });
});

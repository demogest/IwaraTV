import { describe, expect, it } from "vitest";
import { commandMap } from "../src/renderer/tauri-bridge";

describe("tauri bridge command mapping", () => {
  it("keeps renderer API calls routed through internal Tauri commands", () => {
    expect(commandMap).toMatchObject({
      listVideos: "iwara_list_videos",
      getVideo: "iwara_get_video",
      diagnoseVideo: "iwara_diagnose_video",
      play: "player_play",
      getSettings: "settings_get",
      updateSettings: "settings_update",
      openIwaraSession: "auth_open_iwara_session",
      selectExecutable: "system_select_executable"
    });
  });
});

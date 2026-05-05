import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { app } from "electron";
import { chooseVideoFormat } from "../../shared/iwara-utils";
import { buildExternalPlayerArgs } from "../../shared/player-utils";
import type { PlayRequest, PlayResult, PlayerMode, VideoDetail, VideoSummary } from "../../shared/types";
import { IwaraClient } from "./iwara-client";
import { SettingsStore } from "./settings-store";

const HTTP_HEADERS_TEMPLATE = "Referer: https://www.iwara.tv/";

export class PlayerService {
  constructor(
    private readonly iwaraClient: IwaraClient,
    private readonly settingsStore: SettingsStore
  ) {}

  async play(request: PlayRequest): Promise<PlayResult> {
    const settings = this.settingsStore.get();
    const video = await this.iwaraClient.getVideo(request.videoId);
    const format = chooseVideoFormat(video.formats, request.quality ?? settings.player.preferredQuality);

    if (!format) {
      throw new Error("没有找到可播放的清晰度。");
    }

    const mode = request.mode ?? settings.player.preferredMode;
    const playerPath = mode === "external"
      ? this.requireExternalPlayerPath(settings.player.externalPlayerPath)
      : this.requireMpvPath(settings.player.mpvPath);

    const args = mode === "external"
      ? buildExternalPlayerArgs(settings.player.externalPlayerArgs, {
        url: format.url,
        title: video.title,
        headers: HTTP_HEADERS_TEMPLATE
      })
      : this.mpvArgs(video, format.url);

    const child = spawn(playerPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();

    this.settingsStore.addHistory({
      video: toSummary(video),
      formatId: format.id,
      mode,
      playedAt: new Date().toISOString()
    });

    return { ok: true, mode, playerPath, format, video };
  }

  private mpvArgs(video: VideoDetail, url: string): string[] {
    return [
      "--force-window=yes",
      `--title=${video.title}`,
      "--referrer=https://www.iwara.tv/",
      url
    ];
  }

  private requireExternalPlayerPath(playerPath?: string): string {
    if (!playerPath || !existsSync(playerPath)) {
      throw new Error("外部播放器路径不存在，请先在设置中配置。");
    }

    return playerPath;
  }

  private requireMpvPath(configuredPath?: string): string {
    const candidates = [
      configuredPath,
      path.join(process.cwd(), "vendor", "mpv", "mpv.exe"),
      path.join(process.resourcesPath ?? "", "mpv", "mpv.exe"),
      findOnPath("mpv.exe"),
      findOnPath("mpv")
    ].filter((candidate): candidate is string => Boolean(candidate));

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
      throw new Error("未找到 MPV。请放置 vendor/mpv/mpv.exe，安装到 PATH，或在设置中指定 mpv.exe。");
    }

    return found;
  }
}

function findOnPath(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  const first = result.stdout?.split(/\r?\n/).find(Boolean);
  return first?.trim();
}

function toSummary(video: VideoDetail): VideoSummary {
  const { formats: _formats, embedUrl: _embedUrl, ...summary } = video;
  return summary;
}


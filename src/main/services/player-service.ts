import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chooseVideoFormat } from "../../shared/iwara-utils";
import { mediaUrlHost } from "../../shared/media-speed-utils";
import { buildExternalPlayerArgs, templateIncludesUrl } from "../../shared/player-utils";
import type {
  PlayRequest,
  PlayerDiagnostics,
  PlayerProbe,
  PlayResult,
  VideoDetail,
  VideoSummary
} from "../../shared/types";
import { IwaraClient } from "./iwara-client";
import { SettingsStore } from "./settings-store";

const HTTP_HEADERS_TEMPLATE = "Referer: https://www.iwara.tv/";

export class PlayerService {
  constructor(
    private readonly iwaraClient: IwaraClient,
    private readonly settingsStore: SettingsStore
  ) {}

  probe(): PlayerDiagnostics {
    const settings = this.settingsStore.get();
    const mpvPath = this.resolveMpvPath(settings.player.mpvPath);
    const externalPath = settings.player.externalPlayerPath;
    let externalArgsPreview: string[] = [];
    let externalTemplateHasUrl = false;
    let templateError: string | undefined;

    try {
      externalTemplateHasUrl = templateIncludesUrl(settings.player.externalPlayerArgs);
      externalArgsPreview = buildExternalPlayerArgs(settings.player.externalPlayerArgs, {
        url: "https://media.example/video.mp4",
        title: "IwaraTV Preview",
        headers: HTTP_HEADERS_TEMPLATE
      });
    } catch (err) {
      templateError = err instanceof Error ? err.message : String(err);
    }

    return {
      mpv: {
        ok: Boolean(mpvPath),
        label: "MPV",
        configuredPath: settings.player.mpvPath,
        resolvedPath: mpvPath,
        message: mpvPath ? `已找到 MPV：${mpvPath}` : "未找到 MPV，请选择 mpv.exe 或安装到 PATH。"
      },
      external: {
        ok: Boolean(externalPath && existsSync(externalPath) && externalTemplateHasUrl && !templateError),
        label: "外部播放器",
        configuredPath: externalPath,
        resolvedPath: externalPath && existsSync(externalPath) ? externalPath : undefined,
        message: templateError
          ?? (externalPath && existsSync(externalPath)
            ? (externalTemplateHasUrl ? `已找到外部播放器：${externalPath}` : "外部播放器参数需要包含 {url}。")
            : "未配置外部播放器路径。")
      },
      externalArgsPreview,
      externalTemplateHasUrl
    };
  }

  testMpv(): PlayerProbe {
    const settings = this.settingsStore.get();
    const mpvPath = this.resolveMpvPath(settings.player.mpvPath);
    if (!mpvPath) {
      return {
        ok: false,
        label: "MPV",
        configuredPath: settings.player.mpvPath,
        message: "未找到 MPV，请选择 mpv.exe 或安装到 PATH。"
      };
    }

    const result = spawnSync(mpvPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true
    });

    if (result.error) {
      return {
        ok: false,
        label: "MPV",
        configuredPath: settings.player.mpvPath,
        resolvedPath: mpvPath,
        message: `MPV 启动失败：${result.error.message}`
      };
    }

    return {
      ok: result.status === 0,
      label: "MPV",
      configuredPath: settings.player.mpvPath,
      resolvedPath: mpvPath,
      message: result.status === 0 ? "MPV 可启动。" : `MPV 返回退出码 ${result.status ?? "unknown"}。`
    };
  }

  async play(request: PlayRequest): Promise<PlayResult> {
    let settings = this.settingsStore.get();
    let video = await this.iwaraClient.getVideo(request.videoId, { includeComments: false });
    settings = this.settingsStore.addMediaHosts(video.formats.map((format) => mediaUrlHost(format.url)).filter((host): host is string => Boolean(host)));
    if (settings.mediaSpeed.autoTest && !settings.mediaSpeed.rankedHosts.length) {
      const report = await this.iwaraClient.speedTestVideo(video.id, settings.mediaSpeed);
      settings = this.settingsStore.updateMediaHostRanking(report.results, report.testedAt);
    }
    if (settings.mediaSpeed.replaceLinks) {
      video = this.iwaraClient.routeVideoFormats(video, settings.mediaSpeed);
      settings = this.settingsStore.addMediaHosts(video.formats.map((format) => mediaUrlHost(format.url)).filter((host): host is string => Boolean(host)));
    }
    const format = chooseVideoFormat(video.formats, request.quality ?? settings.player.preferredQuality);

    if (!format) {
      throw new Error("没有找到可播放的清晰度。");
    }

    const mode = request.mode ?? settings.player.preferredMode;
    const playerPath = mode === "external"
      ? this.requireExternalPlayerPath(settings.player.externalPlayerPath)
      : this.requireMpvPath(settings.player.mpvPath);

    if (mode === "external" && !templateIncludesUrl(settings.player.externalPlayerArgs)) {
      throw new Error("外部播放器参数需要包含 {url}，否则播放器收不到视频地址。");
    }

    const args = mode === "external"
      ? buildExternalPlayerArgs(settings.player.externalPlayerArgs, {
        url: format.url,
        title: video.title,
        headers: HTTP_HEADERS_TEMPLATE
      })
      : this.mpvArgs(video, format.url);

    await this.launchPlayer(playerPath, args);

    this.settingsStore.addHistory({
      video: toSummary(video),
      formatId: format.id,
      mode,
      playedAt: new Date().toISOString()
    });

    return {
      ok: true,
      mode,
      playerPath,
      format,
      video,
      fallbackFrom: request.quality && request.quality !== format.id ? request.quality : undefined
    };
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
    const found = this.resolveMpvPath(configuredPath);
    if (!found) {
      throw new Error("未找到 MPV。请放置 vendor/mpv/mpv.exe，安装到 PATH，或在设置中指定 mpv.exe。");
    }

    return found;
  }

  private resolveMpvPath(configuredPath?: string): string | undefined {
    const candidates = [
      configuredPath,
      path.join(process.cwd(), "vendor", "mpv", "mpv.exe"),
      path.join(process.resourcesPath ?? "", "mpv", "mpv.exe"),
      findOnPath("mpv.exe"),
      findOnPath("mpv")
    ].filter((candidate): candidate is string => Boolean(candidate));

    return candidates.find((candidate) => existsSync(candidate));
  }

  private async launchPlayer(playerPath: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(playerPath, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      child.once("spawn", () => {
        child.unref();
        settle(resolve);
      });
      child.once("error", (err) => settle(() => reject(err)));
      setTimeout(() => {
        child.unref();
        settle(resolve);
      }, 750);
    });
  }
}

function findOnPath(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  const first = result.stdout?.split(/\r?\n/).find(Boolean);
  return first?.trim();
}

function toSummary(video: VideoDetail): VideoSummary {
  const {
    formats: _formats,
    embedUrl: _embedUrl,
    comments: _comments,
    commentsTotal: _commentsTotal,
    commentsError: _commentsError,
    ...summary
  } = video;
  return summary;
}

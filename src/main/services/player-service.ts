import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import {
  buildExternalPlayerArgs,
  PLAYER_REFERER_HEADER,
  PlayerTemplateError,
  templateIncludesUrl
} from "../../shared/player-template";
import type { PlayerDiagnostics, PlayerMode, PlayerProbe, PlayerSettings } from "../../shared/types";
import { AppError, errorMessage } from "../lib/app-error";

export interface PlayerServiceOptions {
  /** `process.resourcesPath` in packaged builds. */
  resourcesPath?: string;
  /** Repository root in development, for `vendor/mpv`. */
  appRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const PREVIEW_URL = "https://media.example/video.mp4";

export class PlayerService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: PlayerServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  probe(settings: PlayerSettings): PlayerDiagnostics {
    const mpvPath = this.resolveMpvPath(settings.mpvPath);
    let externalArgsPreview: string[] = [];
    let externalTemplateHasUrl = false;
    let templateError: string | undefined;
    try {
      externalTemplateHasUrl = templateIncludesUrl(settings.externalPlayerArgs);
      externalArgsPreview = buildExternalPlayerArgs(settings.externalPlayerArgs, {
        url: PREVIEW_URL,
        title: "IwaraTV Preview",
        headers: PLAYER_REFERER_HEADER
      });
    } catch (error) {
      templateError = errorMessage(error);
    }

    const externalPath = settings.externalPlayerPath;
    const externalExists = Boolean(externalPath && isExecutableFile(externalPath));
    const external: PlayerProbe = templateError
      ? { ok: false, code: "invalid-template", configuredPath: externalPath, detail: templateError }
      : !externalPath
        ? { ok: false, code: "not-configured" }
        : !externalExists
          ? { ok: false, code: "not-found", configuredPath: externalPath }
          : !externalTemplateHasUrl
            ? { ok: false, code: "missing-url-placeholder", configuredPath: externalPath, resolvedPath: externalPath }
            : { ok: true, code: "found", configuredPath: externalPath, resolvedPath: externalPath };

    return {
      mpv: mpvPath
        ? { ok: true, code: "found", configuredPath: settings.mpvPath, resolvedPath: mpvPath }
        : { ok: false, code: "not-found", configuredPath: settings.mpvPath },
      external,
      externalArgsPreview,
      externalTemplateHasUrl
    };
  }

  async testMpv(settings: PlayerSettings): Promise<PlayerProbe> {
    const mpvPath = this.resolveMpvPath(settings.mpvPath);
    if (!mpvPath) {
      return { ok: false, code: "not-found", configuredPath: settings.mpvPath };
    }
    return new Promise((resolve) => {
      const child = spawn(mpvPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 8000 });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        resolve({ ok: false, code: "launch-failed", configuredPath: settings.mpvPath, resolvedPath: mpvPath, detail: error.message });
      });
      child.once("close", (code) => {
        const version = output.split(/\r?\n/)[0]?.trim();
        resolve(
          code === 0
            ? { ok: true, code: "launch-ok", configuredPath: settings.mpvPath, resolvedPath: mpvPath, detail: version || undefined }
            : { ok: false, code: "launch-failed", configuredPath: settings.mpvPath, resolvedPath: mpvPath, detail: `exit code ${code ?? "?"}` }
        );
      });
    });
  }

  /** Resolves the executable for `mode`, or throws an actionable error. */
  requirePlayer(mode: PlayerMode, settings: PlayerSettings): string {
    if (mode === "mpv") {
      const mpvPath = this.resolveMpvPath(settings.mpvPath);
      if (!mpvPath) {
        throw new AppError("MPV_NOT_FOUND", "MPV was not found. Install MPV or choose its executable in Settings.");
      }
      return mpvPath;
    }

    const externalPath = settings.externalPlayerPath;
    if (!externalPath || !isExecutableFile(externalPath)) {
      throw new AppError("EXTERNAL_PLAYER_NOT_FOUND", "The external player path does not exist. Configure it in Settings.");
    }
    let hasUrl = false;
    try {
      hasUrl = templateIncludesUrl(settings.externalPlayerArgs);
    } catch (error) {
      throw new AppError("EXTERNAL_PLAYER_TEMPLATE", errorMessage(error));
    }
    if (!hasUrl) {
      throw new AppError("EXTERNAL_PLAYER_TEMPLATE", "The external player arguments must include {url}.");
    }
    return externalPath;
  }

  buildArgs(mode: PlayerMode, settings: PlayerSettings, url: string, title: string): string[] {
    if (mode === "mpv") {
      return ["--force-window=yes", `--title=${title}`, "--referrer=https://www.iwara.tv/", "--", url];
    }
    try {
      return buildExternalPlayerArgs(settings.externalPlayerArgs, { url, title, headers: PLAYER_REFERER_HEADER });
    } catch (error) {
      if (error instanceof PlayerTemplateError) {
        throw new AppError("EXTERNAL_PLAYER_TEMPLATE", error.message);
      }
      throw error;
    }
  }

  /** Starts the player detached; resolves once the OS has spawned it. */
  launch(playerPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(playerPath, args, { detached: true, stdio: "ignore" });
      child.once("error", (error) => {
        reject(new AppError("PLAYER_LAUNCH_FAILED", `Could not start the player: ${error.message}`));
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  resolveMpvPath(configuredPath?: string): string | undefined {
    const configured = configuredPath?.trim();
    if (configured && isExecutableFile(configured)) {
      return configured;
    }

    const isWindows = this.platform === "win32";
    const binary = isWindows ? "mpv.exe" : "mpv";
    const candidates: string[] = [];
    if (this.options.resourcesPath) {
      candidates.push(path.join(this.options.resourcesPath, "mpv", binary));
    }
    if (this.options.appRoot) {
      candidates.push(path.join(this.options.appRoot, "vendor", "mpv", binary));
    }
    candidates.push(...this.pathCandidates(binary));
    if (this.platform === "darwin") {
      candidates.push("/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv");
    } else if (this.platform === "linux") {
      candidates.push("/usr/bin/mpv", "/usr/local/bin/mpv", "/snap/bin/mpv");
    }

    return candidates.find(isExecutableFile);
  }

  private pathCandidates(binary: string): string[] {
    const pathValue = this.env.PATH ?? this.env.Path ?? "";
    return pathValue
      .split(this.platform === "win32" ? ";" : ":")
      .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean)
      .map((directory) => path.join(directory, binary));
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      accessSync(filePath, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

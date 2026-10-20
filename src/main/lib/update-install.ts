// Works out how this copy of IwaraTV was installed and how a verified update
// is applied to it. Electron calls are injected so this stays unit-testable.

import { chmod, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { UpdateInstallKind, UpdateStrategy } from "../../shared/types";
import type { UpdateEnvironment } from "../services/update-service";
import { assetKeyFor, type UpdateSource } from "./update-manifest";

const INSTALL_KINDS: readonly UpdateInstallKind[] = ["nsis", "portable", "archive", "appimage", "deb", "dmg", "dev"];

export interface InstallContext {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  version: string;
  paths: { userData: string; downloads: string; temp: string };
  exists(filePath: string): boolean;
  writable(directory: string): boolean;
}

export function detectInstallKind(context: InstallContext): UpdateInstallKind {
  const { env, execPath, platform } = context;
  if (!context.isPackaged) {
    // Development builds may pretend to be another install type to exercise the update flow.
    const override = env.IWARATV_UPDATE_INSTALL_KIND as UpdateInstallKind | undefined;
    return override && INSTALL_KINDS.includes(override) ? override : "dev";
  }
  if (platform === "darwin") {
    return "dmg";
  }
  if (platform === "win32") {
    if (env.PORTABLE_EXECUTABLE_FILE) {
      return "portable";
    }
    return context.exists(path.win32.join(path.win32.dirname(execPath), "Uninstall IwaraTV.exe")) ? "nsis" : "archive";
  }
  if (env.APPIMAGE) {
    return "appimage";
  }
  return execPath.startsWith("/opt/IwaraTV/") ? "deb" : "archive";
}

const STRATEGIES: Record<UpdateInstallKind, UpdateStrategy> = {
  nsis: "automatic",
  appimage: "automatic",
  portable: "assisted",
  archive: "assisted",
  deb: "assisted",
  dmg: "assisted",
  dev: "none"
};

export function resolveUpdateEnvironment(
  context: InstallContext,
  options: { source: UpdateSource; publicKey?: string }
): UpdateEnvironment {
  const installKind = detectInstallKind(context);
  const assetKey = assetKeyFor(installKind, context.platform, context.arch);
  let strategy = STRATEGIES[installKind];
  let downloadDirectory = context.paths.downloads;
  let ownsDownloadDirectory = false;

  if (!context.isPackaged) {
    downloadDirectory = path.join(context.paths.userData, "updates");
    ownsDownloadDirectory = true;
  } else if (installKind === "nsis") {
    downloadDirectory = path.join(context.env.LOCALAPPDATA || context.paths.temp, "IwaraTV-updates");
    ownsDownloadDirectory = true;
  } else if (installKind === "appimage") {
    // The new AppImage is written next to the old one so the swap is a rename.
    const directory = path.dirname(context.env.APPIMAGE!);
    if (context.writable(directory)) {
      downloadDirectory = directory;
    } else {
      strategy = "assisted";
    }
  } else if (installKind === "portable") {
    const directory = context.env.PORTABLE_EXECUTABLE_DIR;
    if (directory && context.writable(directory)) {
      downloadDirectory = directory;
    }
  }

  return {
    currentVersion: context.version,
    installKind,
    assetKey,
    strategy: assetKey ? strategy : "none",
    downloadDirectory,
    ownsDownloadDirectory,
    source: options.source,
    publicKey: options.publicKey
  };
}

export interface InstallerDeps {
  /** Starts a program without waiting for it; resolves once it has started. */
  spawnDetached(command: string, args: string[]): Promise<void>;
  /** Starts `execPath` once this instance has exited. */
  relaunch(execPath: string): void;
  quit(): void;
  openPath(filePath: string): Promise<void>;
  showItemInFolder(filePath: string): void;
}

/** Returns the function that applies a verified update file on this install. */
export function createInstaller(environment: UpdateEnvironment, context: InstallContext, deps: InstallerDeps) {
  return async (filePath: string): Promise<void> => {
    const { installKind, strategy } = environment;
    if (!context.isPackaged || strategy === "none") {
      deps.showItemInFolder(filePath);
      return;
    }
    if (strategy === "automatic" && installKind === "nsis") {
      // electron-builder's NSIS flags: keep the install location, stay silent, start the app afterwards.
      await deps.spawnDetached(filePath, ["--updated", "/S", "--force-run"]);
      deps.quit();
      return;
    }
    if (strategy === "automatic" && installKind === "appimage" && context.env.APPIMAGE) {
      const launch = await replaceAppImage(filePath, context.env.APPIMAGE, context.version);
      deps.relaunch(launch);
      deps.quit();
      return;
    }
    if (installKind === "deb" || installKind === "dmg") {
      // The system installer (.deb) or Finder (.dmg) takes it from here.
      await deps.openPath(filePath);
      return;
    }
    deps.showItemInFolder(filePath);
  };
}

/**
 * Puts a downloaded AppImage in place of the running one. Release file names
 * carry the version, so a file named like a release keeps the new name and the
 * old file is removed; a renamed AppImage keeps its name so shortcuts still work.
 * Returns the path to start.
 */
export async function replaceAppImage(downloaded: string, current: string, currentVersion: string): Promise<string> {
  await chmod(downloaded, 0o755);
  const sameFile = path.resolve(downloaded) === path.resolve(current);
  if (path.basename(current).includes(currentVersion)) {
    if (!sameFile) {
      await rm(current, { force: true });
    }
    return downloaded;
  }
  if (!sameFile) {
    await rename(downloaded, current);
  }
  return current;
}

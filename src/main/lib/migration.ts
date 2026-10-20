import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_FILES = ["settings.json", "favorites.json", "downloads.json"];
const MARKER_FILE = ".migration.json";
const TAURI_IDENTIFIER = "local.iwaratv.player";

/** Where the Tauri build kept its data (Tauri's `app_data_dir()`). */
export function tauriDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string {
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), TAURI_IDENTIFIER);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", TAURI_IDENTIFIER);
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), TAURI_IDENTIFIER);
}

/**
 * Copies settings, favorites and download history from the Tauri build on the
 * first launch of this build. Files already in `userDataPath` are kept as
 * `*.pre-migration.json`. Returns the source directory when data was copied.
 */
export function migrateLegacyData(userDataPath: string, sourceDirectory = tauriDataDirectory()): string | undefined {
  const markerPath = path.join(userDataPath, MARKER_FILE);
  if (existsSync(markerPath)) {
    return undefined;
  }

  mkdirSync(userDataPath, { recursive: true });
  const copied: string[] = [];
  if (path.resolve(sourceDirectory) !== path.resolve(userDataPath)) {
    for (const fileName of DATA_FILES) {
      const source = path.join(sourceDirectory, fileName);
      if (!existsSync(source)) {
        continue;
      }
      const target = path.join(userDataPath, fileName);
      if (existsSync(target)) {
        copyFileSync(target, path.join(userDataPath, fileName.replace(/\.json$/, ".pre-migration.json")));
      }
      copyFileSync(source, target);
      copied.push(fileName);
    }
  }

  writeFileSync(
    markerPath,
    `${JSON.stringify({ migratedAt: new Date().toISOString(), source: copied.length ? sourceDirectory : null, files: copied }, null, 2)}\n`
  );
  return copied.length ? sourceDirectory : undefined;
}

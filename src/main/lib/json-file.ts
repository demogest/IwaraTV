import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Writes JSON through a temporary file and a rename so a crash or power loss
 * never leaves a half-written settings/favorites/downloads file behind.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges `patch` onto `base` (objects only; arrays and scalars replace). */
export function mergeJson(base: unknown, patch: unknown): unknown {
  if (isRecord(base) && isRecord(patch)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      merged[key] = key in base ? mergeJson(base[key], value) : value;
    }
    return merged;
  }
  return patch === undefined ? base : patch;
}

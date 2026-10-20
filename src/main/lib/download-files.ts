import { stat } from "node:fs/promises";
import path from "node:path";
import type { VideoFormat } from "../../shared/types";
import { AppError } from "./app-error";

export const DOWNLOAD_SEGMENT_FLOOR_BYTES = 1024 * 1024;
export const MAX_DOWNLOAD_CONNECTIONS = 8;

export interface DownloadSegment {
  index: number;
  start: number;
  end: number;
}

/** Splits `totalBytes` into contiguous inclusive byte ranges. */
export function downloadSegments(totalBytes: number, maxConnections: number): DownloadSegment[] {
  const count = Math.max(
    1,
    Math.min(Math.max(1, maxConnections), MAX_DOWNLOAD_CONNECTIONS, Math.max(1, Math.floor(totalBytes / DOWNLOAD_SEGMENT_FLOOR_BYTES)))
  );
  const segmentSize = Math.ceil(totalBytes / count);
  const segments: DownloadSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * segmentSize;
    if (start >= totalBytes) {
      break;
    }
    segments.push({ index, start, end: Math.min((index + 1) * segmentSize - 1, totalBytes - 1) });
  }
  return segments;
}

export function totalBytesFromContentRange(value: string | null | undefined): number | undefined {
  const total = value?.split("/").at(-1)?.trim();
  if (!total || !/^\d+$/.test(total)) {
    return undefined;
  }
  return Number(total);
}

export function partialDownloadPath(filePath: string): string {
  return `${filePath}.part`;
}

export function segmentPartPath(filePath: string, index: number): string {
  return `${filePath}.part${index}`;
}

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFileStem(value: string): string {
  const sanitized = [...value]
    .map((character) => (/[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const stem = sanitized && !WINDOWS_RESERVED_NAMES.test(sanitized) ? sanitized : `Iwara Video${sanitized ? ` ${sanitized}` : ""}`;
  return [...stem].slice(0, 150).join("").trim();
}

// Only video containers: a server-chosen extension like .bat or .hta would
// otherwise run when the user clicks "Play file".
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mkv", "mov"]);

function isSafeExtension(value: string): boolean {
  return VIDEO_EXTENSIONS.has(value.toLowerCase());
}

export function downloadExtension(format: VideoFormat): string {
  if (format.ext && isSafeExtension(format.ext)) {
    return format.ext.toLowerCase();
  }
  try {
    const name = new URL(format.url).pathname.split("/").at(-1) ?? "";
    const extension = path.extname(name).slice(1).toLowerCase();
    if (isSafeExtension(extension)) {
      return extension;
    }
  } catch {
    // Fall through to the default.
  }
  return "mp4";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * `Title [id] - 1080.mp4`, then `Title [id] - 1080 (1).mp4`, ... The name is
 * deterministic so a retry lands on the same `.part` files and resumes.
 */
export async function uniqueDownloadPath(
  directory: string,
  title: string,
  videoId: string,
  format: VideoFormat,
  inUse: ReadonlySet<string> = new Set()
): Promise<string> {
  const extension = downloadExtension(format);
  const stem = sanitizeFileStem(`${title} [${videoId}] - ${format.label}`);
  for (let index = 0; index < 1000; index += 1) {
    const fileName = index === 0 ? `${stem}.${extension}` : `${stem} (${index}).${extension}`;
    const candidate = path.join(directory, fileName);
    // Paths of running downloads are taken even before their file exists.
    if (!inUse.has(candidate) && !(await exists(candidate))) {
      return candidate;
    }
  }
  throw new AppError("DOWNLOAD_FAILED", "Could not create a unique file name for the download.");
}

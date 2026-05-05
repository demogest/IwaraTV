import { createHash } from "node:crypto";
import type { VideoFormat } from "./types";

const IWARA_VIDEO_ID = /^[a-zA-Z0-9]{6,}$/;
const IWARA_VIDEO_URL = /iwara\.tv\/videos?\/([a-zA-Z0-9]+)/i;
export const DEFAULT_X_VERSION_SALT = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";

export function parseIwaraVideoId(input: string): string {
  const trimmed = input.trim();
  if (IWARA_VIDEO_ID.test(trimmed)) {
    return trimmed;
  }

  const match = trimmed.match(IWARA_VIDEO_URL);
  if (match?.[1]) {
    return match[1];
  }

  throw new Error("无法识别 Iwara 视频 ID 或链接。");
}

export function buildXVersion(fileUrl: string, salt = DEFAULT_X_VERSION_SALT): string {
  const parsed = new URL(fileUrl);
  const expires = parsed.searchParams.get("expires");
  const pathParts = parsed.pathname.replace(/\/$/, "").split("/");
  const fileId = pathParts[pathParts.length - 1];

  if (!expires || !fileId) {
    throw new Error("Iwara fileUrl 缺少生成 X-Version 所需的参数。");
  }

  return createHash("sha1")
    .update([fileId, expires, salt].join("_"))
    .digest("hex");
}

export function extractXVersionSaltFromScript(script: string): string | undefined {
  const candidates = [...script.matchAll(/["']_([A-Za-z0-9]{20,80})["']/g)]
    .map((match) => ({ salt: match[1], index: match.index ?? 0 }))
    .filter((candidate) => /[A-Z]/.test(candidate.salt) && /[a-z]/.test(candidate.salt) && /\d/.test(candidate.salt));

  if (!candidates.length) {
    return undefined;
  }

  const scored = candidates.map((candidate) => {
    const context = script.slice(Math.max(0, candidate.index - 1200), candidate.index + 1600);
    const score = [
      "X-Version",
      "fileUrl",
      "expires",
      "SHA-1",
      "crypto.subtle.digest"
    ].reduce((total, needle) => total + (context.includes(needle) ? 1 : 0), 0);

    return { ...candidate, score };
  });

  return scored.sort((a, b) => b.score - a.score || b.salt.length - a.salt.length)[0]?.salt;
}

export function withIwaraDownloadName(fileUrl: string, title: string, videoId: string): string {
  const parsed = new URL(fileUrl);
  parsed.searchParams.set("download", `Iwara - ${title} [${videoId}].mp4`);
  return parsed.toString();
}

export function normalizeMediaUrl(url: string): string {
  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  return url;
}

export function qualityRank(label: string): number {
  const normalized = label.toLowerCase();
  if (normalized === "source") {
    return 4000;
  }

  if (normalized === "preview") {
    return 1;
  }

  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function chooseVideoFormat(formats: VideoFormat[], preferredQuality?: string): VideoFormat | undefined {
  if (!formats.length) {
    return undefined;
  }

  if (preferredQuality) {
    const preferred = formats.find((format) => format.id === preferredQuality || format.label === preferredQuality);
    if (preferred) {
      return preferred;
    }
  }

  return [...formats].sort((a, b) => b.qualityRank - a.qualityRank)[0];
}

export function formatToExtension(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }

  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  return undefined;
}

import { createHash } from "node:crypto";
import type { VideoFormat } from "./types";

const IWARA_VIDEO_ID = /^[a-zA-Z0-9]{6,}$/;
const IWARA_VIDEO_URL = /iwara\.tv\/videos?\/([a-zA-Z0-9]+)/i;
const X_VERSION_SALT = "5nFp9kmbNnHdAFhaqMvt";

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

export function buildXVersion(fileUrl: string): string {
  const parsed = new URL(fileUrl);
  const expires = parsed.searchParams.get("expires");
  const pathParts = parsed.pathname.replace(/\/$/, "").split("/");
  const fileId = pathParts[pathParts.length - 1];

  if (!expires || !fileId) {
    throw new Error("Iwara fileUrl 缺少生成 X-Version 所需的参数。");
  }

  return createHash("sha1")
    .update([fileId, expires, X_VERSION_SALT].join("_"))
    .digest("hex");
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


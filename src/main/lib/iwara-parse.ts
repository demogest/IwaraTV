// Maps raw Iwara API JSON into the app's data shapes. Every function here is
// defensive: the API is undocumented and fields come and go.

import { isIwaraUrl } from "../../shared/media-hosts";
import type { VideoComment, VideoFormat, VideoSummary } from "../../shared/types";
import { usernameFromJwt } from "./jwt";

const IMAGE_BASE = "https://i.iwara.tv/image";

type Json = unknown;

export function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function field(value: Json, key: string): Json {
  return isObject(value) ? value[key] : undefined;
}

export function valueToString(value: Json): string | undefined {
  if (typeof value === "string") {
    return value.length ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function valueToCount(value: Json): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function mapVideoSummary(raw: Json): VideoSummary {
  const user = field(raw, "user");
  const file = field(raw, "file");
  const tags = field(raw, "tags");

  return compact({
    id: valueToString(field(raw, "id")) ?? "",
    title: valueToString(field(raw, "title")) ?? "Untitled",
    description: plainText(field(raw, "body")),
    uploaderId: valueToString(field(user, "id")),
    uploaderName: valueToString(field(user, "name")),
    uploaderUsername: valueToString(field(user, "username")),
    uploaderAvatarUrl: avatarUrl(field(user, "avatar")),
    uploaderFollowing: typeof field(user, "following") === "boolean" ? (field(user, "following") as boolean) : undefined,
    thumbnailUrl: thumbnailUrl(raw),
    rating: valueToString(field(raw, "rating")),
    tags: Array.isArray(tags)
      ? tags.map((tag) => (typeof tag === "string" ? tag : valueToString(field(tag, "id")))).filter((tag): tag is string => Boolean(tag))
      : [],
    numViews: valueToCount(field(raw, "numViews")),
    numLikes: valueToCount(field(raw, "numLikes")),
    numComments: valueToCount(field(raw, "numComments")),
    durationSeconds: firstDurationSeconds([field(raw, "duration"), field(file, "duration"), field(raw, "length"), field(file, "length")]),
    createdAt: valueToString(field(raw, "createdAt")),
    updatedAt: valueToString(field(raw, "updatedAt"))
  });
}

export function mapVideoComment(raw: Json): VideoComment | undefined {
  const user = field(raw, "user");
  const body = plainText(field(raw, "body") ?? field(raw, "comment") ?? field(raw, "text"));
  if (!body) {
    return undefined;
  }

  return compact({
    id: valueToString(field(raw, "id"))
      ?? `${valueToString(field(user, "username")) ?? "comment"}-${valueToString(field(raw, "createdAt")) ?? ""}`,
    body,
    authorName: valueToString(field(user, "name")),
    authorUsername: valueToString(field(user, "username")),
    authorAvatarUrl: avatarUrl(field(user, "avatar")),
    createdAt: valueToString(field(raw, "createdAt")),
    numLikes: valueToCount(field(raw, "numLikes")),
    numReplies: valueToCount(field(raw, "numReplies"))
  });
}

export function mapVideoFormat(raw: Json): VideoFormat | undefined {
  const label = valueToString(field(raw, "name"))
    ?? valueToString(field(raw, "label"))
    ?? valueToString(field(raw, "quality"))
    ?? valueToString(field(raw, "height"))
    ?? "unknown";
  const rawUrl = formatUrl(raw);
  const url = rawUrl ? normalizeMediaUrl(rawUrl) : undefined;
  // Media requests carry the session token and the URL goes to a local
  // player, so anything that isn't an https Iwara link is dropped.
  if (!url || !isIwaraUrl(url)) {
    return undefined;
  }
  const mimeType = valueToString(field(raw, "type"));
  const height = /^\d+$/.test(label) ? Number(label) : undefined;

  return compact({
    id: label,
    label,
    url,
    mimeType,
    ext: formatToExtension(mimeType),
    height,
    qualityRank: qualityRank(label)
  });
}

function formatUrl(raw: Json): string | undefined {
  const src = field(raw, "src");
  if (typeof src === "string" && src) {
    return src;
  }
  if (isObject(src)) {
    return valueToString(src.download) ?? valueToString(src.view) ?? valueToString(src.src) ?? valueToString(src.url);
  }
  return valueToString(field(raw, "download")) ?? valueToString(field(raw, "view")) ?? valueToString(field(raw, "url"));
}

export function normalizeMediaUrl(value: string): string {
  return value.startsWith("//") ? `https:${value}` : value;
}

export function qualityRank(label: string): number {
  const normalized = label.toLowerCase();
  if (normalized === "source") {
    return 4000;
  }
  if (normalized === "preview") {
    return 1;
  }
  return /^\d+$/.test(normalized) ? Number(normalized) : 0;
}

export function formatToExtension(mimeType: string | undefined): string | undefined {
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

/** Picks the requested quality when available, otherwise the best one. */
export function chooseVideoFormat(formats: readonly VideoFormat[], preferredQuality?: string): VideoFormat | undefined {
  if (preferredQuality) {
    const found = formats.find((format) => format.id === preferredQuality || format.label === preferredQuality);
    if (found) {
      return found;
    }
  }
  return bestFormat(formats);
}

export function bestFormat(formats: readonly VideoFormat[]): VideoFormat | undefined {
  return formats.reduce<VideoFormat | undefined>(
    (best, format) => (!best || format.qualityRank > best.qualityRank ? format : best),
    undefined
  );
}

export function bestQualityRank(formats: readonly VideoFormat[]): number {
  return formats.reduce((best, format) => Math.max(best, format.qualityRank), 0);
}

export function normalizeFileList(value: Json): Json[] {
  if (Array.isArray(value)) {
    return value;
  }
  for (const key of ["files", "results", "data"]) {
    const list = field(value, key);
    if (Array.isArray(list)) {
      return list;
    }
  }
  return [];
}

export function formatsFromJson(value: Json): VideoFormat[] {
  return normalizeFileList(value)
    .map(mapVideoFormat)
    .filter((format): format is VideoFormat => Boolean(format));
}

export function summarizeJsonResponse(body: string): { formatLabels: string[]; formats?: VideoFormat[]; responseShape: string } {
  try {
    const json = JSON.parse(body) as Json;
    const formats = formatsFromJson(json);
    return { formatLabels: formats.map((format) => format.label), formats, responseShape: responseShape(json) };
  } catch {
    return { formatLabels: [], responseShape: "non-json" };
  }
}

export function responseShape(value: Json): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (isObject(value)) {
    return `object(${Object.keys(value).join(", ")})`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Thumbnail URL as built by www.iwara.tv: a custom thumbnail when the
 * uploader set one, otherwise the selected auto-generated frame.
 */
export function thumbnailUrl(video: Json): string | undefined {
  const customId = valueToString(field(field(video, "customThumbnail"), "id"));
  if (customId) {
    return `${IMAGE_BASE}/thumbnail/${customId}/${customId}.jpg`;
  }
  const fileId = valueToString(field(field(video, "file"), "id"));
  if (!fileId) {
    return undefined;
  }
  const index = field(video, "thumbnail");
  const frame = typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
  return `${IMAGE_BASE}/thumbnail/${fileId}/thumbnail-${String(frame).padStart(2, "0")}.jpg`;
}

/** Avatar URL as built by www.iwara.tv (`{id}/{id}.jpg`, whatever the upload name). */
export function avatarUrl(avatar: Json): string | undefined {
  const avatarId = valueToString(field(avatar, "id")) ?? valueToString(avatar);
  return avatarId ? `${IMAGE_BASE}/avatar/${avatarId}/${avatarId}.jpg` : undefined;
}

export interface AuthProfile {
  username?: string;
  avatarUrl?: string;
}

export function extractAuthProfile(response: Json, token?: string): AuthProfile {
  return {
    username: extractAuthUsername(response) ?? (token ? usernameFromJwt(token) : undefined),
    avatarUrl: extractAuthAvatarUrl(response)
  };
}

function extractAuthUsername(response: Json): string | undefined {
  const fromRecord = (record: Json) =>
    valueToString(field(record, "username"))
    ?? valueToString(field(record, "name"))
    ?? valueToString(field(record, "displayName"))
    ?? valueToString(field(record, "display_name"));
  const user = field(response, "user");
  return (isObject(user) ? fromRecord(user) : undefined) ?? fromRecord(response);
}

function extractAuthAvatarUrl(response: Json): string | undefined {
  return avatarUrl(field(field(response, "user"), "avatar"))
    ?? avatarUrl(field(field(field(response, "data"), "user"), "avatar"))
    ?? avatarUrl(field(response, "avatar"));
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'"
};

/** Converts Iwara's HTML-ish bodies into plain text with paragraph breaks. */
export function plainText(value: Json): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const text = trimmed
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

function firstDurationSeconds(values: Json[]): number | undefined {
  for (const value of values) {
    const seconds = durationSeconds(value);
    if (seconds !== undefined) {
      return seconds;
    }
  }
  return undefined;
}

export function durationSeconds(value: Json): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    // Some endpoints report milliseconds.
    return Math.round(value > 360_000 ? value / 1000 : value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return durationSeconds(numeric);
  }
  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return undefined;
  }
  if (parts.length === 2) {
    return parts[0]! * 60 + parts[1]!;
  }
  if (parts.length === 3) {
    return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  return undefined;
}

/** Hides signed query strings when URLs are shown in diagnostics. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search) {
      parsed.search = "?...";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function looksLikeCloudflare(text: string): boolean {
  const normalized = text.slice(0, 4096).toLowerCase();
  return normalized.includes("<html") || normalized.includes("cloudflare") || normalized.includes("just a moment");
}

/** Drops `undefined` properties so IPC payloads stay small and stable. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

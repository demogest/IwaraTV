import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FavoriteFileResult, FavoriteImportResult, FavoriteItem, FavoriteState, VideoSummary } from "../../shared/types";
import { AppError } from "../lib/app-error";
import { isRecord, readJsonFile, writeJsonFileAtomic } from "../lib/json-file";

const FAVORITES_SCHEMA_VERSION = 1;

type Listener = (state: FavoriteState) => void;

export class FavoriteStore {
  private readonly filePath: string;
  private items: FavoriteItem[];
  private readonly listeners = new Set<Listener>();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "favorites.json");
    this.items = dedupeFavorites(parseFavorites(readJsonFile(this.filePath)) ?? []);
  }

  state(): FavoriteState {
    return { items: structuredClone(this.items) };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a video, or refreshes its metadata and moves it to the top. */
  add(video: VideoSummary): FavoriteState {
    return this.upsert({ video, favoritedAt: new Date().toISOString() });
  }

  /** Re-inserts a previously removed item with its original timestamp (undo). */
  restore(item: FavoriteItem): FavoriteState {
    const normalized = normalizeFavoriteItem(item);
    if (!normalized) {
      throw new AppError("INVALID_INPUT", "The favorite item is missing a video ID.");
    }
    return this.upsert(normalized, true);
  }

  remove(videoId: string): FavoriteState {
    return this.commit(this.items.filter((item) => item.video.id !== videoId));
  }

  backupPath(): string {
    return path.join(path.dirname(this.filePath), "favorites.backup.json");
  }

  exportToPath(filePath: string): FavoriteFileResult {
    writeJsonFileAtomic(filePath, {
      schemaVersion: FAVORITES_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      items: this.items
    });
    return { canceled: false, path: filePath, count: this.items.length };
  }

  async importFromPath(filePath: string): Promise<FavoriteImportResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch {
      throw new AppError("FAVORITES_FILE_INVALID", "The selected file is not valid JSON.");
    }
    const incoming = parseFavorites(raw);
    if (!incoming) {
      throw new AppError("FAVORITES_FILE_INVALID", "The selected file does not contain an IwaraTV favorites list.");
    }

    const items = structuredClone(this.items);
    const pendingNew: FavoriteItem[] = [];
    let imported = 0;
    let merged = 0;
    let skipped = 0;
    const seenIncoming = new Set<string>();

    for (const candidate of incoming) {
      const item = normalizeFavoriteItem(candidate);
      if (!item || seenIncoming.has(item.video.id)) {
        skipped += 1;
        continue;
      }
      seenIncoming.add(item.video.id);
      const current = items.find((existing) => existing.video.id === item.video.id);
      if (current) {
        mergeFavoriteItem(current, item);
        merged += 1;
      } else {
        pendingNew.push(item);
        imported += 1;
      }
    }

    const state = this.commit([...pendingNew, ...items]);
    return { canceled: false, path: filePath, imported, merged, skipped, total: state.items.length, state };
  }

  private upsert(item: FavoriteItem, keepTimestamp = false): FavoriteState {
    const existing = this.items.find((current) => current.video.id === item.video.id);
    const next: FavoriteItem = existing
      ? {
          ...existing,
          video: item.video,
          favoritedAt: keepTimestamp ? item.favoritedAt : existing.favoritedAt,
          note: existing.note ?? item.note
        }
      : item;
    return this.commit([next, ...this.items.filter((current) => current.video.id !== item.video.id)]);
  }

  private commit(items: FavoriteItem[]): FavoriteState {
    writeJsonFileAtomic(this.filePath, { items });
    this.items = items;
    const state = this.state();
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}

/** Accepts the export format, the on-disk state format, or a bare array. */
function parseFavorites(raw: unknown): FavoriteItem[] | undefined {
  if (Array.isArray(raw)) {
    return raw as FavoriteItem[];
  }
  if (isRecord(raw) && Array.isArray(raw.items)) {
    return raw.items as FavoriteItem[];
  }
  return undefined;
}

function dedupeFavorites(items: unknown[]): FavoriteItem[] {
  const seen = new Set<string>();
  const result: FavoriteItem[] = [];
  for (const candidate of items) {
    const item = normalizeFavoriteItem(candidate);
    if (item && !seen.has(item.video.id)) {
      seen.add(item.video.id);
      result.push(item);
    }
  }
  return result;
}

export function normalizeFavoriteItem(candidate: unknown): FavoriteItem | undefined {
  if (!isRecord(candidate) || !isRecord(candidate.video)) {
    return undefined;
  }
  const video = candidate.video as unknown as VideoSummary;
  const id = typeof video.id === "string" ? video.id.trim() : "";
  if (!id) {
    return undefined;
  }
  const title = typeof video.title === "string" && video.title.trim() ? video.title.trim() : id;
  const favoritedAt = typeof candidate.favoritedAt === "string" && candidate.favoritedAt.trim()
    ? candidate.favoritedAt
    : new Date().toISOString();
  return {
    video: {
      ...video,
      id,
      title,
      tags: Array.isArray(video.tags) ? video.tags.filter((tag) => typeof tag === "string") : [],
      numViews: typeof video.numViews === "number" ? video.numViews : 0,
      numLikes: typeof video.numLikes === "number" ? video.numLikes : 0,
      numComments: typeof video.numComments === "number" ? video.numComments : 0
    },
    favoritedAt,
    ...(typeof candidate.note === "string" ? { note: candidate.note } : {})
  };
}

/** Keeps local data, filling gaps from the imported copy; keeps the earliest favorite date. */
function mergeFavoriteItem(current: FavoriteItem, incoming: FavoriteItem): void {
  if (incoming.favoritedAt < current.favoritedAt) {
    current.favoritedAt = incoming.favoritedAt;
  }
  current.note ??= incoming.note;
  const video = current.video as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(incoming.video)) {
    const existing = video[key];
    const missing = existing === undefined
      || (typeof existing === "string" && !existing.trim())
      || (Array.isArray(existing) && existing.length === 0)
      || (typeof existing === "number" && existing === 0);
    if (missing && value !== undefined) {
      video[key] = value;
    }
  }
}

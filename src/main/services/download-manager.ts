import path from "node:path";
import type {
  DownloadDeleteRequest,
  DownloadState,
  DownloadTask,
  DownloadTaskStatus,
  DownloadVideoRequest,
  VideoSummary
} from "../../shared/types";
import { AppError, serializeError } from "../lib/app-error";
import { removeDownloadArtifacts, removePartialArtifacts, type ProgressCallback } from "../lib/file-transfer";
import { isRecord, readJsonFile, writeJsonFileAtomic } from "../lib/json-file";
import type { DownloadPlan } from "./iwara-client";

const MAX_HISTORY_ITEMS = 200;
const EMIT_INTERVAL_MS = 200;
const SPEED_WINDOW_MS = 1000;

export interface DownloadEngine {
  /** `inUse` lists the target paths of other running downloads, which must not be reused. */
  prepare(request: DownloadVideoRequest, signal: AbortSignal, inUse: ReadonlySet<string>): Promise<DownloadPlan>;
  transfer(plan: DownloadPlan, onProgress: ProgressCallback, signal: AbortSignal): Promise<number>;
}

type Listener = (state: DownloadState) => void;

const SHUTDOWN = Symbol("shutdown");
const CANCELED = Symbol("canceled");

export class DownloadManager {
  private readonly filePath: string;
  private active: DownloadTask[] = [];
  private history: DownloadTask[];
  private readonly controllers = new Map<string, AbortController>();
  private readonly speedWindows = new Map<string, { time: number; bytes: number }>();
  private readonly listeners = new Set<Listener>();
  private emitTimer?: NodeJS.Timeout;
  private running = 0;
  private nextId = 1;
  private shuttingDown = false;

  constructor(
    userDataPath: string,
    private readonly engine: DownloadEngine,
    private readonly maxConcurrent = 2
  ) {
    this.filePath = path.join(userDataPath, "downloads.json");
    this.history = loadHistory(this.filePath);
  }

  state(): DownloadState {
    return structuredClone({ active: this.active, history: this.history });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  task(id: string): DownloadTask | undefined {
    const found = this.active.find((task) => task.id === id) ?? this.history.find((task) => task.id === id);
    return found ? structuredClone(found) : undefined;
  }

  /** Queues a download; an identical active request is returned instead of duplicated. */
  start(request: DownloadVideoRequest): DownloadTask {
    const existing = this.active.find((task) => task.videoId === request.videoId && task.requestedQuality === request.quality);
    if (existing) {
      return structuredClone(existing);
    }
    const now = new Date().toISOString();
    const task: DownloadTask = {
      id: `download-${Date.now()}-${this.nextId++}`,
      videoId: request.videoId,
      requestedQuality: request.quality,
      status: "queued",
      bytesWritten: 0,
      createdAt: now,
      updatedAt: now
    };
    this.active.unshift(task);
    this.emitNow();
    this.pump();
    return structuredClone(task);
  }

  /** Moves a finished task back into the queue; partial files are resumed. */
  retry(id: string): DownloadTask {
    const index = this.history.findIndex((task) => task.id === id);
    const previous = this.history[index];
    if (!previous) {
      throw new AppError("DOWNLOAD_NOT_FOUND", "No download record to retry.");
    }
    const duplicate = this.active.find((task) => task.videoId === previous.videoId && task.requestedQuality === previous.requestedQuality);
    if (duplicate) {
      return structuredClone(duplicate);
    }
    this.history.splice(index, 1);
    const task: DownloadTask = {
      ...previous,
      requestedQuality: previous.requestedQuality ?? previous.format?.id,
      status: "queued",
      error: undefined,
      errorCode: undefined,
      errorDetails: undefined,
      bytesPerSecond: undefined,
      completedAt: undefined,
      updatedAt: new Date().toISOString()
    };
    this.active.unshift(task);
    this.persist();
    this.emitNow();
    this.pump();
    return structuredClone(task);
  }

  cancel(id: string): DownloadState {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort(CANCELED);
    } else {
      const task = this.takeActive(id);
      if (task) {
        this.finish(task, "canceled");
      }
    }
    return this.state();
  }

  async delete(request: DownloadDeleteRequest): Promise<DownloadState> {
    if (this.active.some((task) => task.id === request.id)) {
      throw new AppError("DOWNLOAD_ACTIVE", "Cancel the download before deleting it.");
    }
    const index = this.history.findIndex((task) => task.id === request.id);
    const removed = index >= 0 ? this.history.splice(index, 1)[0] : undefined;
    if (removed) {
      if (request.deleteFile && removed.path) {
        // Unfinished records may share a path with a later successful
        // download of the same video, so they only own their .part files.
        // A running download may be resuming the same .part files.
        const stillReferenced = this.history.some((task) => task.path === removed.path);
        const inUse = this.active.some((task) => task.path === removed.path);
        if (!inUse) {
          await (removed.status === "completed" && !stillReferenced
            ? removeDownloadArtifacts(removed.path)
            : removePartialArtifacts(removed.path));
        }
      }
      this.persist();
      this.emitNow();
    }
    return this.state();
  }

  /** Forgets finished records without touching files on disk. */
  clearFinished(): DownloadState {
    this.history = [];
    this.persist();
    this.emitNow();
    return this.state();
  }

  /** Stops transfers on quit and records them as canceled so they can be resumed. */
  shutdown(): void {
    this.shuttingDown = true;
    clearTimeout(this.emitTimer);
    for (const controller of this.controllers.values()) {
      controller.abort(SHUTDOWN);
    }
    const now = new Date().toISOString();
    for (const task of this.active) {
      this.history.unshift({ ...task, status: "canceled", bytesPerSecond: undefined, updatedAt: now, completedAt: now });
    }
    this.active = [];
    this.history = this.history.slice(0, MAX_HISTORY_ITEMS);
    this.persist();
  }

  private pump(): void {
    while (!this.shuttingDown && this.running < this.maxConcurrent) {
      const next = [...this.active].reverse().find((task) => task.status === "queued" && !this.controllers.has(task.id));
      if (!next) {
        return;
      }
      this.running += 1;
      void this.run(next.id).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const task = this.active.find((item) => item.id === id);
    if (!task) {
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const request = { videoId: task.videoId, quality: task.requestedQuality };
      let plan = await this.engine.prepare(request, controller.signal, this.pathsInUse(id));
      controller.signal.throwIfAborted();
      if (this.pathsInUse(id).has(plan.path)) {
        // Another download claimed the same name while this one was preparing.
        plan = await this.engine.prepare(request, controller.signal, this.pathsInUse(id));
        controller.signal.throwIfAborted();
        if (this.pathsInUse(id).has(plan.path)) {
          throw new AppError("DOWNLOAD_FAILED", "Another download is already writing this file.", { reason: "fileInUse" });
        }
      }
      this.update(id, {
        status: "downloading",
        video: summaryOf(plan.video),
        format: plan.format,
        path: plan.path,
        directory: path.dirname(plan.path),
        fallbackFrom: plan.fallbackFrom
      });
      this.emitNow();

      const bytesWritten = await this.engine.transfer(plan, (written, total) => this.progress(id, written, total), controller.signal);
      const finished = this.takeActive(id);
      if (finished) {
        this.finish({ ...finished, bytesWritten, totalBytes: bytesWritten }, "completed");
      }
    } catch (error) {
      if (this.shuttingDown || controller.signal.reason === SHUTDOWN) {
        return;
      }
      const finished = this.takeActive(id);
      if (!finished) {
        return;
      }
      if (controller.signal.aborted && controller.signal.reason === CANCELED) {
        this.finish(finished, "canceled");
      } else {
        const serialized = serializeError(error);
        this.finish({ ...finished, error: serialized.message, errorCode: serialized.code, errorDetails: serialized.details }, "failed");
      }
    } finally {
      this.controllers.delete(id);
      this.speedWindows.delete(id);
    }
  }

  private pathsInUse(exceptId: string): Set<string> {
    return new Set(this.active.filter((task) => task.id !== exceptId && task.path).map((task) => task.path!));
  }

  private progress(id: string, bytesWritten: number, totalBytes: number | undefined): void {
    const task = this.active.find((item) => item.id === id);
    if (!task) {
      return;
    }
    const now = Date.now();
    const window = this.speedWindows.get(id);
    if (!window) {
      this.speedWindows.set(id, { time: now, bytes: bytesWritten });
    } else if (now - window.time >= SPEED_WINDOW_MS) {
      const rate = ((bytesWritten - window.bytes) * 1000) / (now - window.time);
      task.bytesPerSecond = Math.max(0, Math.round(task.bytesPerSecond ? task.bytesPerSecond * 0.4 + rate * 0.6 : rate));
      this.speedWindows.set(id, { time: now, bytes: bytesWritten });
    }
    task.bytesWritten = bytesWritten;
    task.totalBytes = totalBytes ?? task.totalBytes;
    task.updatedAt = new Date(now).toISOString();
    this.scheduleEmit();
  }

  private update(id: string, patch: Partial<DownloadTask>): void {
    const task = this.active.find((item) => item.id === id);
    if (task) {
      Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    }
  }

  private takeActive(id: string): DownloadTask | undefined {
    const index = this.active.findIndex((task) => task.id === id);
    return index >= 0 ? this.active.splice(index, 1)[0] : undefined;
  }

  private finish(task: DownloadTask, status: DownloadTaskStatus): void {
    const now = new Date().toISOString();
    this.history = [
      { ...task, status, bytesPerSecond: undefined, updatedAt: now, completedAt: now },
      ...this.history.filter((item) => item.id !== task.id)
    ].slice(0, MAX_HISTORY_ITEMS);
    this.persist();
    this.emitNow();
  }

  private persist(): void {
    // `active` is always written empty: in-flight work can't survive a restart.
    writeJsonFileAtomic(this.filePath, { active: [], history: this.history });
  }

  private scheduleEmit(): void {
    if (this.emitTimer) {
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitNow();
    }, EMIT_INTERVAL_MS);
  }

  private emitNow(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    const state = this.state();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function summaryOf(video: VideoSummary & { formats?: unknown; embedUrl?: unknown }): VideoSummary {
  const { formats: _formats, embedUrl: _embedUrl, ...summary } = video;
  return summary;
}

function loadHistory(filePath: string): DownloadTask[] {
  const raw = readJsonFile(filePath);
  const history = isRecord(raw) && Array.isArray(raw.history) ? raw.history : [];
  return history
    .filter((task): task is DownloadTask => isRecord(task) && typeof task.id === "string" && typeof task.videoId === "string")
    .map((task) =>
      task.status === "queued" || task.status === "downloading"
        ? { ...task, status: "canceled" as const, bytesPerSecond: undefined }
        : task
    )
    .slice(0, MAX_HISTORY_ITEMS);
}

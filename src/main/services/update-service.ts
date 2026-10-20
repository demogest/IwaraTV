// Checks GitHub Releases for a newer IwaraTV, downloads and verifies the file
// for this install type, and hands it to the platform installer. Kept free of
// Electron imports; see docs/auto-update.md for the design.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AppErrorCode } from "../../shared/errors";
import type { UpdateInfo, UpdateInstallKind, UpdateSettings, UpdateState, UpdateStrategy } from "../../shared/types";
import { AppError, errorMessage, serializeError } from "../lib/app-error";
import { discardBody, type HttpFetch } from "../lib/http";
import { isMajorUpgrade, isNewerVersion } from "../lib/semver";
import {
  MAX_MANIFEST_BYTES,
  parseManifest,
  SIGNATURE_NAME,
  verifyManifestSignature,
  type UpdateAsset,
  type UpdateAssetKey,
  type UpdateManifest,
  type UpdateSource
} from "../lib/update-manifest";

const CHECK_TIMEOUT_MS = 20_000;
const STALL_TIMEOUT_MS = 60_000;
const PROGRESS_EMIT_MS = 250;
export const FIRST_CHECK_DELAY_MS = 20_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateEnvironment {
  currentVersion: string;
  installKind: UpdateInstallKind;
  /** The release file this install updates from; undefined when the release job builds none for it. */
  assetKey?: UpdateAssetKey;
  /** How a downloaded file is applied on this install. */
  strategy: UpdateStrategy;
  downloadDirectory: string;
  /** True when the directory belongs to the updater, so stale update files in it may be deleted. */
  ownsDownloadDirectory: boolean;
  source: UpdateSource;
  /** Pinned Ed25519 public key (PEM). When set, unsigned manifests are rejected. */
  publicKey?: string;
}

export interface UpdateServiceOptions {
  environment: UpdateEnvironment;
  /** A cookie-less fetch for github.com. */
  fetch: HttpFetch;
  settings: { get(): UpdateSettings; update(patch: Partial<UpdateSettings>): void };
  /** Applies a verified file: runs the installer and restarts, or opens the file for the user. */
  install(filePath: string): Promise<void>;
  emit(state: UpdateState): void;
  now?: () => Date;
}

export class UpdateService {
  private readonly env: UpdateEnvironment;
  private readonly options: UpdateServiceOptions;
  private state: UpdateState;
  private manifest?: UpdateManifest;
  private asset?: UpdateAsset;
  private downloadedPath?: string;
  private checking?: Promise<UpdateState>;
  private downloading?: Promise<UpdateState>;
  private readonly abort = new AbortController();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private lastProgressEmit = 0;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.env = options.environment;
    this.state = {
      status: "idle",
      currentVersion: this.env.currentVersion,
      installKind: this.env.installKind,
      strategy: this.env.assetKey ? this.env.strategy : "none",
      signedOnly: Boolean(this.env.publicKey),
      checkedAt: options.settings.get().lastCheckedAt
    };
  }

  getState(): UpdateState {
    return structuredClone(this.state);
  }

  /** Checks 20 s after start, then every 6 hours, while automatic checks are on. */
  start(firstDelayMs = FIRST_CHECK_DELAY_MS, intervalMs = CHECK_INTERVAL_MS): void {
    const tick = () => {
      if (this.options.settings.get().autoCheck) {
        void this.check({ background: true });
      }
    };
    const first = setTimeout(() => {
      tick();
      const interval = setInterval(tick, intervalMs);
      interval.unref?.();
      this.timers.push(interval);
    }, firstDelayMs);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
    this.abort.abort();
  }

  check(options: { background?: boolean } = {}): Promise<UpdateState> {
    // A download in progress or ready to install isn't interrupted by another check.
    if (this.state.status === "downloading" || this.state.status === "ready") {
      return Promise.resolve(this.getState());
    }
    this.checking ??= this.runCheck(Boolean(options.background)).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  download(): Promise<UpdateState> {
    if (this.downloading) {
      return this.downloading;
    }
    if (this.state.status === "ready") {
      return Promise.resolve(this.getState());
    }
    const { manifest, asset } = this;
    if (!manifest || !asset || this.state.strategy === "none") {
      return Promise.reject(new AppError("UPDATE_INVALID", "There is no update file to download for this copy of IwaraTV."));
    }
    this.downloading = this.runDownload(manifest, asset).finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  async install(): Promise<UpdateState> {
    const { asset, downloadedPath } = this;
    if (this.state.status !== "ready" || !asset || !downloadedPath) {
      throw new AppError("UPDATE_INVALID", "No downloaded update is ready to install.");
    }
    // The file has been sitting on disk since the download: check it again right before use.
    if (!(await this.verifiedFile(asset))) {
      this.downloadedPath = undefined;
      this.setState({ status: "available" });
      throw new AppError("UPDATE_INVALID", "The downloaded update changed on disk. Download it again.");
    }
    try {
      await this.options.install(downloadedPath);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError("UPDATE_INSTALL_FAILED", errorMessage(error));
    }
    return this.getState();
  }

  skip(version: string): UpdateState {
    this.options.settings.update({ skippedVersion: version });
    if (this.state.update) {
      this.setState({ update: { ...this.state.update, skipped: this.state.update.version === version } });
    }
    return this.getState();
  }

  // --- Checking ------------------------------------------------------------------

  private async runCheck(background: boolean): Promise<UpdateState> {
    const previous = this.getState();
    // Background checks don't hide an update that's already on screen while they run.
    if (!background || !previous.update) {
      this.setState({ status: "checking", error: undefined });
    }
    try {
      const manifest = await this.fetchManifest();
      const checkedAt = (this.options.now?.() ?? new Date()).toISOString();
      this.options.settings.update({ lastCheckedAt: checkedAt });

      if (!manifest || !isNewerVersion(manifest.version, this.env.currentVersion)) {
        this.manifest = undefined;
        this.asset = undefined;
        await this.prune();
        return this.setState({ status: "up-to-date", update: undefined, checkedAt, strategy: this.baseStrategy() });
      }

      this.manifest = manifest;
      this.asset = this.env.assetKey ? manifest.assets[this.env.assetKey] : undefined;
      const update = this.infoFor(manifest, this.asset);
      const strategy = this.asset ? this.env.strategy : "none";
      // A file finished in an earlier session (or fetched by hand) needs no second download.
      const existing = this.asset ? await this.verifiedFile(this.asset) : undefined;
      if (existing) {
        this.downloadedPath = existing;
        return this.setState({ status: "ready", update, checkedAt, strategy });
      }
      this.setState({ status: "available", update, checkedAt, strategy });
      if (this.shouldDownloadAutomatically(update)) {
        void this.download().catch(() => undefined);
      }
      return this.getState();
    } catch (error) {
      // A failed background check keeps what the last check found; only Check now reports errors.
      if (background && previous.status !== "idle" && previous.status !== "error") {
        return this.setState({ ...previous });
      }
      return this.setState({ status: "error", update: undefined, error: errorState(error) });
    }
  }

  private async fetchManifest(): Promise<UpdateManifest | undefined> {
    const { source, publicKey } = this.env;
    const response = await this.options.fetch(source.manifestUrl, { signal: this.signal(CHECK_TIMEOUT_MS) });
    if (response.status === 404) {
      // Releases from before the updater (2.0.0 and older) have no manifest.
      await discardBody(response);
      return undefined;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new AppError("UPDATE_CHECK_FAILED", `GitHub answered with HTTP ${response.status}.`, { status: response.status });
    }
    const bytes = await readLimited(response, MAX_MANIFEST_BYTES);
    const manifest = parseManifest(new TextDecoder().decode(bytes));

    if (publicKey) {
      const signatureResponse = await this.options.fetch(source.fileUrl(manifest.tag, SIGNATURE_NAME), {
        signal: this.signal(CHECK_TIMEOUT_MS)
      });
      if (!signatureResponse.ok) {
        await discardBody(signatureResponse);
        throw new AppError("UPDATE_INVALID", "The update information isn't signed.");
      }
      const signature = new TextDecoder().decode(await readLimited(signatureResponse, 1024));
      if (!verifyManifestSignature(bytes, signature, publicKey)) {
        throw new AppError("UPDATE_INVALID", "The update information's signature isn't valid.");
      }
    }
    return manifest;
  }

  private infoFor(manifest: UpdateManifest, asset: UpdateAsset | undefined): UpdateInfo {
    return {
      version: manifest.version,
      tag: manifest.tag,
      publishedAt: manifest.publishedAt,
      notes: manifest.notes,
      breaking: manifest.breaking || isMajorUpgrade(manifest.version, this.env.currentVersion),
      skipped: this.options.settings.get().skippedVersion === manifest.version,
      fileName: asset?.name,
      size: asset?.size,
      releaseUrl: this.env.source.releaseUrl(manifest.tag)
    };
  }

  private shouldDownloadAutomatically(update: UpdateInfo): boolean {
    return this.env.strategy === "automatic"
      && Boolean(update.fileName)
      && !update.breaking
      && !update.skipped
      && this.options.settings.get().autoDownload;
  }

  private baseStrategy(): UpdateStrategy {
    return this.env.assetKey ? this.env.strategy : "none";
  }

  // --- Downloading ---------------------------------------------------------------

  private async runDownload(manifest: UpdateManifest, asset: UpdateAsset): Promise<UpdateState> {
    this.setState({ status: "downloading", progress: { received: 0, total: asset.size }, error: undefined });
    try {
      await mkdir(this.env.downloadDirectory, { recursive: true });
      await this.prune(asset.name);
      const target = path.join(this.env.downloadDirectory, asset.name);
      await downloadUpdateFile({
        fetch: this.options.fetch,
        url: this.env.source.fileUrl(manifest.tag, asset.name),
        target,
        asset,
        signal: this.abort.signal,
        onProgress: (received) => this.setState({ progress: { received, total: asset.size } }, { throttle: true })
      });
      this.downloadedPath = target;
      return this.setState({ status: "ready", progress: undefined });
    } catch (error) {
      return this.setState({ status: "error", progress: undefined, error: errorState(error) });
    }
  }

  /** The finished file for `asset` when it is already on disk and intact. */
  private async verifiedFile(asset: UpdateAsset): Promise<string | undefined> {
    const filePath = path.join(this.env.downloadDirectory, asset.name);
    try {
      const info = await stat(filePath);
      if (info.isFile() && info.size === asset.size && (await sha256File(filePath)) === asset.sha256) {
        return filePath;
      }
    } catch {
      return undefined;
    }
    if (this.env.ownsDownloadDirectory) {
      await rm(filePath, { force: true });
    }
    return undefined;
  }

  /** Removes older update files from the updater's own folder; never touches folders it doesn't own. */
  private async prune(keep?: string): Promise<void> {
    if (!this.env.ownsDownloadDirectory) {
      return;
    }
    const entries = await readdir(this.env.downloadDirectory).catch(() => [] as string[]);
    await Promise.all(entries
      .filter((name) => name.startsWith("IwaraTV_") && name !== keep)
      .map((name) => rm(path.join(this.env.downloadDirectory, name), { force: true }).catch(() => undefined)));
  }

  // --- State ---------------------------------------------------------------------

  private setState(patch: Partial<UpdateState>, options: { throttle?: boolean } = {}): UpdateState {
    this.state = { ...this.state, ...patch };
    for (const key of Object.keys(this.state) as Array<keyof UpdateState>) {
      if (this.state[key] === undefined) {
        delete this.state[key];
      }
    }
    const now = Date.now();
    if (!options.throttle || now - this.lastProgressEmit >= PROGRESS_EMIT_MS) {
      this.lastProgressEmit = now;
      this.options.emit(this.getState());
    }
    return this.getState();
  }

  private signal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
  }
}

function errorState(error: unknown): { code: AppErrorCode; message: string } {
  const { code, message } = serializeError(error);
  return { code, message };
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new AppError("UPDATE_INVALID", "The update information is too large.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await discardBody(response);
        throw new AppError("UPDATE_INVALID", "The update information is too large.");
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, total);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export interface DownloadUpdateOptions {
  fetch: HttpFetch;
  url: string;
  target: string;
  asset: UpdateAsset;
  onProgress(received: number): void;
  signal?: AbortSignal;
}

/**
 * Streams `url` into `<target>.partial`, enforcing the manifest's size while
 * it arrives, and renames it to `target` only when size and SHA-256 match.
 */
export async function downloadUpdateFile(options: DownloadUpdateOptions): Promise<void> {
  const { asset, target } = options;
  const partial = `${target}.partial`;
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new AppError("NETWORK_ERROR", "The update download stalled.")), STALL_TIMEOUT_MS);
  };
  const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
  let handle: FileHandle | undefined;
  arm();
  try {
    const response = await options.fetch(options.url, { signal });
    if (!response.ok || !response.body) {
      await discardBody(response);
      throw new AppError("UPDATE_CHECK_FAILED", `Downloading the update failed (HTTP ${response.status}).`, { status: response.status });
    }
    handle = await open(partial, "w");
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > asset.size) {
        await discardBody(response);
        throw new AppError("UPDATE_INVALID", "The update file is larger than expected.");
      }
      hash.update(chunk);
      await handle.write(chunk);
      arm();
      options.onProgress(received);
    }
    await handle.close();
    handle = undefined;
    if (received !== asset.size || hash.digest("hex") !== asset.sha256) {
      throw new AppError("UPDATE_INVALID", "The downloaded update doesn't match its checksum.");
    }
    await rename(partial, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
    throw stall.signal.aborted ? stall.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

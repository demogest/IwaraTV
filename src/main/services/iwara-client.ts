import {
  buildXVersion,
  formatToExtension,
  normalizeMediaUrl,
  parseIwaraVideoId,
  qualityRank
} from "../../shared/iwara-utils";
import { buildMediaHostCandidates, mediaUrlHost, replaceMediaUrlHost } from "../../shared/media-speed-utils";
import type {
  AuthState,
  MediaSpeedCandidateResult,
  MediaSpeedSettings,
  MediaSpeedTestReport,
  ListVideosRequest,
  LoginRequest,
  RatingFilter,
  IwaraNetworkCapture,
  IwaraVideoDiagnostics,
  IwaraFileProbe,
  VideoDetail,
  VideoFormat,
  VideoListResult,
  VideoSort,
  VideoSummary
} from "../../shared/types";
import { AuthStore } from "./auth-store";

const API_BASE = "https://api.iwara.tv";
const FILES_BASE = "https://files.iwara.tv";
const DEFAULT_LIMIT = 32;

export class IwaraApiError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "cloudflare" | "not-found" | "private" | "unplayable" | "api"
  ) {
    super(message);
  }
}

export class IwaraClient {
  private readonly formatCache = new Map<string, { formats: VideoFormat[]; capturedAt: number }>();

  constructor(
    private readonly authStore: AuthStore,
    private readonly browserHeaders: (url: string) => Promise<Record<string, string>> = async () => ({}),
    private readonly browserToken: () => Promise<string | undefined> = async () => undefined
  ) {}

  authState(): AuthState {
    return this.authStore.state();
  }

  async login(request: LoginRequest): Promise<AuthState> {
    const response = await this.requestJson<{ token?: string; message?: string }>(`${API_BASE}/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: request.email, password: request.password })
    });

    if (!response.token) {
      throw new IwaraApiError(`Iwara 登录失败：${response.message ?? "未返回 token"}`, "auth");
    }

    this.authStore.saveUserToken(request.email, response.token);
    await this.refreshMediaToken(response.token);
    return this.authStore.state();
  }

  logout(): AuthState {
    this.authStore.clear();
    return this.authStore.state();
  }

  async listVideos(request: ListVideosRequest): Promise<VideoListResult> {
    const sort = request.sort;
    const page = request.page ?? 0;
    const rating = request.rating ?? "all";
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set("sort", sort);
    url.searchParams.set("rating", rating);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(DEFAULT_LIMIT));
    url.searchParams.set("subscribed", "false");

    const data = await this.requestJson<{
      count?: number;
      total?: number;
      results?: unknown[];
    }>(url.toString(), {
      headers: await this.mediaHeaders()
    });

    return {
      sort,
      page,
      limit: DEFAULT_LIMIT,
      total: data.total ?? data.count,
      results: (data.results ?? []).map((item) => this.mapVideoSummary(item))
    };
  }

  async getVideo(idOrUrl: string): Promise<VideoDetail> {
    const id = parseIwaraVideoId(idOrUrl);
    const data = await this.requestJson<Record<string, unknown>>(`${API_BASE}/video/${id}`, {
      headers: await this.mediaHeaders()
    });

    const message = typeof data.message === "string" ? data.message : undefined;
    if (message === "errors.privateVideo") {
      throw new IwaraApiError("这是私有视频，需要登录且账号有访问权限。", "private");
    }

    if (message === "errors.notFound") {
      throw new IwaraApiError("视频不存在，或需要登录后才能访问。", "not-found");
    }

    if (message) {
      throw new IwaraApiError(`Iwara API 返回错误：${message}`, "api");
    }

    const summary = this.mapVideoSummary(data);
    const fileUrl = typeof data.fileUrl === "string" ? data.fileUrl : undefined;
    const embedUrl = typeof data.embedUrl === "string" ? data.embedUrl : undefined;

    if (!fileUrl) {
      if (embedUrl) {
        return { ...summary, embedUrl, formats: [] };
      }
      throw new IwaraApiError("这个视频当前没有可播放的文件。", "unplayable");
    }

    const directFormats = await this.extractFormats(id, fileUrl);
    return {
      ...summary,
      embedUrl,
      formats: this.preferCachedFormats(id, directFormats)
    };
  }

  async diagnoseVideo(
    idOrUrl: string,
    captureNetwork?: () => Promise<IwaraNetworkCapture>
  ): Promise<IwaraVideoDiagnostics> {
    const id = parseIwaraVideoId(idOrUrl);
    const videoHeaders = await this.mediaHeaders();
    const data = await this.requestJson<Record<string, unknown>>(`${API_BASE}/video/${id}`, {
      headers: videoHeaders
    });
    const fileUrl = typeof data.fileUrl === "string" ? data.fileUrl : undefined;
    const title = stringOrUndefined(data.title);
    const probes: IwaraFileProbe[] = [];
    let appFormatLabels: string[] = [];

    if (fileUrl) {
      const xVersion = buildXVersion(fileUrl);
      const sessionProbe = await this.probeFileList("网页会话 headers", fileUrl, {
        "X-Version": xVersion,
        Accept: "application/json"
      });
      probes.push(sessionProbe);

      const mediaProbe = await this.probeFileList("media token headers", fileUrl, {
        ...videoHeaders,
        "X-Version": xVersion,
        Accept: "application/json"
      });
      probes.push(mediaProbe);

      appFormatLabels = mediaProbe.ok && mediaProbe.formatLabels.length
        ? mediaProbe.formatLabels
        : sessionProbe.formatLabels;
    }

    const network = captureNetwork ? await captureNetwork() : undefined;
    const networkFormats = bestNetworkFormats(network);
    if (networkFormats.length) {
      this.formatCache.set(id, { formats: networkFormats, capturedAt: Date.now() });
      appFormatLabels = labelsFor(networkFormats);
    }

    return {
      videoId: id,
      title,
      fileUrl: fileUrl ? safeUrl(fileUrl) : undefined,
      appFormatLabels,
      probes,
      network
    };
  }

  async speedTestVideo(idOrUrl: string, speedSettings: MediaSpeedSettings): Promise<MediaSpeedTestReport> {
    const video = await this.getVideo(idOrUrl);
    return this.speedTestHosts(video, speedSettings);
  }

  routeVideoFormats(video: VideoDetail, speedSettings: MediaSpeedSettings): VideoDetail {
    if (!speedSettings.replaceLinks || !speedSettings.rankedHosts.length) {
      return video;
    }

    return {
      ...video,
      formats: routeFormatsByHostRank(video.formats, speedSettings.rankedHosts)
    };
  }

  private async extractFormats(videoId: string, fileUrl: string): Promise<VideoFormat[]> {
    const xVersion = buildXVersion(fileUrl);
    const mediaHeaders = await this.mediaHeaders();
    const files = await this.requestJson<unknown>(fileUrl, {
      headers: {
        ...mediaHeaders,
        "X-Version": xVersion,
        Accept: "application/json"
      },
      contextId: videoId
    });

    return normalizeFileList(files)
      .map((item) => this.mapVideoFormat(item))
      .filter((format): format is VideoFormat => Boolean(format?.url))
      .sort((a, b) => a.qualityRank - b.qualityRank);
  }

  private async speedTestHosts(video: VideoDetail, speedSettings: MediaSpeedSettings): Promise<MediaSpeedTestReport> {
    const sample = video.formats.slice().sort((a, b) => b.qualityRank - a.qualityRank)[0];
    const sampleHost = sample ? mediaUrlHost(sample.url) : undefined;
    const discoveredHosts = video.formats
      .map((format) => mediaUrlHost(format.url))
      .filter((host): host is string => Boolean(host));
    const candidateHosts = [...new Set([...discoveredHosts, ...speedSettings.candidateHosts])];
    const candidates = sample ? buildMediaHostCandidates(sample.url, candidateHosts) : [];
    const results = await Promise.all(candidates.map((candidate) => this.testMediaUrl(candidate, speedSettings)));
    const fastest = results
      .filter((candidate) => candidate.ok && candidate.bytesPerSecond)
      .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))[0];

    return {
      videoId: video.id,
      title: video.title,
      sampleFormatId: sample?.id,
      sampleFormatLabel: sample?.label,
      sampleHost,
      testedAt: new Date().toISOString(),
      replaceLinks: speedSettings.replaceLinks,
      fastestHost: fastest?.host,
      results
    };
  }

  private async testMediaUrl(
    candidate: { host: string; url: string },
    speedSettings: MediaSpeedSettings
  ): Promise<MediaSpeedCandidateResult> {
    const controller = new AbortController();
    const started = performance.now();
    const timeout = setTimeout(() => controller.abort(), speedSettings.timeoutMs);

    try {
      const response = await fetch(candidate.url, {
        headers: {
          ...(await this.browserHeaders(candidate.url)),
          Referer: "https://www.iwara.tv/",
          Range: `bytes=0-${Math.max(speedSettings.testBytes - 1, 0)}`
        },
        signal: controller.signal
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }

      const bytesRead = await readResponseBytes(response, speedSettings.testBytes);
      const elapsedMs = Math.max(performance.now() - started, 1);
      if (bytesRead <= 0) {
        throw new Error("没有读取到数据");
      }

      return {
        host: candidate.host,
        url: candidate.url,
        ok: true,
        elapsedMs,
        bytesRead,
        bytesPerSecond: Math.round((bytesRead / elapsedMs) * 1000)
      };
    } catch (err) {
      return {
        host: candidate.host,
        url: candidate.url,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private preferCachedFormats(videoId: string, directFormats: VideoFormat[]): VideoFormat[] {
    const cached = this.formatCache.get(videoId);
    if (!cached || Date.now() - cached.capturedAt > 15 * 60 * 1000) {
      this.formatCache.delete(videoId);
      return directFormats;
    }

    const directBest = bestQualityRank(directFormats);
    const cachedBest = bestQualityRank(cached.formats);
    if (cachedBest > directBest || cached.formats.length > directFormats.length) {
      return cached.formats;
    }

    return directFormats;
  }

  private async probeFileList(
    label: string,
    fileUrl: string,
    headers: Record<string, string>
  ): Promise<IwaraFileProbe> {
    try {
      const { status, json } = await this.requestJsonWithStatus<unknown>(fileUrl, { headers });
      const formatLabels = normalizeFileList(json)
        .map((item) => this.mapVideoFormat(item)?.label)
        .filter((value): value is string => Boolean(value));

      return {
        label,
        url: safeUrl(fileUrl),
        ok: true,
        status,
        formatLabels
      };
    } catch (err) {
      return {
        label,
        url: safeUrl(fileUrl),
        ok: false,
        formatLabels: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private mapVideoSummary(raw: unknown): VideoSummary {
    const value = raw as Record<string, unknown>;
    const user = (value.user ?? {}) as Record<string, unknown>;
    const file = (value.file ?? {}) as Record<string, unknown>;

    return {
      id: String(value.id ?? ""),
      title: String(value.title ?? "Untitled"),
      description: typeof value.body === "string" ? value.body : undefined,
      uploaderName: stringOrUndefined(user.name),
      uploaderUsername: stringOrUndefined(user.username),
      thumbnailUrl: this.thumbnailUrl(file),
      rating: stringOrUndefined(value.rating),
      tags: Array.isArray(value.tags)
        ? value.tags.map((tag) => (typeof tag === "string" ? tag : String((tag as Record<string, unknown>).id ?? ""))).filter(Boolean)
        : [],
      numViews: numberOrZero(value.numViews),
      numLikes: numberOrZero(value.numLikes),
      numComments: numberOrZero(value.numComments),
      createdAt: stringOrUndefined(value.createdAt),
      updatedAt: stringOrUndefined(value.updatedAt)
    };
  }

  private mapVideoFormat(raw: unknown): VideoFormat | undefined {
    const value = raw as Record<string, unknown>;
    const label = String(value.name ?? value.label ?? value.quality ?? value.height ?? "unknown");
    const url = this.formatUrl(value);

    if (!url) {
      return undefined;
    }

    const mimeType = stringOrUndefined(value.type);
    return {
      id: label,
      label,
      url: normalizeMediaUrl(url),
      mimeType,
      ext: formatToExtension(mimeType),
      height: Number.isFinite(Number.parseInt(label, 10)) ? Number.parseInt(label, 10) : undefined,
      qualityRank: qualityRank(label)
    };
  }

  private formatUrl(value: Record<string, unknown>): string | undefined {
    const src = value.src;
    if (typeof src === "string") {
      return src;
    }

    if (src && typeof src === "object") {
      const srcRecord = src as Record<string, unknown>;
      return stringOrUndefined(srcRecord.view)
        ?? stringOrUndefined(srcRecord.download)
        ?? stringOrUndefined(srcRecord.src)
        ?? stringOrUndefined(srcRecord.url);
    }

    return stringOrUndefined(value.view)
      ?? stringOrUndefined(value.download)
      ?? stringOrUndefined(value.url);
  }

  private thumbnailUrl(file: Record<string, unknown>): string | undefined {
    const fileId = stringOrUndefined(file.id);
    return fileId ? `${FILES_BASE}/image/thumbnail/${fileId}/thumbnail-00.jpg` : undefined;
  }

  private async mediaHeaders(): Promise<Record<string, string>> {
    const sessionToken = await this.browserToken();
    const userToken = this.authStore.getUserToken() ?? sessionToken;
    if (!userToken) {
      return {};
    }

    const mediaToken = this.authStore.getMediaToken();
    if (mediaToken && !isJwtExpired(mediaToken, 120)) {
      return { Authorization: `Bearer ${mediaToken}` };
    }

    try {
      const refreshed = await this.refreshMediaToken(userToken);
      return { Authorization: `Bearer ${refreshed}` };
    } catch (err) {
      if (sessionToken) {
        return { Authorization: `Bearer ${sessionToken}` };
      }
      throw err;
    }
  }

  private async refreshMediaToken(userToken: string): Promise<string> {
    if (isJwtExpired(userToken, 120)) {
      this.authStore.clear();
      throw new IwaraApiError("登录已过期，请重新登录。", "auth");
    }

    const response = await this.requestJson<{ accessToken?: string }>(`${API_BASE}/user/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json"
      },
      body: ""
    });

    if (!response.accessToken) {
      throw new IwaraApiError("无法获取 Iwara 媒体访问 token。", "auth");
    }

    this.authStore.setMediaToken(response.accessToken);
    return response.accessToken;
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit & { contextId?: string } = {}
  ): Promise<T> {
    return (await this.requestJsonWithStatus<T>(url, init)).json;
  }

  private async requestJsonWithStatus<T>(
    url: string,
    init: RequestInit & { contextId?: string } = {}
  ): Promise<{ status: number; json: T }> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Referer: "https://www.iwara.tv/",
        Origin: "https://www.iwara.tv",
        ...(await this.browserHeaders(url)),
        ...init.headers
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (!contentType.includes("application/json")) {
      if (text.toLowerCase().includes("<html") || text.toLowerCase().includes("cloudflare")) {
        throw new IwaraApiError("Iwara 返回了浏览器验证页面，请先在站点完成验证或稍后重试。", "cloudflare");
      }

      throw new IwaraApiError(`Iwara 返回了非 JSON 内容：HTTP ${response.status}`, "api");
    }

    const json = text ? (JSON.parse(text) as T) : ({} as T);
    if (!response.ok) {
      throw new IwaraApiError(`Iwara API 请求失败：HTTP ${response.status}`, "api");
    }

    return { status: response.status, json };
  }
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function normalizeFileList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.files)) {
      return record.files;
    }
    if (Array.isArray(record.results)) {
      return record.results;
    }
    if (Array.isArray(record.data)) {
      return record.data;
    }
  }

  return [];
}

function bestNetworkFormats(network: IwaraNetworkCapture | undefined): VideoFormat[] {
  const formatSets = network?.entries
    .map((entry) => entry.formats ?? [])
    .filter((formats) => formats.length) ?? [];

  return formatSets.sort((a, b) => bestQualityRank(b) - bestQualityRank(a))[0] ?? [];
}

function bestQualityRank(formats: VideoFormat[]): number {
  return formats.reduce((best, format) => Math.max(best, format.qualityRank), 0);
}

function labelsFor(formats: VideoFormat[]): string[] {
  return formats
    .slice()
    .sort((a, b) => b.qualityRank - a.qualityRank)
    .map((format) => format.label);
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    return Math.min(bytes.byteLength, maxBytes);
  }

  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      bytesRead += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return bytesRead;
}

function routeFormatsByHostRank(formats: VideoFormat[], rankedHosts: string[]): VideoFormat[] {
  return formats.map((format) => {
    const currentHost = mediaUrlHost(format.url);
    const targetHost = rankedHosts.find((host) => host !== currentHost);
    const routedUrl = targetHost ? replaceMediaUrlHost(format.url, targetHost) : undefined;

    if (!routedUrl) {
      return format;
    }

    return {
      ...format,
      url: routedUrl
    };
  });
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = parsed.search ? "?..." : "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isJwtExpired(token: string, skewSeconds: number): boolean {
  try {
    const [, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" && decoded.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
  } catch {
    return false;
  }
}

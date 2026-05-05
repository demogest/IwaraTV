import {
  buildXVersion,
  formatToExtension,
  normalizeMediaUrl,
  parseIwaraVideoId,
  qualityRank
} from "../../shared/iwara-utils";
import type {
  AuthState,
  ListVideosRequest,
  LoginRequest,
  RatingFilter,
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
  constructor(
    private readonly authStore: AuthStore,
    private readonly browserHeaders: (url: string) => Promise<Record<string, string>> = async () => ({})
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

    return {
      ...summary,
      embedUrl,
      formats: await this.extractFormats(id, fileUrl)
    };
  }

  private async extractFormats(videoId: string, fileUrl: string): Promise<VideoFormat[]> {
    const xVersion = buildXVersion(fileUrl);
    const files = await this.requestJson<unknown[]>(fileUrl, {
      headers: {
        "X-Version": xVersion,
        Accept: "application/json"
      },
      contextId: videoId
    });

    return files
      .map((item) => this.mapVideoFormat(item))
      .filter((format): format is VideoFormat => Boolean(format?.url))
      .sort((a, b) => a.qualityRank - b.qualityRank);
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
    const src = (value.src ?? {}) as Record<string, unknown>;
    const label = String(value.name ?? "unknown");
    const url = stringOrUndefined(src.view) ?? stringOrUndefined(src.download);

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

  private thumbnailUrl(file: Record<string, unknown>): string | undefined {
    const fileId = stringOrUndefined(file.id);
    return fileId ? `${FILES_BASE}/image/thumbnail/${fileId}/thumbnail-00.jpg` : undefined;
  }

  private async mediaHeaders(): Promise<Record<string, string>> {
    const userToken = this.authStore.getUserToken();
    if (!userToken) {
      return {};
    }

    const mediaToken = this.authStore.getMediaToken();
    if (mediaToken && !isJwtExpired(mediaToken, 120)) {
      return { Authorization: `Bearer ${mediaToken}` };
    }

    const refreshed = await this.refreshMediaToken(userToken);
    return { Authorization: `Bearer ${refreshed}` };
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

    return json;
  }
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
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

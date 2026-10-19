import path from "node:path";
import { mkdir } from "node:fs/promises";
import { buildMediaHostCandidates, isIwaraUrl, mediaUrlHost, replaceMediaUrlHost } from "../../shared/media-hosts";
import { normalizeTagList } from "../../shared/tags";
import type {
  AuthorFollowRequest,
  AuthorFollowResult,
  DownloadSettings,
  DownloadVideoRequest,
  IwaraFileProbe,
  IwaraNetworkCapture,
  IwaraVideoDiagnostics,
  ListCommentsRequest,
  ListVideosRequest,
  MediaSpeedCandidateResult,
  MediaSpeedSettings,
  MediaSpeedTestReport,
  RatingFilter,
  SendVideoCommentRequest,
  TagPreferences,
  VideoComment,
  VideoCommentsResult,
  VideoDetail,
  VideoFormat,
  VideoListNetworkAttempt,
  VideoListResult,
  VideoSort,
  VideoSummary,
  XVersionSaltReport
} from "../../shared/types";
import type { AppErrorCode } from "../../shared/errors";
import { parseIwaraVideoId } from "../../shared/video-id";
import { AppError, errorMessage, httpStatusOf, isAbortError, isAppError } from "../lib/app-error";
import { uniqueDownloadPath } from "../lib/download-files";
import { delay, discardBody, headerValue, mergeHeaders, withTimeout, type HttpFetch } from "../lib/http";
import {
  bestFormat,
  bestQualityRank,
  chooseVideoFormat,
  extractAuthProfile,
  field,
  formatsFromJson,
  looksLikeCloudflare,
  mapVideoComment,
  mapVideoSummary,
  safeUrl,
  valueToString,
  type AuthProfile
} from "../lib/iwara-parse";
import { isJwtExpired } from "../lib/jwt";
import { buildXVersion, extractXVersionSaltFromScript, scriptUrlsFromHtml } from "../lib/x-version";

export const API_BASE = "https://api.iwara.tv";
const APIQ_BASE = "https://apiq.iwara.tv";
const WEB_BASE = "https://www.iwara.tv";
const DEFAULT_LIMIT = 32;
const SUBSCRIBED_LIMIT = 24;
const COMMENT_LIMIT = 20;
const LIST_RETRY_ATTEMPTS = 3;
const LIST_RETRY_BASE_DELAY_MS = 450;
const TOKEN_SKEW_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 30_000;
const FORMAT_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_FOLLOWED_TAGS = 8;

export interface PageFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** What the client needs from the Electron web session. */
export interface IwaraSessionBridge {
  /** The www.iwara.tv web-session JWT, when the user is signed in. */
  token(): Promise<string | undefined>;
  /** Re-runs an API request inside a www.iwara.tv page (Cloudflare fallback). */
  pageFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<PageFetchResult>;
}

export interface IwaraClientOptions {
  fetch: HttpFetch;
  session: IwaraSessionBridge;
  /** Current X-Version salt from settings. */
  salt: () => string;
}

export interface DownloadPlan {
  path: string;
  format: VideoFormat;
  video: VideoDetail;
  fallbackFrom?: string;
}

interface JsonResponse {
  status: number;
  data: unknown;
}

interface ListPageFetch {
  total?: number;
  limit: number;
  rawCount: number;
  results: VideoSummary[];
  attempts: VideoListNetworkAttempt[];
}

class ListPageFetchFailure extends Error {
  constructor(message: string, readonly code: AppErrorCode, readonly attempts: VideoListNetworkAttempt[]) {
    super(message);
  }
}

interface ListFilter {
  required: Set<string>;
  blocked: Set<string>;
}

export class IwaraClient {
  private readonly fetch: HttpFetch;
  private readonly session: IwaraSessionBridge;
  private readonly salt: () => string;
  private mediaToken?: { value: string; userToken: string };
  private profile?: { token: string; profile: AuthProfile };
  private listQueue: Promise<unknown> = Promise.resolve();
  private readonly formatCache = new Map<string, { formats: VideoFormat[]; capturedAt: number }>();

  constructor(options: IwaraClientOptions) {
    this.fetch = options.fetch;
    this.session = options.session;
    this.salt = options.salt;
  }

  /** Forgets cached tokens and profile data (sign-out). */
  clearCredentials(): void {
    this.mediaToken = undefined;
    this.profile = undefined;
  }

  // ---------------------------------------------------------------------------
  // Account

  async currentUserProfile(): Promise<AuthProfile> {
    const token = await this.session.token();
    if (!token) {
      return {};
    }
    if (this.profile?.token === token) {
      return this.profile.profile;
    }
    const { data } = await this.requestJson(`${API_BASE}/user`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    const profile = extractAuthProfile(data, token);
    this.profile = { token, profile };
    return profile;
  }

  async setAuthorFollowing(request: AuthorFollowRequest): Promise<AuthorFollowResult> {
    const authorId = request.authorId.trim();
    if (!authorId) {
      throw new AppError("INVALID_INPUT", "Missing author ID.");
    }
    await this.requestJson(`${APIQ_BASE}/user/${encodeURIComponent(authorId)}/followers`, {
      method: request.following ? "POST" : "DELETE",
      headers: await this.authenticatedApiHeaders()
    });
    return { authorId, following: request.following };
  }

  // ---------------------------------------------------------------------------
  // Lists

  /** List requests are serialized: Iwara rate-limits bursts of feed requests. */
  listVideos(request: ListVideosRequest, tagPreferences: TagPreferences): Promise<VideoListResult> {
    const run = this.listQueue.then(() => this.listVideosNow(request, tagPreferences));
    this.listQueue = run.catch(() => undefined);
    return run;
  }

  private async listVideosNow(request: ListVideosRequest, preferences: TagPreferences): Promise<VideoListResult> {
    if (request.searchOnly) {
      return this.searchVideos(request, preferences);
    }
    if (request.subscribedOnly) {
      return this.listSubscribedVideos(request, preferences);
    }
    if (request.followedOnly) {
      return this.listFollowedVideos(request, preferences);
    }

    const sort = request.sort;
    const page = request.page ?? 0;
    const rating = request.rating ?? "all";
    const query = cleanQuery(request.query);
    const tags = normalizeTagList(request.tags ?? []);
    const filter = listFilter(tags, preferences);
    const needsClientScan = tags.length > 1 || filter.blocked.size > 0;
    const pagesToScan = needsClientScan ? clampScanPages(preferences.maxScanPages) : 1;
    const startPage = page * pagesToScan;

    const scan = await this.scanPages(pagesToScan, preferences, filter, (offset) =>
      this.fetchVideoListPageWithRetry({
        sort,
        page: startPage + offset,
        rating,
        query,
        tag: tags[0],
        userId: request.userId,
        subscribed: false,
        limit: DEFAULT_LIMIT
      }), (offset) => `${startPage + offset + 1}`);

    return {
      sort,
      page,
      limit: DEFAULT_LIMIT,
      query,
      tags,
      scannedPages: scan.scannedPages,
      blockedCount: scan.blockedCount,
      partialFailures: scan.failures.length ? scan.failures : undefined,
      total: scan.total,
      hasMore: hasMorePages(scan.total, startPage + scan.scannedPages, DEFAULT_LIMIT, scan.lastRawCount),
      networkDiagnostics: diagnostics(scan.attempts),
      results: scan.results
    };
  }

  private async searchVideos(request: ListVideosRequest, preferences: TagPreferences): Promise<VideoListResult> {
    const sort = request.sort;
    const page = request.page ?? 0;
    const query = cleanQuery(request.query);
    const tags = normalizeTagList(request.tags ?? []);
    const filter = listFilter(tags, preferences);
    if (!query) {
      return { sort, page, limit: DEFAULT_LIMIT, query, tags, scannedPages: 0, blockedCount: 0, total: 0, hasMore: false, results: [] };
    }
    const needsClientScan = filter.required.size > 0 || filter.blocked.size > 0;
    const pagesToScan = needsClientScan ? clampScanPages(preferences.maxScanPages) : 1;
    const startPage = page * pagesToScan;
    let limit = DEFAULT_LIMIT;

    const scan = await this.scanPages(pagesToScan, preferences, filter, async (offset) => {
      const fetched = await this.fetchVideoSearchPageWithRetry(startPage + offset, query, sort);
      limit = fetched.limit;
      return fetched;
    }, (offset) => `${startPage + offset + 1}`);

    return {
      sort,
      page,
      limit,
      query,
      tags,
      scannedPages: scan.scannedPages,
      blockedCount: scan.blockedCount,
      partialFailures: scan.failures.length ? scan.failures : undefined,
      total: scan.total,
      hasMore: hasMorePages(scan.total, startPage + scan.scannedPages, limit, scan.lastRawCount),
      networkDiagnostics: diagnostics(scan.attempts),
      results: scan.results
    };
  }

  private async listSubscribedVideos(request: ListVideosRequest, preferences: TagPreferences): Promise<VideoListResult> {
    const sort = request.sort;
    const page = request.page ?? 0;
    const query = cleanQuery(request.query);
    const tags = normalizeTagList(request.tags ?? []);
    const filter = listFilter(tags, preferences);
    try {
      const fetched = await this.fetchVideoListPageWithRetry({
        sort,
        page,
        rating: request.rating ?? "all",
        query,
        tag: tags[0],
        subscribed: true,
        limit: SUBSCRIBED_LIMIT
      });
      const { results, blockedCount } = applyFilter(fetched.results, filter);
      return {
        sort,
        page,
        limit: SUBSCRIBED_LIMIT,
        query,
        tags,
        scannedPages: 1,
        blockedCount,
        total: fetched.total,
        hasMore: hasMorePages(fetched.total, page + 1, SUBSCRIBED_LIMIT, fetched.rawCount),
        networkDiagnostics: diagnostics(fetched.attempts),
        results
      };
    } catch (error) {
      throw error instanceof ListPageFetchFailure ? new AppError(error.code, error.message) : error;
    }
  }

  private async listFollowedVideos(request: ListVideosRequest, preferences: TagPreferences): Promise<VideoListResult> {
    const sort = request.sort;
    const page = request.page ?? 0;
    const query = cleanQuery(request.query);
    const followedTags = normalizeTagList(preferences.followedTags).slice(0, MAX_FOLLOWED_TAGS);
    const filter = listFilter(normalizeTagList(request.tags ?? []), preferences);
    if (!followedTags.length) {
      return { sort, page, limit: DEFAULT_LIMIT, query, tags: [], scannedPages: 0, blockedCount: 0, hasMore: false, results: [] };
    }

    const pagesToScan = clampScanPages(preferences.maxScanPages);
    const startPage = page * pagesToScan;
    const collected: VideoSummary[] = [];
    const failures: string[] = [];
    const attempts: VideoListNetworkAttempt[] = [];
    let blockedCount = 0;
    let scannedPages = 0;
    let anyFullPage = false;
    let lastFailure: ListPageFetchFailure | undefined;

    for (const tag of followedTags) {
      for (let offset = 0; offset < pagesToScan; offset += 1) {
        if (scannedPages > 0) {
          await delay(clampDelay(preferences.requestDelayMs));
        }
        try {
          const fetched = await this.fetchVideoListPageWithRetry({
            sort,
            page: startPage + offset,
            rating: request.rating ?? "all",
            query,
            tag,
            userId: request.userId,
            subscribed: false,
            limit: DEFAULT_LIMIT
          });
          attempts.push(...fetched.attempts);
          scannedPages += 1;
          anyFullPage ||= fetched.rawCount >= DEFAULT_LIMIT;
          const filtered = applyFilter(fetched.results, filter);
          blockedCount += filtered.blockedCount;
          collected.push(...filtered.results);
          if (fetched.rawCount < DEFAULT_LIMIT) {
            break;
          }
        } catch (error) {
          if (!(error instanceof ListPageFetchFailure)) {
            throw error;
          }
          attempts.push(...error.attempts);
          failures.push(`${tag} #${startPage + offset + 1}: ${error.message}`);
          lastFailure = error;
        }
      }
    }
    if (!scannedPages && lastFailure) {
      throw new AppError(lastFailure.code, lastFailure.message);
    }

    const results = dedupeVideos(collected)
      .sort((a, b) => dateScore(b.createdAt) - dateScore(a.createdAt))
      .slice(0, DEFAULT_LIMIT);

    return {
      sort,
      page,
      limit: DEFAULT_LIMIT,
      query,
      tags: followedTags,
      scannedPages,
      blockedCount,
      partialFailures: failures.length ? failures : undefined,
      hasMore: anyFullPage,
      networkDiagnostics: diagnostics(attempts),
      results
    };
  }

  /** Fetches up to `pageCount` pages, filtering locally until a page of results is filled. */
  private async scanPages(
    pageCount: number,
    preferences: TagPreferences,
    filter: ListFilter,
    fetchPage: (offset: number) => Promise<ListPageFetch>,
    pageLabel: (offset: number) => string
  ) {
    const results: VideoSummary[] = [];
    const failures: string[] = [];
    const attempts: VideoListNetworkAttempt[] = [];
    let total: number | undefined;
    let scannedPages = 0;
    let blockedCount = 0;
    let lastRawCount = 0;
    let lastFailure: ListPageFetchFailure | undefined;

    for (let offset = 0; offset < pageCount; offset += 1) {
      if (offset > 0) {
        await delay(clampDelay(preferences.requestDelayMs));
      }
      try {
        const fetched = await fetchPage(offset);
        attempts.push(...fetched.attempts);
        total = fetched.total ?? total;
        scannedPages += 1;
        lastRawCount = fetched.rawCount;
        const filtered = applyFilter(fetched.results, filter);
        blockedCount += filtered.blockedCount;
        results.push(...filtered.results);
        if (fetched.rawCount < fetched.limit) {
          break;
        }
      } catch (error) {
        if (!(error instanceof ListPageFetchFailure)) {
          throw error;
        }
        attempts.push(...error.attempts);
        failures.push(`#${pageLabel(offset)}: ${error.message}`);
        lastFailure = error;
      }
      if (results.length >= DEFAULT_LIMIT) {
        break;
      }
    }

    // Nothing loaded at all: report the error instead of an empty list.
    if (!scannedPages && lastFailure) {
      throw new AppError(lastFailure.code, lastFailure.message);
    }

    return {
      results: dedupeVideos(results).slice(0, DEFAULT_LIMIT),
      failures,
      attempts,
      total,
      scannedPages,
      blockedCount,
      lastRawCount
    };
  }

  private async fetchVideoListPageWithRetry(options: {
    sort: VideoSort;
    page: number;
    rating: RatingFilter;
    query?: string;
    tag?: string;
    userId?: string;
    subscribed: boolean;
    limit: number;
  }): Promise<ListPageFetch> {
    const url = new URL(`${API_BASE}/videos`);
    if (!options.subscribed) {
      url.searchParams.set("sort", options.sort);
    }
    url.searchParams.set("rating", options.rating);
    url.searchParams.set("page", String(options.page));
    url.searchParams.set("limit", String(options.limit));
    url.searchParams.set("subscribed", String(options.subscribed));
    if (options.query) {
      url.searchParams.set("query", options.query);
    }
    if (options.tag) {
      url.searchParams.set("tags", options.tag);
    }
    if (options.userId) {
      url.searchParams.set("user", options.userId);
    }

    const headers = options.subscribed ? await this.userHeaders() : await this.mediaHeaders();
    const endpoint = options.subscribed ? "subscriptions" : "videos";
    // The latest feed's first page should never be empty; Iwara occasionally
    // returns an empty page under load, so retry it.
    const isDefaultLatest = !options.subscribed && options.page === 0 && options.sort === "date"
      && !options.query && !options.tag && !options.userId;

    return this.fetchListWithRetry(endpoint, options.page, url.toString(), headers, (data) => {
      const raw = arrayField(data, "results");
      return {
        total: numberField(data, "total") ?? numberField(data, "count"),
        limit: options.limit,
        rawCount: raw.length,
        results: raw.map(mapVideoSummary)
      };
    }, (fetched) => fetched.rawCount === 0 && ((fetched.total ?? 0) > 0 || isDefaultLatest));
  }

  private async fetchVideoSearchPageWithRetry(page: number, query: string, sort: VideoSort): Promise<ListPageFetch> {
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set("type", "videos");
    url.searchParams.set("page", String(page));
    url.searchParams.set("query", query);
    url.searchParams.set("sort", sort);

    return this.fetchListWithRetry("search", page, url.toString(), await this.optionalUserHeaders(), (data) => {
      const raw = arrayField(data, "results");
      return {
        total: numberField(data, "total") ?? numberField(data, "count"),
        limit: numberField(data, "limit") ?? DEFAULT_LIMIT,
        rawCount: raw.length,
        results: raw.map(mapVideoSummary)
      };
    }, (fetched) => fetched.rawCount === 0 && (fetched.total ?? 0) > 0);
  }

  private async fetchListWithRetry(
    endpoint: string,
    page: number,
    url: string,
    headers: Record<string, string>,
    parse: (data: unknown) => Omit<ListPageFetch, "attempts">,
    shouldRetryEmpty: (fetched: Omit<ListPageFetch, "attempts">) => boolean
  ): Promise<ListPageFetch> {
    const attempts: VideoListNetworkAttempt[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= LIST_RETRY_ATTEMPTS; attempt += 1) {
      const started = Date.now();
      try {
        const { status, data } = await this.requestJson(url, { headers });
        const fetched = parse(data);
        const retryEmpty = shouldRetryEmpty(fetched);
        attempts.push({
          endpoint,
          page,
          attempt,
          ok: true,
          status,
          elapsedMs: Date.now() - started,
          resultCount: fetched.rawCount,
          error: retryEmpty ? "Empty page returned; retrying" : undefined
        });
        if (retryEmpty && attempt < LIST_RETRY_ATTEMPTS) {
          await delay(LIST_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        return { ...fetched, attempts };
      } catch (error) {
        lastError = error;
        attempts.push({
          endpoint,
          page,
          attempt,
          ok: false,
          status: httpStatusOf(error),
          elapsedMs: Date.now() - started,
          error: errorMessage(error)
        });
        if (attempt < LIST_RETRY_ATTEMPTS && isRetryableListError(error)) {
          await delay(LIST_RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    throw new ListPageFetchFailure(
      errorMessage(lastError ?? "List request failed"),
      isAppError(lastError) ? lastError.code : "NETWORK_ERROR",
      attempts
    );
  }

  // ---------------------------------------------------------------------------
  // Videos

  async getVideo(idOrUrl: string): Promise<VideoDetail> {
    const id = requireVideoId(idOrUrl);
    let data: unknown;
    try {
      ({ data } = await this.requestJson(`${API_BASE}/video/${id}`, { headers: await this.mediaHeaders() }));
    } catch (error) {
      throw mapVideoError(error);
    }
    const apiMessage = valueToString(field(data, "message"));
    if (apiMessage) {
      throw mapVideoError(new AppError("HTTP_ERROR", apiMessage, { apiMessage }));
    }

    const summary = mapVideoSummary(data);
    const fileUrl = valueToString(field(data, "fileUrl"));
    const embedUrl = valueToString(field(data, "embedUrl"));
    if (!fileUrl) {
      if (embedUrl) {
        return { ...summary, formats: [], embedUrl };
      }
      throw new AppError("NO_FORMATS", "This video currently has no playable file.");
    }

    const formats = await this.extractFormats(id, fileUrl, summary.title);
    return { ...summary, formats: this.preferCachedFormats(id, formats), ...(embedUrl ? { embedUrl } : {}) };
  }

  async diagnoseVideo(idOrUrl: string, network?: IwaraNetworkCapture): Promise<IwaraVideoDiagnostics> {
    const id = requireVideoId(idOrUrl);
    const videoHeaders = await this.mediaHeaders();
    const { data } = await this.requestJson(`${API_BASE}/video/${id}`, { headers: videoHeaders });
    const fileUrl = valueToString(field(data, "fileUrl"));
    const probes: IwaraFileProbe[] = [];
    let appFormatLabels: string[] = [];

    if (fileUrl) {
      const xVersion = buildXVersion(fileUrl, this.salt());
      probes.push(await this.probeFileList("session", fileUrl, { "X-Version": xVersion, Accept: "application/json" }));
      probes.push(await this.probeFileList("media-token", fileUrl, mergeHeaders(videoHeaders, { "X-Version": xVersion, Accept: "application/json" })));
      const mediaProbe = probes[1];
      appFormatLabels = mediaProbe?.ok && mediaProbe.formatLabels.length ? mediaProbe.formatLabels : probes[0]?.formatLabels ?? [];
    }

    const networkFormats = bestNetworkFormats(network);
    if (networkFormats.length) {
      this.formatCache.set(id, { formats: networkFormats, capturedAt: Date.now() });
      appFormatLabels = [...networkFormats].sort((a, b) => b.qualityRank - a.qualityRank).map((format) => format.label);
    }

    return {
      videoId: id,
      title: valueToString(field(data, "title")),
      fileUrl: fileUrl ? safeUrl(fileUrl) : undefined,
      appFormatLabels,
      probes,
      network
    };
  }

  routeVideoFormats(video: VideoDetail, speed: MediaSpeedSettings): VideoDetail {
    const target = speed.rankedHosts[0];
    if (!speed.replaceLinks || !target) {
      return video;
    }
    return {
      ...video,
      formats: video.formats.map((format) => {
        if (mediaUrlHost(format.url) === target) {
          return format;
        }
        const url = replaceMediaUrlHost(format.url, target);
        return url ? { ...format, url } : format;
      })
    };
  }

  async speedTestVideo(idOrUrl: string, speed: MediaSpeedSettings): Promise<MediaSpeedTestReport> {
    return this.speedTestHosts(await this.getVideo(idOrUrl), speed);
  }

  async speedTestHosts(video: VideoDetail, speed: MediaSpeedSettings): Promise<MediaSpeedTestReport> {
    const sample = bestFormat(video.formats);
    const discovered = [
      ...video.formats.map((format) => mediaUrlHost(format.url)).filter((host): host is string => Boolean(host)),
      ...speed.candidateHosts
    ];
    const candidates = sample ? buildMediaHostCandidates(sample.url, discovered) : [];
    const results: MediaSpeedCandidateResult[] = [];
    for (const candidate of candidates) {
      results.push(await this.testMediaUrl(candidate.host, candidate.url, speed));
    }
    const fastest = results
      .filter((result) => result.ok && result.bytesPerSecond)
      .sort((a, b) => (b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0))[0];

    return {
      videoId: video.id,
      title: video.title,
      sampleFormatId: sample?.id,
      sampleFormatLabel: sample?.label,
      sampleHost: sample ? mediaUrlHost(sample.url) : undefined,
      testedAt: new Date().toISOString(),
      replaceLinks: speed.replaceLinks,
      fastestHost: fastest?.host,
      results
    };
  }

  private async testMediaUrl(host: string, url: string, speed: MediaSpeedSettings): Promise<MediaSpeedCandidateResult> {
    const started = Date.now();
    const signal = AbortSignal.timeout(speed.timeoutMs);
    try {
      const headers = mergeHeaders(await this.mediaRequestHeaders(), { Range: `bytes=0-${Math.max(speed.testBytes - 1, 0)}` });
      const response = await this.fetch(url, { headers, signal });
      if (!response.ok) {
        await discardBody(response);
        return { host, url, ok: false, error: `HTTP ${response.status}` };
      }
      const bytesRead = await readAtMost(response, speed.testBytes, signal);
      if (!bytesRead) {
        return { host, url, ok: false, error: "No data received" };
      }
      const elapsedMs = Math.max(Date.now() - started, 1);
      return { host, url, ok: true, elapsedMs, bytesRead, bytesPerSecond: Math.round((bytesRead * 1000) / elapsedMs) };
    } catch (error) {
      return { host, url, ok: false, error: isAbortError(error) ? "Timed out" : errorMessage(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // Downloads

  async prepareDownload(
    request: DownloadVideoRequest,
    download: DownloadSettings,
    speed: MediaSpeedSettings,
    inUse: ReadonlySet<string> = new Set()
  ): Promise<DownloadPlan> {
    let video = await this.getVideo(request.videoId);
    video = this.routeVideoFormats(video, speed);
    const requestedQuality = request.quality ?? download.defaultQuality;
    const format = chooseVideoFormat(video.formats, requestedQuality);
    if (!format) {
      throw new AppError("NO_FORMATS", "No downloadable quality was found.");
    }
    if (!download.directory) {
      throw new AppError("DOWNLOAD_DIRECTORY_REQUIRED", "Choose a download folder in Settings first.");
    }
    const directory = path.resolve(download.directory);
    await mkdir(directory, { recursive: true });
    return {
      path: await uniqueDownloadPath(directory, video.title, video.id, format, inUse),
      format,
      video,
      fallbackFrom: requestedQuality && requestedQuality !== format.id ? requestedQuality : undefined
    };
  }

  /** Headers for direct media requests (downloads, speed tests). */
  async mediaRequestHeaders(): Promise<Record<string, string>> {
    const token = await this.session.token();
    return {
      Accept: "*/*",
      Referer: `${WEB_BASE}/`,
      Origin: WEB_BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  // ---------------------------------------------------------------------------
  // X-Version salt

  async sniffXVersionSalt(): Promise<XVersionSaltReport> {
    const checkedAt = new Date().toISOString();
    const home = await this.fetchText(`${WEB_BASE}/`, "text/html");
    // Third-party scripts (analytics, Cloudflare) never carry the salt.
    for (const sourceUrl of scriptUrlsFromHtml(home, `${WEB_BASE}/`).filter(isIwaraUrl)) {
      const script = await this.fetchText(sourceUrl, "application/javascript,text/javascript,*/*");
      const salt = extractXVersionSaltFromScript(script);
      if (salt) {
        return { salt, sourceUrl, checkedAt };
      }
    }
    throw new AppError("SALT_NOT_FOUND", "No X-Version salt was found in Iwara's frontend scripts.");
  }

  // ---------------------------------------------------------------------------
  // Comments

  async listVideoComments(request: ListCommentsRequest): Promise<VideoCommentsResult> {
    const videoId = requireVideoId(request.videoId);
    const page = Math.max(0, Math.floor(request.page ?? 0));
    const url = new URL(`${API_BASE}/video/${videoId}/comments`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(COMMENT_LIMIT));
    if (request.parentId) {
      url.searchParams.set("parent", request.parentId);
    }
    const { data } = await this.requestJson(url.toString(), { headers: await this.mediaHeaders() });
    const raw = arrayField(data, "results");
    const total = numberField(data, "total") ?? numberField(data, "count") ?? raw.length;
    const limit = numberField(data, "limit") ?? COMMENT_LIMIT;
    return {
      videoId,
      parentId: request.parentId,
      page,
      limit,
      total,
      hasMore: (page + 1) * limit < total,
      comments: raw.map(mapVideoComment).filter((comment): comment is VideoComment => Boolean(comment)),
      fetchedAt: new Date().toISOString()
    };
  }

  async sendVideoComment(request: SendVideoCommentRequest): Promise<VideoComment> {
    const videoId = requireVideoId(request.videoId);
    const body = request.body.trim();
    if (!body) {
      throw new AppError("INVALID_INPUT", "Comment text cannot be empty.");
    }
    if (!(await this.session.token())) {
      throw new AppError("LOGIN_REQUIRED", "Sign in to Iwara to comment.");
    }
    const { data } = await this.requestJson(`${API_BASE}/video/${videoId}/comments`, {
      method: "POST",
      headers: mergeHeaders(await this.mediaHeaders(), { "Content-Type": "application/json" }),
      body: JSON.stringify(request.parentId ? { body, parent: request.parentId } : { body })
    });
    const comment = mapVideoComment(data);
    if (!comment) {
      throw new AppError("INVALID_RESPONSE", "The comment was submitted, but Iwara returned no displayable comment.");
    }
    return comment;
  }

  // ---------------------------------------------------------------------------
  // Internals

  private async extractFormats(videoId: string, fileUrl: string, title: string): Promise<VideoFormat[]> {
    const url = new URL(fileUrl);
    url.searchParams.append("download", `Iwara - ${title} [${videoId}].mp4`);
    const { data } = await this.requestJson(url.toString(), {
      headers: mergeHeaders(await this.mediaHeaders(), {
        "X-Version": buildXVersion(fileUrl, this.salt()),
        Accept: "application/json"
      })
    });
    return formatsFromJson(data).sort((a, b) => a.qualityRank - b.qualityRank);
  }

  private preferCachedFormats(videoId: string, direct: VideoFormat[]): VideoFormat[] {
    const cached = this.formatCache.get(videoId);
    if (!cached) {
      return direct;
    }
    if (Date.now() - cached.capturedAt > FORMAT_CACHE_TTL_MS) {
      this.formatCache.delete(videoId);
      return direct;
    }
    return bestQualityRank(cached.formats) > bestQualityRank(direct) || cached.formats.length > direct.length
      ? cached.formats
      : direct;
  }

  private async probeFileList(label: string, fileUrl: string, headers: Record<string, string>): Promise<IwaraFileProbe> {
    try {
      const { status, data } = await this.requestJson(fileUrl, { headers });
      return { label, url: safeUrl(fileUrl), ok: true, status, formatLabels: formatsFromJson(data).map((format) => format.label) };
    } catch (error) {
      return { label, url: safeUrl(fileUrl), ok: false, status: httpStatusOf(error), formatLabels: [], error: errorMessage(error) };
    }
  }

  /** Anonymous requests are fine; when signed in, prefer a fresh media token. */
  private async mediaHeaders(): Promise<Record<string, string>> {
    const userToken = await this.session.token();
    if (!userToken) {
      return {};
    }
    if (this.mediaToken?.userToken === userToken && !isJwtExpired(this.mediaToken.value, TOKEN_SKEW_SECONDS)) {
      return { Authorization: `Bearer ${this.mediaToken.value}` };
    }
    try {
      return { Authorization: `Bearer ${await this.refreshMediaToken(userToken)}` };
    } catch {
      return { Authorization: `Bearer ${userToken}` };
    }
  }

  private async userHeaders(): Promise<Record<string, string>> {
    const token = await this.session.token();
    if (!token) {
      throw new AppError("LOGIN_REQUIRED", "Sign in to Iwara to see subscriptions.");
    }
    if (isJwtExpired(token, TOKEN_SKEW_SECONDS)) {
      throw new AppError("LOGIN_EXPIRED", "Your Iwara session has expired. Sign in again.");
    }
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  private async authenticatedApiHeaders(): Promise<Record<string, string>> {
    const token = await this.session.token();
    if (!token) {
      throw new AppError("LOGIN_REQUIRED", "Sign in to Iwara to follow authors.");
    }
    const media = await this.mediaHeaders();
    if (media.Authorization) {
      return media;
    }
    if (isJwtExpired(token, TOKEN_SKEW_SECONDS)) {
      throw new AppError("LOGIN_EXPIRED", "Your Iwara session has expired. Sign in again.");
    }
    return { Authorization: `Bearer ${token}` };
  }

  private async optionalUserHeaders(): Promise<Record<string, string>> {
    const token = await this.session.token();
    return token && !isJwtExpired(token, TOKEN_SKEW_SECONDS)
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" };
  }

  private async refreshMediaToken(userToken: string): Promise<string> {
    if (isJwtExpired(userToken, TOKEN_SKEW_SECONDS)) {
      throw new AppError("LOGIN_EXPIRED", "Your Iwara session has expired. Sign in again.");
    }
    const { data } = await this.requestJson(`${API_BASE}/user/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: ""
    });
    const accessToken = valueToString(field(data, "accessToken"));
    if (!accessToken) {
      throw new AppError("INVALID_RESPONSE", "Iwara did not return a media access token.");
    }
    this.mediaToken = { value: accessToken, userToken };
    return accessToken;
  }

  /**
   * JSON request against Iwara. Adds the site headers and the web-session
   * token, and retries inside a real www.iwara.tv page when Cloudflare answers
   * with a browser challenge instead of JSON.
   */
  private async requestJson(
    url: string,
    init: { method?: "GET" | "POST" | "DELETE"; headers?: Record<string, string>; body?: string } = {}
  ): Promise<JsonResponse> {
    const method = init.method ?? "GET";
    if (!isIwaraUrl(url)) {
      // e.g. a fileUrl from the API pointing elsewhere: never send it the token.
      throw new AppError("INVALID_RESPONSE", "Iwara returned a link outside iwara.tv.", { url: safeUrl(url) });
    }
    const sessionToken = await this.session.token();
    const headers = mergeHeaders(
      {
        Accept: "application/json",
        "X-Site": "www.iwara.tv",
        Referer: `${WEB_BASE}/`,
        Origin: WEB_BASE
      },
      sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined,
      init.headers
    );

    let response: Response;
    try {
      response = await this.fetch(url, { method, headers, body: init.body, signal: withTimeout(undefined, REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new AppError("NETWORK_ERROR", isAbortError(error) ? "The request to Iwara timed out." : errorMessage(error));
    }

    let status = response.status;
    let contentType = response.headers.get("content-type") ?? "";
    let text = await response.text();

    const body = text.trimStart();
    const challenged = !contentType.includes("application/json")
      && (looksLikeCloudflare(text) || (!body.startsWith("{") && !body.startsWith("[")));
    if (challenged && text.trim() && canUsePageFetch(url, headers)) {
      try {
        const fallback = await this.session.pageFetch(url, { method, headers, body: init.body });
        status = fallback.status;
        contentType = headerValue(fallback.headers, "content-type") ?? "";
        text = fallback.text;
      } catch {
        // Keep the original response; it is reported below.
      }
    }

    if (!text.trim()) {
      if (status < 200 || status >= 300) {
        throw statusError(status, undefined);
      }
      return { status, data: {} };
    }

    const trimmed = text.trimStart();
    if (!contentType.includes("application/json") && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      if (looksLikeCloudflare(text)) {
        throw new AppError("CLOUDFLARE_CHALLENGE", "Iwara answered with a browser verification page.", { status });
      }
      throw new AppError("INVALID_RESPONSE", `Iwara returned non-JSON content (HTTP ${status}).`, { status });
    }

    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new AppError("INVALID_RESPONSE", `Iwara returned malformed JSON (HTTP ${status}).`, { status });
    }
    if (status < 200 || status >= 300) {
      throw statusError(status, valueToString(field(data, "message")));
    }
    return { status, data };
  }

  /** Public pages and scripts; these need no session token. */
  private async fetchText(url: string, accept: string): Promise<string> {
    if (!isIwaraUrl(url)) {
      throw new AppError("INVALID_RESPONSE", "Refusing to fetch a page outside iwara.tv.", { url: safeUrl(url) });
    }
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { Accept: accept, Referer: `${WEB_BASE}/` },
        signal: withTimeout(undefined, REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new AppError("NETWORK_ERROR", errorMessage(error));
    }
    const text = await response.text();
    if (!response.ok) {
      if (looksLikeCloudflare(text)) {
        throw new AppError("CLOUDFLARE_CHALLENGE", "Iwara answered with a browser verification page.", { status: response.status });
      }
      throw new AppError("HTTP_ERROR", `Request failed: HTTP ${response.status}`, { status: response.status });
    }
    return text;
  }
}

// -----------------------------------------------------------------------------
// Helpers

function requireVideoId(idOrUrl: string): string {
  const id = parseIwaraVideoId(idOrUrl);
  if (!id) {
    throw new AppError("INVALID_VIDEO_ID", "Not a recognizable Iwara video ID or link.");
  }
  return id;
}

function statusError(status: number, apiMessage: string | undefined): AppError {
  const details: Record<string, string | number> = { status };
  if (apiMessage) {
    details.apiMessage = apiMessage;
  }
  const suffix = apiMessage ? ` (${apiMessage})` : "";
  if (status === 401) {
    return new AppError("LOGIN_REQUIRED", `Iwara rejected the request: HTTP 401${suffix}`, details);
  }
  return new AppError("HTTP_ERROR", `Iwara request failed: HTTP ${status}${suffix}`, details);
}

function mapVideoError(error: unknown): unknown {
  if (!isAppError(error)) {
    return error;
  }
  const apiMessage = String(error.details?.apiMessage ?? "");
  if (apiMessage === "errors.privateVideo") {
    return new AppError("PRIVATE_VIDEO", "This video is private. Sign in with an account that can access it.", error.details);
  }
  if (apiMessage === "errors.notFound" || error.details?.status === 404) {
    return new AppError("VIDEO_NOT_FOUND", "The video does not exist or requires signing in.", error.details);
  }
  if (apiMessage && error.code === "HTTP_ERROR") {
    return new AppError("VIDEO_UNAVAILABLE", `Iwara returned an error: ${apiMessage}`, error.details);
  }
  return error;
}

function canUsePageFetch(url: string, headers: Record<string, string>): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ["api.iwara.tv", "apiq.iwara.tv", "files.iwara.tv", "filesq.iwara.tv"].includes(host)
    && (headerValue(headers, "accept") ?? "").toLowerCase().includes("application/json");
}

function isRetryableListError(error: unknown): boolean {
  if (isAppError(error) && ["LOGIN_REQUIRED", "LOGIN_EXPIRED", "CLOUDFLARE_CHALLENGE", "INVALID_INPUT"].includes(error.code)) {
    return false;
  }
  const status = httpStatusOf(error);
  if (status === undefined) {
    return true;
  }
  if ([401, 403, 404].includes(status)) {
    return false;
  }
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

function listFilter(requiredTags: string[], preferences: TagPreferences): ListFilter {
  return { required: new Set(requiredTags), blocked: new Set(normalizeTagList(preferences.blockedTags)) };
}

function applyFilter(videos: VideoSummary[], filter: ListFilter): { results: VideoSummary[]; blockedCount: number } {
  let blockedCount = 0;
  const results = videos.filter((video) => {
    const tags = new Set(video.tags.map((tag) => tag.trim().toLowerCase()));
    if ([...filter.blocked].some((tag) => tags.has(tag))) {
      blockedCount += 1;
      return false;
    }
    return [...filter.required].every((tag) => tags.has(tag));
  });
  return { results, blockedCount };
}

export function matchesAllTags(videoTags: string[], tags: Set<string>): boolean {
  const normalized = new Set(videoTags.map((tag) => tag.trim().toLowerCase()));
  return [...tags].every((tag) => normalized.has(tag));
}

export function matchesAnyTag(videoTags: string[], tags: Set<string>): boolean {
  const normalized = new Set(videoTags.map((tag) => tag.trim().toLowerCase()));
  return [...tags].some((tag) => normalized.has(tag));
}

function dedupeVideos(videos: VideoSummary[]): VideoSummary[] {
  const seen = new Set<string>();
  return videos.filter((video) => {
    if (seen.has(video.id)) {
      return false;
    }
    seen.add(video.id);
    return true;
  });
}

function hasMorePages(total: number | undefined, pagesConsumed: number, limit: number, lastRawCount: number): boolean {
  return total !== undefined ? pagesConsumed * limit < total : lastRawCount >= limit;
}

function dateScore(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function cleanQuery(query: string | undefined): string | undefined {
  const trimmed = query?.trim();
  return trimmed || undefined;
}

function clampScanPages(value: number): number {
  return Math.min(Math.max(Math.round(value) || 1, 1), 10);
}

function clampDelay(value: number): number {
  return Math.min(Math.max(Math.round(value) || 0, 0), 1500);
}

function diagnostics(attempts: VideoListNetworkAttempt[]) {
  return attempts.length ? { attempts } : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  const list = field(value, key);
  return Array.isArray(list) ? list : [];
}

function numberField(value: unknown, key: string): number | undefined {
  const number = field(value, key);
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function bestNetworkFormats(network: IwaraNetworkCapture | undefined): VideoFormat[] {
  let best: VideoFormat[] = [];
  for (const entry of network?.entries ?? []) {
    if (entry.formats?.length && bestQualityRank(entry.formats) > bestQualityRank(best)) {
      best = entry.formats;
    }
  }
  return best;
}

async function readAtMost(response: Response, maxBytes: number, signal: AbortSignal): Promise<number> {
  if (!response.body) {
    return 0;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Math.min(bytes, maxBytes);
}

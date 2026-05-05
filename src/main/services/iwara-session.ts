import { BrowserWindow, session, shell } from "electron";
import { formatToExtension, normalizeMediaUrl, parseIwaraVideoId, qualityRank } from "../../shared/iwara-utils";
import type { AuthState, IwaraNetworkCapture, IwaraNetworkEntry, VideoFormat } from "../../shared/types";

const IWARA_HOME = "https://www.iwara.tv/";
const IWARA_ORIGINS = ["https://www.iwara.tv/", "https://api.iwara.tv/", "https://files.iwara.tv/", "https://filesq.iwara.tv/"];
const FORBIDDEN_BROWSER_FETCH_HEADERS = ["cookie", "host", "origin", "referer", "user-agent", "content-length"];

export class IwaraSessionService {
  private verificationWindow?: BrowserWindow;
  private pageFetchWindow?: BrowserWindow;
  private capturedToken?: { key: string; value: string };
  private captureTimer?: NodeJS.Timeout;

  constructor() {
    const browserUserAgent = session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/i, "");
    session.defaultSession.setUserAgent(browserUserAgent, "zh-CN,zh;q=0.9,en;q=0.8");
  }

  async openVerificationWindow(parent?: BrowserWindow): Promise<Pick<AuthState, "siteSessionReady" | "siteCookieCount" | "siteTokenReady" | "siteTokenKey" | "browserUserAgent">> {
    if (this.verificationWindow && !this.verificationWindow.isDestroyed()) {
      this.verificationWindow.focus();
      return this.state();
    }

    this.verificationWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      parent,
      title: "Iwara 验证",
      backgroundColor: "#111317",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: session.defaultSession
      }
    });

    this.verificationWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isIwaraUrl(url)) {
        this.verificationWindow?.loadURL(url);
      } else {
        shell.openExternal(url);
      }

      return { action: "deny" };
    });

    this.verificationWindow.on("closed", () => {
      this.verificationWindow = undefined;
      this.stopCaptureTimer();
    });

    await this.verificationWindow.loadURL(IWARA_HOME);
    this.startCaptureLoop(this.verificationWindow);
    return this.state();
  }

  async state(): Promise<Pick<AuthState, "siteSessionReady" | "siteCookieCount" | "siteTokenReady" | "siteTokenKey" | "browserUserAgent">> {
    const cookies = await this.iwaraCookies();
    const token = await this.captureToken();
    return {
      siteSessionReady: cookies.length > 0,
      siteCookieCount: cookies.length,
      siteTokenReady: Boolean(token?.value),
      siteTokenKey: token?.key,
      browserUserAgent: session.defaultSession.getUserAgent()
    };
  }

  async headersFor(url: string): Promise<Record<string, string>> {
    const cookieHeader = await this.cookieHeaderFor(url);
    const token = await this.captureToken();
    return {
      "User-Agent": session.defaultSession.getUserAgent(),
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(token?.value ? { Authorization: `Bearer ${token.value}` } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    };
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const name of FORBIDDEN_BROWSER_FETCH_HEADERS) {
      headers.delete(name);
    }
    if (!headers.has("Accept-Language")) {
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    }

    const browserInit = {
      ...init,
      credentials: "include",
      headers,
      referrer: IWARA_HOME
    } satisfies RequestInit;

    try {
      const response = await session.defaultSession.fetch(url, browserInit);
      if (await this.shouldRetryInsideIwaraPage(url, headers, response)) {
        return await this.fetchInsideIwaraPage(url, browserInit).catch(() => response);
      }

      return response;
    } catch (err) {
      if (this.canUseIwaraPageFetch(url, headers)) {
        return await this.fetchInsideIwaraPage(url, browserInit);
      }

      throw err;
    }
  }

  async token(): Promise<string | undefined> {
    return (await this.captureToken())?.value;
  }

  async captureVideoNetwork(idOrUrl: string, parent?: BrowserWindow): Promise<IwaraNetworkCapture> {
    const videoId = parseIwaraVideoId(idOrUrl);
    const pageUrl = `https://www.iwara.tv/video/${videoId}`;
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      parent,
      title: "Iwara API 抓包诊断",
      backgroundColor: "#111317",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: session.defaultSession
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isIwaraUrl(url)) {
        window.loadURL(url);
      } else {
        shell.openExternal(url);
      }

      return { action: "deny" };
    });

    const entries = new Map<string, IwaraNetworkEntry>();
    let timedOut = false;
    let closeTimer: NodeJS.Timeout | undefined;

    const closeSoon = (delay = 1200) => {
      if (closeTimer) {
        return;
      }

      closeTimer = setTimeout(() => {
        if (!window.isDestroyed()) {
          window.close();
        }
      }, delay);
    };

    try {
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Network.enable");
      window.webContents.debugger.on("message", (_event, method, params) => {
        void this.handleNetworkMessage(window, entries, method, params, closeSoon);
      });
    } catch (err) {
      entries.set("debugger", {
        url: pageUrl,
        method: "GET",
        formatLabels: [],
        error: err instanceof Error ? err.message : String(err)
      });
    }

    window.on("closed", () => {
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
      if (window.webContents.debugger.isAttached()) {
        window.webContents.debugger.detach();
      }
    });

    await window.loadURL(pageUrl);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        closeSoon(0);
        resolve();
      }, 18000);
      window.on("closed", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    return {
      pageUrl,
      entries: [...entries.values()],
      timedOut
    };
  }

  private async cookieHeaderFor(url: string): Promise<string | undefined> {
    const urls = unique([url, ...IWARA_ORIGINS]);
    const cookies = (await Promise.all(urls.map((cookieUrl) => session.defaultSession.cookies.get({ url: cookieUrl })))).flat();
    const cookieMap = new Map<string, string>();

    for (const cookie of cookies) {
      cookieMap.set(cookie.name, cookie.value);
    }

    return cookieMap.size
      ? [...cookieMap.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
      : undefined;
  }

  private async iwaraCookies() {
    return (await Promise.all(IWARA_ORIGINS.map((url) => session.defaultSession.cookies.get({ url })))).flat();
  }

  private startCaptureLoop(window: BrowserWindow): void {
    this.stopCaptureTimer();
    const capture = async () => {
      if (window.isDestroyed()) {
        this.stopCaptureTimer();
        return;
      }

      const token = await this.captureTokenFromWindow(window);
      if (token?.value) {
        this.capturedToken = token;
        this.stopCaptureTimer();
        setTimeout(() => {
          if (!window.isDestroyed()) {
            window.close();
          }
        }, 800);
      }
    };

    window.webContents.on("did-finish-load", () => {
      void capture();
    });
    window.webContents.on("dom-ready", () => {
      void capture();
    });
    this.captureTimer = setInterval(() => {
      void capture();
    }, 1500);
    void capture();
  }

  private stopCaptureTimer(): void {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = undefined;
    }
  }

  private async captureToken(): Promise<{ key: string; value: string } | undefined> {
    const target = this.verificationWindow && !this.verificationWindow.isDestroyed()
      ? this.verificationWindow
      : this.pageFetchWindow && !this.pageFetchWindow.isDestroyed()
        ? this.pageFetchWindow
      : undefined;

    if (!target) {
      return this.capturedToken;
    }

    const token = await this.captureTokenFromWindow(target);
    if (token?.value) {
      this.capturedToken = token;
    }

    return this.capturedToken;
  }

  private async shouldRetryInsideIwaraPage(url: string, headers: Headers, response: Response): Promise<boolean> {
    if (!this.canUseIwaraPageFetch(url, headers)) {
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return false;
    }

    const text = await response.clone().text().catch(() => "");
    const normalized = text.toLowerCase();
    return normalized.includes("<html") || normalized.includes("cloudflare");
  }

  private canUseIwaraPageFetch(url: string, headers: Headers): boolean {
    return isRelevantIwaraApiUrl(url) && (headers.get("Accept") ?? "").toLowerCase().includes("application/json");
  }

  private async fetchInsideIwaraPage(url: string, init: RequestInit): Promise<Response> {
    const window = await this.ensurePageFetchWindow();
    const headers = new Headers(init.headers);
    for (const name of FORBIDDEN_BROWSER_FETCH_HEADERS) {
      headers.delete(name);
    }

    const payload = {
      url,
      method: init.method ?? "GET",
      headers: [...headers.entries()],
      body: typeof init.body === "string" ? init.body : undefined
    };
    const result = await window.webContents.executeJavaScript(`
      (async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body,
          credentials: "include",
          mode: "cors"
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          text: await response.text()
        };
      })(${JSON.stringify(payload)})
    `, true) as BrowserFetchResult;

    const token = await this.captureTokenFromWindow(window);
    if (token?.value) {
      this.capturedToken = token;
    }

    return new Response(result.text, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
  }

  private async ensurePageFetchWindow(): Promise<BrowserWindow> {
    if (this.verificationWindow && !this.verificationWindow.isDestroyed()) {
      return this.verificationWindow;
    }

    if (this.pageFetchWindow && !this.pageFetchWindow.isDestroyed()) {
      return this.pageFetchWindow;
    }

    this.pageFetchWindow = new BrowserWindow({
      width: 960,
      height: 640,
      show: false,
      title: "Iwara 会话请求",
      backgroundColor: "#111317",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: session.defaultSession
      }
    });

    this.pageFetchWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isIwaraUrl(targetUrl)) {
        this.pageFetchWindow?.loadURL(targetUrl);
      } else {
        shell.openExternal(targetUrl);
      }

      return { action: "deny" };
    });
    this.pageFetchWindow.on("closed", () => {
      this.pageFetchWindow = undefined;
    });

    await this.pageFetchWindow.loadURL(IWARA_HOME);
    const token = await this.captureTokenFromWindow(this.pageFetchWindow);
    if (token?.value) {
      this.capturedToken = token;
    }

    return this.pageFetchWindow;
  }

  private async captureTokenFromWindow(target: BrowserWindow): Promise<{ key: string; value: string } | undefined> {
    try {
      const storage = await target.webContents.executeJavaScript(`
        (() => {
          const dump = (storage) => {
            const entries = {};
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (key) entries[key] = storage.getItem(key);
            }
            return entries;
          };
          return {
            localStorage: dump(window.localStorage),
            sessionStorage: dump(window.sessionStorage)
          };
        })()
      `, true) as StorageDump;

      return findToken(storage);
    } catch {
      return this.capturedToken;
    }
  }

  private async handleNetworkMessage(
    target: BrowserWindow,
    entries: Map<string, IwaraNetworkEntry>,
    method: string,
    params: Record<string, unknown>,
    closeSoon: () => void
  ): Promise<void> {
    if (method === "Network.requestWillBeSent") {
      const requestId = String(params.requestId ?? "");
      const request = params.request as { url?: string; method?: string } | undefined;
      if (!requestId || !request?.url || !isRelevantIwaraApiUrl(request.url)) {
        return;
      }

      entries.set(requestId, {
        url: safeUrl(request.url),
        method: request.method ?? "GET",
        formatLabels: [],
        ...requestHeaderSummary((request as { headers?: Record<string, unknown> }).headers)
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = String(params.requestId ?? "");
      const response = params.response as { url?: string; status?: number; mimeType?: string } | undefined;
      if (!requestId || !response?.url || !isRelevantIwaraApiUrl(response.url)) {
        return;
      }

      const current = entries.get(requestId) ?? {
        url: safeUrl(response.url),
        method: "GET",
        formatLabels: []
      };
      current.status = response.status;
      current.resourceType = typeof params.type === "string" ? params.type : response.mimeType;
      entries.set(requestId, current);
      return;
    }

    if (method === "Network.loadingFinished") {
      const requestId = String(params.requestId ?? "");
      const current = entries.get(requestId);
      if (!requestId || !current) {
        return;
      }

      try {
        const body = await target.webContents.debugger.sendCommand("Network.getResponseBody", { requestId }) as { body?: string; base64Encoded?: boolean };
        if (!body.body || body.base64Encoded) {
          return;
        }

        const summary = summarizeJsonResponse(body.body);
        current.formatLabels = summary.formatLabels;
        current.formats = summary.formats;
        current.responseShape = summary.responseShape;
        entries.set(requestId, current);
        if (summary.formatLabels.length) {
          closeSoon();
        }
      } catch (err) {
        current.error = err instanceof Error ? err.message : String(err);
        entries.set(requestId, current);
      }
    }
  }
}

interface StorageDump {
  localStorage?: Record<string, string | null>;
  sessionStorage?: Record<string, string | null>;
}

interface BrowserFetchResult {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  text: string;
}

function isIwaraUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "iwara.tv" || parsed.hostname.endsWith(".iwara.tv");
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function findToken(storage: StorageDump): { key: string; value: string } | undefined {
  const entries = [
    ...Object.entries(storage.localStorage ?? {}).map(([key, value]) => [`localStorage.${key}`, value] as const),
    ...Object.entries(storage.sessionStorage ?? {}).map(([key, value]) => [`sessionStorage.${key}`, value] as const)
  ];
  const preferredKeys = ["token", "accessToken", "access_token", "authToken", "userToken"];

  for (const keyName of preferredKeys) {
    const found = entries.find(([key, value]) => key.toLowerCase().endsWith(`.${keyName.toLowerCase()}`) && findJwt(value));
    if (found) {
      return { key: found[0], value: findJwt(found[1])! };
    }
  }

  for (const [key, value] of entries) {
    const token = findJwt(value);
    if (token) {
      return { key, value: token };
    }
  }

  return undefined;
}

function findJwt(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const direct = value.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (direct) {
    return direct[0];
  }

  try {
    return findJwt(JSON.stringify(JSON.parse(value)));
  } catch {
    return undefined;
  }
}

function isRelevantIwaraApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.iwara.tv"
      || parsed.hostname === "files.iwara.tv"
      || parsed.hostname === "filesq.iwara.tv";
  } catch {
    return false;
  }
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

function requestHeaderSummary(headers: Record<string, unknown> | undefined): Pick<IwaraNetworkEntry, "xVersion" | "hasAuthorization"> {
  const entries = Object.entries(headers ?? {});
  const header = (name: string) => {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return typeof found?.[1] === "string" ? found[1] : undefined;
  };

  return {
    xVersion: header("x-version"),
    hasAuthorization: Boolean(header("authorization"))
  };
}

function summarizeJsonResponse(body: string): { formatLabels: string[]; formats: VideoFormat[]; responseShape: string } {
  try {
    const json = JSON.parse(body) as unknown;
    const formats = fileListFromJson(json)
      .map((item) => mapVideoFormat(item))
      .filter((format): format is VideoFormat => Boolean(format));
    return {
      formatLabels: formats.map((format) => format.label),
      formats,
      responseShape: responseShape(json)
    };
  } catch {
    return {
      formatLabels: [],
      formats: [],
      responseShape: "non-json"
    };
  }
}

function fileListFromJson(value: unknown): unknown[] {
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

function mapVideoFormat(value: unknown): VideoFormat | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const label = record.name ?? record.label ?? record.quality ?? record.height;
  const normalizedLabel = typeof label === "string" || typeof label === "number" ? String(label) : undefined;
  const url = formatUrl(record);

  if (!normalizedLabel || !url) {
    return undefined;
  }

  const mimeType = typeof record.type === "string" ? record.type : undefined;
  return {
    id: normalizedLabel,
    label: normalizedLabel,
    url: normalizeMediaUrl(url),
    mimeType,
    ext: formatToExtension(mimeType),
    height: Number.isFinite(Number.parseInt(normalizedLabel, 10)) ? Number.parseInt(normalizedLabel, 10) : undefined,
    qualityRank: qualityRank(normalizedLabel)
  };
}

function formatUrl(record: Record<string, unknown>): string | undefined {
  const src = record.src;
  if (typeof src === "string") {
    return src;
  }

  if (src && typeof src === "object") {
    const srcRecord = src as Record<string, unknown>;
    return stringValue(srcRecord.view)
      ?? stringValue(srcRecord.download)
      ?? stringValue(srcRecord.src)
      ?? stringValue(srcRecord.url);
  }

  return stringValue(record.view)
    ?? stringValue(record.download)
    ?? stringValue(record.url);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function responseShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (value && typeof value === "object") {
    return `object(${Object.keys(value as Record<string, unknown>).join(", ")})`;
  }

  return typeof value;
}

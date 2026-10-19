import { BrowserWindow, session as electronSession, shell, type Session } from "electron";
import type { IwaraNetworkCapture, IwaraNetworkEntry } from "../../shared/types";
import { parseIwaraVideoId } from "../../shared/video-id";
import { AppError, errorMessage } from "../lib/app-error";
import type { HttpFetch, HttpRequestInit } from "../lib/http";
import { safeUrl, summarizeJsonResponse } from "../lib/iwara-parse";
import { findToken, isJwtExpired, jwtExpiry, type CapturedToken, type StorageDump } from "../lib/jwt";
import type { IwaraSessionBridge, PageFetchResult } from "./iwara-client";

export const IWARA_PARTITION = "persist:iwara";
const IWARA_HOME = "https://www.iwara.tv/";
const IWARA_LOGIN = "https://www.iwara.tv/login";
const COOKIE_ORIGINS = ["https://www.iwara.tv/", "https://api.iwara.tv/", "https://files.iwara.tv/", "https://filesq.iwara.tv/"];
const ACCEPT_LANGUAGES = "zh-CN,zh;q=0.9,en;q=0.8";
const TOKEN_CACHE_MS = 60_000;
const HELPER_IDLE_MS = 5 * 60_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const SCRIPT_TIMEOUT_MS = 20_000;
const CAPTURE_POLL_MS = 1500;
const NETWORK_CAPTURE_TIMEOUT_MS = 18_000;
/** Headers a page-context fetch() may not set; the browser supplies them. */
const FORBIDDEN_PAGE_FETCH_HEADERS = new Set(["cookie", "host", "origin", "referer", "user-agent", "content-length"]);
/** Headers Chromium's network service rejects or owns for main-process requests. */
const NETWORK_MANAGED_HEADERS = new Set(["cookie", "host", "origin", "referer", "user-agent", "content-length", "connection"]);

export interface SessionSnapshot {
  cookieCount: number;
  token?: CapturedToken;
  verificationWindowOpen: boolean;
}

export function isIwaraUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "iwara.tv" || hostname.endsWith(".iwara.tv"));
  } catch {
    return false;
  }
}

function isApiHost(url: string): boolean {
  try {
    return ["api.iwara.tv", "apiq.iwara.tv", "files.iwara.tv", "filesq.iwara.tv"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Chromium's UA without the Electron and app tokens, so Iwara sees a normal browser. */
export function browserUserAgent(userAgent: string): string {
  return userAgent.replace(/\s(?:Electron|IwaraTV|iwara-tv-local-player)\/\S+/gi, "");
}

export class IwaraSessionService implements IwaraSessionBridge {
  readonly session: Session;
  private verificationWindow?: BrowserWindow;
  private helperWindow?: BrowserWindow;
  private helperLoading?: Promise<BrowserWindow>;
  private helperIdleTimer?: NodeJS.Timeout;
  private capturePollTimer?: NodeJS.Timeout;
  private cached?: { token: CapturedToken; checkedAt: number };
  private capturing?: Promise<CapturedToken | undefined>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly parentWindow: () => BrowserWindow | undefined) {
    this.session = electronSession.fromPartition(IWARA_PARTITION);
    this.session.setUserAgent(browserUserAgent(this.session.getUserAgent()), ACCEPT_LANGUAGES);
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    // Main-process API requests have no page, so Chromium won't let us set
    // Referer/Origin directly. Add the values Iwara's own frontend sends.
    this.session.webRequest.onBeforeSendHeaders({ urls: ["https://*.iwara.tv/*"] }, (details, callback) => {
      if (details.webContentsId !== undefined) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Referer: IWARA_HOME,
          ...(isApiHost(details.url) ? { Origin: "https://www.iwara.tv" } : {})
        }
      });
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Requests through the Iwara session: shared cookies, Cloudflare clearance, browser TLS. */
  readonly fetch: HttpFetch = (url: string, init: HttpRequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (!NETWORK_MANAGED_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    return this.session.fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: init.signal,
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    });
  };

  async token(): Promise<string | undefined> {
    const cached = this.cached;
    if (cached && Date.now() - cached.checkedAt < TOKEN_CACHE_MS && !isJwtExpired(cached.token.value, 30)) {
      return cached.token.value;
    }
    return (await this.captureToken())?.value;
  }

  async snapshot(): Promise<SessionSnapshot> {
    const [cookieCount] = await Promise.all([this.cookieCount(), this.token()]);
    return {
      cookieCount,
      token: this.cached?.token,
      verificationWindowOpen: isLive(this.verificationWindow)
    };
  }

  tokenExpiry(): Date | undefined {
    return this.cached ? jwtExpiry(this.cached.token.value) : undefined;
  }

  async openVerificationWindow(): Promise<void> {
    if (isLive(this.verificationWindow)) {
      this.verificationWindow.show();
      this.verificationWindow.focus();
      return;
    }

    const parent = this.parentWindow();
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 720,
      minHeight: 560,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: "Iwara",
      backgroundColor: "#111317",
      autoHideMenuBar: true,
      webPreferences: remoteWebPreferences(this.session)
    });
    hardenRemoteWindow(window);
    this.verificationWindow = window;
    window.on("closed", () => {
      this.stopCapturePolling();
      this.verificationWindow = undefined;
      if (this.cached) {
        this.notify();
      } else {
        // The user may have signed in and closed the window before the poll ran.
        void this.captureToken().finally(() => this.notify());
      }
    });

    this.notify();
    window.loadURL(IWARA_LOGIN).catch(() => undefined);
    this.startCapturePolling(window);
  }

  /** Re-runs a request inside a www.iwara.tv page, as the site itself would. */
  async pageFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<PageFetchResult> {
    const window = isLive(this.verificationWindow) ? this.verificationWindow : await this.ensureHelperWindow();
    const headers = Object.entries(init.headers).filter(([name]) => !FORBIDDEN_PAGE_FETCH_HEADERS.has(name.toLowerCase()));
    const payload = JSON.stringify({ url, method: init.method, headers, body: init.body ?? null });
    const result = await executeWithTimeout<{ status: number; headers: Array<[string, string]>; text: string }>(
      window,
      `(async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: request.body ?? undefined,
          credentials: "include",
          mode: "cors"
        });
        return { status: response.status, headers: Array.from(response.headers.entries()), text: await response.text() };
      })(${payload})`
    );
    this.touchHelper();
    return { status: result.status, headers: Object.fromEntries(result.headers), text: result.text };
  }

  /** Opens the video page hidden and records Iwara API responses via the DevTools protocol. */
  async captureVideoNetwork(idOrUrl: string): Promise<IwaraNetworkCapture> {
    const videoId = parseIwaraVideoId(idOrUrl);
    if (!videoId) {
      throw new AppError("INVALID_VIDEO_ID", "Not a recognizable Iwara video ID or link.");
    }
    const pageUrl = `https://www.iwara.tv/video/${videoId}`;
    const window = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: remoteWebPreferences(this.session) });
    hardenRemoteWindow(window);
    window.webContents.setAudioMuted(true);

    const entries = new Map<string, IwaraNetworkEntry>();
    let resolveFound: () => void = () => undefined;
    const found = new Promise<void>((resolve) => {
      resolveFound = resolve;
    });
    const debuggerApi = window.webContents.debugger;

    try {
      debuggerApi.attach("1.3");
      debuggerApi.on("message", (_event, method, params: Record<string, unknown>) => {
        void handleNetworkMessage(debuggerApi, entries, method, params).then((hasFormats) => {
          if (hasFormats) {
            resolveFound();
          }
        });
      });
      // Before the first navigation there is no renderer target yet: the
      // command takes effect on load but its promise never settles, so it
      // must not be awaited.
      debuggerApi.sendCommand("Network.enable").catch((error: unknown) => {
        entries.set("debugger", { url: pageUrl, method: "GET", formatLabels: [], error: errorMessage(error) });
      });
    } catch (error) {
      entries.set("debugger", { url: pageUrl, method: "GET", formatLabels: [], error: errorMessage(error) });
    }

    window.loadURL(pageUrl).catch(() => undefined);
    const timedOut = await Promise.race([
      found.then(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), NETWORK_CAPTURE_TIMEOUT_MS))
    ]);

    if (debuggerApi.isAttached()) {
      debuggerApi.detach();
    }
    window.destroy();
    return { pageUrl, entries: [...entries.values()], timedOut };
  }

  /** Clears cookies, storage and cache for the Iwara partition. */
  async signOut(): Promise<void> {
    this.stopCapturePolling();
    for (const window of [this.verificationWindow, this.helperWindow]) {
      if (isLive(window)) {
        window.destroy();
      }
    }
    this.verificationWindow = undefined;
    this.helperWindow = undefined;
    this.helperLoading = undefined;
    this.cached = undefined;
    await this.session.clearStorageData();
    await this.session.clearCache();
    this.notify();
  }

  dispose(): void {
    this.stopCapturePolling();
    clearTimeout(this.helperIdleTimer);
    for (const window of [this.verificationWindow, this.helperWindow]) {
      if (isLive(window)) {
        window.destroy();
      }
    }
  }

  private async cookieCount(): Promise<number> {
    const cookies = (await Promise.all(COOKIE_ORIGINS.map((url) => this.session.cookies.get({ url })))).flat();
    return new Set(cookies.map((cookie) => `${cookie.domain ?? ""}|${cookie.name}`)).size;
  }

  private captureToken(): Promise<CapturedToken | undefined> {
    this.capturing ??= this.captureTokenNow().finally(() => {
      this.capturing = undefined;
    });
    return this.capturing;
  }

  private async captureTokenNow(): Promise<CapturedToken | undefined> {
    const previous = this.cached?.token;
    let target: BrowserWindow | undefined = isLive(this.verificationWindow) ? this.verificationWindow : undefined;
    if (!target) {
      if (!isLive(this.helperWindow) && (await this.cookieCount()) === 0) {
        this.cached = undefined;
        return undefined;
      }
      try {
        target = await this.ensureHelperWindow();
      } catch {
        return previous && !isJwtExpired(previous.value, 0) ? previous : undefined;
      }
    }

    let token = await readStorageToken(target);
    if (token === null) {
      // The page couldn't be read (still loading or challenged); keep a valid previous token.
      return previous && !isJwtExpired(previous.value, 0) ? previous : undefined;
    }
    if (token && isJwtExpired(token.value, 30) && target === this.helperWindow) {
      // Let the site refresh its access token, then read again.
      await loadAndWait(target, IWARA_HOME);
      token = (await readStorageToken(target)) ?? undefined;
    }

    this.cached = token ? { token, checkedAt: Date.now() } : undefined;
    if (previous?.value !== token?.value) {
      this.notify();
    }
    return token;
  }

  private ensureHelperWindow(): Promise<BrowserWindow> {
    if (isLive(this.helperWindow)) {
      this.touchHelper();
      return Promise.resolve(this.helperWindow);
    }
    this.helperLoading ??= (async () => {
      const window = new BrowserWindow({ show: false, width: 960, height: 640, webPreferences: remoteWebPreferences(this.session) });
      hardenRemoteWindow(window);
      window.webContents.setAudioMuted(true);
      window.on("closed", () => {
        if (this.helperWindow === window) {
          this.helperWindow = undefined;
        }
      });
      await loadAndWait(window, IWARA_HOME);
      this.helperWindow = window;
      this.touchHelper();
      return window;
    })().finally(() => {
      this.helperLoading = undefined;
    });
    return this.helperLoading;
  }

  /** The hidden helper page runs Iwara's site scripts; close it when unused. */
  private touchHelper(): void {
    clearTimeout(this.helperIdleTimer);
    this.helperIdleTimer = setTimeout(() => {
      if (isLive(this.helperWindow)) {
        this.helperWindow.destroy();
      }
      this.helperWindow = undefined;
    }, HELPER_IDLE_MS);
  }

  private startCapturePolling(window: BrowserWindow): void {
    this.stopCapturePolling();
    const poll = async () => {
      if (!isLive(window)) {
        return;
      }
      const token = await readStorageToken(window);
      if (token) {
        this.cached = { token, checkedAt: Date.now() };
        this.notify();
        this.stopCapturePolling();
        setTimeout(() => {
          if (isLive(window)) {
            window.close();
          }
        }, 800);
        return;
      }
      this.capturePollTimer = setTimeout(() => void poll(), CAPTURE_POLL_MS);
    };
    this.capturePollTimer = setTimeout(() => void poll(), CAPTURE_POLL_MS);
  }

  private stopCapturePolling(): void {
    clearTimeout(this.capturePollTimer);
    this.capturePollTimer = undefined;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function isLive(window: BrowserWindow | undefined): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed());
}

function remoteWebPreferences(session: Session): Electron.WebPreferences {
  return {
    session,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false
  };
}

/** Keeps remote windows on Iwara; everything else opens in the system browser. */
function hardenRemoteWindow(window: BrowserWindow): void {
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isIwaraUrl(url)) {
      void window.loadURL(url).catch(() => undefined);
    } else if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isIwaraUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

async function loadAndWait(window: BrowserWindow, url: string): Promise<void> {
  await Promise.race([
    window.loadURL(url).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, PAGE_LOAD_TIMEOUT_MS))
  ]);
}

function executeWithTimeout<T>(window: BrowserWindow, script: string): Promise<T> {
  return Promise.race([
    window.webContents.executeJavaScript(script, true) as Promise<T>,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new AppError("NETWORK_ERROR", "The Iwara page did not respond in time.")), SCRIPT_TIMEOUT_MS)
    )
  ]);
}

const STORAGE_DUMP_SCRIPT = `(() => {
  const dump = (storage) => {
    const entries = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) entries[key] = storage.getItem(key);
    }
    return entries;
  };
  return { localStorage: dump(window.localStorage), sessionStorage: dump(window.sessionStorage) };
})()`;

/** Returns the token, `undefined` when signed out, or `null` when the page can't be read. */
async function readStorageToken(window: BrowserWindow): Promise<CapturedToken | undefined | null> {
  try {
    if (!isIwaraUrl(window.webContents.getURL())) {
      return null;
    }
    return findToken(await executeWithTimeout<StorageDump>(window, STORAGE_DUMP_SCRIPT));
  } catch {
    return null;
  }
}

async function handleNetworkMessage(
  debuggerApi: Electron.Debugger,
  entries: Map<string, IwaraNetworkEntry>,
  method: string,
  params: Record<string, unknown>
): Promise<boolean> {
  const requestId = typeof params.requestId === "string" ? params.requestId : "";
  if (!requestId) {
    return false;
  }

  if (method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string; method?: string; headers?: Record<string, unknown> } | undefined;
    if (!request?.url || !isApiHost(request.url) || request.method === "OPTIONS") {
      return false;
    }
    const header = (name: string) => {
      const found = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === name);
      return typeof found?.[1] === "string" ? found[1] : undefined;
    };
    entries.set(requestId, {
      url: safeUrl(request.url),
      method: request.method ?? "GET",
      formatLabels: [],
      xVersion: header("x-version"),
      hasAuthorization: Boolean(header("authorization"))
    });
    return false;
  }

  const current = entries.get(requestId);
  if (!current) {
    return false;
  }

  if (method === "Network.responseReceived") {
    const response = params.response as { status?: number; mimeType?: string } | undefined;
    current.status = response?.status;
    current.resourceType = typeof params.type === "string" ? params.type : response?.mimeType;
    return false;
  }

  if (method === "Network.loadingFinished") {
    try {
      const body = (await Promise.race([
        debuggerApi.sendCommand("Network.getResponseBody", { requestId }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Timed out reading the response body.")), 5000))
      ])) as { body?: string; base64Encoded?: boolean };
      if (!body.body || body.base64Encoded) {
        return false;
      }
      const summary = summarizeJsonResponse(body.body);
      current.formatLabels = summary.formatLabels;
      current.formats = summary.formats;
      current.responseShape = summary.responseShape;
      return summary.formatLabels.length > 0;
    } catch (error) {
      current.error = errorMessage(error);
    }
  }
  return false;
}

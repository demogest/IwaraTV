import { BrowserWindow, session, shell } from "electron";
import type { AuthState } from "../../shared/types";

const IWARA_HOME = "https://www.iwara.tv/";
const IWARA_ORIGINS = ["https://www.iwara.tv/", "https://api.iwara.tv/", "https://files.iwara.tv/"];

export class IwaraSessionService {
  private verificationWindow?: BrowserWindow;
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

  async token(): Promise<string | undefined> {
    return (await this.captureToken())?.value;
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
}

interface StorageDump {
  localStorage?: Record<string, string | null>;
  sessionStorage?: Record<string, string | null>;
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

import { BrowserWindow, session, shell } from "electron";
import type { AuthState } from "../../shared/types";

const IWARA_HOME = "https://www.iwara.tv/";
const IWARA_ORIGINS = ["https://www.iwara.tv/", "https://api.iwara.tv/", "https://files.iwara.tv/"];

export class IwaraSessionService {
  private verificationWindow?: BrowserWindow;

  constructor() {
    const browserUserAgent = session.defaultSession.getUserAgent().replace(/\sElectron\/\S+/i, "");
    session.defaultSession.setUserAgent(browserUserAgent, "zh-CN,zh;q=0.9,en;q=0.8");
  }

  async openVerificationWindow(parent?: BrowserWindow): Promise<Pick<AuthState, "siteSessionReady" | "siteCookieCount" | "browserUserAgent">> {
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
    });

    await this.verificationWindow.loadURL(IWARA_HOME);
    return this.state();
  }

  async state(): Promise<Pick<AuthState, "siteSessionReady" | "siteCookieCount" | "browserUserAgent">> {
    const cookies = await this.iwaraCookies();
    return {
      siteSessionReady: cookies.length > 0,
      siteCookieCount: cookies.length,
      browserUserAgent: session.defaultSession.getUserAgent()
    };
  }

  async headersFor(url: string): Promise<Record<string, string>> {
    const cookieHeader = await this.cookieHeaderFor(url);
    return {
      "User-Agent": session.defaultSession.getUserAgent(),
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
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

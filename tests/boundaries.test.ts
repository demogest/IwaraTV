// Static checks that keep the process boundaries and Electron hardening intact.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/shared/csp";

const root = path.resolve(__dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!
  );
}

const relative = (file: string) => path.relative(root, file);

describe("process boundaries", () => {
  it("keeps the renderer free of Node and Electron", () => {
    const offenders = sourceFiles(path.join(root, "src/renderer")).flatMap((file) =>
      imports(file)
        .filter((specifier) => /^(node:|electron$|fs$|path$|child_process$|os$)/.test(specifier) || specifier.includes("/main/") || specifier.includes("/preload/"))
        .map((specifier) => `${relative(file)} → ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it("keeps shared code platform-neutral", () => {
    const offenders = sourceFiles(path.join(root, "src/shared")).flatMap((file) =>
      imports(file)
        .filter((specifier) => !specifier.startsWith("./"))
        .map((specifier) => `${relative(file)} → ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it("limits the preload script to Electron and the IPC contract", () => {
    const preload = sourceFiles(path.join(root, "src/preload"));
    expect(preload.map(relative)).toEqual(["src/preload/index.ts"]);
    expect(imports(preload[0]!).sort()).toEqual(["../shared/ipc", "electron"]);
    const source = readFileSync(preload[0]!, "utf8");
    expect(source).toContain("isInvokeChannel(channel)");
    expect(source).toContain("isEventChannel(channel)");
    // The raw ipcRenderer must never reach the page.
    expect(source).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
  });

  it("keeps Electron out of the unit-testable backend modules", () => {
    const testable = [
      "src/main/backend.ts",
      "src/main/ipc-handlers.ts",
      ...sourceFiles(path.join(root, "src/main/lib")).map(relative),
      ...["download-manager", "favorite-store", "iwara-client", "player-service", "settings-store"].map((name) => `src/main/services/${name}.ts`)
    ];
    for (const file of testable) {
      expect(imports(path.join(root, file)), file).not.toContain("electron");
    }
  });

  it("has no Tauri leftovers", () => {
    expect(existsSync(path.join(root, "src-tauri"))).toBe(false);
    const pkg = readFileSync(path.join(root, "package.json"), "utf8");
    expect(pkg).not.toMatch(/tauri/i);
    const offenders = [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "tests"))]
      .filter((file) => !file.endsWith("boundaries.test.ts"))
      .filter((file) => /@tauri-apps|__TAURI__/.test(readFileSync(file, "utf8")));
    expect(offenders.map(relative)).toEqual([]);
  });
});

describe("Electron hardening", () => {
  const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
  const session = readFileSync(path.join(root, "src/main/services/iwara-session.ts"), "utf8");

  it("sandboxes the app window", () => {
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/webSecurity:\s*true/);
    expect(main).toMatch(/devTools:\s*!app\.isPackaged/);
  });

  it("never weakens web preferences anywhere", () => {
    for (const file of sourceFiles(path.join(root, "src/main"))) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(file)).not.toMatch(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/);
      expect(source, relative(file)).not.toMatch(/allowRunningInsecureContent|webviewTag:\s*true|nodeIntegrationInSubFrames|experimentalFeatures/);
      expect(source, relative(file)).not.toMatch(/enableRemoteModule|@electron\/remote/);
    }
  });

  it("denies permissions, popups and foreign navigation", () => {
    for (const source of [main, session]) {
      expect(source).toContain("setPermissionRequestHandler");
      expect(source).toContain("setPermissionCheckHandler");
      expect(source).toContain("setWindowOpenHandler");
      expect(source).toMatch(/action:\s*"deny"/);
      expect(source).toContain('"will-navigate"');
    }
    expect(main).toContain("requestSingleInstanceLock");
    expect(main).toContain("isTrustedSender");
  });

  it("gives remote Iwara windows no preload and the isolated Iwara session", () => {
    const remoteWindows = [...session.matchAll(/new BrowserWindow\(\{[\s\S]*?\n {2,6}\}\);/g)].map((match) => match[0]);
    expect(remoteWindows.length).toBeGreaterThan(0);
    for (const block of remoteWindows) {
      expect(block).not.toContain("preload");
      expect(block).toContain("webPreferences: remoteWebPreferences(this.session)");
    }
    const preferences = session.slice(session.indexOf("function remoteWebPreferences"), session.indexOf("function hardenRemoteWindow"));
    expect(preferences).toMatch(/sandbox:\s*true/);
    expect(preferences).toMatch(/contextIsolation:\s*true/);
    expect(preferences).toMatch(/nodeIntegration:\s*false/);
    expect(preferences).not.toContain("preload");
    expect(session).toContain('IWARA_PARTITION = "persist:iwara"');
  });

  it("keeps hidden Iwara windows from opening the browser and blocks off-site redirects", () => {
    expect(session.match(/hardenRemoteWindow\(window, \{ forwardLinks: (true|false) \}\)/g)).toEqual([
      "hardenRemoteWindow(window, { forwardLinks: true })",
      "hardenRemoteWindow(window, { forwardLinks: false })",
      "hardenRemoteWindow(window, { forwardLinks: false })"
    ]);
    expect(session).toContain('"will-redirect"');
    // The token is stripped from any main-process request that leaves iwara.tv, including redirects.
    expect(session).toContain('withoutHeader(details.requestHeaders, "authorization")');
  });

  it("only opens http(s) links in the system browser", () => {
    for (const source of [main, session]) {
      for (const match of source.matchAll(/shell\.openExternal\(([^)]*)\)/g)) {
        const index = match.index!;
        const context = source.slice(Math.max(0, index - 200), index);
        expect(context, match[0]).toMatch(/https\?:/);
      }
    }
  });

  it("ships a strict content security policy", () => {
    const policy = contentSecurityPolicy({ dev: false });
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("base-uri 'none'");
    expect(contentSecurityPolicy({ dev: true })).not.toContain("unsafe-eval");
  });
});

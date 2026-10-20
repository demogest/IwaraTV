import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateSettings, UpdateState } from "../src/shared/types";
import type { HttpFetch } from "../src/main/lib/http";
import { compareVersions, isMajorUpgrade, isNewerVersion, parseVersion } from "../src/main/lib/semver";
import {
  assetFileName,
  assetKeyFor,
  folderSource,
  GITHUB_SOURCE,
  MAX_UPDATE_BYTES,
  parseManifest,
  UPDATE_ASSET_KEYS,
  verifyManifestSignature,
  type UpdateAssetKey
} from "../src/main/lib/update-manifest";
import { createInstaller, detectInstallKind, replaceAppImage, resolveUpdateEnvironment, type InstallContext } from "../src/main/lib/update-install";
import { UpdateService, type UpdateEnvironment } from "../src/main/services/update-service";
import { SettingsStore } from "../src/main/services/settings-store";
import { tempDir } from "./helpers";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function keyPair() {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function manifestFor(version: string, files: Partial<Record<UpdateAssetKey, Uint8Array>>, extra: Record<string, unknown> = {}) {
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    publishedAt: "2026-11-02T10:00:00Z",
    breaking: false,
    notes: "## What's new\n\n- Things",
    assets: Object.fromEntries(Object.entries(files).map(([key, data]) => [
      key,
      { name: assetFileName(key as UpdateAssetKey, version), size: data!.byteLength, sha256: sha256(data!) }
    ])),
    ...extra
  };
}

describe("semver", () => {
  it("parses versions with an optional v prefix", () => {
    expect(parseVersion("v2.1.0")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: [] });
    expect(parseVersion("2.1.0-beta.2+build.5")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: ["beta", 2] });
    expect(parseVersion("2.1")).toBeUndefined();
    expect(parseVersion("02.1.0")).toBeUndefined();
  });

  it("orders versions like semver.org", () => {
    const sorted = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "2.0.0", "1.10.0"]
      .sort(compareVersions);
    expect(sorted).toEqual(["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.10.0", "2.0.0"]);
  });

  it("only treats strictly newer versions as updates", () => {
    expect(isNewerVersion("2.0.1", "2.0.0")).toBe(true);
    expect(isNewerVersion("2.0.0", "2.0.0")).toBe(false);
    expect(isNewerVersion("1.9.9", "2.0.0")).toBe(false);
    expect(isNewerVersion("2.1.0-rc.1", "2.1.0")).toBe(false);
    expect(isNewerVersion("garbage", "2.0.0")).toBe(false);
    expect(isMajorUpgrade("3.0.0", "2.9.1")).toBe(true);
    expect(isMajorUpgrade("2.9.1", "2.0.0")).toBe(false);
  });
});

describe("update manifest", () => {
  const files = { "win32-x64-nsis": new Uint8Array([1, 2, 3]), "linux-x64-deb": new Uint8Array([4, 5]) };

  it("accepts a valid manifest and ignores unknown fields and asset keys", () => {
    const raw = manifestFor("2.1.0", files, { future: true });
    (raw.assets as Record<string, unknown>)["linux-riscv64-tar"] = { name: "x", size: 1, sha256: "0".repeat(64) };
    const manifest = parseManifest(JSON.stringify(raw));
    expect(manifest).toMatchObject({ version: "2.1.0", tag: "v2.1.0", breaking: false, publishedAt: "2026-11-02T10:00:00.000Z" });
    expect(Object.keys(manifest.assets).sort()).toEqual(["linux-x64-deb", "win32-x64-nsis"]);
    expect(manifest).not.toHaveProperty("future");
  });

  it.each([
    ["not JSON", "{"],
    ["another schema", JSON.stringify({ ...manifestFor("2.1.0", files), schema: 2 })],
    ["a tag that doesn't match", JSON.stringify({ ...manifestFor("2.1.0", files), tag: "v9.9.9" })],
    ["a v-prefixed version", JSON.stringify({ ...manifestFor("2.1.0", files), version: "v2.1.0" })],
    ["no breaking flag", JSON.stringify({ ...manifestFor("2.1.0", files), breaking: "no" })],
    ["no assets", JSON.stringify({ ...manifestFor("2.1.0", files), assets: [] })]
  ])("rejects %s", (_name, text) => {
    expect(() => parseManifest(text)).toThrow(expect.objectContaining({ code: "UPDATE_INVALID" }));
  });

  it("rejects file entries that could point elsewhere or exhaust the disk", () => {
    const base = manifestFor("2.1.0", files);
    const withAsset = (asset: Record<string, unknown>) => JSON.stringify({ ...base, assets: { "win32-x64-nsis": asset } });
    const good = base.assets["win32-x64-nsis"] as Record<string, unknown>;
    for (const name of ["../IwaraTV_2.1.0_x64-setup.exe", "https://evil.example/IwaraTV_2.1.0_x64-setup.exe", "IwaraTV_2.0.0_x64-setup.exe", "IwaraTV_2.1.0_x64-portable.exe"]) {
      expect(() => parseManifest(withAsset({ ...good, name })), name).toThrow(/unexpected name/);
    }
    expect(() => parseManifest(withAsset({ ...good, size: MAX_UPDATE_BYTES + 1 }))).toThrow(/invalid size/);
    expect(() => parseManifest(withAsset({ ...good, size: 1.5 }))).toThrow(/invalid size/);
    expect(() => parseManifest(withAsset({ ...good, sha256: "ABC" }))).toThrow(/invalid checksum/);
  });

  it("verifies Ed25519 signatures over the exact bytes", () => {
    const { publicKey, privateKey } = keyPair();
    const bytes = Buffer.from(JSON.stringify(manifestFor("2.1.0", files)));
    const signature = sign(null, bytes, privateKey).toString("base64");
    expect(verifyManifestSignature(bytes, `${signature}\n`, publicKey)).toBe(true);
    expect(verifyManifestSignature(Buffer.concat([bytes, Buffer.from(" ")]), signature, publicKey)).toBe(false);
    expect(verifyManifestSignature(bytes, signature, keyPair().publicKey)).toBe(false);
    expect(verifyManifestSignature(bytes, "not base64!", publicKey)).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    expect(verifyManifestSignature(bytes, sign("sha256", bytes, rsa.privateKey).toString("base64"), rsa.publicKey)).toBe(false);
  });

  it("maps install types to the files the release job builds", () => {
    expect(assetKeyFor("nsis", "win32", "x64")).toBe("win32-x64-nsis");
    expect(assetKeyFor("nsis", "win32", "arm64")).toBeUndefined();
    expect(assetKeyFor("archive", "win32", "x64")).toBe("win32-x64-zip");
    expect(assetKeyFor("archive", "linux", "x64")).toBeUndefined();
    expect(assetKeyFor("appimage", "linux", "x64")).toBe("linux-x64-appimage");
    expect(assetKeyFor("dmg", "darwin", "arm64")).toBe("darwin-arm64-dmg");
    expect(assetKeyFor("dmg", "darwin", "x64")).toBeUndefined();
    expect(assetKeyFor("dev", "linux", "x64")).toBeUndefined();
  });

  it("builds download URLs from the tag and name only", () => {
    expect(GITHUB_SOURCE.manifestUrl).toBe("https://github.com/demogest/IwaraTV/releases/latest/download/update.json");
    expect(GITHUB_SOURCE.fileUrl("v2.1.0", "IwaraTV_2.1.0_amd64.deb")).toBe("https://github.com/demogest/IwaraTV/releases/download/v2.1.0/IwaraTV_2.1.0_amd64.deb");
    const local = folderSource("http://127.0.0.1:9000/updates");
    expect(local.manifestUrl).toBe("http://127.0.0.1:9000/updates/update.json");
    expect(local.fileUrl("v2.1.0", "update.json.sig")).toBe("http://127.0.0.1:9000/updates/update.json.sig");
    expect(() => folderSource("file:///tmp/updates")).toThrow();
  });
});

// --- UpdateService -----------------------------------------------------------------

interface Served {
  [url: string]: Uint8Array | string | number;
}

function fakeFetch(served: Served) {
  const requests: string[] = [];
  const fetch = vi.fn<HttpFetch>(async (url) => {
    requests.push(url);
    const body = served[url];
    if (body === undefined) {
      return new Response("missing", { status: 404 });
    }
    if (typeof body === "number") {
      return new Response("error", { status: body });
    }
    return new Response(typeof body === "string" ? body : new Uint8Array(body));
  });
  return { fetch, requests };
}

function setup(options: {
  served: Served;
  environment?: Partial<UpdateEnvironment>;
  settings?: Partial<UpdateSettings>;
}) {
  const directory = tempDir("updates");
  const environment: UpdateEnvironment = {
    currentVersion: "2.0.0",
    installKind: "nsis",
    assetKey: "win32-x64-nsis",
    strategy: "automatic",
    downloadDirectory: directory,
    ownsDownloadDirectory: true,
    source: folderSource("https://updates.test/"),
    ...options.environment
  };
  let settings: UpdateSettings = { autoCheck: true, autoDownload: true, ...options.settings };
  const states: UpdateState[] = [];
  const install = vi.fn(async (_filePath: string) => undefined);
  const { fetch, requests } = fakeFetch(options.served);
  const service = new UpdateService({
    environment,
    fetch,
    settings: { get: () => settings, update: (patch) => (settings = { ...settings, ...patch }) },
    install,
    emit: (state) => states.push(state),
    now: () => new Date("2026-11-03T00:00:00Z")
  });
  return { service, directory, states, install, fetch, requests, settings: () => settings };
}

async function settled(service: UpdateService): Promise<UpdateState> {
  await vi.waitFor(() => expect(["downloading", "checking"]).not.toContain(service.getState().status));
  return service.getState();
}

describe("UpdateService", () => {
  const installer = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 251));
  const served = (manifest: object, extra: Served = {}): Served => ({
    "https://updates.test/update.json": JSON.stringify(manifest),
    "https://updates.test/IwaraTV_2.1.0_x64-setup.exe": installer,
    ...extra
  });

  it("reports up to date when the latest release has no manifest", async () => {
    const { service, settings } = setup({ served: {} });
    expect(service.getState()).toMatchObject({ status: "idle", strategy: "automatic", signedOnly: false });
    expect(await service.check()).toMatchObject({ status: "up-to-date", checkedAt: "2026-11-03T00:00:00.000Z" });
    expect(settings().lastCheckedAt).toBe("2026-11-03T00:00:00.000Z");
  });

  it("reports HTTP failures from the manifest request", async () => {
    const { service } = setup({ served: { "https://updates.test/update.json": 503 } });
    expect(await service.check()).toMatchObject({ status: "error", error: { code: "UPDATE_CHECK_FAILED" } });
  });

  it("downloads a newer non-breaking release in the background and installs the verified file", async () => {
    const { service, directory, install, states } = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })) });
    const checked = await service.check();
    expect(checked.update).toMatchObject({ version: "2.1.0", breaking: false, skipped: false, fileName: "IwaraTV_2.1.0_x64-setup.exe", size: 4096 });
    const state = await settled(service);
    expect(state.status).toBe("ready");
    expect(states.map((entry) => entry.status)).toEqual(expect.arrayContaining(["checking", "available", "downloading", "ready"]));
    const file = path.join(directory, "IwaraTV_2.1.0_x64-setup.exe");
    expect(sha256(readFileSync(file))).toBe(sha256(installer));
    expect(readdirSync(directory)).toEqual(["IwaraTV_2.1.0_x64-setup.exe"]);

    await service.install();
    expect(install).toHaveBeenCalledWith(file);
  });

  it("never downloads breaking, skipped or opted-out updates by itself", async () => {
    const breaking = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer }, { breaking: true })) });
    expect((await breaking.service.check()).update?.breaking).toBe(true);

    const major = setup({
      served: {
        "https://updates.test/update.json": JSON.stringify(manifestFor("3.0.0", { "win32-x64-nsis": installer })),
        "https://updates.test/IwaraTV_3.0.0_x64-setup.exe": installer
      }
    });
    expect((await major.service.check()).update?.breaking).toBe(true);

    const skipped = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })), settings: { skippedVersion: "2.1.0" } });
    expect((await skipped.service.check()).update?.skipped).toBe(true);

    const optedOut = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })), settings: { autoDownload: false } });
    await optedOut.service.check();

    for (const { service, requests } of [breaking, major, skipped, optedOut]) {
      expect(service.getState().status).toBe("available");
      expect(requests.some((url) => url.endsWith(".exe"))).toBe(false);
    }

    // The user can still choose to download.
    expect(await skipped.service.download()).toMatchObject({ status: "ready" });
  });

  it("assisted installs wait for the user", async () => {
    const { service, requests } = setup({
      served: served(manifestFor("2.1.0", { "linux-x64-deb": installer }), { "https://updates.test/IwaraTV_2.1.0_amd64.deb": installer }),
      environment: { installKind: "deb", assetKey: "linux-x64-deb", strategy: "assisted", ownsDownloadDirectory: false }
    });
    expect(await service.check()).toMatchObject({ status: "available", strategy: "assisted" });
    expect(requests).toHaveLength(1);
    expect(await service.download()).toMatchObject({ status: "ready" });
  });

  it("deletes downloads that don't match the manifest", async () => {
    const tampered = new Uint8Array(installer);
    tampered[100] = 0;
    const { service, directory } = setup({
      served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer }), { "https://updates.test/IwaraTV_2.1.0_x64-setup.exe": tampered })
    });
    await service.check();
    const state = await settled(service);
    expect(state).toMatchObject({ status: "error", error: { code: "UPDATE_INVALID" }, update: { version: "2.1.0" } });
    expect(readdirSync(directory)).toEqual([]);
    await expect(service.install()).rejects.toMatchObject({ code: "UPDATE_INVALID" });
  });

  it("stops a download that grows past the manifest's size", async () => {
    const { service, directory } = setup({
      served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer }), {
        "https://updates.test/IwaraTV_2.1.0_x64-setup.exe": new Uint8Array(installer.byteLength * 4)
      })
    });
    await service.check();
    expect(await settled(service)).toMatchObject({ status: "error", error: { message: expect.stringMatching(/larger than expected/) } });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("requires a valid signature when a public key is pinned", async () => {
    const { publicKey, privateKey } = keyPair();
    const manifest = JSON.stringify(manifestFor("2.1.0", { "win32-x64-nsis": installer }));
    const signature = sign(null, Buffer.from(manifest), privateKey).toString("base64");

    const unsigned = setup({ served: served(JSON.parse(manifest)), environment: { publicKey } });
    expect(unsigned.service.getState().signedOnly).toBe(true);
    expect(await unsigned.service.check()).toMatchObject({ status: "error", error: { code: "UPDATE_INVALID", message: expect.stringMatching(/isn't signed/) } });

    const forged = setup({
      served: { "https://updates.test/update.json": manifest, "https://updates.test/update.json.sig": sign(null, Buffer.from(manifest), keyPair().privateKey).toString("base64") },
      environment: { publicKey }
    });
    expect(await forged.service.check()).toMatchObject({ status: "error", error: { message: expect.stringMatching(/signature/) } });
    expect(forged.requests.some((url) => url.endsWith(".exe"))).toBe(false);

    const signed = setup({
      served: { ...served({}), "https://updates.test/update.json": manifest, "https://updates.test/update.json.sig": `${signature}\n` },
      environment: { publicKey }
    });
    await signed.service.check();
    expect(await settled(signed.service)).toMatchObject({ status: "ready" });
  });

  it("offers no downgrades and prunes old files from its own folder", async () => {
    const { service, directory } = setup({ served: served(manifestFor("2.0.0", { "win32-x64-nsis": installer })) });
    writeFileSync(path.join(directory, "IwaraTV_1.9.0_x64-setup.exe"), "old");
    writeFileSync(path.join(directory, "notes.txt"), "keep");
    expect(await service.check()).toMatchObject({ status: "up-to-date" });
    expect(readdirSync(directory)).toEqual(["notes.txt"]);
  });

  it("reuses a file that was already downloaded and re-checks it before installing", async () => {
    const { service, directory, requests, install } = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })) });
    const file = path.join(directory, "IwaraTV_2.1.0_x64-setup.exe");
    writeFileSync(file, installer);
    expect(await service.check()).toMatchObject({ status: "ready" });
    expect(requests).toEqual(["https://updates.test/update.json"]);

    writeFileSync(file, "swapped after the download");
    await expect(service.install()).rejects.toMatchObject({ code: "UPDATE_INVALID" });
    expect(install).not.toHaveBeenCalled();
    expect(service.getState().status).toBe("available");
  });

  it("keeps the last result when a background check fails", async () => {
    const { service, fetch } = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })), settings: { autoDownload: false } });
    await service.check();
    fetch.mockRejectedValue(new Error("offline"));
    expect(await service.check({ background: true })).toMatchObject({ status: "available", update: { version: "2.1.0" } });
    expect(await service.check()).toMatchObject({ status: "error", error: { message: "offline" } });
  });

  it("points to the release page when there is no file for this install", async () => {
    const { service } = setup({
      served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })),
      environment: { installKind: "dev", assetKey: undefined, strategy: "none" }
    });
    expect(service.getState().strategy).toBe("none");
    expect(await service.check()).toMatchObject({ status: "available", strategy: "none", update: { releaseUrl: "https://github.com/demogest/IwaraTV/releases/tag/v2.1.0" } });
    expect(service.getState().update?.fileName).toBeUndefined();
    await expect(service.download()).rejects.toMatchObject({ code: "UPDATE_INVALID" });
  });

  it("remembers a skipped version", async () => {
    const { service, settings } = setup({ served: served(manifestFor("2.1.0", { "win32-x64-nsis": installer })), settings: { autoDownload: false } });
    await service.check();
    expect(service.skip("2.1.0").update?.skipped).toBe(true);
    expect(settings().skippedVersion).toBe("2.1.0");
  });

  it("checks on a schedule only while automatic checks are on", async () => {
    vi.useFakeTimers();
    try {
      const { service, requests, settings } = setup({ served: {}, settings: { autoCheck: false } });
      service.start(20_000, 60_000);
      await vi.advanceTimersByTimeAsync(80_000);
      expect(requests).toEqual([]);
      (settings() as UpdateSettings).autoCheck = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toEqual(["https://updates.test/update.json"]);
      service.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- Install types ------------------------------------------------------------------

function context(overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    isPackaged: true,
    platform: "linux",
    arch: "x64",
    execPath: "/opt/IwaraTV/iwaratv",
    env: {},
    version: "2.0.0",
    paths: { userData: "/home/u/.config/IwaraTV", downloads: "/home/u/Downloads", temp: "/tmp" },
    exists: () => false,
    writable: () => true,
    ...overrides
  };
}

describe("install types", () => {
  it("detects how the app was installed", () => {
    expect(detectInstallKind(context({ isPackaged: false }))).toBe("dev");
    expect(detectInstallKind(context({ isPackaged: false, env: { IWARATV_UPDATE_INSTALL_KIND: "appimage" } }))).toBe("appimage");
    expect(detectInstallKind(context({ isPackaged: false, env: { IWARATV_UPDATE_INSTALL_KIND: "bogus" } }))).toBe("dev");
    // The override is ignored in packaged builds.
    expect(detectInstallKind(context({ env: { IWARATV_UPDATE_INSTALL_KIND: "nsis" } }))).toBe("deb");
    expect(detectInstallKind(context({ platform: "darwin" }))).toBe("dmg");
    expect(detectInstallKind(context({ platform: "win32", execPath: "C:\\Users\\u\\AppData\\Local\\Programs\\IwaraTV\\IwaraTV.exe", exists: (file) => file.endsWith("\\Uninstall IwaraTV.exe") }))).toBe("nsis");
    expect(detectInstallKind(context({ platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "D:\\IwaraTV.exe" } }))).toBe("portable");
    expect(detectInstallKind(context({ platform: "win32", execPath: "D:\\Apps\\IwaraTV\\IwaraTV.exe" }))).toBe("archive");
    expect(detectInstallKind(context({ env: { APPIMAGE: "/home/u/Apps/IwaraTV_2.0.0_x86_64.AppImage" } }))).toBe("appimage");
    expect(detectInstallKind(context({ execPath: "/usr/lib/iwaratv/iwaratv" }))).toBe("archive");
  });

  it("chooses where updates are downloaded and how they're applied", () => {
    const source = GITHUB_SOURCE;
    expect(resolveUpdateEnvironment(context(), { source })).toMatchObject({
      installKind: "deb", assetKey: "linux-x64-deb", strategy: "assisted", downloadDirectory: "/home/u/Downloads", ownsDownloadDirectory: false
    });
    expect(resolveUpdateEnvironment(context({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      exists: () => true
    }), { source })).toMatchObject({ installKind: "nsis", strategy: "automatic", ownsDownloadDirectory: true, downloadDirectory: path.join("C:\\Users\\u\\AppData\\Local", "IwaraTV-updates") });
    expect(resolveUpdateEnvironment(context({ env: { APPIMAGE: "/home/u/Apps/IwaraTV.AppImage" } }), { source }))
      .toMatchObject({ strategy: "automatic", downloadDirectory: "/home/u/Apps" });
    expect(resolveUpdateEnvironment(context({ env: { APPIMAGE: "/opt/apps/IwaraTV.AppImage" }, writable: () => false }), { source }))
      .toMatchObject({ strategy: "assisted", downloadDirectory: "/home/u/Downloads" });
    expect(resolveUpdateEnvironment(context({ platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "D:\\x.exe", PORTABLE_EXECUTABLE_DIR: "D:\\Apps" } }), { source }))
      .toMatchObject({ installKind: "portable", strategy: "assisted", downloadDirectory: "D:\\Apps" });
    expect(resolveUpdateEnvironment(context({ isPackaged: false }), { source, publicKey: "pem" }))
      .toMatchObject({ installKind: "dev", strategy: "none", assetKey: undefined, downloadDirectory: path.join("/home/u/.config/IwaraTV", "updates"), ownsDownloadDirectory: true, publicKey: "pem" });
    // An install type the release job doesn't build for this architecture gets no file.
    expect(resolveUpdateEnvironment(context({ arch: "arm64" }), { source })).toMatchObject({ assetKey: undefined, strategy: "none" });
  });

  function deps() {
    return {
      spawnDetached: vi.fn(async (_command: string, _args: string[]) => undefined),
      relaunch: vi.fn(),
      quit: vi.fn(),
      openPath: vi.fn(async (_filePath: string) => undefined),
      showItemInFolder: vi.fn()
    };
  }

  it("runs the NSIS installer silently and quits", async () => {
    const ctx = context({ platform: "win32", exists: () => true });
    const calls = deps();
    await createInstaller(resolveUpdateEnvironment(ctx, { source: GITHUB_SOURCE }), ctx, calls)("C:\\updates\\IwaraTV_2.1.0_x64-setup.exe");
    expect(calls.spawnDetached).toHaveBeenCalledWith("C:\\updates\\IwaraTV_2.1.0_x64-setup.exe", ["--updated", "/S", "--force-run"]);
    expect(calls.quit).toHaveBeenCalled();
  });

  it("hands assisted updates to the system and never installs from development builds", async () => {
    const deb = context();
    const debCalls = deps();
    await createInstaller(resolveUpdateEnvironment(deb, { source: GITHUB_SOURCE }), deb, debCalls)("/home/u/Downloads/IwaraTV_2.1.0_amd64.deb");
    expect(debCalls.openPath).toHaveBeenCalledWith("/home/u/Downloads/IwaraTV_2.1.0_amd64.deb");
    expect(debCalls.quit).not.toHaveBeenCalled();

    const zip = context({ platform: "win32" });
    const zipCalls = deps();
    await createInstaller(resolveUpdateEnvironment(zip, { source: GITHUB_SOURCE }), zip, zipCalls)("D:\\Downloads\\IwaraTV_2.1.0_x64-unpacked.zip");
    expect(zipCalls.showItemInFolder).toHaveBeenCalled();

    const dev = context({ isPackaged: false, env: { IWARATV_UPDATE_INSTALL_KIND: "nsis" }, platform: "win32" });
    const devCalls = deps();
    await createInstaller(resolveUpdateEnvironment(dev, { source: GITHUB_SOURCE }), dev, devCalls)("C:\\x.exe");
    expect(devCalls.spawnDetached).not.toHaveBeenCalled();
    expect(devCalls.showItemInFolder).toHaveBeenCalledWith("C:\\x.exe");
  });

  it("swaps an AppImage in place and relaunches it", async () => {
    const directory = tempDir("appimage");
    const current = path.join(directory, "IwaraTV_2.0.0_x86_64.AppImage");
    const downloaded = path.join(directory, "IwaraTV_2.1.0_x86_64.AppImage");
    writeFileSync(current, "old");
    writeFileSync(downloaded, "new");
    const ctx = context({ env: { APPIMAGE: current } });
    const calls = deps();
    await createInstaller(resolveUpdateEnvironment(ctx, { source: GITHUB_SOURCE }), ctx, calls)(downloaded);
    expect(existsSync(current)).toBe(false);
    expect(statSync(downloaded).mode & 0o777).toBe(0o755);
    expect(calls.relaunch).toHaveBeenCalledWith(downloaded);
    expect(calls.quit).toHaveBeenCalled();

    // A renamed AppImage keeps its name so shortcuts keep working.
    const renamed = path.join(directory, "IwaraTV.AppImage");
    const next = path.join(directory, "IwaraTV_2.2.0_x86_64.AppImage");
    writeFileSync(renamed, "old");
    writeFileSync(next, "newer");
    expect(await replaceAppImage(next, renamed, "2.1.0")).toBe(renamed);
    expect(readFileSync(renamed, "utf8")).toBe("newer");
    expect(existsSync(next)).toBe(false);
  });
});

describe("update settings", () => {
  it("defaults, coerces and persists cleared values", () => {
    const directory = tempDir("update-settings");
    writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ updates: { autoCheck: "yes", skippedVersion: " 2.1.0 " } }));
    const store = new SettingsStore(directory);
    expect(store.get().updates).toEqual({ autoCheck: true, autoDownload: true, skippedVersion: "2.1.0" });
    store.update({ updates: { skippedVersion: null, autoDownload: false, lastCheckedAt: "2026-11-03T00:00:00.000Z" } });
    const saved = JSON.parse(readFileSync(path.join(directory, "settings.json"), "utf8"));
    expect(saved.updates).toEqual({ autoCheck: true, autoDownload: false, skippedVersion: null, lastCheckedAt: "2026-11-03T00:00:00.000Z" });
    expect(new SettingsStore(directory).get().updates).toEqual({ autoCheck: true, autoDownload: false, lastCheckedAt: "2026-11-03T00:00:00.000Z" });
  });
});

// --- Release scripts ------------------------------------------------------------------

describe("release scripts", () => {
  const script = path.resolve("scripts/update-manifest.mjs");

  function releaseFolder(version: string) {
    const directory = tempDir("release");
    for (const key of UPDATE_ASSET_KEYS) {
      writeFileSync(path.join(directory, assetFileName(key, version)), `${key} build`);
    }
    const notes = path.join(directory, "notes.md");
    writeFileSync(notes, "## IwaraTV 2.1\n\n> [!WARNING]\n> Read this.\n\n### ⚠️ Breaking changes\n\n- Something changed.\n");
    return { directory, notes };
  }

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  }

  it("writes a manifest the app accepts, with a signature that matches the committed key", () => {
    const { publicKey, privateKey } = keyPair();
    const { directory, notes } = releaseFolder("2.1.0");
    const publicKeyFile = path.join(directory, "public.pem");
    writeFileSync(publicKeyFile, publicKey);

    const result = run(["--tag", "v2.1.0", "--dir", directory, "--notes", notes, "--public-key", publicKeyFile], { UPDATE_SIGNING_KEY: privateKey });
    expect(result.status, result.stderr).toBe(0);
    const bytes = readFileSync(path.join(directory, "update.json"));
    const manifest = parseManifest(bytes.toString("utf8"));
    expect(manifest).toMatchObject({ version: "2.1.0", breaking: true });
    expect(manifest.notes).not.toContain("[!WARNING]");
    for (const key of UPDATE_ASSET_KEYS) {
      expect(manifest.assets[key]).toEqual({ name: assetFileName(key, "2.1.0"), size: `${key} build`.length, sha256: sha256(`${key} build`) });
    }
    expect(verifyManifestSignature(bytes, readFileSync(path.join(directory, "update.json.sig"), "utf8"), publicKey)).toBe(true);
  });

  it("refuses to publish unsigned or wrongly signed manifests once a key is committed", () => {
    const { publicKey } = keyPair();
    const { directory, notes } = releaseFolder("2.1.0");
    const publicKeyFile = path.join(directory, "public.pem");
    writeFileSync(publicKeyFile, publicKey);
    const args = ["--tag", "v2.1.0", "--dir", directory, "--notes", notes, "--public-key", publicKeyFile];

    expect(run(args).stderr).toMatch(/UPDATE_SIGNING_KEY is not set/);
    const mismatch = run(args, { UPDATE_SIGNING_KEY: keyPair().privateKey });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/doesn't match/);
    expect(existsSync(path.join(directory, "update.json.sig"))).toBe(false);
  });

  it("writes an unsigned manifest when no key is set up, and fails on missing files", () => {
    const { directory, notes } = releaseFolder("2.1.0");
    const args = ["--tag", "v2.1.0", "--dir", directory, "--notes", notes, "--public-key", path.join(directory, "none.pem")];
    expect(run(args).status).toBe(0);
    expect(existsSync(path.join(directory, "update.json.sig"))).toBe(false);

    const empty = tempDir("release-empty");
    const missing = run(["--tag", "v2.1.0", "--dir", empty, "--public-key", path.join(empty, "none.pem")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/missing IwaraTV_2\.1\.0_x64-setup\.exe/);
  });

  it("generates a key pair outside the repository only", () => {
    const keygen = path.resolve("scripts/update-keygen.mjs");
    const workspace = tempDir("keygen");
    mkdirSync(path.join(workspace, "build"));
    const inside = spawnSync(process.execPath, [keygen, "--out", path.join(workspace, "key.pem")], { cwd: workspace, encoding: "utf8" });
    expect(inside.status).toBe(1);
    expect(inside.stderr).toMatch(/inside the repository/);

    const outside = path.join(tempDir("keygen-secret"), "key.pem");
    execFileSync(process.execPath, [keygen, "--out", outside], { cwd: workspace });
    expect(statSync(outside).mode & 0o777).toBe(0o600);
    const publicKey = readFileSync(path.join(workspace, "build", "update-public-key.pem"), "utf8");
    const bytes = Buffer.from("manifest");
    expect(verifyManifestSignature(bytes, sign(null, bytes, readFileSync(outside, "utf8")).toString("base64"), publicKey)).toBe(true);

    const again = spawnSync(process.execPath, [keygen, "--out", path.join(tempDir("keygen-2"), "key.pem")], { cwd: workspace, encoding: "utf8" });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
  });
});

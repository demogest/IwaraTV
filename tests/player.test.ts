import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlayerService } from "../src/main/services/player-service";
import { createDefaultSettings } from "../src/shared/defaults";
import type { PlayerSettings } from "../src/shared/types";
import { tempDir } from "./helpers";

// "freebsd" has no hard-coded install locations, so results never depend on
// whether this machine happens to have MPV installed.
const OTHER_OS = "freebsd" as NodeJS.Platform;

function executable(directory: string, name: string, script = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

function playerSettings(overrides: Partial<PlayerSettings> = {}): PlayerSettings {
  return { ...createDefaultSettings().player, ...overrides };
}

describe("PlayerService.resolveMpvPath", () => {
  it("prefers a configured executable, then bundled copies, then PATH", () => {
    const root = tempDir("mpv-resolve");
    const configured = executable(path.join(root, "configured"), "my-mpv");
    const bundled = executable(path.join(root, "resources", "mpv"), "mpv");
    const onPath = executable(path.join(root, "bin"), "mpv");
    const env = { PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}` };

    const withResources = new PlayerService({ platform: OTHER_OS, env, resourcesPath: path.join(root, "resources") });
    expect(withResources.resolveMpvPath(configured)).toBe(configured);
    expect(withResources.resolveMpvPath(` ${configured} `)).toBe(configured);
    expect(withResources.resolveMpvPath(path.join(root, "nope"))).toBe(bundled);
    expect(new PlayerService({ platform: OTHER_OS, env }).resolveMpvPath()).toBe(onPath);
    expect(new PlayerService({ platform: OTHER_OS, env: { PATH: "" } }).resolveMpvPath()).toBeUndefined();
  });

  it("skips directories and non-executable files", () => {
    const root = tempDir("mpv-nonexec");
    mkdirSync(path.join(root, "a", "mpv"), { recursive: true });
    mkdirSync(path.join(root, "b"), { recursive: true });
    writeFileSync(path.join(root, "b", "mpv"), "not executable");
    chmodSync(path.join(root, "b", "mpv"), 0o644);
    const env = { PATH: [path.join(root, "a"), path.join(root, "b")].join(":") };
    expect(new PlayerService({ platform: OTHER_OS, env }).resolveMpvPath()).toBeUndefined();
  });

  it("understands Windows PATH syntax", () => {
    const root = tempDir("mpv-win");
    const mpv = executable(path.join(root, "Program Files", "mpv"), "mpv.exe");
    const service = new PlayerService({ platform: "win32", env: { Path: `C:\\Windows;"${path.dirname(mpv)}"` } });
    expect(service.resolveMpvPath()).toBe(mpv);
  });
});

describe("PlayerService diagnostics", () => {
  const root = tempDir("player-probe");
  const external = executable(root, "external-player");
  const service = new PlayerService({ platform: OTHER_OS, env: { PATH: "" } });

  it("reports each external player problem distinctly", () => {
    expect(service.probe(playerSettings()).external.code).toBe("not-configured");
    expect(service.probe(playerSettings({ externalPlayerPath: path.join(root, "missing") })).external.code).toBe("not-found");
    expect(service.probe(playerSettings({ externalPlayerPath: external, externalPlayerArgs: "--title {title}" })).external.code).toBe(
      "missing-url-placeholder"
    );
    expect(service.probe(playerSettings({ externalPlayerPath: external, externalPlayerArgs: `"{url}` })).external).toMatchObject({
      ok: false,
      code: "invalid-template"
    });
    const ok = service.probe(playerSettings({ externalPlayerPath: external, externalPlayerArgs: `--header "{headers}" {url}` }));
    expect(ok.external).toMatchObject({ ok: true, code: "found", resolvedPath: external });
    expect(ok.externalArgsPreview).toEqual(["--header", "Referer: https://www.iwara.tv/", "https://media.example/video.mp4"]);
    expect(ok.mpv).toMatchObject({ ok: false, code: "not-found" });
  });

  it("throws actionable errors when a player cannot be used", () => {
    expect(() => service.requirePlayer("mpv", playerSettings())).toThrow(expect.objectContaining({ code: "MPV_NOT_FOUND" }));
    expect(() => service.requirePlayer("external", playerSettings())).toThrow(expect.objectContaining({ code: "EXTERNAL_PLAYER_NOT_FOUND" }));
    expect(() => service.requirePlayer("external", playerSettings({ externalPlayerPath: external, externalPlayerArgs: "--fs" }))).toThrow(
      expect.objectContaining({ code: "EXTERNAL_PLAYER_TEMPLATE" })
    );
    expect(service.requirePlayer("external", playerSettings({ externalPlayerPath: external }))).toBe(external);
  });

  it("fills template placeholders only once", () => {
    const args = service.buildArgs("external", playerSettings({ externalPlayerArgs: "--title={title} {url}" }), "https://a.iwara.tv/v?x={title}", "{url} {headers}");
    expect(args).toEqual(["--title={url} {headers}", "https://a.iwara.tv/v?x={title}"]);
  });

  it("ends MPV options before the URL", () => {
    const args = service.buildArgs("mpv", playerSettings(), "--script=evil.lua", "Title");
    expect(args.slice(-2)).toEqual(["--", "--script=evil.lua"]);
    expect(args).toContain("--referrer=https://www.iwara.tv/");
    expect(service.buildArgs("external", playerSettings({ externalPlayerArgs: "--name={title} {url}" }), "https://u", "My video")).toEqual([
      "--name=My video",
      "https://u"
    ]);
  });

  it("tests MPV by running --version", async () => {
    const mpv = executable(tempDir("mpv-version"), "mpv", "#!/bin/sh\necho 'mpv 0.40.0 Copyright'\n");
    expect(await service.testMpv(playerSettings({ mpvPath: mpv }))).toMatchObject({ ok: true, code: "launch-ok", detail: "mpv 0.40.0 Copyright" });
    const broken = executable(tempDir("mpv-broken"), "mpv", "#!/bin/sh\nexit 3\n");
    expect(await service.testMpv(playerSettings({ mpvPath: broken }))).toMatchObject({ ok: false, code: "launch-failed", detail: "exit code 3" });
    expect(await service.testMpv(playerSettings())).toMatchObject({ ok: false, code: "not-found" });
  });

  it("launches detached players and reports spawn failures", async () => {
    const marker = path.join(tempDir("player-launch"), "args.txt");
    const player = executable(tempDir("player-bin"), "player", `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
    await service.launch(player, ["--", "https://u"]);
    await expect.poll(() => (existsSync(marker) ? readFileSync(marker, "utf8") : ""), { timeout: 3000 }).toBe("--\nhttps://u\n");
    await expect(service.launch(path.join(root, "missing-player"), [])).rejects.toMatchObject({ code: "PLAYER_LAUNCH_FAILED" });
  });
});

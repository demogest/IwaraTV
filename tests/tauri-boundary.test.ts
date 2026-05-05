import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const runtimeSourceDirs = ["src"].map((relativePath) => path.join(root, relativePath));
const oldDesktopRuntimeName = ["elec", "tron"].join("");
const oldWebEntryName = ["ren", "derer"].join("");
const oldMainApiName = ["ipc", "Main"].join("");
const oldContextApiName = ["context", "Bridge"].join("");
const oldWindowApiName = ["Browser", "Window"].join("");
const forbiddenRuntimePatterns = [
  /\bfrom\s+["']node:/,
  /\brequire\s*\(/,
  new RegExp(`\\bipc${oldWebEntryName}\\b`, "i"),
  new RegExp(`\\b${oldMainApiName}\\b`),
  new RegExp(`\\b${oldContextApiName}\\b`),
  new RegExp(`\\b${oldWindowApiName}\\b`)
];

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

describe("Tauri mainline boundaries", () => {
  it("does not carry legacy JS desktop source or output files", () => {
    expect(fs.existsSync(path.join(root, "src", "main"))).toBe(false);
    expect(fs.existsSync(path.join(root, "tsconfig.node.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, `dist-${oldDesktopRuntimeName}`))).toBe(false);
    expect(fs.existsSync(path.join(root, "release/win-unpacked"))).toBe(false);
  });

  it("keeps native implementation in Rust instead of shared TypeScript backend clones", () => {
    expect(fs.existsSync(path.join(root, "src-tauri/src/iwara_utils.rs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src-tauri/src/player_template.rs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "src/lib/iwara-utils.ts"))).toBe(false);
    expect(fs.existsSync(path.join(root, "src/lib/player-utils.ts"))).toBe(false);
  });

  it("keeps web runtime code browser-safe", () => {
    const offenders = runtimeSourceDirs
      .flatMap(listFiles)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => forbiddenRuntimePatterns.some((pattern) => pattern.test(fs.readFileSync(file, "utf8"))))
      .map((file) => path.relative(root, file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });

  it("does not depend on legacy JS desktop packages in the Tauri mainline", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {})
    ];

    expect(dependencyNames.filter((name) => name.includes(oldDesktopRuntimeName))).toEqual([]);
  });
});

import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");
const packageJson = require("../package.json");

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_RELEASE_DIR = path.join(PROJECT_ROOT, "src-tauri", "target", "release");
const RELEASE_DIR = path.join(PROJECT_ROOT, "release");
const APP_EXE = path.join(TARGET_RELEASE_DIR, "iwaratv.exe");
const VERSION = packageJson.version;
const ARCH = process.env.IWARATV_RELEASE_ARCH || "x64";
const PORTABLE_EXE_NAME = `IwaraTV_${VERSION}_${ARCH}-portable.exe`;
const UNPACKED_ZIP_NAME = `IwaraTV_${VERSION}_${ARCH}-unpacked.zip`;
const PORTABLE_EXE = path.join(RELEASE_DIR, PORTABLE_EXE_NAME);
const UNPACKED_ZIP = path.join(RELEASE_DIR, UNPACKED_ZIP_NAME);
const STAGING_DIR = path.join(RELEASE_DIR, `IwaraTV_${VERSION}_${ARCH}-unpacked`);

async function main() {
  assertWorkspacePath(RELEASE_DIR);
  await requireFile(APP_EXE, "Run `npm run build:tauri -- --bundles nsis` before packaging.");
  await assertReleaseExe(APP_EXE);
  await mkdir(RELEASE_DIR, { recursive: true });

  await cp(APP_EXE, PORTABLE_EXE, { force: true });

  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });
  await cp(APP_EXE, path.join(STAGING_DIR, "IwaraTV.exe"), { force: true });
  await copyIfExists(path.join(TARGET_RELEASE_DIR, "mpv"), path.join(STAGING_DIR, "mpv"));
  await copyIfExists(
    path.join(TARGET_RELEASE_DIR, "resources"),
    path.join(STAGING_DIR, "resources")
  );
  await copyIfExists(path.join(PROJECT_ROOT, "README.md"), path.join(STAGING_DIR, "README.md"));
  await copyIfExists(path.join(PROJECT_ROOT, "LICENSE"), path.join(STAGING_DIR, "LICENSE"));

  await rm(UNPACKED_ZIP, { force: true });
  await run(path7za, ["a", "-tzip", "-mx=7", "-mmt=on", UNPACKED_ZIP, "."], STAGING_DIR);

  console.log(`Packaged ${path.relative(PROJECT_ROOT, PORTABLE_EXE)}`);
  console.log(`Packaged ${path.relative(PROJECT_ROOT, UNPACKED_ZIP)}`);
}

async function copyIfExists(source, destination) {
  if (!existsSync(source)) {
    return;
  }
  const info = await stat(source);
  if (info.isDirectory()) {
    await cp(source, destination, { recursive: true, force: true });
  } else {
    await cp(source, destination, { force: true });
  }
}

async function requireFile(file, hint) {
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. ${hint}`);
  }
  const info = await stat(file);
  if (!info.isFile()) {
    throw new Error(`Expected a file: ${file}`);
  }
}

async function assertReleaseExe(file) {
  const raw = await readFile(file);
  if (!raw.includes(Buffer.from("index.html")) || !raw.includes(Buffer.from("assets/index-"))) {
    throw new Error(
      `${file} does not contain the built frontend assets. Run \`npm run build:tauri -- --bundles nsis\` before packaging.`
    );
  }
  await assertReleaseBuildMode();
}

async function assertReleaseBuildMode() {
  const buildDir = path.join(TARGET_RELEASE_DIR, "build");
  const entries = await readdir(buildDir, { withFileTypes: true }).catch(() => []);
  const outputs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("iwaratv-")) {
      continue;
    }
    const output = path.join(buildDir, entry.name, "output");
    if (existsSync(output)) {
      outputs.push({ path: output, info: await stat(output) });
    }
  }
  outputs.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  const latest = outputs[0];
  if (!latest) {
    throw new Error("Could not verify the latest Tauri build mode.");
  }
  const output = await readFile(latest.path, "utf8");
  if (output.includes("cargo:rustc-cfg=dev")) {
    throw new Error(
      "The latest release build was compiled in Tauri dev mode and would load 127.0.0.1. Run `npm run build:tauri -- --bundles nsis` with the `custom-protocol` feature enabled."
    );
  }
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

function assertWorkspacePath(target) {
  const resolvedRoot = PROJECT_ROOT;
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside workspace: ${target}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

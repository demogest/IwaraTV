import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");

const REPO = "shinchiro/mpv-winbuild-cmake";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const PROJECT_ROOT = process.cwd();
const TARGET_DIR = path.resolve(PROJECT_ROOT, "vendor", "mpv");

function selectMpvAsset(assets) {
  const patterns = [
    /^mpv-x86_64-\d{8}-git-[^.]+\.7z$/i,
    /^mpv-x86_64-v3-\d{8}-git-[^.]+\.7z$/i,
    /^mpv-dev-x86_64-\d{8}-git-[^.]+\.7z$/i
  ];

  for (const pattern of patterns) {
    const asset = assets.find((candidate) => pattern.test(candidate.name ?? ""));
    if (asset) {
      return asset;
    }
  }

  return undefined;
}

async function main() {
  assertWorkspacePath(TARGET_DIR);

  const release = await fetchJson(RELEASE_API);
  const asset = selectMpvAsset(release.assets ?? []);
  if (!asset?.browser_download_url) {
    throw new Error(`No compatible Windows mpv asset found in ${REPO} latest release.`);
  }

  const tempDir = path.join(os.tmpdir(), `iwaratv-mpv-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  const archivePath = path.join(tempDir, asset.name);
  const extractDir = path.join(tempDir, "extract");
  await mkdir(extractDir, { recursive: true });

  console.log(`Downloading ${asset.name} from ${release.html_url}`);
  const sha256 = await downloadFile(asset.browser_download_url, archivePath);

  console.log("Extracting mpv archive...");
  await run(path7za, ["x", archivePath, `-o${extractDir}`, "-y"]);

  const mpvExe = await findFile(extractDir, "mpv.exe");
  if (!mpvExe) {
    throw new Error("Archive did not contain mpv.exe.");
  }

  await replaceDirectoryContents(path.dirname(mpvExe), TARGET_DIR);
  await writeFile(
    path.join(TARGET_DIR, "mpv-manifest.json"),
    `${JSON.stringify(
      {
        source: REPO,
        release: release.tag_name,
        releaseUrl: release.html_url,
        asset: asset.name,
        downloadedAt: new Date().toISOString(),
        sha256
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(TARGET_DIR, ".gitkeep"), "\n", "utf8");

  await rm(tempDir, { recursive: true, force: true });
  console.log(`Installed latest mpv to ${TARGET_DIR}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "IwaraTV-build-script"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "IwaraTV-build-script"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(destination, bytes);

  return createHash("sha256").update(bytes).digest("hex");
}

async function replaceDirectoryContents(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(targetDir);
  await Promise.all(
    entries
      .filter((entry) => entry !== ".gitkeep")
      .map((entry) => rm(path.join(targetDir, entry), { recursive: true, force: true }))
  );
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

async function findFile(root, filename) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return current;
    }
    if (entry.isDirectory()) {
      const found = await findFile(current, filename);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
  const resolvedRoot = path.resolve(PROJECT_ROOT);
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

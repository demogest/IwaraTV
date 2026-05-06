import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUMP_TYPES = new Set(["major", "minor", "patch"]);

const files = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  tauriConfig: path.join("src-tauri", "tauri.conf.json"),
  cargoManifest: path.join("src-tauri", "Cargo.toml"),
  cargoLock: path.join("src-tauri", "Cargo.lock")
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const currentVersion = await readPackageVersion();
  const targetVersion = options.target ? resolveTargetVersion(options.target, currentVersion) : currentVersion;

  if (options.check) {
    await checkVersions(targetVersion);
    return;
  }

  if (!options.target) {
    printUsage();
    throw new Error("Missing target version. Pass an exact version, major, minor, or patch.");
  }

  const updates = await buildUpdates(targetVersion);
  const before = await collectVersions();

  printChanges(before, targetVersion, options.dryRun);
  if (options.dryRun) {
    return;
  }

  for (const update of updates) {
    if (update.next !== update.raw) {
      await writeFile(abs(update.file), update.next);
    }
  }
}

function parseArgs(args) {
  const options = {
    check: false,
    dryRun: false,
    help: false,
    target: undefined
  };

  for (const arg of args) {
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.target) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.target = arg;
  }

  return options;
}

function printUsage() {
  console.log(`
Usage:
  npm run version:update -- <version|major|minor|patch>
  npm run version:update -- --check
  npm run version:update -- patch --dry-run

Examples:
  npm run version:update -- 1.0.3
  npm run version:update -- patch
`.trim());
}

async function readPackageVersion() {
  const packageJson = await readJson(files.packageJson);
  assertVersion(packageJson.version, files.packageJson);
  return packageJson.version;
}

function resolveTargetVersion(target, currentVersion) {
  if (BUMP_TYPES.has(target)) {
    return bumpVersion(currentVersion, target);
  }

  const normalized = target.startsWith("v") ? target.slice(1) : target;
  assertVersion(normalized, "target version");
  return normalized;
}

function bumpVersion(version, type) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Cannot ${type}-bump invalid current version: ${version}`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (type === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

async function buildUpdates(version) {
  const packageJson = await readJson(files.packageJson);
  packageJson.version = version;

  const packageLock = await readJson(files.packageLock);
  packageLock.version = version;
  if (!packageLock.packages?.[""]) {
    throw new Error("Could not find root package entry in package-lock.json.");
  }
  packageLock.packages[""].version = version;

  const tauriConfig = await readJson(files.tauriConfig);
  tauriConfig.version = version;

  const cargoManifest = await readText(files.cargoManifest);
  const cargoLock = await readText(files.cargoLock);

  return [
    {
      file: files.packageJson,
      raw: await readText(files.packageJson),
      next: `${JSON.stringify(packageJson, null, 2)}\n`
    },
    {
      file: files.packageLock,
      raw: await readText(files.packageLock),
      next: `${JSON.stringify(packageLock, null, 2)}\n`
    },
    {
      file: files.tauriConfig,
      raw: await readText(files.tauriConfig),
      next: `${JSON.stringify(tauriConfig, null, 2)}\n`
    },
    {
      file: files.cargoManifest,
      raw: cargoManifest,
      next: replaceCargoPackageVersion(cargoManifest, version, files.cargoManifest)
    },
    {
      file: files.cargoLock,
      raw: cargoLock,
      next: replaceCargoLockPackageVersion(cargoLock, version, files.cargoLock)
    }
  ];
}

async function collectVersions() {
  const packageJson = await readJson(files.packageJson);
  const packageLock = await readJson(files.packageLock);
  const tauriConfig = await readJson(files.tauriConfig);
  const cargoManifest = await readText(files.cargoManifest);
  const cargoLock = await readText(files.cargoLock);

  return [
    { label: "package.json", file: files.packageJson, version: packageJson.version },
    { label: "package-lock.json", file: files.packageLock, version: packageLock.version },
    {
      label: "package-lock.json packages root",
      file: files.packageLock,
      version: packageLock.packages?.[""]?.version
    },
    { label: "tauri.conf.json", file: files.tauriConfig, version: tauriConfig.version },
    { label: "Cargo.toml package", file: files.cargoManifest, version: readCargoPackageVersion(cargoManifest, files.cargoManifest) },
    { label: "Cargo.lock iwaratv", file: files.cargoLock, version: readCargoLockPackageVersion(cargoLock, files.cargoLock) }
  ];
}

async function checkVersions(expectedVersion) {
  const versions = await collectVersions();
  const mismatches = versions.filter((entry) => entry.version !== expectedVersion);

  if (mismatches.length) {
    console.error(`Version check failed. Expected ${expectedVersion}:`);
    for (const entry of mismatches) {
      console.error(`- ${entry.label}: ${entry.version ?? "missing"}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`All version references are ${expectedVersion}.`);
}

function printChanges(versions, targetVersion, dryRun) {
  console.log(`${dryRun ? "Would update" : "Updating"} version references to ${targetVersion}:`);
  for (const entry of versions) {
    const next = entry.version === targetVersion ? "unchanged" : `${entry.version ?? "missing"} -> ${targetVersion}`;
    console.log(`- ${entry.label}: ${next}`);
  }
}

function readCargoPackageVersion(raw, file) {
  const match = raw.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find package version in ${file}.`);
  }
  return match[1];
}

function replaceCargoPackageVersion(raw, version, file) {
  let replaced = false;
  const next = raw.replace(/(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m, (_match, prefix, _oldVersion, suffix) => {
    replaced = true;
    return `${prefix}${version}${suffix}`;
  });

  if (!replaced) {
    throw new Error(`Could not update package version in ${file}.`);
  }

  return next;
}

function readCargoLockPackageVersion(raw, file) {
  const match = raw.match(/^\[\[package\]\]\r?\nname = "iwaratv"\r?\nversion = "([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find iwaratv package version in ${file}.`);
  }
  return match[1];
}

function replaceCargoLockPackageVersion(raw, version, file) {
  let replaced = false;
  const next = raw.replace(/(^\[\[package\]\]\r?\nname = "iwaratv"\r?\nversion = ")([^"]+)(")/m, (_match, prefix, _oldVersion, suffix) => {
    replaced = true;
    return `${prefix}${version}${suffix}`;
  });

  if (!replaced) {
    throw new Error(`Could not update iwaratv package version in ${file}.`);
  }

  return next;
}

function assertVersion(version, source) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid semver in ${source}: ${version}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readText(file));
}

async function readText(file) {
  return readFile(abs(file), "utf8");
}

function abs(file) {
  return path.join(PROJECT_ROOT, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

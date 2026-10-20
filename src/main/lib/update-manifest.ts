// The signed update manifest (update.json) attached to every release. See
// docs/auto-update.md for the format and the trust model.

import { createPublicKey, verify } from "node:crypto";
import type { UpdateInstallKind } from "../../shared/types";
import { AppError } from "./app-error";
import { isRecord } from "./json-file";
import { parseVersion } from "./semver";

export const UPDATE_REPOSITORY = "demogest/IwaraTV";
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
export const MANIFEST_NAME = "update.json";
export const SIGNATURE_NAME = "update.json.sig";
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_UPDATE_BYTES = 600 * 1024 * 1024;
const MAX_NOTES_LENGTH = 8 * 1024;

export const UPDATE_ASSET_KEYS = [
  "win32-x64-nsis",
  "win32-x64-portable",
  "win32-x64-zip",
  "darwin-arm64-dmg",
  "linux-x64-appimage",
  "linux-x64-deb"
] as const;
export type UpdateAssetKey = (typeof UPDATE_ASSET_KEYS)[number];

export interface UpdateAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface UpdateManifest {
  schema: 1;
  version: string;
  tag: string;
  publishedAt?: string;
  breaking: boolean;
  notes?: string;
  assets: Partial<Record<UpdateAssetKey, UpdateAsset>>;
}

/** Where manifests and files come from. Only GitHub Releases in packaged builds. */
export interface UpdateSource {
  manifestUrl: string;
  fileUrl(tag: string, name: string): string;
  releaseUrl(tag: string): string;
}

export const GITHUB_SOURCE: UpdateSource = {
  manifestUrl: `${RELEASES_URL}/latest/download/${MANIFEST_NAME}`,
  fileUrl: (tag, name) => `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  releaseUrl: (tag) => `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`
};

/** A folder that holds update.json, its signature and the files (development and tests only). */
export function folderSource(baseUrl: string): UpdateSource {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("Update source must be an http(s) URL.");
  }
  return {
    manifestUrl: new URL(MANIFEST_NAME, base).toString(),
    fileUrl: (_tag, name) => new URL(encodeURIComponent(name), base).toString(),
    releaseUrl: (tag) => `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`
  };
}

/** The release file each install type updates from, as the release job names it. */
export function assetFileName(key: UpdateAssetKey, version: string): string {
  const suffix: Record<UpdateAssetKey, string> = {
    "win32-x64-nsis": "x64-setup.exe",
    "win32-x64-portable": "x64-portable.exe",
    "win32-x64-zip": "x64-unpacked.zip",
    "darwin-arm64-dmg": "arm64.dmg",
    "linux-x64-appimage": "x86_64.AppImage",
    "linux-x64-deb": "amd64.deb"
  };
  return `IwaraTV_${version}_${suffix[key]}`;
}

export function assetKeyFor(kind: UpdateInstallKind, platform: NodeJS.Platform, arch: string): UpdateAssetKey | undefined {
  const key = ({
    nsis: "win32-x64-nsis",
    portable: "win32-x64-portable",
    archive: platform === "win32" ? "win32-x64-zip" : undefined,
    appimage: "linux-x64-appimage",
    deb: "linux-x64-deb",
    dmg: "darwin-arm64-dmg",
    dev: undefined
  } satisfies Record<UpdateInstallKind, UpdateAssetKey | undefined>)[kind];
  // Only builds the release job makes: x64 Windows and Linux, Apple Silicon macOS.
  return key && key.startsWith(`${platform}-${arch}-`) ? key : undefined;
}

function invalid(message: string): never {
  throw new AppError("UPDATE_INVALID", message, { reason: "format" });
}

/** Parses and validates update.json. Unknown fields and asset keys are ignored for forward compatibility. */
export function parseManifest(text: string): UpdateManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    invalid("The update information is not valid JSON.");
  }
  if (!isRecord(raw)) {
    invalid("The update information is not an object.");
  }
  if (raw.schema !== 1) {
    invalid("The update information uses an unsupported format.");
  }
  const version = typeof raw.version === "string" ? raw.version : "";
  if (!parseVersion(version) || version.startsWith("v") || version.length > 64) {
    invalid("The update information has no valid version.");
  }
  if (raw.tag !== `v${version}`) {
    invalid("The update information's tag doesn't match its version.");
  }
  if (typeof raw.breaking !== "boolean") {
    invalid("The update information doesn't say whether it is a breaking release.");
  }
  if (!isRecord(raw.assets)) {
    invalid("The update information lists no files.");
  }

  const assets: Partial<Record<UpdateAssetKey, UpdateAsset>> = {};
  for (const key of UPDATE_ASSET_KEYS) {
    const asset = raw.assets[key];
    if (asset !== undefined) {
      assets[key] = parseAsset(asset, key, version);
    }
  }

  const manifest: UpdateManifest = { schema: 1, version, tag: `v${version}`, breaking: raw.breaking, assets };
  if (typeof raw.publishedAt === "string" && raw.publishedAt.length <= 64 && !Number.isNaN(Date.parse(raw.publishedAt))) {
    manifest.publishedAt = new Date(raw.publishedAt).toISOString();
  }
  if (typeof raw.notes === "string" && raw.notes.trim()) {
    manifest.notes = raw.notes.slice(0, MAX_NOTES_LENGTH);
  }
  return manifest;
}

function parseAsset(value: unknown, key: UpdateAssetKey, version: string): UpdateAsset {
  if (!isRecord(value)) {
    invalid(`The update file entry ${key} is not an object.`);
  }
  // Names are fixed by the release job, so a manifest can't send the app to another file.
  if (value.name !== assetFileName(key, version)) {
    invalid(`The update file entry ${key} has an unexpected name.`);
  }
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_UPDATE_BYTES) {
    invalid(`The update file entry ${key} has an invalid size.`);
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    invalid(`The update file entry ${key} has an invalid checksum.`);
  }
  return { name: value.name, size: value.size, sha256: value.sha256 };
}

/** Checks an Ed25519 signature (base64) over the manifest's exact bytes. */
export function verifyManifestSignature(manifest: Uint8Array, signature: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const bytes = Buffer.from(signature.trim(), "base64");
    return bytes.length === 64 && verify(null, manifest, key, bytes);
  } catch {
    return false;
  }
}

/** True when the PEM text is an Ed25519 public key the app can pin. */
export function isUsablePublicKey(publicKeyPem: string | undefined): publicKeyPem is string {
  if (!publicKeyPem?.trim()) {
    return false;
  }
  try {
    return createPublicKey(publicKeyPem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

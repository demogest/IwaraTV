// Writes update.json (and update.json.sig when a signing key is available)
// for the in-app updater. Run by the release job; see docs/auto-update.md.
//
//   node scripts/update-manifest.mjs --tag v2.1.0 --dir release-assets [--notes <file>]
//
// UPDATE_SIGNING_KEY: the Ed25519 private key (PEM) from `npm run update:keygen`.
// When build/update-public-key.pem is committed, the key is required and must match it.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const PUBLIC_KEY_FILE = "build/update-public-key.pem";
const NOTES_LIMIT = 4096;
// Keep in sync with assetFileName() in src/main/lib/update-manifest.ts.
const ASSETS = {
  "win32-x64-nsis": "x64-setup.exe",
  "win32-x64-portable": "x64-portable.exe",
  "win32-x64-zip": "x64-unpacked.zip",
  "darwin-arm64-dmg": "arm64.dmg",
  "linux-x64-appimage": "x86_64.AppImage",
  "linux-x64-deb": "amd64.deb"
};

function fail(message) {
  console.error(`update-manifest: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    dir: { type: "string" },
    notes: { type: "string" },
    "out-dir": { type: "string" },
    "public-key": { type: "string" }
  }
});

const tag = values.tag ?? "";
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(`--tag must look like v1.2.3 (got "${tag}").`);
}
const version = tag.slice(1);
const assetDir = values.dir ?? fail("--dir is required.");
const outDir = values["out-dir"] ?? assetDir;
const notesFile = values.notes ?? path.join("docs", "release-notes", `${tag}.md`);
const publicKeyFile = values["public-key"] ?? PUBLIC_KEY_FILE;

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const assets = {};
for (const [key, suffix] of Object.entries(ASSETS)) {
  const name = `IwaraTV_${version}_${suffix}`;
  const filePath = path.join(assetDir, name);
  if (!existsSync(filePath)) {
    fail(`missing ${name} in ${assetDir}.`);
  }
  assets[key] = { name, size: statSync(filePath).size, sha256: await sha256(filePath) };
}

/** The hand-written notes, cut at a section boundary to fit the update dialog. */
function releaseNotes() {
  if (!existsSync(notesFile)) {
    return undefined;
  }
  const text = readFileSync(notesFile, "utf8")
    .replace(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n/gim, "")
    .trim();
  if (Buffer.byteLength(text) <= NOTES_LIMIT) {
    return text;
  }
  let kept = "";
  for (const section of text.split(/\n(?=#{2,} )/)) {
    const next = kept ? `${kept}\n${section}` : section;
    if (Buffer.byteLength(next) > NOTES_LIMIT) {
      break;
    }
    kept = next;
  }
  if (!kept) {
    for (const line of text.split("\n")) {
      const next = kept ? `${kept}\n${line}` : line;
      if (Buffer.byteLength(next) > NOTES_LIMIT) {
        break;
      }
      kept = next;
    }
  }
  return kept.trim();
}

const notes = releaseNotes();
const manifest = {
  schema: 1,
  version,
  tag,
  publishedAt: new Date().toISOString(),
  // Same rule as scripts/release-notes.sh; clients also treat any major upgrade as breaking.
  breaking: Boolean(notes && /^#{2,} .*breaking changes/im.test(readFileSync(notesFile, "utf8"))),
  ...(notes ? { notes } : {}),
  assets
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(outDir, "update.json"), bytes);
console.log(`Wrote update.json for ${tag}${manifest.breaking ? " (breaking)" : ""}.`);

const privateKeyText = process.env.UPDATE_SIGNING_KEY?.trim();
const publicKeyText = existsSync(publicKeyFile) ? readFileSync(publicKeyFile, "utf8") : undefined;
if (!privateKeyText) {
  if (publicKeyText) {
    fail(`${publicKeyFile} is committed, so apps only accept signed updates, but UPDATE_SIGNING_KEY is not set.`);
  }
  console.log("No UPDATE_SIGNING_KEY: update.json is unsigned (apps without a pinned key still accept it).");
  process.exit(0);
}

let privateKey;
try {
  // Accept keys pasted with escaped newlines as well.
  privateKey = createPrivateKey(privateKeyText.includes("\n") ? privateKeyText : privateKeyText.replace(/\\n/g, "\n"));
} catch {
  fail("UPDATE_SIGNING_KEY is not a PEM private key.");
}
if (privateKey.asymmetricKeyType !== "ed25519") {
  fail("UPDATE_SIGNING_KEY must be an Ed25519 key (npm run update:keygen).");
}
const signature = sign(null, bytes, privateKey);
if (publicKeyText && !verify(null, bytes, createPublicKey(publicKeyText), signature)) {
  fail(`UPDATE_SIGNING_KEY doesn't match ${publicKeyFile}; apps would reject this release.`);
}
writeFileSync(path.join(outDir, "update.json.sig"), `${signature.toString("base64")}\n`);
console.log(`Signed update.json${publicKeyText ? ` (matches ${publicKeyFile})` : ""}.`);

// Creates the Ed25519 key pair that signs update manifests. Run once, on the
// maintainer's machine:
//
//   npm run update:keygen [-- --out <private key path>] [-- --force]
//
// The public key goes to build/update-public-key.pem (commit it). The private
// key is written outside the repository with owner-only permissions; store it
// as the UPDATE_SIGNING_KEY repository secret and keep an offline backup.

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const PUBLIC_KEY_FILE = path.resolve("build", "update-public-key.pem");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    force: { type: "boolean", default: false }
  }
});

function fail(message) {
  console.error(`update-keygen: ${message}`);
  process.exit(1);
}

const privateKeyFile = path.resolve(values.out ?? path.join(os.homedir(), ".iwaratv", "update-signing-key.pem"));
const relativeToRepo = path.relative(process.cwd(), privateKeyFile);
if (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo)) {
  fail("the private key must not be written inside the repository. Pass --out with a path outside it.");
}
if (existsSync(PUBLIC_KEY_FILE) && !values.force) {
  fail(
    `${path.relative(process.cwd(), PUBLIC_KEY_FILE)} already exists. Installed apps trust that key: replacing it means `
    + "they reject every future update until users reinstall by hand. Pass --force only if the old private key is lost or leaked."
  );
}
if (existsSync(privateKeyFile) && !values.force) {
  fail(`${privateKeyFile} already exists. Pass --force to overwrite it.`);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

mkdirSync(path.dirname(privateKeyFile), { recursive: true, mode: 0o700 });
writeFileSync(privateKeyFile, privateKey, { mode: 0o600 });
chmodSync(privateKeyFile, 0o600);
mkdirSync(path.dirname(PUBLIC_KEY_FILE), { recursive: true });
writeFileSync(PUBLIC_KEY_FILE, publicKey);

console.log(`Public key:  ${path.relative(process.cwd(), PUBLIC_KEY_FILE)} (commit this file)`);
console.log(`Private key: ${privateKeyFile} (never commit or share it)`);
console.log("");
console.log("Next steps:");
console.log(`  1. gh secret set UPDATE_SIGNING_KEY --repo demogest/IwaraTV < "${privateKeyFile}"`);
console.log("  2. Commit build/update-public-key.pem. Releases from then on are signed, and apps built");
console.log("     with the key accept only signed updates.");
console.log("  3. Back the private key up offline (a password manager works), then consider deleting this copy.");

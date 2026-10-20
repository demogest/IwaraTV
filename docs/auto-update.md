# Auto-update design

Status: implemented, first shipped in the release after 2.0.0 · Related: [audit S-10](audit.md#findings), [release notes](release-notes/)

## Goals

- Tell users when a new version is out and get them onto it with as little effort as each package type allows.
- Never install something that wasn't published by this repository's release job, even though builds aren't code-signed yet.
- Respect breaking releases: a breaking update is never downloaded or installed silently.
- Work with the existing release flow (GitHub Releases built by `.github/workflows/build.yml`), with no update server to run.

## Why not electron-updater

`electron-updater` is the usual choice, but it fits this project poorly:

- On macOS it relies on Squirrel.Mac, which only installs updates signed with the same Developer ID. IwaraTV builds are signed ad hoc, so macOS updates would always fail.
- Its integrity check is the `sha512` in `latest.yml`, served from the same place as the installer. Without code signing, that only detects corruption, not a tampered release.
- It adds a runtime dependency tree to an app that currently ships none.

A purpose-built updater adds one signature check and stays within the project's process boundaries: everything below runs in the main process, and the renderer can only ask for the five actions listed under [Process boundaries](#process-boundaries).

## Overview

```
release job ──► update.json (+ update.json.sig) ──► GitHub Release assets
                                                        │
app (main process) ── fetch …/releases/latest/download/update.json
        │  fetch …/releases/download/<tag>/update.json.sig and verify it (when a key is pinned)
        │  compare versions, pick the file for this install type
        │  download …/releases/download/<tag>/<name>, enforce size, check SHA-256
        ▼
install: NSIS silent update · AppImage swap · assisted (open or show the file)
```

| Piece | File |
| --- | --- |
| Version comparison | `src/main/lib/semver.ts` |
| Manifest format, file names, signature check | `src/main/lib/update-manifest.ts` |
| Install-type detection and installers | `src/main/lib/update-install.ts` |
| Checking, downloading, state | `src/main/services/update-service.ts` |
| Electron wiring (session, spawn, relaunch) | `electronUpdates()` in `src/main/index.ts` |
| Manifest generation and signing | `scripts/update-manifest.mjs` |
| Key generation | `scripts/update-keygen.mjs` (`npm run update:keygen`) |
| UI | `src/renderer/state/updates.tsx`, `components/UpdateDialog.tsx`, Settings → Updates |

## The update manifest

The release job runs `scripts/update-manifest.mjs` after collecting the platform bundles and attaches the result to the release:

```json
{
  "schema": 1,
  "version": "2.1.0",
  "tag": "v2.1.0",
  "publishedAt": "2026-11-02T10:00:00.000Z",
  "breaking": false,
  "notes": "Markdown from docs/release-notes/v2.1.0.md (up to 4 KB)",
  "assets": {
    "win32-x64-nsis": { "name": "IwaraTV_2.1.0_x64-setup.exe", "size": 146000000, "sha256": "…" },
    "win32-x64-portable": { "name": "IwaraTV_2.1.0_x64-portable.exe", "size": 145000000, "sha256": "…" },
    "win32-x64-zip": { "name": "IwaraTV_2.1.0_x64-unpacked.zip", "size": 199000000, "sha256": "…" },
    "darwin-arm64-dmg": { "name": "IwaraTV_2.1.0_arm64.dmg", "size": 120000000, "sha256": "…" },
    "linux-x64-appimage": { "name": "IwaraTV_2.1.0_x86_64.AppImage", "size": 128000000, "sha256": "…" },
    "linux-x64-deb": { "name": "IwaraTV_2.1.0_amd64.deb", "size": 101000000, "sha256": "…" }
  }
}
```

- `breaking` is true when the version's notes have a "Breaking changes" heading (the same rule that adds "— Breaking changes" to the release title). The app also treats **any major-version upgrade** as breaking, whatever the flag says.
- `notes` are the hand-written release notes, cut at a section boundary to fit 4 KB, with GitHub callout markers removed. The dialog renders headings, lists, paragraphs, bold and code only, as plain React text.
- The manifest carries **file names only, never URLs**, and each name must be exactly `IwaraTV_<version>_<suffix>` for its key. The app builds every download URL itself as `https://github.com/demogest/IwaraTV/releases/download/<tag>/<name>`, so a manifest can't point it anywhere else.
- The script fails the release if any of the six files is missing.
- Clients read `https://github.com/demogest/IwaraTV/releases/latest/download/update.json`. GitHub redirects that to the newest non-prerelease release without touching the rate-limited API. Releases without a manifest (2.0.0 and older) answer 404, which the app reports as "up to date".
- Unknown top-level fields and asset keys are ignored, so later releases can add platforms without breaking older apps.

## Trust: signed manifests

- `npm run update:keygen` creates an Ed25519 key pair on the maintainer's machine. The **public key** goes into `build/update-public-key.pem` (committed). The **private key** is written outside the repository with owner-only permissions; it belongs in the repository secret `UPDATE_SIGNING_KEY` and an offline backup, nowhere else. The script refuses to write the private key inside the repository, and refuses to replace an existing public key unless forced.
- When the secret exists, the release job signs the exact bytes of `update.json` and uploads `update.json.sig` (base64).
- When `build/update-public-key.pem` exists at build time, `electron.vite.config.mts` compiles it into the main process (the build fails if it isn't an Ed25519 key) and the app **rejects any manifest without a valid signature**. The release job also refuses to publish if the key is committed but the secret is missing, or if the secret doesn't match the committed key, so a signed app line can never be left without updates.
- Without a pinned key the app still updates, but trust rests on HTTPS to github.com plus the SHA-256 values in the manifest. Settings → Updates shows which mode the build is in.

Because the per-file SHA-256 values are inside the signed manifest, a valid signature vouches for the installers as well, even without platform code signing.

## Install types and strategies

The main process works out how it was installed (`detectInstallKind`):

| Install type | How it's detected | Strategy | Download folder |
| --- | --- | --- | --- |
| Windows installer (`nsis`) | `Uninstall IwaraTV.exe` next to the executable | **Automatic:** download in the background, then on **Restart to update** run the installer with `--updated /S --force-run` and quit. The installer keeps the install location and starts the new version. | `%LOCALAPPDATA%\IwaraTV-updates` (owned by the updater) |
| Windows portable (`portable`) | `PORTABLE_EXECUTABLE_FILE` is set | **Assisted:** download the new portable `.exe` and show it. | Next to the running `.exe` when writable, else Downloads |
| Windows ZIP (`archive`) | anything else on Windows | **Assisted:** download the ZIP and show it. | Downloads |
| AppImage (`appimage`) | `APPIMAGE` is set | **Automatic:** download next to the running AppImage, then on restart make it executable, remove the old file (release-named files) or rename the new one over it (renamed files, so shortcuts keep working) and relaunch it. Assisted when that folder isn't writable. | The AppImage's folder |
| Debian package (`deb`) | executable under `/opt/IwaraTV` | **Assisted:** download the `.deb` and open it in the system installer (asks for the user's password). | Downloads |
| macOS (`dmg`) | `darwin` | **Assisted:** download the `.dmg` and open it; the user drags the app over the old one. | Downloads |
| Other Linux folders (`archive`) | anything else on Linux | **None:** the release has no matching file, so the dialog links to GitHub. | — |
| Development (`dev`) | `!app.isPackaged` | **None:** checks only; nothing is installed. | `<userData>/updates` |

A file only qualifies when the release job builds it for this platform and architecture (x64 Windows and Linux, Apple Silicon macOS); anything else gets the GitHub link.

Every download is streamed to `<name>.partial`, stopped as soon as it grows past the manifest's size, checked against size and SHA-256, and only then renamed into place. Files that fail are deleted. A file that is already present and intact (from an earlier session, or fetched by hand into Downloads) is used without downloading again, and every file is checked once more right before it is installed or opened. Stale `IwaraTV_*` files are removed only from the updater's own folder, never from Downloads or the user's app folder.

## Behaviour

- **When:** 20 seconds after start, then every 6 hours while the app runs, and on **Check now**. **Check for updates automatically** (on by default) turns the scheduled checks off.
- **Automatic installs:** with **Download updates in the background** on (the default), non-breaking updates download as soon as they're found; a toast and the sidebar then offer **Restart to update**. Nothing installs until the user chooses to restart.
- **Assisted installs** download when the user clicks **Download**, then offer **Open installer**, **Open disk image** or **Show in folder** with a one-line instruction.
- **What users see:** an item above Settings in the sidebar (update available / downloading with progress / restart or ready), a dialog with the version's notes, a toast once per version and stage, and a status card in **Settings → Updates** with the install type and verification mode.
- **Breaking releases** (`breaking: true` or a new major version) are never downloaded or installed automatically. The dialog shows a warning above the notes, and the user decides.
- **Skip this version** stops the reminders (sidebar item and toasts) until a newer version appears. Settings still lists the skipped version and can download it.
- **Downgrades** are never offered: only strictly newer versions count, using semantic-version ordering where pre-releases sort below their release.
- **Errors:** a failed **Check now** shows the reason. A failed scheduled check keeps whatever the previous check found, so a flaky network doesn't hide a known update.
- **Privacy:** requests go only to github.com (and GitHub's download host), from a separate in-memory session with no cookies and no cache. No identifiers are sent.

## State machine

```
idle ─check─► checking ─► up-to-date | available | ready (file already on disk) | error
available ─download─► downloading(progress) ─► ready | error(update kept, can retry)
ready ─install─► automatic: app quits and the new version starts · assisted: file opened or shown
```

Checks don't interrupt a download in progress or a ready update.

## Process boundaries

The renderer gets the state through `updates:state` and the `updates:changed` event, and can only call `updates:check`, `updates:download`, `updates:install` and `updates:skip` (a version string of at most 64 characters). It never supplies URLs or paths; installation only ever runs the file the main process itself downloaded and verified. The updater code outside `src/main/index.ts` has no Electron imports and is covered by unit tests.

## Security review

| Threat | Mitigation |
| --- | --- |
| Tampered manifest or installer on GitHub (stolen maintainer token) | Ed25519 signature with a key that never touches GitHub except as an encrypted Actions secret; apps with a pinned key reject unsigned or wrongly signed manifests. |
| Network attacker | HTTPS only, to fixed github.com URLs; SHA-256 and size checked before use. |
| Manifest redirects downloads elsewhere | Manifests carry names, not URLs; each name must match its key and version exactly. |
| Downgrade or replay of an old manifest | Only strictly newer versions are offered; a signed old manifest can't install an older build. |
| Renderer compromise triggers an install | IPC carries no URLs or paths; installation only runs files the main process verified, re-checked just before use. |
| File swapped on disk after download | The file is hashed again right before it is installed or opened. |
| Disk filling or stalled downloads | 600 MB cap, the manifest's size enforced while streaming, a 60-second stall timeout, one download at a time; failed files are removed. |
| Signing key lost or mismatched | The release job refuses to publish when the secret is missing or doesn't match the committed key; `update:keygen` refuses to replace a committed key without `--force`. |
| Update testing hooks abused in production | `IWARATV_UPDATE_URL`, `IWARATV_UPDATE_PUBLIC_KEY` and `IWARATV_UPDATE_INSTALL_KIND` are read only by unpackaged development builds. |

## Testing

- `tests/updates.test.ts` covers version ordering, manifest validation, signatures, install-type detection, the installers (including the AppImage swap), the update service against a fake GitHub (background download, breaking and skipped releases, checksum and size failures, pinned keys, downgrades, re-verification, scheduling) and the release scripts.
- The end-to-end smoke test builds a signed release one minor version ahead with `scripts/update-manifest.mjs`, serves it locally and checks that the real app finds, verifies and downloads it without sending cookies.
- In a development build, `IWARATV_UPDATE_URL=http://127.0.0.1:<port>/` points the updater at a folder holding `update.json`, its signature and the files; `IWARATV_UPDATE_PUBLIC_KEY` pins a test key; `IWARATV_UPDATE_INSTALL_KIND` (for example `appimage`) picks an install type. Installing from a development build only shows the file.
- The browser preview shows the UI with `npm run dev:web` and `?update=1` or `?update=breaking`.

## Rollout

1. The first release with the updater attaches `update.json`. Users on 2.0.0 install it manually once; from then on updates find them.
2. The maintainer runs `npm run update:keygen`, adds the `UPDATE_SIGNING_KEY` secret (`gh secret set UPDATE_SIGNING_KEY < <private key file>`) and commits `build/update-public-key.pem`. The next release is signed, and apps built from it only accept signed updates. Doing this before the first updater release means every updating app is signed-only from the start.
3. When code-signing certificates are available, keep the manifest signature anyway: it also protects the assisted macOS and Linux paths, which platform signing doesn't cover.

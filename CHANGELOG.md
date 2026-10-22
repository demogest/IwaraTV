# Changelog

All notable changes to IwaraTV. Versions follow [semantic versioning](https://semver.org/); a major version marks breaking changes. Full notes for each release, including upgrade steps, are in [`docs/release-notes/`](docs/release-notes/) and on the [Releases page](https://github.com/demogest/IwaraTV/releases).

## 2.3.0 — 2026-10-22

See the [2.3.0 release notes](docs/release-notes/v2.3.0.md).

### Changed

- New **Home** page, now the start page: Continue watching, Recently played and Recent searches in one place. Browse shows only the feeds. `Ctrl/⌘+1…7` now starts with Home.

## 2.2.0 — 2026-10-20

See the [2.2.0 release notes](docs/release-notes/v2.2.0.md).

### Added

- Traditional Chinese (繁體中文) and Japanese (日本語). Language follows the system by default: Taiwan, Hong Kong and Macau get Traditional Chinese; any other Chinese variant gets Simplified Chinese. You can pick a language in Settings → General.

### Fixed

- The play button reads naturally in every language ("用外部播放器播放", "Play in external player") and its menu half joins the button instead of showing a rounded notch.
- "Source" and "Preview" quality names, update errors, download errors and Iwara error details are translated instead of showing English.
- Long labels no longer widen the sidebar.
- Windows release builds authenticate the MPV download's GitHub API request, so shared CI runners don't hit the anonymous rate limit.

## 2.1.1 — 2026-10-20

### Fixed

- Closing the window now quits IwaraTV. While signed in, a hidden Iwara page kept the app running for up to 5 minutes, and starting it again in that time showed no window. See the [2.1.1 release notes](docs/release-notes/v2.1.1.md).

## 2.1.0 — 2026-10-20

IwaraTV keeps itself up to date. 2.0 can't update itself, so install 2.1 once by hand; see the [2.1.0 release notes](docs/release-notes/v2.1.0.md).

### Added

- In-app updates. IwaraTV checks GitHub Releases on start and every 6 hours, verifies the release's `update.json` (Ed25519-signed once the project's key is set up) and each file's size and SHA-256, and then installs with a restart (Windows installer, AppImage) or hands over the verified file (portable, ZIP, `.deb`, macOS). Breaking releases are never installed automatically. New **Settings → Updates** page and a sidebar notice. See [docs/auto-update.md](docs/auto-update.md).
- Release job publishes a signed `update.json` and `update.json.sig`; the signing key lives in the tag-only `release` environment. `npm run update:keygen` creates the key pair.

### Fixed

- Release assets no longer include the end-to-end test screenshots.
- macOS install instructions cover macOS 15 and later, where unnotarized apps are opened from System Settings → Privacy & Security.

## 2.0.0 — 2026-10-20 · ⚠️ Breaking

IwaraTV rebuilt on Electron with a redesigned interface. See the [2.0.0 release notes](docs/release-notes/v2.0.0.md) for upgrade steps.

### Breaking changes

- Runtime changed from Tauri to Electron 44. Requires Windows 10+ (64-bit), macOS 13 Ventura+ on Apple Silicon, or 64-bit Linux; macOS 12 and older are no longer supported.
- Iwara sessions and the keyring-stored token from 1.x aren't migrated; sign in again.
- Data folder moved from `local.iwaratv.player` to `IwaraTV`; 1.x data is copied once on first start.
- The Windows installer installs a new app instead of upgrading 1.x; uninstall 1.x first.
- Release asset names changed (`_arm64.dmg`, `_x86_64.AppImage`); the Linux package installs to `/opt/IwaraTV`.
- New installs default to the built-in player.
- Development: the Rust toolchain, `src-tauri` and the Tauri npm scripts are removed.

### Added

- Built-in player with resume, quality switching at the same position, fullscreen and keyboard controls.
- Continue watching, hover frame previews, related videos and more from the author.
- Recent searches and copied-link suggestions, a shortcut list (`?`), compact cards.
- Download progress on the taskbar and completion notifications.
- English and Simplified Chinese, light and dark themes.

### Security

- Sandboxed, context-isolated renderer with a strict CSP and validated IPC; isolated Iwara session; Electron fuses in packaged builds. See [`docs/audit.md`](docs/audit.md).

## 1.0.2 — 2026-05-06

Last Tauri-based release. See the [v1.0.2 release](https://github.com/demogest/IwaraTV/releases/tag/v1.0.2).

<div align="center">
  <img src="src/renderer/assets/iwara-tv-mark.svg" alt="IwaraTV logo" width="80" height="80">
  <h1>IwaraTV</h1>
  <p><a href="README.zh-CN.md">简体中文</a> | English</p>
  <p>
    <a href="https://github.com/demogest/IwaraTV/actions/workflows/build.yml"><img src="https://github.com/demogest/IwaraTV/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
    <a href="https://github.com/demogest/IwaraTV/releases"><img src="https://img.shields.io/github/v/release/demogest/IwaraTV?include_prereleases&amp;sort=semver" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f.svg" alt="License: MIT"></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-44-47848f?logo=electron&amp;logoColor=white" alt="Electron 44"></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61dafb?logo=react&amp;logoColor=111111" alt="React 19"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript 6"></a>
    <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&amp;logoColor=white" alt="Vite 8"></a>
    <a href="#releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Platforms"></a>
  </p>
</div>

IwaraTV is a desktop app for browsing Iwara.tv and watching videos in its built-in player, in MPV, or in another local player. Browse and search feeds, open any video link, follow authors and tags, comment, keep local favorites and history, and download files with resumable, parallel transfers.

This project is independently made and is not affiliated with, sponsored by, or endorsed by Iwara.

## Documentation

- [User Manual](docs/user-manual.en.md) / [用户手册](docs/user-manual.zh-CN.md)
- [Developer Contribution Guide](CONTRIBUTING.md) / [开发者贡献参考](CONTRIBUTING.zh-CN.md)
- [UI/UX and security audit](docs/audit.md)
- [Auto-update design](docs/auto-update.md)

## Highlights

- Latest, trending, popular and followed-tag feeds, with tag filters, a content-rating switch, and hover previews that step through frames of each video.
- One top bar for everything: type to search, paste an Iwara link or video ID to open it, or pick a recent search or a copied link.
- A built-in player that works out of the box, remembers where you stopped, switches quality without losing your place, and has fullscreen and keyboard controls — or one-click MPV and external players.
- Video pages with quality selection, downloads, favorites, author follow, tags, threaded comments, more from the author and related videos.
- A Home page with everything recent: videos you haven't finished, what you played lately and your recent searches.
- Subscriptions from the authors you follow, filterable by author.
- Local favorites with undo, backup, export and import; playback history grouped by day.
- A multi-connection downloader: up to 16 connections per file with work stealing between them, automatic reconnects for dropped or stalled connections, resume after cancel or restart, a queue with a configurable number of simultaneous downloads, per-part progress, speed/ETA, taskbar progress and completion notifications.
- Sign in on Iwara's own page in a separate window; the app never sees your password.
- English, Simplified Chinese, Traditional Chinese and Japanese, light and dark themes, large or compact cards, keyboard shortcuts (press `?`), collapsible sidebar.
- Troubleshooting tools: compare formats with the website, speed-test CDN hosts, refresh the X-Version salt.
- Updates itself from GitHub Releases: checks signatures and checksums, installs with a restart where it can (Windows installer, AppImage) and hands you the verified file where the system installs it. Breaking releases always ask first.

## Requirements

- To run IwaraTV: Windows 10 or later (64-bit), macOS 13 Ventura or later on Apple Silicon, or 64-bit Linux.
- Node.js 24.14.1+ and npm 11.11.0+ (see `.node-version`).
- Nothing extra for playback: the built-in player works everywhere. MPV is optional (bundled in Windows release builds).

## Development

```bash
npm ci
npm run dev
```

`npm run dev` starts the full Electron app with hot reload. `npm run dev:web` opens just the UI in a browser at http://127.0.0.1:5175 with fake data, which is handy for layout work (add `?lang=zh-CN` / `zh-TW` / `ja`, `?theme=light`, `?update=1`, `?signedIn=0` or `?empty=1` to the URL).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the desktop app with hot reload. |
| `npm run dev:web` | Preview the UI in a browser with mock data. |
| `npm run typecheck` | Type-check the renderer and the main/preload/test code. |
| `npm test` | Run the Vitest unit, boundary and security tests. |
| `npm run test:e2e` | Build, then drive the real app against a mock Iwara server (Linux: wrap in `xvfb-run -a`). |
| `npm run build` | Build main, preload and renderer into `out/`. |
| `npm start` | Run the last build. |
| `npm run pack` | Build an unpacked app into `release/` for a quick local check. |
| `npm run dist:win` / `dist:mac` / `dist:linux` | Build installers with electron-builder. |
| `npm run check:release` | Version check, typecheck and unit tests. |
| `npm run version:update -- patch` | Bump the version in `package.json` and `package-lock.json`. Also accepts `minor`, `major` or an exact version. |
| `npm run update:keygen` | Create the key pair that signs update manifests (maintainers, once). |

Windows packaging with bundled MPV:

```bash
npm run mpv:update
npm run dist:win
```

Windows builds produce `IwaraTV_<version>_x64-setup.exe`, `IwaraTV_<version>_x64-portable.exe` and `IwaraTV_<version>_x64-unpacked.zip`; macOS builds a `.dmg`; Linux builds `.deb` and `.AppImage`.

## Architecture

- `src/main` — Electron main process: Iwara API client, the Iwara browser session, downloads, player launch, settings and favorites stores, IPC handlers.
- `src/preload` — the only bridge into the page: an allowlisted `window.iwaraTV.invoke/on`.
- `src/renderer` — React UI (views, components, state, i18n, styles).
- `src/shared` — types, the IPC contract, error codes and helpers used by both sides.
- `tests` — unit, boundary and security tests; `tests/e2e` holds the smoke test and mock server.

The renderer runs sandboxed with context isolation and no Node.js access, is served from a private `app://` scheme under a strict Content-Security-Policy, and can only call the channels declared in `src/shared/ipc.ts`. The built-in player streams from a private `iwara-media://` scheme: the main process fetches the media through the Iwara session (Range requests, referrer, token) and only for streams it handed out itself. Iwara pages (sign-in and verification) open in separate sandboxed windows with their own session and no preload. Packaged builds disable Electron's run-as-Node, `NODE_OPTIONS` and inspector fuses.

Upgrading from the Tauri version: settings, favorites and download history are imported automatically on first launch. You need to sign in again. Your default player stays MPV (or your external player); new installs default to the built-in player. On Windows, uninstall 1.x first and keep its app data; the `.deb` upgrades the 1.x package in place. See the [2.0 release notes](docs/release-notes/v2.0.0.md).

## Releases

Use `npm run version:update -- <major|minor|patch|x.y.z>` before a release; `npm run version:check` verifies that `package.json` and `package-lock.json` agree.

The `Build` workflow runs the version check, typecheck, unit tests and the end-to-end smoke test on every pull request and push. When the version changes on `main` it tags the commit; the tag build packages Windows, macOS and Linux artifacts and publishes a GitHub Release with checksums and the `update.json` manifest the in-app updater reads. Once `build/update-public-key.pem` and the `release` environment's `UPDATE_SIGNING_KEY` secret are set up, the manifest is signed and apps accept only signed updates; see [docs/auto-update.md](docs/auto-update.md).

## License

IwaraTV is released under the [MIT License](LICENSE).

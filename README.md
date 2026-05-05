# IwaraTV

[![Build](https://github.com/demogest/IwaraTV/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/demogest/IwaraTV/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/demogest/IwaraTV?include_prereleases&sort=semver)](https://github.com/demogest/IwaraTV/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-b7410e?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vite.dev/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)](#releases)

![IwaraTV logo](src/assets/iwara-tv-mark.svg)

IwaraTV is a local desktop browser and player launcher for Iwara.tv. The app keeps the React UI light and fast while a native Tauri/Rust backend owns session handling, Iwara API access, settings, diagnostics, downloads, and player launch.

This project is independently made and is not affiliated with, sponsored by, or endorsed by Iwara.

## Highlights

- Browse recent, trending, popular, followed-tag, subscribed-author, and author-filtered feeds.
- Open Iwara video IDs or URLs directly from the top bar.
- Follow or unfollow authors from the video detail panel or author page.
- Launch MPV or a configured external player with a selected quality.
- Download videos to a configured local folder with preferred quality fallback.
- Keep local playback history and player/media-host preferences.
- Use an embedded verification window for login and Cloudflare/session setup.
- Diagnose video formats, X-Version salt, media hosts, and captured network responses.
- Build native Windows, macOS, and Linux packages through GitHub Actions.

## Screens

The first screen is the working app: browse feeds, open a video, choose a quality, and play or download immediately. Settings cover login/session state, MPV/external player paths, download defaults, media-host speed tests, X-Version sniffing, and tag preferences.

## Requirements

- Node.js 24.14.1+
- npm 11.11.0+
- Rust stable
- Tauri system dependencies for your platform

## Development

```bash
npm ci
npm run icons:build
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run dev:tauri
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite UI preview. |
| `npm run dev:tauri` | Run the full desktop app with Tauri commands. |
| `npm run typecheck` | Type-check the React/TypeScript UI. |
| `npm test` | Run Vitest tests. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust tests. |
| `npm run build:web` | Build the web UI into `dist`. |
| `npm run build` | Build the Tauri app. |
| `npm run check:release` | Run TypeScript, Vitest, and Rust release-gate checks. |
| `npm run release:portable:win` | Package the current Windows release build as a portable EXE and unpacked ZIP. |
| `npm run release:win` | Run release checks, then build the Windows NSIS installer, portable EXE, and unpacked ZIP. |
| `npm run release:win:fast` | Build the Windows release artifacts without rerunning checks. |

Windows packaging with bundled MPV:

```bash
npm run mpv:update
npm run dist:win
```

Release builds use Rust LTO, a single codegen unit, stripped symbols, and panic aborts. Tauri devtools are only enabled through `npm run dev:tauri`, so packaged builds do not carry the development tooling feature. Windows releases write an NSIS installer plus `release/IwaraTV_<version>_x64-portable.exe` and `release/IwaraTV_<version>_x64-unpacked.zip`.

## Architecture

The `main` branch is the Tauri/Rust desktop app. The former Electron implementation is deprecated and should stay on historical branches only.

- `src-tauri/src` owns native app work: Iwara API, auth, session capture, settings, downloads, player launch, X-Version, diagnostics, and OS integration.
- `src` is the Vite/React UI entrypoint.
- `src/lib` contains browser-safe UI types and helpers.
- `src/tauri` contains the small web-to-Rust command API.
- `tests` covers UI helpers and command boundary expectations.

## Releases

The `Build` workflow runs checks on pull requests, compiles release artifacts when the package version changes on `main`, and also supports manual artifact builds. Version tags like `v1.0.0` publish a GitHub Release with the generated bundles and checksums.

## License

IwaraTV is released under the [MIT License](LICENSE).

# IwaraTV

![IwaraTV logo](src/assets/iwara-tv-mark.svg)
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fdemogest%2FIwaraTV.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2Fdemogest%2FIwaraTV?ref=badge_shield)

IwaraTV is a local desktop browser and player launcher for Iwara.tv. It keeps the React UI lightweight while using a native Tauri backend for settings, session handling, diagnostics, and launching MPV or another external player.

This project is independently made and is not affiliated with or endorsed by Iwara.

## Features

- Browse recent, trending, popular, followed-tag, and author-filtered video feeds.
- Open Iwara video IDs or URLs directly.
- Launch MPV or a configured external player with the selected quality.
- Keep local playback history and player/media-host preferences.
- Use an embedded verification window for site session setup.
- Diagnose video format and network capture issues from inside the app.
- Build native Windows, macOS, and Linux packages through GitHub Actions.

## Development

Requirements:

- Node.js 24.14.1+
- npm 11.11.0+
- Rust stable
- Tauri system dependencies for your platform

Common commands:

```bash
npm ci
npm run icons:build
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run dev:tauri
npm run build
```

## Mainline

The `main` branch is now the Tauri/Rust desktop app. The former Electron desktop implementation is deprecated and no longer maintained; keep any legacy Electron work on historical branches only.

## Architecture Boundaries

- `main` is the Tauri/Rust desktop branch.
- `src-tauri/src` owns all native app work: Iwara API, session, auth, settings, player launch, X-Version, diagnostics, and OS integration.
- `src` is the Vite web UI entrypoint.
- `src/lib` contains browser-safe UI types and helpers only.
- `src/tauri` contains the small web-to-Rust command API.

Windows packaging with bundled MPV:

```bash
npm run mpv:update
npm run dist:win
```

## Releases

The `Build` workflow compiles Windows, macOS, and Linux artifacts on pushes, pull requests, manual runs, and version tags. Pushing a tag like `v0.2.0` publishes a GitHub Release with the generated bundles.


## License
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fdemogest%2FIwaraTV.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2Fdemogest%2FIwaraTV?ref=badge_large)
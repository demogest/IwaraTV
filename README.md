<div align="center">
  <img src="src/assets/iwara-tv-mark.svg" alt="IwaraTV logo" width="80" height="80">
  <h1>IwaraTV</h1>
  <p><a href="README.zh-CN.md">简体中文</a> | English</p>
  <p>
    <a href="https://github.com/demogest/IwaraTV/actions/workflows/build.yml"><img src="https://github.com/demogest/IwaraTV/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
    <a href="https://github.com/demogest/IwaraTV/releases"><img src="https://img.shields.io/github/v/release/demogest/IwaraTV?include_prereleases&amp;sort=semver" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f.svg" alt="License: MIT"></a>
    <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-2.x-24c8db?logo=tauri&amp;logoColor=white" alt="Tauri 2.x"></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61dafb?logo=react&amp;logoColor=111111" alt="React 19"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript 6"></a>
    <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-stable-b7410e?logo=rust&amp;logoColor=white" alt="Rust stable"></a>
    <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&amp;logoColor=white" alt="Vite 8"></a>
    <a href="#releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="Platforms"></a>
  </p>
</div>

IwaraTV is a local desktop browser and player launcher for Iwara.tv. The app keeps the React UI light and fast while a native Tauri/Rust backend owns session handling, Iwara API access, settings, diagnostics, downloads, and player launch.

This project is independently made and is not affiliated with, sponsored by, or endorsed by Iwara.

## Documentation

- [User Manual](docs/user-manual.en.md) / [用户手册](docs/user-manual.zh-CN.md)
- [Developer Contribution Guide](CONTRIBUTING.md) / [开发者贡献参考](CONTRIBUTING.zh-CN.md)

## Highlights

- Browse recent, trending, popular, followed-tag, subscribed-author, and author-filtered feeds.
- Open Iwara video IDs or URLs directly from the top bar.
- Follow or unfollow authors from the video detail panel or author page.
- Save local favorites, then back up, export, or import the favorites list.
- Launch MPV or a configured external player with a selected quality.
- Download videos to a configured local folder with preferred quality fallback.
- Keep local playback history and player/media-host preferences.
- Use an embedded verification window for login and Cloudflare/session setup.
- Diagnose video formats, X-Version salt, media hosts, and captured network responses.
- Build native Windows, macOS, and Linux packages through GitHub Actions.

## App Flow

The first screen is the working app: browse feeds, open a video, choose a quality, and play, favorite, or download immediately. Settings cover login/session state, MPV/external player paths, download defaults, media-host speed tests, X-Version sniffing, and tag preferences.

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
| `npm run version:check` | Verify that npm, Tauri, and Cargo version metadata match. |
| `npm run version:update -- patch` | Bump every app version reference together. Also accepts `minor`, `major`, or an exact version. |
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

Use `npm run version:update -- patch` before a release to keep `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` in sync. Run `npm run version:check` if you need to verify the metadata without changing it.

The `Build` workflow runs checks on pull requests, compiles release artifacts when the package version changes on `main`, and also supports manual artifact builds. Version tags like `v1.0.0` publish a GitHub Release with the generated bundles and checksums.

## License

IwaraTV is released under the [MIT License](LICENSE).

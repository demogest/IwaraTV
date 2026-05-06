# Developer Contribution Guide

[简体中文](CONTRIBUTING.zh-CN.md) | English

Thanks for helping improve IwaraTV. This guide is for contributors who want to build, test, debug, or extend the desktop app.

IwaraTV is independent and is not affiliated with, sponsored by, or endorsed by Iwara.

## Project Shape

The mainline app is a Tauri 2 desktop application:

- `src`: Vite, React, and TypeScript UI.
- `src/lib`: Browser-safe types and UI helper utilities.
- `src/tauri`: The typed web-to-Tauri command wrapper.
- `src-tauri/src`: Rust backend for Iwara API access, auth, session capture, settings, favorites, downloads, playback, diagnostics, and OS integration.
- `src-tauri/capabilities`: Tauri permission surface for the main window.
- `tests`: Vitest coverage for browser-safe helpers and command boundary expectations.
- `.github/workflows/build.yml`: CI checks, package builds, and release publishing.

The legacy Electron implementation is deprecated and should not be reintroduced on `main`.

## Prerequisites

- Node.js `24.14.1` or newer. The repository includes `.node-version`.
- npm `11.11.0` or newer.
- Rust stable. The Rust crate declares `rust-version = "1.77.2"`.
- Tauri system dependencies for your platform.
- MPV for playback testing, unless you are only changing code paths that do not launch playback.

On Windows packaging flows, `npm run mpv:update` downloads a current MPV build into `vendor/mpv`. It requires network access and should be run intentionally.

## First-Time Setup

```bash
npm ci
npm run icons:build
npm run dev:tauri
```

`npm run dev` starts only the Vite UI preview. It is useful for layout work, but Tauri commands are unavailable there. Use `npm run dev:tauri` when testing settings, login, downloads, playback, dialogs, clipboard, or OS integration.

## Quality Gates

Run the smallest relevant checks while developing, then run the full release gate before a PR that touches behavior:

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:release
```

Useful build commands:

| Command | Purpose |
| --- | --- |
| `npm run build:web` | Build the Vite UI into `dist`. |
| `npm run build` | Build the Tauri app. |
| `npm run version:check` | Verify that all app version references are synchronized. |
| `npm run version:update -- patch` | Update npm, Tauri, and Cargo version metadata together. |
| `npm run release:win` | Run checks, build the Windows NSIS installer, and package portable artifacts. |
| `npm run release:win:fast` | Build Windows release artifacts without rerunning checks. |
| `npm run dist:win` | Update bundled MPV, rebuild icons, and run the Windows release flow. |

## Coding Guidelines

- Prefer existing module boundaries over new cross-cutting abstractions.
- Keep browser runtime code free of Node.js APIs. `tests/tauri-boundary.test.ts` guards this boundary.
- Keep Tauri commands typed in both directions: Rust models in `src-tauri/src/models.rs`, TypeScript mirrors in `src/lib/types.ts`, and command wrappers in `src/tauri/api.ts`.
- Keep settings migrations tolerant. `settings.rs` merges stored JSON with defaults so older settings files keep working.
- Avoid storing secrets in JSON files. API credentials belong in the OS keyring when available; WebView session data should stay in the WebView session surface.
- Preserve user data behavior. Changes to `settings.json`, `downloads.json`, history, or auth state should include a migration or compatibility plan.
- Prefer explicit errors with user-actionable messages. The UI classifies common issues in `src/lib/issue-utils.ts`.

## Adding A Tauri Command

When adding a new command:

1. Add or update shared data structures in `src-tauri/src/models.rs`.
2. Implement the command in `src-tauri/src/commands.rs`.
3. Register it in `tauri::generate_handler!` in `src-tauri/src/lib.rs`.
4. Add the command string to `commandMap` in `src/tauri/api.ts`.
5. Expose a typed wrapper from `tauriApi`.
6. Update TypeScript types in `src/lib/types.ts`.
7. Add or update `tests/tauri-api.test.ts`.
8. Check `src-tauri/capabilities/default.json` if the feature needs new plugin permissions.

## Feature Areas

- **Iwara API and parsing**: Keep request logic in `iwara_client.rs` and parsing helpers close to the API response shape.
- **Session and Cloudflare verification**: Keep browser-session work in `session.rs`; avoid leaking raw token or cookie details into UI logs.
- **Playback**: Keep player resolution and process launching in `player.rs`; external-player argument parsing belongs in `player_template.rs`.
- **Favorites**: Keep local favorite persistence, import, export, backup, and merge behavior in `favorites.rs`.
- **Downloads**: Keep queue/history behavior in `downloads.rs`; file naming, format choice, and segmented transfer planning live near the Iwara client download path.
- **Settings**: Defaults, normalization, and compatibility live in `settings.rs`.
- **Media host speed tests**: Shared browser-safe normalization helpers live in `src/lib/media-speed-utils.ts`; Rust routing should stay in `media_speed.rs`.

## Pull Request Checklist

- Describe the user-visible behavior and affected platform(s).
- Link the issue or explain the motivation.
- Include screenshots or short clips for visible UI changes.
- Include the commands you ran, especially `npm run typecheck`, `npm test`, and Rust tests.
- Note any checks you could not run.
- Do not commit generated release artifacts unless the change is specifically about packaging output.
- Do not include personal settings, tokens, downloaded videos, or local WebView/session data.

## Release Notes

Use `npm run version:update -- patch` for patch releases, `npm run version:update -- minor` or `major` for larger bumps, or pass an exact semver such as `npm run version:update -- 1.2.3`. The script updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `iwaratv` entry in `src-tauri/Cargo.lock`. Use `npm run version:check` before publishing if you only need to confirm that the metadata is aligned.

The GitHub `Build` workflow runs checks on pull requests. On `main`, release artifacts are built when `package.json` version changes or when a version tag such as `v1.0.0` is pushed. Tagged releases publish generated assets and checksums through GitHub Releases.

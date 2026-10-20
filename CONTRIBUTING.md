# Developer Contribution Guide

[简体中文](CONTRIBUTING.zh-CN.md) | English

Thanks for helping improve IwaraTV. This guide is for contributors who want to build, test, debug, or extend the desktop app.

IwaraTV is independent and is not affiliated with, sponsored by, or endorsed by Iwara.

## Project Shape

IwaraTV is an Electron app built with electron-vite:

- `src/main` — the main process.
  - `index.ts` — app lifecycle, the `app://` protocol, window creation and hardening, OS integration.
  - `backend.ts` — wires stores and services together; one method per IPC channel.
  - `ipc-handlers.ts` / `ipc.ts` — channel → handler and channel → validator tables, and their registration.
  - `services/` — `iwara-client` (API, file lists, comments, follows, speed tests), `iwara-session` (the `persist:iwara` browser session, sign-in window, page-context fetch, network capture), `download-manager`, `player-service`, `settings-store`, `favorite-store`, `update-service` (the updater).
  - `lib/` — Electron-free helpers: X-Version, JWT detection, response parsing, file transfer, JSON files, legacy data migration, versions and update manifests/installers.
- `src/preload/index.ts` — exposes `window.iwaraTV` with allowlisted `invoke` and `on`.
- `src/renderer` — React UI: `views/`, `components/`, `state/` (app state, navigation, toasts, confirm dialogs), `hooks/`, `i18n/` (`en.ts`, `zh-CN.ts`, `zh-TW.ts`, `ja.ts`), `styles/`, and `dev/mock-bridge.ts` for the browser preview.
- `src/shared` — types, the IPC contract (`ipc.ts`), error codes, CSP and helpers shared by both processes.
- `tests` — Vitest suites; `tests/e2e` — the Playwright smoke test and mock Iwara server.
- `.github/workflows/build.yml` — CI checks, packaging and release publishing.

## Prerequisites

- Node.js `24.14.1` or newer (`.node-version`) and npm `11.11.0` or newer.
- MPV for playback testing.
- Linux only, for `npm run test:e2e`: `xvfb` (or a desktop session) and `openssl`.

On Windows packaging flows, `npm run mpv:update` downloads a current MPV build into `vendor/mpv`. It requires network access and should be run intentionally.

## First-Time Setup

```bash
npm ci
npm run dev
```

The Electron binary is downloaded on first use. `npm run dev:web` serves only the UI with a mock backend (`src/renderer/dev/mock-bridge.ts`); query parameters `lang`, `theme`, `signedIn=0` and `empty=1` switch the fake state.

## Quality Gates

```bash
npm run typecheck
npm test
npm run test:e2e        # Linux: xvfb-run -a npm run test:e2e
npm run check:release
```

The unit suites cover the Iwara client against a fake fetch, downloads against a local Range server, stores, the player service, the updater (`tests/updates.test.ts`), IPC validation, translations, and static boundary/security rules (`tests/boundaries.test.ts`). The smoke test builds the app and walks through browsing, hover previews, search and recent searches, the shortcut list, MPV playback (with a stub MPV), built-in playback of a real clip (`tests/e2e/fixtures/sample.mp4`) with fullscreen, resume and Continue watching, related videos, downloads, favorites, sign-in, subscriptions, following, commenting, settings, a signed update served from a local folder, and sign-out against `tests/e2e/mock-iwara.mjs`, saving screenshots to `test-results/e2e/`. Set `IWARATV_E2E_EXECUTABLE` to run it against a packaged app instead of `out/` (only for builds without the inspector fuse, since Playwright attaches through it).

## Coding Guidelines

- Keep the process boundaries: the renderer never imports Node.js, Electron or `src/main`; `src/shared` imports nothing outside itself; the preload imports only `electron` and the IPC contract. `tests/boundaries.test.ts` enforces this.
- Never weaken `webPreferences` (`sandbox`, `contextIsolation`, `nodeIntegration: false`, `webSecurity`), the CSP, the navigation and permission handlers, or the IPC sender check.
- Keep `src/main/lib` and the services other than `iwara-session` free of Electron imports so they stay unit-testable; pass Electron features in through `SessionPort` and `PlatformPort`.
- Throw `AppError` with a specific `AppErrorCode`. The renderer maps codes to localized titles, details and recovery actions in `src/renderer/lib/errors.ts`.
- Add every user-visible string to all four dictionaries (`en.ts`, `zh-CN.ts`, `zh-TW.ts`, `ja.ts`); the type system and `tests/renderer.test.ts` check keys and placeholders. Write whole sentences rather than splicing names into them, because word order and spacing differ between languages. Main-process errors that reach the screen carry a `reason` in their details, translated under `errors.<CODE>.reasons`. Supported locales and system-language matching live in `src/shared/locales.ts`.
- Keep settings tolerant: `normalizeSettings` merges stored JSON over defaults and clamps values, so old files keep working.
- Don't log tokens, cookies or signed media URLs; use `safeUrl` for diagnostics.

## Adding An IPC Channel

1. Add request/response types to `src/shared/types.ts` if needed.
2. Declare the channel in `InvokeContract` and `INVOKE_CHANNELS` in `src/shared/ipc.ts`.
3. Implement the method on `Backend` (`src/main/backend.ts`).
4. Add the handler and an argument validator in `src/main/ipc-handlers.ts` — validators must reject anything unexpected and copy only known fields.
5. Call it from the renderer with `invoke("your:channel", …)` from `src/renderer/lib/api.ts`, and add it to `src/renderer/dev/mock-bridge.ts`.
6. Add a happy-path sample to `tests/ipc.test.ts` (it fails until every channel has one) and tests for the new behavior.

## Pull Request Checklist

- Describe the user-visible behavior and affected platform(s).
- Link the issue or explain the motivation.
- Include screenshots for visible UI changes (both themes when colors change).
- List the commands you ran: `npm run typecheck`, `npm test`, `npm run test:e2e`.
- Don't commit build output (`out/`, `release/`), test screenshots, personal settings, tokens, downloaded videos or session data.

## Release Notes

Use `npm run version:update -- patch` (or `minor`, `major`, or an exact semver such as `1.2.3`). It updates `package.json` and `package-lock.json`; electron-builder reads the version from there. `npm run version:check` confirms they agree.

The GitHub `Build` workflow runs checks on pull requests and pushes. On `main`, a version change creates a `v*` tag and dispatches a tag build, which packages Windows (NSIS installer, portable EXE, ZIP), macOS (DMG) and Linux (DEB, AppImage) and publishes a GitHub Release with `SHA256SUMS.txt` and `update.json`, the manifest the in-app updater reads.

Update signing is set up once by a maintainer: run `npm run update:keygen`, store the private key it writes (outside the repository) as the `UPDATE_SIGNING_KEY` secret of the `release` environment, which only `v*` tags may use, and commit `build/update-public-key.pem` (step by step in [docs/auto-update.md](docs/auto-update.md#setting-up-signing)). From then on the release job signs `update.json` and refuses to publish without a matching key, and apps built from that commit accept only signed updates. Never replace the committed public key unless the private key is lost or leaked: installed apps would reject every later update. To try the updater in a development build, point `IWARATV_UPDATE_URL` at a local folder with a manifest made by `scripts/update-manifest.mjs`; see [docs/auto-update.md](docs/auto-update.md#testing).

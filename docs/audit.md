# IwaraTV Electron Rewrite — UI/UX and Security Audit

Date: 2026-10-19 · Baseline: `main` at `cdc43fa` (Tauri 2 + Rust, version 1.0.2) · Result: Electron 44 app on branch `claude/affectionate-ritchie-xqj8xn`

This report covers the port from Tauri to Electron, the redesigned interface, and an audit of both the old and the new app. Findings are marked **Fixed** (changed in this rewrite), **Mitigated** (reduced, with residual risk), or **Open** (recommended follow-up).

## Summary

- The Rust backend (about 7,300 lines in 16 files) was ported to a TypeScript main process. The single 4,205-line `App.tsx` was replaced by a React renderer split into views, components, state and i18n modules. All user-facing features carried over: feeds, search, subscriptions, the video page, comments, following, favorites, downloads, history, settings, MPV and external players, sign-in and verification, diagnostics, CDN speed tests and X-Version salt detection.
- Security posture improved on every boundary. The old main webview ran with **no Content-Security-Policy** (`"csp": null`) and with `withGlobalTauri: true`, so any script that ran in the page had the full command API. The new renderer is sandboxed and context-isolated, has no Node.js, runs under a strict CSP on a private `app://` scheme, and reaches the backend only through 40 allowlisted, runtime-validated IPC channels that check the sender (37 at the time of the audit, 3 added in the follow-up).
- The UI was redesigned around a sidebar, a single search-or-open bar, and a video page with clear primary actions. It is now available in English and Simplified Chinese (the old UI was Chinese-only), in light and dark themes, and with full keyboard support. Errors map to specific, actionable messages.
- Six functional bugs from the Tauri version were fixed along the way (see [Bugs fixed](#bugs-fixed-from-the-tauri-version)). An independent review of the new main process found ten more issues, all fixed before release (R-1 to R-10). A follow-up added a built-in player with resume, hover previews, related videos, Continue watching, download notifications and more ([Follow-up](#follow-up-improvements-after-the-audit)). Verification: 132 unit, boundary and security tests, a 20-step end-to-end smoke test (also run against a packaged Linux build before the follow-up), live checks against iwara.tv, and screenshot review.

## Method

1. **Code review** of the Tauri app: Rust modules, Tauri config and capabilities, and the React UI.
2. **Live verification** against iwara.tv (browsing and reading only): feeds, search, video file lists signed with X-Version, comments, salt detection, CDN discovery and speed tests across 8 hosts, a real 5 MB download and deletion, hidden-page network capture, and the sign-in window lifecycle (opened and closed without credentials).
3. **Automated tests:** Vitest suites (Iwara client with a fake fetch, downloads against a local HTTP Range server, stores, player service, IPC validation, translations, static boundary and hardening rules), plus a Playwright end-to-end test driving the real Electron app against a mock HTTPS Iwara server (`tests/e2e`).
4. **Packaged-build checks:** an electron-builder Linux build with fuses read back from the binary, launched with hostile `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` values and inspected over CDP.
5. **UI review:** screenshots of every view in both themes and languages, at narrow widths, in empty, loading and error states, with menus, dialogs, focus rings and active downloads. Screenshots use synthetic thumbnails only.
6. **Dependencies:** `npm audit`.
7. **Independent review:** a separate reviewer audited the new main process (IPC, session, downloads, players, protocol handler) without seeing this report. Its findings are listed as R-1 to R-10, each checked against the code before being fixed.

## Architecture: before and after

| Area | Tauri (before) | Electron (after) |
| --- | --- | --- |
| Backend | Rust (`src-tauri/src`, reqwest, keyring) | TypeScript main process (`src/main`), Chromium network stack via `session.fetch` |
| UI | One 4,205-line component, 55 `useState` hooks, Chinese strings inline | `src/renderer`: 10 views, shared components, state providers, typed i18n |
| Bridge | `window.__TAURI__` global with 34 commands; argument checks came only from serde types | Preload exposes `invoke`/`on` for declared channels only; every argument validated at runtime |
| Page origin | `tauri://` / localhost, **no CSP** | `app://iwaratv` with a strict CSP (meta tag plus response header) |
| Iwara sign-in | WebView window sharing the app's webview profile | Separate `persist:iwara` partition, sandboxed, no preload, navigation pinned to `*.iwara.tv` |
| Token storage | API token copied into the OS keyring | The token stays in Iwara's own site storage inside the partition; it is read on demand and never sent to the renderer |
| Packaging | Tauri bundler | electron-builder (NSIS, portable and ZIP; DMG; DEB and AppImage) with hardened fuses |

## Security audit

### Threat model

- **Untrusted content:** everything from Iwara (titles, descriptions, comments, usernames, image and media URLs, file lists) is rendered in the app or passed to local players. Remote Iwara pages run Iwara's own scripts.
- **Privileged sinks:** process launch (MPV and external players), the filesystem (downloads, deletes, imports and exports), `shell.openExternal`, the clipboard, and the Iwara session token.
- **Out of scope:** a local attacker who already runs code as the user, and compromise of Iwara itself beyond serving hostile content.

### Controls in the new app

| Control | Where | Verified by |
| --- | --- | --- |
| `sandbox`, `contextIsolation`, `nodeIntegration: false`, `webSecurity` on every window; DevTools only in unpackaged builds | `src/main/index.ts`, `iwara-session.ts` | `tests/boundaries.test.ts`; the renderer has no `require` or `process` in the fused build |
| CSP `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`; images only from `self`, `data:`, `blob:` and `https://*.iwara.tv`; plus `frame-ancestors 'none'` and `nosniff` headers | `src/shared/csp.ts`, `app://` handler | boundary test; e2e asserts no renderer errors |
| Private `app://` scheme with a path-traversal guard and malformed-URL handling, instead of `file://` | `registerAppProtocol` | packaged-build launch |
| IPC allowlist in the preload; the main process rejects senders other than the main window's top frame on the app origin; validators drop unknown fields and bound string and list sizes | `src/preload`, `src/main/ipc*.ts` | `tests/ipc.test.ts` (all 40 channels) |
| Navigation and popups denied; only `http(s)` links go to the system browser; `<webview>` blocked; every permission request denied (both sessions); single-instance lock | `index.ts`, `hardenRemoteWindow` | boundary test |
| Iwara windows: own partition, no preload, no app IPC, muted hidden helpers that close after 5 minutes idle | `iwara-session.ts` | boundary test, e2e sign-in |
| Players: arguments passed as an argv array (no shell); MPV gets `--` before the URL; external templates require `{url}` | `player-service.ts` | `tests/player.test.ts`, e2e |
| Downloads: names sanitized (reserved Windows names, separators, control characters, length); video extensions only; files written only inside the chosen folder; deleting a record removes only files the app created and that no other record or running download uses | `download-files.ts`, `download-manager.ts` | `tests/downloads.test.ts` |
| The token never reaches the renderer, and only goes to `https://*.iwara.tv`: API calls refuse other URLs, media and file-list URLs from the API are filtered, the session strips `Authorization` from any main-process request that leaves iwara.tv (including redirect hops), the CDN pool accepts only `*.iwara.tv`, and diagnostics strip signed query strings | `iwara-client.ts`, `iwara-parse.ts`, `iwara-session.ts`, `settings-store.ts` | `tests/iwara-client.test.ts`, `tests/main-lib.test.ts`, e2e redirect step |
| Fuses: RunAsNode, `NODE_OPTIONS` and CLI inspector off; app loads only from the asar; no extra `file://` privileges | `electron-builder.yml` | `@electron/fuses read` and a hostile-environment launch |

### Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| S-1 | High | **No CSP and a global command API in the main webview.** `tauri.conf.json` set `"csp": null` and `withGlobalTauri: true`, so a script injected through any rendering bug, or loaded from a remote origin, could call every registered command, including downloads into any folder, player launch and the token flows. | **Fixed**: strict CSP, sandboxed renderer, allowlisted bridge, sender check and runtime validation (see the controls table). |
| S-2 | Medium | **Option injection into MPV.** The media URL from the API was passed as MPV's last argument with no end-of-options marker, so a value beginning with `--` (for example `--script=…`) would be read as an MPV option. | **Fixed**: `--` comes before the URL; covered by a unit test and the e2e test. |
| S-3 | Medium | **Token detection accepted any dotted string.** The Rust capture treated any `a.b.c` value from site storage (hostnames, version strings) as a JWT and could send it as a Bearer token. | **Fixed**: candidates must decode to a JWT header and payload; access tokens are preferred over refresh tokens; tested. |
| S-4 | Medium | **Deleting a download removed the file without confirmation.** One click deleted both the record and the video. | **Fixed**: a confirmation dialog offers "Remove from list" or "Delete file". Deleting unfinished records removes only partial files. |
| S-5 | Info | **Sign-in window shared the app's webview profile.** Iwara's pages used the same cookie and cache store as the app UI, so isolation relied on origin separation alone. | **Fixed**: separate partition with no preload and no IPC. Iwara's referrer and origin headers are added only to requests the main process makes. |
| S-6 | Low | **Packaged-binary abuse.** A stock Electron binary honours `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, which lets the signed app be used as a generic Node runtime. | **Fixed** with fuses, verified on the Linux build. |
| S-7 | Low | **Build-time dependency advisory.** `npm audit` reports 8 moderate issues, all from one `sprintf-js` DoS (GHSA-hp3w-g68c-fv3c) reached through electron-builder → `@electron/get` → `global-agent` → `roarr`. Nothing from this chain ships in the app, and there are no production dependencies (`npm audit --omit=dev`: 0). | **Open**: update electron-builder when a fixed release ships. `npm audit fix --force` would downgrade it, so it was not applied. |
| S-8 | Info | **No code signing or notarization.** Windows SmartScreen and macOS Gatekeeper warn on first run, and the asar-integrity fuse is left off until signing is in place, because it can't be verified here. | **Open**: add signing certificates to CI, then enable `enableEmbeddedAsarIntegrityValidation`. |
| S-9 | Info | **Session data at rest.** Cookies and site storage in `Partitions/iwara` are stored like a normal browser profile. The cookie-encryption fuse is off because unsigned macOS builds would show a keychain prompt after every update. | **Open**: enable with code signing. |
| S-10 | Info | **No auto-update.** Users update by downloading releases, so old Electron versions may stay in use. | **Fixed** after 2.0.0: a built-in updater reads a signed `update.json` from GitHub Releases, verifies size and SHA-256, installs with a restart where possible and never installs breaking releases on its own. See [auto-update.md](auto-update.md). |
| S-11 | Info | **Legacy keyring entry.** The Tauri app's token in the OS keyring (service `IwaraTV`) is not migrated or removed; users sign in again. | Accepted; documented in the README and user manual. |

### Findings from the independent review of the new code

| ID | Severity | Finding | Fix |
| --- | --- | --- | --- |
| R-1 | Medium-high | **Session token could reach non-Iwara hosts.** API requests added `Authorization` to any URL, including a `fileUrl`, file-list `src` URLs and every `<script>` on the home page used for salt detection. Testing also showed that Chromium's `session.fetch` **keeps `Authorization` on cross-origin redirects**. | API calls accept only `https://*.iwara.tv`; format URLs elsewhere are dropped; scripts and pages are fetched without the token, and only from iwara.tv; a `webRequest` guard strips `Authorization` from any main-process request (or redirect hop) that leaves iwara.tv. The e2e step "keeps the session token on iwara.tv across redirects" fails without the guard. |
| R-2 | Medium | **Executable download extensions.** With no MIME type, the extension came from the URL path (any 1–8 characters), so a `.bat`, `.hta` or `.command` file could be saved and run via "Play file", with no Mark-of-the-Web prompt. | Only mp4, m4v, webm, mkv and mov; anything else becomes `.mp4`. |
| R-3 | Medium | **Data loss on record removal.** Removing an old failed record deleted the `.part` files a new download of the same video was resuming. Two qualities that fall back to the same format could also write to the same file at once. | Files used by running downloads are never removed, and new downloads skip paths that running ones have claimed (re-checked after preparing). |
| R-4 | Low-medium | **External-player option injection and double expansion.** The URL wasn't validated before becoming an argument, and chained `replaceAll` calls expanded `{title}` or `{headers}` text found inside the title or URL. | URLs are validated (R-1), and placeholders are substituted in a single pass. |
| R-5 | Low-medium | **Hidden windows could open the browser.** Scripts in the invisible helper or capture windows could open system-browser tabs. | Only the visible sign-in window forwards links; hidden windows drop them. |
| R-6 | Low | **Off-site redirects and page fetch.** Server redirects bypass `will-navigate`, and the page-context fetch didn't check the page's origin before running with the token. | `will-redirect` keeps remote windows on iwara.tv, and page-context fetches run only on an Iwara origin. |
| R-7 | Low | **Merge interruption.** Segments were merged directly into the final file name, so a crash or a full disk left a truncated file that looked complete. | Merge into `.part`, then rename. |
| R-8 | Low | **Sign-out races.** A helper window still loading, or a token capture in progress, could restore the old session after sign-out. | A sign-out generation counter discards stale results and destroys the loading window. |
| R-9 | Low | **Unhandled rejections** from `openPath` and `openExternal` in the main process. | Awaited or caught. |
| R-10 | Low | **Windows `.cmd`/`.bat` players** were offered in the picker, but they can't start without a shell (and adding one would allow command injection through titles). | The picker offers `.exe` only. |

## UI/UX audit

### Findings in the Tauri UI and what changed

| # | Before | After |
| --- | --- | --- |
| U-1 | Chinese-only UI: about 290 lines of `App.tsx` held inline Chinese strings, and Rust errors were Chinese sentences. | Typed i18n for English and Simplified Chinese with system-language detection, plural rules, and locale-aware numbers, dates and relative times. Both dictionaries are checked for identical keys and placeholders. |
| U-2 | Dark theme only. | System, light and dark themes, set in Settings → General and applied to native menus and dialogs. |
| U-3 | One status line: each message replaced the previous one, and errors showed as raw text. | Toast stack with tones and actions (Undo, View downloads, Show in folder, Resume, Sign in, Open settings). Every backend error code maps to a localized title, explanation and recovery action. Related toasts replace each other ("Added to downloads" → "Downloaded"); at most 3 show at once; errors stay until dismissed. |
| U-4 | Destructive actions with no confirmation or undo (S-4). | Confirmation dialogs for deleting files, signing out and clearing history or lists; Undo for removing favorites. |
| U-5 | Navigation in one long component, with list scroll restoration added late. | Sidebar grouped into Discover and Library; a back stack that restores page and scroll; a top bar that searches or opens a pasted link or ID (offering both when ambiguous); shortcuts (`/`, `Ctrl/⌘+K`, `Ctrl/⌘+,`, `Esc`, `Alt+←`, mouse back). |
| U-6 | Limited accessibility: 15 `aria-*` attributes, 9 `role`s, no `:focus-visible` styles. | Labelled controls; roving-tabindex tabs and segmented controls; menus with arrow, Home and End keys; visible focus rings; `aria-busy` on pending actions; `role="status"` toasts; hidden views removed from the accessibility tree; reduced-motion support. |
| U-7 | Thumbnails always showed frame 00 (often black). | The frame Iwara selected, or the custom thumbnail. |
| U-8 | Fixed 960 px minimum width. | Works down to 720 px; the sidebar collapses automatically below 1080 px, or on demand (remembered). |
| U-9 | Download rows showed bytes and percent, with no speed, time remaining or status filters. | Progress, speed, time remaining, status tabs with counts, resume after cancel or restart, and per-item actions. |
| U-10 | All settings on one page in a grid of panels. | Sectioned settings with auto-save, a live player check with a command preview, a Test MPV button, and an account panel showing session details. |
| U-11 | Sign-in progress was reported in the status line, and the rest of the UI learned about the session when it next refreshed. | One button opens Iwara's page; the window closes once the session is detected, the sidebar and Settings update immediately, and a toast confirms the account. |

### Issues found and fixed while testing the new UI

- A "Signed in" toast appeared on every launch; it now shows only when signing in.
- The toast action "Downloads" read like the sidebar item; it is now "View downloads".
- Stale toasts piled up during quick sequences; keyed replacement and a cap of 3 fixed it.
- The "Failed" downloads tab also counted canceled items; it is now "Interrupted" (failed or canceled, both resumable).
- A missing favicon caused a 404; the quality picker stretched to full width; menu items wrapped.
- The skeleton shimmer ignored reduced-motion preferences.

### Recommendations (Open)

- Show the account's display name next to the username in the sidebar chip.
- Virtualize very long favorites and history lists (they currently render fully).
- ~~On macOS and Linux, show a one-time hint about installing MPV before the first playback.~~ Superseded: new installs default to the built-in player, and a missing player's error now offers **Play here instead** (see the follow-up below).
- ~~Offer an optional in-app preview player.~~ Done in the follow-up below.

## Follow-up: improvements after the audit

| Area | Improvement |
| --- | --- |
| Playback | **Built-in player.** Plays on the video page with native controls, fullscreen, remembered volume and keys (Space/K, ←/→, F, M). It's the default for new installs; existing settings keep their player. Switching quality continues at the same moment. When MPV or an external player can't start, the error offers **Play here instead**. |
| Playback | **Resume and Continue watching.** The built-in player saves its position (every 10 s, on pause and on leaving), offers **Start over**, and shows watched bars on cards, rows and the hero. Unfinished videos appear in a Continue watching row on Browse; History shows how much was watched and offers **Resume**. |
| Discovery | **Hover previews** step through Iwara's frame strip (thumbnail-00…). Each frame is decoded before it's shown; on live iwara.tv, no sample caught a blank frame (it was about 10% before decoding first). Reduced-motion users get no animation. |
| Discovery | **More from the author** and **Related videos** (`/video/{id}/related`) in the video page's side column, without blocked tags or the video itself. |
| Navigation | Recent searches and a **copied Iwara link** suggestion in the empty top bar; `Ctrl/⌘+1…6` switches sections; `?` (or the keyboard button) opens a shortcut list. |
| Layout | **Card size** (large or compact) in Settings → General. |
| Downloads | Aggregate progress on the taskbar or Dock, a badge count, and a system notification when a download finishes or fails while the app is in the background (clicking it opens Downloads; it can be turned off). |
| Fixes | Electron 44's clipboard API is asynchronous; copying a link had been firing without being awaited. |

Security notes on the new surface:

| ID | New surface | Control |
| --- | --- | --- |
| F-1 | `iwara-media://` stream proxy | Registered only on the app window's session; Iwara windows can't reach it. Requests resolve through random one-time tokens that `player:play` issues (at most 16 live), so the page can't make the main process fetch arbitrary URLs. Targets are format URLs that already passed the `https://*.iwara.tv` filter; upstream response headers are allowlisted; CSP `media-src` allows only this scheme. Tested in `tests/backend.test.ts` and end-to-end. |
| F-2 | Fullscreen | The only permission the app window can get, and only for its own top-level page (asserted in `tests/boundaries.test.ts`, exercised by the e2e test). |
| F-3 | Clipboard read | Happens in the main process when the top bar gains focus; only a recognized `iwara.tv/video/…` link yields a video ID, and no clipboard text is ever sent to the page. |
| F-4 | New IPC channels | `iwara:list-related`, `player:report-progress` and `system:clipboard-video` have runtime validators (bounded strings, finite non-negative seconds) and appear in the all-channels test. |
| F-5 | Notifications | Show only the video title and an outcome; they're created in the main process and are skipped while the window is focused. |

## Bugs fixed from the Tauri version

1. **Cloudflare fallback discarded its own result.** After a challenge, the request was retried inside a real Iwara page, but the original 403 status was kept, so the call failed even when the retry succeeded. The page response is now used.
2. **JWT false positives** (S-3).
3. **Wrong thumbnail frame** (U-7).
4. **Option injection into MPV** (S-2).
5. **Download deletion without confirmation** (S-4).
6. **Wrong subscription count:** the Subscriptions header showed "共 N 个订阅视频" from the API's `count`. For `/videos`, that field is "results on this page + 1" when more pages exist (so a full page always read 25), not a total. The app now treats it as a has-more flag and shows totals only for search, where they are real.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (renderer, plus main, preload and tests) | Pass |
| `npm test` | 10 files, 132 tests pass |
| `npm run test:e2e` (20 steps: feed and thumbnails, feeds and paging, search, hover frame preview, recent searches, shortcut list, open by link with salt detection, MPV launch arguments, favorite, segmented download with SHA-256 check, built-in playback of a real clip with related lists and fullscreen, saved position and resume, Continue watching, favorites and history, sign-in window and subscriptions, token kept on iwara.tv across a redirect, follow and comment, MPV detection and test, sign-out, no renderer errors) | 20/20 against `out/`. The packaged `release/linux-unpacked` build (without fuses, since Playwright attaches through the inspector) passed all 13 steps that existed before the review fixes |
| Packaged Linux build with fuses (rebuilt after the review fixes) | Fuses read back as configured; ignores `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS`; renders the feed from the asar over `app://`, with no `require` or `process` in the page |
| `npm audit --omit=dev` | 0 vulnerabilities (S-7 covers the dev tooling) |
| Live iwara.tv (read-only) | Feeds, search, video formats, comments, salt detection, host discovery and speed test, a real download, and network capture all worked. Follow-up: the built-in player streamed a real video (640×360), seeked to 2:07 over Range requests, switched to Source (720p) at the same moment, and saved its position. Related and more-from-author lists filled, and hover previews cycled real frames |

Not verified here: Windows and macOS packaging and runtime (the CI matrix builds them on the next release tag), and a full sign-in with a real Iwara account (only the window lifecycle was exercised live; the complete flow ran against the mock server).

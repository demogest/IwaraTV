# IwaraTV User Manual

[简体中文](user-manual.zh-CN.md) | English

IwaraTV is a desktop app for browsing Iwara.tv and playing videos in MPV or another player on your computer. Everything it stores — settings, favorites, history, downloads and your Iwara session — stays on your machine.

This project is independent and is not affiliated with, sponsored by, or endorsed by Iwara.

## Install And Start

1. Download the latest build from [GitHub Releases](https://github.com/demogest/IwaraTV/releases):
   - Windows: `IwaraTV_<version>_x64-setup.exe` (installer), `…-portable.exe` (no install) or `…-unpacked.zip`.
   - macOS: the `.dmg`. The app isn't notarized, so the first time, right-click the app and choose **Open**.
   - Linux: the `.deb` or the `.AppImage` (make it executable first).
2. Start IwaraTV. The Browse page opens straight away; signing in is optional.
3. Windows builds include MPV. On macOS and Linux, install MPV (`brew install mpv`, `sudo apt install mpv`, …) or pick another player in **Settings → Playback**.

Upgrading from an older (Tauri-based) IwaraTV: your settings, favorites and download history are imported automatically on the first start, and **Settings → Advanced** confirms it. Sign in again once — sessions can't be carried over.

## The Window

- **Sidebar**: Browse, Search, Subscriptions (Discover) and Favorites, Downloads, History (Library); Settings and your account at the bottom. The button next to the logo collapses the sidebar; it collapses automatically in narrow windows. A badge on Downloads shows active downloads.
- **Top bar**: type words and press Enter to search, or paste an Iwara link or video ID to open the video. When the text could be either, the suggestion list offers both.
- **Back**: the Back button, `Esc`, `Alt+←` or the mouse back button return to where you were, including your scroll position.

Keyboard shortcuts:

| Keys | Action |
| --- | --- |
| `/`, `Ctrl+K` or `Ctrl+L` (`⌘` on macOS) | Focus the top bar |
| `Ctrl+,` | Open Settings |
| `Esc`, `Alt+←`, mouse back | Go back |
| `Ctrl+Enter` in a comment box | Send |
| Arrow keys, `Home`, `End` | Move between tabs, quality options and menu items |

## Browsing And Searching

- **Browse** has four feeds: Latest, Trending, Popular and Followed tags. The rating switch (All / General / Ecchi) applies to all of them; set its default in **Settings → General**. Add tag filters to narrow a feed.
- **Search** searches all of Iwara and sorts by relevance, newest, views or likes.
- **Subscriptions** shows new videos from authors you follow on Iwara (sign-in required). Filter by author with the chips at the top.
- Hover a video card for quick actions: play, download and favorite. Click the author's name to open their page.
- Lists remember their page and scroll position while you move around.

## Watching

Open a video to see its details. Choose a **Quality** (best first), then:

- **Play in MPV** (or your external player). The arrow next to it picks the other player for this one time.
- **Download** saves the chosen quality.
- **Favorite** saves the video locally.
- **⋯** opens the video on Iwara or copies its link.

If the chosen quality isn't available, IwaraTV uses the best one there is and tells you. The page also shows the description, tags and comments. Each tag has a menu to browse it, follow it or block it.

### Players

Pick the default player and preferred quality in **Settings → Playback**.

- **MPV**: found automatically (bundled copy, your system's MPV, or a path you choose). **Test MPV** confirms it starts.
- **External player**: choose the executable and its arguments. The arguments must contain `{url}`; you can also use `{title}` and `{headers}` (the Iwara referrer header). The preview shows the exact command.

## Signing In

Subscriptions, following authors, commenting and some private videos need an Iwara account.

1. Click **Sign in with Iwara** on the Subscriptions page or in **Settings → Account** (the account button at the bottom of the sidebar opens it).
2. Iwara's own sign-in page opens in a separate window. Sign in there, and complete a browser check if Iwara asks for one. Your password goes to Iwara only; IwaraTV never sees it.
3. The window closes by itself once IwaraTV detects the session, and the sidebar shows your name.

The same window is used when Iwara asks to verify the browser ("Browser check needed"). **Settings → Account → Sign out** clears Iwara's cookies and site data from IwaraTV; favorites, history and downloads are kept.

## Authors, Tags And Comments

- **Follow** an author from the video page or their author page. New videos appear in Subscriptions.
- **Followed tags** fill the Followed tags feed; **blocked tags** hide matching videos everywhere (blocking a tag also unfollows it). Manage both from a tag's menu or **Settings → Content filters**, which also sets how many pages to scan when filtering and the pause between pages.
- **Comments** load on the video page with replies; when signed in, you can comment and reply.

## Favorites And History

Favorites are saved on this computer, not on your Iwara account. Click the star to add or remove a video; removing shows **Undo**. In **Favorites** you can filter, sort, and:

- **Back up**: write a copy next to the app's data.
- **Export…**: save a JSON file anywhere.
- **Import…**: merge a JSON file exported from IwaraTV; duplicates are merged and the earliest date is kept.

**History** lists videos you played, grouped by day, with the quality and player used. Play again, remove single entries or clear everything.

## Downloads

Choose the folder, default quality, parallel connections and split threshold in **Settings → Downloads**. The default folder is `IwaraTV` inside your Downloads folder.

- The video page downloads the quality you selected; quick actions on cards use the default quality.
- Large files are fetched in parallel ranges when the server allows it.
- **Cancel** keeps the partial file; **Resume** continues where it stopped, also after restarting the app.
- Finished items offer **Play file** and **Show in folder**; the **⋯** menu removes the entry, and for finished downloads asks whether to delete the file too.
- Tabs filter active, completed and interrupted (failed or canceled) downloads; **Clear list** removes finished entries (files are kept).

## Network And Troubleshooting

**Settings → Network** manages the CDN host pool. **Run speed test** downloads a small sample from each host; with **Use the fastest host** on, playback and download links are rewritten to the top-ranked host. Turn it off if you get HTTP 403 errors.

On a video page, **Troubleshooting** offers:

- **Compare with website**: opens the video in a hidden Iwara page and compares the formats the website gets with what IwaraTV sees — useful when only low qualities appear.
- **Speed-test CDN hosts** using this video.

**Settings → Advanced** shows the X-Version salt Iwara uses to sign file-list requests. IwaraTV detects it from Iwara's website at most once a day; **Detect now** refreshes it.

Errors appear as messages with a suggested fix, such as **Sign in**, **Open settings** or **Try again**.

| Problem | What to do |
| --- | --- |
| "MPV not found" | Install MPV or choose its executable in **Settings → Playback**, or switch to an external player. |
| External player doesn't open | Check the executable path and that the arguments include `{url}`. |
| "Browser check needed" | Click **Open Iwara window** and complete the check. |
| "Sign-in required" / "Session expired" | Sign in again. |
| Only low qualities appear | Sign in, then use **Troubleshooting → Compare with website**. |
| HTTP 403 when playing or downloading | Turn off **Use the fastest host** in **Settings → Network**. |
| Downloads fail or stall | **Resume** the download, lower parallel connections, or choose another quality. |
| Favorites import skips items | Use a JSON file exported from IwaraTV. |

## Where Your Data Lives

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| App data | `%APPDATA%\IwaraTV` | `~/Library/Application Support/IwaraTV` | `~/.config/IwaraTV` |

The app data folder (also shown in **Settings → Advanced**) contains:

- `settings.json` — preferences, tag lists, host ranking and playback history.
- `favorites.json` and `favorites.backup.json` — favorites and the latest backup.
- `downloads.json` — the download list.
- `window-state.json` — window size and position.
- `Partitions/iwara` — the Iwara browser session (cookies and site storage), like a browser profile.

Files imported from the previous version are kept with a `.pre-migration.json` suffix if they replaced newer ones. Downloaded videos are stored in the download folder you chose.

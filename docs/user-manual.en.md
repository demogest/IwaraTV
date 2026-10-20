# IwaraTV User Manual

[简体中文](user-manual.zh-CN.md) | English

IwaraTV is a desktop app for browsing Iwara.tv and watching videos — in its own built-in player, in MPV, or in another player on your computer. Everything it stores — settings, favorites, history, downloads and your Iwara session — stays on your machine.

This project is independent and is not affiliated with, sponsored by, or endorsed by Iwara.

## Install And Start

IwaraTV runs on Windows 10 or later (64-bit), macOS 13 Ventura or later on Apple Silicon, and 64-bit Linux.

1. Download the latest build from [GitHub Releases](https://github.com/demogest/IwaraTV/releases):
   - Windows: `IwaraTV_<version>_x64-setup.exe` (installer), `…-portable.exe` (no install) or `…-unpacked.zip`.
   - macOS: the `.dmg`. The app isn't notarized, so the first time, right-click the app and choose **Open**.
   - Linux: the `.deb` or the `.AppImage` (make it executable first).
2. Start IwaraTV. The Browse page opens straight away; signing in is optional.
3. Press **Play here** on any video — the built-in player needs nothing else. If you prefer MPV, Windows builds include it; on macOS and Linux install it (`brew install mpv`, `sudo apt install mpv`, …) and choose it in **Settings → Playback**.

Upgrading from an older (Tauri-based) IwaraTV: your settings, favorites and download history are imported automatically on the first start, and **Settings → Advanced** confirms it. Sign in again once — sessions can't be carried over. Your default player stays MPV (or your external player); switch to **Built-in** in **Settings → Playback** if you like.

## The Window

- **Sidebar**: Browse, Search, Subscriptions (Discover) and Favorites, Downloads, History (Library); Settings and your account at the bottom. The button next to the logo collapses the sidebar; it collapses automatically in narrow windows. A badge on Downloads shows active downloads.
- **Top bar**: type words and press Enter to search, or paste an Iwara link or video ID to open the video. When the text could be either, the suggestion list offers both. With the box empty, it suggests your recent searches (remove one with its **×** or `Delete`, or clear them all) and, if you copied an Iwara video link, offers to open it.
- **Back**: the Back button, `Esc`, `Alt+←` or the mouse back button return to where you were, including your scroll position.

Keyboard shortcuts (press `?` or the keyboard button in the top bar to see them in the app):

| Keys | Action |
| --- | --- |
| `/`, `Ctrl+K` or `Ctrl+L` (`⌘` on macOS) | Focus the top bar |
| `Ctrl+1` … `Ctrl+6` | Browse, Search, Subscriptions, Favorites, Downloads, History |
| `Ctrl+,` | Open Settings |
| `Esc`, `Alt+←`, mouse back | Go back |
| `Ctrl+Enter` in a comment box | Send |
| `?` | Show the shortcut list |
| `Space` or `K` | Built-in player: play or pause |
| `←` / `→` | Built-in player: back or forward 5 seconds |
| `F` / `M` | Built-in player: fullscreen / mute |
| Arrow keys, `Home`, `End` | Move between tabs, quality options and menu items |

## Browsing And Searching

- **Browse** has four feeds: Latest, Trending, Popular and Followed tags. The rating switch (All / General / Ecchi) applies to all of them; set its default in **Settings → General**. Add tag filters to narrow a feed.
- **Search** searches all of Iwara and sorts by relevance, newest, views or likes.
- **Subscriptions** shows new videos from authors you follow on Iwara (sign-in required). Filter by author with the chips at the top.
- Rest the pointer on a video card to preview it: the thumbnail steps through frames from the video, and quick actions appear (play, download, favorite). Click the author's name to open their page.
- **Continue watching** at the top of Browse lists videos you started in the built-in player but didn't finish; a bar under each thumbnail shows how far you got, and **Resume** carries on from there.
- **Settings → General → Card size** switches to smaller cards to fit more videos on each row.
- Lists remember their page and scroll position while you move around.

## Watching

Open a video to see its details. Choose a **Quality** (best first), then:

- **Play here** (or **Play in MPV** / your external player, depending on your default). The arrow next to it picks another player for this one time.
- **Download** saves the chosen quality.
- **Favorite** saves the video locally.
- **⋯** opens the video on Iwara or copies its link.

If the chosen quality isn't available, IwaraTV uses the best one there is and tells you. The page also shows the description, tags and comments, plus **More from** the author and **Related videos** in the side column. Each tag has a menu to browse it, follow it or block it.

### The built-in player

**Play here** plays the video right on its page, with the usual controls, fullscreen and keyboard shortcuts (`Space`/`K`, `←`/`→`, `F`, `M`). The volume is remembered.

- Switching **Quality** while watching continues at the same moment.
- IwaraTV remembers where you stopped. Next time it continues from there and shows **Start over** in case you'd rather begin again. Finished videos start from the beginning.
- Leaving the page stops playback. The **×** in the corner closes the player and brings back the thumbnail.
- If a video can't be played (for example an expired link), the player offers **Try again**; MPV may still work from the arrow menu.

### Players

Pick the default player and preferred quality in **Settings → Playback**. If MPV or your external player can't be found, the error message offers **Play here instead**.

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

**History** lists videos you played, grouped by day, with the quality, the player used and how much you watched in the built-in player. **Resume** (or **Play again**), remove single entries or clear everything.

## Downloads

Choose the folder, default quality, parallel connections and split threshold in **Settings → Downloads**. The default folder is `IwaraTV` inside your Downloads folder.

- The video page downloads the quality you selected; quick actions on cards use the default quality.
- Large files are fetched in parallel ranges when the server allows it.
- **Cancel** keeps the partial file; **Resume** continues where it stopped, also after restarting the app.
- Finished items offer **Play file** and **Show in folder**; the **⋯** menu removes the entry, and for finished downloads asks whether to delete the file too.
- Tabs filter active, completed and interrupted (failed or canceled) downloads; **Clear list** removes finished entries (files are kept).
- Progress also shows on the taskbar or Dock icon. When a download finishes or fails while IwaraTV is in the background, a system notification tells you; click it to open Downloads. Turn this off with **Notify when downloads finish**.

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
| "Update rejected" | The file didn't match what the release published, so nothing was installed. Try again later, or download the release from GitHub. |

## Updates

IwaraTV checks GitHub for a new version 20 seconds after it starts and every 6 hours after that. When one is out, an item appears above **Settings** in the sidebar; click it to read what's new.

How the update is installed depends on how you installed IwaraTV:

- **Windows installer and AppImage:** the update downloads in the background. Click **Restart to update** when it suits you; IwaraTV closes, installs it and starts again. Your data stays as it is.
- **Windows portable app and ZIP:** click **Download**. IwaraTV saves the new file (next to the portable app when it can) and shows it in its folder; close IwaraTV and start the new file, or unpack the ZIP over your IwaraTV folder.
- **Linux `.deb`:** click **Download**, then **Open installer**. Your software installer asks for your password.
- **macOS:** click **Download**, then **Open disk image**, and drag IwaraTV onto Applications to replace the old copy.

Every file is checked against the checksums published with the release before it is used, and releases can be signed so IwaraTV accepts only files from this project; **Settings → Updates** shows which check your copy uses. **Breaking releases**, which change how IwaraTV works or what it needs, are never downloaded or installed by themselves: the update window shows a warning and you decide. **Skip this version** stops the reminders until a newer version is out.

In **Settings → Updates** you can check now, turn automatic checks off, and choose whether updates download in the background. Update checks contact only github.com, without cookies or anything that identifies you.

## Where Your Data Lives

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| App data | `%APPDATA%\IwaraTV` | `~/Library/Application Support/IwaraTV` | `~/.config/IwaraTV` |

The app data folder (also shown in **Settings → Advanced**) contains:

- `settings.json` — preferences, tag lists, host ranking and playback history (including where you stopped in the built-in player).
- `favorites.json` and `favorites.backup.json` — favorites and the latest backup.
- `downloads.json` — the download list.
- `window-state.json` — window size and position.
- `Partitions/iwara` — the Iwara browser session (cookies and site storage), like a browser profile.

Updates for the Windows installer are downloaded to `%LOCALAPPDATA%\IwaraTV-updates` and removed by the first update check after they're installed; other updates go to your Downloads folder (or next to the portable app or AppImage).

Files imported from the previous version are kept with a `.pre-migration.json` suffix if they replaced newer ones. Downloaded videos are stored in the download folder you chose.

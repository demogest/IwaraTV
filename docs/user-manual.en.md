# IwaraTV User Manual

[简体中文](user-manual.zh-CN.md) | English

IwaraTV is a desktop companion for browsing Iwara.tv, opening video detail pages, launching local playback, and downloading videos. It runs locally; Iwara account access, Cloudflare verification, player paths, playback history, and downloads remain on your machine.

This project is independent and is not affiliated with, sponsored by, or endorsed by Iwara.

## Install And Start

1. Download the latest build from [GitHub Releases](https://github.com/demogest/IwaraTV/releases).
2. Install the package for your platform, or use the Windows portable build if available.
3. Start IwaraTV.
4. Open **Settings** before the first playback and check the MPV or external-player status.

Windows release builds can include bundled MPV. On macOS and Linux, install MPV separately or configure another player in **Settings**.

## Main Navigation

- **Browse**: Recent, trending, popular, followed-tag, and author-filtered feeds.
- **Search**: Keyword search with sort options for relevance, newest, views, or likes.
- **Subscriptions**: Videos from subscribed authors after login/session verification.
- **Favorites**: Local saved videos with backup, export, and import tools.
- **Downloads**: Active download queue, progress, retry, open file/folder, and history.
- **History**: Recently played videos stored locally.
- **Settings**: Account/session state, player paths, download defaults, media-host routing, X-Version handling, and tag preferences.

## Open Videos

Use any of these entry points:

- Click a video card in a feed or search result.
- Paste an Iwara video ID into the top bar.
- Paste an Iwara video URL into the top bar.
- Open an author from a detail page to browse that author's feed.

The detail page lists the available qualities. Choose a quality, then use **Play**, **External**, or **Download** depending on your preferred action.

## Playback

IwaraTV supports two playback modes:

- **MPV**: Preferred default. The app looks for a configured MPV path, a bundled Windows MPV, `vendor/mpv/mpv.exe` in development, or MPV on `PATH`.
- **External player**: Configure an executable path and argument template. The template must include `{url}` so the player receives the media URL.

Useful external-player placeholders:

- `{url}`: Direct media URL.
- `{title}`: Video title.
- `{headers}`: HTTP header string with the Iwara referrer.

If your selected quality is unavailable, IwaraTV falls back to the best available format and reports the fallback.

## Login And Verification

Some actions require an Iwara account or a browser session:

- Subscribed-author feeds.
- Following or unfollowing authors.
- Commenting or replying.
- Accessing videos that require Iwara session cookies or a site token.

Open **Settings**, then use the Iwara verification action. Complete login or Cloudflare verification in the embedded window. When IwaraTV captures a usable site token, the window closes automatically and later requests reuse the token and cookies.

Credential notes:

- API login tokens are stored through the operating system keyring when available.
- Web session data is handled through the app's WebView session.
- If secure storage is unavailable, the app warns that login persistence may be limited.

## Search, Tags, And Feeds

Browse feeds can combine text and tag filtering. Tag preferences in **Settings** apply across list views:

- **Followed tags** power the followed-tag feed.
- **Blocked tags** hide matching videos and take priority over followed tags.
- **Scan pages** controls how many list pages the app scans for multi-tag or blocked-tag filtering.
- **Request delay** adds a pause between scanned pages to reduce request bursts.

Search results use Iwara search plus local filtering for tags and blocked tags.

## Comments And Authors

The video detail page can load comments and replies. After login/session verification, you can post a top-level comment or reply.

Author controls appear on video detail pages and author feeds. Follow/unfollow requires login/session verification.

## Favorites

Use the star/favorite action on video cards or the detail page to save a video locally. The **Favorites** view keeps saved videos available for quick reopening, playback, and downloads.

Favorites are local data, not an Iwara server-side favorite list. The view includes:

- **Backup**: Writes a backup JSON file next to the app's local favorites data.
- **Export**: Lets you choose a JSON destination for sharing or manual backup.
- **Import**: Merges a JSON favorites file into the current local list, deduplicating by video ID.

Imported favorites preserve existing local notes when possible and fill in missing metadata from the imported file.

## Downloads

Set the download directory and default quality in **Settings**. Detail-page downloads use the currently selected quality; video-card downloads use the default quality.

The download manager supports:

- Active task status and progress.
- Preferred-quality fallback.
- Resume-friendly partial files.
- Segmented downloads when the file is large enough and the server supports range requests.
- Retry for failed history items.
- Opening the downloaded file or its folder.
- Deleting history records, with an option to delete local files.

Download history is stored locally in the app data directory.

## Media Hosts And Diagnostics

Iwara media URLs may resolve through different hostnames. In **Settings**, you can:

- Maintain a candidate media-host list.
- Run a speed test with the current video as the sample.
- Enable automatic testing when no ranked hosts exist.
- Replace playback links with the fastest ranked host.

If playback fails with host replacement enabled, disable replacement and retry with the original media URL.

Diagnostics tools help investigate format and session issues:

- **X-Version sniffing** refreshes the salt used for Iwara API requests.
- **Video diagnostics** checks available formats and, when possible, captures Iwara network responses from an embedded page.
- **Media speed reports** show per-host success, latency, and throughput.

## Local Data

IwaraTV writes local state in the app data directory:

- `settings.json`: Player, download, Iwara, media-host, tag, and history settings.
- `downloads.json`: Download history.
- `favorites.json`: Local favorites.
- Keyring entry: Persisted API token when the OS keyring is available.

Downloaded videos are saved to the configured download folder, which defaults to an `IwaraTV` folder under the system Downloads directory when available.

## Troubleshooting

- **"Tauri API is not available"**: You are likely running the Vite web preview. Use the packaged desktop app or `npm run dev:tauri` for development.
- **MPV not found**: Select `mpv.exe` or `mpv` in **Settings**, install MPV on `PATH`, or use an external player.
- **External player does not open**: Confirm the executable exists and the argument template includes `{url}`.
- **Subscribed feed or comments fail**: Complete the embedded Iwara verification flow and refresh the app state.
- **Only low-quality formats appear**: Use video diagnostics after logging in; session-only formats may require captured browser credentials.
- **Downloads fail or stall**: Retry from the download history, lower max connections, disable host replacement, or choose another quality.
- **403 after host replacement**: Disable media-host replacement and use the original link.
- **Favorites import skips items**: Confirm the JSON came from IwaraTV export or contains valid video IDs.

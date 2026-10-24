// End-to-end smoke test: launches the built Electron app against the mock
// Iwara server and walks through the main flows. Run with `npm run test:e2e`
// (on Linux CI wrap it in `xvfb-run -a`). Screenshots land in test-results/e2e.

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import electronPath from "electron";
import { MEDIA_SHA256, MEDIA_SIZE, MOCK_SALT, PLAYABLE_VIDEO_INDEX, VIDEOS, VIEWER, startMockIwara } from "./mock-iwara.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shots = path.join(root, "test-results", "e2e");
mkdirSync(shots, { recursive: true });

const home = mkdtempSync(path.join(os.tmpdir(), "iwaratv-e2e-home-"));
const configHome = path.join(home, ".config");
const userData = path.join(configHome, "IwaraTV");
const downloads = path.join(home, "Downloads", "IwaraTV");
const binDir = path.join(home, "bin");
const mpvLog = path.join(home, "mpv-args.txt");
mkdirSync(userData, { recursive: true });
mkdirSync(binDir, { recursive: true });

// Start from English and small split thresholds so the download is segmented.
// Automatic update checks are off so the scheduled check can't race the steps.
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  ui: { language: "en", theme: "dark", rating: "all" },
  download: { directory: downloads, minSplitBytes: 1024 * 1024, maxConnections: 4 },
  updates: { autoCheck: false }
}));

// A signed release one minor version ahead, built with the release job's own
// manifest script and served from a local folder.
const appVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const [major, minor] = appVersion.split(".").map(Number);
const updateVersion = `${major}.${minor + 1}.0`;
const updateDir = path.join(home, "release");
mkdirSync(updateDir);
for (const suffix of ["x64-setup.exe", "x64-portable.exe", "x64-unpacked.zip", "arm64.dmg", "x86_64.AppImage", "amd64.deb"]) {
  writeFileSync(path.join(updateDir, `IwaraTV_${updateVersion}_${suffix}`), `IwaraTV ${updateVersion} ${suffix}\n`.repeat(40_000));
}
const updateNotes = path.join(home, "update-notes.md");
writeFileSync(updateNotes, `## IwaraTV ${updateVersion}\n\n- **Updates inside the app** — new versions are found, verified and installed for you.\n- Smoother scrolling on long lists.\n`);
const updateKeys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
const updatePublicKeyFile = path.join(home, "update-public-key.pem");
writeFileSync(updatePublicKeyFile, updateKeys.publicKey);
execFileSync(process.execPath, [
  path.join(root, "scripts", "update-manifest.mjs"),
  "--tag", `v${updateVersion}`, "--dir", updateDir, "--notes", updateNotes, "--public-key", updatePublicKeyFile
], { env: { ...process.env, UPDATE_SIGNING_KEY: updateKeys.privateKey }, stdio: "inherit" });
const updateKind = { linux: "appimage", win32: "nsis", darwin: "dmg" }[process.platform];
const updateFile = `IwaraTV_${updateVersion}_${{ appimage: "x86_64.AppImage", nsis: "x64-setup.exe", dmg: "arm64.dmg" }[updateKind]}`;
const updateRequests = [];
const updateServer = http.createServer((request, response) => {
  updateRequests.push({ path: request.url, cookie: request.headers.cookie });
  const file = path.join(updateDir, path.basename(decodeURIComponent(request.url ?? "/")));
  if (!existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((resolve) => updateServer.listen(0, "127.0.0.1", resolve));

// A stand-in MPV that records its arguments.
const mpvStub = path.join(binDir, "mpv");
writeFileSync(mpvStub, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "mpv 0.40.0 (e2e stub)"; exit 0; fi
printf '%s\\n' "$@" > "${mpvLog}"
`);
chmodSync(mpvStub, 0o755);

const mock = await startMockIwara();
const results = [];
let app;

async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`✔ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.error(`✘ ${name}\n  ${error?.stack ?? error}`);
    throw error;
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const errors = [];

try {
  // IWARATV_E2E_EXECUTABLE runs the smoke test against a packaged app instead of `out/`.
  const packaged = process.env.IWARATV_E2E_EXECUTABLE;
  app = await electron.launch({
    executablePath: packaged ? path.resolve(packaged) : electronPath,
    args: [
      ...(process.platform === "linux" && (runsAsRoot || process.env.CI) ? ["--no-sandbox"] : []),
      `--host-resolver-rules=MAP *.iwara.tv 127.0.0.1:${mock.port}, MAP iwara.tv 127.0.0.1:${mock.port}, MAP outside.example 127.0.0.1:${mock.port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
      ...(packaged ? [] : [root])
    ],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      LANG: "en_US.UTF-8",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      IWARATV_UPDATE_URL: `http://127.0.0.1:${updateServer.address().port}/`,
      IWARATV_UPDATE_PUBLIC_KEY: updateKeys.publicKey,
      IWARATV_UPDATE_INSTALL_KIND: updateKind
    }
  });

  const page = await app.firstWindow();
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);
  const view = page.locator(".view:not([hidden])");
  const cards = view.locator(".video-card:not(.video-card--skeleton)");
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const nav = (name) => page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
  const toast = (text) => page.locator(".toast__title", { hasText: text }).first().waitFor({ timeout: 15_000 });

  await step("opens on an empty Home", async () => {
    await view.getByText("Nothing here yet").waitFor({ timeout: 30_000 });
    expect(await page.locator(".sidebar .nav-item[aria-current=page]").innerText() === "Home", "Home is not the start page");
    await nav("Browse");
  });

  await step("loads the latest feed with thumbnails", async () => {
    await cards.first().waitFor({ timeout: 30_000 });
    expect((await cards.count()) === 32, `expected 32 cards, got ${await cards.count()}`);
    await waitFor(
      () => view.locator(".video-card__thumb img").first().evaluate((image) => image.complete && image.naturalWidth > 0),
      "first thumbnail to load"
    );
    const apiRequest = mock.state.requests.find((request) => request.host === "api.iwara.tv" && request.path === "/videos");
    expect(apiRequest.headers.referer === "https://www.iwara.tv/", `Referer was ${apiRequest.headers.referer}`);
    expect(apiRequest.headers.origin === "https://www.iwara.tv", `Origin was ${apiRequest.headers.origin}`);
    expect(!/Electron|IwaraTV/i.test(apiRequest.headers["user-agent"] ?? ""), "User-Agent leaks the app");
    await shot("01-browse");
  });

  await step("keeps the page header in place while scrolling", async () => {
    const header = view.locator(".view-header");
    const ecchi = view.getByRole("radio", { name: "Ecchi" });
    const restingTop = (await ecchi.boundingBox()).y;
    await view.evaluate((element) => element.scrollTo({ top: 900 }));
    await waitFor(async () => (await view.evaluate((element) => element.scrollTop)) >= 900, "the feed to scroll");
    const pinned = await header.evaluate((element) => ({
      offset: element.getBoundingClientRect().top - element.closest(".view").getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      covered: parseFloat(element.closest(".view").style.getPropertyValue("--view-header-height")),
      shadow: getComputedStyle(element).boxShadow
    }));
    const filterTop = (await ecchi.boundingBox()).y;
    expect(Math.abs(pinned.offset + 12) <= 1, `header is ${pinned.offset}px from the top`);
    expect(Math.abs(restingTop - 12 - filterTop) <= 1, `rating filter moved from ${restingTop} to ${filterTop}`);
    expect((await cards.first().boundingBox()).y < pinned.bottom, "the list does not pass under the header");
    expect(pinned.covered > 100, `--view-header-height is ${pinned.covered}`);
    expect(pinned.shadow !== "none", "pinned header has no shadow");
    await shot("01a-browse-scrolled");
    await view.evaluate((element) => element.scrollTo({ top: 0 }));
  });

  await step("switches feeds and pages", async () => {
    await view.getByRole("tab", { name: "Trending" }).click();
    await waitFor(async () => (await view.locator(".video-card__title").first().innerText()) === VIDEOS.at(-1).title, "trending order");
    await view.getByRole("button", { name: "Next" }).click();
    await waitFor(async () => (await cards.count()) === 8, "second page with 8 videos");
    await view.getByRole("button", { name: "Previous" }).click();
    await waitFor(async () => (await cards.count()) === 32, "back to the first page");
  });

  await step("searches from the omnibox", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("neon");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await cards.count()) === 5, "5 search results");
    const titles = await view.locator(".video-card__title").allInnerTexts();
    expect(titles.every((title) => title.startsWith("Neon")), `unexpected results ${titles}`);
    await shot("02-search");
  });

  await step("previews frames when hovering a card", async () => {
    await view.locator(".video-card__media").first().hover();
    await view.locator(".video-card__frames").first().waitFor({ timeout: 5_000 });
    const src = await view.locator(".video-card__thumb img").first().getAttribute("src");
    expect(/\/image\/thumbnail\/file-\d+\/thumbnail-\d\d\.jpg$/.test(src ?? ""), `frame src ${src}`);
    await page.mouse.move(5, 5);
    await view.locator(".video-card__frames").first().waitFor({ state: "detached", timeout: 5_000 });
  });

  await step("suggests recent searches in the top bar", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Backspace");
    await page.locator(".omnibox__option", { hasText: "neon" }).waitFor({ timeout: 5_000 });
    await page.locator(".omnibox__option", { hasText: "Clear recent searches" }).waitFor();
    await page.keyboard.press("Escape");
  });

  await step("shows the keyboard shortcuts", async () => {
    await page.keyboard.press("Shift+?");
    await page.locator(".shortcuts").getByText("Keyboard shortcuts").waitFor({ timeout: 5_000 });
    await shot("02b-shortcuts");
    await page.keyboard.press("Escape");
    await page.locator(".shortcuts").waitFor({ state: "detached", timeout: 5_000 });
  });

  const video = VIDEOS[3];
  await step("opens a pasted video link after detecting the X-Version salt", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(`https://www.iwara.tv/video/${video.id}/some-slug`);
    await page.keyboard.press("Enter");
    await view.locator(".quality-picker").waitFor({ timeout: 20_000 });
    expect((await view.locator(".video-title").innerText()) === video.title, "video title");
    const qualities = await view.locator(".quality-picker [role=radio]").allInnerTexts();
    expect(qualities.join(",") === "Source,540p,360p", `qualities ${qualities}`);
    const settings = JSON.parse(readFileSync(path.join(userData, "settings.json"), "utf8"));
    expect(settings.iwara.xVersionSalt === MOCK_SALT, "salt was not detected");
    await view.locator(".comment").first().waitFor();
    await shot("03-video");
  });

  await step("plays in MPV with the Iwara referrer", async () => {
    await view.getByRole("button", { name: "Choose player" }).click();
    await page.getByRole("menuitem", { name: "Play in MPV" }).click();
    await toast("Playing in MPV");
    const args = (await waitFor(() => existsSync(mpvLog) && readFileSync(mpvLog, "utf8"), "MPV to start")).trim().split("\n");
    expect(args.includes("--referrer=https://www.iwara.tv/"), `args ${args}`);
    expect(args.at(-2) === "--", "URL is not separated from options");
    expect(new URL(args.at(-1)).hostname.endsWith(".iwara.tv"), `url ${args.at(-1)}`);
    expect(args.includes(`--title=${video.title}`), "title");
  });

  await step("adds a favorite", async () => {
    await view.getByRole("button", { name: "Favorite", exact: true }).click();
    await view.getByRole("button", { name: "Favorited", exact: true }).waitFor();
  });

  await step("downloads the file with parallel ranges", async () => {
    await view.getByRole("button", { name: /^Download/ }).click();
    await nav("Downloads");
    await view.locator(".badge", { hasText: "Completed" }).first().waitFor({ timeout: 30_000 });
    const files = readdirSync(downloads).filter((name) => name.endsWith(".mp4"));
    expect(files.length === 1, `files ${files}`);
    const data = readFileSync(path.join(downloads, files[0]));
    expect(data.length === MEDIA_SIZE, `size ${data.length}`);
    expect(createHash("sha256").update(data).digest("hex") === MEDIA_SHA256, "content mismatch");
    const ranged = mock.state.requests.filter((request) => request.path.startsWith("/download/") && request.headers.range && request.headers.range !== "bytes=0-0");
    expect(ranged.length >= 2, `expected segmented download, saw ${ranged.length} ranged requests`);
    expect(ranged.every((request) => request.headers.referer === "https://www.iwara.tv/"), "media requests need the Iwara referrer");
    await shot("04-downloads");
  });

  const playable = VIDEOS[PLAYABLE_VIDEO_INDEX];
  const player = view.locator("video.player__video");
  const playerState = () => player.evaluate((element) => ({ time: element.currentTime, ready: element.readyState, paused: element.paused, error: element.error?.code }));
  await step("plays in the built-in player with related videos alongside", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(playable.id);
    await page.keyboard.press("Enter");
    await view.locator(".quality-picker").waitFor({ timeout: 20_000 });
    await view.locator(".side-list", { hasText: "Related videos" }).locator(".video-row").first().waitFor({ timeout: 10_000 });
    await view.locator(".side-list", { hasText: `More from ${playable.user.name}` }).locator(".video-row").first().waitFor();

    await view.getByRole("button", { name: "Play here" }).first().click();
    await waitFor(async () => {
      const state = await playerState().catch(() => undefined);
      expect(!state?.error, `media error ${state?.error}`);
      return state && state.ready >= 2 && state.time > 0.3;
    }, "the built-in player to start playing", 20_000);
    const streamed = mock.state.requests.filter((request) => request.path.startsWith("/download/source") && request.headers.range);
    expect(streamed.length > 0, "the stream should reach the CDN with Range requests");
    expect(streamed.every((request) => request.headers.referer === "https://www.iwara.tv/"), "stream requests need the Iwara referrer");
    await shot("04b-player");

    // Fullscreen is the one permission the app window gets.
    await page.keyboard.press("f");
    await waitFor(() => page.evaluate(() => Boolean(document.fullscreenElement)), "fullscreen");
    await page.keyboard.press("f");
    await waitFor(() => page.evaluate(() => !document.fullscreenElement), "leaving fullscreen");
  });

  await step("remembers the position and resumes", async () => {
    await player.evaluate((element) => {
      element.currentTime = 30;
    });
    await waitFor(async () => (await playerState()).time >= 30, "seeking to 0:30");
    await page.keyboard.press("k");
    await waitFor(async () => (await playerState()).paused, "pausing with K");
    await waitFor(() => {
      const history = JSON.parse(readFileSync(path.join(userData, "settings.json"), "utf8")).history;
      const entry = history.find((item) => item.video.id === playable.id);
      return entry?.positionSeconds >= 29 && entry.durationSeconds === 60;
    }, "the saved position");

    await view.getByRole("button", { name: "Close player" }).click();
    await view.locator(".hero .watch-progress").waitFor();
    await view.getByRole("button", { name: "Play here" }).first().click();
    await toast("Continuing from 0:3");
    await waitFor(async () => {
      const state = await playerState().catch(() => undefined);
      return state && state.time >= 29;
    }, "resuming at the saved position", 20_000);
    await page.keyboard.press("k");
  });

  await step("collects recent activity on Home, not on Browse", async () => {
    await nav("Browse");
    await cards.first().waitFor();
    expect((await view.locator(".shelf").count()) === 0, "Browse should only show feeds");
    await nav("Home");
    const continueShelf = view.locator(".shelf", { has: page.getByRole("heading", { name: "Continue watching" }) });
    await continueShelf.locator(".video-card__title", { hasText: playable.title }).waitFor({ timeout: 5_000 });
    await continueShelf.locator(".watch-progress").first().waitFor();
    // Played in MPV, so it's recent but has no position to resume.
    const recentShelf = view.locator(".shelf", { has: page.getByRole("heading", { name: "Recently played" }) });
    await recentShelf.locator(".video-card__title", { hasText: video.title }).waitFor();
    await view.locator(".chip--search", { hasText: "neon" }).waitFor();
    await shot("01b-home");
    await view.locator(".chip__label", { hasText: "neon" }).click();
    await waitFor(async () => (await cards.count()) === 5, "the recent search runs again");
    await nav("Home");
    // Leaving the video ended playback, so reopening it shows the page, not a running player.
    await continueShelf.locator(".video-card__title", { hasText: playable.title }).click();
    await view.locator(".hero .watch-progress").waitFor();
    expect((await player.count()) === 0, "the player should not restart on its own");
    await page.keyboard.press("Escape");
  });

  await step("lists favorites and history", async () => {
    await nav("Favorites");
    await waitFor(async () => (await cards.count()) === 1, "one favorite");
    await shot("05-favorites");
    await nav("History");
    await view.getByText(video.title).first().waitFor();
  });

  await step("signs in through the Iwara window", async () => {
    await nav("Subscriptions");
    await view.getByText("Sign in to see your subscriptions").waitFor();
    const opened = app.waitForEvent("window", { predicate: (window) => window.url().includes("/login"), timeout: 15_000 });
    await view.getByRole("button", { name: "Sign in with Iwara" }).click();
    const login = await opened;
    await login.locator("#sign-in").click();
    await login.waitForEvent("close", { timeout: 15_000 });
    await page.locator(".account-chip__name", { hasText: VIEWER.username }).waitFor({ timeout: 15_000 });
    await waitFor(async () => (await cards.count()) > 0, "subscription feed");
    const authors = new Set(await view.locator(".video-card__author").allInnerTexts());
    expect(authors.size === 1, `subscription authors ${[...authors]}`);
    await shot("06-subscriptions");
  });

  await step("keeps the session token on iwara.tv across redirects", async () => {
    mock.state.redirectVideosTo = "https://outside.example/collect";
    try {
      await view.getByRole("button", { name: "Refresh" }).click();
      const leaked = await waitFor(() => mock.state.requests.find((request) => request.host === "outside.example"), "the redirected request");
      const iwaraRequest = mock.state.requests.findLast((request) => request.host === "api.iwara.tv" && request.path === "/videos");
      expect(Boolean(iwaraRequest.headers.authorization), "the original request should be signed in");
      expect(!leaked.headers.authorization, "Authorization was forwarded to a non-Iwara host");
    } finally {
      mock.state.redirectVideosTo = undefined;
    }
    await view.getByRole("button", { name: "Refresh" }).click();
    await waitFor(async () => (await cards.count()) > 0, "subscription feed after the redirect test");
  });

  const other = VIDEOS[1];
  await step("follows an author and posts a comment", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(other.id);
    await page.keyboard.press("Enter");
    await view.locator(".quality-picker").waitFor({ timeout: 20_000 });
    await view.getByRole("button", { name: "Follow", exact: true }).click();
    await view.getByRole("button", { name: "Following", exact: true }).waitFor();
    expect(mock.state.followRequests.includes(`POST ${other.user.id}`), `follow requests ${mock.state.followRequests}`);

    const text = "Hello from the IwaraTV smoke test";
    await view.getByPlaceholder("Add a comment…").fill(text);
    await view.getByRole("button", { name: "Send", exact: true }).click();
    await view.locator(".comment__body", { hasText: text }).waitFor();
    expect(mock.state.postedComments.some((comment) => comment.videoId === other.id && comment.body === text), "comment not posted");
    await shot("07-comment");
  });

  await step("detects and tests MPV in settings", async () => {
    await nav("Settings");
    await page.locator(".settings__nav").getByRole("button", { name: "Playback" }).click();
    await view.locator(".setting__status--ok", { hasText: "Found" }).first().waitFor();
    await view.getByRole("button", { name: "Test MPV" }).click();
    await view.getByText("MPV starts correctly (mpv 0.40.0 (e2e stub))").waitFor();
    await shot("08-settings");
  });

  await step("switches the interface language", async () => {
    await page.locator(".settings__nav").getByRole("button", { name: "General" }).click();
    const language = view.getByRole("combobox", { name: "Language" });
    await language.selectOption("ja");
    await page.locator(".sidebar").getByRole("button", { name: "ブラウズ", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.lang) === "ja", "html lang is not ja");
    await shot("08b-settings-ja");
    await view.getByRole("combobox", { name: "言語" }).selectOption("zh-TW");
    await page.locator(".sidebar").getByRole("button", { name: "瀏覽", exact: true }).waitFor();
    await view.getByRole("combobox", { name: "語言" }).selectOption("en");
    await page.locator(".sidebar").getByRole("button", { name: "Browse", exact: true }).waitFor();
  });

  await step("finds, verifies and downloads a signed update", async () => {
    await page.locator(".settings__nav").getByRole("button", { name: "Updates" }).click();
    await view.getByText("Only releases signed with the key built into this app").waitFor();
    await view.getByRole("button", { name: "Check now" }).click();
    const notice = page.locator(".nav-item--update");
    if (updateKind === "dmg") {
      // macOS updates are assisted: the user starts the download.
      await notice.getByText("Update available").waitFor({ timeout: 20_000 });
      await notice.click();
      await page.locator(".update-dialog").getByRole("button", { name: /^Download/ }).click();
    }
    await notice.getByText(updateKind === "dmg" ? "Update ready" : "Restart to update").waitFor({ timeout: 20_000 });
    const downloaded = path.join(userData, "updates", updateFile);
    expect(existsSync(downloaded), `${updateFile} was not downloaded`);
    const expected = createHash("sha256").update(readFileSync(path.join(updateDir, updateFile))).digest("hex");
    expect(createHash("sha256").update(readFileSync(downloaded)).digest("hex") === expected, "downloaded file differs");
    const paths = updateRequests.map((request) => request.path);
    expect(["/update.json", "/update.json.sig", `/${updateFile}`].every((wanted) => paths.includes(wanted)), `update requests: ${paths.join(", ")}`);
    expect(updateRequests.every((request) => !request.cookie), "update requests carried cookies");
    await view.getByText(`Version ${updateVersion} is downloaded`).waitFor();

    if (updateKind !== "dmg") {
      await toast(`IwaraTV ${updateVersion} is ready`);
      await notice.click();
    }
    const dialog = page.locator(".update-dialog");
    await dialog.locator("#update-title", { hasText: `IwaraTV ${updateVersion}` }).waitFor();
    expect(await dialog.locator(".release-notes h4").count() === 0, "the notes repeat the dialog title");
    await dialog.getByText("Updates inside the app").waitFor();
    await shot("09-update");
    await dialog.getByRole("button", { name: "Later" }).click();
  });

  await step("signs out", async () => {
    await page.locator(".settings__nav").getByRole("button", { name: "Account" }).click();
    await view.getByRole("button", { name: "Sign out…" }).click();
    await page.locator(".dialog").getByRole("button", { name: "Sign out", exact: true }).click();
    await toast("Signed out of Iwara");
    await page.locator(".account-chip__name", { hasText: "Guest" }).waitFor();
  });

  await step("logs no renderer errors", async () => {
    expect(errors.length === 0, `renderer errors:\n${errors.join("\n")}`);
  });

  await step("quits when its window is closed, even with hidden pages open", async () => {
    // Stands in for the hidden Iwara helper page the app keeps while signed in.
    await app.evaluate(({ BrowserWindow }) => {
      void new BrowserWindow({ show: false }).loadURL("about:blank");
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) >= 2, "no hidden window to test with");
    const exited = new Promise((resolve) => app.process().once("exit", () => resolve(true)));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible())?.close()).catch(() => undefined);
    const quit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]);
    expect(quit, "the app kept running after its window was closed");
  });
} catch {
  // The failing step has already been reported.
} finally {
  await app?.close().catch(() => undefined);
  await mock.close();
  updateServer.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${path.relative(root, shots)}`);
process.exit(failed.length ? 1 : 0);

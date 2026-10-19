// End-to-end smoke test: launches the built Electron app against the mock
// Iwara server and walks through the main flows. Run with `npm run test:e2e`
// (on Linux CI wrap it in `xvfb-run -a`). Screenshots land in test-results/e2e.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import electronPath from "electron";
import { MEDIA_SHA256, MEDIA_SIZE, MOCK_SALT, VIDEOS, VIEWER, startMockIwara } from "./mock-iwara.mjs";

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
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  ui: { language: "en", theme: "dark", rating: "all" },
  download: { directory: downloads, minSplitBytes: 1024 * 1024, maxConnections: 4 }
}));

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
      `--host-resolver-rules=MAP *.iwara.tv 127.0.0.1:${mock.port}, MAP iwara.tv 127.0.0.1:${mock.port}`,
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
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
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
    await view.getByRole("button", { name: "Play in MPV" }).last().click();
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
} catch {
  // The failing step has already been reported.
} finally {
  await app?.close().catch(() => undefined);
  await mock.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Screenshots: ${path.relative(root, shots)}`);
process.exit(failed.length ? 1 : 0);

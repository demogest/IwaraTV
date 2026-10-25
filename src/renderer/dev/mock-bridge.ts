// Development-only fake backend for the browser preview (`npm run dev:web`)
// and for UI screenshots. Never bundled into production builds.

import { createDefaultSettings, EMPTY_AUTH_STATE } from "../../shared/defaults";
import type { EventChannel, InvokeArgs, InvokeChannel, IpcEventContract, IpcResponse, IwaraTVBridge } from "../../shared/ipc";
import type {
  AppSettings,
  AuthState,
  DownloadState,
  DownloadTask,
  FavoriteState,
  PlaybackProgress,
  PlayRequest,
  SettingsPatch,
  UpdateState,
  VideoComment,
  VideoDetail,
  VideoSummary
} from "../../shared/types";

const params = new URLSearchParams(location.search);
const TITLES = [
  "Ocean Breeze — dance cover in 4K",
  "夜樱 · 春日舞会",
  "Neon City Walk (original animation)",
  "Summer Festival Fireworks",
  "Lo-fi Library Study Session",
  "星空下的约定 Remastered",
  "Rainy Window — short film",
  "Clockwork Garden",
  "Morning Run Through the Hills",
  "月光奏鸣曲 Moonlight",
  "Retro Arcade Showdown",
  "Paper Planes Over the Bay",
  "Crystal Cave Exploration",
  "Autumn Leaves Choreography",
  "Midnight Train to Nowhere",
  "竹林小径 Bamboo Path"
];
const AUTHORS = [
  { id: "u-aurora", name: "Aurora Studio", username: "aurora" },
  { id: "u-kitsune", name: "Kitsune MMD", username: "kitsune_mmd" },
  { id: "u-pixel", name: "PixelForge", username: "pixelforge" },
  { id: "u-sakura", name: "桜井工房", username: "sakurai" },
  { id: "u-nova", name: "Nova", username: "nova3d" },
  { id: "u-lumen", name: "Lumen Works", username: "lumen" }
];
const TAGS = ["mmd", "dance", "blender", "koikatsu", "4k", "original", "music", "animation", "60fps", "vocaloid", "cosplay", "landscape"];
const HUES = [152, 200, 265, 320, 18, 42, 180, 230];

function seeded(seed: number) {
  let value = seed % 2147483647 || 1;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function hash(text: string): number {
  let result = 7;
  for (const character of text) {
    result = (result * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(result);
}

function thumbnail(seed: number, label: string): string {
  const hue = HUES[seed % HUES.length]!;
  const hue2 = (hue + 60) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 42%)"/><stop offset="1" stop-color="hsl(${hue2} 60% 22%)"/></linearGradient><radialGradient id="r" cx="0.7" cy="0.3" r="0.6"><stop offset="0" stop-color="white" stop-opacity="0.35"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect width="320" height="180" fill="url(#r)"/><circle cx="${60 + (seed % 200)}" cy="${120 - (seed % 60)}" r="${28 + (seed % 30)}" fill="white" fill-opacity="0.12"/><text x="18" y="160" font-family="system-ui,sans-serif" font-size="15" font-weight="700" fill="white" fill-opacity="0.85">${label.replace(/[<&>]/g, "")}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function avatar(seed: number, name: string): string | undefined {
  if (seed % 3 === 0) {
    return undefined;
  }
  const hue = HUES[(seed + 3) % HUES.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 50% 45%)"/><circle cx="32" cy="26" r="12" fill="white" fill-opacity="0.85"/><rect x="12" y="42" width="40" height="22" rx="11" fill="white" fill-opacity="0.85"/><title>${name}</title></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeVideo(seed: number): VideoSummary {
  const random = seeded(seed);
  const author = AUTHORS[seed % AUTHORS.length]!;
  const title = TITLES[seed % TITLES.length]!;
  const tagCount = 2 + Math.floor(random() * 4);
  const tags = [...new Set(Array.from({ length: tagCount }, () => TAGS[Math.floor(random() * TAGS.length)]!))];
  return {
    id: `mock${seed.toString(36).padStart(8, "0")}`,
    title,
    description: "A short description of this video.\n\nMusic: original composition\nModel: credits in the description on Iwara.",
    uploaderId: author.id,
    uploaderName: author.name,
    uploaderUsername: author.username,
    uploaderAvatarUrl: avatar(hash(author.id), author.name),
    uploaderFollowing: seed % 4 === 0,
    thumbnailUrl: thumbnail(seed, title.split(" ")[0] ?? "IwaraTV"),
    rating: seed % 5 === 0 ? "ecchi" : "general",
    tags,
    numViews: Math.floor(random() * 250_000),
    numLikes: Math.floor(random() * 9_000),
    numComments: Math.floor(random() * 60),
    durationSeconds: 45 + Math.floor(random() * 900),
    createdAt: new Date(Date.now() - Math.floor(random() * 40) * 86_400_000 - Math.floor(random() * 86_400_000)).toISOString()
  };
}

const listeners = new Map<EventChannel, Set<(payload: unknown) => void>>();
function emit<E extends EventChannel>(channel: E, payload: IpcEventContract[E]): void {
  for (const listener of listeners.get(channel) ?? []) {
    listener(structuredClone(payload));
  }
}

let settings: AppSettings = (() => {
  const value = createDefaultSettings();
  value.download.directory = "/Users/you/Downloads/IwaraTV";
  value.tagPreferences.followedTags = ["mmd", "blender"];
  value.tagPreferences.blockedTags = ["cosplay"];
  value.mediaSpeed.rankedHosts = ["kafka.iwara.tv", "jade.iwara.tv", "bronya.iwara.tv"];
  value.mediaSpeed.lastTestedAt = new Date(Date.now() - 3_600_000).toISOString();
  value.ui.theme = (params.get("theme") as AppSettings["ui"]["theme"]) ?? "system";
  value.ui.language = (params.get("lang") as AppSettings["ui"]["language"]) ?? "system";
  value.history = params.get("empty") ? [] : Array.from({ length: 7 }, (_, index) => ({
    video: makeVideo(500 + index),
    formatId: index % 2 ? "1080" : "Source",
    mode: index < 2 ? "builtin" : index % 3 ? "mpv" : "external",
    playedAt: new Date(Date.now() - index * 9 * 3_600_000).toISOString(),
    ...(index < 2 ? { positionSeconds: 140 + index * 210, durationSeconds: 600 } : {})
  }));
  return value;
})();

const signedIn = params.get("signedIn") !== "0";
let auth: AuthState = signedIn
  ? { status: "signed-in", username: "demo_user", siteSessionReady: true, siteCookieCount: 6, siteTokenReady: true, siteTokenKey: "localStorage.accessToken", tokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), verificationWindowOpen: false }
  : { ...EMPTY_AUTH_STATE, siteSessionReady: true, siteCookieCount: 2, status: "verified" };

let favorites: FavoriteState = {
  items: params.get("empty") ? [] : [3, 9, 14, 21, 27].map((seed, index) => ({ video: makeVideo(seed), favoritedAt: new Date(Date.now() - index * 86_400_000).toISOString() }))
};

let downloads: DownloadState = {
  active: [],
  history: params.get("empty") ? [] : [
    { ...downloadTask(makeVideo(41), "completed", 1), totalBytes: 812_000_000, bytesWritten: 812_000_000 },
    { ...downloadTask(makeVideo(42), "failed", 2), error: "Download request failed: HTTP 403", errorCode: "DOWNLOAD_FAILED" as const },
    { ...downloadTask(makeVideo(43), "canceled", 3), totalBytes: 420_000_000, bytesWritten: 120_000_000 }
  ]
};

function downloadTask(video: VideoSummary, status: DownloadTask["status"], offset: number): DownloadTask {
  const time = new Date(Date.now() - offset * 3_600_000).toISOString();
  return {
    id: `dl-${video.id}-${offset}`,
    videoId: video.id,
    requestedQuality: "Source",
    status,
    video,
    format: { id: "Source", label: "Source", url: "https://example.invalid/video.mp4", qualityRank: 4000, ext: "mp4" },
    path: `${settings.download.directory}/${video.title} [${video.id}] - Source.mp4`,
    directory: settings.download.directory,
    bytesWritten: 0,
    createdAt: time,
    updatedAt: time,
    completedAt: status === "completed" || status === "failed" || status === "canceled" ? time : undefined
  };
}

function detail(id: string): VideoDetail {
  const seed = Number.parseInt(id.replace(/^mock/, ""), 36) || hash(id);
  const video = { ...makeVideo(seed), id };
  return {
    ...video,
    description: `${video.description}\n\nThis is a preview build of IwaraTV running with mock data. Every number and title on this page is generated.\n\nTimestamps:\n00:00 Intro\n01:12 Main part\n03:40 Outro`,
    formats: ["Source", "1080", "540", "360", "preview"].map((label, index) => ({
      id: label,
      label,
      url: `https://${["kafka", "jade", "bronya"][index % 3]}.iwara.tv/view?file=${id}&q=${label}`,
      ext: "mp4",
      mimeType: "video/mp4",
      qualityRank: label === "Source" ? 4000 : label === "preview" ? 1 : Number(label)
    }))
  };
}

function comments(videoId: string, page: number, parentId?: string): VideoComment[] {
  const random = seeded(hash(`${videoId}-${page}-${parentId ?? ""}`));
  const bodies = ["Beautiful lighting in this one!", "这个运镜太棒了", "The choreography at 1:30 is amazing.", "Model credits please?", "Saved to favorites ✨", "第一次见到这么流畅的动作", "Great music choice."];
  return Array.from({ length: parentId ? 3 : 8 }, (_, index) => {
    const author = AUTHORS[Math.floor(random() * AUTHORS.length)]!;
    return {
      id: `${parentId ?? videoId}-c${page}-${index}`,
      body: bodies[Math.floor(random() * bodies.length)]!,
      authorName: author.name,
      authorUsername: author.username,
      authorAvatarUrl: avatar(hash(author.id), author.name),
      createdAt: new Date(Date.now() - Math.floor(random() * 30 * 86_400_000)).toISOString(),
      numLikes: Math.floor(random() * 40),
      numReplies: parentId ? 0 : index % 3 === 0 ? 3 : 0
    };
  });
}

function applyPatch(patch: SettingsPatch): void {
  const next = structuredClone(settings) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(patch)) {
    if (section === "history") {
      (next as unknown as AppSettings).history = values as AppSettings["history"];
      continue;
    }
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (value === null) {
        delete next[section]![key];
      } else if (value !== undefined) {
        next[section]![key] = value;
      }
    }
  }
  settings = next as unknown as AppSettings;
  emit("settings:changed", settings);
}

const progressTimers = new Map<string, number>();
function simulateDownload(task: DownloadTask): void {
  const total = 380_000_000;
  const count = settings.download.maxConnections;
  const size = Math.ceil(total / count);
  // Each simulated connection fills its own part of the file at its own pace.
  const parts = Array.from({ length: count }, (_, index) => ({
    next: index * size,
    end: Math.min(total, (index + 1) * size) - 1,
    pace: 0.5 + Math.random()
  }));
  const timer = window.setInterval(() => {
    const current = downloads.active.find((item) => item.id === task.id);
    if (!current) {
      window.clearInterval(timer);
      return;
    }
    const before = current.bytesWritten;
    for (const part of parts) {
      part.next = Math.min(part.end + 1, part.next + Math.round(700_000 * part.pace));
    }
    const missing = parts.filter((part) => part.next <= part.end).map((part): [number, number] => [part.next, part.end]);
    current.status = "downloading";
    current.video ??= detail(task.videoId);
    current.totalBytes = total;
    current.bytesWritten = total - missing.reduce((sum, [first, last]) => sum + last - first + 1, 0);
    current.bytesPerSecond = (current.bytesWritten - before) * 4;
    current.connections = missing.length;
    current.missingRanges = missing;
    if (!missing.length) {
      window.clearInterval(timer);
      const { connections: _connections, missingRanges: _missing, bytesPerSecond: _speed, ...finished } = current;
      downloads = {
        active: downloads.active.filter((item) => item.id !== task.id),
        history: [{ ...finished, status: "completed", completedAt: new Date().toISOString() }, ...downloads.history]
      };
    }
    emit("downloads:changed", downloads);
  }, 250);
  progressTimers.set(task.id, timer);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `?update=1` shows an available update, `?update=breaking` a breaking one.
const updateMode = params.get("update");
const mockUpdateVersion = updateMode === "breaking" ? "3.0.0" : "2.1.0";
let updateState: UpdateState = {
  status: updateMode ? "available" : "up-to-date",
  currentVersion: "2.0.0",
  installKind: "nsis",
  strategy: "automatic",
  signedOnly: true,
  checkedAt: new Date().toISOString(),
  update: updateMode
    ? {
        version: mockUpdateVersion,
        tag: `v${mockUpdateVersion}`,
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
        breaking: updateMode === "breaking",
        skipped: false,
        notes: [
          `## IwaraTV ${mockUpdateVersion}`,
          "",
          "- **Updates inside the app**: IwaraTV now tells you about new versions and installs them with a restart.",
          "- Faster startup and smoother scrolling on long lists.",
          "- Fixed a crash when a download folder was removed while the app was open.",
          "",
          "### Notes",
          "",
          "Signed releases are verified with `Ed25519` before anything is installed."
        ].join("\n"),
        fileName: `IwaraTV_${mockUpdateVersion}_x64-setup.exe`,
        size: 146_000_000,
        releaseUrl: `https://github.com/demogest/IwaraTV/releases/tag/v${mockUpdateVersion}`
      }
    : undefined
};

function setUpdateState(next: UpdateState): UpdateState {
  updateState = next;
  emit("updates:changed", updateState);
  return updateState;
}

async function handle<C extends InvokeChannel>(channel: C, args: InvokeArgs<C>): Promise<unknown> {
  const [first] = args as unknown[];
  switch (channel) {
    case "iwara:list-videos": {
      await delay(450);
      const request = first as { sort: string; page?: number; tags?: string[]; query?: string; userId?: string; subscribedOnly?: boolean; searchOnly?: boolean };
      const page = request.page ?? 0;
      const base = hash(`${request.sort}|${request.query ?? ""}|${request.userId ?? ""}|${request.subscribedOnly ? "s" : ""}`);
      const count = request.subscribedOnly ? 24 : 32;
      let results = Array.from({ length: count }, (_, index) => makeVideo((base % 9000) + page * count + index));
      if (request.userId) {
        const author = AUTHORS.find((item) => item.id === request.userId) ?? AUTHORS[0]!;
        results = results.map((video) => ({ ...video, uploaderId: author.id, uploaderName: author.name, uploaderUsername: author.username, uploaderAvatarUrl: avatar(hash(author.id), author.name) }));
      }
      const blocked = new Set(settings.tagPreferences.blockedTags);
      const before = results.length;
      results = results.filter((video) => !video.tags.some((tag) => blocked.has(tag)));
      const required = request.tags ?? [];
      results = results.filter((video) => required.every((tag) => video.tags.includes(tag)));
      if (params.get("empty")) {
        results = [];
      }
      return {
        sort: request.sort,
        page,
        limit: count,
        query: request.query,
        tags: required,
        scannedPages: required.length > 1 || blocked.size ? 3 : 1,
        blockedCount: before - results.length,
        total: request.searchOnly ? 1284 : undefined,
        hasMore: page < 4,
        results
      };
    }
    case "iwara:get-video":
      await delay(500);
      return detail(String(first));
    case "iwara:list-comments": {
      await delay(300);
      const request = first as { videoId: string; page?: number; parentId?: string };
      const page = request.page ?? 0;
      return { videoId: request.videoId, parentId: request.parentId, page, limit: 8, total: request.parentId ? 3 : 23, hasMore: !request.parentId && page < 2, comments: comments(request.videoId, page, request.parentId), fetchedAt: new Date().toISOString() };
    }
    case "iwara:send-comment": {
      await delay(400);
      const request = first as { body: string };
      return { id: `new-${Date.now()}`, body: request.body, authorName: auth.username, authorUsername: auth.username, createdAt: new Date().toISOString(), numLikes: 0, numReplies: 0 };
    }
    case "iwara:set-author-following":
      await delay(300);
      return first;
    case "iwara:diagnose-video":
      await delay(1500);
      return { videoId: String(first), appFormatLabels: ["Source", "1080", "540", "360"], probes: [{ label: "session", url: "https://files.iwara.tv/file/…?...", ok: true, status: 200, formatLabels: ["Source", "540", "360"] }], network: { pageUrl: "https://www.iwara.tv/video/x", timedOut: false, entries: [{ url: "https://files.iwara.tv/file/…?...", method: "GET", status: 200, formatLabels: ["Source", "1080", "540", "360"], hasAuthorization: true }] } };
    case "iwara:speed-test-video":
      await delay(1200);
      return { videoId: String(first), testedAt: new Date().toISOString(), replaceLinks: settings.mediaSpeed.replaceLinks, fastestHost: "kafka.iwara.tv", results: settings.mediaSpeed.candidateHosts.map((host, index) => ({ host, url: `https://${host}/`, ok: index !== 3, bytesPerSecond: index === 3 ? undefined : 4_200_000 - index * 700_000, error: index === 3 ? "HTTP 404" : undefined })) };
    case "iwara:sniff-x-version-salt":
      await delay(800);
      applyPatch({ iwara: { lastSaltSniffAt: new Date().toISOString() } });
      return { salt: settings.iwara.xVersionSalt, sourceUrl: "https://www.iwara.tv/main.js", checkedAt: new Date().toISOString() };
    case "downloads:list":
      return downloads;
    case "downloads:start":
    case "downloads:retry": {
      const request = channel === "downloads:start" ? (first as { videoId: string; quality?: string }) : { videoId: downloads.history.find((task) => task.id === first)?.videoId ?? "" };
      downloads.history = downloads.history.filter((task) => task.id !== first);
      const task = { ...downloadTask(detail(request.videoId), "queued", 0), id: `dl-${Date.now()}` };
      downloads = { ...downloads, active: [task, ...downloads.active] };
      emit("downloads:changed", downloads);
      simulateDownload(task);
      return task;
    }
    case "downloads:cancel": {
      const task = downloads.active.find((item) => item.id === first);
      window.clearInterval(progressTimers.get(String(first)));
      if (task) {
        downloads = { active: downloads.active.filter((item) => item !== task), history: [{ ...task, status: "canceled", bytesPerSecond: undefined }, ...downloads.history] };
        emit("downloads:changed", downloads);
      }
      return downloads;
    }
    case "downloads:delete":
      downloads = { ...downloads, history: downloads.history.filter((task) => task.id !== (first as { id: string }).id) };
      emit("downloads:changed", downloads);
      return downloads;
    case "downloads:clear-finished":
      downloads = { ...downloads, history: [] };
      emit("downloads:changed", downloads);
      return downloads;
    case "favorites:list":
      return favorites;
    case "favorites:add":
      favorites = { items: [{ video: first as VideoSummary, favoritedAt: new Date().toISOString() }, ...favorites.items.filter((item) => item.video.id !== (first as VideoSummary).id)] };
      return favorites;
    case "favorites:restore":
      favorites = { items: [first as FavoriteState["items"][number], ...favorites.items] };
      return favorites;
    case "favorites:remove":
      favorites = { items: favorites.items.filter((item) => item.video.id !== first) };
      return favorites;
    case "favorites:backup":
    case "favorites:export":
      return { canceled: false, path: "/Users/you/iwaratv-favorites.json", count: favorites.items.length };
    case "favorites:import":
      return { canceled: true, imported: 0, merged: 0, skipped: 0, total: favorites.items.length, state: favorites };
    case "player:play": {
      await delay(600);
      const request = first as PlayRequest;
      const video = detail(request.videoId);
      const format = video.formats.find((item) => item.id === (request.quality ?? settings.player.preferredQuality)) ?? video.formats[0]!;
      const mode = request.mode ?? settings.player.preferredMode;
      const previous = settings.history.find((entry) => entry.video.id === video.id);
      applyPatch({ history: [{ ...previous, video, formatId: format.id, mode, playedAt: new Date().toISOString() }, ...settings.history.filter((entry) => entry.video.id !== video.id)] });
      // The preview has no stream proxy, so the built-in player shows its error state.
      return mode === "builtin"
        ? { ok: true, mode, streamUrl: "iwara-media://stream/preview", resumeAt: previous?.positionSeconds, format, video }
        : { ok: true, mode, playerPath: "/usr/bin/mpv", format, video };
    }
    case "player:report-progress": {
      const progress = first as PlaybackProgress;
      applyPatch({ history: settings.history.map((entry) => (entry.video.id === progress.videoId ? { ...entry, ...progress } : entry)) });
      return undefined;
    }
    case "iwara:list-related": {
      await delay(400);
      const seed = hash(String(first));
      return Array.from({ length: 8 }, (_, index) => makeVideo(seed + index * 7));
    }
    case "system:clipboard-video":
      return params.get("clipboard") ?? undefined;
    case "player:probe":
      return { mpv: { ok: true, code: "found", resolvedPath: "/usr/bin/mpv" }, external: settings.player.externalPlayerPath ? { ok: true, code: "found", resolvedPath: settings.player.externalPlayerPath } : { ok: false, code: "not-configured" }, externalArgsPreview: [], externalTemplateHasUrl: true };
    case "player:test-mpv":
      await delay(500);
      return { ok: true, code: "launch-ok", resolvedPath: "/usr/bin/mpv", detail: "mpv 0.40.0" };
    case "settings:get":
      return settings;
    case "settings:update":
      applyPatch(first as SettingsPatch);
      return settings;
    case "auth:state":
      await delay(200);
      return auth;
    case "auth:open-verification":
      auth = { ...auth, verificationWindowOpen: true };
      setTimeout(() => {
        auth = { status: "signed-in", username: "demo_user", siteSessionReady: true, siteCookieCount: 6, siteTokenReady: true, siteTokenKey: "localStorage.accessToken", verificationWindowOpen: false };
        emit("auth:changed", auth);
      }, 1500);
      return auth;
    case "auth:sign-out":
      auth = { ...EMPTY_AUTH_STATE };
      return auth;
    case "system:select-executable":
    case "system:select-directory":
      return { canceled: true };
    case "updates:state":
      return updateState;
    case "updates:check":
      setUpdateState({ ...updateState, status: "checking" });
      await delay(700);
      return setUpdateState({ ...updateState, status: updateState.update ? "available" : "up-to-date", checkedAt: new Date().toISOString() });
    case "updates:download": {
      const total = updateState.update?.size ?? 1;
      for (let received = 0; received < total; received += total / 12) {
        setUpdateState({ ...updateState, status: "downloading", progress: { received, total } });
        await delay(250);
      }
      return setUpdateState({ ...updateState, status: "ready", progress: undefined });
    }
    case "updates:install":
      return updateState;
    case "updates:skip":
      return setUpdateState({ ...updateState, update: updateState.update && { ...updateState.update, skipped: true } });
    case "system:app-info":
      return { name: "IwaraTV", version: "preview", electron: "—", chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "—", node: "—", platform: "web", arch: "—", userDataPath: "~/.config/IwaraTV", systemLocale: navigator.language };
    default:
      return undefined;
  }
}

export function installMockBridge(): void {
  const bridge: IwaraTVBridge = {
    async invoke(channel, ...args) {
      try {
        return { ok: true, data: await handle(channel, args) } as IpcResponse<never>;
      } catch (error) {
        return { ok: false, error: { code: "UNKNOWN", message: String(error) } };
      }
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener as (payload: unknown) => void);
      listeners.set(channel, set);
      return () => set.delete(listener as (payload: unknown) => void);
    },
    platform: "web"
  };
  window.iwaraTV = bridge;
}

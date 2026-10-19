// A small stand-in for Iwara used by the end-to-end smoke test. One HTTPS
// server answers for every *.iwara.tv host (Electron maps them to it with
// --host-resolver-rules) and implements just enough of the site, the API, the
// signed file list and the media CDN for the app's main flows.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";

/** Differs from the app's built-in default, so file lists only work after salt detection. */
export const MOCK_SALT = "E2eMockSaltZx81Qw7Lp4Rt9Vn2Ks6Hd0";
export const MEDIA_SIZE = 3 * 1024 * 1024 + 777;
export const VIEWER = { id: "user-me", name: "E2E Viewer", username: "e2e_viewer" };

const AUTHORS = [
  { id: "author-aiko", name: "Aiko Studio", username: "aiko_studio" },
  { id: "author-bay", name: "Blender Bay", username: "blender_bay" },
  { id: "author-cel", name: "Cel Shade Works", username: "celshade" }
];
const TITLE_WORDS = ["Neon", "Sakura", "Midnight", "Aurora", "Velvet", "Crystal", "Summer", "Echo"];
const TAGS = ["dance", "mmd", "koikatsu", "original", "music"];

export const VIDEOS = Array.from({ length: 40 }, (_, index) => {
  const author = AUTHORS[index % AUTHORS.length];
  return {
    id: `vid${String(index).padStart(11, "0")}`,
    title: `${TITLE_WORDS[index % TITLE_WORDS.length]} ${["Dance", "Motion", "Study", "Loop"][index % 4]} #${index + 1}`,
    body: `<p>Mock video number ${index + 1}.<br>Rendered for the IwaraTV smoke test.</p>`,
    rating: index % 5 === 0 ? "ecchi" : "general",
    thumbnail: index % 12,
    numLikes: 40 * index + 7,
    numViews: 1300 * index + 52,
    numComments: index % 3,
    file: { id: `file-${index}`, type: "video", name: `file-${index}.mp4`, duration: 60 + index * 7 },
    customThumbnail: null,
    user: { ...author, following: false, avatar: { id: `avatar-${author.username}` } },
    tags: [{ id: TAGS[index % TAGS.length], type: "general" }, { id: TAGS[(index + 2) % TAGS.length], type: "general" }],
    createdAt: new Date(Date.UTC(2026, 9, 19, 12) - index * 5 * 3600_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 19, 12) - index * 5 * 3600_000).toISOString()
  };
});

export function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.bW9jaw`;
}

/** Deterministic media bytes, so the test can verify the downloaded file. */
export const MEDIA = Buffer.alloc(MEDIA_SIZE);
for (let index = 0; index < MEDIA_SIZE; index += 1) {
  MEDIA[index] = (index * 31 + (index >> 8)) & 0xff;
}
export const MEDIA_SHA256 = createHash("sha256").update(MEDIA).digest("hex");

function selfSignedCertificate() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "iwaratv-e2e-cert-"));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", "/CN=iwara.tv",
    "-addext", "subjectAltName=DNS:iwara.tv,DNS:*.iwara.tv"
  ], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

function svgImage(seed, label) {
  const hue = [...seed].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},65%,30%)"/>
</linearGradient></defs><rect width="640" height="360" fill="url(#g)"/>
<circle cx="500" cy="90" r="120" fill="rgba(255,255,255,.12)"/><circle cx="120" cy="300" r="160" fill="rgba(0,0,0,.12)"/>
<text x="32" y="330" font-family="sans-serif" font-size="28" fill="rgba(255,255,255,.75)">${label}</text></svg>`;
}

export async function startMockIwara() {
  const state = {
    requests: [],
    following: new Set(),
    comments: new Map(),
    postedComments: [],
    followRequests: [],
    /** When set, `GET /videos` answers with a redirect here (to test token scoping). */
    redirectVideosTo: undefined
  };
  const userToken = makeJwt({ id: VIEWER.id, username: VIEWER.username, type: "refresh_token", exp: Math.floor(Date.now() / 1000) + 7200 });
  const mediaToken = makeJwt({ id: VIEWER.id, type: "access_token", exp: Math.floor(Date.now() / 1000) + 3600 });

  const bearer = (request) => request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const authorized = (request) => [userToken, mediaToken].includes(bearer(request) ?? "");

  const withFollowing = (video, request) => ({
    ...video,
    user: { ...video.user, following: authorized(request) && state.following.has(video.user.id) }
  });

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body === undefined ? "" : JSON.stringify(body));
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function videoList(request, url, response) {
    const subscribed = url.searchParams.get("subscribed") === "true";
    if (subscribed && !authorized(request)) {
      return json(response, 401, { message: "errors.unauthorized" });
    }
    let list = VIDEOS;
    if (subscribed) {
      list = list.filter((video) => state.following.has(video.user.id) || video.user.id === AUTHORS[0].id);
    }
    const user = url.searchParams.get("user");
    if (user) {
      list = list.filter((video) => video.user.id === user);
    }
    const tags = url.searchParams.get("tags");
    if (tags) {
      list = list.filter((video) => video.tags.some((tag) => tag.id === tags));
    }
    const rating = url.searchParams.get("rating");
    if (rating && rating !== "all") {
      list = list.filter((video) => video.rating === rating);
    }
    if (url.searchParams.get("sort") === "trending") {
      list = [...list].reverse();
    } else if (url.searchParams.get("sort") === "popularity") {
      list = [...list].sort((a, b) => b.numLikes - a.numLikes);
    }
    const page = Number(url.searchParams.get("page") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 32);
    const results = list.slice(page * limit, page * limit + limit);
    // Like the live API: count is a has-more hint, not the total.
    const more = list.length > (page + 1) * limit;
    json(response, 200, { count: results.length + (more ? 1 : 0), limit, page, results: results.map((video) => withFollowing(video, request)) });
  }

  async function api(request, url, response) {
    const { pathname } = url;
    if (pathname === "/videos" && request.method === "GET") {
      if (state.redirectVideosTo) {
        response.writeHead(302, { location: state.redirectVideosTo });
        return response.end();
      }
      return videoList(request, url, response);
    }
    if (pathname === "/search" && request.method === "GET") {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const results = VIDEOS.filter((video) => video.title.toLowerCase().includes(query));
      const page = Number(url.searchParams.get("page") ?? 0);
      return json(response, 200, { count: results.length, limit: 32, page, results: results.slice(page * 32, page * 32 + 32) });
    }
    if (pathname === "/user" && request.method === "GET") {
      return authorized(request)
        ? json(response, 200, { user: { ...VIEWER, avatar: { id: "avatar-viewer" } }, profile: null })
        : json(response, 401, { message: "errors.unauthorized" });
    }
    if (pathname === "/user/token" && request.method === "POST") {
      return bearer(request) === userToken ? json(response, 200, { accessToken: mediaToken }) : json(response, 401, { message: "errors.unauthorized" });
    }
    const videoMatch = pathname.match(/^\/video\/([^/]+)(\/comments)?$/);
    const video = videoMatch && VIDEOS.find((item) => item.id === videoMatch[1]);
    if (videoMatch && !video) {
      return json(response, 404, { message: "errors.notFound" });
    }
    if (video && !videoMatch[2] && request.method === "GET") {
      const expires = Date.now() + 3600_000;
      return json(response, 200, {
        ...withFollowing(video, request),
        fileUrl: `https://files.iwara.tv/file/${video.file.id}?expires=${expires}&hash=mockhash`
      });
    }
    if (video && videoMatch[2]) {
      const list = state.comments.get(video.id) ?? [
        { id: `${video.id}-c1`, body: "Lovely motion work!", numReplies: 1, createdAt: "2026-10-18T10:00:00.000Z", user: { id: AUTHORS[1].id, name: AUTHORS[1].name, username: AUTHORS[1].username, avatar: { id: "avatar-blender_bay" } } },
        { id: `${video.id}-r1`, parent: `${video.id}-c1`, body: "Thank you!", numReplies: 0, createdAt: "2026-10-18T11:00:00.000Z", user: { ...video.user } }
      ];
      state.comments.set(video.id, list);
      if (request.method === "POST") {
        if (!authorized(request)) {
          return json(response, 401, { message: "errors.unauthorized" });
        }
        const payload = JSON.parse((await readBody(request)) || "{}");
        const comment = {
          id: `${video.id}-n${list.length}`,
          body: payload.body,
          parent: payload.parent,
          numReplies: 0,
          createdAt: new Date().toISOString(),
          user: { id: VIEWER.id, name: VIEWER.name, username: VIEWER.username, avatar: { id: "avatar-viewer" } }
        };
        list.unshift(comment);
        state.postedComments.push({ videoId: video.id, ...payload });
        return json(response, 201, comment);
      }
      const parent = url.searchParams.get("parent") ?? undefined;
      const scoped = list.filter((comment) => comment.parent === parent);
      return json(response, 200, { count: scoped.length, limit: 20, page: 0, results: scoped });
    }
    return json(response, 404, { message: "errors.notFound" });
  }

  function apiq(request, url, response) {
    const match = url.pathname.match(/^\/user\/([^/]+)\/followers$/);
    if (!match || !["POST", "DELETE"].includes(request.method)) {
      return json(response, 404, { message: "errors.notFound" });
    }
    if (!authorized(request)) {
      return json(response, 401, { message: "errors.unauthorized" });
    }
    state.followRequests.push(`${request.method} ${match[1]}`);
    if (request.method === "POST") {
      state.following.add(match[1]);
    } else {
      state.following.delete(match[1]);
    }
    response.writeHead(204);
    response.end();
  }

  function files(request, url, response) {
    const fileId = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const expires = url.searchParams.get("expires");
    const expected = createHash("sha1").update(`${fileId}_${expires}_${MOCK_SALT}`).digest("hex");
    if (request.headers["x-version"] !== expected) {
      return json(response, 403, { message: "errors.forbidden" });
    }
    const source = (name) => `//jade.iwara.tv/${name}?filename=${fileId}.mp4&expires=${expires}&hash=media`;
    json(response, 200, [
      { id: `${fileId}-360`, name: "360", type: "video/mp4", src: { view: source("view/360"), download: source("download/360") } },
      { id: `${fileId}-540`, name: "540", type: "video/mp4", src: { view: source("view/540"), download: source("download/540") } },
      { id: `${fileId}-src`, name: "Source", type: "video/mp4", src: { view: source("view/source"), download: source("download/source") } }
    ]);
  }

  function media(request, response) {
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-length": MEDIA_SIZE, "accept-ranges": "bytes", "content-type": "video/mp4" });
      return response.end();
    }
    if (!range) {
      response.writeHead(200, { "content-length": MEDIA_SIZE, "accept-ranges": "bytes", "content-type": "video/mp4" });
      return response.end(MEDIA);
    }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : MEDIA_SIZE - 1, MEDIA_SIZE - 1);
    if (start >= MEDIA_SIZE) {
      response.writeHead(416, { "content-range": `bytes */${MEDIA_SIZE}` });
      return response.end();
    }
    response.writeHead(206, {
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${MEDIA_SIZE}`,
      "accept-ranges": "bytes",
      "content-type": "video/mp4"
    });
    response.end(MEDIA.subarray(start, end + 1));
  }

  function website(request, url, response) {
    const html = (body, headers = {}) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Iwara (mock)</title>
<style>body{font-family:sans-serif;background:#16181d;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
button{font-size:18px;padding:10px 24px;border-radius:8px;border:0;background:#00bcd4;color:#012}</style>
<script src="/main.e2e1234.js"></script></head><body>${body}</body></html>`);
    };
    if (url.pathname === "/main.e2e1234.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      // Shaped like the real bundle: the salt literal next to the X-Version code.
      return response.end(`window.__iwaraSigner = { header: "X-Version", salt: "${MOCK_SALT}", sign: (fileUrl, expires) => [fileUrl, expires].join("_") };`);
    }
    if (url.pathname === "/login") {
      return html(`<main><h1>Iwara sign-in (mock)</h1>
<button id="sign-in" onclick="localStorage.setItem('token','${userToken}');document.cookie='mock_session=1; path=/; secure; max-age=3600';this.textContent='Signed in'">Sign in</button></main>`, {
        "set-cookie": "cf_clearance=mock; Path=/; Domain=.iwara.tv; Secure; SameSite=None; Max-Age=3600"
      });
    }
    return html("<main><h1>Iwara (mock)</h1></main>");
  }

  const server = createServer(selfSignedCertificate(), (request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    const url = new URL(request.url ?? "/", `https://${host}`);
    state.requests.push({ host, method: request.method, path: url.pathname, headers: request.headers });
    void (async () => {
      if (host === "api.iwara.tv") {
        return api(request, url, response);
      }
      if (host === "apiq.iwara.tv") {
        return apiq(request, url, response);
      }
      if (host === "files.iwara.tv" || host === "filesq.iwara.tv") {
        return files(request, url, response);
      }
      if (host === "i.iwara.tv") {
        const id = url.pathname.split("/")[3] ?? "x";
        const isAvatar = url.pathname.startsWith("/image/avatar/");
        response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
        return response.end(svgImage(id, isAvatar ? "" : id.replace("file-", "#")));
      }
      if (host === "www.iwara.tv" || host === "iwara.tv") {
        return website(request, url, response);
      }
      if (host.endsWith(".iwara.tv")) {
        return media(request, response);
      }
      json(response, 404, { message: "errors.notFound" });
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    userToken,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

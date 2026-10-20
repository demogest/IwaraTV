import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

export function tempDir(name: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `iwaratv-${name}-`));
}

/** A video object shaped like a real `GET /videos` result from api.iwara.tv. */
export function rawVideo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "0bmwbE50acZY4B",
    title: "Sample video",
    body: "<p>First line<br>Second &amp; third</p>",
    rating: "ecchi",
    thumbnail: 9,
    numLikes: 3,
    numViews: 63,
    numComments: 0,
    file: {
      id: "a283691e-4be7-4f7b-9f90-11a922a06fb6",
      type: "video",
      name: "a283691e-4be7-4f7b-9f90-11a922a06fb6.mp4",
      duration: 494
    },
    customThumbnail: null,
    user: {
      id: "76e89cf1-aec6-4e32-b620-c16acc9723e0",
      name: "kqjtv",
      username: "jtvkq",
      following: false,
      avatar: { id: "1511e132-d973-4181-8e1e-e3e8aadadc6d", name: "1511e132-d973-4181-8e1e-e3e8aadadc6d.jpeg" }
    },
    tags: [
      { id: "koikatsu", type: "category", sensitive: false },
      { id: "Mind_Break", type: "general", sensitive: false }
    ],
    createdAt: "2026-10-19T15:21:15.000Z",
    updatedAt: "2026-10-19T15:32:48.000Z",
    ...overrides
  };
}

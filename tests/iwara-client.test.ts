import { describe, expect, it, vi } from "vitest";
import { IwaraClient } from "../src/main/services/iwara-client";
import type { AuthState, TagPreferences, VideoSummary } from "../src/shared/types";

vi.mock("electron", () => ({
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    isEncryptionAvailable: vi.fn(() => false)
  }
}));

const defaultPreferences: TagPreferences = {
  followedTags: [],
  blockedTags: [],
  maxScanPages: 1,
  requestDelayMs: 0
};

const anonymousAuth = {
  clear: vi.fn(),
  getMediaToken: vi.fn(() => undefined),
  getUserToken: vi.fn(() => undefined),
  saveUserToken: vi.fn(),
  setMediaToken: vi.fn(),
  state: vi.fn((): AuthState => ({
    loggedIn: false,
    hasMediaToken: false,
    encryptionAvailable: false
  }))
};

describe("IwaraClient listVideos tag handling", () => {
  it("uses one server tag, then applies multi-tag and blocked filters client-side", async () => {
    const requests: URL[] = [];
    const pages: VideoSummary[][] = [
      [
        video("ok", ["breeding", "koikatsu"]),
        video("missing-second-tag", ["breeding"]),
        video("blocked", ["breeding", "koikatsu", "muted"])
      ],
      [video("also-ok", ["breeding", "koikatsu"])],
      [video("too-far", ["breeding", "koikatsu"])]
    ];
    const client = new IwaraClient(
      anonymousAuth as never,
      async () => ({}),
      async () => undefined,
      async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        const page = Number(parsed.searchParams.get("page") ?? 0);
        return jsonResponse({ total: 96, results: pages[page] ?? [] });
      }
    );

    const result = await client.listVideos(
      { sort: "date", page: 0, tags: ["breeding", "koikatsu"] },
      {
        tagPreferences: {
          ...defaultPreferences,
          blockedTags: ["muted"],
          maxScanPages: 3
        }
      }
    );

    expect(requests).toHaveLength(3);
    expect(requests.every((url) => url.searchParams.get("tags") === "breeding")).toBe(true);
    expect(result.scannedPages).toBe(3);
    expect(result.blockedCount).toBe(1);
    expect(result.results.map((item) => item.id)).toEqual(["ok", "also-ok", "too-far"]);
  });

  it("aggregates followed tags and still lets blocked tags win", async () => {
    const requests: URL[] = [];
    const client = new IwaraClient(
      anonymousAuth as never,
      async () => ({}),
      async () => undefined,
      async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        const tag = parsed.searchParams.get("tags");
        return jsonResponse({
          results: tag === "breeding"
            ? [video("kept", ["breeding", "koikatsu"]), video("blocked", ["breeding", "muted"])]
            : [video("duplicate", ["koikatsu"]), video("kept", ["breeding", "koikatsu"])]
        });
      }
    );

    const result = await client.listVideos(
      { sort: "date", page: 0, followedOnly: true },
      {
        tagPreferences: {
          ...defaultPreferences,
          followedTags: ["breeding", "koikatsu"],
          blockedTags: ["muted"]
        }
      }
    );

    expect(requests.map((url) => url.searchParams.get("tags"))).toEqual(["breeding", "koikatsu"]);
    expect(result.scannedPages).toBe(2);
    expect(result.blockedCount).toBe(1);
    expect(result.results.map((item) => item.id)).toEqual(["kept", "duplicate"]);
  });
});

function video(id: string, tags: string[]): VideoSummary {
  return {
    id,
    title: id,
    tags,
    numViews: 0,
    numLikes: 0,
    numComments: 0,
    createdAt: "2026-05-05T00:00:00.000Z"
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9]{6,}$/;
const VIDEO_URL_PATTERN = /iwara\.tv\/videos?\/([a-zA-Z0-9]+)/i;

/** Extracts an Iwara video ID from a bare ID or a video page URL. */
export function parseIwaraVideoId(input: string): string | undefined {
  const trimmed = input.trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return VIDEO_URL_PATTERN.exec(trimmed)?.[1];
}

export function iwaraVideoPageUrl(videoId: string): string {
  return `https://www.iwara.tv/video/${encodeURIComponent(videoId)}`;
}

export function iwaraProfilePageUrl(username: string): string {
  return `https://www.iwara.tv/profile/${encodeURIComponent(username)}`;
}

export type OmniboxIntent =
  | { kind: "empty" }
  | { kind: "video"; videoId: string }
  | { kind: "search"; query: string }
  /** A single ID-shaped token: could be a video ID or a search keyword. */
  | { kind: "ambiguous"; videoId: string; query: string; preferVideo: boolean };

/** Decides what pressing Enter in the top search box should do. */
export function classifyOmniboxInput(input: string): OmniboxIntent {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }

  const urlMatch = VIDEO_URL_PATTERN.exec(trimmed);
  if (urlMatch?.[1]) {
    return { kind: "video", videoId: urlMatch[1] };
  }

  if (VIDEO_ID_PATTERN.test(trimmed)) {
    const looksGenerated = trimmed.length >= 10 && /\d/.test(trimmed) && /[a-zA-Z]/.test(trimmed);
    return { kind: "ambiguous", videoId: trimmed, query: trimmed, preferVideo: looksGenerated };
  }

  return { kind: "search", query: trimmed };
}

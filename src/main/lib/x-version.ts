import { createHash } from "node:crypto";
import { DEFAULT_X_VERSION_SALT } from "../../shared/defaults";
import { AppError } from "./app-error";

/** X-Version = sha1(`${fileId}_${expires}_${salt}`), required by Iwara's file list endpoint. */
export function buildXVersion(fileUrl: string, salt: string | undefined = DEFAULT_X_VERSION_SALT): string {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new AppError("INVALID_RESPONSE", "Iwara returned an invalid file URL.");
  }
  const expires = parsed.searchParams.get("expires");
  const fileId = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!expires || !fileId) {
    throw new AppError("INVALID_RESPONSE", "The Iwara file URL is missing the parameters needed for X-Version.");
  }

  return createHash("sha1").update(`${fileId}_${expires}_${salt || DEFAULT_X_VERSION_SALT}`).digest("hex");
}

const SALT_PATTERN = /["_]([A-Za-z0-9]{20,80})["']/g;
const SALT_CONTEXT_HINTS = ["X-Version", "fileUrl", "expires", "SHA-1", "crypto.subtle.digest"];

/** Finds the most plausible X-Version salt literal in Iwara's bundled frontend script. */
export function extractXVersionSaltFromScript(script: string): string | undefined {
  let best: { salt: string; score: number } | undefined;

  for (const match of script.matchAll(SALT_PATTERN)) {
    const salt = match[1];
    if (!salt || !/[A-Z]/.test(salt) || !/[a-z]/.test(salt) || !/\d/.test(salt)) {
      continue;
    }
    const index = (match.index ?? 0) + 1;
    const context = script.slice(Math.max(0, index - 1200), Math.min(script.length, index + 1600));
    const score = SALT_CONTEXT_HINTS.filter((hint) => context.includes(hint)).length;
    if (!best || score > best.score || (score === best.score && salt.length >= best.salt.length)) {
      best = { salt, score };
    }
  }

  return best?.salt;
}

const SCRIPT_SRC_PATTERN = /<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']/g;

/** Script URLs from Iwara's home page, most likely salt carriers first. */
export function scriptUrlsFromHtml(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(SCRIPT_SRC_PATTERN)) {
    try {
      urls.push(new URL(match[1]!, baseUrl).toString());
    } catch {
      // Ignore malformed script URLs.
    }
  }
  const score = (url: string) => (/\/main\.[\w-]+\.js/.test(url) ? 2 : url.endsWith(".js") ? 1 : 0);
  return [...new Set(urls)].sort((a, b) => score(b) - score(a));
}

/** Custom scheme the built-in player streams from; the main process proxies it to Iwara's CDN. */
export const MEDIA_STREAM_SCHEME = "iwara-media";

const IWARA_MEDIA_HOST_PATTERN = /^[a-z0-9-]+\.iwara\.tv$/i;

/** True for https URLs on iwara.tv or one of its subdomains — the only hosts that may see the session token. */
export function isIwaraUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "iwara.tv" || hostname.endsWith(".iwara.tv"));
  } catch {
    return false;
  }
}

/** Normalizes user- or API-provided media hosts to bare `*.iwara.tv` hostnames. */
export function normalizeMediaHostList(hosts: readonly string[]): string[] {
  const cleaned = hosts
    .map((host) => host.trim().toLowerCase())
    .map((host) => host.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((host) => IWARA_MEDIA_HOST_PATTERN.test(host));

  return [...new Set(cleaned)];
}

export function mediaUrlHost(url: string): string | undefined {
  try {
    return new URL(normalizeAbsoluteMediaUrl(url)).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function replaceMediaUrlHost(url: string, host: string): string | undefined {
  try {
    const parsed = new URL(normalizeAbsoluteMediaUrl(url));
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function buildMediaHostCandidates(url: string, hosts: readonly string[]): Array<{ host: string; url: string }> {
  const original = mediaUrlHost(url);
  return normalizeMediaHostList([original ?? "", ...hosts])
    .map((host) => ({ host, url: replaceMediaUrlHost(url, host) }))
    .filter((candidate): candidate is { host: string; url: string } => Boolean(candidate.url));
}

export function normalizeAbsoluteMediaUrl(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

const MEDIA_HOST_PATTERN = /^[a-z0-9-]+\.iwara\.tv$/i;

export function normalizeMediaHostList(hosts: string[]): string[] {
  const cleaned = hosts
    .map((host) => host.trim().toLowerCase())
    .map((host) => host.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter((host) => MEDIA_HOST_PATTERN.test(host));

  return [...new Set(cleaned)];
}

export function mediaUrlHost(url: string): string | undefined {
  try {
    return new URL(normalizeAbsoluteMediaUrl(url)).hostname;
  } catch {
    return undefined;
  }
}

export function buildMediaHostCandidates(url: string, hosts: string[]): Array<{ host: string; url: string }> {
  const original = mediaUrlHost(url);
  const candidates = normalizeMediaHostList([original ?? "", ...hosts]);

  return candidates
    .map((host) => ({ host, url: replaceMediaUrlHost(url, host) }))
    .filter((candidate): candidate is { host: string; url: string } => Boolean(candidate.url));
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

function normalizeAbsoluteMediaUrl(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

// Semantic-version parsing and ordering for update checks (semver.org §11).

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): SemVer | undefined {
  const match = PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { major, minor, patch, prerelease };
}

/** Negative when a < b, positive when a > b, 0 when equal. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return left ? 1 : right ? -1 : 0;
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  // A pre-release sorts below its release.
  if (!left.prerelease.length || !right.prerelease.length) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.prerelease[index];
    const y = right.prerelease[index];
    if (x === undefined || y === undefined) {
      return x === undefined ? -1 : 1;
    }
    if (x === y) {
      continue;
    }
    if (typeof x === "number" && typeof y === "number") {
      return x - y;
    }
    // Numeric identifiers sort below alphanumeric ones.
    if (typeof x === "number" || typeof y === "number") {
      return typeof x === "number" ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return Boolean(parseVersion(candidate)) && compareVersions(candidate, current) > 0;
}

export function isMajorUpgrade(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  return Boolean(next && now && next.major > now.major);
}

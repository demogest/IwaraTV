// JWT helpers and the logic that finds Iwara's web-session token inside a dump
// of the site's localStorage/sessionStorage.

const JWT_CANDIDATE_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const MAX_JSON_DEPTH = 24;

export interface StorageDump {
  localStorage?: Record<string, string | null>;
  sessionStorage?: Record<string, string | null>;
}

export interface CapturedToken {
  key: string;
  value: string;
  username?: string;
}

export function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return undefined;
  }
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** True for strings shaped like a JWT whose header and payload decode to JSON objects. */
export function isLikelyJwt(token: string): boolean {
  const [header] = token.split(".");
  if (!header?.startsWith("eyJ")) {
    return false;
  }
  try {
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown;
    return typeof decodedHeader === "object" && decodedHeader !== null && jwtPayload(token) !== undefined;
  } catch {
    return false;
  }
}

export function jwtExpiry(token: string): Date | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : undefined;
}

/** Tokens without an `exp` claim are treated as non-expiring, matching the site. */
export function isJwtExpired(token: string, skewSeconds: number, now = Date.now()): boolean {
  const expiry = jwtExpiry(token);
  return expiry ? expiry.getTime() <= now + skewSeconds * 1000 : false;
}

const USERNAME_CLAIMS = [
  "username",
  "name",
  "preferred_username",
  "displayName",
  "display_name",
  "nickname",
  "user.username",
  "user.name",
  "profile.username",
  "profile.name"
];

export function usernameFromJwt(token: string): string | undefined {
  const payload = jwtPayload(token);
  if (!payload) {
    return undefined;
  }
  for (const claim of USERNAME_CLAIMS) {
    const value = claim.split(".").reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), payload);
    const text = nonEmptyText(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

const PREFERRED_TOKEN_KEYS = ["accesstoken", "access_token", "authtoken", "usertoken", "token"];

export function findToken(storage: StorageDump): CapturedToken | undefined {
  const entries: Array<[string, string | null]> = [
    ...Object.entries(storage.localStorage ?? {}).map(([key, value]) => [`localStorage.${key}`, value] as [string, string | null]),
    ...Object.entries(storage.sessionStorage ?? {}).map(([key, value]) => [`sessionStorage.${key}`, value] as [string, string | null])
  ];
  const storageUsername = findStorageUsername(entries);
  const capture = (key: string, value: string): CapturedToken => ({
    key,
    value,
    username: storageUsername ?? usernameFromJwt(value)
  });

  for (const preferred of PREFERRED_TOKEN_KEYS) {
    for (const [key, value] of entries) {
      if (!key.toLowerCase().endsWith(`.${preferred}`)) {
        continue;
      }
      const token = findJwt(value);
      if (token) {
        return capture(key, token);
      }
    }
  }

  for (const [key, value] of entries) {
    const token = findJwt(value);
    if (token) {
      return capture(key, token);
    }
  }

  return undefined;
}

export function findJwt(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return findJwtInText(value) ?? findJwtInJson(parseJson(value), 0);
}

function findJwtInText(value: string): string | undefined {
  for (const match of value.matchAll(JWT_CANDIDATE_PATTERN)) {
    if (isLikelyJwt(match[0])) {
      return match[0];
    }
  }
  return undefined;
}

function findJwtInJson(value: unknown, depth: number): string | undefined {
  if (depth > MAX_JSON_DEPTH || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return findJwtInText(value) ?? findJwtInJson(parseJson(value), depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJwtInJson(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) {
      const found = findJwtInJson(item, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

const USERNAME_STORAGE_TERMS = ["auth", "user", "account", "profile", "session", "pinia", "store", "persist"];

function findStorageUsername(entries: Array<[string, string | null]>): string | undefined {
  for (const [key, value] of entries) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.endsWith(".username")
      || normalizedKey.endsWith(".user_name")
      || normalizedKey.endsWith(".displayname")
      || normalizedKey.endsWith(".display_name")
    ) {
      const text = nonEmptyText(value);
      if (text) {
        return text;
      }
      continue;
    }
    if (USERNAME_STORAGE_TERMS.some((term) => normalizedKey.includes(term))) {
      const found = findUsernameInStorageValue(value);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function findUsernameInStorageValue(value: string | null | undefined): string | undefined {
  return value ? findUsernameInJson(parseJson(value), 0) : undefined;
}

const USER_CONTAINER_KEYS = ["currentUser", "current_user", "authUser", "auth_user", "profile", "account", "user", "me"];
const USERNAME_KEYS = ["username", "userName", "user_name", "displayName", "display_name", "name", "nickname"];

function findUsernameInJson(value: unknown, depth: number): string | undefined {
  if (depth > MAX_JSON_DEPTH || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return findUsernameInJson(parseJson(value), depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsernameInJson(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isObject(value)) {
    return undefined;
  }
  for (const key of USER_CONTAINER_KEYS) {
    const found = findUsernameInJson(value[key], depth + 1);
    if (found) {
      return found;
    }
  }
  for (const key of USERNAME_KEYS) {
    const text = typeof value[key] === "string" ? nonEmptyText(value[key]) : undefined;
    if (text) {
      return text;
    }
  }
  for (const item of Object.values(value)) {
    const found = findUsernameInJson(item, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

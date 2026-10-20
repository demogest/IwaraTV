// Recent search terms, kept in this window's storage (a per-user convenience;
// nothing breaks if storage is unavailable).

const KEY = "iwaratv.recentSearches";
const LIMIT = 8;

export function readRecentSearches(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function write(values: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(values.slice(0, LIMIT)));
  } catch {
    // Optional convenience.
  }
}

export function addRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (trimmed) {
    write([trimmed, ...readRecentSearches().filter((item) => item.toLowerCase() !== trimmed.toLowerCase())]);
  }
}

export function removeRecentSearch(query: string): void {
  write(readRecentSearches().filter((item) => item !== query));
}

export function clearRecentSearches(): void {
  write([]);
}

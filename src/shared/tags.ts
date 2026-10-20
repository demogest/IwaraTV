export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Lower-cases, trims and de-duplicates tags while keeping their order. */
export function normalizeTagList(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const value = normalizeTag(tag);
    if (value && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

/** Splits pasted or typed text into tags (whitespace, commas, semicolons, CJK punctuation). */
export function splitTagInput(input: string): string[] {
  return normalizeTagList(input.split(/[\s,;，；、]+/));
}

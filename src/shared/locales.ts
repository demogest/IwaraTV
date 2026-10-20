// The UI languages IwaraTV ships, shared by the renderer (dictionaries) and the
// main process (menus and notifications).

export const LOCALES = ["en", "zh-CN", "zh-TW", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's name in itself, for the language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語"
};

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * Picks the first supported language from a preference list such as
 * `navigator.languages`. Traditional Chinese covers Taiwan, Hong Kong, Macau
 * and explicit Hant tags; other Chinese variants use Simplified Chinese.
 */
export function matchLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase().replace(/_/g, "-");
    if (tag === "zh" || tag.startsWith("zh-")) {
      return /^zh-(?:hant|tw|hk|mo)\b/.test(tag) ? "zh-TW" : "zh-CN";
    }
    if (tag === "ja" || tag.startsWith("ja-")) {
      return "ja";
    }
    if (tag === "en" || tag.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

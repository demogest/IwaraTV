import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LanguagePreference } from "../../shared/types";
import { en, type Dictionary } from "./en";
import { zhCN } from "./zh-CN";

export type Locale = "zh-CN" | "en";

export interface PluralForms {
  one?: string;
  other: string;
}

type Leaf = string | PluralForms;

/** Same shape as the English dictionary; plural forms may collapse to one string. */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends PluralForms ? PluralForms | string : Translation<T[K]>;
};

type Paths<T> = {
  [K in keyof T & string]: T[K] extends Leaf ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];

export type TranslationKey = Paths<Dictionary>;
export type TranslationParams = Record<string, string | number | undefined>;
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

const dictionaries: Record<Locale, Translation<Dictionary>> = { en, "zh-CN": zhCN };

export function resolveLocale(preference: LanguagePreference, systemLanguages: readonly string[] = navigator.languages): Locale {
  if (preference !== "system") {
    return preference;
  }
  return systemLanguages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

function lookup(dictionary: Translation<Dictionary>, key: string): Leaf | undefined {
  let current: unknown = dictionary;
  for (const part of key.split(".")) {
    current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[part] : undefined;
  }
  return typeof current === "string" || (typeof current === "object" && current !== null && "other" in current)
    ? (current as Leaf)
    : undefined;
}

export function createTranslator(locale: Locale): Translate {
  const numberFormat = new Intl.NumberFormat(locale);
  const plural = new Intl.PluralRules(locale);
  return (key, params) => {
    const entry = lookup(dictionaries[locale], key) ?? lookup(en, key) ?? key;
    const template = typeof entry === "string"
      ? entry
      : (typeof params?.count === "number" && plural.select(params.count) === "one" && entry.one) || entry.other;
    if (!params) {
      return template;
    }
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params[name];
      if (value === undefined) {
        return match;
      }
      return typeof value === "number" ? numberFormat.format(value) : value;
    });
  };
}

interface I18nValue {
  locale: Locale;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({ locale: "en", t: createTranslator("en") });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

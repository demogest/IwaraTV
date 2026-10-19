import type { Locale } from "../i18n";

export function compactNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60]
];

/** "3 days ago" / "3 天前"; falls back to "just now" under a minute. */
export function relativeTime(value: string | undefined, locale: Locale, now = Date.now()): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) {
    return "";
  }
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(0, "minute");
}

export function formatDate(value: string | undefined, locale: Locale): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(time) : "";
}

export function formatDateTime(value: string | undefined, locale: Locale): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(time)
    : "";
}

export function formatTime(value: string | undefined, locale: Locale): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(time) : "";
}

export function formatBytes(value: number | undefined, locale: Locale): string {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit >= 2 ? 1 : 0 }).format(size)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | undefined, locale: Locale): string {
  return bytesPerSecond ? `${formatBytes(bytesPerSecond, locale)}/s` : "—";
}

/** Compact remaining-time label such as "2:05" or "1:02:03". */
export function formatRemaining(remainingBytes: number, bytesPerSecond: number | undefined): string | undefined {
  if (!bytesPerSecond || bytesPerSecond <= 0 || remainingBytes <= 0) {
    return undefined;
  }
  return formatDuration(remainingBytes / bytesPerSecond);
}

export function qualityLabel(label: string): string {
  return /^\d+$/.test(label) ? `${label}p` : label === "preview" ? "Preview" : label;
}

export function modKey(): string {
  return /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";
}

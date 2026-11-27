import { INTL_TAG, type Locale } from "@/i18n/locales";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** « à l'instant », « il y a 4 min », « il y a 3 h 12 » ; « just now », « 4 min ago ». */
export function ago(minutes: number, locale: Locale): string {
  if (locale === "en") {
    if (minutes < 1) return "just now";
    return `${duration(minutes, locale)} ago`;
  }
  if (minutes < 1) return "à l'instant";
  return `il y a ${duration(minutes, locale)}`;
}

/** Durée sans « il y a » : « 3 h 12 », « 3 h 12 min ». */
export function duration(minutes: number, locale: Locale): string {
  if (minutes < 1)
    return locale === "en" ? "under a minute" : "moins d'une minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!m) return `${h} h`;
  return locale === "en"
    ? `${h} h ${m} min`
    : `${h} h ${String(m).padStart(2, "0")}`;
}

/** Accord d'un nom compté : le français met le singulier jusqu'à 1, l'anglais pour 1 seul. */
export function plural(
  n: number,
  one: string,
  many: string,
  locale: Locale,
): string {
  const single = locale === "en" ? n === 1 : n <= 1;
  return `${number(n, 0, locale)} ${single ? one : many}`;
}

const NNBSP = "\u202f";
const numberFormats = new Map<string, Intl.NumberFormat>();

/** Nombre dans la langue : « 43,7 » et espace fine en français, « 43.7 » en anglais. */
export function number(value: number, digits: number, locale: Locale): string {
  const key = `${locale}:${digits}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(INTL_TAG[locale], {
      maximumFractionDigits: digits,
    });
    numberFormats.set(key, f);
  }
  const text = f.format(value);
  return locale === "fr" ? text.replace(/[\s\u00a0\u202f]/g, NNBSP) : text;
}

/** Ce qui sépare un nombre de son unité : une espace fine en français, une espace en anglais. */
function unitSpace(locale: Locale): string {
  return locale === "fr" ? NNBSP : " ";
}

/** « 43 % », « 43,7 % » ; « 43%», « 43.7% » ; une valeur absente s'écrit « – ». */
export function formatPct(
  value: number | null | undefined,
  locale: Locale,
  digits = 0,
): string {
  if (value == null) return "–";
  return locale === "en"
    ? `${number(value, digits, locale)}%`
    : `${number(value, digits, locale)}${NNBSP}%`;
}

/** « 35 °C ». */
export function formatTemp(
  value: number | null | undefined,
  locale: Locale,
): string {
  return value == null
    ? "–"
    : `${number(value, 0, locale)}${unitSpace(locale)}°C`;
}

const RATE_UNITS: Record<Locale, string[]> = {
  fr: ["o/s", "Ko/s", "Mo/s", "Go/s"],
  en: ["B/s", "KB/s", "MB/s", "GB/s"],
};

/** Débit en unités binaires : « 2 Ko/s », « 1,8 Mo/s » ; « 1.8 MB/s ». */
export function formatRate(
  bps: number | null | undefined,
  locale: Locale,
): string {
  if (bps == null) return "–";
  let value = bps;
  let unit = 0;
  const units = RATE_UNITS[locale];
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${number(value, value >= 10 ? 0 : 1, locale)}${unitSpace(locale)}${units[unit]}`;
}

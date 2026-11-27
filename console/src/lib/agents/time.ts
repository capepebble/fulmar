// Heures de l'agent : heure locale du NAS, ISO sans fuseau (« 2026-11-09T10:35:00 »).
// La couche de traduction les ramène à des instants UTC ; l'affichage se fait dans le fuseau
// de la console (`NAS_CONSOLE_TZ`, Europe/Paris par défaut). Seules les programmations et les
// jours de la bande des sauvegardes restent à l'heure du NAS.

import { INTL_TAG, type Locale } from "@/i18n/locales";
import { ago, number } from "@/lib/format";

const DAYS: Record<Locale, string[]> = {
  fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
};
const DAYS_SHORT: Record<Locale, string[]> = {
  fr: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const MONTHS: Record<Locale, string[]> = {
  fr: [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};
const MONTHS_SHORT: Record<Locale, string[]> = {
  fr: [
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
  ],
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
};

const DEFAULT_TZ = "Europe/Paris";

/** Lit une heure murale ; un décalage éventuel (« +01:00 », « Z ») est ignoré. */
export function wall(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

/** Fuseau d'affichage : `NAS_CONSOLE_TZ` s'il est reconnu, sinon Europe/Paris. */
export function consoleTimeZone(
  env: Record<string, string | undefined> = process.env,
): string {
  const tz = env.NAS_CONSOLE_TZ?.trim();
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat(INTL_TAG.fr, { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Heure locale du NAS (décalage en minutes) vers un instant ISO UTC ; une heure déjà située
 * (« Z », « +01:00 ») garde son instant. */
export function instantFromNasLocal(
  local: string | null | undefined,
  offsetMin: number,
): string | null {
  if (!local) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(local)) {
    const t = new Date(local);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  }
  const w = wall(local);
  if (!w) return null;
  return new Date(w.getTime() - offsetMin * 60_000).toISOString();
}

/** « 2026-11-21 05:59:48.377Z » (Beszel, PocketBase) vers « 2026-11-21T05:59:48.377Z ». */
export function instantFromBeszel(s: string): string {
  return new Date(s.replace(" ", "T")).toISOString();
}

/** Jour du calendrier du NAS pour un instant : « 2026-11-21 ». */
export function nasLocalDay(at: string, offsetMin: number): string {
  return new Date(new Date(at).getTime() + offsetMin * 60_000)
    .toISOString()
    .slice(0, 10);
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number };

const partsFormats = new Map<string, Intl.DateTimeFormat>();

/** Date et heure murales d'un instant dans un fuseau. */
function partsIn(at: Date, tz: string): Parts {
  let f = partsFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    partsFormats.set(tz, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(at).map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
  };
}

function instant(at: string | null | undefined): Date | null {
  if (!at) return null;
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Décalage d'un fuseau sur UTC, en minutes, à un instant donné (heure d'été comprise). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const p = partsIn(at, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  return Math.round(
    (asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000,
  );
}

/** Jours entre la date de `at` et celle de `now`, dans le fuseau. */
function daysBefore(at: Date, now: Date, tz: string): number {
  const a = partsIn(at, tz);
  const n = partsIn(now, tz);
  return Math.round(
    (Date.UTC(n.y, n.mo - 1, n.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86_400_000,
  );
}

function weekday(p: Parts): number {
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

/** « 6:59 », dans le fuseau ; « 6:59 AM » en anglais. */
export function formatClock(
  at: string | null | undefined,
  tz: string,
  locale: Locale,
): string {
  const t = instant(at);
  if (!t) return "–";
  const p = partsIn(t, tz);
  const mm = String(p.mi).padStart(2, "0");
  if (locale === "en") {
    const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    return `${h12}:${mm} ${p.h < 12 ? "AM" : "PM"}`;
  }
  return `${p.h}:${mm}`;
}

function shortDay(p: Parts, locale: Locale): string {
  const day = DAYS_SHORT[locale][weekday(p)];
  const month = MONTHS_SHORT[locale][p.mo - 1];
  return locale === "en" ? `${day}, ${month} ${p.d}` : `${day} ${p.d} ${month}`;
}

/** « aujourd'hui », « hier », « mer. 18 nov. » ; « today », « Wed, Nov 18 ». */
export function formatDate(
  at: string | null | undefined,
  now: Date,
  tz: string,
  locale: Locale,
): string {
  const t = instant(at);
  if (!t) return "–";
  const diff = daysBefore(t, now, tz);
  const en = locale === "en";
  if (diff === 0) return en ? "today" : "aujourd'hui";
  if (diff === 1) return en ? "yesterday" : "hier";
  if (diff === -1) return en ? "tomorrow" : "demain";
  return shortDay(partsIn(t, tz), locale);
}

/** « aujourd'hui, 6:59 », « mer. 18 nov., 16:57 » ; « today, 6:59 AM ». */
export function formatDateTime(
  at: string | null | undefined,
  now: Date,
  tz: string,
  locale: Locale,
): string {
  const day = formatDate(at, now, tz, locale);
  return day === "–" ? day : `${day}, ${formatClock(at, tz, locale)}`;
}

/** Un jour du calendrier, tel quel (« 2026-11-18 » donne « mer. 18 nov. ») : les jours de la
 * bande des sauvegardes sont ceux du NAS. */
export function formatDay(day: string, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "–";
  return shortDay({ y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0 }, locale);
}

/** Titre d'un jour dans un journal : « Aujourd'hui », « Vendredi 6 novembre » ; « Friday,
 * November 6 ». */
export function formatDayTitle(
  at: string | null | undefined,
  now: Date,
  tz: string,
  locale: Locale,
): string {
  const t = instant(at);
  const en = locale === "en";
  if (!t) return en ? "Unknown date" : "Date inconnue";
  const diff = daysBefore(t, now, tz);
  if (diff === 0) return en ? "Today" : "Aujourd'hui";
  if (diff === 1) return en ? "Yesterday" : "Hier";
  const p = partsIn(t, tz);
  const day = DAYS[locale][weekday(p)];
  const month = MONTHS[locale][p.mo - 1];
  return en
    ? `${day}, ${month} ${p.d}`
    : `${day.charAt(0).toUpperCase()}${day.slice(1)} ${p.d} ${month}`;
}

/** « il y a 12 s », « il y a 3 min », « il y a 2 h », puis la date et l'heure. */
export function formatAgo(
  at: string | null | undefined,
  now: Date,
  tz: string,
  locale: Locale,
): string {
  const t = instant(at);
  if (!t) return "–";
  const s = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
  const en = locale === "en";
  if (s < 1) return en ? "just now" : "à l'instant";
  if (s < 60) return en ? `${s} s ago` : `il y a ${s} s`;
  if (s < 3600)
    return en
      ? `${Math.floor(s / 60)} min ago`
      : `il y a ${Math.floor(s / 60)} min`;
  if (s < 86_400)
    return en
      ? `${Math.floor(s / 3600)} h ago`
      : `il y a ${Math.floor(s / 3600)} h`;
  return formatDateTime(at, now, tz, locale);
}

/** Durée écoulée depuis un instant : « il y a 72 h 21 ». */
export function since(
  at: string | null | undefined,
  now: Date,
  locale: Locale,
): string {
  const t = instant(at);
  if (!t) return "–";
  return ago(
    Math.max(0, Math.floor((now.getTime() - t.getTime()) / 60_000)),
    locale,
  );
}

/** « 30 nov. 2026 », « Nov 30, 2026 » : une échéance au jour près, telle que l'agent la donne. */
export function date(iso: string | null | undefined, locale: Locale): string {
  const t = wall(iso);
  if (!t) return "–";
  const month = MONTHS_SHORT[locale][t.getUTCMonth()];
  return locale === "en"
    ? `${month} ${t.getUTCDate()}, ${t.getUTCFullYear()}`
    : `${t.getUTCDate()} ${month} ${t.getUTCFullYear()}`;
}

/** Entier dans la langue : « 46 860 » (espace fine), « 46,860 ». */
export function formatInt(n: number, locale: Locale): string {
  return number(n, 0, locale);
}

/** « 2 j 21 h », « 41 j », « 5 h 12 » ; « 2 d 21 h ». */
export function uptime(
  seconds: number | null | undefined,
  locale: Locale,
): string {
  if (seconds == null) return locale === "en" ? "unknown" : "inconnue";
  const d = locale === "en" ? "d" : "j";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days >= 10) return `${days} ${d}`;
  if (days > 0) return `${days} ${d} ${hours} h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return locale === "en"
    ? `${hours} h ${minutes} min`
    : `${hours} h ${String(minutes).padStart(2, "0")}`;
}

const SIZE_UNITS: Record<Locale, string[]> = {
  fr: ["o", "Ko", "Mo", "Go", "To", "Po"],
  en: ["B", "KB", "MB", "GB", "TB", "PB"],
};

/** Taille en unités binaires, comme DSM : « 10,5 To », « 102 Mo » ; « 10.5 TB ». */
export function bytes(n: number | null | undefined, locale: Locale): string {
  if (n == null) return "–";
  let value = n;
  let unit = 0;
  const units = SIZE_UNITS[locale];
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value >= 100 ? Math.round(value) : value;
  return `${number(shown, 1, locale)} ${units[unit]}`;
}

/** Les jours de la semaine, dimanche d'abord, en minuscules en français. */
export function weekdayNames(locale: Locale): string[] {
  return DAYS[locale];
}

// Mise en mots du parc : depuis quand, dernière sauvegarde, teinte d'un volume, libellés des
// points. Tout s'écrit dans le fuseau de la console.

import { type Locale, type Texts, tr } from "@/i18n";
import { INTL_TAG } from "@/i18n/locales";
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatInt,
} from "@/lib/agents/time";
import type { Point } from "@/lib/fleet/series";
import type { Issue, IssueLevel } from "./issues";
import type { Nas, Status, Volume } from "./types";

const ISSUE_LEVEL_TEXT: Record<IssueLevel, Texts> = {
  offline: { en: "Offline", fr: "Hors ligne" },
  denied: { en: "Access denied", fr: "Accès refusé" },
  agent_down: { en: "Agent unreachable", fr: "Agent injoignable" },
  failed: { en: "Failed", fr: "En échec" },
  warning: { en: "Warning", fr: "À surveiller" },
};

export function issueLevelLabel(level: IssueLevel, lang: Locale): string {
  return ISSUE_LEVEL_TEXT[level][lang];
}

export const ISSUE_LEVEL_TONE: Record<IssueLevel, "crit" | "warn"> = {
  offline: "crit",
  denied: "warn",
  agent_down: "warn",
  failed: "crit",
  warning: "warn",
};

const shortDays = new Map<string, Intl.DateTimeFormat>();

/** « 8 nov. », « Nov 8 », dans le fuseau. */
function dayMonth(at: string, tz: string, lang: Locale): string {
  const key = `${lang}|${tz}`;
  let f = shortDays.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[lang], {
      timeZone: tz,
      day: "numeric",
      month: "short",
    });
    shortDays.set(key, f);
  }
  return f.format(new Date(at));
}

/** Aujourd'hui, hier ou un autre jour, quelle que soit la langue. */
function dayOf(
  at: string,
  now: Date,
  tz: string,
): "today" | "yesterday" | "other" {
  const day = formatDate(at, now, tz, "en");
  return day === "today" || day === "yesterday" ? day : "other";
}

/** « depuis 11:34 », « depuis hier », « depuis le 8 nov. » ; « since 11:34 AM », « seen Nov 9 ». */
export function formatSince(
  since: Issue["since"],
  now: Date,
  tz: string,
  lang: Locale,
): string {
  if (!since) return "";
  const day = dayOf(since.at, now, tz);
  const seen = since.label === "vu le";
  if (day === "today") {
    const clock = formatClock(since.at, tz, lang);
    return seen
      ? tr(lang, { en: `seen at ${clock}`, fr: `vu à ${clock}` })
      : tr(lang, { en: `since ${clock}`, fr: `depuis ${clock}` });
  }
  if (day === "yesterday")
    return seen
      ? tr(lang, { en: "seen yesterday", fr: "vu hier" })
      : tr(lang, { en: "since yesterday", fr: "depuis hier" });
  const date = dayMonth(since.at, tz, lang);
  return seen
    ? tr(lang, { en: `seen ${date}`, fr: `vu le ${date}` })
    : tr(lang, { en: `since ${date}`, fr: `depuis le ${date}` });
}

/** Pourquoi un NAS n'a pas de courbes, en clair ; `failure`, la raison d'une lecture ratée. */
export function noCurvesReason(
  nas: Nas,
  now: Date,
  tz: string,
  lang: Locale,
  failure: Texts | null = null,
): string {
  if (nas.agentHistory)
    return (
      failure?.[lang] ??
      tr(lang, {
        en: "no reading from the agent over the period",
        fr: "aucun relevé de l'agent sur la période",
      })
    );
  switch (nas.beszel.kind) {
    case "none":
      return nas.agent.kind === "ok"
        ? tr(lang, {
            en: "this NAS’s agent keeps no history yet, and Beszel is not connected for this NAS",
            fr: "l'agent de ce NAS ne tient pas encore d'historique et Beszel n'est pas branché pour ce NAS",
          })
        : tr(lang, {
            en: "Beszel is not connected for this NAS",
            fr: "Beszel n'est pas branché pour ce NAS",
          });
    case "missing":
      return tr(lang, {
        en: "system not found in Beszel (System tab)",
        fr: "système introuvable dans Beszel (onglet Système)",
      });
    case "down": {
      const at = nas.beszel.lastAt;
      if (!at) return nas.beszel.reason;
      const when =
        dayOf(at, now, tz) === "today"
          ? formatClock(at, tz, lang)
          : formatDate(at, now, tz, lang);
      return tr(lang, {
        en: `Beszel no longer sees this NAS since ${when}`,
        fr: `Beszel ne voit plus ce NAS depuis ${when}`,
      });
    }
    case "ok":
      return (
        failure?.[lang] ??
        tr(lang, {
          en: "no reading over the period",
          fr: "aucun relevé sur la période",
        })
      );
  }
}

/** Ce que la bande d'une sauvegarde dit de son journal quand il ne couvre aucun jour ; `null`
 * quand il en couvre. */
export function backupLogNote(nas: Nas, lang: Locale): string | null {
  if (nas.backupLogFrom) return null;
  return nas.backupLogRead
    ? tr(lang, {
        en: "Hyper Backup log empty: days unknown.",
        fr: "Journal de Hyper Backup vide : jours inconnus.",
      })
    : tr(lang, {
        en: "Hyper Backup log not read: days unknown.",
        fr: "Journal de Hyper Backup non lu : jours inconnus.",
      });
}

/** Le chiffre « NAS en ligne » : sa ligne et le mot de son état, au singulier ou au pluriel. */
export function onlineSummary(
  offline: Issue[],
  total: number,
  now: Date,
  tz: string,
  lang: Locale,
): { sub: string; stateLabel: string } {
  if (offline.length === 0)
    return {
      sub:
        total === 1
          ? tr(lang, { en: "It answers", fr: "Il répond" })
          : tr(lang, { en: "All answer", fr: "Tous répondent" }),
      stateLabel: tr(lang, { en: "All online", fr: "Tous en ligne" }),
    };
  if (offline.length === 1)
    return {
      sub: [
        tr(lang, {
          en: `${offline[0].nas.name} no longer answers`,
          fr: `${offline[0].nas.name} ne répond plus`,
        }),
        formatSince(offline[0].since, now, tz, lang),
      ]
        .filter(Boolean)
        .join(" "),
      stateLabel: tr(lang, {
        en: "A NAS no longer answers",
        fr: "Un NAS ne répond plus",
      }),
    };
  const many = tr(lang, {
    en: `${offline.length} NAS no longer answer`,
    fr: `${offline.length} NAS ne répondent plus`,
  });
  return { sub: many, stateLabel: many };
}

/** Le point du contrôle de remplissage gagne la date de remplissage de son NAS, quand elle se
 * calcule (conception, § 6) : la console n'en fait pas un point à part. */
export function withFillDates(
  issues: Issue[],
  dates: Map<string, string>,
  now: Date,
  tz: string,
  lang: Locale,
): Issue[] {
  return issues.map((issue) => {
    const at = dates.get(issue.nas.id);
    if (issue.checkId !== "storage.volume_usage" || !at) return issue;
    const when = formatMonthDay(at, now, tz, lang);
    const todo = `${issue.todo} ${tr(lang, {
      en: `At the pace of the last 30 days, full around ${when}.`,
      fr: `Au rythme des 30 derniers jours, plein vers le ${when}.`,
    })}`;
    return { ...issue, todo: todo.trim() };
  });
}

/** « 28 décembre », « December 28 », avec l'année quand ce n'est pas celle de `now`. */
export function formatMonthDay(
  at: string,
  now: Date,
  tz: string,
  lang: Locale,
): string {
  const year = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(
      d,
    );
  const sameYear = year(new Date(at)) === year(now);
  return new Intl.DateTimeFormat(INTL_TAG[lang], {
    timeZone: tz,
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(at));
}

/** La tâche lancée le plus récemment, son résultat et sa date. */
export function lastBackup(
  nas: Nas,
  now: Date,
  tz: string,
  lang: Locale,
): { status: Status; text: string; task: string | null } {
  if (nas.agent.kind === "none")
    return {
      status: "unknown",
      text: tr(lang, { en: "No agent", fr: "Sans agent" }),
      task: null,
    };
  if (nas.agent.kind !== "ok")
    return { status: "unknown", text: "–", task: null };
  if (nas.tasks.length === 0)
    return {
      status: "unknown",
      text: tr(lang, { en: "No task", fr: "Aucune tâche" }),
      task: null,
    };
  const latest = [...nas.tasks]
    .filter((t) => t.lastRunAt)
    .sort((a, b) =>
      (b.lastRunAt as string).localeCompare(a.lastRunAt as string),
    )[0];
  if (!latest)
    return {
      status: "unknown",
      text: tr(lang, { en: "Never run", fr: "Jamais lancée" }),
      task: null,
    };
  return {
    status: latest.result.status,
    text: formatDateTime(latest.lastRunAt, now, tz, lang),
    task: latest.name,
  };
}

/** Teinte d'un volume : celle du contrôle de remplissage de l'agent quand il le nomme. */
export function volumeTone(nas: Nas, volume: Volume): "ok" | "warn" | "crit" {
  const check = nas.checks.find((c) => c.id === "storage.volume_usage");
  // L'agent écrit « /volume1 : 91 % » en français, « /volume1: 91 % » en anglais.
  const named = check?.items.some(
    (i) => i.startsWith(`${volume.path} :`) || i.startsWith(`${volume.path}:`),
  );
  if (!check || !named) return "ok";
  return check.status === "failed"
    ? "crit"
    : check.status === "warning"
      ? "warn"
      : "ok";
}

/** Moyenne, pic et heure du pic d'une courbe (« 4:00 » le jour même, sinon « hier, 22:00 »).
 * Le pic est le plus haut relevé quand la source le donne (`max`), sinon la plus haute
 * moyenne. */
export function seriesSummary(
  points: Point[],
  now: Date,
  tz: string,
  lang: Locale,
): { avg: number; max: number; maxAt: string } | null {
  const known = points
    .filter(
      (p): p is Point & { v: number } => p.v != null && Number.isFinite(p.v),
    )
    .map((p) => ({
      t: p.t,
      v: p.v,
      top: p.max != null && Number.isFinite(p.max) ? p.max : p.v,
    }));
  if (!known.length) return null;
  const peak = known.reduce((a, b) => (b.top > a.top ? b : a));
  return {
    avg: known.reduce((sum, p) => sum + p.v, 0) / known.length,
    max: peak.top,
    maxAt:
      dayOf(peak.t, now, tz) === "today"
        ? formatClock(peak.t, tz, lang)
        : formatDateTime(peak.t, now, tz, lang),
  };
}

/** « /volume1 » devient « Volume 1 » ; les autres chemins restent tels quels. */
export function volumeName(path: string): string {
  const m = /^\/volume(\d+)$/.exec(path);
  return m ? `Volume ${m[1]}` : path;
}

/** « 46 860 h de marche (5 ans 4 mois) », « 46,860 power-on hours (5 years 4 months) ». */
export function formatPowerOn(
  hours: number | null | undefined,
  lang: Locale,
): string {
  if (hours == null) return "";
  const days = Math.floor(hours / 24);
  const years = Math.floor(days / 365.25);
  const months = Math.floor((days - years * 365.25) / 30.44);
  const age = tr(lang, {
    en:
      years > 0
        ? `${years} ${years === 1 ? "year" : "years"}${months ? ` ${months} ${months === 1 ? "month" : "months"}` : ""}`
        : months > 0
          ? `${months} ${months === 1 ? "month" : "months"}`
          : `${days} ${days === 1 ? "day" : "days"}`,
    fr:
      years > 0
        ? `${years} ${years > 1 ? "ans" : "an"}${months ? ` ${months} mois` : ""}`
        : months > 0
          ? `${months} mois`
          : `${days} ${days > 1 ? "jours" : "jour"}`,
  });
  const n = formatInt(hours, lang);
  return tr(lang, {
    en: `${n} power-on hours (${age})`,
    fr: `${n} h de marche (${age})`,
  });
}

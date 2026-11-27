// Bande des 30 jours d'une sauvegarde (conception, § 7.5) : une case par jour du NAS, le pire
// résultat du jour. Une journée où la tâche a des lignes sans résultat compris (DSM dans une
// autre langue, tâche en cours) est « inconnue », jamais « aucune exécution ».

import { nasLocalDay } from "@/lib/agents/time";
import type { BackupLogEntry, BackupOutcome } from "./types";

export type StripKind =
  | "success"
  | "failure"
  | "partial"
  | "unknown"
  | "none"
  | "before";

export interface StripCell {
  day: string;
  kind: StripKind;
}

const WORST: BackupOutcome[] = ["failure", "partial", "success"];
const DAYS = 30;

function shiftDay(day: string, delta: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 30 cases, de la plus ancienne à `today` (jour du NAS, « 2026-11-21 »). `logFrom` : la plus
 * ancienne entrée lue ; `null` si le journal n'a pas été lu. */
export function backupStrip(
  log: BackupLogEntry[],
  task: string,
  offsetMin: number,
  today: string,
  logFrom: string | null,
): StripCell[] {
  const byDay = new Map<string, (BackupOutcome | null)[]>();
  for (const entry of log) {
    if (entry.task !== task) continue;
    const day = nasLocalDay(entry.at, offsetMin);
    const list = byDay.get(day) ?? [];
    list.push(entry.outcome);
    byDay.set(day, list);
  }
  const firstDay = logFrom ? nasLocalDay(logFrom, offsetMin) : null;
  return Array.from({ length: DAYS }, (_, i) => {
    const day = shiftDay(today, i - (DAYS - 1));
    if (!logFrom) return { day, kind: "unknown" as const };
    const outcomes = byDay.get(day);
    if (outcomes) {
      const worst = WORST.find((o) => outcomes.includes(o));
      return { day, kind: worst ?? ("unknown" as const) };
    }
    return {
      day,
      kind:
        firstDay && day < firstDay ? ("before" as const) : ("none" as const),
    };
  });
}

/** Du pire au meilleur, pour fondre les bandes de plusieurs tâches. */
const MERGE_ORDER: StripKind[] = [
  "failure",
  "partial",
  "unknown",
  "success",
  "none",
  "before",
];

/** La bande de toutes les tâches d'un NAS : le pire résultat de chaque jour (fiche en bref). */
export function mergeStrips(strips: StripCell[][]): StripCell[] {
  if (!strips.length) return [];
  return strips[0].map((cell, i) => ({
    day: cell.day,
    kind:
      MERGE_ORDER.find((k) => strips.some((s) => s[i]?.kind === k)) ??
      cell.kind,
  }));
}

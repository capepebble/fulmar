// Traduction des réponses de Beszel : courbes, constantes du moment, disques, remplissage d'un
// volume. Une valeur absente reste absente (`null`), jamais 0.

import { instantFromBeszel } from "@/lib/agents/time";
import {
  type Metric,
  type Period,
  type Point,
  withGaps,
} from "@/lib/fleet/series";
import type { BzSmart, BzStats, BzStatsRecord, BzSystem, Tier } from "./types";

export type { Tier };

export interface BeszelVitals {
  cpu: number | null;
  ram: number | null;
  temp: number | null;
  netBps: number | null;
  uptimeS: number | null;
  /** Instant du dernier relevé du système. */
  at: string | null;
}

export interface BeszelDisk {
  device: string;
  model: string | null;
  state: string | null;
  temp: number | null;
  hours: number | null;
  capacityBytes: number | null;
}

const GIB = 1024 ** 3;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Température du processeur : le plus chaud des capteurs coretemp, k10temp ou cpu. */
export function cpuTemp(t?: Record<string, number>): number | null {
  if (!t) return null;
  const values = Object.entries(t)
    .filter(([k]) => /^(coretemp|k10temp|cpu)/i.test(k))
    .map(([, v]) => num(v))
    .filter((v): v is number => v != null);
  return values.length ? Math.max(...values) : null;
}

/** Débit du réseau, envoyé plus reçu, en octets par seconde. */
export function netBps(s: BzStats): number | null {
  if (!Array.isArray(s.b) || s.b.length === 0) return null;
  const values = s.b.map(num);
  if (values.some((v) => v == null)) return null;
  return (values as number[]).reduce((a, b) => a + b, 0);
}

function metricOf(s: BzStats, metric: Metric): number | null {
  switch (metric) {
    case "cpu":
      return num(s.cpu);
    case "mem":
      return num(s.mp);
    case "temp":
      return cpuTemp(s.t);
    case "net":
      return netBps(s);
  }
}

function byTime(records: BzStatsRecord[]) {
  return records
    .map((r) => ({ t: instantFromBeszel(r.created), stats: r.stats ?? {} }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

/** Courbe d'une mesure ; un trou de plus de deux pas du palier coupe le trait (`null`). */
export function series(
  records: BzStatsRecord[],
  metric: Metric,
  period: Period,
): Point[] {
  return withGaps(
    byTime(records).map((r) => ({ t: r.t, v: metricOf(r.stats, metric) })),
    period,
  );
}

/** Constantes du moment : le dernier relevé, sinon le résumé du système. */
export function latestVitals(
  system: BzSystem,
  last: BzStats | null,
): BeszelVitals {
  const info = system.info ?? {};
  return {
    cpu: num(last?.cpu) ?? num(info.cpu),
    ram: num(last?.mp) ?? num(info.mp),
    temp: (last ? cpuTemp(last.t) : null) ?? num(info.dt),
    netBps: (last ? netBps(last) : null) ?? num(info.bb),
    uptimeS: num(info.u),
    at: system.updated ? instantFromBeszel(system.updated) : null,
  };
}

/** Disques vus par S.M.A.R.T. ; les grappes md de DSM (fausses alertes) sont ignorées. */
export function beszelDisks(smart: BzSmart[]): BeszelDisk[] {
  return smart
    .filter((d) => d.type !== "mdraid" && !/^(\/dev\/)?md\d+$/.test(d.name))
    .map((d) => ({
      device: d.name.replace(/^\/dev\//, ""),
      model: d.model || null,
      state: d.state || null,
      // 0 °C n'existe pas dans un NAS : c'est une température non lue.
      temp: num(d.temp) && (d.temp as number) > 0 ? (d.temp as number) : null,
      hours: num(d.hours),
      capacityBytes: num(d.capacity),
    }));
}

/** Occupation d'un volume dans le temps : le disque principal de Beszel s'il a la taille du
 * volume (à 2 % près), sinon le système de fichiers qui porte son nom. */
export function volumeFill(
  records: BzStatsRecord[],
  volume: { name: string; totalBytes: number },
): { t: string; usedBytes: number }[] {
  const name = volume.name.split("/").filter(Boolean).pop()?.toLowerCase();
  const sameSize = (d: number | undefined) =>
    d != null &&
    volume.totalBytes > 0 &&
    Math.abs(d * GIB - volume.totalBytes) / volume.totalBytes <= 0.02;
  const out: { t: string; usedBytes: number }[] = [];
  for (const r of byTime(records)) {
    let used: number | null = null;
    if (sameSize(r.stats.d)) used = num(r.stats.du);
    else if (name) {
      const fs = Object.entries(r.stats.efs ?? {}).find(([k]) =>
        k.toLowerCase().includes(name),
      )?.[1];
      if (fs) used = num(fs.du);
    }
    if (used != null) out.push({ t: r.t, usedBytes: Math.round(used * GIB) });
  }
  return out;
}

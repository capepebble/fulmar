// Traduction de l'historique d'un agent (`metrics.history`) : courbes, valeur du moment,
// remplissage d'un volume. Une valeur absente reste absente, un trou reste un trou.

import {
  type NasCurves,
  type Period,
  type Point,
  withGaps,
} from "@/lib/fleet/series";
import type { HistoryMetric, MetricsHistory } from "./types";

/** Au-delà, le dernier relevé n'est plus la valeur du moment (le relevé est arrêté). */
export const FRESH_MS = 5 * 60_000;

type Series = NonNullable<MetricsHistory["series"]>[number];

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function instant(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function find(
  h: MetricsHistory,
  metric: HistoryMetric | string,
  subject: string | null = null,
): Series | undefined {
  return h.series?.find(
    (s) => s.metric === metric && (s.subject ?? null) === subject,
  );
}

function points(s: Series | undefined): Point[] {
  const out: Point[] = [];
  for (const p of s?.points ?? []) {
    const t = instant(p.t);
    if (t && finite(p.avg))
      out.push({ t, v: p.avg, max: finite(p.max) ? p.max : null });
  }
  return out;
}

/** Réseau : reçu plus envoyé, aux seuls instants où les deux sont connus. Le pic d'une somme
 * ne se déduit pas des pics de ses termes : le point n'en porte pas. */
function network(h: MetricsHistory): Point[] {
  const tx = new Map(points(find(h, "network_tx_bps")).map((p) => [p.t, p.v]));
  return points(find(h, "network_rx_bps")).flatMap((p) => {
    const sent = tx.get(p.t);
    return finite(sent) && finite(p.v) ? [{ t: p.t, v: p.v + sent }] : [];
  });
}

/** Courbes d'un NAS tirées de l'historique de son agent. */
export function historyCurves(h: MetricsHistory, period: Period): NasCurves {
  return {
    cpu: withGaps(points(find(h, "cpu_pct")), period),
    mem: withGaps(points(find(h, "memory_pct")), period),
    temp: withGaps(points(find(h, "temperature_c")), period),
    net: withGaps(network(h), period),
  };
}

export interface HistoryVitals {
  cpu: number | null;
  ram: number | null;
  temp: number | null;
  netBps: number | null;
}

/** Valeur du moment : le dernier relevé d'une minute de chaque série, s'il est récent ;
 * `null` si aucun ne l'est. */
export function historyVitals(
  h: MetricsHistory,
  now: Date,
): HistoryVitals | null {
  const fresh = (metric: HistoryMetric): number | null => {
    const latest = find(h, metric)?.latest;
    const t = instant(latest?.t);
    if (!latest || !t || !finite(latest.value)) return null;
    const age = now.getTime() - Date.parse(t);
    return age <= FRESH_MS && age >= -FRESH_MS ? latest.value : null;
  };
  const rx = fresh("network_rx_bps");
  const tx = fresh("network_tx_bps");
  const vitals = {
    cpu: fresh("cpu_pct"),
    ram: fresh("memory_pct"),
    temp: fresh("temperature_c"),
    netBps: rx != null && tx != null ? rx + tx : null,
  };
  return Object.values(vitals).some((v) => v != null) ? vitals : null;
}

/** Remplissage d'un volume dans le temps, par son identifiant DSM (`volume_1`). */
export function historyFill(
  h: MetricsHistory,
  volumeId: string,
): { t: string; usedBytes: number }[] {
  return points(find(h, "volume_used_bytes", volumeId)).flatMap((p) =>
    p.v != null ? [{ t: p.t, usedBytes: p.v }] : [],
  );
}

/** L'agent tient un historique : il a répondu, relevé actif. */
export function keepsHistory(h: MetricsHistory | null): boolean {
  return h != null && h.sampling?.enabled !== false;
}

/** Une carte de constante en détail : charge, swap, une interface réseau, un disque. */
export interface DetailSeries {
  kind: "load" | "swap" | "interface" | "disk";
  /** Interface (« eth0 ») ou disque (« sata1 ») ; `null` pour le NAS entier. */
  subject: string | null;
  /** Dernière valeur relevée ; débits en octets par seconde, charge sans unité, swap en %. */
  value: number | null;
  points: Point[];
  /** Charge : les moyennes sur 5 et 15 minutes du dernier relevé. */
  extra?: { load5: number | null; load15: number | null };
}

/** Somme de deux séries aux seuls instants où les deux sont connues. */
function sum(a: Point[], b: Point[]): Point[] {
  const other = new Map(b.map((p) => [p.t, p.v]));
  return a.flatMap((p) => {
    const v = other.get(p.t);
    return finite(v) && finite(p.v) ? [{ t: p.t, v: p.v + v }] : [];
  });
}

function last(points: Point[]): number | null {
  const v = points[points.length - 1]?.v;
  return finite(v) ? v : null;
}

/** Les constantes en détail (parité Beszel, 2026-11-26) : charge, swap, réseau par interface,
 * lectures et écritures de chaque disque. Une interface qui n'a jamais rien fait reste cachée. */
export function historyDetail(
  h: MetricsHistory,
  period: Period,
): DetailSeries[] {
  const out: DetailSeries[] = [];
  const load = points(find(h, "load_1m"));
  if (load.length)
    out.push({
      kind: "load",
      subject: null,
      value: last(load),
      points: withGaps(load, period),
      extra: {
        load5: last(points(find(h, "load_5m"))),
        load15: last(points(find(h, "load_15m"))),
      },
    });
  const swap = points(find(h, "swap_pct"));
  if (swap.length)
    out.push({
      kind: "swap",
      subject: null,
      value: last(swap),
      points: withGaps(swap, period),
    });
  const subjects = (metric: HistoryMetric | string) =>
    [
      ...new Set(
        (h.series ?? [])
          .filter((s) => s.metric === metric && s.subject)
          .map((s) => s.subject as string),
      ),
    ].sort();
  for (const iface of subjects("network_rx_bps")) {
    const both = sum(
      points(find(h, "network_rx_bps", iface)),
      points(find(h, "network_tx_bps", iface)),
    );
    if (!both.some((p) => (p.v ?? 0) > 0)) continue;
    out.push({
      kind: "interface",
      subject: iface,
      value: last(both),
      points: withGaps(both, period),
    });
  }
  for (const disk of subjects("disk_read_bps")) {
    const both = sum(
      points(find(h, "disk_read_bps", disk)),
      points(find(h, "disk_write_bps", disk)),
    );
    if (!both.length) continue;
    out.push({
      kind: "disk",
      subject: disk,
      value: last(both),
      points: withGaps(both, period),
    });
  }
  return out;
}

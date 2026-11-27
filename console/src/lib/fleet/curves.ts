import "server-only";

// Courbes et date de remplissage. Une seule source par NAS (conception du 2026-11-23) :
// l'historique de son agent quand il le tient ; sinon Beszel, s'il voit le NAS ; sinon aucune.
// Les NAS fictifs ont des séries synthétiques. Une source en panne n'empêche pas la page de
// s'afficher : les courbes manquent et la raison est rendue.

import type { Texts } from "@/i18n";
import { agentHistory, type HistoryReader } from "@/lib/agents/history";
import {
  type DetailSeries,
  historyCurves,
  historyDetail,
  historyFill,
} from "@/lib/agents/history-map";
import { type BeszelClient, beszel } from "@/lib/beszel/client";
import {
  type BeszelDisk,
  beszelDisks,
  series,
  volumeFill,
} from "@/lib/beszel/map";
import type {
  BzContainerRecord,
  BzDetails,
  BzStatsRecord,
} from "@/lib/beszel/types";
import { demoFill, demoSeries } from "./demo";
import { type FillForecast, fillForecast } from "./forecast";
import {
  METRICS,
  type NasCurves,
  PERIODS,
  type Period,
  type Point,
} from "./series";
import type { Nas, Volume } from "./types";

export type { NasCurves };

const MONTH_MS = 30 * 86_400_000;

/** Le système Beszel d'un NAS, s'il en a un que le compte de la console voit. */
export function systemIdOf(nas: Nas): string | null {
  if (nas.beszel.kind === "ok") return nas.beszel.systemId;
  // Un NAS que Beszel ne voit plus garde son historique ; un hub muet, on ne le relance pas.
  if (nas.beszel.kind === "down" && !nas.beszel.hub) return nas.beszel.systemId;
  return null;
}

export type CurveSource = "agent" | "beszel" | "demo" | null;

/** D'où viennent les courbes d'un NAS : une seule source à la fois. */
export function curveSource(nas: Nas): CurveSource {
  if (!nas.live) return "demo";
  if (nas.agentHistory) return "agent";
  if (systemIdOf(nas)) return "beszel";
  return null;
}

function bySystem(records: BzStatsRecord[]): Map<string, BzStatsRecord[]> {
  const out = new Map<string, BzStatsRecord[]>();
  for (const r of records) {
    const list = out.get(r.system) ?? [];
    list.push(r);
    out.set(r.system, list);
  }
  return out;
}

/** Courbes d'un parc, et la raison quand une lecture a échoué (`null` sinon). */
export interface CurvesRead {
  curves: Map<string, NasCurves>;
  failure: Texts | null;
}

export async function fleetCurves(
  fleet: Nas[],
  period: Period,
  now: Date,
  client: BeszelClient | null = beszel(),
  history: HistoryReader = agentHistory(),
): Promise<Map<string, NasCurves>> {
  return (await readCurves(fleet, period, now, client, history)).curves;
}

/** Courbes des NAS dont l'agent tient l'historique : une lecture par agent, en parallèle. */
async function fromAgents(
  fleet: Nas[],
  period: Period,
  history: HistoryReader,
): Promise<CurvesRead> {
  const curves = new Map<string, NasCurves>();
  let failure: Texts | null = null;
  const reads = await Promise.all(
    fleet.map((nas) => history.read(nas.id, period)),
  );
  fleet.forEach((nas, i) => {
    const read = reads[i];
    if (!read) return;
    if (read.ok) curves.set(nas.id, historyCurves(read.data, period));
    else
      failure ??= {
        en: `agent history unreadable (${read.reason.en})`,
        fr: `historique de l'agent illisible (${read.reason.fr})`,
      };
  });
  return { curves, failure };
}

/** Courbes des NAS lus dans Beszel : une seule requête pour tous les systèmes. */
async function fromBeszel(
  fleet: Nas[],
  period: Period,
  now: Date,
  client: BeszelClient | null,
): Promise<CurvesRead> {
  const curves = new Map<string, NasCurves>();
  if (!client || fleet.length === 0) return { curves, failure: null };
  const { tier, ms } = PERIODS[period];
  const read = await client.stats(
    fleet.map((n) => systemIdOf(n) as string),
    tier,
    new Date(now.getTime() - ms),
  );
  if (!read.ok) return { curves, failure: read.reason };
  const grouped = bySystem(read.data);
  for (const nas of fleet) {
    const records = grouped.get(systemIdOf(nas) as string);
    if (!records?.length) continue;
    curves.set(
      nas.id,
      Object.fromEntries(
        METRICS.map((m) => [m, series(records, m, period)]),
      ) as NasCurves,
    );
  }
  return { curves, failure: null };
}

export async function readCurves(
  fleet: Nas[],
  period: Period,
  now: Date,
  client: BeszelClient | null = beszel(),
  history: HistoryReader = agentHistory(),
): Promise<CurvesRead> {
  const curves = new Map<string, NasCurves>();
  for (const nas of fleet.filter((n) => curveSource(n) === "demo")) {
    curves.set(
      nas.id,
      Object.fromEntries(
        METRICS.map((m) => [m, demoSeries(nas, m, period, now)]),
      ) as NasCurves,
    );
  }
  const [agents, bz] = await Promise.all([
    fromAgents(
      fleet.filter((n) => curveSource(n) === "agent"),
      period,
      history,
    ),
    fromBeszel(
      fleet.filter((n) => curveSource(n) === "beszel"),
      period,
      now,
      client,
    ),
  ]);
  for (const part of [agents, bz])
    for (const [id, c] of part.curves) curves.set(id, c);
  return { curves, failure: agents.failure ?? bz.failure };
}

/** Remplissage d'un volume sur 30 jours (en %) et sa date de remplissage, d'après la source
 * des courbes du NAS. */
export async function volumeHistory(
  nas: Nas,
  volume: Volume,
  now: Date,
  client: BeszelClient | null = beszel(),
  history: HistoryReader = agentHistory(),
): Promise<{ points: Point[]; forecast: FillForecast }> {
  const total = volume.totalBytes;
  const none = { points: [], forecast: { kind: "unknown" } as FillForecast };
  if (total == null || !(total > 0)) return none;
  let fill: { t: string; usedBytes: number }[];
  const source = curveSource(nas);
  if (source === "demo") fill = demoFill(nas, volume, now);
  else if (source === "agent") {
    const read = volume.id ? await history.read(nas.id, "30d") : null;
    if (!read?.ok || !volume.id) return none;
    fill = historyFill(read.data, volume.id);
  } else {
    const systemId = systemIdOf(nas);
    if (!client || !systemId) return none;
    const read = await client.stats(
      [systemId],
      "480m",
      new Date(now.getTime() - MONTH_MS),
    );
    if (!read.ok) return none;
    fill = volumeFill(read.data, { name: volume.path, totalBytes: total });
  }
  return {
    points: fill.map((p) => ({
      t: p.t,
      v: Math.round((p.usedBytes / total) * 1000) / 10,
    })),
    forecast: fillForecast(fill, total, now),
  };
}

/** Date de remplissage du volume le plus rempli de chaque NAS dont le contrôle de remplissage
 * n'est pas OK : une lecture par NAS concerné, aucune pour les autres. */
export async function fillDates(
  fleet: Nas[],
  now: Date,
  client: BeszelClient | null = beszel(),
  history: HistoryReader = agentHistory(),
): Promise<Map<string, string>> {
  const concerned = fleet.filter((nas) =>
    nas.checks.some(
      (c) =>
        c.id === "storage.volume_usage" &&
        (c.status === "failed" || c.status === "warning"),
    ),
  );
  const found = await Promise.all(
    concerned.map(async (nas) => {
      const fullest = [...nas.volumes].sort((a, b) => b.pct - a.pct)[0];
      if (!fullest) return null;
      const f = await volumeForecast(nas, fullest, now, client, history);
      return f.kind === "date" ? ([nas.id, f.at] as const) : null;
    }),
  );
  return new Map(found.filter((e) => e !== null));
}

/** Date de remplissage d'un volume, d'après 30 jours de relevés. */
export async function volumeForecast(
  nas: Nas,
  volume: Volume,
  now: Date,
  client: BeszelClient | null = beszel(),
  history: HistoryReader = agentHistory(),
): Promise<FillForecast> {
  return (await volumeHistory(nas, volume, now, client, history)).forecast;
}

export interface NasBeszel {
  /** Disques vus par S.M.A.R.T., sans les grappes md ; `null` si Beszel ne les donne pas. */
  disks: BeszelDisk[] | null;
  details: BzDetails | null;
}

/** Ce que Beszel sait d'un NAS au-delà des courbes : disques et matériel. Les NAS fictifs
 * reprennent leurs disques. Les conteneurs se lisent à part (`nasContainers`). */
export async function nasBeszel(
  nas: Nas,
  client: BeszelClient | null = beszel(),
): Promise<NasBeszel> {
  if (!nas.live)
    return {
      disks: nas.disks.map((d) => ({
        device: d.device ?? `disque ${d.bay}`,
        model: d.model,
        state: d.healthy ? "PASSED" : "FAILED",
        temp: d.temp,
        hours: d.hours,
        capacityBytes: d.sizeBytes,
      })),
      details: null,
    };
  const systemId = nas.beszel.kind === "ok" ? nas.beszel.systemId : null;
  if (!client || !systemId) return { disks: null, details: null };
  const [smart, details] = await Promise.all([
    client.smart(systemId),
    client.details(systemId),
  ]);
  return {
    disks: smart.ok ? beszelDisks(smart.data) : null,
    details: details.ok ? details.data : null,
  };
}

/** Conteneurs vus par Beszel, pour l'onglet Système seulement (conception, § 8). */
export async function nasContainers(
  nas: Nas,
  client: BeszelClient | null = beszel(),
): Promise<BzContainerRecord | null> {
  const systemId = nas.beszel.kind === "ok" ? nas.beszel.systemId : null;
  if (!nas.live || !client || !systemId) return null;
  const read = await client.containers(systemId);
  return read.ok ? read.data : null;
}

/** Les constantes en détail d'un NAS (charge, swap, interfaces, disques) : depuis l'historique
 * de son agent seulement, sur 24 h ; rien pour un NAS fictif ou sans historique. */
export async function vitalsDetail(
  nas: Nas,
  history: HistoryReader = agentHistory(),
): Promise<DetailSeries[]> {
  if (curveSource(nas) !== "agent") return [];
  const read = await history.read(nas.id, "24h");
  return read?.ok ? historyDetail(read.data, "24h") : [];
}

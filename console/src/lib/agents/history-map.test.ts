import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { historyPath } from "./history";
import {
  historyCurves,
  historyDetail,
  historyFill,
  historyVitals,
  keepsHistory,
} from "./history-map";
import { type MetricsHistory, READ_PATHS } from "./types";

// L'agent rejoué sur les réponses DSM enregistrées : deux heures de relevés d'une minute,
// lues au palier de 20 minutes sur 24 h, à l'heure des autres réponses enregistrées.
const FIXTURE: MetricsHistory = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "__fixtures__",
      "essai",
      "metrics_history_tier_20m_hours_24.json",
    ),
    "utf8",
  ),
).data;
const READ_AT = new Date("2026-11-09T15:26:47Z");

function history(
  series: NonNullable<MetricsHistory["series"]>,
): MetricsHistory {
  return { tier: "20m", sampling: { enabled: true }, series };
}

const pt = (t: string, avg: number, max = avg) => ({ t, avg, max, n: 20 });

describe("historique de l'agent", () => {
  test("la lecture de 24 h des courbes est celle qui part avec l'agent", () => {
    expect(historyPath("24h")).toBe(READ_PATHS["metrics.history"]);
    expect(historyPath("1h")).toBe("/metrics/history?tier=1m&hours=1");
    expect(historyPath("30d")).toBe("/metrics/history?tier=480m&hours=720");
  });

  test("courbes de la réponse enregistrée", () => {
    const c = historyCurves(FIXTURE, "24h");
    expect(c.cpu.length).toBe(7);
    expect(c.cpu.every((p) => p.v === 9 && p.max === 9)).toBe(true);
    expect(c.mem[0].v).toBe(24);
    expect(c.temp[0].v).toBe(40);
    // Réseau : reçu plus envoyé, sans pic inventé.
    expect(c.net[0]).toEqual({ t: c.cpu[0].t, v: 109549 + 45097 });
    expect(c.cpu[0].t).toBe("2026-11-09T13:20:00.000Z");
  });

  test("valeur du moment : le dernier relevé, s'il est récent", () => {
    expect(historyVitals(FIXTURE, READ_AT)).toEqual({
      cpu: 9,
      ram: 24,
      temp: 40,
      netBps: 154646,
    });
    const late = new Date(READ_AT.getTime() + 10 * 60_000);
    expect(historyVitals(FIXTURE, late)).toBeNull();
  });

  test("un trou de plus de deux pas coupe le trait", () => {
    const h = history([
      {
        metric: "cpu_pct",
        points: [
          pt("2026-11-21T08:00:00Z", 5),
          pt("2026-11-21T08:20:00Z", 6),
          pt("2026-11-21T10:00:00Z", 7),
        ],
      },
    ]);
    expect(historyCurves(h, "24h").cpu.map((p) => p.v)).toEqual([
      5,
      6,
      null,
      7,
    ]);
  });

  test("le pic vient du maximum de chaque point", () => {
    const h = history([
      { metric: "cpu_pct", points: [pt("2026-11-21T08:00:00Z", 5, 80)] },
    ]);
    expect(historyCurves(h, "24h").cpu[0]).toMatchObject({ v: 5, max: 80 });
  });

  test("une série absente ou mal formée reste vide", () => {
    const h = history([
      {
        metric: "memory_pct",
        points: [
          { t: "pas une date", avg: 3, max: 3, n: 1 },
          { t: "2026-11-21T08:00:00Z", avg: Number.NaN, max: 1, n: 1 },
        ],
      },
      { metric: "network_rx_bps", points: [pt("2026-11-21T08:00:00Z", 1)] },
    ]);
    const c = historyCurves(h, "24h");
    expect(c.cpu).toEqual([]);
    expect(c.mem).toEqual([]);
    expect(c.net).toEqual([]);
  });

  test("remplissage d'un volume, par son identifiant", () => {
    expect(historyFill(FIXTURE, "volume_1")[0].usedBytes).toBe(26724878606336);
    expect(historyFill(FIXTURE, "volume_9")).toEqual([]);
  });

  test("relevé désactivé : pas d'historique", () => {
    expect(keepsHistory(FIXTURE)).toBe(true);
    expect(keepsHistory({ sampling: { enabled: false }, series: [] })).toBe(
      false,
    );
    expect(keepsHistory(null)).toBe(false);
  });
});

describe("constantes en détail (2026-11-26)", () => {
  const at = (m: number) =>
    new Date(Date.UTC(2026, 10, 26, 10, m)).toISOString();
  const series = (
    metric: string,
    subject: string | null,
    values: number[],
  ) => ({
    metric,
    subject,
    unit: "x",
    latest: { t: at(values.length - 1), value: values[values.length - 1] },
    points: values.map((v, i) => ({ t: at(i), avg: v, max: v, n: 1 })),
  });

  test("charge, swap, réseau par interface et débit de chaque disque", () => {
    const h = history([
      series("load_1m", null, [0.4, 1.2]),
      series("load_5m", null, [0.3, 0.6]),
      series("load_15m", null, [0.2, 0.3]),
      series("swap_pct", null, [2, 3]),
      series("network_rx_bps", null, [100, 200]),
      series("network_tx_bps", null, [50, 60]),
      series("network_rx_bps", "eth0", [100, 200]),
      series("network_tx_bps", "eth0", [50, 60]),
      series("network_rx_bps", "eth1", [0, 0]),
      series("network_tx_bps", "eth1", [0, 0]),
      series("disk_read_bps", "sata1", [1000, 3000]),
      series("disk_write_bps", "sata1", [500, 700]),
    ]);
    const d = historyDetail(h, "1h");
    expect(d.map((x) => [x.kind, x.subject, x.value])).toEqual([
      ["load", null, 1.2],
      ["swap", null, 3],
      ["interface", "eth0", 260],
      ["disk", "sata1", 3700],
    ]);
    expect(d[0].extra).toEqual({ load5: 0.6, load15: 0.3 });
    expect(d[2].points.map((p) => p.v)).toEqual([150, 260]);
  });

  test("une interface muette reste cachée, rien n'est inventé sans série", () => {
    expect(historyDetail(history([]), "24h")).toEqual([]);
  });
});

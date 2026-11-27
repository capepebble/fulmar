import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PERIODS } from "@/lib/fleet/series";
import {
  beszelDisks,
  cpuTemp,
  latestVitals,
  netBps,
  series,
  volumeFill,
} from "./map";
import type { BzSmart, BzStats, BzStatsRecord, BzSystem } from "./types";

// Réponses du hub Beszel d'essai (0.21.2), enregistrées et nettoyées le 2026-11-21.
const DIR = join(__dirname, "__fixtures__", "essai");
const items = <T>(name: string): T[] =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).items;

const systems = items<BzSystem>("systems");
const stats1m = items<BzStatsRecord>("stats_1m");
const stats480m = items<BzStatsRecord>("stats_480m");
const smart = items<BzSmart>("smart_devices");

const GIB = 1024 ** 3;

function record(created: string, stats: BzStats): BzStatsRecord {
  return { system: "a", type: "20m", created, stats };
}

describe("constantes", () => {
  test("constantes du moment", () =>
    expect(latestVitals(systems[0], stats1m[0].stats)).toMatchObject({
      cpu: 1.06,
      ram: 43.71,
      temp: 35,
      netBps: 2051,
      uptimeS: 268009,
      at: "2026-11-21T09:08:48.379Z",
    }));
  test("sans relevé, les constantes du système", () =>
    expect(latestVitals(systems[0], null)).toMatchObject({
      cpu: 1.06,
      ram: 43.71,
      temp: 35,
      netBps: 2051,
    }));
  test("température : le plus chaud des capteurs du processeur", () => {
    expect(
      cpuTemp({ coretemp_core_0: 35, coretemp_core_1: 41, nvme: 60 }),
    ).toBe(41);
    expect(cpuTemp({ k10temp_tctl: 48 })).toBe(48);
    expect(cpuTemp({ nvme_composite: 50 })).toBeNull();
    expect(cpuTemp(undefined)).toBeNull();
  });
  test("réseau : envoyé plus reçu, absent s'il manque", () => {
    expect(netBps({ b: [201, 1850] })).toBe(2051);
    expect(netBps({})).toBeNull();
  });
});

describe("disques", () => {
  test("les grappes md sont ignorées", () => {
    const d = beszelDisks(smart);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      device: "sata1",
      hours: 46880,
      state: "PASSED",
      temp: 31,
      capacityBytes: 12000138625024,
    });
  });
});

describe("courbes", () => {
  test("les relevés se rangent du plus ancien au plus récent", () => {
    const s = series(stats480m, "cpu", "30d");
    expect(s).toHaveLength(2);
    expect(s[0].t < s[1].t).toBe(true);
    expect(s.every((p) => typeof p.v === "number")).toBe(true);
  });
  test("un trou de plus de deux pas devient null", () => {
    const s = series(
      [
        record("2026-11-21 10:00:00.000Z", { cpu: 1 }),
        record("2026-11-21 10:20:00.000Z", { cpu: 2 }),
        record("2026-11-21 13:40:00.000Z", { cpu: 3 }),
      ],
      "cpu",
      "24h",
    );
    expect(s.map((p) => p.v)).toEqual([1, 2, null, 3]);
    expect(s[2].t).toBe("2026-11-21T10:40:00.000Z");
  });
  test("un trou de deux pas au plus reste un trait", () => {
    const s = series(
      [
        record("2026-11-21 10:00:00.000Z", { cpu: 1 }),
        record("2026-11-21 10:40:00.000Z", { cpu: 2 }),
      ],
      "cpu",
      "24h",
    );
    expect(s.map((p) => p.v)).toEqual([1, 2]);
  });
  test("un champ disparu donne null, jamais 0", () => {
    const s = series(
      [record("2026-11-21 10:00:00.000Z", { mp: 40 })],
      "cpu",
      "24h",
    );
    expect(s).toEqual([{ t: "2026-11-21T10:00:00.000Z", v: null }]);
  });
  test("mémoire, température et réseau", () => {
    const r = [
      record("2026-11-21 10:00:00.000Z", {
        mp: 40,
        t: { coretemp_core_0: 36 },
        b: [1, 2],
      }),
    ];
    expect(series(r, "mem", "24h")[0].v).toBe(40);
    expect(series(r, "temp", "24h")[0].v).toBe(36);
    expect(series(r, "net", "24h")[0].v).toBe(3);
  });
  test("paliers des périodes", () => {
    expect(PERIODS["1h"].tier).toBe("1m");
    expect(PERIODS["24h"].tier).toBe("20m");
    expect(PERIODS["7d"].tier).toBe("120m");
    expect(PERIODS["30d"].tier).toBe("480m");
  });
});

describe("volume", () => {
  test("le volume se reconnaît à sa taille", () => {
    const fill = volumeFill(stats1m, {
      name: "/volume1",
      totalBytes: 11_508_794_368_000,
    });
    expect(fill).toHaveLength(stats1m.length);
    expect(fill[0].t < fill[fill.length - 1].t).toBe(true);
    const last = stats1m[0].stats;
    expect(fill[fill.length - 1].usedBytes).toBe(
      Math.round((last.du ?? 0) * GIB),
    );
  });
  test("sinon par son nom parmi les autres systèmes de fichiers", () => {
    const fill = volumeFill(
      [
        record("2026-11-21 10:00:00.000Z", {
          d: 100,
          du: 20,
          efs: { volume2: { d: 5000, du: 1000 } },
        }),
      ],
      { name: "/volume2", totalBytes: 5000 * GIB },
    );
    expect(fill).toEqual([
      { t: "2026-11-21T10:00:00.000Z", usedBytes: 1000 * GIB },
    ]);
  });
  test("aucun système de fichiers ne correspond : rien", () =>
    expect(
      volumeFill([record("2026-11-21 10:00:00.000Z", { d: 100, du: 20 })], {
        name: "/volume1",
        totalBytes: 5000 * GIB,
      }),
    ).toEqual([]));
});

import { describe, expect, test } from "vitest";
import type { HistoryReader } from "@/lib/agents/history";
import type { MetricsHistory, Read } from "@/lib/agents/types";
import type { BeszelClient } from "@/lib/beszel/client";
import type { BzStatsRecord } from "@/lib/beszel/types";
import { makeCheck, makeNas, makeVolume } from "@/test/nas";
import {
  fillDates,
  fleetCurves,
  nasBeszel,
  nasContainers,
  readCurves,
  volumeForecast,
  volumeHistory,
} from "./curves";

const NOW = new Date("2026-11-21T10:00:00Z");
const up = (systemId: string) =>
  ({ kind: "ok", systemId, lastAt: "2026-11-21T09:59:00Z" }) as const;

function fakeClient(records: BzStatsRecord[]) {
  const calls: { ids: string[]; tier: string; since: Date }[] = [];
  const client = {
    async stats(ids: string[], tier: string, since: Date) {
      calls.push({ ids, tier, since });
      return { ok: true, data: records, at: NOW.toISOString() };
    },
  } as unknown as BeszelClient;
  return { client, calls };
}

const rec = (system: string, created: string, cpu: number, mp: number) => ({
  system,
  created,
  type: "20m",
  stats: { cpu, mp },
});

describe("courbes du parc", () => {
  test("une seule lecture pour tous les systèmes, rangée par NAS", async () => {
    const { client, calls } = fakeClient([
      rec("a1", "2026-11-21 09:00:00.000Z", 5, 40),
      rec("b2", "2026-11-21 09:00:00.000Z", 9, 60),
      rec("a1", "2026-11-21 09:20:00.000Z", 6, 41),
    ]);
    const fleet = [
      makeNas({ id: "a", beszel: up("a1") }),
      makeNas({ id: "b", beszel: up("b2") }),
      makeNas({ id: "c" }),
    ];
    const curves = await fleetCurves(fleet, "24h", NOW, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ids: ["a1", "b2"], tier: "20m" });
    expect(calls[0].since.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(curves.get("a")?.cpu.map((p) => p.v)).toEqual([5, 6]);
    expect(curves.get("b")?.mem.map((p) => p.v)).toEqual([60]);
    expect(curves.has("c")).toBe(false);
  });

  test("sans Beszel : aucune courbe, la page s'affiche quand même", async () => {
    const curves = await fleetCurves(
      [makeNas({ id: "a", beszel: up("a1") })],
      "24h",
      NOW,
      null,
    );
    expect(curves.size).toBe(0);
  });

  test("hub muet : on ne lui redemande rien", async () => {
    const { client, calls } = fakeClient([]);
    const nas = makeNas({
      id: "a",
      beszel: {
        kind: "down",
        systemId: "a1",
        lastAt: null,
        reason: "Beszel injoignable",
        hub: true,
      },
    });
    const curves = await fleetCurves([nas], "24h", NOW, client);
    expect(curves.size).toBe(0);
    expect(calls).toHaveLength(0);
    expect(
      await volumeForecast(nas, makeVolume({ totalBytes: 1 }), NOW, client),
    ).toEqual({ kind: "unknown" });
    expect(calls).toHaveLength(0);
  });

  test("Beszel en panne : aucune courbe", async () => {
    const client = {
      async stats() {
        return { ok: false, reason: "Beszel injoignable" };
      },
    } as unknown as BeszelClient;
    const curves = await fleetCurves(
      [makeNas({ id: "a", beszel: up("a1") })],
      "24h",
      NOW,
      client,
    );
    expect(curves.size).toBe(0);
  });

  test("Beszel en panne : la raison est rendue avec les courbes", async () => {
    const client = {
      async stats() {
        return {
          ok: false,
          reason: "Beszel limite les requêtes, nouvel essai dans 42 s",
        };
      },
    } as unknown as BeszelClient;
    const read = await readCurves(
      [makeNas({ id: "a", beszel: up("a1") })],
      "24h",
      NOW,
      client,
    );
    expect(read.curves.size).toBe(0);
    expect(read.failure).toBe(
      "Beszel limite les requêtes, nouvel essai dans 42 s",
    );
  });

  test("date de remplissage d'après 30 jours de relevés", async () => {
    const GIB = 1024 ** 3;
    const records = Array.from({ length: 30 }, (_, i) => ({
      system: "a1",
      created: new Date(NOW.getTime() - (29 - i) * 86_400_000)
        .toISOString()
        .replace("T", " "),
      type: "480m",
      stats: { d: 1000, du: 600 + i * 10 },
    }));
    const { client, calls } = fakeClient(records);
    const nas = makeNas({ id: "a", beszel: up("a1") });
    const f = await volumeForecast(
      nas,
      makeVolume({ totalBytes: 1000 * GIB, usedBytes: 890 * GIB }),
      NOW,
      client,
    );
    expect(calls[0]).toMatchObject({ ids: ["a1"], tier: "480m" });
    expect(f.kind).toBe("date");

    // Seuls les NAS dont le contrôle de remplissage n'est pas OK sont lus.
    const full = makeNas({
      id: "a",
      beszel: up("a1"),
      volumes: [makeVolume({ totalBytes: 1000 * GIB, usedBytes: 890 * GIB })],
      checks: [makeCheck({ id: "storage.volume_usage", status: "warning" })],
    });
    const calm = makeNas({ id: "b", beszel: up("b1") });
    const dates = await fillDates([full, calm], NOW, client);
    expect([...dates.keys()]).toEqual(["a"]);
    expect(f.kind === "date" && dates.get("a")).toBe(
      f.kind === "date" ? f.at : null,
    );
  });

  test("historique du remplissage sur 30 jours, en pourcentage", async () => {
    const GIB = 1024 ** 3;
    const { client } = fakeClient([
      {
        system: "a1",
        created: "2026-11-01 10:00:00.000Z",
        type: "480m",
        stats: { d: 1000, du: 500 },
      },
      {
        system: "a1",
        created: "2026-11-21 02:00:00.000Z",
        type: "480m",
        stats: { d: 1000, du: 600 },
      },
    ]);
    const h = await volumeHistory(
      makeNas({ id: "a", beszel: up("a1") }),
      makeVolume({ totalBytes: 1000 * GIB }),
      NOW,
      client,
    );
    expect(h.points.map((p) => p.v)).toEqual([50, 60]);
    expect(h.forecast.kind).toBe("date");
  });

  test("sans système Beszel : date inconnue", async () => {
    const f = await volumeForecast(
      makeNas(),
      makeVolume({ totalBytes: 1 }),
      NOW,
      null,
    );
    expect(f).toEqual({ kind: "unknown" });
  });
});

describe("historique de l'agent", () => {
  const DAY = 86_400_000;
  const GIB = 1024 ** 3;

  function history(): MetricsHistory {
    const days = Array.from({ length: 30 }, (_, i) =>
      new Date(NOW.getTime() - (29 - i) * DAY).toISOString(),
    );
    return {
      sampling: { enabled: true },
      series: [
        {
          metric: "cpu_pct",
          latest: { t: NOW.toISOString(), value: 7 },
          points: [
            { t: "2026-11-21T09:00:00Z", avg: 5, max: 40, n: 20 },
            { t: "2026-11-21T09:20:00Z", avg: 6, max: 9, n: 20 },
          ],
        },
        {
          metric: "volume_used_bytes",
          subject: "volume_1",
          points: days.map((t, i) => ({
            t,
            avg: (600 + i * 10) * GIB,
            max: (600 + i * 10) * GIB,
            n: 480,
          })),
        },
      ],
    };
  }

  function fakeHistory(
    read: Read<MetricsHistory> = {
      ok: true,
      fetchedAt: NOW.toISOString(),
      data: history(),
    },
  ) {
    const calls: { id: string; period: string }[] = [];
    const reader: HistoryReader = {
      read(id, period) {
        calls.push({ id, period });
        return Promise.resolve(read);
      },
    };
    return { reader, calls };
  }

  const keeper = (over = {}) =>
    makeNas({ id: "a", agentHistory: true, beszel: up("a1"), ...over });

  test("les courbes viennent de l'agent, Beszel n'est pas lu", async () => {
    const { client, calls: bz } = fakeClient([
      rec("a1", "2026-11-21 09:00:00.000Z", 99, 99),
    ]);
    const { reader, calls } = fakeHistory();
    const read = await readCurves([keeper()], "24h", NOW, client, reader);
    expect(calls).toEqual([{ id: "a", period: "24h" }]);
    expect(bz).toHaveLength(0);
    expect(read.curves.get("a")?.cpu.map((p) => [p.v, p.max])).toEqual([
      [5, 40],
      [6, 9],
    ]);
    expect(read.failure).toBeNull();
  });

  test("sans Beszel configuré : les courbes de l'agent quand même", async () => {
    const { reader } = fakeHistory();
    const curves = await fleetCurves(
      [keeper({ beszel: { kind: "none" } })],
      "7d",
      NOW,
      null,
      reader,
    );
    expect(curves.get("a")?.cpu).toHaveLength(2);
  });

  test("historique illisible : pas de courbe, la raison, pas de Beszel", async () => {
    const { client, calls: bz } = fakeClient([]);
    const { reader } = fakeHistory({
      ok: false,
      reason: {
        en: "l'agent n'a pas répondu à temps",
        fr: "l'agent n'a pas répondu à temps",
      },
    });
    const read = await readCurves([keeper()], "24h", NOW, client, reader);
    expect(read.curves.size).toBe(0);
    expect(read.failure?.fr).toBe(
      "historique de l'agent illisible (l'agent n'a pas répondu à temps)",
    );
    expect(bz).toHaveLength(0);
  });

  test("parc mêlé : l'agent, Beszel et le fictif, chacun sa source", async () => {
    const { client, calls: bz } = fakeClient([
      rec("b2", "2026-11-21 09:00:00.000Z", 9, 60),
    ]);
    const { reader, calls } = fakeHistory();
    const curves = await fleetCurves(
      [
        keeper(),
        makeNas({ id: "b", beszel: up("b2") }),
        makeNas({ id: "c", live: false, vitals: { ...makeNas().vitals } }),
      ],
      "24h",
      NOW,
      client,
      reader,
    );
    expect(calls.map((c) => c.id)).toEqual(["a"]);
    expect(bz).toHaveLength(1);
    expect(bz[0].ids).toEqual(["b2"]);
    expect([...curves.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  test("remplissage et date de remplissage tirés de l'agent", async () => {
    const { client, calls: bz } = fakeClient([]);
    const { reader, calls } = fakeHistory();
    const volume = makeVolume({
      id: "volume_1",
      totalBytes: 1000 * GIB,
      usedBytes: 890 * GIB,
    });
    const h = await volumeHistory(keeper(), volume, NOW, client, reader);
    expect(calls).toEqual([{ id: "a", period: "30d" }]);
    expect(bz).toHaveLength(0);
    expect(h.points[0].v).toBe(60);
    expect(h.forecast.kind).toBe("date");
    const none = await volumeHistory(
      keeper(),
      makeVolume({ id: "volume_9", totalBytes: 1000 * GIB }),
      NOW,
      client,
      reader,
    );
    expect(none.forecast).toEqual({ kind: "unknown" });
  });
});

describe("Beszel pour un NAS", () => {
  test("disques sans les grappes md et matériel, sans lire les conteneurs", async () => {
    let containersRead = false;
    const client = {
      async smart() {
        return {
          ok: true,
          at: NOW.toISOString(),
          data: [
            {
              system: "a1",
              name: "/dev/md0",
              type: "mdraid",
              state: "WARNING",
            },
            {
              system: "a1",
              name: "/dev/sata1",
              type: "sat",
              state: "PASSED",
              hours: 46880,
              temp: 31,
            },
          ],
        };
      },
      async details() {
        return {
          ok: true,
          at: NOW.toISOString(),
          data: { system: "a1", cpu: "Celeron", cores: 2 },
        };
      },
      async containers() {
        containersRead = true;
        return {
          ok: true,
          at: NOW.toISOString(),
          data: { created: "x", stats: [{ n: "nas-agent", c: 0.1, m: 60 }] },
        };
      },
    } as unknown as BeszelClient;
    const r = await nasBeszel(makeNas({ beszel: up("a1") }), client);
    expect(r.disks?.map((d) => d.device)).toEqual(["sata1"]);
    expect(r.details?.cores).toBe(2);
    expect(containersRead).toBe(false);
    const containers = await nasContainers(
      makeNas({ beszel: up("a1") }),
      client,
    );
    expect(containers?.stats).toHaveLength(1);
  });

  test("système introuvable ou Beszel absent : rien", async () => {
    const r = await nasBeszel(
      makeNas({ beszel: { kind: "missing", systemId: "x" } }),
      null,
    );
    expect(r).toEqual({ disks: null, details: null });
    expect(
      await nasContainers(
        makeNas({ beszel: { kind: "missing", systemId: "x" } }),
        null,
      ),
    ).toBeNull();
  });
});

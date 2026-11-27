import { describe, expect, test } from "vitest";
import { makeCheck, makeNas, makeTask, makeVolume } from "@/test/nas";
import type { NasState } from "./state";
import { fleetSentence, fleetStats } from "./summary";
import type { Nas } from "./types";

const up = {
  kind: "ok",
  systemId: "s",
  lastAt: "2026-11-21T09:00:00Z",
} as const;

function nasIn(state: NasState, i = 0): Nas {
  const id = `${state}-${i}`;
  switch (state) {
    case "offline":
      return makeNas({
        id,
        agent: { kind: "down", reason: "x", lastReadAt: null },
      });
    case "agent_down":
      return makeNas({
        id,
        agent: { kind: "down", reason: "x", lastReadAt: null },
        beszel: up,
      });
    case "denied":
      return makeNas({
        id,
        agent: { kind: "denied", reason: "401", lastReadAt: null },
      });
    case "beszel_only":
      return makeNas({ id, agent: { kind: "none" }, beszel: up });
    case "ok":
      return makeNas({ id, checks: [makeCheck()] });
    default:
      return makeNas({ id, checks: [makeCheck({ status: state })] });
  }
}

describe("phrase du parc", () => {
  test.each([
    [["ok", "ok"], "Les 2 NAS vont bien"],
    [["ok"], "Le NAS va bien"],
    [
      ["offline", "failed", "warning", "ok"],
      "3 NAS sur 4 demandent votre attention · 1 hors ligne, 1 en échec, 1 à surveiller",
    ],
    [
      ["failed", "ok", "beszel_only"],
      "1 NAS sur 3 demande votre attention · 1 en échec · 1 suivi par Beszel seulement",
    ],
    [
      ["ok", "beszel_only", "beszel_only"],
      "Les 3 NAS vont bien · 2 suivis par Beszel seulement",
    ],
    [
      ["denied", "agent_down", "agent_down", "unknown"],
      "3 NAS sur 4 demandent votre attention · 1 accès refusé, 2 agents injoignables · 1 à l'état inconnu",
    ],
    [["ok", "unknown"], "Aucun point à traiter · 1 NAS à l'état inconnu"],
    [[], "Aucun NAS"],
  ] as [NasState[], string][])("phrase du parc %j", (states, sentence) =>
    expect(
      fleetSentence(
        states.map((s, i) => nasIn(s, i)),
        "fr",
      ),
    ).toBe(sentence));
});

describe("chiffres du parc", () => {
  const NOW = new Date("2026-11-21T10:00:00Z");

  test("NAS en ligne : tous les NAS", () => {
    const s = fleetStats(
      ["ok", "offline", "beszel_only"].map((x, i) => nasIn(x as NasState, i)),
      NOW,
    );
    expect(s.online).toEqual({ n: 2, total: 3 });
  });

  test("contrôles et sauvegardes ne comptent que les NAS avec agent", () => {
    const fleet = [
      makeNas({
        id: "a",
        checks: [
          makeCheck({ status: "failed" }),
          makeCheck({ id: "b", status: "warning" }),
          makeCheck({ id: "c", status: "warning", severity: "info" }),
        ],
      }),
      makeNas({ id: "z", agent: { kind: "none" }, beszel: up }),
      makeNas({
        id: "d",
        agent: { kind: "down", reason: "x", lastReadAt: null },
      }),
    ];
    expect(fleetStats(fleet, NOW).checks).toEqual({
      failed: 1,
      warning: 1,
      agentNas: 1,
    });
  });

  test("sauvegardes des dernières 24 h : celles lancées depuis 24 h, réussies sur lancées", () => {
    const nas = makeNas({
      tasks: [
        makeTask({
          name: "a",
          lastRunAt: "2026-11-21T02:00:00Z",
          lastSuccessAt: "2026-11-21T02:10:00Z",
        }),
        makeTask({
          name: "b",
          lastRunAt: "2026-11-21T03:00:00Z",
          lastSuccessAt: "2026-11-19T03:10:00Z",
        }),
        makeTask({
          name: "c",
          lastRunAt: "2026-11-19T03:00:00Z",
          lastSuccessAt: "2026-11-19T03:10:00Z",
        }),
        makeTask({ name: "d", lastRunAt: null, lastSuccessAt: null }),
      ],
    });
    expect(fleetStats([nas], NOW).backups).toEqual({
      ok: 1,
      considered: 2,
      failed: { nas, task: "b" },
    });
  });

  test("une sauvegarde en cours n'est ni réussie ni échouée", () => {
    const nas = makeNas({
      tasks: [
        makeTask({
          name: "Nuit",
          running: true,
          lastRunAt: "2026-11-21T09:50:00Z",
          lastSuccessAt: "2026-11-20T03:10:00Z",
        }),
        makeTask({
          name: "a",
          lastRunAt: "2026-11-21T02:00:00Z",
          lastSuccessAt: "2026-11-21T02:10:00Z",
        }),
      ],
    });
    expect(fleetStats([nas], NOW).backups).toEqual({
      ok: 1,
      considered: 1,
      failed: null,
    });
  });

  test("le volume le plus plein, NAS avec agent seulement", () => {
    const a = makeNas({
      id: "a",
      volumes: [
        makeVolume({ pct: 40 }),
        makeVolume({ path: "/volume2", pct: 81 }),
      ],
    });
    const b = makeNas({ id: "b", volumes: [makeVolume({ pct: 62 })] });
    const s = fleetStats([a, b], NOW);
    expect(s.fullest?.nas.id).toBe("a");
    expect(s.fullest?.volume.path).toBe("/volume2");
    expect(fleetStats([], NOW).fullest).toBeNull();
  });
});

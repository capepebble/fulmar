import { describe, expect, it } from "vitest";
import {
  briefLine,
  demoReport,
  mapReport,
  monthsBack,
  writeWords,
} from "./report";

const REPORT = {
  month: "2026-11",
  start: "2026-11-01T00:00:00+00:00",
  end: "2026-11-30T23:59:59+00:00",
  in_progress: false,
  end_state: {
    source: "frozen",
    ok: 40,
    warning: 2,
    failed: 1,
    failing: [
      { id: "backup.task_result", title: "Sauvegardes", status: "failed" },
    ],
  },
  incidents: [
    {
      check_id: "backup.task_result",
      title: "Sauvegardes\u0007",
      status: "failed",
      at: "2026-11-12T03:10:00+00:00",
      recovered_at: "2026-11-13T03:05:00+00:00",
    },
    { check_id: "x", title: "?", status: "exploded", at: "z" },
  ],
  availability: { read_pct: 99.8, since: "2026-11-01T00:00:00+00:00" },
  vitals: {
    cpu_avg: 12.3,
    cpu_max: 88,
    memory_avg: 41,
    memory_max: 60,
    temperature_max: 52,
  },
  volumes: [
    { volume: "volume_1", start_pct: 60.1, end_pct: 64.2, grown_bytes: 4.1e10 },
  ],
  updates: [
    {
      kind: "packages",
      name: "Text Editor",
      from_version: "1.2.5",
      to_version: "1.2.6",
      state: "done",
      ended_at: "2026-11-26T21:03:00+00:00",
    },
  ],
  fulmar: {
    calls: 12000,
    denied: 2,
    writes: [{ op: "packages.update", count: 1 }],
  },
};

describe("mapReport", () => {
  it("lit le bilan sans confiance", () => {
    const r = mapReport(REPORT);
    expect(r?.incidents).toHaveLength(1);
    expect(r?.incidents[0].title).toBe("Sauvegardes");
    expect(r?.endState.failed).toBe(1);
    expect(r?.volumes[0].endPct).toBe(64.2);
    expect(r?.fulmar.writes).toEqual([{ op: "packages.update", count: 1 }]);
    expect(mapReport({ month: "nope" })).toBeNull();
  });
});

describe("briefLine", () => {
  it("dit le mois en une phrase", () => {
    const r = mapReport(REPORT);
    if (!r) throw new Error("bilan attendu");
    expect(briefLine(r, "fr")).toBe(
      "1 incident, résolu ; lu 99,8 % du temps ; Volume 1 à 64 % ; 1 mise à jour faite.",
    );
    expect(briefLine(r, "en")).toBe(
      "1 incident, resolved; read 99.8% of the time; Volume 1 at 64%; 1 update done.",
    );
  });
});

describe("monthsBack", () => {
  it("les douze derniers mois, le plus récent d'abord", () => {
    const months = monthsBack(new Date("2026-11-26T22:00:00Z"), 12, "fr");
    expect(months[0]).toEqual({ value: "2026-11", label: "novembre 2026" });
    expect(months[11].value).toBe("2025-12");
  });
});

describe("demoReport", () => {
  it("un exemple pour un NAS fictif", () => {
    const r = demoReport("2026-11", "fr");
    expect(r.month).toBe("2026-11");
    expect(r.incidents.length).toBeGreaterThan(0);
  });
});

describe("writeWords", () => {
  it("dit chaque écriture en mots", () => {
    expect(writeWords({ op: "updates.protect", count: 4 }, "fr")).toBe(
      "4 protections changées",
    );
    expect(writeWords({ op: "access.close", count: 1 }, "en")).toBe(
      "1 access closed",
    );
    expect(writeWords({ op: "made.up", count: 2 }, "fr")).toBe("made.up (2)");
  });
});

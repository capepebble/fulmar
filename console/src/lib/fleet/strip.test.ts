import { describe, expect, test } from "vitest";
import { backupStrip, mergeStrips, type StripCell } from "./strip";
import type { BackupLogEntry } from "./types";

const e = (
  at: string,
  outcome: BackupLogEntry["outcome"],
  task = "Nuit",
): BackupLogEntry => ({
  at,
  task,
  outcome,
});

describe("bande des 30 jours", () => {
  test("30 cases, de la plus ancienne à aujourd'hui", () => {
    const s = backupStrip([], "Nuit", 60, "2026-11-21", "2026-10-01T00:00:00Z");
    expect(s).toHaveLength(30);
    expect(s[0].day).toBe("2026-10-23");
    expect(s[29].day).toBe("2026-11-21");
    expect(s.every((c) => c.kind === "none")).toBe(true);
  });

  test("une case par jour du NAS, la pire du jour", () => {
    const log = [
      e("2026-11-21T02:10:00Z", "success"),
      e("2026-11-21T02:00:00Z", null),
      e("2026-11-20T14:00:00Z", "success"),
      e("2026-11-20T02:05:00Z", "failure"),
      e("2026-11-19T02:05:00Z", "partial"),
      e("2026-11-19T02:15:00Z", "success"),
      e("2026-11-18T02:05:00Z", "failure", "Autre tâche"),
    ];
    const s = backupStrip(
      log,
      "Nuit",
      60,
      "2026-11-21",
      "2026-10-01T00:00:00Z",
    );
    expect(s.slice(-4).map((c) => [c.day, c.kind])).toEqual([
      ["2026-11-18", "none"],
      ["2026-11-19", "partial"],
      ["2026-11-20", "failure"],
      ["2026-11-21", "success"],
    ]);
  });

  test("ligne au résultat illisible : unknown, pas none", () => {
    const log = [
      e("2026-11-21T02:10:00Z", null),
      e("2026-11-21T02:00:00Z", null),
    ];
    const s = backupStrip(
      log,
      "Nuit",
      60,
      "2026-11-21",
      "2026-10-01T00:00:00Z",
    );
    expect(s[29].kind).toBe("unknown");
  });

  test("avant le début du journal : before", () => {
    const s = backupStrip(
      [e("2026-11-15T02:10:00Z", "success")],
      "Nuit",
      60,
      "2026-11-21",
      "2026-11-14T22:30:00Z",
    );
    const byDay = Object.fromEntries(s.map((c) => [c.day, c.kind]));
    expect(byDay["2026-11-13"]).toBe("before");
    // 22:30 UTC le 14 : 23:30 à l'heure du NAS, le journal commence ce jour-là.
    expect(byDay["2026-11-14"]).toBe("none");
    expect(byDay["2026-11-15"]).toBe("success");
  });

  test("journal illisible : aucune case n'est inventée", () => {
    const s = backupStrip([], "Nuit", 60, "2026-11-21", null);
    expect(s.every((c) => c.kind === "unknown")).toBe(true);
  });

  test("jours comptés dans le fuseau du NAS", () => {
    const s = backupStrip(
      [e("2026-11-20T20:00:00Z", "failure")],
      "Nuit",
      420,
      "2026-11-21",
      "2026-10-01T00:00:00Z",
    );
    expect(s[29]).toEqual({ day: "2026-11-21", kind: "failure" });
    expect(s[28]).toEqual({ day: "2026-11-20", kind: "none" });
  });
});

describe("bande de toutes les tâches", () => {
  test("garde le pire résultat de chaque jour, et les jours sans exécution", () => {
    const a: StripCell[] = [
      { day: "2026-11-23", kind: "success" },
      { day: "2026-11-24", kind: "success" },
      { day: "2026-11-25", kind: "none" },
    ];
    const b: StripCell[] = [
      { day: "2026-11-23", kind: "before" },
      { day: "2026-11-24", kind: "failure" },
      { day: "2026-11-25", kind: "unknown" },
    ];
    expect(mergeStrips([a, b]).map((c) => c.kind)).toEqual([
      "success",
      "failure",
      "unknown",
    ]);
    expect(mergeStrips([])).toEqual([]);
  });
});

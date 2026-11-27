import { describe, expect, it } from "vitest";
import { heldWords, mapProtections, protectQuery } from "./protections";
import { mapRollouts, rolloutKey } from "./rollouts";

describe("mapProtections", () => {
  it("lit les protections et ce qu'elles retiennent", () => {
    const view = mapProtections({
      frozen: false,
      dsm_locked: true,
      packages: ["ActiveBackup-Office365", "../x"],
      note: "caméras\u0007 du client",
      held: {
        "ActiveBackup-Office365": "protected",
        SynoFinder: "needed by ActiveBackup-Office365",
        "bad id": "protected",
      },
    });
    expect(view).toEqual({
      frozen: false,
      dsmLocked: true,
      packages: ["ActiveBackup-Office365"],
      note: "caméras du client",
      held: {
        "ActiveBackup-Office365": "protected",
        SynoFinder: "needed by ActiveBackup-Office365",
      },
    });
    expect(mapProtections("nope")).toBeNull();
  });

  it("dit pourquoi un paquet est retenu", () => {
    const names = {
      "ActiveBackup-Office365": "Active Backup for Microsoft 365",
    };
    expect(heldWords("frozen", "fr", names)).toBe("NAS gelé");
    expect(heldWords("protected", "fr", names)).toBe("Protégé");
    expect(heldWords("needed by ActiveBackup-Office365", "fr", names)).toBe(
      "Requis par Active Backup for Microsoft 365",
    );
    expect(heldWords("needed by X", "en", {})).toBe("Needed by X");
  });
});

describe("mapRollouts", () => {
  it("lit les déroulés du hub, sans confiance", () => {
    const got = mapRollouts({
      running: true,
      rollouts: [
        {
          id: "ab12cd34",
          target: "dsm",
          at: "2026-11-26T22:00:00+00:00",
          accept_warnings: false,
          created_at: "2026-11-26T21:59:00+00:00",
          state: "running",
          reason: null,
          ended_at: null,
          cancel: false,
          steps: [
            {
              nas: "aaaa0001",
              state: "done",
              reason: null,
              started_at: "x",
              ended_at: "y",
            },
            {
              nas: "hub",
              state: "pending",
              reason: null,
              started_at: null,
              ended_at: null,
            },
            { nas: "../evil", state: "done" },
            { nas: "bbbb0002", state: "exploded" },
          ],
        },
        { id: "nope", state: "done", steps: [] },
      ],
    });
    expect(got.running).toBe(true);
    expect(got.rollouts).toHaveLength(1);
    expect(got.rollouts[0].steps.map((s) => [s.nas, s.state])).toEqual([
      ["aaaa0001", "done"],
      ["hub", "pending"],
    ]);
  });

  it("le NAS du projet s'appelle « hub » pour l'agent", () => {
    expect(rolloutKey({ id: "local", member: false })).toBe("hub");
    expect(rolloutKey({ id: "aaaa0001", member: true })).toBe("aaaa0001");
    expect(rolloutKey({ id: "essai", member: false })).toBeNull();
  });
});

describe("protectQuery", () => {
  it("ne laisse passer que des changements revérifiés", () => {
    expect(
      protectQuery({ frozen: true, lock: ["TextEditor"], note: "gel" }),
    ).toBe("?frozen=true&lock=TextEditor&note=gel");
    expect(protectQuery({ dsmLocked: false, unlock: [] })).toBe(
      "?dsm_locked=false",
    );
    expect(protectQuery({ lock: ["../etc"] })).toBeNull();
    expect(protectQuery({ note: "x".repeat(201) })).toBeNull();
    expect(protectQuery({})).toBeNull();
  });
});

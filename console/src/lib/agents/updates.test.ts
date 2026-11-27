import { describe, expect, it } from "vitest";
import { mapDsmPlan, mapJobs, mapPlan, packageIds } from "./updates";

// Réponses de l'agent lors de la mise à jour réelle de Text Editor sur le NAS d'essai
// (2026-11-26, DSM 7.4.1-90080 Update 2).
const CHECK = {
  packages: [
    {
      id: "TextEditor",
      name: "Text Editor",
      installed: "1.2.5-0254",
      available: "1.2.6-0260",
      security: false,
      state: "ready",
    },
    {
      id: "HyperBackup",
      name: "Hyper Backup",
      installed: "4.2.2-4262",
      available: "4.2.2-4262",
      security: false,
      state: "up_to_date",
    },
    {
      id: "Nope",
      name: "Nope",
      installed: null,
      available: null,
      security: null,
      state: "not_installed",
    },
  ],
  feasibility: "ok",
  reasons: [],
  dsm_code: null,
};
const STATUS = {
  running: false,
  jobs: [
    {
      id: "5bea5f7c",
      state: "done",
      started_at: "2026-11-26T18:01:48.493223+00:00",
      ended_at: "2026-11-26T18:01:53.072032+00:00",
      packages: [
        {
          id: "TextEditor",
          name: "Text Editor",
          from_version: "1.2.5-0254",
          to_version: "1.2.6-0260",
          state: "done",
          error: null,
          dsm_code: null,
          started_at: "2026-11-26T18:01:48.494267+00:00",
          ended_at: "2026-11-26T18:01:53.071371+00:00",
        },
      ],
    },
  ],
};

describe("mises à jour des paquets", () => {
  it("lit le plan de l'agent", () => {
    const plan = mapPlan(CHECK);
    expect(plan.feasibility).toBe("ok");
    expect(plan.packages.map((p) => [p.id, p.state])).toEqual([
      ["TextEditor", "ready"],
      ["HyperBackup", "up_to_date"],
      ["Nope", "not_installed"],
    ]);
  });

  it("garde les raisons de DSM sans caractère de contrôle, et rejette le reste", () => {
    const plan = mapPlan({
      feasibility: "warning",
      reasons: ["Active Backup\u0007 is backing up", 42],
      packages: [
        { id: "../x", state: "ready" },
        { id: "A", state: "bizarre" },
      ],
    });
    expect(plan.reasons).toEqual(["Active Backup  is backing up"]);
    expect(plan.packages).toEqual([]);
    expect(mapPlan({ feasibility: "peut-être" }).feasibility).toBe("unknown");
  });

  it("lit le travail et son paquet", () => {
    const { running, jobs } = mapJobs(STATUS);
    expect(running).toBe(false);
    expect(jobs[0]).toMatchObject({ id: "5bea5f7c", state: "done" });
    expect(jobs[0].packages[0]).toEqual({
      id: "TextEditor",
      name: "Text Editor",
      from: "1.2.5-0254",
      to: "1.2.6-0260",
      state: "done",
      error: null,
    });
  });

  it("ne transmet que des identifiants de paquets valides", () => {
    expect(
      packageIds(["TextEditor", "TextEditor", "../etc", 3, "Hyper Backup"]),
    ).toEqual(["TextEditor"]);
    expect(packageIds("TextEditor")).toEqual([]);
  });
});

describe("DSM et rendez-vous", () => {
  it("lit l'état de DSM et ses raisons", () => {
    expect(
      mapDsmPlan({
        current: "DSM 7.4.1-90080 Update 2",
        available: false,
        version: null,
        download: "none",
        feasibility: "ok",
        reasons: [],
      }),
    ).toEqual({
      current: "DSM 7.4.1-90080 Update 2",
      available: false,
      version: null,
      feasibility: "ok",
      reasons: [],
    });
  });

  it("lit un travail DSM et les rendez-vous", () => {
    const state = mapJobs({
      running: true,
      jobs: [
        {
          id: "a1b2c3d4",
          kind: "dsm",
          state: "running",
          started_at: "2026-11-27T02:00:00+00:00",
          ended_at: null,
          packages: [],
          dsm: {
            from_version: "DSM 7.4.1-90080 Update 2",
            to_version: "DSM 7.4.1-90080 Update 3",
            step: "download",
            state: "running",
            percent: 42.4,
            error: null,
          },
        },
      ],
      schedules: [
        {
          id: "0f0f0f0f",
          target: "packages",
          packages: ["TextEditor", "../x"],
          at: "2026-11-27T02:00:00+00:00",
          accept_warnings: false,
          state: "waiting",
          reason: null,
        },
        { id: "bad", state: "bizarre", at: "x" },
      ],
    });
    expect(state.jobs[0].dsm).toMatchObject({ step: "download", percent: 42 });
    expect(state.schedules).toEqual([
      {
        id: "0f0f0f0f",
        target: "packages",
        packages: ["TextEditor"],
        at: "2026-11-27T02:00:00+00:00",
        acceptWarnings: false,
        state: "waiting",
        reason: null,
      },
    ]);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeBackupFrom, cloudBackupsFrom, synologyFrom } from "./map";
import type { AgentReads } from "./types";

// Réponses de l'agent lues sur le NAS d'essai le 2026-11-26 (DSM 7.4.1-90080 Update 2) :
// les pages de Synology lues par l'agent lui-même, Active Backup installé sans tâche.
const DIR = join(__dirname, "__fixtures__", "essai");
const read = (file: string) => {
  const env = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  return {
    ok: true as const,
    fetchedAt: env.fetched_at as string,
    data: env.data,
  };
};

describe("failles connues et fin de vie", () => {
  it("rend la lecture du NAS d'essai : rien ne le touche, modèle suivi", () => {
    const info = synologyFrom({
      "updates.synology": read("updates_synology.json"),
    });
    expect(info).toMatchObject({
      read: true,
      known: 140,
      lifecycle: {
        model: "DS420+",
        listed: true,
        updates: "full",
        warrantyYears: 3,
      },
      findings: [],
    });
  });

  it("ne garde que les liens vers www.synology.com", () => {
    const base = read("updates_synology.json");
    const finding = {
      id: "Synology-SA-26:19",
      title: "t",
      severity: "Critical",
      product: "DSM 7.2",
      state: "affected" as const,
      fixed_in: "7.2.2-72806-10",
      other_branch: false,
    };
    const reads: AgentReads = {
      "updates.synology": {
        ...base,
        data: {
          ...base.data,
          findings: [
            {
              ...finding,
              url: "https://www.synology.com/en-global/security/advisory/Synology_SA_26_19",
            },
            { ...finding, url: "https://www.synology.com.evil.example/x" },
            { ...finding, url: "javascript:alert(1)" },
          ],
        },
      },
    };
    const info = synologyFrom(reads);
    expect(info?.findings.map((f) => f.url)).toEqual([
      "https://www.synology.com/en-global/security/advisory/Synology_SA_26_19",
    ]);
    expect(info?.findings[0]).toMatchObject({
      fixedIn: "7.2.2-72806-10",
      otherBranch: false,
    });
  });

  it("sans la lecture, rien", () => {
    expect(synologyFrom({})).toBeNull();
  });
});

describe("Active Backup for Business", () => {
  it("installé, pas activé, sans tâche : aucun appareil", () => {
    expect(
      activeBackupFrom({
        "backup.activebackup": read("backup_activebackup.json"),
      }),
    ).toEqual({
      activated: false,
      devices: [],
    });
  });

  it("un appareil par ligne, la tâche sans appareil sous son nom", () => {
    const base = read("backup_activebackup.json");
    const info = activeBackupFrom({
      "backup.activebackup": {
        ...base,
        data: {
          activated: true,
          tasks: [
            {
              name: "Postes",
              type: "pc",
              last_result: "success",
              devices: [
                {
                  name: "atelier-mac",
                  os: "macOS 26",
                  last_success_at: "2026-11-26T08:00:00+00:00",
                },
                { name: "accueil-pc", os: "Windows 11", last_success_at: null },
              ],
            },
            {
              name: "Partage",
              type: "file_server",
              last_result: "failed",
              devices: [],
            },
          ],
        },
      },
    });
    expect(
      info?.devices.map((d) => [d.name, d.task, d.type, d.lastResult]),
    ).toEqual([
      ["atelier-mac", "Postes", "pc", "success"],
      ["accueil-pc", "Postes", "pc", "success"],
      ["Partage", "Partage", "file_server", "failed"],
    ]);
  });
});

describe("Microsoft 365 et Google Workspace", () => {
  it("installés sur le NAS d'essai, pas activés, sans tâche", () => {
    const info = cloudBackupsFrom({
      "backup.activebackup_cloud": read("backup_activebackup_cloud.json"),
    });
    expect(info).toEqual({
      suites: ["microsoft365", "google_workspace"],
      tasks: [],
    });
  });

  it("sans les paquets, rien ; une tâche continue se lit", () => {
    const base = read("backup_activebackup_cloud.json");
    expect(
      cloudBackupsFrom({
        "backup.activebackup_cloud": {
          ...base,
          data: { microsoft365: null, google_workspace: null },
        },
      }),
    ).toBeNull();
    const info = cloudBackupsFrom({
      "backup.activebackup_cloud": {
        ...base,
        data: {
          microsoft365: {
            activated: true,
            tasks: [
              {
                name: "Microsoft 365 du cabinet",
                state: "active",
                continuous: true,
                last_run_at: "2026-11-26T16:50:00+00:00",
                last_result: "success",
                errors: 0,
                accounts: 12,
              },
            ],
          },
          google_workspace: null,
        },
      },
    });
    expect(info?.suites).toEqual(["microsoft365"]);
    expect(info?.tasks[0]).toMatchObject({
      suite: "microsoft365",
      name: "Microsoft 365 du cabinet",
      continuous: true,
      accounts: 12,
    });
  });
});

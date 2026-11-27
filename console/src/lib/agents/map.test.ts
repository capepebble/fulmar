import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapNas, offlineNas } from "./map";
import {
  type AgentConfig,
  type AgentReads,
  READ_PATHS,
  type ReadKey,
} from "./types";

// Réponses de l'agent rejoué sur les réponses DSM enregistrées et nettoyées du NAS d'essai.
const DIR = join(__dirname, "__fixtures__", "essai");

function fixture(key: ReadKey) {
  const file = `${READ_PATHS[key].slice(1).replace(/[/?=&]/g, "_")}.json`;
  const env = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  return {
    ok: true as const,
    fetchedAt: env.fetched_at as string,
    data: env.data,
  };
}

function allReads(): AgentReads {
  return Object.fromEntries(
    (Object.keys(READ_PATHS) as ReadKey[]).map((k) => [k, fixture(k)]),
  ) as AgentReads;
}

const AGENT: AgentConfig = {
  id: "essai",
  name: "NAS d'essai",
  place: "Salon",
  url: "http://127.0.0.1:18765",
  tokenEnv: "NAS_AGENT_ESSAI_TOKEN",
};

const NOW = new Date("2026-11-09T15:30:00Z");

describe("mapNas", () => {
  const nas = mapNas(AGENT, allReads(), NOW, "Europe/Paris", "fr");

  it("reprend l'identité de la configuration et le système lu par l'agent", () => {
    expect(nas).toMatchObject({
      id: "essai",
      name: "NAS d'essai",
      place: "Salon",
      model: "DS918+",
      dsm: "DSM 7.2.2-72806 Update 3",
      timeZone: "UTC+1, Amsterdam",
      reachable: true,
      live: true,
      real: false,
      fileLogs: "on",
    });
    // Valeur du moment : le dernier relevé de l'historique de l'agent (4 min avant NOW).
    expect(nas.agentHistory).toBe(true);
    expect(nas.vitals).toEqual({
      cpu: 9,
      ram: 24,
      temp: 40,
      uptime: "1 j 19 h",
      netBps: 109_549 + 45_097,
      source: "agent",
    });
    // L'heure de lecture est celle des lectures de DSM, jamais celle de l'historique.
    const latest = (Object.keys(READ_PATHS) as ReadKey[])
      .filter((k) => k !== "metrics.history")
      .map((k) => new Date(fixture(k).fetchedAt).getTime())
      .sort((a, b) => b - a)[0];
    expect(nas.readAt).toBe(new Date(latest).toISOString());
  });

  it("lit l'usure des disques dans SMART et les conteneurs (2026-11-26)", () => {
    // La réponse SMART vient du DS420+ (« sata1 ») : on la rattache au premier disque.
    const reads = allReads();
    const smart = fixture("storage.smart");
    smart.data.disks[0].id = "sda";
    const withSmart = mapNas(
      AGENT,
      { ...reads, "storage.smart": smart },
      NOW,
      "Europe/Paris",
      "fr",
    );
    expect(withSmart.disks[0]).toMatchObject({
      device: "sda",
      hours: 46_983,
      wear: {
        reallocated: 0,
        pending: 0,
        uncorrectable: 0,
        crc: 0,
        ssdLife: null,
        lastTest: "completed",
      },
    });
    expect(withSmart.disks[1].wear).toBeNull();
    expect(nas.containers).toHaveLength(5);
    expect(nas.containers?.find((c) => c.name === "nas-agent")).toMatchObject({
      state: "running",
      oomKilled: false,
      image: "nas-agent:0.1.0",
    });
  });

  it("sans Container Manager ni SMART : rien d'inventé", () => {
    const bare = mapNas(
      AGENT,
      {
        ...allReads(),
        "containers.list": { ok: false, reason: { en: "x", fr: "x" } },
        "storage.smart": { ok: false, reason: { en: "x", fr: "x" } },
      },
      NOW,
      "Europe/Paris",
      "fr",
    );
    expect(bare.containers).toBeNull();
    expect(bare.disks[0].wear).toBeNull();
    expect(bare.disks[0].hours).toBeNull();
  });

  it("garde les 47 contrôles de l'agent, avec leur libellé court", () => {
    expect(nas.checks).toHaveLength(47);
    const twoFactor = nas.checks.find(
      (c) => c.id === "accounts.admin_two_factor",
    );
    expect(twoFactor).toMatchObject({
      status: "failed",
      category: "accounts",
      short: "2FA",
      items: ["utilisateur", "claude"],
    });
    expect(nas.checks.filter((c) => c.status === "failed")).toHaveLength(4);
  });

  it("traduit le stockage, disque en mauvais état compris", () => {
    expect(nas.volumes).toEqual([
      {
        id: "volume_1",
        path: "/volume1",
        fs: "Btrfs",
        raid: "SHR-2, 2 disques",
        pct: 69.6,
        used: "24,3 To",
        total: "34,9 To",
        status: "normal",
        totalBytes: 38_378_964_738_048,
        usedBytes: 26_724_878_606_336,
      },
    ]);
    expect(
      nas.disks.map((d) => [d.bay, d.size, d.temp, d.smart, d.healthy]),
    ).toEqual([
      [1, "7,3 To", 39, "normal", true],
      [2, "7,3 To", 58, "warning", false],
    ]);
    expect(nas.pools).toEqual([
      { name: "Groupe de stockage 1", raid: "SHR-2", status: "normal" },
    ]);
  });

  it("donne aux sauvegardes l'état du contrôle qui les vise", () => {
    expect(nas.tasks).toEqual([
      {
        name: "Essai local",
        kind: "Locale, multiversion",
        destination: "sauvegardes",
        schedule: "Lancée à la main",
        lastRun: "il y a 72 h 21",
        lastSuccess: "ven. 6 nov., 16:08",
        result: {
          status: "warning",
          text: "sans planning, dernière réussite il y a 67 h",
        },
        nextRun: "aucune",
        integrityLast: "aujourd'hui, 10:35",
        integrityNext: "dim. 15 nov., 4:00",
        lastSuccessAt: "2026-11-06T15:08:41.000Z",
        lastRunAt: "2026-11-06T15:08:29.000Z",
        running: false,
      },
    ]);
  });

  it("aligne les réglages de sécurité sur les verdicts des contrôles", () => {
    const byLabel = Object.fromEntries(
      nas.security.map((s) => [s.label, [s.state, s.value]]),
    );
    expect(byLabel).toEqual({
      "Pare-feu": ["failed", "Coupé"],
      "Blocage automatique": ["ok", "Actif, 10 échecs en 5 min"],
      // Depuis le 2026-11-26, la protection des comptes est un contrôle : coupée, à surveiller.
      "Protection des comptes": ["warning", "Coupée"],
      "Double authentification imposée": ["neutral", "À personne"],
      SSH: ["warning", "Ouvert, port 22"],
      Telnet: ["ok", "Coupé"],
      QuickConnect: ["ok", "Coupé"],
      // Services, lus en direct le 2026-11-26 (services.list).
      SMB: ["ok", "Actif, minimum SMB2"],
      FTP: ["neutral", "Coupé"],
      SFTP: ["neutral", "Coupé"],
      rsync: ["neutral", "Coupé"],
      SNMP: ["neutral", "Coupé"],
      AFP: ["neutral", "Coupé"],
      "DSM en HTTPS": ["warning", "HTTP encore ouvert (port 5000)"],
      "Déconnexion après inactivité": ["neutral", "15 min"],
    });
    expect(nas.advisor).toMatchObject({
      group: "Maison",
      rules: 31,
      passed: 21,
      failed: 2,
      skipped: 8,
      lastRun: "aujourd'hui, 7:39",
    });
    expect(nas.advisor.failedRules[0]).toEqual({
      state: "failed",
      title: "Port SSH par défaut (22)",
      area: "Réseau",
    });
  });

  it("traduit certificats, comptes, onduleur, connectés et journaux", () => {
    expect(nas.certificates).toEqual([
      {
        name: "synology",
        issuer: "Autosigné",
        until: "7 nov. 2027",
        days: 362,
        services: 4,
        isDefault: true,
      },
    ]);
    expect(nas.accounts.map((a) => [a.name, a.role, a.state])).toEqual([
      ["admin", "Administrateur d'origine", "Désactivé"],
      ["utilisateur", "Administrateur", "Actif"],
      ["claude", "Administrateur", "Actif"],
      ["guest", "Invité", "Désactivé"],
    ]);
    expect(nas.ups).toBe("Aucun onduleur configuré");
    expect(nas.connected[1]).toEqual({
      who: "utilisateur",
      protocol: "DSM",
      from: "192.0.2.1",
      since: "ven. 6 nov., 15:49",
      device: "HTTP/HTTPS",
      isAgent: false,
    });
    // Transferts réels du NAS d'essai : actions File Station du compte de l'agent.
    expect(
      nas.activity.filter((e) => e.source === "files").map((e) => e.text),
    ).toEqual([
      "A supprimé « /essai/journal 2 renommé » (File Station).",
      "A supprimé « /essai/journal renommé » (File Station).",
      "A déplacé « /essai/journal 2 renommé/note-2.txt » vers « /essai/journal renommé/note-2.txt » (File Station).",
      "A copié « /essai/documents/note-2.txt » vers « /essai/journal 2 renommé/note-2.txt » (File Station).",
      "A renommé « /essai/journal-essai-2 » en « /essai/journal 2 renommé » (File Station).",
      "A créé le dossier « /essai/journal-essai-2 » (File Station).",
    ]);
    expect(nas.activity[0]).toMatchObject({
      day: "Aujourd'hui",
      time: "21:26",
      level: "warning",
      source: "files",
      who: "claude",
    });
    // Juste après eux, la plus récente entrée des journaux de DSM, comme avant.
    expect(nas.activity[6]).toMatchObject({
      time: "7:40",
      who: "SYSTEM_ADMIN",
    });
    expect(nas.shares.find((s) => s.name === "docker")).toEqual({
      name: "docker",
      recycleBin: false,
      snapshots: "2 instantanés, planifiés",
    });
  });

  it("range les transferts de fichiers dans l'activité, suppressions en attention", () => {
    const reads = allReads();
    reads["logs.files"] = {
      ok: true,
      fetchedAt: "2026-11-09T15:29:00Z",
      data: {
        total: 2,
        logging: { smb: true, file_station: false },
        entries: [
          {
            time: "2026-11-09T16:20:00",
            protocol: "SMB",
            account: "jeanne",
            action: "delete",
            path: "/essai/a.txt",
            is_dir: false,
            size: 10,
          },
          {
            time: "2026-11-09T16:10:00",
            protocol: "File Station",
            account: "paul",
            action: "chmod",
            path: "/essai/b",
            is_dir: true,
            size: 0,
          },
        ],
      },
    };
    const live = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(live.fileLogs).toBe("on");
    expect(live.activity.filter((e) => e.source === "files")).toEqual([
      {
        day: "Aujourd'hui",
        time: "16:20",
        level: "warning",
        source: "files",
        who: "jeanne",
        text: "A supprimé « /essai/a.txt » (SMB).",
      },
      {
        day: "Aujourd'hui",
        time: "16:10",
        level: "ok",
        source: "files",
        who: "paul",
        text: "Action « chmod » sur « /essai/b » (File Station).",
      },
    ]);
    // Journal coupé après coup : les actions déjà notées restent lisibles.
    const cut = structuredClone(reads);
    const files = cut["logs.files"];
    if (files?.ok) files.data.logging = { smb: false, file_station: false };
    const off = mapNas(AGENT, cut, NOW, "Europe/Paris", "fr");
    expect(off.fileLogs).toBe("off");
    expect(off.activity.filter((e) => e.source === "files")).toHaveLength(2);
    // Réglage illisible, ou lecture refusée : on ne sait pas, on ne dit pas « coupé ».
    if (files?.ok) files.data.logging = null;
    expect(mapNas(AGENT, cut, NOW, "Europe/Paris", "fr").fileLogs).toBe(
      "unknown",
    );
    reads["logs.files"] = { ok: false, reason: { en: "403", fr: "403" } };
    expect(mapNas(AGENT, reads, NOW, "Europe/Paris", "fr").fileLogs).toBe(
      "unknown",
    );
  });

  it("garde toutes les lignes lues de chaque source, même quand les transferts abondent", () => {
    const reads = allReads();
    reads["logs.files"] = undefined;
    const before = mapNas(
      AGENT,
      reads,
      NOW,
      "Europe/Paris",
      "fr",
    ).activity.filter((e) => e.source === "connections").length;
    reads["logs.files"] = {
      ok: true,
      fetchedAt: "2026-11-09T15:29:00Z",
      data: {
        total: 50,
        logging: { smb: true },
        entries: Array.from({ length: 50 }, (_, i) => ({
          time: `2026-11-09T16:${String(i).padStart(2, "0")}:00`,
          protocol: "SMB",
          account: "jeanne",
          action: "write",
          path: `/essai/f${i}.txt`,
        })),
      },
    };
    const after = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr").activity;
    expect(after.filter((e) => e.source === "files")).toHaveLength(50);
    expect(after.filter((e) => e.source === "connections")).toHaveLength(
      before,
    );
  });

  it("dit « lecture impossible » quand une lecture manque, sans inventer", () => {
    const reads = allReads();
    reads["audit.checks"] = {
      ok: false,
      reason: {
        en: "403 : droit audit:checks manquant",
        fr: "403 : droit audit:checks manquant",
      },
    };
    reads["users.list"] = { ok: false, reason: { en: "403", fr: "403" } };
    const partial = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(partial.reachable).toBe(true);
    expect(partial.checks).toHaveLength(47);
    expect(partial.checks.every((c) => c.status === "unknown")).toBe(true);
    expect(partial.checks[0].observed).toBe(
      "Lecture impossible : 403 : droit audit:checks manquant",
    );
    expect(partial.accounts).toEqual([]);
  });

  it("journal de Hyper Backup lu mais vide : lu ; refusé : non lu", () => {
    const empty = allReads();
    const read = empty["backup.hyperbackup.logs"];
    if (!read?.ok) throw new Error("réponse enregistrée attendue");
    empty["backup.hyperbackup.logs"] = {
      ...read,
      data: { ...(read.data as object), entries: [] },
    };
    const e = mapNas(AGENT, empty, NOW, "Europe/Paris", "fr");
    expect(e.backupLog).toEqual([]);
    expect(e.backupLogRead).toBe(true);
    const unread = allReads();
    unread["backup.hyperbackup.logs"] = {
      ok: false,
      reason: { en: "403", fr: "403" },
    };
    expect(mapNas(AGENT, unread, NOW, "Europe/Paris", "fr").backupLogRead).toBe(
      false,
    );
  });

  it("modèle v2 : lien avec l'agent, fuseau, journal des sauvegardes, instants et octets", () => {
    expect(nas.agent).toEqual({ kind: "ok", readAt: nas.readAt });
    expect(nas.beszel).toEqual({ kind: "none" });
    expect(nas.tzOffsetMin).toBe(60);
    expect(nas.vitals).toMatchObject({ netBps: 154_646, source: "agent" });
    expect(nas.backupLog).toEqual([
      {
        at: "2026-11-06T15:08:41.000Z",
        task: "Essai local",
        outcome: "success",
      },
      { at: "2026-11-06T15:08:29.000Z", task: "Essai local", outcome: null },
      { at: "2026-11-06T15:08:19.000Z", task: null, outcome: null },
    ]);
    expect(nas.backupLogFrom).toBe("2026-11-06T15:08:19.000Z");
    expect(nas.tasks[0]).toMatchObject({
      lastSuccessAt: "2026-11-06T15:08:41.000Z",
      lastRunAt: "2026-11-06T15:08:29.000Z",
    });
    expect(nas.volumes[0]).toMatchObject({
      totalBytes: 38_378_964_738_048,
      usedBytes: 26_724_878_606_336,
    });
    expect(nas.disks[0]).toMatchObject({
      device: "sda",
      model: "WD80EFAX-68KNBN0",
      hours: null,
    });
    expect(nas.seen).toEqual({});
  });

  it("système : mémoire, DSM et ses mises à jour, paquets, réseau", () => {
    expect(nas.ramMb).toBeTypeOf("number");
    expect(nas.dsmUpdate).toEqual({
      current: "DSM 7.4.1-90080 Update 1",
      checkOk: true,
      available: null,
      major: null,
      auto: "Correctifs de sécurité installés seuls",
    });
    expect(nas.packages).toHaveLength(13);
    expect(nas.packages?.every((p) => p.running)).toBe(true);
    expect(nas.network).toMatchObject({
      gateway: "192.0.2.1",
      dns: ["192.0.2.1"],
    });
    expect(nas.network?.interfaces.map((i) => i.name)).toEqual([
      "eth0",
      "eth1",
      "pppoe",
    ]);
  });

  it("une lecture du système qui manque reste absente", () => {
    const reads = allReads();
    reads["packages.list"] = { ok: false, reason: { en: "403", fr: "403" } };
    reads["network.overview"] = { ok: false, reason: { en: "403", fr: "403" } };
    const partial = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(partial.packages).toBeNull();
    expect(partial.network).toBeNull();
  });

  it("le décalage mesuré par l'agent l'emporte sur le libellé (heure d'été)", () => {
    const reads = allReads();
    const time = reads["system.time"] as unknown as {
      data: Record<string, unknown>;
    };
    reads["system.time"] = {
      ...(reads["system.time"] as object),
      data: { ...time.data, utc_offset_minutes: 120 },
    } as AgentReads["system.time"];
    const summer = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(summer.tzOffsetMin).toBe(120);
    expect(summer.tasks[0].lastSuccessAt).toBe("2026-11-06T14:08:41.000Z");
  });

  it("un agent muet : lien « down », sans lecture connue", () => {
    const silent = Object.fromEntries(
      (Object.keys(READ_PATHS) as ReadKey[]).map((k) => [
        k,
        {
          ok: false,
          reason: {
            en: "agent unreachable (timed out)",
            fr: "agent injoignable (délai dépassé)",
          },
        },
      ]),
    ) as AgentReads;
    expect(mapNas(AGENT, silent, NOW, "Europe/Paris", "fr").agent).toEqual({
      kind: "down",
      reason: "agent injoignable (délai dépassé)",
      lastReadAt: null,
    });
  });

  it("un droit manquant sur une lecture ne rend pas l'agent refusé", () => {
    const reads = allReads();
    reads["users.list"] = {
      ok: false,
      status: 403,
      reason: { en: "403 : droit manquant", fr: "403 : droit manquant" },
    };
    expect(mapNas(AGENT, reads, NOW, "Europe/Paris", "fr").agent.kind).toBe(
      "ok",
    );
  });

  it("les heures d'un NAS s'affichent dans le fuseau de la console", () => {
    const far = mapNas(AGENT, allReads(), NOW, "Asia/Ho_Chi_Minh", "fr");
    expect(far.tasks[0]).toMatchObject({
      lastSuccess: "ven. 6 nov., 22:08",
      integrityLast: "aujourd'hui, 16:35",
      integrityNext: "dim. 15 nov., 10:00",
    });
  });

  it("la programmation garde l'heure du NAS, et le dit quand les fuseaux diffèrent", () => {
    const reads = allReads();
    const tasks = structuredClone(
      (reads["backup.hyperbackup.tasks"] as { data: unknown }).data,
    ) as { tasks: { schedule: unknown }[] };
    tasks.tasks[0].schedule = {
      enabled: true,
      hour: 3,
      minute: 0,
      week_days: [0, 1, 2, 3, 4, 5, 6],
      repeat_every_hours: null,
      next_run_at: "2026-11-10T03:00:00",
    };
    reads["backup.hyperbackup.tasks"] = {
      ...(reads["backup.hyperbackup.tasks"] as object),
      data: tasks,
    } as AgentReads["backup.hyperbackup.tasks"];
    expect(
      mapNas(AGENT, reads, NOW, "Europe/Paris", "fr").tasks[0].schedule,
    ).toBe("Chaque jour à 3:00");
    const far = mapNas(AGENT, reads, NOW, "Asia/Ho_Chi_Minh", "fr").tasks[0];
    expect(far.schedule).toBe("Chaque jour à 3:00 (heure du NAS)");
    expect(far.nextRun).toBe("demain, 9:00");
  });
});

describe("mapNas et l'historique de l'agent", () => {
  it("DSM muet, historique qui répond : l'agent reste injoignable", () => {
    // L'historique ne passe pas par DSM : il ne prouve pas que l'agent lit son NAS.
    const reads = Object.fromEntries(
      (Object.keys(READ_PATHS) as ReadKey[]).map((k) => [
        k,
        k === "metrics.history"
          ? fixture(k)
          : {
              ok: false,
              status: 503,
              reason: { en: "503: dsm error", fr: "503 : DSM ne répond pas." },
            },
      ]),
    ) as AgentReads;
    const nas = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(nas.agent).toMatchObject({
      kind: "down",
      reason: "503 : DSM ne répond pas.",
    });
    expect(nas.agentHistory).toBe(false);
  });

  it("agent d'avant l'historique : valeur instantanée, pas d'historique", () => {
    const reads = allReads();
    reads["metrics.history"] = {
      ok: false,
      status: 404,
      reason: {
        en: "404 : Opération inconnue : metrics.history",
        fr: "404 : Opération inconnue : metrics.history",
      },
    };
    const nas = mapNas(AGENT, reads, NOW, "Europe/Paris", "fr");
    expect(nas.agentHistory).toBe(false);
    expect(nas.vitals).toMatchObject({ cpu: 9, netBps: null, source: "agent" });
    expect(nas.agent.kind).toBe("ok");
  });

  it("relevé arrêté depuis longtemps : la lecture instantanée, l'historique reste", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    const nas = mapNas(AGENT, allReads(), later, "Europe/Paris", "fr");
    expect(nas.agentHistory).toBe(true);
    expect(nas.vitals).toMatchObject({ cpu: 9, ram: 24, netBps: null });
  });

  it("relevé désactivé sur l'agent : pas d'historique", () => {
    const reads = allReads();
    reads["metrics.history"] = {
      ok: true,
      fetchedAt: "2026-11-09T15:26:47Z",
      data: { sampling: { enabled: false }, series: [] },
    };
    expect(mapNas(AGENT, reads, NOW, "Europe/Paris", "fr").agentHistory).toBe(
      false,
    );
  });
});

describe("offlineNas", () => {
  it("rend un NAS injoignable sans valeur inventée", () => {
    const nas = offlineNas(AGENT, "délai dépassé", "down", "fr");
    expect(nas).toMatchObject({
      reachable: false,
      live: true,
      readAt: null,
      model: "–",
    });
    expect(nas.checks.every((c) => c.status === "unknown")).toBe(true);
    expect(nas.volumes).toEqual([]);
  });
});

describe("nom de l'agent du projet", () => {
  it("prend le nom que DSM donne au NAS", () => {
    const reads = allReads();
    const net = reads["network.overview"];
    if (!net?.ok) throw new Error("lecture réseau attendue");
    const named = {
      ...reads,
      "network.overview": { ...net, data: { ...net.data, hostname: "Bureau" } },
    } as AgentReads;
    expect(
      mapNas({ ...AGENT, autoName: true }, named, NOW, "Europe/Paris", "fr")
        .name,
    ).toBe("Bureau");
    expect(mapNas(AGENT, named, NOW, "Europe/Paris", "fr").name).toBe(
      "NAS d'essai",
    );
  });
});

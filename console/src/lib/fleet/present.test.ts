import { describe, expect, test } from "vitest";
import { makeCheck, makeNas, makeTask, makeVolume } from "@/test/nas";
import {
  backupLogNote,
  formatMonthDay,
  formatPowerOn,
  formatSince,
  lastBackup,
  noCurvesReason,
  onlineSummary,
  seriesSummary,
  volumeName,
  volumeTone,
  withFillDates,
} from "./present";

const NOW = new Date("2026-11-21T10:00:00Z");
const TZ = "Europe/Paris";

describe("depuis quand", () => {
  test("le jour même : l'heure", () => {
    expect(
      formatSince(
        { label: "depuis", at: "2026-11-21T10:34:00Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("depuis 11:34");
    expect(
      formatSince(
        { label: "vu le", at: "2026-11-21T07:00:00Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("vu à 8:00");
  });
  test("la veille", () => {
    expect(
      formatSince(
        { label: "depuis", at: "2026-11-20T10:34:00Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("depuis hier");
    expect(
      formatSince(
        { label: "vu le", at: "2026-11-20T10:34:00Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("vu hier");
  });
  test("au-delà : le jour", () => {
    expect(
      formatSince(
        { label: "depuis", at: "2026-11-08T15:57:38Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("depuis le 8 nov.");
    expect(
      formatSince(
        { label: "vu le", at: "2026-11-09T10:00:00Z" },
        NOW,
        TZ,
        "fr",
      ),
    ).toBe("vu le 9 nov.");
  });
  test("rien de connu : rien", () =>
    expect(formatSince(null, NOW, TZ, "fr")).toBe(""));
});

describe("dernière sauvegarde", () => {
  test("la tâche lancée le plus récemment, et son résultat", () => {
    const nas = makeNas({
      tasks: [
        makeTask({
          name: "a",
          lastRunAt: "2026-11-21T02:00:00Z",
          lastSuccessAt: "2026-11-21T02:07:00Z",
        }),
        makeTask({
          name: "b",
          lastRunAt: "2026-11-21T03:00:00Z",
          result: { status: "failed", text: "x" },
          lastSuccessAt: "2026-11-19T03:07:00Z",
        }),
      ],
    });
    expect(lastBackup(nas, NOW, TZ, "fr")).toEqual({
      status: "failed",
      text: "aujourd'hui, 4:00",
      task: "b",
    });
  });
  test("sans tâche, sans agent, agent muet", () => {
    expect(lastBackup(makeNas(), NOW, TZ, "fr")).toEqual({
      status: "unknown",
      text: "Aucune tâche",
      task: null,
    });
    expect(
      lastBackup(makeNas({ agent: { kind: "none" } }), NOW, TZ, "fr"),
    ).toEqual({
      status: "unknown",
      text: "Sans agent",
      task: null,
    });
    expect(
      lastBackup(
        makeNas({ agent: { kind: "down", reason: "x", lastReadAt: null } }),
        NOW,
        TZ,
        "fr",
      ),
    ).toEqual({ status: "unknown", text: "–", task: null });
  });
});

describe("teinte d'un volume", () => {
  test("celle du contrôle de remplissage qui le nomme", () => {
    const nas = makeNas({
      checks: [
        makeCheck({
          id: "storage.volume_usage",
          status: "warning",
          items: ["/volume1 : 91 %"],
        }),
      ],
    });
    expect(volumeTone(nas, makeVolume({ path: "/volume1" }))).toBe("warn");
    expect(volumeTone(nas, makeVolume({ path: "/volume2" }))).toBe("ok");
  });
});

test("jour et mois en toutes lettres", () => {
  expect(formatMonthDay("2026-12-28T12:00:00Z", NOW, TZ, "fr")).toBe(
    "28 décembre",
  );
  expect(formatMonthDay("2027-02-03T12:00:00Z", NOW, TZ, "fr")).toBe(
    "3 février 2027",
  );
});

describe("résumé d'une courbe", () => {
  test("moyenne, pic et son heure dans le fuseau", () => {
    const s = seriesSummary(
      [
        { t: "2026-11-21T01:00:00Z", v: 2 },
        { t: "2026-11-21T02:00:00Z", v: null },
        { t: "2026-11-21T03:00:00Z", v: 10 },
        { t: "2026-11-21T04:00:00Z", v: 3 },
      ],
      NOW,
      TZ,
      "fr",
    );
    expect(s).toEqual({ avg: 5, max: 10, maxAt: "4:00" });
  });
  test("le pic est le plus haut relevé quand la source le donne", () => {
    const s = seriesSummary(
      [
        { t: "2026-11-21T01:00:00Z", v: 4, max: 70 },
        { t: "2026-11-21T03:00:00Z", v: 10, max: 12 },
      ],
      NOW,
      TZ,
      "fr",
    );
    expect(s).toEqual({ avg: 7, max: 70, maxAt: "2:00" });
  });
  test("aucune valeur : rien", () =>
    expect(seriesSummary([], NOW, TZ, "fr")).toBeNull());
});

test("nom d'un volume", () => {
  expect(volumeName("/volume1")).toBe("Volume 1");
  expect(volumeName("/volumeUSB1/usbshare")).toBe("/volumeUSB1/usbshare");
});

test("heures de marche d'un disque", () => {
  expect(formatPowerOn(46880, "fr")).toBe(
    "46\u202f880 h de marche (5 ans 4 mois)",
  );
  expect(formatPowerOn(500, "fr")).toBe("500 h de marche (20 jours)");
  expect(formatPowerOn(null, "fr")).toBe("");
});

describe("raison de l'absence de courbes", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const up = {
    kind: "ok",
    systemId: "a1",
    lastAt: "2026-11-21T09:59:00Z",
  } as const;

  test("Beszel lu mais sans relevé : aucun relevé sur la période", () => {
    expect(
      noCurvesReason(makeNas({ beszel: up }), now, "Europe/Paris", "fr"),
    ).toBe("aucun relevé sur la période");
  });

  test("lecture des courbes ratée : sa raison", () => {
    expect(
      noCurvesReason(makeNas({ beszel: up }), now, "Europe/Paris", "fr", {
        en: "Beszel unreachable (timed out)",
        fr: "Beszel injoignable (délai dépassé)",
      }),
    ).toBe("Beszel injoignable (délai dépassé)");
  });

  test("agent sans historique et Beszel pas branché", () => {
    expect(
      noCurvesReason(
        makeNas({ beszel: { kind: "none" } }),
        now,
        "Europe/Paris",
        "fr",
      ),
    ).toBe(
      "l'agent de ce NAS ne tient pas encore d'historique et Beszel n'est pas branché pour ce NAS",
    );
    expect(
      noCurvesReason(
        makeNas({
          beszel: { kind: "none" },
          agent: { kind: "down", reason: "x", lastReadAt: null },
        }),
        now,
        "Europe/Paris",
        "fr",
      ),
    ).toBe("Beszel n'est pas branché pour ce NAS");
  });

  test("historique de l'agent : sa raison, jamais celle de Beszel", () => {
    const nas = makeNas({ agentHistory: true, beszel: { kind: "none" } });
    expect(noCurvesReason(nas, now, "Europe/Paris", "fr")).toBe(
      "aucun relevé de l'agent sur la période",
    );
    expect(
      noCurvesReason(nas, now, "Europe/Paris", "fr", {
        en: "history unreadable",
        fr: "historique illisible",
      }),
    ).toBe("historique illisible");
  });
});

describe("journal de Hyper Backup", () => {
  test("lu mais vide, ou non lu : on le dit tel quel", () => {
    expect(backupLogNote(makeNas({ backupLogRead: true }), "fr")).toBe(
      "Journal de Hyper Backup vide : jours inconnus.",
    );
    expect(backupLogNote(makeNas({ backupLogRead: false }), "fr")).toBe(
      "Journal de Hyper Backup non lu : jours inconnus.",
    );
    expect(
      backupLogNote(
        makeNas({
          backupLogRead: true,
          backupLogFrom: "2026-11-06T15:08:19.000Z",
        }),
        "fr",
      ),
    ).toBeNull();
  });
});

describe("NAS en ligne", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const off = (name: string) => ({
    nas: makeNas({ id: name, name }),
    level: "offline" as const,
    title: "Le NAS ne répond plus",
    todo: "",
    since: null,
    checkId: null,
  });

  test("un seul NAS muet : son nom, au singulier", () => {
    expect(onlineSummary([off("Cave")], 3, now, "Europe/Paris", "fr")).toEqual({
      sub: "Cave ne répond plus",
      stateLabel: "Un NAS ne répond plus",
    });
  });

  test("plusieurs NAS muets : au pluriel, partout", () => {
    expect(
      onlineSummary(
        [off("Cave"), off("Atelier")],
        9,
        now,
        "Europe/Paris",
        "fr",
      ),
    ).toEqual({
      sub: "2 NAS ne répondent plus",
      stateLabel: "2 NAS ne répondent plus",
    });
  });

  test("tous répondent", () => {
    expect(onlineSummary([], 1, now, "Europe/Paris", "fr")).toEqual({
      sub: "Il répond",
      stateLabel: "Tous en ligne",
    });
  });
});

describe("date de remplissage dans le point à traiter", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  const issue = (nasId: string, checkId: string) => ({
    nas: makeNas({ id: nasId }),
    level: "warning" as const,
    title: "Remplissage des volumes",
    todo: "Libérer de la place ou agrandir le volume.",
    since: null,
    checkId,
  });

  test("le contrôle de remplissage gagne la date, les autres points restent", () => {
    const out = withFillDates(
      [issue("a", "storage.volume_usage"), issue("a", "access.firewall")],
      new Map([["a", "2027-01-02T00:00:00.000Z"]]),
      now,
      "Europe/Paris",
      "fr",
    );
    expect(out[0].todo).toBe(
      "Libérer de la place ou agrandir le volume. Au rythme des 30 derniers jours, plein vers le 2 janvier 2027.",
    );
    expect(out[1].todo).toBe("Libérer de la place ou agrandir le volume.");
  });
});

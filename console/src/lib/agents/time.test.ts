import { describe, expect, test } from "vitest";
import {
  consoleTimeZone,
  formatAgo,
  formatClock,
  formatDate,
  formatDateTime,
  formatDay,
  formatDayTitle,
  formatInt,
  instantFromBeszel,
  instantFromNasLocal,
  nasLocalDay,
  tzOffsetMinutes,
  uptime,
} from "./time";

const NOW = new Date("2026-11-21T10:00:00Z");

describe("instants", () => {
  test("une heure locale du NAS devient un instant UTC", () =>
    expect(instantFromNasLocal("2026-11-08T16:57:38", 60)).toBe(
      "2026-11-08T15:57:38.000Z",
    ));
  test("une heure déjà située garde son instant", () =>
    expect(instantFromNasLocal("2026-11-08T06:39:00Z", 420)).toBe(
      "2026-11-08T06:39:00.000Z",
    ));
  test("une heure absente ou illisible reste absente", () => {
    expect(instantFromNasLocal(null, 60)).toBeNull();
    expect(instantFromNasLocal("?", 60)).toBeNull();
  });
  test("une heure de Beszel devient un instant ISO", () =>
    expect(instantFromBeszel("2026-11-21 05:59:48.377Z")).toBe(
      "2026-11-21T05:59:48.377Z",
    ));
  test("jour du NAS", () =>
    expect(nasLocalDay("2026-11-20T20:00:00Z", 420)).toBe("2026-11-21"));
});

describe("formats dans le fuseau de la console", () => {
  test("dates à Paris et à Hô Chi Minh-Ville", () => {
    expect(
      formatDateTime("2026-11-21T05:59:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("aujourd'hui, 6:59");
    expect(
      formatDateTime("2026-11-20T15:57:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("hier, 16:57");
    expect(
      formatDateTime("2026-11-18T15:57:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("mer. 18 nov., 16:57");
    expect(
      formatDateTime("2026-11-20T20:00:00Z", NOW, "Asia/Ho_Chi_Minh", "fr"),
    ).toBe("aujourd'hui, 3:00");
  });
  test("heure seule, sans zéro devant l'heure", () =>
    expect(formatClock("2026-11-21T05:09:00Z", "Europe/Paris", "fr")).toBe(
      "6:09",
    ));
  test("minuit s'écrit 0:00", () =>
    expect(formatClock("2026-11-20T23:00:00Z", "Europe/Paris", "fr")).toBe(
      "0:00",
    ));
  test("date seule", () => {
    expect(formatDate("2026-11-21T05:59:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "aujourd'hui",
    );
    expect(formatDate("2026-11-20T05:59:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "hier",
    );
    expect(formatDate("2026-11-18T05:59:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "mer. 18 nov.",
    );
  });
  test("un jour du calendrier du NAS", () => {
    expect(formatDay("2026-11-18", "fr")).toBe("mer. 18 nov.");
    expect(formatDay("?", "fr")).toBe("–");
  });
  test("titre d'un jour", () => {
    expect(
      formatDayTitle("2026-11-21T05:59:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("Aujourd'hui");
    expect(
      formatDayTitle("2026-11-20T05:59:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("Hier");
    expect(
      formatDayTitle("2026-11-06T05:59:00Z", NOW, "Europe/Paris", "fr"),
    ).toBe("Vendredi 6 novembre");
  });
  test("une valeur absente s'écrit « – »", () => {
    expect(formatDateTime("", NOW, "Europe/Paris", "fr")).toBe("–");
    expect(formatClock("?", "Europe/Paris", "fr")).toBe("–");
  });
  test("il y a", () => {
    expect(formatAgo("2026-11-21T09:59:48Z", NOW, "Europe/Paris", "fr")).toBe(
      "il y a 12 s",
    );
    expect(formatAgo("2026-11-21T09:57:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "il y a 3 min",
    );
    expect(formatAgo("2026-11-21T08:00:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "il y a 2 h",
    );
    expect(formatAgo("2026-11-19T15:57:00Z", NOW, "Europe/Paris", "fr")).toBe(
      "jeu. 19 nov., 16:57",
    );
  });
  test("décalage d'un fuseau à un instant", () => {
    expect(tzOffsetMinutes("Europe/Paris", NOW)).toBe(60);
    expect(
      tzOffsetMinutes("Europe/Paris", new Date("2026-07-01T10:00:00Z")),
    ).toBe(120);
    expect(tzOffsetMinutes("Asia/Ho_Chi_Minh", NOW)).toBe(420);
  });
});

describe("réglages", () => {
  test("fuseau invalide : Europe/Paris", () =>
    expect(consoleTimeZone({ NAS_CONSOLE_TZ: "Mars/Olympus" })).toBe(
      "Europe/Paris",
    ));
  test("fuseau absent : Europe/Paris", () =>
    expect(consoleTimeZone({})).toBe("Europe/Paris"));
  test("fuseau valide : gardé", () =>
    expect(consoleTimeZone({ NAS_CONSOLE_TZ: "Asia/Ho_Chi_Minh" })).toBe(
      "Asia/Ho_Chi_Minh",
    ));
  test("milliers à la française", () =>
    expect(formatInt(46860, "fr")).toBe("46\u202f860"));
});

describe("in English", () => {
  test("dates, times and days", () => {
    expect(
      formatDateTime("2026-11-21T05:59:00Z", NOW, "Europe/Paris", "en"),
    ).toBe("today, 6:59 AM");
    expect(
      formatDateTime("2026-11-18T15:57:00Z", NOW, "Europe/Paris", "en"),
    ).toBe("Wed, Nov 18, 4:57 PM");
    expect(formatClock("2026-11-20T23:00:00Z", "Europe/Paris", "en")).toBe(
      "12:00 AM",
    );
    expect(formatDay("2026-11-18", "en")).toBe("Wed, Nov 18");
    expect(
      formatDayTitle("2026-11-06T05:59:00Z", NOW, "Europe/Paris", "en"),
    ).toBe("Friday, November 6");
    expect(formatAgo("2026-11-21T09:57:00Z", NOW, "Europe/Paris", "en")).toBe(
      "3 min ago",
    );
    expect(formatInt(46860, "en")).toBe("46,860");
  });
});

describe("durée d'allumage", () => {
  test("en heures et minutes, dans chaque langue", () => {
    expect(uptime(12 * 3600 + 14 * 60, "fr")).toBe("12 h 14");
    expect(uptime(12 * 3600 + 14 * 60, "en")).toBe("12 h 14 min");
    expect(uptime(3 * 86_400 + 5 * 3600, "en")).toBe("3 d 5 h");
  });
});

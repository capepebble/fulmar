import { describe, expect, test } from "vitest";
import { fillForecast } from "./forecast";

const DAY = 86_400_000;
const NOW = new Date("2026-11-21T10:00:00Z");
const TOTAL = 10_000_000_000_000;

/** Un relevé par jour, de `days` jours avant `NOW` jusqu'à `NOW`. */
function daily(days: number, pctAt: (daysAgo: number) => number) {
  return Array.from({ length: days + 1 }, (_, i) => {
    const ago = days - i;
    return {
      t: new Date(NOW.getTime() - ago * DAY).toISOString(),
      usedBytes: (pctAt(ago) / 100) * TOTAL,
    };
  });
}

describe("date de remplissage", () => {
  test("régression linéaire : plein vers la date calculée", () => {
    const f = fillForecast(
      daily(29, (ago) => 91 - ago),
      TOTAL,
      NOW,
    );
    expect(f.kind).toBe("date");
    const at = f.kind === "date" ? Date.parse(f.at) : 0;
    expect(Math.abs(at - (NOW.getTime() + 9 * DAY))).toBeLessThan(60_000);
  });

  test("seuls les 30 derniers jours comptent", () => {
    // Un an plat, puis 30 jours de +1 % par jour.
    const points = [
      ...daily(365, () => 10).slice(0, 335),
      ...daily(29, (ago) => 91 - ago),
    ];
    const f = fillForecast(points, TOTAL, NOW);
    expect(f.kind).toBe("date");
  });

  test("moins de 7 jours d'historique : unknown", () =>
    expect(
      fillForecast(
        daily(6, (ago) => 90 - ago),
        TOTAL,
        NOW,
      ),
    ).toEqual({ kind: "unknown" }));

  test("aucun relevé : unknown", () =>
    expect(fillForecast([], TOTAL, NOW)).toEqual({ kind: "unknown" }));

  test("pente nulle ou négative : stable", () => {
    expect(
      fillForecast(
        daily(29, () => 50),
        TOTAL,
        NOW,
      ),
    ).toEqual({ kind: "stable" });
    expect(
      fillForecast(
        daily(29, (ago) => 40 + ago * 0.2),
        TOTAL,
        NOW,
      ),
    ).toEqual({ kind: "stable" });
  });

  test("plein au-delà d'un an : stable", () =>
    // +0,1 % par jour à 50 % : plein dans 500 jours.
    expect(
      fillForecast(
        daily(29, (ago) => 50 - ago * 0.1),
        TOTAL,
        NOW,
      ),
    ).toEqual({ kind: "stable" }));

  test("déjà plein : aujourd'hui", () => {
    const f = fillForecast(
      daily(29, (ago) => 101 - ago * 0.5),
      TOTAL,
      NOW,
    );
    expect(f).toEqual({ kind: "date", at: NOW.toISOString() });
  });
});

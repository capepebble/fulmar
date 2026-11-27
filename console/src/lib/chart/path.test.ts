import { describe, expect, test } from "vitest";
import type { Point } from "@/lib/fleet/series";
import { areaPath, linePath } from "./path";

const box = { w: 100, h: 20 };
const dom = { min: 0, max: 100 };
const at = (min: number) =>
  new Date(Date.UTC(2026, 10, 21, 10, min)).toISOString();
const pts = (values: (number | null)[]): Point[] =>
  values.map((v, i) => ({ t: at(i * 10), v }));

describe("tracés", () => {
  test("un null coupe le tracé : deux segments M", () =>
    expect(
      linePath(pts([10, 20, null, 30, 40]), box, dom).match(/M/g),
    ).toHaveLength(2));

  test("sans null : un seul M, en tête", () => {
    const d = linePath(pts([0, 50, 100]), box, dom);
    expect(d.startsWith("M")).toBe(true);
    expect(d.match(/M/g)).toHaveLength(1);
    // 0 en bas, 100 en haut, le temps de gauche à droite.
    expect(d).toBe("M0 20L50 10L100 0");
  });

  test("une fenêtre de temps fixe place les points dans la période", () =>
    expect(
      linePath(pts([50]), box, dom, {
        from: Date.parse(at(-10)),
        to: Date.parse(at(10)),
      }),
    ).toBe("M50 10l0.01 0"));

  test("aucune valeur : aucun tracé", () => {
    expect(linePath(pts([null, null]), box, dom)).toBe("");
    expect(linePath([], box, dom)).toBe("");
  });

  test("les valeurs hors domaine restent dans le cadre", () =>
    expect(linePath(pts([-10, 150]), box, dom)).toBe("M0 20L100 0"));

  test("l'aire se ferme sur le bas, segment par segment", () => {
    const d = areaPath(pts([0, 100, null, 50, 50]), box, dom);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.match(/Z/g)).toHaveLength(2);
    expect(d.startsWith("M0 20L25 0L25 20L0 20Z")).toBe(true);
  });
});

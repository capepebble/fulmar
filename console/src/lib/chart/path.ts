// Tracés SVG des courbes : le temps de gauche à droite, la valeur de bas en haut. Un trou
// (`null`) coupe le tracé : jamais de trait tiré par-dessus un NAS éteint ou un Beszel muet.

import type { Point } from "@/lib/fleet/series";

export interface Box {
  w: number;
  h: number;
}

export interface Domain {
  min: number;
  max: number;
}

/** Fenêtre de temps, en millisecondes ; par défaut, celle des points. */
export interface Span {
  from: number;
  to: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Segments continus de points, en coordonnées du cadre. */
function segments(
  points: Point[],
  box: Box,
  domain: Domain,
  span?: Span,
): [number, number][][] {
  const times = points.map((p) => Date.parse(p.t));
  const from = span?.from ?? Math.min(...times);
  const to = span?.to ?? Math.max(...times);
  const width = to - from;
  const range = domain.max - domain.min || 1;
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  points.forEach((p, i) => {
    if (p.v == null || !Number.isFinite(p.v)) {
      if (current.length) out.push(current);
      current = [];
      return;
    }
    const x = width > 0 ? ((times[i] - from) / width) * box.w : 0;
    const share = Math.min(1, Math.max(0, (p.v - domain.min) / range));
    current.push([
      round(Math.min(box.w, Math.max(0, x))),
      round(box.h - share * box.h),
    ]);
  });
  if (current.length) out.push(current);
  return out;
}

export function linePath(
  points: Point[],
  box: Box,
  domain: Domain,
  span?: Span,
): string {
  return segments(points, box, domain, span)
    .map((seg) =>
      seg.length === 1
        ? `M${seg[0][0]} ${seg[0][1]}l0.01 0`
        : seg.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(""),
    )
    .join("");
}

/** L'aire sous la courbe, fermée sur le bas du cadre, segment par segment. */
export function areaPath(
  points: Point[],
  box: Box,
  domain: Domain,
  span?: Span,
): string {
  return segments(points, box, domain, span)
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const line = seg.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
      const last = seg[seg.length - 1][0];
      return `${line}L${last} ${box.h}L${seg[0][0]} ${box.h}Z`;
    })
    .join("");
}

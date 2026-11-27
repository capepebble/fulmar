// Courbes, quelle que soit leur source (historique de l'agent, Beszel, démonstration) :
// périodes, points et coupure des trous.

/** Périodes des courbes et palier qui les sert. Les paliers portent les mêmes noms chez
 * l'agent (`metrics.history`) et chez Beszel. */
export const PERIODS = {
  "1h": { tier: "1m", ms: 3_600_000, stepMin: 1 },
  "24h": { tier: "20m", ms: 86_400_000, stepMin: 20 },
  "7d": { tier: "120m", ms: 604_800_000, stepMin: 120 },
  "30d": { tier: "480m", ms: 2_592_000_000, stepMin: 480 },
} as const satisfies Record<
  string,
  { tier: "1m" | "20m" | "120m" | "480m"; ms: number; stepMin: number }
>;

export type Period = keyof typeof PERIODS;

export interface Point {
  t: string;
  v: number | null;
  /** Plus haute valeur du palier, quand la source la donne (historique de l'agent). */
  max?: number | null;
}

export type Metric = "cpu" | "mem" | "temp" | "net";

export type NasCurves = Record<Metric, Point[]>;

export const METRICS: Metric[] = ["cpu", "mem", "temp", "net"];

/** Points dans l'ordre du temps ; un trou de plus de deux pas du palier coupe le trait
 * (`null`), jamais interpolé. */
export function withGaps(points: Point[], period: Period): Point[] {
  const stepMs = PERIODS[period].stepMin * 60_000;
  const out: Point[] = [];
  let prev: number | null = null;
  for (const p of [...points].sort((a, b) => a.t.localeCompare(b.t))) {
    const t = Date.parse(p.t);
    if (prev != null && t - prev > 2 * stepMs)
      out.push({ t: new Date(prev + stepMs).toISOString(), v: null });
    out.push(p);
    prev = t;
  }
  return out;
}

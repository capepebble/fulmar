// Date de remplissage d'un volume (conception, § 7.5) : régression linéaire (moindres carrés)
// sur les 30 derniers jours ; seulement avec au moins 7 jours d'historique et une pente
// positive. Au-delà d'un an, ou pente nulle ou négative : stable.

const DAY = 86_400_000;
const WINDOW = 30 * DAY;
const MIN_HISTORY = 7 * DAY;
const HORIZON = 365 * DAY;

export type FillForecast =
  | { kind: "date"; at: string }
  | { kind: "stable" }
  | { kind: "unknown" };

export function fillForecast(
  points: { t: string; usedBytes: number }[],
  totalBytes: number,
  now: Date,
): FillForecast {
  const from = now.getTime() - WINDOW;
  const recent = points
    .map((p) => ({ x: Date.parse(p.t), y: p.usedBytes }))
    .filter((p) => Number.isFinite(p.x) && p.x >= from && p.x <= now.getTime());
  if (recent.length < 2 || !(totalBytes > 0)) return { kind: "unknown" };
  const xs = recent.map((p) => p.x);
  if (Math.max(...xs) - Math.min(...xs) < MIN_HISTORY)
    return { kind: "unknown" };

  // Temps en jours depuis maintenant, pour garder des nombres raisonnables.
  const n = recent.length;
  const x = recent.map((p) => (p.x - now.getTime()) / DAY);
  const y = recent.map((p) => p.y);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  if (sxx === 0) return { kind: "unknown" };
  const slope = sxy / sxx; // octets par jour
  if (!(slope > 0)) return { kind: "stable" };
  const intercept = my - slope * mx; // remplissage estimé maintenant
  const days = (totalBytes - intercept) / slope;
  if (days * DAY > HORIZON) return { kind: "stable" };
  const at = Math.max(now.getTime(), now.getTime() + days * DAY);
  return { kind: "date", at: new Date(at).toISOString() };
}

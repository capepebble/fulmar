import { type Locale, tr } from "@/i18n";
import { areaPath, linePath, type Span } from "@/lib/chart/path";
import type { Point } from "@/lib/fleet/series";

/** Courbe miniature, rendue côté serveur, sans axe ; son étiquette résume minimum, maximum et
 * dernière valeur. Un trou reste un trou. */
export function Sparkline({
  lang,
  points,
  max,
  color,
  label,
  format,
  width = 72,
  height = 24,
  dim = false,
  fluid = false,
  span,
}: {
  lang: Locale;
  points: Point[];
  max: number;
  color: "c1" | "c2";
  /** Ce que montre la courbe : « Processeur sur 24 h ». */
  label: string;
  format: (v: number) => string;
  width?: number;
  height?: number;
  /** Courbe d'un NAS qui ne répond plus : estompée. */
  dim?: boolean;
  /** Toute la largeur de son conteneur (cartes de constantes). */
  fluid?: boolean;
  /** Fenêtre de temps de la courbe (24 h) : un trou à la fin reste un trou. */
  span?: Span;
}) {
  const values = points
    .map((p) => p.v)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const box = { w: width, h: height - 2 };
  const domain = { min: 0, max: Math.max(max, ...values, 1) };
  const last = [...points].reverse().find((p) => p.v != null)?.v ?? null;
  const lo = values.length ? format(Math.min(...values)) : "";
  const hi = values.length ? format(Math.max(...values)) : "";
  const end = last != null ? format(last) : null;
  const summary = values.length
    ? tr(lang, {
        en: `${label}: minimum ${lo}, maximum ${hi}, last value ${end ?? "unknown"}`,
        fr: `${label} : minimum ${lo}, maximum ${hi}, dernière valeur ${end ?? "inconnue"}`,
      })
    : tr(lang, { en: `${label}: no data`, fr: `${label} : aucune donnée` });
  return (
    <svg
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 -1 ${width} ${height}`}
      preserveAspectRatio={fluid ? "none" : undefined}
      role="img"
      aria-label={summary}
      className={fluid ? "block" : "flex-none"}
    >
      <title>{summary}</title>
      {values.length ? (
        <>
          <path
            d={areaPath(points, box, domain, span)}
            style={{
              fill: `var(--${color})`,
              fillOpacity: 0.1,
              stroke: "none",
            }}
          />
          <path
            d={linePath(points, box, domain, span)}
            style={{
              fill: "none",
              stroke: `var(--${color})`,
              strokeWidth: 1.5,
              strokeLinejoin: "round",
              strokeLinecap: "round",
              opacity: dim ? 0.45 : 1,
              vectorEffect: "non-scaling-stroke",
            }}
          />
        </>
      ) : (
        <line
          x1={0}
          x2={width}
          y1={box.h}
          y2={box.h}
          stroke="var(--border-2)"
          strokeDasharray="2 3"
        />
      )}
    </svg>
  );
}

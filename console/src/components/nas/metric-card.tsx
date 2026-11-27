import { type Locale, tr } from "@/i18n";
import type { Point } from "@/lib/fleet/series";
import { Sparkline } from "../ui/sparkline";

/** Carte de constante (à la UniFi) : valeur du moment, ligne d'explication, courbe de 24 h. */
export function MetricCard({
  lang,
  label,
  value,
  sub,
  points,
  color,
  max,
  format,
  now,
}: {
  lang: Locale;
  label: string;
  value: string;
  sub: string;
  /** `null` : pas de courbe pour ce NAS. */
  points: Point[] | null;
  color: "c1" | "c2";
  max: number;
  format: (v: number) => string;
  /** Fin de la fenêtre de 24 h. */
  now: Date;
}) {
  return (
    <div className="card flex flex-col gap-1.5 px-[18px] pt-4 pb-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-[13px] text-fg-2">{label}</span>
        {points ? <span className="meta">24 h</span> : null}
      </div>
      <div className="num">{value}</div>
      <div className="meta text-fg-2">{sub}</div>
      {points ? (
        <div className="mt-1">
          <Sparkline
            lang={lang}
            points={points}
            max={max}
            color={color}
            label={tr(lang, {
              en: `${label} over 24 h`,
              fr: `${label} sur 24 h`,
            })}
            format={format}
            span={{ from: now.getTime() - 86_400_000, to: now.getTime() }}
            width={240}
            height={44}
            fluid
          />
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useId, useMemo, useRef, useState } from "react";
import type { Locale } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { INTL_TAG } from "@/i18n/locales";
import { areaPath, linePath } from "@/lib/chart/path";
import { PERIODS, type Period, type Point } from "@/lib/fleet/series";

export interface ChartSeries {
  label: string;
  color: "c1" | "c2";
  points: Point[];
}

const W = 1000;
const H = 200;
const TICKS = 6;

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(
  tz: string,
  opts: Intl.DateTimeFormatOptions,
  lang: Locale,
): Intl.DateTimeFormat {
  const key = `${lang}|${tz}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[lang], {
      timeZone: tz,
      hourCycle: lang === "en" ? "h12" : "h23",
      ...opts,
    });
    formats.set(key, f);
  }
  return f;
}

/** Étiquette d'un instant sur l'axe du temps, selon la période. */
function tickLabel(
  t: number,
  period: Period,
  tz: string,
  lang: Locale,
): string {
  if (period === "1h" || period === "24h")
    return fmt(tz, { hour: "numeric", minute: "2-digit" }, lang).format(t);
  return fmt(tz, { weekday: "short", day: "numeric" }, lang).format(t);
}

/** Lecture au survol : jour et heure complets. */
function pointLabel(t: number, tz: string, lang: Locale): string {
  return fmt(
    tz,
    {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    },
    lang,
  ).format(t);
}

/** Graphique principal : pourcentages de 0 à 100, axe du temps, lecture des valeurs au
 * survol et au toucher. Un trou reste un trou. */
export function TimeChart({
  series,
  period,
  tz,
  now,
  unit = "%",
  label,
}: {
  series: ChartSeries[];
  period: Period;
  tz: string;
  /** Instant de fin du graphique (ISO), fixé par le serveur. */
  now: string;
  unit?: string;
  /** Résumé pour les lecteurs d'écran. */
  label: string;
}) {
  const id = useId();
  const lang = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const to = Date.parse(now);
  const from = to - PERIODS[period].ms;
  const span = { from, to };
  const dims = { w: W, h: H };
  const domain = { min: 0, max: 100 };

  const ticks = useMemo(
    () =>
      Array.from(
        { length: TICKS + 1 },
        (_, i) => from + ((to - from) * i) / TICKS,
      ),
    [from, to],
  );

  const reading = useMemo(() => {
    if (hover == null) return null;
    const step = PERIODS[period].stepMin * 60_000;
    const values = series.map((s) => {
      let best: Point | null = null;
      let gap = Number.POSITIVE_INFINITY;
      for (const p of s.points) {
        const d = Math.abs(Date.parse(p.t) - hover);
        if (d < gap) {
          gap = d;
          best = p;
        }
      }
      return { s, v: best && gap <= step ? best.v : null };
    });
    return { t: hover, values };
  }, [hover, series, period]);

  function onMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    setHover(from + ratio * (to - from));
  }

  const x = hover == null ? 0 : ((hover - from) / (to - from)) * 100;
  return (
    <div className="flex gap-2.5 py-[18px] pr-[18px] pl-3">
      <div
        className="flex h-[200px] w-[38px] flex-none flex-col justify-between text-right text-[11.5px] text-fg-3"
        aria-hidden="true"
      >
        {[100, 75, 50, 25, 0].map((v) => (
          <span key={v}>
            {v}
            {" "}
            {unit}
          </span>
        ))}
      </div>
      <div className="flex min-w-0 grow flex-col gap-2">
        <div
          ref={box}
          className="relative touch-pan-y"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-[200px] w-full"
            role="img"
            aria-labelledby={`${id}-label`}
          >
            <title id={`${id}-label`}>{label}</title>
            <path
              d={[0.25, 0.5, 0.75].map((f) => `M0 ${H * f}H${W}`).join("")}
              style={{
                fill: "none",
                stroke: "var(--grid)",
                strokeWidth: 1,
                vectorEffect: "non-scaling-stroke",
              }}
            />
            {series.map((s) => (
              <g key={s.label}>
                <path
                  d={areaPath(s.points, dims, domain, span)}
                  style={{
                    fill: `var(--${s.color})`,
                    fillOpacity: s.color === "c1" ? 0.1 : 0.08,
                    stroke: "none",
                  }}
                />
                <path
                  d={linePath(s.points, dims, domain, span)}
                  style={{
                    fill: "none",
                    stroke: `var(--${s.color})`,
                    strokeWidth: 1.75,
                    strokeLinejoin: "round",
                    strokeLinecap: "round",
                    vectorEffect: "non-scaling-stroke",
                  }}
                />
              </g>
            ))}
          </svg>
          {reading ? (
            <>
              <span
                className="pointer-events-none absolute inset-y-0 w-px bg-border-2"
                style={{ left: `${x}%` }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute top-1 z-10 rounded-[8px] border border-border bg-surface px-2.5 py-1.5 text-[12.5px] shadow-pop"
                style={
                  x > 60
                    ? { right: `${100 - x}%`, marginRight: 8 }
                    : { left: `${x}%`, marginLeft: 8 }
                }
                aria-live="polite"
              >
                <div className="meta whitespace-nowrap">
                  {pointLabel(reading.t, tz, lang)}
                </div>
                {reading.values.map(({ s, v }) => (
                  <div
                    key={s.label}
                    className="flex items-center gap-2 whitespace-nowrap"
                  >
                    <span
                      className="h-0.5 w-2.5 rounded"
                      style={{ background: `var(--${s.color})` }}
                    />
                    <span className="text-fg-2">{s.label}</span>
                    <span className="ml-auto font-medium">
                      {v == null
                        ? "–"
                        : `${Math.round(v * 10) / 10}`.replace(".", ",")}
                      {v == null ? "" : ` ${unit}`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div
          className="flex justify-between text-[11.5px] text-fg-3"
          aria-hidden="true"
        >
          {ticks.map((t, i) => (
            <span key={t}>
              {i === TICKS
                ? lang === "en"
                  ? "Now"
                  : "Maintenant"
                : tickLabel(t, period, tz, lang)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

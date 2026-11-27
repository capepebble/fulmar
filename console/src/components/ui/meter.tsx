"use client";

import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { cn, formatPct } from "@/lib/format";

/** Une jauge à la manière de Beszel : la barre et son pourcentage ; jaune puis rouge aux seuils. */
export function Meter({
  value,
  label,
  warn = 80,
  crit = 90,
  className,
}: {
  value: number | null;
  label: string;
  warn?: number;
  crit?: number;
  className?: string;
}) {
  const lang = useLocale();
  if (value === null)
    return (
      <span className={cn("meta", className)}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">
          {tr(lang, { en: `${label}: unknown`, fr: `${label} : inconnu` })}
        </span>
      </span>
    );
  const pct = Math.max(0, Math.min(100, value));
  const fill =
    pct >= crit ? "fill-crit" : pct >= warn ? "fill-warn" : "fill-ok";
  return (
    <span
      className={cn("flex min-w-0 items-center gap-2", className)}
      role="img"
      aria-label={`${label}${lang === "fr" ? " :" : ":"} ${formatPct(pct, lang)}`}
      title={`${label}${lang === "fr" ? " :" : ":"} ${formatPct(pct, lang)}`}
    >
      <span className="bar min-w-8 flex-1">
        <span className={fill} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-9 flex-none text-right text-[12px] text-fg-2 tabular-nums">
        {formatPct(pct, lang)}
      </span>
    </span>
  );
}

"use client";

import { useLocale } from "@/i18n/client";
import { greenSentence } from "@/lib/fleet/lights";
import { cn } from "@/lib/format";

/** L'anneau : la part de vert sur ce qu'on suit. Plein et vert à 100 %. */
export function Ring({
  ok,
  total,
  size = 44,
  className,
}: {
  ok: number;
  total: number;
  size?: number;
  className?: string;
}) {
  const share = total === 0 ? 1 : ok / total;
  const stroke = size >= 80 ? 8 : 5;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  const full = share >= 1;
  const tone = full
    ? "var(--ok)"
    : share >= 0.75
      ? "var(--warn)"
      : "var(--crit)";
  const lang = useLocale();
  const label = greenSentence(ok, total, lang);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("relative inline-flex flex-none", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={stroke}
        />
        {total === 0 ? null : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${share * length} ${length}`}
          />
        )}
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center font-semibold tabular-nums",
          size >= 80 ? "text-[17px]" : "text-[10.5px]",
        )}
      >
        {total === 0 ? (
          <span className="text-fg-3">–</span>
        ) : (
          <>
            {Math.round(share * 100)}
            <span className={size >= 80 ? "text-[11px]" : "text-[7.5px]"}>
              %
            </span>
          </>
        )}
      </span>
    </span>
  );
}

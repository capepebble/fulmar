"use client";

import Link from "next/link";
import type { Texts } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { PERIODS, type Period } from "@/lib/fleet/series";

export const PERIOD_LABEL: Record<Period, Texts> = {
  "1h": { en: "1 h", fr: "1 h" },
  "24h": { en: "24 h", fr: "24 h" },
  "7d": { en: "7 d", fr: "7 j" },
  "30d": { en: "30 d", fr: "30 j" },
};

/** Sélecteur de période segmenté ; chaque période est une adresse (`?period=`), donnée par
 * la page serveur (une fonction ne passe pas du serveur au client). */
export function PeriodPicker({
  value,
  hrefs,
}: {
  value: Period;
  hrefs: Record<Period, string>;
}) {
  const lang = useLocale();
  return (
    <nav className="seg" aria-label={lang === "en" ? "Period" : "Période"}>
      {(Object.keys(PERIODS) as Period[]).map((p) => (
        <Link
          key={p}
          href={hrefs[p]}
          scroll={false}
          className="seg-b"
          aria-current={p === value ? "true" : undefined}
        >
          {PERIOD_LABEL[p][lang]}
        </Link>
      ))}
    </nav>
  );
}

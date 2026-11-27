"use client";

import { type Texts, tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { formatDay } from "@/lib/agents/time";
import type { StripCell, StripKind } from "@/lib/fleet/strip";

export const STRIP_LABEL: Record<StripKind, Texts> = {
  success: { en: "succeeded", fr: "réussie" },
  failure: { en: "failed", fr: "en échec" },
  partial: { en: "partial", fr: "partielle" },
  unknown: { en: "result unreadable", fr: "résultat illisible" },
  none: { en: "no run", fr: "aucune exécution" },
  before: { en: "before the log starts", fr: "avant le début du journal" },
};

// [singulier, pluriel] dans chaque langue.
const SUMMARY: [StripKind, Record<"en" | "fr", [string, string]>][] = [
  ["success", { en: ["succeeded", "succeeded"], fr: ["réussie", "réussies"] }],
  ["failure", { en: ["failed", "failed"], fr: ["en échec", "en échec"] }],
  ["partial", { en: ["partial", "partial"], fr: ["partielle", "partielles"] }],
  [
    "unknown",
    { en: ["unreadable", "unreadable"], fr: ["illisible", "illisibles"] },
  ],
  [
    "none",
    {
      en: ["without a run", "without a run"],
      fr: ["sans exécution", "sans exécution"],
    },
  ],
  [
    "before",
    {
      en: ["before the log", "before the log"],
      fr: ["avant le journal", "avant le journal"],
    },
  ],
];

/** Bande des 30 jours d'une sauvegarde : une case par jour du NAS, chacune titrée. */
export function BackupStrip({
  cells,
  label,
  mini = false,
}: {
  cells: StripCell[];
  label: string;
  /** En petit, dans la tuile Sauvegardes de la fiche en bref. */
  mini?: boolean;
}) {
  const lang = useLocale();
  const parts = SUMMARY.flatMap(([kind, words]) => {
    const n = cells.filter((c) => c.kind === kind).length;
    const [one, many] = words[lang];
    const single = lang === "en" ? n === 1 : n <= 1;
    return n ? [`${n} ${single ? one : many}`] : [];
  });
  return (
    <div
      className={mini ? "grid gap-[2px]" : "grid gap-[3px]"}
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={tr(lang, {
        en: `${label}, last ${cells.length} days: ${parts.join(", ")}`,
        fr: `${label}, ${cells.length} derniers jours : ${parts.join(", ")}`,
      })}
    >
      {cells.map((c) => (
        <span
          key={c.day}
          className={`day k-${c.kind}${mini ? " day-mini" : ""}`}
          title={tr(lang, {
            en: `${formatDay(c.day, lang)}: ${STRIP_LABEL[c.kind].en}`,
            fr: `${formatDay(c.day, lang)} : ${STRIP_LABEL[c.kind].fr}`,
          })}
        />
      ))}
    </div>
  );
}

"use client";

import { Printer } from "lucide-react";
import { useRouter } from "next/navigation";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";

const SELECT = "btn h-[30px] appearance-none pr-3 font-normal max-md:h-9";

/** Le mois, l'étendue, et « Imprimer ou enregistrer en PDF ». L'adresse garde le choix. */
export function ReportControls({
  months,
  scopes,
  month,
  scope,
}: {
  months: { value: string; label: string }[];
  scopes: { value: string; label: string }[];
  month: string;
  scope: string;
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const router = useRouter();
  const go = (m: string, s: string) =>
    router.push(`/reports?month=${m}&scope=${encodeURIComponent(s)}`);
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <select
        className={SELECT}
        value={month}
        onChange={(e) => go(e.target.value, scope)}
        aria-label={t("Month", "Mois")}
      >
        {months.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        className={SELECT}
        value={scope}
        onChange={(e) => go(month, e.target.value)}
        aria-label={t("Scope", "Étendue")}
      >
        {scopes.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn" onClick={() => window.print()}>
        <Printer className="size-3.5" aria-hidden="true" />
        {t("Print or save as PDF", "Imprimer ou enregistrer en PDF")}
      </button>
    </div>
  );
}

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ReportControls } from "@/components/fleet/report-controls";
import {
  ReportDocument,
  type ReportNas,
} from "@/components/fleet/report-document";
import { PageHeader } from "@/components/shell/page-header";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { monthsBack } from "@/lib/agents/report";
import { readReport } from "@/lib/agents/report-read";
import { consoleTimeZone } from "@/lib/agents/time";
import { getFleet } from "@/lib/fleet";
import { FOLDER_KIND_LABEL } from "@/lib/fleet/folders";

type Params = Promise<{ lang: string }>;
type Search = Promise<{ month?: string; scope?: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Reports", fr: "Bilans" }) };
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const lang = await pageLocale(params);
  return (
    <Suspense
      fallback={<div className="card h-[420px] animate-pulse" aria-hidden />}
    >
      <Reports lang={lang} searchParams={searchParams} />
    </Suspense>
  );
}

/** Le bilan du mois (conception 2026-11-26-bilan-du-mois) : d'un NAS, d'un groupe, du parc. */
async function Reports({
  lang,
  searchParams,
}: {
  lang: Locale;
  searchParams: Search;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  // Lu à la requête : le mois en cours et l'heure du bilan ne se figent pas au prérendu.
  await connection();
  const search = await searchParams;
  const now = new Date();
  const months = monthsBack(now, 12, lang);
  const month = months.some((m) => m.value === search.month)
    ? (search.month as string)
    : months[0].value;
  const monthLabel = months.find((m) => m.value === month)?.label ?? month;
  const fleet = (await getFleet(lang)).filter((n) => n.agent.kind !== "none");
  const folders = [
    ...new Map(
      fleet.flatMap((n) =>
        n.folder ? [[n.folder.id, n.folder] as const] : [],
      ),
    ).values(),
  ].sort((a, b) => a.rank - b.rank);
  const scopes = [
    { value: "all", label: t("The whole fleet", "Tout le parc") },
    ...folders.map((f) => ({
      value: `folder:${f.id}`,
      label: `${tr(lang, FOLDER_KIND_LABEL[f.kind])} ${f.name}`,
    })),
    ...fleet.map((n) => ({ value: `nas:${n.id}`, label: n.name })),
  ];
  const scope = scopes.some((s) => s.value === search.scope)
    ? (search.scope as string)
    : "all";
  const chosen = fleet.filter((n) =>
    scope === "all"
      ? true
      : scope.startsWith("folder:")
        ? n.folder?.id === scope.slice(7)
        : n.id === scope.slice(4),
  );
  const reports = await Promise.all(
    chosen.map((n) => readReport(n.id, n.live, month, lang)),
  );
  const nas: ReportNas[] = chosen.map((n, i) => {
    const got = reports[i];
    return {
      id: n.id,
      name: n.name,
      context: [
        n.model,
        n.dsm,
        n.folder?.name,
        n.live ? null : t("fictitious", "fictif"),
      ]
        .filter((x) => x && x !== "–")
        .join(" · "),
      report: got.ok ? got.value : null,
      reason: got.ok ? null : got.reason,
    };
  });
  return (
    <>
      <div className="print:hidden">
        <PageHeader
          lang={lang}
          title={t("Reports", "Bilans")}
          sentence={t(
            "One NAS, a group or the whole fleet, month by month: what happened, without opening DSM.",
            "Un NAS, un groupe ou tout le parc, mois par mois : ce qui s'est passé, sans ouvrir DSM.",
          )}
        />
      </div>
      <ReportControls
        months={months}
        scopes={scopes}
        month={month}
        scope={scope}
      />
      {nas.length ? (
        <ReportDocument
          lang={lang}
          tz={consoleTimeZone()}
          monthLabel={monthLabel}
          scopeLabel={scopes.find((s) => s.value === scope)?.label ?? ""}
          nas={nas}
          generatedAt={now}
        />
      ) : (
        <p className="m-0 text-fg-2">
          {t("No NAS with an agent here.", "Aucun NAS avec un agent ici.")}
        </p>
      )}
    </>
  );
}

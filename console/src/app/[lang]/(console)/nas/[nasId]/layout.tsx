import Link from "next/link";
import { Suspense } from "react";
import { NAS_SECTIONS, nasHref } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";
import { NasHeaderSkeleton } from "@/components/skeleton";
import { StateBadge, ToneBadge } from "@/components/ui/badge";
import { type TabItem, Tabs } from "@/components/ui/tabs";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { listNasIds, nasName } from "@/lib/fleet";
import { hasHyperBackup } from "@/lib/fleet/applies";
import { nasFromParams } from "@/lib/fleet/page";
import { checkCounts, nasState } from "@/lib/fleet/state";
import type { Nas } from "@/lib/fleet/types";

export function generateStaticParams() {
  return listNasIds().map((nasId) => ({ nasId }));
}

type NasParams = Promise<{ lang: string; nasId: string }>;

export async function generateMetadata({ params }: { params: NasParams }) {
  const name = nasName((await params).nasId, await pageLocale(params));
  return { title: name ?? "NAS" };
}

export default function NasLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: NasParams;
}) {
  return (
    <>
      <Suspense fallback={<NasHeaderSkeleton />}>
        <NasHeader params={params} />
      </Suspense>
      {children}
    </>
  );
}

function tabsFor(nas: Nas, lang: Locale): TabItem[] {
  const { failed, warning } = checkCounts(nas);
  const failedTasks = nas.tasks.filter(
    (t) => t.result.status === "failed",
  ).length;
  const sections = (
    nas.agent.kind === "none"
      ? NAS_SECTIONS.filter((s) => ["", "storage", "system"].includes(s.slug))
      : NAS_SECTIONS
  ).filter((s) => s.slug !== "backups" || hasHyperBackup(nas));
  return sections.map((s) => ({
    href: nasHref(nas.id, s.slug),
    label: s.label[lang],
    exact: s.slug === "",
    action: s.slug === "phones",
    ...(s.slug === "checks" && failed + warning
      ? {
          count: failed + warning,
          tone: failed ? ("crit" as const) : ("warn" as const),
        }
      : {}),
    ...(s.slug === "backups" && failedTasks
      ? { count: failedTasks, tone: "crit" as const }
      : {}),
  }));
}

/** En-tête d'un NAS : nom, badges de compte, contexte, lecture, puis ses onglets. */
async function NasHeader({ params }: { params: NasParams }) {
  const nas = await nasFromParams(params);
  const lang = await pageLocale(params);
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const now = new Date();
  const state = nasState(nas);
  const { failed, warning } = checkCounts(nas);
  const up = nas.vitals.uptime;
  const context = [
    nas.model,
    nas.dsm,
    nas.place,
    up !== "inconnue" && up !== "unknown"
      ? t(`up for ${up}`, `allumé depuis ${up}`)
      : null,
  ]
    .filter((x) => x && x !== "–")
    .join(" · ");
  const readAt =
    nas.agent.kind === "ok"
      ? nas.agent.readAt
      : nas.beszel.kind === "ok"
        ? nas.beszel.lastAt
        : null;
  return (
    <div className="flex flex-col gap-3.5">
      <nav
        className="meta flex items-center gap-1.5"
        aria-label={t("Breadcrumb", "Fil d'Ariane")}
      >
        <Link href="/" className="text-fg-3">
          {t("Fleet", "Le parc")}
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-fg-2">{nas.name}</span>
      </nav>
      <PageHeader
        lang={lang}
        title={nas.name}
        badges={
          <>
            {!nas.live ? (
              <span className="tag">{t("fictitious", "fictif")}</span>
            ) : null}
            {nas.agent.kind === "ok" && (failed || warning) ? (
              <>
                {failed ? (
                  <ToneBadge tone="crit">
                    {t(`${failed} failed`, `${failed} en échec`)}
                  </ToneBadge>
                ) : null}
                {warning ? (
                  <ToneBadge tone="warn">
                    {t(`${warning} warning`, `${warning} à surveiller`)}
                  </ToneBadge>
                ) : null}
              </>
            ) : (
              <StateBadge state={state} />
            )}
          </>
        }
        readAt={readAt}
        now={now}
      >
        {context || nas.folder ? (
          <div className="text-[13.5px] text-fg-2">
            {nas.folder ? (
              <>
                <Link
                  href={`/?group=folder&folder=${nas.folder.id}`}
                  className="text-fg-2"
                >
                  {nas.folder.name}
                </Link>
                {context ? " · " : ""}
              </>
            ) : null}
            {context}
          </div>
        ) : null}
      </PageHeader>
      <Tabs
        items={tabsFor(nas, lang)}
        label={t("NAS sections", "Sections du NAS")}
      />
    </div>
  );
}

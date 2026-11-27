import { Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { FleetBoard } from "@/components/fleet/fleet-board";
import { PageHeader } from "@/components/shell/page-header";
import { Ring } from "@/components/ui/ring";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { localSetupStatus } from "@/lib/agents/setup";
import { beszelTrouble, getFleet, type Nas } from "@/lib/fleet";
import { boardItem } from "@/lib/fleet/board";
import { greenSentence } from "@/lib/fleet/lights";
import { byState, nasState } from "@/lib/fleet/state";
import { fleetSentence } from "@/lib/fleet/summary";

// La vue du parc (conception 2026-11-24, section 4) : l'anneau du parc, puis chaque NAS en
// une ligne de voyants et de jauges, en liste ou en colonnes, sans texte de plus.

export default async function FleetPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const lang = await pageLocale(params);
  return (
    <Suspense fallback={<FleetSkeleton lang={lang} />}>
      <Fleet lang={lang} />
    </Suspense>
  );
}

function FleetSkeleton({ lang }: { lang: Locale }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <PageHeader
        lang={lang}
        title={tr(lang, { en: "Fleet", fr: "Le parc" })}
        sentence={tr(lang, {
          en: "Reading the fleet…",
          fr: "Lecture du parc…",
        })}
      />
      <div className="card h-[44px] animate-pulse" />
      <div className="card h-[420px] animate-pulse" />
    </div>
  );
}

/** Dernière lecture réussie d'un agent dans le parc. */
function latestRead(fleet: Nas[]): string | null {
  return (
    fleet
      .flatMap((n) => (n.agent.kind === "ok" ? [n.agent.readAt] : []))
      .sort()
      .at(-1) ?? null
  );
}

async function Fleet({ lang }: { lang: Locale }) {
  // L'agent du projet attend d'être relié à DSM : l'installation d'abord.
  const setup = await localSetupStatus();
  if (setup.kind === "waiting") redirect("/setup");
  const [fleet, trouble] = await Promise.all([
    getFleet(lang),
    beszelTrouble(lang),
  ]);
  const now = new Date();
  const sorted = [...fleet].sort(byState);
  const items = sorted.map((nas) => boardItem(nas, lang));
  // L'anneau du parc : la part de vert sur tout ce qu'on suit, NAS par NAS additionnés.
  const ok = items.reduce((n, i) => n + i.green.ok, 0);
  const total = items.reduce((n, i) => n + i.green.total, 0);

  return (
    <>
      <PageHeader
        lang={lang}
        title={tr(lang, { en: "Fleet", fr: "Le parc" })}
        sentence={fleetSentence(fleet, lang)}
        state={sorted[0] ? nasState(sorted[0]) : undefined}
        readAt={latestRead(fleet)}
        now={now}
        actions={
          // Dans le moteur, ce NAS sert de hub : on lui ajoute les autres.
          setup.kind === "enrolled" ? (
            <Link href="/nas/add" className="btn">
              <Plus className="size-4" aria-hidden="true" />
              {tr(lang, { en: "Add a NAS", fr: "Ajouter un NAS" })}
            </Link>
          ) : undefined
        }
      >
        <span className="flex items-center gap-2.5">
          <Ring ok={ok} total={total} size={40} />
          <span className="meta">{greenSentence(ok, total, lang)}</span>
        </span>
        {trouble ? (
          <p className="meta m-0">
            {tr(lang, {
              en: `Charts and NAS without an agent unavailable: ${trouble}.`,
              fr: `Courbes et NAS sans agent indisponibles : ${trouble}.`,
            })}
          </p>
        ) : null}
      </PageHeader>
      <Suspense fallback={<div className="card h-[420px] animate-pulse" />}>
        <FleetBoard items={items} />
      </Suspense>
    </>
  );
}

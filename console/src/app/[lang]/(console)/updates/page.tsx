import type { Metadata } from "next";
import { Suspense } from "react";
import { FleetRollout } from "@/components/fleet/fleet-rollout";
import {
  type UpdatableNas,
  UpdatesBoard,
} from "@/components/fleet/updates-board";
import { PageHeader } from "@/components/shell/page-header";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { loadAgents, localAgent } from "@/lib/agents/config";
import { mapRollouts, rolloutKey } from "@/lib/agents/rollouts";
import { fleetRollouts } from "@/lib/agents/setup";
import { readProtections } from "@/lib/agents/updates-read";
import { getFleet } from "@/lib/fleet";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Updates", fr: "Mises à jour" }) };
}

export default async function UpdatesPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const lang = await pageLocale(params);
  return (
    <Suspense
      fallback={
        <div aria-hidden="true" className="flex flex-col gap-6">
          <PageHeader
            lang={lang}
            title={tr(lang, { en: "Updates", fr: "Mises à jour" })}
            sentence={tr(lang, {
              en: "Reading the fleet…",
              fr: "Lecture du parc…",
            })}
          />
          <div className="card h-[320px] animate-pulse" />
        </div>
      }
    >
      <Updates lang={lang} />
    </Suspense>
  );
}

/** Les paquets en retard sur le catalogue de Synology, NAS par NAS, à mettre à jour d'ici. */
async function Updates({ lang }: { lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const fleet = await getFleet(lang);
  const now = new Date();
  const agents = loadAgents();
  const withAgent = fleet.filter((n) => n.agent.kind !== "none");
  // Les protections de chaque NAS, lues sur son agent ; et, dans le moteur, les déroulés du hub.
  const [held, rollouts] = await Promise.all([
    Promise.all(
      withAgent.map((n) =>
        n.live && n.agent.kind === "ok" ? readProtections(n.id, lang) : null,
      ),
    ),
    localAgent() ? fleetRollouts() : null,
  ]);
  const updatable: UpdatableNas[] = withAgent.map((n, i) => ({
    id: n.id,
    name: n.name,
    model: n.model,
    live: n.live,
    held: (() => {
      const got = held[i];
      return got?.ok
        ? {
            frozen: got.value.frozen,
            dsmLocked: got.value.dsmLocked,
            note: got.value.note,
            reasons: got.value.held,
          }
        : null;
    })(),
    folder: n.folder
      ? { id: n.folder.id, name: n.folder.name, rank: n.folder.rank }
      : null,
    rolloutKey: (() => {
      const agent = agents.find((a) => a.id === n.id);
      return agent ? rolloutKey(agent) : null;
    })(),
    dsm: n.dsmUpdate?.available
      ? { current: n.dsmUpdate.current, available: n.dsmUpdate.available }
      : null,
    packages: (n.packages ?? []).flatMap((p) =>
      p.id && p.update
        ? [
            {
              id: p.id,
              name: p.name,
              version: p.version,
              update: p.update,
              security: p.security,
            },
          ]
        : [],
    ),
  }));
  const total = updatable.reduce(
    (n, nas) => n + nas.packages.length + (nas.dsm ? 1 : 0),
    0,
  );
  const security = updatable.reduce(
    (n, nas) => n + nas.packages.filter((p) => p.security).length,
    0,
  );
  const readAt =
    fleet
      .flatMap((n) => (n.agent.kind === "ok" ? [n.agent.readAt] : []))
      .sort()
      .at(-1) ?? null;
  return (
    <>
      <PageHeader
        lang={lang}
        title={t("Updates", "Mises à jour")}
        sentence={
          total
            ? t(
                `${total} ${total === 1 ? "update" : "updates"}${security ? `, ${security} for security` : ""}`,
                `${total} ${total > 1 ? "mises à jour" : "mise à jour"}${security ? `, dont ${security} de sécurité` : ""}`,
              )
            : t("All up to date", "Tout est à jour")
        }
        state={security ? "warning" : "ok"}
        readAt={readAt}
        now={now}
      />
      {rollouts ? (
        <FleetRollout
          lang={lang}
          fleet={updatable}
          initial={
            rollouts.ok
              ? mapRollouts(rollouts.body)
              : { reason: rollouts.error[lang] }
          }
        />
      ) : null}
      <UpdatesBoard lang={lang} fleet={updatable} />
    </>
  );
}

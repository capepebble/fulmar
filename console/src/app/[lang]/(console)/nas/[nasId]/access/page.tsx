import { AccessSection } from "@/components/nas/access";
import { ProtectionsCard } from "@/components/nas/protections";
import { NoAgent, WithNas } from "@/components/with-nas";
import type { Locale } from "@/i18n";
import { readAccess } from "@/lib/agents/access-read";
import { loadAgents } from "@/lib/agents/config";
import type { ProtectionsView } from "@/lib/agents/protections";
import { consoleTimeZone } from "@/lib/agents/time";
import { readProtections } from "@/lib/agents/updates-read";
import { tabMetadata } from "@/lib/fleet/page";
import type { Nas } from "@/lib/fleet/types";

export const generateMetadata = tabMetadata({ en: "Access", fr: "Accès" });

export default function AccessPage({
  params,
}: {
  params: Promise<{ lang: string; nasId: string }>;
}) {
  return (
    <WithNas params={params}>
      {(nas, lang) =>
        nas.agent.kind === "none" ? (
          <NoAgent lang={lang} />
        ) : (
          <Access nas={nas} lang={lang} />
        )
      }
    </WithNas>
  );
}

/** Un NAS fictif : Surveillance Station protégée, avec sa note. */
function demoProtections(lang: Locale): ProtectionsView {
  return {
    frozen: false,
    dsmLocked: true,
    packages: ["SurveillanceStation"],
    note:
      lang === "en"
        ? "client cameras: never stop during the day"
        : "caméras du client : jamais d'arrêt en journée",
    held: { SurveillanceStation: "protected" },
  };
}

async function Access({ nas, lang }: { nas: Nas; lang: Locale }) {
  const [view, held] = await Promise.all([
    readAccess(nas.id, nas.live, lang),
    nas.live ? readProtections(nas.id, lang) : null,
  ]);
  const protections = !nas.live
    ? demoProtections(lang)
    : held?.ok
      ? held.value
      : { reason: held?.reason ?? "–" };
  const installed = (nas.packages ?? []).flatMap((p) =>
    p.id ? [{ id: p.id, name: p.name }] : [],
  );
  // Un NAS ajouté au hub se retire du parc ; le NAS du projet se détache.
  const member = loadAgents().some((a) => a.id === nas.id && a.member);
  return (
    <AccessSection
      view={view}
      lang={lang}
      nasId={nas.id}
      nasName={nas.name}
      member={member}
      now={new Date()}
      tz={consoleTimeZone()}
    >
      <ProtectionsCard
        nasId={nas.id}
        initial={protections}
        packages={installed}
        live={nas.live}
      />
    </AccessSection>
  );
}

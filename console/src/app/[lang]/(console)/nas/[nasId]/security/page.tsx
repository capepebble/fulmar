import { OpenAccess } from "@/components/nas/open-access";
import { SecuritySection } from "@/components/nas/security";
import { NoAgent, WithNas } from "@/components/with-nas";
import type { Locale } from "@/i18n";
import { readWatch } from "@/lib/agents/close-access-read";
import { consoleTimeZone } from "@/lib/agents/time";
import { tabMetadata } from "@/lib/fleet/page";
import type { Nas } from "@/lib/fleet/types";

export const generateMetadata = tabMetadata({ en: "Security", fr: "Sécurité" });

export default function SecurityPage({
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
          <Security nas={nas} lang={lang} />
        )
      }
    </WithNas>
  );
}

async function Security({ nas, lang }: { nas: Nas; lang: Locale }) {
  // SSH et Telnet d'abord : la seule carte de l'onglet où l'on agit.
  const watch = await readWatch(nas.id, nas.live, lang);
  return (
    <>
      <OpenAccess nasId={nas.id} initial={watch} tz={consoleTimeZone()} />
      <SecuritySection nas={nas} lang={lang} now={new Date()} />
    </>
  );
}

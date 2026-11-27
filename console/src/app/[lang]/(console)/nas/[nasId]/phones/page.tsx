import { PhonesSection } from "@/components/nas/phones";
import { NoAgent, WithNas } from "@/components/with-nas";
import type { Locale } from "@/i18n";
import { readPhones } from "@/lib/agents/phones-read";
import { consoleTimeZone } from "@/lib/agents/time";
import { tabMetadata } from "@/lib/fleet/page";
import type { Nas } from "@/lib/fleet/types";

export const generateMetadata = tabMetadata({ en: "Phones", fr: "Téléphones" });

export default function PhonesPage({
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
          <Phones nas={nas} lang={lang} />
        )
      }
    </WithNas>
  );
}

async function Phones({ nas, lang }: { nas: Nas; lang: Locale }) {
  const initial = await readPhones(nas.id, nas.live, lang);
  return (
    <PhonesSection
      nasId={nas.id}
      live={nas.live}
      initial={initial}
      tz={consoleTimeZone()}
      nowIso={new Date().toISOString()}
    />
  );
}

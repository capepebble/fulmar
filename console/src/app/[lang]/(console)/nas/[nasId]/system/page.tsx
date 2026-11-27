import { SystemSection } from "@/components/nas/system";
import { WithNas } from "@/components/with-nas";
import type { Locale } from "@/i18n";
import { nasBeszel, nasContainers } from "@/lib/fleet/curves";
import { tabMetadata } from "@/lib/fleet/page";
import type { Nas } from "@/lib/fleet/types";

export const generateMetadata = tabMetadata({ en: "System", fr: "Système" });

export default function SystemPage({
  params,
}: {
  params: Promise<{ lang: string; nasId: string }>;
}) {
  return (
    <WithNas params={params}>
      {(nas, lang) => <System nas={nas} lang={lang} />}
    </WithNas>
  );
}

async function System({ nas, lang }: { nas: Nas; lang: Locale }) {
  const [bz, containers] = await Promise.all([
    nasBeszel(nas),
    nasContainers(nas),
  ]);
  return (
    <SystemSection
      lang={lang}
      nas={nas}
      details={bz.details}
      containers={containers}
      now={new Date()}
    />
  );
}

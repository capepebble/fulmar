import { BackupsSection } from "@/components/nas/backups";
import { NoAgent, WithNas } from "@/components/with-nas";
import { consoleTimeZone } from "@/lib/agents/time";
import { tabMetadata } from "@/lib/fleet/page";

export const generateMetadata = tabMetadata({
  en: "Backups",
  fr: "Sauvegardes",
});

export default function NasBackupsPage({
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
          <BackupsSection
            nas={nas}
            now={new Date()}
            tz={consoleTimeZone()}
            lang={lang}
          />
        )
      }
    </WithNas>
  );
}

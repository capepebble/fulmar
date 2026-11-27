import { CheckList } from "@/components/nas/check-list";
import { NoAgent, WithNas } from "@/components/with-nas";
import { consoleTimeZone } from "@/lib/agents/time";
import { tabMetadata } from "@/lib/fleet/page";

export const generateMetadata = tabMetadata({ en: "Checks", fr: "Points" });

export default function ChecksPage({
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
          <CheckList
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

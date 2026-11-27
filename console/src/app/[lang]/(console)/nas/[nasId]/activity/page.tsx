import { ActivityJournal, ConnectedCard } from "@/components/nas/activity";
import { NoAgent, WithNas } from "@/components/with-nas";
import { tabMetadata } from "@/lib/fleet/page";

export const generateMetadata = tabMetadata({ en: "Activity", fr: "Activité" });

export default function ActivityPage({
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
          <>
            <ConnectedCard connected={nas.connected} />
            <ActivityJournal events={nas.activity} fileLogs={nas.fileLogs} />
          </>
        )
      }
    </WithNas>
  );
}

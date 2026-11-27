import { StorageSection } from "@/components/nas/storage";
import { WithNas } from "@/components/with-nas";
import type { Locale } from "@/i18n";
import { consoleTimeZone } from "@/lib/agents/time";
import { nasBeszel, volumeHistory } from "@/lib/fleet/curves";
import { matchDisks } from "@/lib/fleet/disks";
import type { FillForecast } from "@/lib/fleet/forecast";
import { tabMetadata } from "@/lib/fleet/page";
import type { Nas } from "@/lib/fleet/types";

export const generateMetadata = tabMetadata({ en: "Storage", fr: "Stockage" });

export default function StoragePage({
  params,
}: {
  params: Promise<{ lang: string; nasId: string }>;
}) {
  return (
    <WithNas params={params}>
      {(nas, lang) => <Storage nas={nas} lang={lang} />}
    </WithNas>
  );
}

async function Storage({ nas, lang }: { nas: Nas; lang: Locale }) {
  const now = new Date();
  const [bz, forecasts] = await Promise.all([
    nasBeszel(nas),
    Promise.all(
      nas.volumes.map(
        async (v) => [v.path, await volumeHistory(nas, v, now)] as const,
      ),
    ),
  ]);
  return (
    <StorageSection
      lang={lang}
      nas={nas}
      pairs={matchDisks(nas.disks, bz.disks ?? [])}
      forecasts={
        new Map<string, FillForecast>(
          forecasts.map(([k, h]) => [k, h.forecast]),
        )
      }
      histories={new Map(forecasts.map(([k, h]) => [k, h.points]))}
      now={now}
      tz={consoleTimeZone()}
    />
  );
}

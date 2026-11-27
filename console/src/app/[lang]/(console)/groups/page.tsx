import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { GroupsEditor } from "@/components/fleet/groups-editor";
import { PageHeader } from "@/components/shell/page-header";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { listNasIds, nasName } from "@/lib/fleet";
import { memory } from "@/lib/store/memory";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Groups", fr: "Groupes" }) };
}

export default async function GroupsPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const lang = await pageLocale(params);
  return (
    <Suspense
      fallback={<div className="card h-[320px] animate-pulse" aria-hidden />}
    >
      <Groups lang={lang} />
    </Suspense>
  );
}

/** Les groupes de NAS (conception 2026-11-26-groupes-protections-parc, section 1). */
async function Groups({ lang }: { lang: Locale }) {
  await connection();
  const m = memory();
  const placed = m.nasFolders();
  const nas = listNasIds().map((id) => ({
    id,
    name: nasName(id, lang) ?? id,
    folderId: placed[id] ?? null,
  }));
  return (
    <>
      <PageHeader
        lang={lang}
        title={tr(lang, { en: "Groups", fr: "Groupes" })}
        sentence={tr(lang, {
          en: "Sort your NAS by client, by category, or any way you like. A NAS is in one group at most.",
          fr: "Rangez vos NAS par client, par catégorie ou comme vous l'entendez. Un NAS est dans un groupe au plus.",
        })}
      />
      <GroupsEditor
        persistent={m.persistent}
        folders={m.folders().map(({ id, name, kind }) => ({ id, name, kind }))}
        nas={nas}
      />
    </>
  );
}

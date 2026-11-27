import { connection } from "next/server";
import { Suspense } from "react";
import { CommandPalette } from "@/components/command-palette";
import {
  ConsoleProvider,
  type FleetEntry,
  type IssueEntry,
  Shortcuts,
} from "@/components/console-provider";
import { MobileBars, MobileBarsSkeleton } from "@/components/shell/mobile-bar";
import { Sidebar, SidebarSkeleton } from "@/components/shell/sidebar";
import type { Locale } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { passwordMode } from "@/lib/auth";
import { getFleet, type Nas } from "@/lib/fleet";
import { fleetIssues } from "@/lib/fleet/issues";
import { nasState } from "@/lib/fleet/state";

// La coque de la console : barre latérale, barres du téléphone, palette. Les pages d'accès
// (bienvenue, connexion, installation) vivent à part, sans elle.

// Le mode de connexion se lit à la requête, jamais au prérendu : l'image se construit sans
// l'environnement du projet.
async function SidebarSlot() {
  await connection();
  return <Sidebar canSignOut={passwordMode()} />;
}

async function MobileSlot() {
  await connection();
  return <MobileBars canSignOut={passwordMode()} />;
}

/** Le parc pour la barre latérale et la palette : lu sans bloquer la coque de la page. */
async function fleetEntries(
  fleet: Promise<Nas[]>,
  lang: Locale,
): Promise<FleetEntry[]> {
  const list = await fleet;
  const issues = fleetIssues(list, lang);
  return list.map((nas) => ({
    id: nas.id,
    name: nas.name,
    model: nas.model,
    place: nas.place,
    folder: nas.folder
      ? { id: nas.folder.id, name: nas.folder.name, rank: nas.folder.rank }
      : null,
    status: nasState(nas),
    fictive: !nas.live,
    issues: issues.filter((i) => i.nas.id === nas.id).length,
  }));
}

/** Les points à traiter du parc, pour la palette et le compte de la barre latérale. */
async function issueEntries(
  fleet: Promise<Nas[]>,
  lang: Locale,
): Promise<IssueEntry[]> {
  return fleetIssues(await fleet, lang).map((i) => ({
    nasId: i.nas.id,
    nasName: i.nas.name,
    level: i.level,
    title: i.title,
    checkId: i.checkId,
  }));
}

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const lang = await pageLocale(params);
  const fleet = getFleet(lang);
  return (
    <ConsoleProvider
      fleet={fleetEntries(fleet, lang)}
      issues={issueEntries(fleet, lang)}
    >
      <div className="flex min-h-dvh">
        <Suspense fallback={<SidebarSkeleton />}>
          <SidebarSlot />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense fallback={<MobileBarsSkeleton />}>
            <MobileSlot />
          </Suspense>
          <main className="flex-1 px-4 pt-5 pb-28 md:px-[clamp(16px,3vw,40px)] md:pt-7 md:pb-14">
            <div className="mx-auto flex max-w-[1180px] flex-col gap-6">
              {children}
            </div>
          </main>
        </div>
      </div>
      <Suspense fallback={null}>
        <CommandPalette />
        <Shortcuts />
      </Suspense>
    </ConsoleProvider>
  );
}

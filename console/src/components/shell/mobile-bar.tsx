"use client";

import {
  CircleAlert,
  LayoutGrid,
  LogOut,
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signOut } from "@/app/[lang]/(acces)/actions";
import { tr } from "@/i18n";
import { useLocale, usePathname } from "@/i18n/client";
import { NAS_STATE_LABEL } from "@/lib/fleet/state";
import { cn } from "@/lib/format";
import { PRODUCT_NAME } from "@/lib/product";
import { useConsole, useFleet, useIssues } from "../console-provider";
import { Dot } from "../ui/dot";
import { Logo } from "./logo";
import { nasHref } from "./nav";
import { LanguageChoice, ThemeChoice } from "./sidebar";

/** Téléphone : en-tête collant (nom, Relire) et barre d'onglets sous le pouce. */
export function MobileBars({ canSignOut = false }: { canSignOut?: boolean }) {
  const fleet = useFleet();
  const issues = useIssues();
  const pathname = usePathname();
  const { reload, reading, setPaletteOpen } = useConsole();
  const [listOpen, setListOpen] = useState(false);

  // Changer de page referme la liste des NAS.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on réagit à la seule adresse.
  useEffect(() => setListOpen(false), [pathname]);

  const onNas = pathname.startsWith("/nas/");
  const lang = useLocale();
  return (
    <>
      <header className="sticky top-0 z-20 flex items-center justify-between border-border border-b-[0.5px] bg-[var(--blur)] px-4 pt-3 pb-2.5 backdrop-blur-xl backdrop-saturate-150 md:hidden">
        <Link
          href="/"
          aria-label={tr(lang, {
            en: `${PRODUCT_NAME}, overview`,
            fr: `${PRODUCT_NAME}, vue d'ensemble`,
          })}
          className="flex items-center text-fg hover:no-underline"
        >
          <Logo className="h-[22px] w-auto" />
        </Link>
        <span className="flex items-center">
          {canSignOut ? (
            <form action={signOut}>
              <button
                type="submit"
                aria-label={tr(lang, { en: "Sign out", fr: "Se déconnecter" })}
                className="flex size-11 items-center justify-center rounded-full text-fg-3 active:scale-90 transition-transform"
              >
                <LogOut className="icon size-5" aria-hidden="true" />
              </button>
            </form>
          ) : null}
          <button
            type="button"
            aria-label={tr(lang, { en: "Read again", fr: "Relire" })}
            onClick={reload}
            disabled={reading}
            className="flex size-11 items-center justify-center rounded-full text-[var(--accent)] active:scale-90 transition-transform"
          >
            <RefreshCw
              className={cn("icon size-5", reading && "animate-spin")}
              aria-hidden="true"
            />
          </button>
        </span>
      </header>

      {listOpen ? (
        <div className="fixed inset-0 z-30 md:hidden">
          <button
            type="button"
            aria-label={tr(lang, {
              en: "Close the NAS list",
              fr: "Fermer la liste des NAS",
            })}
            className="absolute inset-0 bg-black/30"
            onClick={() => setListOpen(false)}
          />
          <section
            className="absolute inset-x-0 bottom-0 max-h-[75dvh] overflow-y-auto rounded-t-[14px] bg-surface pb-[calc(env(safe-area-inset-bottom)+84px)] shadow-[var(--shadow-pop)]"
            aria-labelledby="mobile-nas"
          >
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <h2 className="h2" id="mobile-nas">
                NAS
              </h2>
              <button
                type="button"
                aria-label={tr(lang, { en: "Close", fr: "Fermer" })}
                className="flex size-11 items-center justify-center text-fg-3"
                onClick={() => setListOpen(false)}
              >
                <X className="icon size-5" aria-hidden="true" />
              </button>
            </div>
            {fleet.map((nas) => (
              <Link
                key={nas.id}
                href={nasHref(nas.id)}
                className="flex min-h-[52px] items-center gap-3 border-border border-t px-4 text-fg hover:no-underline"
              >
                <Dot state={nas.status} />
                <span className="grow truncate font-medium">{nas.name}</span>
                <span className="meta">
                  {NAS_STATE_LABEL[nas.status][lang]}
                </span>
              </Link>
            ))}
            <div className="flex items-center gap-2 border-border border-t px-4 pt-4">
              <ThemeChoice />
              <LanguageChoice />
            </div>
          </section>
        </div>
      ) : null}

      <nav
        aria-label={tr(lang, { en: "Navigation", fr: "Navigation" })}
        className="fixed inset-x-0 bottom-0 z-40 flex border-border border-t-[0.5px] bg-[var(--blur)] px-2 pt-1 pb-[calc(env(safe-area-inset-bottom)+6px)] backdrop-blur-xl backdrop-saturate-150 md:hidden"
      >
        <Link
          href="/"
          className="tabbar-i"
          aria-current={pathname === "/" ? "page" : undefined}
        >
          <LayoutGrid className="icon size-5" aria-hidden="true" />
          {tr(lang, { en: "Fleet", fr: "Le parc" })}
        </Link>
        <Link
          href="/issues"
          className="tabbar-i"
          aria-current={pathname.startsWith("/issues") ? "page" : undefined}
        >
          <span className="relative">
            <CircleAlert className="icon size-5" aria-hidden="true" />
            {issues.length ? (
              <span className="-top-1.5 -right-2.5 absolute rounded-full bg-crit-bg px-1 font-semibold text-[10px] text-crit-text leading-[15px]">
                {issues.length}
              </span>
            ) : null}
          </span>
          {tr(lang, { en: "To handle", fr: "À traiter" })}
        </Link>
        <button
          type="button"
          className="tabbar-i"
          aria-current={onNas ? "page" : undefined}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
        >
          <Server className="icon size-5" aria-hidden="true" />
          NAS
        </button>
        <button
          type="button"
          className="tabbar-i"
          onClick={() => setPaletteOpen(true)}
        >
          <Search className="icon size-5" aria-hidden="true" />
          {tr(lang, { en: "Search", fr: "Chercher" })}
        </button>
      </nav>
    </>
  );
}

export function MobileBarsSkeleton() {
  return (
    <header className="sticky top-0 z-20 h-[69px] border-border border-b bg-[var(--blur)] md:hidden" />
  );
}

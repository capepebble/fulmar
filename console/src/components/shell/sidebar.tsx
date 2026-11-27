"use client";

import {
  CircleAlert,
  DatabaseBackup,
  FileText,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  PackageCheck,
  Search,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { signOut } from "@/app/[lang]/(acces)/actions";
import { tr } from "@/i18n";
import { switchLocale, useLocale, usePathname } from "@/i18n/client";
import { LOCALE_NAME, LOCALES } from "@/i18n/locales";
import { folderSections } from "@/lib/fleet/folders";
import { PRODUCT_NAME } from "@/lib/product";
import { useConsole, useFleet, useIssues } from "../console-provider";
import { Dot } from "../ui/dot";
import { Logo } from "./logo";
import { FLEET_PAGES, nasHref } from "./nav";

const ICONS = {
  "/": LayoutGrid,
  "/issues": CircleAlert,
  "/backups": DatabaseBackup,
  "/updates": PackageCheck,
  "/reports": FileText,
} as const;

function current(pathname: string, href: string): "page" | undefined {
  if (href === "/") return pathname === "/" ? "page" : undefined;
  return pathname === href || pathname.startsWith(`${href}/`)
    ? "page"
    : undefined;
}

/** Barre latérale (Mac) : nom, recherche, pages du parc, NAS dans l'ordre de la liste. La
 * pastille dit l'urgence ; l'ordre reste stable pour la mémoire des gestes. */
export function Sidebar({ canSignOut = false }: { canSignOut?: boolean }) {
  const fleet = useFleet();
  const issues = useIssues();
  const pathname = usePathname();
  const { setPaletteOpen } = useConsole();
  const lang = useLocale();
  // Des titres de groupe dès qu'un NAS est rangé ; sinon la liste reste d'un seul tenant.
  const sectioned = fleet.some((nas) => nas.folder);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[248px] flex-none flex-col gap-4 overflow-y-auto border-border border-r-[0.5px] bg-[var(--sidebar)] px-2.5 py-4 backdrop-blur-xl backdrop-saturate-150 md:flex">
      <Link
        href="/"
        aria-label={tr(lang, {
          en: `${PRODUCT_NAME}, overview`,
          fr: `${PRODUCT_NAME}, vue d'ensemble`,
        })}
        className="flex items-center px-2 pt-1 text-fg hover:no-underline"
      >
        <Logo className="h-[22px] w-auto" />
      </Link>
      <button
        type="button"
        className="btn w-full justify-start font-normal text-fg-3"
        onClick={() => setPaletteOpen(true)}
      >
        <Search className="icon" aria-hidden="true" />
        <span className="grow text-left">
          {tr(lang, { en: "Search for a NAS", fr: "Rechercher un NAS" })}
        </span>
        <span className="kbd">⌘K</span>
      </button>
      <nav
        className="flex flex-col gap-0.5"
        aria-label={tr(lang, { en: "Fleet pages", fr: "Pages du parc" })}
      >
        {FLEET_PAGES.map(({ href, label }) => {
          const Icon = ICONS[href];
          return (
            <Link
              key={href}
              href={href}
              className="nav-i"
              aria-current={current(pathname, href)}
            >
              <Icon className="icon" aria-hidden="true" />
              {label[lang]}
              {href === "/issues" && issues.length ? (
                <span className="count">{issues.length}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <nav className="flex flex-col gap-0.5" aria-label="NAS">
        <div className="flex items-baseline justify-between px-2.5 pb-1.5">
          <span className="meta font-medium">NAS</span>
          <Link
            href="/groups"
            className="meta hover:text-fg hover:no-underline"
            aria-current={current(pathname, "/groups")}
          >
            {tr(lang, { en: "Groups", fr: "Groupes" })}
          </Link>
        </div>
        {folderSections(fleet).map((section) => (
          <div key={section.key} className="flex flex-col gap-0.5">
            {sectioned ? (
              <div className="meta truncate px-2.5 pt-2 pb-0.5">
                {section.folder?.name ??
                  tr(lang, { en: "No group", fr: "Sans groupe" })}
              </div>
            ) : null}
            {section.items.map((nas) => (
              <Link
                key={nas.id}
                href={nasHref(nas.id)}
                className="nav-i"
                aria-current={
                  pathname === nasHref(nas.id) ||
                  pathname.startsWith(`${nasHref(nas.id)}/`)
                    ? "page"
                    : undefined
                }
              >
                <Dot state={nas.status} />
                <span className="grow truncate">{nas.name}</span>
                {nas.issues ? (
                  <span className="count">{nas.issues}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-3 px-2.5">
        <p className="meta m-0 leading-[1.45]">
          {tr(lang, {
            en: "State and charts read by each NAS’s agent; Beszel, when connected, for NAS without an agent and for disks.",
            fr: "État et courbes lus par l'agent de chaque NAS ; Beszel, s'il est branché, pour les NAS sans agent et les disques.",
          })}
        </p>
        <span className="flex items-center gap-2">
          <ThemeChoice />
          <LanguageChoice />
        </span>
        {canSignOut ? (
          <form action={signOut}>
            <button type="submit" className="nav-i w-full">
              <LogOut className="icon size-4" aria-hidden="true" />
              {tr(lang, { en: "Sign out", fr: "Se déconnecter" })}
            </button>
          </form>
        ) : null}
      </div>
    </aside>
  );
}

const THEMES = [
  { value: "system", label: { en: "System", fr: "Système" }, Icon: Monitor },
  { value: "light", label: { en: "Light", fr: "Clair" }, Icon: Sun },
  { value: "dark", label: { en: "Dark", fr: "Sombre" }, Icon: Moon },
] as const;

/** Thème : celui du système, ou un choix manuel. */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const lang = useLocale();
  useEffect(() => setMounted(true), []);
  return (
    <fieldset className="seg m-0 self-start">
      <legend className="sr-only">
        {tr(lang, { en: "Theme", fr: "Thème" })}
      </legend>
      {THEMES.map(({ value, label: names, Icon }) => {
        const label = names[lang];
        return (
          <button
            key={value}
            type="button"
            aria-pressed={mounted ? theme === value : undefined}
            aria-current={mounted && theme === value ? "true" : undefined}
            className="seg-b gap-1.5"
            onClick={() => setTheme(value)}
            title={label}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </fieldset>
  );
}

/** Langue de la console : retenue par un cookie, la page se recharge dans la langue choisie. */
export function LanguageChoice() {
  const lang = useLocale();
  return (
    <fieldset className="seg m-0 self-start">
      <legend className="sr-only">
        {tr(lang, { en: "Language", fr: "Langue" })}
      </legend>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={code === lang}
          aria-current={code === lang ? "true" : undefined}
          className="seg-b px-2 font-medium text-[11.5px] uppercase"
          title={LOCALE_NAME[code]}
          onClick={() => code !== lang && switchLocale(code)}
        >
          {code}
          <span className="sr-only"> {LOCALE_NAME[code]}</span>
        </button>
      ))}
    </fieldset>
  );
}

export function SidebarSkeleton() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[248px] flex-none border-border border-r-[0.5px] bg-[var(--sidebar)] md:block" />
  );
}

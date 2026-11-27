"use client";

import { usePathname as useNextPathname } from "next/navigation";
import { createContext, useContext } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  type Locale,
  splitLocale,
} from "./locales";

// Les composants client lisent la langue de la page par ce contexte.

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** L'adresse de la page sans préfixe de langue. Au rendu serveur, Next.js donne l'adresse
 * réécrite par le proxy (/en/nas/essai) ; dans le navigateur, celle de la barre d'adresse
 * (/nas/essai) : sans ce retrait, l'onglet actif diffère et l'hydratation échoue. */
export function usePathname(): string {
  const pathname = useNextPathname();
  return splitLocale(pathname)?.rest ?? pathname;
}

/** Change de langue : le cookie (un an), puis la page rechargée dans la nouvelle langue. */
export function switchLocale(locale: Locale): void {
  // biome-ignore lint/suspicious/noDocumentCookie: un cookie de préférence, lu par le serveur.
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  window.location.reload();
}

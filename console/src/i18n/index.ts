import type { Locale } from "./locales";

// Les textes de la console s'écrivent dans toutes les langues, côte à côte, là où ils servent
// (conception du moteur en anglais) : `tr(locale, { en, fr })`. Une langue ajoutée à
// `LOCALES` fait signaler par TypeScript chaque texte qui ne l'a pas encore.

export type Texts = Record<Locale, string>;

export function tr(locale: Locale, texts: Texts): string {
  return texts[locale];
}

export type { Locale } from "./locales";

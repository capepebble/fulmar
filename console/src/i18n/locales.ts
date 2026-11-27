// Les langues de la console (conception du moteur en anglais, 2026-11-25) : l'anglais par
// défaut, le français ; une autre langue s'ajoute ici et par son dictionnaire.

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Cookie du choix de langue, posé par le sélecteur ; lisible par la page (pas HttpOnly). */
export const LOCALE_COOKIE = "lang";
/** En-tête posé par le proxy sur chaque requête de page : la langue choisie, que les
 * réécritures de next.config.ts suivent. */
export const LOCALE_HEADER = "x-console-locale";

/** Les conventions d'Intl pour chaque langue : dates, nombres. */
export const INTL_TAG: Record<Locale, string> = { en: "en-US", fr: "fr-FR" };

export const LOCALE_NAME: Record<Locale, string> = {
  en: "English",
  fr: "Français",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/** La première langue connue d'un en-tête Accept-Language, poids compris. */
export function fromAcceptLanguage(
  header: string | null | undefined,
): Locale | null {
  const ranked = (header ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...rest] = part.trim().split(";");
      const q = rest.find((r) => r.trim().startsWith("q="));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return {
        code: tag.split("-")[0].toLowerCase(),
        weight: Number.isFinite(weight) ? weight : 0,
        i,
      };
    })
    .filter((r) => r.code && r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  return (
    (ranked.find((r) => isLocale(r.code))?.code as Locale | undefined) ?? null
  );
}

/** Le cookie s'il est valable, sinon la langue du navigateur, sinon l'anglais. */
export function pickLocale(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

/** « /fr/nas/essai » donne fr et « /nas/essai » ; une adresse sans langue donne null. */
export function splitLocale(
  pathname: string,
): { locale: Locale; rest: string } | null {
  const m = /^\/([a-z]{2})(\/.*)?$/.exec(pathname);
  if (!m || !isLocale(m[1])) return null;
  return { locale: m[1], rest: m[2] ?? "/" };
}

/** La langue d'une page, lue dans ses paramètres (`/[lang]/…`). */
export async function pageLocale(
  params: Promise<{ lang: string }>,
): Promise<Locale> {
  const { lang } = await params;
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

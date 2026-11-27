import { type ReactNode, Suspense } from "react";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import type { Nas } from "@/lib/fleet";
import { nasFromParams } from "@/lib/fleet/page";
import { PageSkeleton } from "./skeleton";

type Params = Promise<{ lang: string; nasId: string }>;

async function Resolve({
  params,
  render,
}: {
  params: Params;
  render: (nas: Nas, lang: Locale) => ReactNode;
}) {
  return render(await nasFromParams(params), await pageLocale(params));
}

/**
 * Une page de NAS : l'adresse se résout sous un `<Suspense>`, pour que la navigation reste
 * instantanée (Next.js montre le squelette, puis la page dès que le NAS est connu). La page
 * reçoit le NAS et la langue.
 */
export function WithNas({
  params,
  children,
  fallback = <PageSkeleton />,
}: {
  params: Params;
  children: (nas: Nas, lang: Locale) => ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <Resolve params={params} render={children} />
    </Suspense>
  );
}

/** Onglet d'un NAS sans agent : seuls la vue d'ensemble, le stockage et le système existent. */
export function NoAgent({ lang }: { lang: Locale }) {
  return (
    <div className="card px-[18px] py-4 text-fg-2">
      {tr(lang, {
        en: "This NAS is followed by Beszel only: without an agent, no checks, no backups, no logs.",
        fr: "Ce NAS n'est suivi que par Beszel : sans agent, ni contrôles, ni sauvegardes, ni journaux.",
      })}
    </div>
  );
}

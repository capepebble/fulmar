"use client";

import Link from "next/link";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";

// Une page 404 ne reçoit pas les paramètres de la route : la langue vient du fournisseur
// posé par la mise en page racine.
export default function NotFound() {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <h1 className="m-0 font-semibold text-[22px] tracking-[-0.02em]">
        {t(
          "This NAS or this page does not exist.",
          "Ce NAS ou cette page n'existe pas.",
        )}
      </h1>
      <p className="m-0 text-fg-2">
        {t(
          "It may have been removed from the fleet, or the link is incomplete.",
          "Il a peut-être été retiré du parc, ou le lien est incomplet.",
        )}
      </p>
      <Link href="/" className="btn mt-3">
        {t("Back to the overview", "Revenir à la vue d'ensemble")}
      </Link>
    </div>
  );
}

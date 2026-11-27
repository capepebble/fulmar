"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { removeNas } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";

/** « Retirer du parc », pour un NAS ajouté au hub : une confirmation qui dit ce qui s'efface,
 * puis le parc. */
export function RemoveNas({ nasId, name }: { nasId: string; name: string }) {
  const router = useRouter();
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const headingId = useId();

  function remove() {
    setError(null);
    start(async () => {
      const result = await removeNas(nasId, lang);
      if (!result.ok) return setError(result.reason ?? null);
      router.replace("/");
    });
  }

  return (
    <section
      aria-labelledby={headingId}
      className="card flex flex-col gap-3 px-[18px] py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="m-0 font-semibold text-[15px]">
          {t("Remove from the fleet", "Retirer du parc")}
        </h2>
        <p className="meta m-0">
          {t(
            "This hub stops reading the NAS and erases what it kept of it: the service account's password, the history of its vitals, its paired phones. Nothing changes on the NAS.",
            "Ce hub cesse de lire le NAS et efface ce qu'il en gardait : le mot de passe du compte de service, l'historique de ses constantes, ses téléphones appairés. Rien ne change sur le NAS.",
          )}
        </p>
      </div>
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-danger"
            onClick={remove}
            disabled={busy}
          >
            {busy
              ? t("Removing…", "Retrait…")
              : t(`Remove ${name}`, `Retirer ${name}`)}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setAsking(false)}
            disabled={busy}
          >
            {t("Cancel", "Annuler")}
          </button>
        </div>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            {t("Remove from the fleet…", "Retirer du parc…")}
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="m-0 text-[14px] text-crit-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}

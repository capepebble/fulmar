"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { detachNas } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { accountPhrase, type Detached } from "@/lib/agents/access";
import { plural } from "@/lib/format";
import { ToneBadge } from "../ui/badge";

/** « Détacher ce NAS », pour le NAS qui porte le projet : une confirmation qui dit ce que
 * l'agent défait, puis ce qu'il reste à faire dans DSM. */
export function DetachNas({
  nasId,
  name,
  account,
  members,
}: {
  nasId: string;
  name: string;
  account: string | null;
  members: number;
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Detached | null>(null);
  const [busy, start] = useTransition();
  const headingId = useId();
  const who = accountPhrase(account, lang);

  function detach() {
    setError(null);
    start(async () => {
      const result = await detachNas(nasId, lang);
      if (!result.ok) return setError(result.reason);
      setAsking(false);
      setDone(result.value);
    });
  }

  if (done)
    return (
      <section
        aria-labelledby={headingId}
        className="card flex flex-col gap-3 px-[18px] py-4"
        aria-live="polite"
      >
        <div className="flex items-center gap-2">
          <h2 id={headingId} className="m-0 font-semibold text-[15px]">
            {t("NAS detached", "NAS détaché")}
          </h2>
          <ToneBadge tone="ok">{t("Done", "Fait")}</ToneBadge>
        </div>
        <p className="m-0 text-fg-2">
          {lang === "en"
            ? `${plural(done.phonesRemoved, "phone", "phones", lang)} removed, ${plural(done.tokensRevoked, "token", "tokens", lang)} revoked${done.credentialsRemoved ? ", the service account’s password erased" : ""}. The agent now waits for a new installation.`
            : `${plural(done.phonesRemoved, "téléphone retiré", "téléphones retirés", lang)}, ${plural(done.tokensRevoked, "jeton révoqué", "jetons révoqués", lang)}${done.credentialsRemoved ? ", mot de passe du compte de service effacé" : ""}. L'agent attend maintenant une nouvelle installation.`}
        </p>
        <p className="m-0 text-fg-2">
          {t(
            `To finish in DSM: delete ${who} (Control Panel › User & Group), then Fulmar’s project (Container Manager › Project).`,
            `Pour finir dans DSM : supprimer ${who} (Panneau de configuration › Utilisateur et groupe), puis le projet de Fulmar (Container Manager › Projet).`,
          )}
        </p>
        <div>
          <Link href="/setup" className="btn">
            {t("Install again", "Réinstaller")}
          </Link>
        </div>
      </section>
    );

  return (
    <section
      aria-labelledby={headingId}
      className="card flex flex-col gap-3 px-[18px] py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="m-0 font-semibold text-[15px]">
          {t("Detach this NAS", "Détacher ce NAS")}
        </h2>
        <p className="meta m-0">
          {t(
            "Fulmar removes the paired phones, revokes the tokens (except this console’s), cancels the scheduled updates and erases the service account’s password, then waits for a new installation. Nothing changes in DSM.",
            "Fulmar retire les téléphones appairés, révoque les jetons (sauf celui de cette console), annule les mises à jour programmées et efface le mot de passe du compte de service, puis attend une nouvelle installation. Rien ne change dans DSM.",
          )}
        </p>
      </div>
      {members > 0 ? (
        <p className="m-0 text-[14px] text-fg-2">
          {lang === "en"
            ? `First remove the ${plural(members, "NAS", "NAS", lang)} added to this hub, from their Access tab.`
            : `Retirer d'abord ${members > 1 ? "les" : "le"} ${plural(members, "NAS ajouté", "NAS ajoutés", lang)} à ce hub, depuis leur onglet Accès.`}
        </p>
      ) : asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-danger"
            onClick={detach}
            disabled={busy}
          >
            {busy
              ? t("Detaching…", "Détachement…")
              : t(`Detach ${name}`, `Détacher ${name}`)}
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
            {t("Detach this NAS…", "Détacher ce NAS…")}
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

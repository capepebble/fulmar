import { type Locale, type Texts, tr } from "@/i18n";
import { date, since } from "@/lib/agents/time";
import type { SynologyInfo } from "@/lib/fleet/types";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";

// Les failles publiées par Synology qui touchent ce NAS, et le suivi de son modèle
// (conception 2026-11-26-failles-fin-de-vie). Chaque faille mène à la page de Synology.

const SEVERITY: Record<string, { tone: Tone; word: Texts }> = {
  critical: { tone: "crit", word: { en: "Critical", fr: "Critique" } },
  important: { tone: "crit", word: { en: "Important", fr: "Importante" } },
  moderate: { tone: "warn", word: { en: "Moderate", fr: "Modérée" } },
  low: { tone: "warn", word: { en: "Low", fr: "Faible" } },
};

const LIFE: Record<string, { tone: Tone; word: Texts }> = {
  full: {
    tone: "ok",
    word: { en: "Full updates", fr: "Mises à jour complètes" },
  },
  limited: {
    tone: "warn",
    word: { en: "Security fixes only", fr: "Correctifs de sécurité seulement" },
  },
  end_of_life: {
    tone: "crit",
    word: { en: "End of life", fr: "Fin de vie" },
  },
};

export function SynologyCard({
  lang,
  info,
  now,
}: {
  lang: Locale;
  info: SynologyInfo;
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const life = info.lifecycle;
  const lifeWord = life?.updates ? LIFE[life.updates] : null;
  return (
    <Card labelledBy="failles">
      <CardHeader
        id="failles"
        title={t("Known Synology flaws", "Failles connues de Synology")}
        meta={
          info.read
            ? t(
                `${info.known} advisories · read ${since(info.readAt, now, lang)}`,
                `${info.known} avis · lus ${since(info.readAt, now, lang)}`,
              )
            : t("not read yet", "pas encore lus")
        }
      />
      {life ? (
        <div className="row justify-between">
          <span className="font-medium">
            {t(`Support of the ${life.model}`, `Suivi du ${life.model}`)}
          </span>
          {lifeWord ? (
            <ToneBadge tone={lifeWord.tone}>{lifeWord.word[lang]}</ToneBadge>
          ) : (
            <span className="text-fg-2">
              {life.listed
                ? t("Not recognized", "Non reconnu")
                : t("Not in Synology's list", "Absent de la liste de Synology")}
            </span>
          )}
        </div>
      ) : null}
      {!info.read ? (
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {info.error
            ? t(
                `The agent could not read Synology's pages: ${info.error}`,
                `L'agent n'a pas pu lire les pages de Synology : ${info.error}`,
              )
            : t(
                "The agent reads Synology's advisories in the background.",
                "L'agent lit les avis de Synology en tâche de fond.",
              )}
        </p>
      ) : info.findings.length ? (
        info.findings.map((f) => {
          const sev = SEVERITY[(f.severity ?? "").toLowerCase()];
          const name = f.product.startsWith("DSM ")
            ? "DSM"
            : f.product.split(" for DSM ")[0];
          const fix =
            f.state === "no_fix"
              ? t("no fix yet", "pas encore de correctif")
              : f.state === "wont_fix"
                ? t(
                    "Synology will not fix it on this version",
                    "Synology ne la corrigera pas sur cette version",
                  )
                : f.otherBranch
                  ? t(
                      `fixed only by moving to ${name} ${f.fixedIn}`,
                      `corrigée seulement en passant à ${name} ${f.fixedIn}`,
                    )
                  : f.scheduledBy
                    ? t(
                        `fixed by ${name} ${f.fixedIn}, announced for ${date(f.scheduledBy, lang)}`,
                        `corrigée par ${name} ${f.fixedIn}, annoncée pour le ${date(f.scheduledBy, lang)}`,
                      )
                    : t(
                        `fixed by ${name} ${f.fixedIn}`,
                        `corrigée par ${name} ${f.fixedIn}`,
                      );
          return (
            <a
              key={`${f.id}-${f.product}`}
              className="row justify-between gap-3"
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="grow">
                <span className="block font-medium">
                  {f.id} · {f.product}
                </span>
                <span className="meta">{fix}</span>
              </span>
              {sev ? (
                <ToneBadge tone={sev.tone}>{sev.word[lang]}</ToneBadge>
              ) : null}
            </a>
          );
        })
      ) : (
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {t(
            "No flaw published by Synology affects this NAS.",
            "Aucune faille publiée par Synology ne touche ce NAS.",
          )}
        </p>
      )}
    </Card>
  );
}

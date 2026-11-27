import "server-only";

import { type Locale, tr } from "@/i18n";
import { agentToken, loadAgents } from "./config";
import { readPath } from "./fetch";
import { demoReport, type MonthReport, mapReport } from "./report";

// Le bilan du mois, côté serveur : report.month lu sur l'agent de chaque NAS par le jeton de la
// console (droit audit:checks) ; un NAS fictif donne un exemple.

export type ReportResult =
  | { ok: true; value: MonthReport }
  | { ok: false; reason: string };

export async function readReport(
  nasId: string,
  live: boolean,
  month: string,
  lang: Locale,
): Promise<ReportResult> {
  if (!live) return { ok: true, value: demoReport(month, lang) };
  const agent = loadAgents().find((a) => a.id === nasId);
  const token = agent ? agentToken(agent) : undefined;
  if (!agent || !token)
    return {
      ok: false,
      reason: tr(lang, {
        en: "NAS unknown or token missing.",
        fr: "NAS inconnu ou jeton absent.",
      }),
    };
  const read = await readPath(
    agent,
    token,
    `/report/month?month=${month}`,
    "GET",
    lang,
  );
  if (!read.ok)
    return {
      ok: false,
      reason:
        read.status === 404
          ? tr(lang, {
              en: "This agent does not keep monthly reports yet: update it.",
              fr: "Cet agent ne tient pas encore de bilan : le mettre à jour.",
            })
          : read.reason[lang],
    };
  const value = mapReport(read.data);
  return value
    ? { ok: true, value }
    : {
        ok: false,
        reason: tr(lang, {
          en: "Unexpected answer.",
          fr: "Réponse inattendue.",
        }),
      };
}

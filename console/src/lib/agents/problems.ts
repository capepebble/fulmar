import type { Texts } from "@/i18n";

// Les refus de l'API REST d'un agent (lecture ou action), courts : ils se glissent dans une
// phrase (« historique de l'agent illisible (403 : droit manquant) »). L'agent écrit son
// `detail` en anglais ; en français, la console traduit par le code (moteur en anglais, section 3).

const FRENCH: Record<string, string> = {
  unauthorized: "jeton refusé",
  rate_limited: "trop d'appels, nouvel essai dans une minute",
  forbidden: "droit manquant",
  not_found: "opération inconnue de cet agent",
  invalid_params: "paramètres refusés",
  unsupported: "non pris en charge par ce NAS",
  dsm_unreachable: "DSM ne répond pas",
  dsm_certificate: "le certificat de DSM a changé",
  dsm_error: "refus de DSM",
  internal: "erreur interne de l'agent",
  not_configured: "module des téléphones non configuré",
  // Mises à jour des paquets (2026-11-26).
  blocked: "DSM refuse la mise à jour",
  needs_confirmation: "DSM avertit, confirmation demandée",
  nothing_to_update: "rien à mettre à jour",
  busy: "une mise à jour est déjà en cours",
  unchecked: "DSM n'a pas dit ce que la mise à jour couperait",
  // Détacher un NAS (carte sur table, 2026-11-26).
  fleet_not_empty: "retirer d'abord les NAS ajoutés à ce hub",
  update_running: "une mise à jour est en cours, attendre sa fin",
  not_offered: "ce NAS ne se détache pas d'ici",
};

/** Le refus d'un agent par son statut HTTP et son code stable, en anglais et en français. */
export function agentProblem(status: number, code: string): Texts {
  const words = code.replace(/_/g, " ");
  return {
    en: `${status}: ${words}`,
    fr: `${status} : ${FRENCH[code] ?? words}`,
  };
}

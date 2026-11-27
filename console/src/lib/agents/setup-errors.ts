import type { Texts } from "@/i18n";

// Les refus de l'API d'installation de l'agent, dans la langue de la page : l'agent écrit son
// `detail` en anglais, la console traduit par le code (moteur en anglais, section 3).

/** Les motifs de refus de DSM à la connexion (code de l'API SYNO.API.Auth). */
const LOGIN_REASONS: Record<number, Texts> = {
  400: {
    en: "unknown account or wrong password",
    fr: "compte inconnu ou mot de passe faux",
  },
  401: { en: "account disabled", fr: "compte désactivé" },
  402: {
    en: "this account may not sign in",
    fr: "ce compte n'a pas le droit de se connecter",
  },
  404: {
    en: "wrong two-factor code",
    fr: "code de double authentification faux",
  },
  406: {
    en: "two-factor authentication is required for this account",
    fr: "la double authentification est imposée à ce compte",
  },
  407: {
    en: "address blocked by DSM after too many failures",
    fr: "adresse bloquée par DSM après trop d'échecs",
  },
  408: { en: "password expired", fr: "mot de passe expiré" },
  409: { en: "password expired", fr: "mot de passe expiré" },
  410: {
    en: "password to change in DSM",
    fr: "mot de passe à changer dans DSM",
  },
};

export interface SetupReply {
  status: number;
  code?: unknown;
  dsm_code?: unknown;
  detail?: unknown;
}

/** Le refus d'un appel d'installation, en anglais et en français. */
export function setupProblem(
  reply: SetupReply,
  at: { host: string; port: number },
): Texts {
  const where = `${at.host}:${at.port}`;
  switch (reply.code) {
    case "already_enrolled":
      return {
        en: "The agent is already linked to DSM.",
        fr: "L'agent est déjà relié à DSM.",
      };
    case "rate_limited":
      return {
        en: "Too many attempts: wait five minutes before trying again.",
        fr: "Trop d'essais : attendez cinq minutes avant de recommencer.",
      };
    case "forbidden":
      return {
        en: "This token may not link the agent.",
        fr: "Ce jeton n'a pas le droit d'enrôler l'agent.",
      };
    case "otp_required":
      return {
        en: "DSM asks for the two-factor code.",
        fr: "DSM demande le code de double authentification.",
      };
    case "login_failed": {
      const reason = (typeof reply.dsm_code === "number" &&
        LOGIN_REASONS[reply.dsm_code]) || {
        en: "no known reason",
        fr: "refus sans motif connu",
      };
      return {
        en: `DSM refused the sign-in: ${reason.en}.`,
        fr: `Connexion refusée par DSM : ${reason.fr}.`,
      };
    }
    case "dsm_unreachable":
      return {
        en: `DSM does not answer over HTTPS at ${where}.`,
        fr: `DSM ne répond pas en HTTPS à ${where}.`,
      };
    case "certificate_changed":
      return {
        en: "DSM's certificate changed since you confirmed it: read it and confirm it again.",
        fr: "Le certificat de DSM a changé depuis votre confirmation : relisez-le et confirmez-le.",
      };
    case "not_dsm":
      return {
        en: `${where} answers, but not as DSM: check the address and the port.`,
        fr: `${where} répond, mais pas comme DSM : vérifiez l'adresse et le port.`,
      };
    case "already_followed":
      return {
        en: "This NAS is already in the fleet.",
        fr: "Ce NAS est déjà dans le parc.",
      };
    case "fleet_full":
      return {
        en: "This hub follows as many NAS as it may (NAS_AGENT_FLEET_MAX).",
        fr: "Ce hub suit déjà autant de NAS qu'il le peut (NAS_AGENT_FLEET_MAX).",
      };
    case "not_found":
      return {
        en: "This hub does not follow this NAS.",
        fr: "Ce hub ne suit pas ce NAS.",
      };
  }
  if (reply.status === 422)
    return {
      en: "The address or the certificate name is not valid.",
      fr: "L'adresse ou le nom du certificat n'est pas valide.",
    };
  return {
    en:
      typeof reply.detail === "string"
        ? reply.detail
        : `The agent refused this request (${reply.status}).`,
    fr: `L'agent a refusé cette demande (${reply.status}).`,
  };
}

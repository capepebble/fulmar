import "server-only";

import { type Locale, tr } from "@/i18n";
import {
  type AccessView,
  accessError,
  type Detached,
  demoAccess,
  mapAccess,
  mapDetached,
} from "./access";
import { agentToken, LOCAL_AGENT_ID, loadAgents, tokenSource } from "./config";
import { readPath } from "./fetch";

// Carte sur table, côté serveur : agent.access lu à chaque demande par le jeton de la console,
// et agent.detach pour l'agent du projet seulement (jamais un NAS ajouté au hub, qui se retire
// du parc).

/** Ce que Fulmar fait sur un NAS ; un NAS fictif montre un exemple. */
export async function readAccess(
  nasId: string,
  live: boolean,
  lang: Locale,
): Promise<AccessView> {
  if (!live) return demoAccess(lang);
  const agent = loadAgents().find((a) => a.id === nasId);
  if (!agent)
    return {
      kind: "down",
      reason: tr(lang, {
        en: "NAS unknown to the console",
        fr: "NAS inconnu de la console",
      }),
    };
  const token = agentToken(agent);
  if (!token)
    return {
      kind: "denied",
      reason: tr(lang, {
        en: `token missing (${tokenSource(agent)})`,
        fr: `jeton absent (${tokenSource(agent)})`,
      }),
    };
  const read = await readPath(agent, token, "/agent/access", "GET", lang);
  return read.ok
    ? mapAccess(read.data)
    : accessError(read.status, read.reason[lang], lang);
}

export type DetachResult =
  | { ok: true; value: Detached }
  | { ok: false; reason: string };

/** Détache le NAS du projet : l'agent oublie DSM et revient en attente d'installation. */
export async function detachLocal(
  nasId: string,
  lang: Locale,
): Promise<DetachResult> {
  const agent = loadAgents().find(
    (a) => a.id === nasId && a.id === LOCAL_AGENT_ID && !a.member,
  );
  const token = agent ? agentToken(agent) : undefined;
  if (!agent || !token)
    return {
      ok: false,
      reason: tr(lang, {
        en: "Only the NAS that carries this project detaches from here.",
        fr: "Seul le NAS qui porte ce projet se détache d'ici.",
      }),
    };
  const read = await readPath(agent, token, "/agent/detach", "POST", lang);
  if (!read.ok) return { ok: false, reason: read.reason[lang] };
  const value = mapDetached(read.data);
  return value
    ? { ok: true, value }
    : {
        ok: false,
        reason: tr(lang, {
          en: "Unexpected answer from the agent.",
          fr: "Réponse inattendue de l'agent.",
        }),
      };
}

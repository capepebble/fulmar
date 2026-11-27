import "server-only";

import { type Locale, tr } from "@/i18n";
import { agentToken, loadAgents, tokenSource } from "./config";
import { readPath } from "./fetch";
import {
  DEVICE_ID,
  demoPhones,
  mapOffer,
  mapPhones,
  type PairingOffer,
  type PhonesView,
  phonesError,
} from "./phones";
import type { AgentConfig } from "./types";

// Téléphones d'un NAS, côté serveur : lus à chaque demande (jamais gardés : un code
// d'appairage ne doit vivre que sur la page qui l'affiche), par le jeton de la console.

function agentOf(nasId: string): AgentConfig | undefined {
  return loadAgents().find((a) => a.id === nasId);
}

function tokenOf(agent: AgentConfig): string | undefined {
  return agentToken(agent);
}

/** Les téléphones d'un NAS ; un NAS fictif (sans agent dans agents.json) en a de fictifs. */
export async function readPhones(
  nasId: string,
  live: boolean,
  lang: Locale,
): Promise<PhonesView> {
  if (!live) return demoPhones(new Date(), lang);
  const agent = agentOf(nasId);
  if (!agent)
    return {
      kind: "down",
      reason: tr(lang, {
        en: "NAS unknown to the console",
        fr: "NAS inconnu de la console",
      }),
    };
  const token = tokenOf(agent);
  if (!token)
    return {
      kind: "denied",
      reason: tr(lang, {
        en: `token missing (${tokenSource(agent)})`,
        fr: `jeton absent (${tokenSource(agent)})`,
      }),
    };
  const read = await readPath(agent, token, "/devices", "GET", lang);
  return read.ok
    ? mapPhones(read.data, lang)
    : phonesError(read.status, read.reason[lang], lang);
}

function unknownNas(lang: Locale): string {
  return tr(lang, {
    en: "NAS unknown or token missing.",
    fr: "NAS inconnu ou jeton absent.",
  });
}

export type PairResult =
  | { ok: true; offer: PairingOffer }
  | { ok: false; reason: string };

export async function openPairing(
  nasId: string,
  lang: Locale,
): Promise<PairResult> {
  const agent = agentOf(nasId);
  const token = agent ? tokenOf(agent) : undefined;
  if (!agent || !token) return { ok: false, reason: unknownNas(lang) };
  const read = await readPath(agent, token, "/devices/pair", "POST", lang);
  if (!read.ok) {
    const view = phonesError(read.status, read.reason[lang], lang);
    return {
      ok: false,
      reason: "reason" in view ? view.reason : read.reason[lang],
    };
  }
  const offer = mapOffer(read.data);
  return offer
    ? { ok: true, offer }
    : {
        ok: false,
        reason: tr(lang, {
          en: "Unexpected answer from the agent.",
          fr: "Réponse inattendue de l'agent.",
        }),
      };
}

export async function revokePhone(
  nasId: string,
  deviceId: string,
  lang: Locale,
): Promise<{ ok: boolean; reason?: string }> {
  if (!DEVICE_ID.test(deviceId))
    return {
      ok: false,
      reason: tr(lang, {
        en: "Invalid identifier.",
        fr: "Identifiant invalide.",
      }),
    };
  const agent = agentOf(nasId);
  const token = agent ? tokenOf(agent) : undefined;
  if (!agent || !token) return { ok: false, reason: unknownNas(lang) };
  const read = await readPath(
    agent,
    token,
    `/devices/revoke?device=${deviceId}`,
    "POST",
    lang,
  );
  if (!read.ok) return { ok: false, reason: read.reason[lang] };
  return { ok: (read.data as { revoked?: unknown } | null)?.revoked === true };
}

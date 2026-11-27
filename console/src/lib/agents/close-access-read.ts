import "server-only";

import { type Locale, tr } from "@/i18n";
import {
  type AccessChange,
  type AccessService,
  changePath,
  demoWatch,
  mapServiceWatch,
  mapWatch,
  type ServiceWatch,
  type WatchView,
  watchError,
} from "./close-access";
import { agentToken, loadAgents } from "./config";
import { readPath } from "./fetch";

// Fermer un accès resté ouvert, côté serveur (conception 2026-11-26-fermer-acces) : chaque
// appel passe par le jeton de la console, qui doit avoir le droit access:close pour agir.

function agentOf(nasId: string) {
  const agent = loadAgents().find((a) => a.id === nasId);
  const token = agent ? agentToken(agent) : undefined;
  return agent && token ? { agent, token } : null;
}

export async function readWatch(
  nasId: string,
  live: boolean,
  lang: Locale,
): Promise<WatchView> {
  if (!live) return demoWatch(new Date());
  const found = agentOf(nasId);
  if (!found)
    return {
      kind: "down",
      reason: tr(lang, {
        en: "NAS unknown or token missing.",
        fr: "NAS inconnu ou jeton absent.",
      }),
    };
  const read = await readPath(
    found.agent,
    found.token,
    "/access/watch",
    "GET",
    lang,
  );
  return read.ok
    ? mapWatch(read.data)
    : watchError(read.status, read.reason[lang], lang);
}

export type { AccessChange };

export type ChangeResult =
  | { ok: true; value: ServiceWatch }
  | { ok: false; reason: string };

export async function changeAccess(
  nasId: string,
  service: AccessService,
  change: AccessChange,
  lang: Locale,
): Promise<ChangeResult> {
  const path = changePath(service, change);
  const found = agentOf(nasId);
  if (!path || !found)
    return {
      ok: false,
      reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
    };
  const read = await readPath(found.agent, found.token, path, "POST", lang);
  if (!read.ok) return { ok: false, reason: read.reason[lang] };
  const value = mapServiceWatch(read.data);
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

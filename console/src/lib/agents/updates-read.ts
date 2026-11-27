import "server-only";

import { type Locale, tr } from "@/i18n";
import { agentToken, loadAgents } from "./config";
import { readPath } from "./fetch";
import {
  mapProtections,
  type ProtectionChange,
  type ProtectionsView,
  protectQuery,
} from "./protections";

export type { ProtectionChange };

import {
  type DsmPlan,
  mapDsmPlan,
  mapJob,
  mapJobs,
  mapPlan,
  mapScheduled,
  type Scheduled,
  type UpdateJob,
  type UpdatePlan,
  type UpdatesState,
} from "./updates";

// Mises à jour des paquets et de DSM, côté serveur : chaque appel passe par le jeton de la
// console, qui doit avoir le droit packages:update (et dsm:update pour DSM). Rien n'est gardé :
// la page relit l'état.

export type UpdateResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function agentOf(nasId: string) {
  const agent = loadAgents().find((a) => a.id === nasId);
  const token = agent ? agentToken(agent) : undefined;
  return agent && token ? { agent, token } : null;
}

function unknown(lang: Locale): { ok: false; reason: string } {
  return {
    ok: false,
    reason: tr(lang, {
      en: "NAS unknown or token missing.",
      fr: "NAS inconnu ou jeton absent.",
    }),
  };
}

function unexpected(lang: Locale): { ok: false; reason: string } {
  return {
    ok: false,
    reason: tr(lang, { en: "Unexpected answer.", fr: "Réponse inattendue." }),
  };
}

async function call<T>(
  nasId: string,
  path: string,
  method: "GET" | "POST",
  lang: Locale,
  map: (data: unknown) => T | null,
): Promise<UpdateResult<T>> {
  const found = agentOf(nasId);
  if (!found) return unknown(lang);
  const read = await readPath(found.agent, found.token, path, method, lang);
  if (!read.ok) return { ok: false, reason: read.reason[lang] };
  const value = map(read.data);
  return value === null ? unexpected(lang) : { ok: true, value };
}

export async function checkUpdates(
  nasId: string,
  ids: string[],
  lang: Locale,
): Promise<UpdateResult<UpdatePlan>> {
  if (!ids.length) return unknown(lang);
  const query = `?packages=${encodeURIComponent(ids.join(","))}`;
  return call(nasId, `/packages/update/check${query}`, "GET", lang, mapPlan);
}

export async function startUpdates(
  nasId: string,
  ids: string[],
  acceptWarnings: boolean,
  lang: Locale,
): Promise<UpdateResult<UpdateJob>> {
  if (!ids.length) return unknown(lang);
  const accept = acceptWarnings ? "&accept_warnings=true" : "";
  const query = `?packages=${encodeURIComponent(ids.join(","))}${accept}`;
  return call(nasId, `/packages/update${query}`, "POST", lang, mapJob);
}

export async function updateStatus(
  nasId: string,
  lang: Locale,
): Promise<UpdateResult<UpdatesState>> {
  return call(nasId, "/updates/status", "GET", lang, mapJobs);
}

export async function checkDsm(
  nasId: string,
  lang: Locale,
): Promise<UpdateResult<DsmPlan>> {
  return call(nasId, "/dsm/update/check", "GET", lang, mapDsmPlan);
}

export async function startDsm(
  nasId: string,
  acceptWarnings: boolean,
  lang: Locale,
): Promise<UpdateResult<UpdateJob>> {
  const query = acceptWarnings ? "?accept_warnings=true" : "";
  return call(nasId, `/dsm/update/run${query}`, "POST", lang, mapJob);
}

export async function scheduleUpdate(
  nasId: string,
  target: "packages" | "dsm",
  ids: string[],
  at: string,
  acceptWarnings: boolean,
  lang: Locale,
): Promise<UpdateResult<Scheduled>> {
  if (target === "packages" && !ids.length) return unknown(lang);
  const params = new URLSearchParams({ target, at });
  if (target === "packages") params.set("packages", ids.join(","));
  if (acceptWarnings) params.set("accept_warnings", "true");
  return call(nasId, `/updates/schedule?${params}`, "POST", lang, mapScheduled);
}

export async function unscheduleUpdate(
  nasId: string,
  id: string,
  lang: Locale,
): Promise<UpdateResult<boolean>> {
  if (!/^[0-9a-f]{8}$/.test(id)) return unknown(lang);
  return call(nasId, `/updates/unschedule?id=${id}`, "POST", lang, (data) =>
    typeof data === "object" && data !== null
      ? (data as { cancelled?: unknown }).cancelled === true
      : null,
  );
}

// Protections (conception 2026-11-26-groupes-protections-parc, section 2) : lues et changées
// sur l'agent du NAS, qui les applique.

export async function readProtections(
  nasId: string,
  lang: Locale,
): Promise<UpdateResult<ProtectionsView>> {
  return call(nasId, "/updates/protections", "GET", lang, mapProtections);
}

export async function protectNas(
  nasId: string,
  change: ProtectionChange,
  lang: Locale,
): Promise<UpdateResult<ProtectionsView>> {
  const query = protectQuery(change);
  if (!query) return unknown(lang);
  return call(nasId, `/updates/protect${query}`, "POST", lang, mapProtections);
}

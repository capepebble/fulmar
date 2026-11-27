"use server";

import { revalidatePath } from "next/cache";
import { tr } from "@/i18n";
import { isLocale } from "@/i18n/locales";
import { type DetachResult, detachLocal } from "@/lib/agents/access-read";
import type { AccessService, WatchView } from "@/lib/agents/close-access";
import {
  type AccessChange,
  type ChangeResult,
  changeAccess,
  readWatch,
} from "@/lib/agents/close-access-read";
import { loadAgents } from "@/lib/agents/config";
import type { PhonesView } from "@/lib/agents/phones";
import {
  openPairing,
  type PairResult,
  readPhones,
  revokePhone,
} from "@/lib/agents/phones-read";
import type { ProtectionsView } from "@/lib/agents/protections";
import { forgetReads } from "@/lib/agents/read";
import { mapRollouts, type Rollout } from "@/lib/agents/rollouts";
import {
  cancelFleetRollout,
  fleetRollouts,
  planFleetRollout,
  removeFromFleet,
} from "@/lib/agents/setup";
import type {
  DsmPlan,
  Scheduled,
  UpdateJob,
  UpdatePlan,
  UpdatesState,
} from "@/lib/agents/updates";
import { packageIds } from "@/lib/agents/updates";
import {
  checkDsm,
  checkUpdates,
  type ProtectionChange,
  protectNas,
  readProtections,
  scheduleUpdate,
  startDsm,
  startUpdates,
  type UpdateResult,
  unscheduleUpdate,
  updateStatus,
} from "@/lib/agents/updates-read";
import { requireSession } from "@/lib/auth/guard";
import { beszel } from "@/lib/beszel/client";
import { listNasIds } from "@/lib/fleet";
import {
  cleanFolderName,
  FOLDER_ID,
  FOLDER_KINDS,
  type FolderKind,
} from "@/lib/fleet/folders";
import { memory } from "@/lib/store/memory";

// Toute action passe par le contrôle d'accès de src/proxy.ts, comme les pages, et vérifie en plus
// la session dans la console du projet (requireSession : une action se joint par son identifiant
// depuis n'importe quelle page, /connexion comprise). Les identifiants reçus sont revérifiés ici.

/** « Relire » : oublie les lectures gardées en mémoire, celles des agents (historiques
 * compris) comme celles de Beszel ; la page relit alors les uns et l'autre. */
export async function reread(): Promise<void> {
  await requireSession();
  forgetReads();
  beszel()?.forget();
}

/** Ouvre un code d'appairage de 10 minutes sur l'agent du NAS (devices.pair). */
export async function pairPhone(
  nasId: string,
  locale?: string,
): Promise<PairResult> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  return openPairing(nasId, lang);
}

/** Les téléphones du NAS, relus pendant qu'un QR code est affiché. */
export async function phonesOf(
  nasId: string,
  locale?: string,
): Promise<PhonesView> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      kind: "down",
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  return readPhones(nasId, true, lang);
}

/** Retire un téléphone appairé (devices.revoke). */
export async function forgetPhone(
  nasId: string,
  deviceId: string,
  locale?: string,
): Promise<{ ok: boolean; reason?: string }> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || typeof deviceId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
    };
  return revokePhone(nasId, deviceId, lang);
}

/** Ce que DSM dit avant de mettre à jour ces paquets (packages.update_check). */
export async function checkPackageUpdates(
  nasId: string,
  ids: string[],
  locale?: string,
): Promise<UpdateResult<UpdatePlan>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  return checkUpdates(nasId, packageIds(ids), lang);
}

/** Lance la mise à jour de ces paquets (packages.update) ; l'agent revérifie tout. */
export async function startPackageUpdates(
  nasId: string,
  ids: string[],
  acceptWarnings: boolean,
  locale?: string,
): Promise<UpdateResult<UpdateJob>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  const result = await startUpdates(
    nasId,
    packageIds(ids),
    acceptWarnings === true,
    lang,
  );
  forgetReads();
  return result;
}

/** L'avancement des mises à jour d'un NAS et ses rendez-vous (updates.status). */
export async function packageUpdateStatus(
  nasId: string,
  locale?: string,
): Promise<UpdateResult<UpdatesState>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  const result = await updateStatus(nasId, lang);
  if (result.ok && !result.value.running) forgetReads();
  return result;
}

const unknownNas = (lang: "en" | "fr") => ({
  ok: false as const,
  reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
});

/** Ce que DSM dit avant d'installer sa mise à jour (dsm.update_check). */
export async function checkDsmUpdate(
  nasId: string,
  locale?: string,
): Promise<UpdateResult<DsmPlan>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string") return unknownNas(lang);
  return checkDsm(nasId, lang);
}

/** Lance la mise à jour de DSM (dsm.update_run) : le NAS redémarre. */
export async function startDsmUpdate(
  nasId: string,
  acceptWarnings: boolean,
  locale?: string,
): Promise<UpdateResult<UpdateJob>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string") return unknownNas(lang);
  const result = await startDsm(nasId, acceptWarnings === true, lang);
  forgetReads();
  return result;
}

/** Programme une mise à jour de paquets ou de DSM (updates.schedule). */
export async function scheduleNasUpdate(
  nasId: string,
  target: "packages" | "dsm",
  ids: string[],
  at: string,
  acceptWarnings: boolean,
  locale?: string,
): Promise<UpdateResult<Scheduled>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || (target !== "packages" && target !== "dsm"))
    return unknownNas(lang);
  const when = typeof at === "string" ? new Date(at) : null;
  if (!when || Number.isNaN(when.getTime()))
    return {
      ok: false,
      reason: tr(lang, { en: "Invalid date.", fr: "Date invalide." }),
    };
  return scheduleUpdate(
    nasId,
    target,
    packageIds(ids),
    when.toISOString(),
    acceptWarnings === true,
    lang,
  );
}

/** Retire une mise à jour programmée (updates.unschedule). */
export async function cancelScheduledUpdate(
  nasId: string,
  id: string,
  locale?: string,
): Promise<UpdateResult<boolean>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || typeof id !== "string")
    return unknownNas(lang);
  return unscheduleUpdate(nasId, id, lang);
}

/** Suivre ou ne plus suivre un contrôle, sur un NAS ou sur tout le parc (« * ») : une
 * préférence de la console, jamais une action sur le NAS. */
export async function setFollow(
  scope: string,
  checkId: string,
  follow: boolean,
  locale?: string,
): Promise<{ ok: boolean; reason?: string }> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (
    typeof scope !== "string" ||
    typeof checkId !== "string" ||
    typeof follow !== "boolean" ||
    !/^[a-z_]+\.[a-z_]+$/.test(checkId) ||
    (scope !== "*" && !listNasIds().includes(scope))
  )
    return {
      ok: false,
      reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
    };
  if (!memory().persistent)
    return {
      ok: false,
      reason: tr(lang, {
        en: "The console has no memory (NAS_CONSOLE_MEMORY_FILE): the choice cannot be kept.",
        fr: "La console n'a pas de mémoire (NAS_CONSOLE_MEMORY_FILE) : le choix ne peut pas être retenu.",
      }),
    };
  memory().setFollow(scope, checkId, follow);
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Détache de Fulmar le NAS qui porte ce projet (agent.detach) : l'agent retire les
 * téléphones, révoque les jetons sauf celui de la console, oublie DSM et attend une nouvelle
 * installation. Rien ne change dans DSM : la page dit quoi y faire pour finir. */
export async function detachNas(
  nasId: string,
  locale?: string,
): Promise<DetachResult> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string")
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  const result = await detachLocal(nasId, lang);
  if (result.ok) {
    forgetReads();
    revalidatePath("/", "layout");
  }
  return result;
}

/** Retire du parc un NAS ajouté au hub : l'agent l'arrête et efface ses identifiants, son
 * historique et ses téléphones ; la console oublie sa mémoire. Jamais le NAS du hub. */
export async function removeNas(
  nasId: string,
  locale?: string,
): Promise<{ ok: boolean; reason?: string }> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  const member =
    typeof nasId === "string"
      ? loadAgents().find((a) => a.id === nasId && a.member)
      : undefined;
  if (!member)
    return {
      ok: false,
      reason: tr(lang, {
        en: "This NAS was not added to this hub.",
        fr: "Ce NAS n'a pas été ajouté à ce hub.",
      }),
    };
  const result = await removeFromFleet(member.id);
  if (!result.ok) return { ok: false, reason: result.error[lang] };
  memory().forget(member.id);
  forgetReads();
  revalidatePath("/", "layout");
  return { ok: true };
}

// Les groupes de NAS (conception 2026-11-26-groupes-protections-parc, section 1) : gardés dans
// la mémoire de la console ; chaque identifiant et chaque nom reçus sont revérifiés ici.

type GroupResult = { ok: boolean; reason?: string };

/** Après `requireSession()` : la langue, et le refus d'une console sans mémoire. */
function groupGuard(locale?: string) {
  const lang = isLocale(locale) ? locale : "en";
  if (!memory().persistent)
    return {
      lang,
      refused: {
        ok: false,
        reason: tr(lang, {
          en: "The console has no memory (NAS_CONSOLE_MEMORY_FILE): groups cannot be kept.",
          fr: "La console n'a pas de mémoire (NAS_CONSOLE_MEMORY_FILE) : les groupes ne peuvent pas être gardés.",
        }),
      } as GroupResult,
    };
  return { lang, refused: null };
}

function invalid(lang: "en" | "fr"): GroupResult {
  return {
    ok: false,
    reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
  };
}

function isKind(kind: unknown): kind is FolderKind {
  return FOLDER_KINDS.includes(kind as FolderKind);
}

function knownFolder(id: unknown): id is string {
  return (
    typeof id === "string" &&
    FOLDER_ID.test(id) &&
    memory()
      .folders()
      .some((f) => f.id === id)
  );
}

function groupsChanged(): GroupResult {
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function createGroup(
  name: string,
  kind: string,
  locale?: string,
): Promise<GroupResult> {
  await requireSession();
  const { lang, refused } = groupGuard(locale);
  if (refused) return refused;
  const clean = cleanFolderName(name);
  if (!clean || !isKind(kind))
    return {
      ok: false,
      reason: tr(lang, {
        en: "A group name has 1 to 40 characters.",
        fr: "Un nom de groupe a de 1 à 40 caractères.",
      }),
    };
  if (memory().folders().length >= 200) return invalid(lang);
  memory().createFolder(clean, kind);
  return groupsChanged();
}

export async function updateGroup(
  id: string,
  change: { name?: string; kind?: string },
  locale?: string,
): Promise<GroupResult> {
  await requireSession();
  const { lang, refused } = groupGuard(locale);
  if (refused) return refused;
  if (!knownFolder(id) || typeof change !== "object" || change === null)
    return invalid(lang);
  const name =
    change.name === undefined ? undefined : cleanFolderName(change.name);
  if (name === null) return invalid(lang);
  if (change.kind !== undefined && !isKind(change.kind)) return invalid(lang);
  memory().updateFolder(id, {
    name,
    kind: change.kind as FolderKind | undefined,
  });
  return groupsChanged();
}

export async function moveGroup(
  id: string,
  step: number,
  locale?: string,
): Promise<GroupResult> {
  await requireSession();
  const { lang, refused } = groupGuard(locale);
  if (refused) return refused;
  if (!knownFolder(id) || (step !== -1 && step !== 1)) return invalid(lang);
  memory().moveFolder(id, step);
  return groupsChanged();
}

export async function deleteGroup(
  id: string,
  locale?: string,
): Promise<GroupResult> {
  await requireSession();
  const { lang, refused } = groupGuard(locale);
  if (refused) return refused;
  if (!knownFolder(id)) return invalid(lang);
  memory().deleteFolder(id);
  return groupsChanged();
}

export async function assignGroup(
  nasId: string,
  folderId: string | null,
  locale?: string,
): Promise<GroupResult> {
  await requireSession();
  const { lang, refused } = groupGuard(locale);
  if (refused) return refused;
  if (typeof nasId !== "string" || !listNasIds().includes(nasId))
    return invalid(lang);
  if (folderId !== null && !knownFolder(folderId)) return invalid(lang);
  memory().setNasFolder(nasId, folderId);
  return groupsChanged();
}

// Fermer un accès resté ouvert (conception 2026-11-26-fermer-acces) : fermer maintenant,
// prolonger, choisir la règle ; l'agent revérifie le droit access:close.

export async function accessWatchOf(
  nasId: string,
  locale?: string,
): Promise<WatchView> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || !listNasIds().includes(nasId))
    return {
      kind: "down",
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  return readWatch(nasId, true, lang);
}

export async function changeNasAccess(
  nasId: string,
  service: AccessService,
  change: AccessChange,
  locale?: string,
): Promise<ChangeResult> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || !listNasIds().includes(nasId))
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  const result = await changeAccess(nasId, service, change, lang);
  if (result.ok) forgetReads();
  return result;
}

// Protections et mises à jour du parc (conception 2026-11-26-groupes-protections-parc).

export async function nasProtections(
  nasId: string,
  locale?: string,
): Promise<UpdateResult<ProtectionsView>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || !listNasIds().includes(nasId))
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  return readProtections(nasId, lang);
}

export async function changeProtections(
  nasId: string,
  change: ProtectionChange,
  locale?: string,
): Promise<UpdateResult<ProtectionsView>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof nasId !== "string" || !listNasIds().includes(nasId))
    return {
      ok: false,
      reason: tr(lang, { en: "Unknown NAS.", fr: "NAS inconnu." }),
    };
  const result = await protectNas(nasId, change, lang);
  if (result.ok) revalidatePath("/updates");
  return result;
}

export async function rolloutsOf(
  locale?: string,
): Promise<UpdateResult<{ running: boolean; rollouts: Rollout[] }>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  const got = await fleetRollouts();
  return got.ok
    ? { ok: true, value: mapRollouts(got.body) }
    : { ok: false, reason: got.error[lang] };
}

const ROLLOUT_NAS = /^(hub|[0-9a-f]{8})$/;

export async function planRollout(
  input: {
    target: string;
    nas: string[];
    at: string | null;
    acceptWarnings: boolean;
  },
  locale?: string,
): Promise<UpdateResult<Rollout>> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  const bad = {
    ok: false as const,
    reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
  };
  if (
    !input ||
    (input.target !== "packages" && input.target !== "dsm") ||
    !Array.isArray(input.nas) ||
    input.nas.length === 0 ||
    input.nas.length > 501 ||
    !input.nas.every((n) => typeof n === "string" && ROLLOUT_NAS.test(n)) ||
    (input.at !== null &&
      (typeof input.at !== "string" || Number.isNaN(Date.parse(input.at))))
  )
    return bad;
  const got = await planFleetRollout({
    target: input.target,
    nas: input.nas,
    at: input.at ? new Date(input.at).toISOString() : null,
    acceptWarnings: input.acceptWarnings === true,
  });
  if (!got.ok) return { ok: false, reason: got.error[lang] };
  const [rollout] = mapRollouts({ rollouts: [got.body] }).rollouts;
  forgetReads();
  return rollout ? { ok: true, value: rollout } : bad;
}

export async function cancelRollout(
  id: string,
  locale?: string,
): Promise<{ ok: boolean; reason?: string }> {
  await requireSession();
  const lang = isLocale(locale) ? locale : "en";
  if (typeof id !== "string" || !/^[0-9a-f]{8}$/.test(id))
    return {
      ok: false,
      reason: tr(lang, { en: "Invalid request.", fr: "Requête invalide." }),
    };
  const got = await cancelFleetRollout(id);
  return got.ok ? { ok: true } : { ok: false, reason: got.error?.[lang] };
}

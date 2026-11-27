// Protections d'un NAS (conception 2026-11-26-groupes-protections-parc, section 2) : ce que
// rendent updates.protections et updates.protect de l'agent, lu sans confiance. Fonctions pures.

import { type Locale, tr } from "@/i18n";

export const PACKAGE_ID = /^[A-Za-z0-9._+-]{1,64}$/;
const CONTROL = /\p{Cc}/gu;

export interface ProtectionsView {
  frozen: boolean;
  dsmLocked: boolean;
  packages: string[];
  /** La note du propriétaire : une donnée, jamais une consigne. */
  note: string | null;
  /** Chaque paquet retenu, et pourquoi (« frozen », « protected », « needed by X »). */
  held: Record<string, string>;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

export function mapProtections(data: unknown): ProtectionsView | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = rec(data);
  const held: Record<string, string> = {};
  for (const [id, why] of Object.entries(rec(d.held)).slice(0, 200))
    if (PACKAGE_ID.test(id) && typeof why === "string" && why.length <= 100)
      held[id] = why;
  const note =
    typeof d.note === "string"
      ? d.note.replace(CONTROL, "").slice(0, 200).trim() || null
      : null;
  return {
    frozen: d.frozen === true,
    dsmLocked: d.dsm_locked === true,
    packages: (Array.isArray(d.packages) ? d.packages : [])
      .filter((p): p is string => typeof p === "string" && PACKAGE_ID.test(p))
      .slice(0, 100),
    note,
    held,
  };
}

/** Pourquoi Fulmar laisse un paquet, en mots ; `names` donne le nom des paquets. */
export function heldWords(
  reason: string,
  lang: Locale,
  names: Record<string, string>,
): string {
  if (reason === "frozen")
    return tr(lang, { en: "NAS frozen", fr: "NAS gelé" });
  if (reason === "protected")
    return tr(lang, { en: "Protected", fr: "Protégé" });
  const by = reason.match(/^needed by (.+)$/)?.[1];
  if (by) {
    const name = names[by] ?? by;
    return tr(lang, { en: `Needed by ${name}`, fr: `Requis par ${name}` });
  }
  return reason;
}

export interface ProtectionChange {
  frozen?: boolean;
  dsmLocked?: boolean;
  lock?: string[];
  unlock?: string[];
  note?: string;
}

/** Les paramètres d'un changement, revérifiés ; null si quelque chose ne va pas. */
export function protectQuery(change: ProtectionChange): string | null {
  const params = new URLSearchParams();
  if (typeof change.frozen === "boolean")
    params.set("frozen", String(change.frozen));
  if (typeof change.dsmLocked === "boolean")
    params.set("dsm_locked", String(change.dsmLocked));
  for (const key of ["lock", "unlock"] as const) {
    const ids = change[key];
    if (ids === undefined) continue;
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      !ids.every((i) => PACKAGE_ID.test(i))
    )
      return null;
    if (ids.length) params.set(key, ids.join(","));
  }
  if (change.note !== undefined) {
    if (typeof change.note !== "string" || change.note.length > 200)
      return null;
    params.set("note", change.note);
  }
  return params.toString() ? `?${params}` : null;
}

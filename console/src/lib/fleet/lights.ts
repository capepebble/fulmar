// Les voyants d'un NAS (conception 2026-11-24, section 2) : un par catégorie de contrôles
// présente, le pire de ses contrôles suivis ; et l'anneau, la part de vert sur ce qu'on suit.

import { type Locale, type Texts, tr } from "@/i18n";
import { counts } from "./state";
import type { CategoryId, Nas, Status } from "./types";

export type Light = Status | "muted";

/** Ordre de lecture : ce qui fait perdre des données d'abord. */
export const LIGHT_ORDER: CategoryId[] = [
  "backup",
  "storage",
  "system",
  "updates",
  "security_advisor",
  "access",
  "accounts",
  "certificates",
  "containers",
  "ups",
  "shares",
];

export const LIGHT_LABEL: Record<CategoryId, Texts> = {
  system: { en: "System", fr: "Système" },
  containers: { en: "Containers", fr: "Conteneurs" },
  backup: { en: "Backups", fr: "Sauvegardes" },
  storage: { en: "Storage", fr: "Stockage" },
  updates: { en: "Updates", fr: "Mises à jour" },
  security_advisor: { en: "Security Advisor", fr: "Security Advisor" },
  access: { en: "Access", fr: "Accès" },
  accounts: { en: "Accounts", fr: "Comptes" },
  certificates: { en: "Certificates", fr: "Certificats" },
  ups: { en: "UPS", fr: "Onduleur" },
  shares: { en: "Shares", fr: "Partages" },
};

export const LIGHT_WORD: Record<Light, Texts> = {
  failed: { en: "Failed", fr: "En échec" },
  warning: { en: "Warning", fr: "À surveiller" },
  ok: { en: "OK", fr: "OK" },
  unknown: { en: "Unknown", fr: "Inconnu" },
  muted: { en: "Not followed", fr: "Non suivi" },
};

export interface CategoryLight {
  id: CategoryId;
  light: Light;
  /** Contrôles de la catégorie, suivis ou non. */
  total: number;
  /** Contrôles suivis qui comptent (« à titre indicatif » exclus). */
  counted: number;
}

const WORST: Status[] = ["failed", "warning", "unknown"];

export function lights(nas: Nas): CategoryLight[] {
  const out: CategoryLight[] = [];
  for (const id of LIGHT_ORDER) {
    const all = nas.checks.filter((c) => c.category === id);
    if (all.length === 0) continue;
    const followed = all.filter((c) => c.followed !== false);
    const counted = all.filter(counts);
    let light: Light;
    if (followed.length === 0) light = "muted";
    else light = WORST.find((s) => counted.some((c) => c.status === s)) ?? "ok";
    out.push({ id, light, total: all.length, counted: counted.length });
  }
  return out;
}

/** L'anneau : contrôles suivis qui comptent, et combien sont verts. */
export function greenShare(nas: Nas): { ok: number; total: number } {
  const counted = nas.checks.filter(counts);
  return {
    ok: counted.filter((c) => c.status === "ok").length,
    total: counted.length,
  };
}

/** La phrase de l'anneau : « Tout ce que vous suivez est vert. », « 10 contrôles verts sur 18
 * suivis ». */
export function greenSentence(ok: number, total: number, lang: Locale): string {
  if (total === 0)
    return tr(lang, { en: "No check followed", fr: "Aucun contrôle suivi" });
  if (ok === total)
    return tr(lang, {
      en: "Everything you follow is green.",
      fr: "Tout ce que vous suivez est vert.",
    });
  return tr(lang, {
    en: `${ok} green ${ok === 1 ? "check" : "checks"} out of ${total} followed`,
    fr: `${ok} ${ok > 1 ? "contrôles verts" : "contrôle vert"} sur ${total} suivis`,
  });
}

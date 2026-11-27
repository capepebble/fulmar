// Navigation de la console : pages du parc et sections d'un NAS.

import type { Texts } from "@/i18n";

export const FLEET_PAGES: readonly {
  href: "/" | "/issues" | "/backups" | "/updates" | "/reports";
  label: Texts;
}[] = [
  { href: "/", label: { en: "Fleet", fr: "Le parc" } },
  { href: "/issues", label: { en: "To handle", fr: "À traiter" } },
  { href: "/backups", label: { en: "Backups", fr: "Sauvegardes" } },
  { href: "/updates", label: { en: "Updates", fr: "Mises à jour" } },
  { href: "/reports", label: { en: "Reports", fr: "Bilans" } },
];

export const NAS_SECTIONS: readonly { slug: string; label: Texts }[] = [
  { slug: "", label: { en: "Overview", fr: "Synthèse" } },
  { slug: "checks", label: { en: "Checks", fr: "Points" } },
  { slug: "storage", label: { en: "Storage", fr: "Stockage" } },
  { slug: "backups", label: { en: "Backups", fr: "Sauvegardes" } },
  { slug: "security", label: { en: "Security", fr: "Sécurité" } },
  { slug: "activity", label: { en: "Activity", fr: "Activité" } },
  { slug: "system", label: { en: "System", fr: "Système" } },
  { slug: "access", label: { en: "Access", fr: "Accès" } },
  { slug: "phones", label: { en: "Phones", fr: "Téléphones" } },
];

export function nasHref(id: string, slug = ""): string {
  return `/nas/${id}${slug ? `/${slug}` : ""}`;
}

/** Où mène un point : le contrôle sur la page du NAS, ou le NAS lui-même. */
export function issueHref(nasId: string, checkId: string | null): string {
  return checkId ? `${nasHref(nasId, "checks")}#${checkId}` : nasHref(nasId);
}

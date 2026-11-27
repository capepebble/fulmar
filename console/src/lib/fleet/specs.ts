import type { Locale, Texts } from "@/i18n";
import { AGENT_ORDER, MORE_DEFS } from "./specs-more";
import type { CategoryId, Check, Severity, Status } from "./types";

// Les 42 contrôles de l'opération audit.checks, dans l'ordre de l'agent, dans les deux langues
// (mêmes textes que l'agent) : ils servent quand l'agent ne répond pas, et au parc fictif.
// Les 21 du 2026-11-26 vivent dans specs-more.

const CATEGORY_DEFS: { id: CategoryId; label: Texts; short: Texts }[] = [
  {
    id: "system",
    label: { en: "System", fr: "Système" },
    short: { en: "Sys.", fr: "Sys." },
  },
  {
    id: "updates",
    label: { en: "Updates", fr: "Mises à jour" },
    short: { en: "Upd.", fr: "Màj" },
  },
  {
    id: "accounts",
    label: { en: "Accounts", fr: "Comptes" },
    short: { en: "Accounts", fr: "Comptes" },
  },
  {
    id: "access",
    label: { en: "Access", fr: "Accès" },
    short: { en: "Access", fr: "Accès" },
  },
  {
    id: "certificates",
    label: { en: "Certificates", fr: "Certificats" },
    short: { en: "Cert.", fr: "Cert." },
  },
  {
    id: "backup",
    label: { en: "Backups", fr: "Sauvegardes" },
    short: { en: "Backup", fr: "Sauveg." },
  },
  {
    id: "storage",
    label: { en: "Storage", fr: "Stockage" },
    short: { en: "Stor.", fr: "Stock." },
  },
  {
    id: "containers",
    label: { en: "Containers", fr: "Conteneurs" },
    short: { en: "Cont.", fr: "Cont." },
  },
  {
    id: "ups",
    label: { en: "UPS", fr: "Onduleur" },
    short: { en: "UPS", fr: "Ond." },
  },
  {
    id: "security_advisor",
    label: { en: "Security Advisor", fr: "Security Advisor" },
    short: { en: "Advisor", fr: "Advisor" },
  },
  {
    id: "shares",
    label: { en: "Shares", fr: "Partages" },
    short: { en: "Shares", fr: "Part." },
  },
];

export function categoryLabel(id: CategoryId, lang: Locale): string {
  return CATEGORY_DEFS.find((c) => c.id === id)?.label[lang] ?? id;
}

interface Spec {
  id: string;
  title: string;
  short: string;
  severity: Severity;
  expected: string;
  advice: string;
  sources: string[];
}

export interface SpecDef {
  id: string;
  title: Texts;
  short: Texts;
  severity: Severity;
  expected: Texts;
  advice: Texts;
  sources: string[];
}

const BASE_DEFS: SpecDef[] = [
  {
    id: "updates.dsm",
    title: { en: "DSM up to date", fr: "DSM à jour" },
    short: { en: "DSM", fr: "DSM" },
    severity: "high",
    expected: {
      en: "DSM up to date within its major version.",
      fr: "DSM à jour dans sa version majeure.",
    },
    advice: {
      en: "Install the DSM update after a backup (Control Panel, Update & Restore).",
      fr: "Installer la mise à jour de DSM après une sauvegarde (Panneau de configuration, Mise à jour et restauration).",
    },
    sources: ["dsm.update"],
  },
  {
    id: "updates.packages",
    title: { en: "Packages up to date", fr: "Paquets à jour" },
    short: { en: "Packages", fr: "Paquets" },
    severity: "medium",
    expected: {
      en: "Packages up to date.",
      fr: "Paquets à jour.",
    },
    advice: {
      en: "Update the packages in Package Center, or turn on their automatic updates.",
      fr: "Mettre à jour les paquets dans le Centre de paquets, ou activer leur mise à jour automatique.",
    },
    sources: ["packages.list"],
  },
  {
    id: "accounts.admin_two_factor",
    title: {
      en: "Two-factor authentication for administrators",
      fr: "Double authentification des administrateurs",
    },
    short: { en: "2FA", fr: "2FA" },
    severity: "high",
    expected: {
      en: "Every active administrator has two-factor authentication.",
      fr: "Tous les administrateurs actifs ont la double authentification.",
    },
    advice: {
      en: "Turn on two-factor authentication for each administrator account. Enforcing it for administrators would also lock out the agent’s account, until it has a device token.",
      fr: "Activer la double authentification sur chaque compte administrateur. L'imposer aux administrateurs bloquerait aussi le compte de l'agent, tant qu'il n'a pas de jeton d'appareil.",
    },
    sources: ["users.list", "security.settings"],
  },
  {
    id: "accounts.builtin_admin",
    title: { en: "Built-in “admin” account", fr: "Compte « admin » d'origine" },
    short: { en: "admin", fr: "admin" },
    severity: "high",
    expected: {
      en: "Built-in “admin” account disabled.",
      fr: "Compte « admin » d'origine désactivé.",
    },
    advice: {
      en: "Disable the built-in “admin” account, after checking that another administrator exists.",
      fr: "Désactiver le compte « admin » d'origine, après avoir vérifié qu'un autre administrateur existe.",
    },
    sources: ["users.list"],
  },
  {
    id: "accounts.guest",
    title: { en: "“guest” account", fr: "Compte « guest »" },
    short: { en: "guest", fr: "guest" },
    severity: "medium",
    expected: {
      en: "“guest” account disabled.",
      fr: "Compte « guest » désactivé.",
    },
    advice: {
      en: "Disable the “guest” account (Control Panel, User & Group).",
      fr: "Désactiver le compte « guest » (Panneau de configuration, Utilisateur et groupe).",
    },
    sources: ["users.list"],
  },
  {
    id: "access.ssh",
    title: { en: "SSH", fr: "SSH" },
    short: { en: "SSH", fr: "SSH" },
    severity: "medium",
    expected: {
      en: "SSH off when not in use.",
      fr: "SSH coupé quand il ne sert pas.",
    },
    advice: {
      en: "Turn SSH off if you don’t use it; otherwise allow keys only, change port 22 and filter it with the firewall.",
      fr: "Couper SSH s'il ne sert pas ; sinon le réserver aux clés, changer le port 22 et le filtrer par le pare-feu.",
    },
    sources: ["security.settings"],
  },
  {
    id: "access.telnet",
    title: { en: "Telnet", fr: "Telnet" },
    short: { en: "Telnet", fr: "Telnet" },
    severity: "high",
    expected: {
      en: "Telnet off.",
      fr: "Telnet coupé.",
    },
    advice: {
      en: "Turn Telnet off: it sends passwords in clear text.",
      fr: "Couper Telnet, qui transmet les mots de passe en clair.",
    },
    sources: ["security.settings"],
  },
  {
    id: "access.firewall",
    title: { en: "Firewall", fr: "Pare-feu" },
    short: { en: "Firewall", fr: "Pare-feu" },
    severity: "medium",
    expected: {
      en: "Firewall on.",
      fr: "Pare-feu actif.",
    },
    advice: {
      en: "Turn on the DSM firewall with a profile that only opens the services you use (Control Panel, Security, Firewall).",
      fr: "Activer le pare-feu de DSM avec un profil qui n'ouvre que les services utilisés (Panneau de configuration, Sécurité, Pare-feu).",
    },
    sources: ["security.settings"],
  },
  {
    id: "access.auto_block",
    title: { en: "Auto block", fr: "Blocage automatique" },
    short: { en: "Block", fr: "Blocage" },
    severity: "medium",
    expected: {
      en: "Automatic blocking of addresses on.",
      fr: "Blocage automatique des adresses actif.",
    },
    advice: {
      en: "Turn on auto block (Control Panel, Security, Protection).",
      fr: "Activer le blocage automatique (Panneau de configuration, Sécurité, Protection).",
    },
    sources: ["security.settings"],
  },
  {
    id: "access.quickconnect",
    title: { en: "QuickConnect", fr: "QuickConnect" },
    short: { en: "QC", fr: "QC" },
    severity: "info",
    expected: {
      en: "QuickConnect off when not in use.",
      fr: "QuickConnect coupé s'il ne sert pas.",
    },
    advice: {
      en: "Turn QuickConnect off if you don’t use it, or restrict the services it exposes.",
      fr: "Couper QuickConnect s'il ne sert pas, ou restreindre les services qu'il expose.",
    },
    sources: ["security.settings"],
  },
  {
    id: "certificates.validity",
    title: { en: "Certificates", fr: "Certificats" },
    short: { en: "Cert.", fr: "Certif." },
    severity: "high",
    expected: {
      en: "Certificates in use valid for more than 30 days.",
      fr: "Certificats utilisés valides plus de 30 jours.",
    },
    advice: {
      en: "Renew the certificate, or let DSM renew it (Let’s Encrypt), and check the services that use it.",
      fr: "Renouveler le certificat, ou laisser DSM le renouveler (Let's Encrypt), et vérifier les services qui l'emploient.",
    },
    sources: ["certificates.list"],
  },
  {
    id: "backup.recent_success",
    title: { en: "Last success", fr: "Dernière réussite" },
    short: { en: "Recent", fr: "Récente" },
    severity: "high",
    expected: {
      en: "Each scheduled task succeeded less than 26 h ago, or as its schedule requires.",
      fr: "Chaque tâche planifiée a réussi depuis moins de 26 h, ou selon son planning.",
    },
    advice: {
      en: "Check the task and its destination in Hyper Backup; schedule the tasks run by hand.",
      fr: "Vérifier la tâche et sa destination dans Hyper Backup ; planifier les tâches lancées à la main.",
    },
    sources: ["backup.hyperbackup.tasks", "system.time"],
  },
  {
    id: "backup.last_result",
    title: { en: "Tasks in error", fr: "Tâches en erreur" },
    short: { en: "Errors", fr: "Erreurs" },
    severity: "high",
    expected: {
      en: "No task in error.",
      fr: "Aucune tâche en erreur.",
    },
    advice: {
      en: "Open the task’s log in Hyper Backup, fix the cause (destination full, disconnected or write-protected), then run the backup again.",
      fr: "Ouvrir le journal de la tâche dans Hyper Backup, corriger la cause (destination pleine, déconnectée ou protégée en écriture), puis relancer la sauvegarde.",
    },
    sources: ["backup.hyperbackup.tasks"],
  },
  {
    id: "backup.integrity",
    title: { en: "Integrity check", fr: "Contrôle d'intégrité" },
    short: { en: "Integrity", fr: "Intégrité" },
    severity: "medium",
    expected: {
      en: "An integrity check less than 35 days old on every multi-version task.",
      fr: "Un contrôle d'intégrité de moins de 35 jours sur chaque tâche multiversion.",
    },
    advice: {
      en: "Schedule a regular integrity check in the task settings, and run one now.",
      fr: "Planifier un contrôle d'intégrité régulier dans les réglages de la tâche, et en lancer un maintenant.",
    },
    sources: ["backup.hyperbackup.tasks", "system.time"],
  },
  {
    id: "storage.volume_usage",
    title: { en: "Volume usage", fr: "Remplissage des volumes" },
    short: { en: "Volumes", fr: "Volumes" },
    severity: "high",
    expected: {
      en: "Volumes less than 80 % full (failure at 90 %).",
      fr: "Volumes remplis à moins de 80 % (échec à 90 %).",
    },
    advice: {
      en: "Free up space (recycle bins, snapshots, old Hyper Backup versions) or expand the volume.",
      fr: "Libérer de la place (corbeilles, instantanés, anciennes versions de Hyper Backup) ou agrandir le volume.",
    },
    sources: ["storage.overview"],
  },
  {
    id: "storage.disks",
    title: { en: "Disk health", fr: "Santé des disques" },
    short: { en: "Disks", fr: "Disques" },
    severity: "high",
    expected: {
      en: "Healthy disks (normal state and SMART).",
      fr: "Disques sains (état et SMART normaux).",
    },
    advice: {
      en: "Back up right away, then replace the faulty disk.",
      fr: "Sauvegarder sans attendre, puis remplacer le disque en cause.",
    },
    sources: ["storage.overview"],
  },
  {
    id: "storage.pools",
    title: {
      en: "Storage pools and volumes",
      fr: "Groupes de stockage et volumes",
    },
    short: { en: "Pools", fr: "Groupes" },
    severity: "high",
    expected: {
      en: "Storage pools and volumes in normal state, none degraded.",
      fr: "Groupes de stockage et volumes en état normal, aucun dégradé.",
    },
    advice: {
      en: "Open Storage Manager and repair the degraded item, after a backup.",
      fr: "Ouvrir le Gestionnaire de stockage et réparer l'élément dégradé, après une sauvegarde.",
    },
    sources: ["storage.overview"],
  },
  {
    id: "ups.configured",
    title: { en: "UPS", fr: "Onduleur" },
    short: { en: "UPS", fr: "Onduleur" },
    severity: "medium",
    expected: {
      en: "UPS configured, NAS on mains power.",
      fr: "Onduleur configuré, NAS sur secteur.",
    },
    advice: {
      en: "Connect a UPS and turn on its support, for a clean shutdown during a power cut.",
      fr: "Brancher un onduleur et activer sa prise en charge, pour un arrêt propre en cas de coupure.",
    },
    sources: ["ups.status"],
  },
  {
    id: "security_advisor.critical",
    title: {
      en: "Critical Security Advisor issues",
      fr: "Points critiques de Security Advisor",
    },
    short: { en: "Advisor", fr: "Advisor" },
    severity: "high",
    expected: {
      en: "No critical issue, scan less than 30 days old.",
      fr: "Aucun point critique, analyse de moins de 30 jours.",
    },
    advice: {
      en: "Open Security Advisor, fix the items in red, then run the scan again.",
      fr: "Ouvrir Security Advisor, corriger les points en rouge, puis relancer l'analyse.",
    },
    sources: ["security.advisor"],
  },
  {
    id: "shares.recycle_bin",
    title: {
      en: "Recycle bin for shared folders",
      fr: "Corbeille des dossiers partagés",
    },
    short: { en: "Bin", fr: "Corbeille" },
    severity: "info",
    expected: {
      en: "Recycle bin on for shared folders.",
      fr: "Corbeille active sur les dossiers partagés.",
    },
    advice: {
      en: "Turn on the recycle bin for shared folders and schedule its emptying.",
      fr: "Activer la corbeille des dossiers partagés et planifier son vidage.",
    },
    sources: ["shares.list"],
  },
  {
    id: "shares.snapshots",
    title: {
      en: "Snapshots of shared folders",
      fr: "Instantanés des dossiers partagés",
    },
    short: { en: "Snapsh.", fr: "Instant." },
    severity: "info",
    expected: {
      en: "Snapshots scheduled for shared folders.",
      fr: "Instantanés planifiés sur les dossiers partagés.",
    },
    advice: {
      en: "Schedule snapshots with Snapshot Replication: they protect against deletions and ransomware.",
      fr: "Planifier des instantanés avec Snapshot Replication : ils protègent des suppressions et des rançongiciels.",
    },
    sources: ["shares.list"],
  },
];

const DEFS: SpecDef[] = (() => {
  const all = new Map([...BASE_DEFS, ...MORE_DEFS].map((d) => [d.id, d]));
  return AGENT_ORDER.map((id) => {
    const def = all.get(id);
    if (!def) throw new Error(`Contrôle sans définition : ${id}`);
    return def;
  });
})();

const BY_LANG = new Map<Locale, Spec[]>();

/** Les contrôles dans une langue. */
export function specs(lang: Locale): Spec[] {
  let list = BY_LANG.get(lang);
  if (!list) {
    list = DEFS.map((d) => ({
      id: d.id,
      title: d.title[lang],
      short: d.short[lang],
      severity: d.severity,
      expected: d.expected[lang],
      advice: d.advice[lang],
      sources: d.sources,
    }));
    BY_LANG.set(lang, list);
  }
  return list;
}

export type Verdicts = Record<string, [Status, string, string[]?]>;

/** Assemble les 42 contrôles d'un NAS à partir de ses verdicts. */
export function buildChecks(verdicts: Verdicts, lang: Locale): Check[] {
  return specs(lang).map((spec) => {
    const verdict = verdicts[spec.id];
    if (!verdict) throw new Error(`Verdict manquant : ${spec.id}`);
    const [status, observed, items = []] = verdict;
    return {
      ...spec,
      category: spec.id.split(".")[0] as CategoryId,
      status,
      observed,
      items,
      advice: status === "ok" ? null : spec.advice,
    };
  });
}

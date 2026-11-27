// Traduction des réponses d'un agent dans le modèle de la console. Fonctions pures : ni
// réseau ni horloge cachée, l'heure courante est passée en paramètre.

import { type Locale, type Texts, tr } from "@/i18n";
import { specs } from "@/lib/fleet/specs";
import type {
  AbbInfo,
  Account,
  ActivityEvent,
  AgentContainer,
  BackupLogEntry,
  BackupTask,
  CategoryId,
  Check,
  CloudBackupsInfo,
  FileLogState,
  Nas,
  SecuritySetting,
  SettingState,
  Severity,
  Status,
  SynologyInfo,
} from "@/lib/fleet/types";
import { historyVitals, keepsHistory } from "./history-map";
import {
  bytes,
  date,
  formatClock,
  formatDate,
  formatDateTime,
  formatDayTitle,
  instantFromNasLocal,
  since,
  tzOffsetMinutes,
  uptime,
  weekdayNames,
} from "./time";
import type {
  AgentConfig,
  AgentReads,
  BackupSchedule,
  FileLogs,
  Payloads,
  ReadKey,
} from "./types";

const STATUSES: Status[] = ["ok", "warning", "failed", "unknown"];
const SEVERITIES: Severity[] = ["high", "medium", "info"];

function get<K extends ReadKey>(reads: AgentReads, key: K): Payloads[K] | null {
  const read = reads[key];
  return read?.ok ? (read.data as Payloads[K]) : null;
}

function reason(reads: AgentReads, key: ReadKey, lang: Locale): string {
  const read = reads[key];
  return read && !read.ok
    ? read.reason[lang]
    : tr(lang, { en: "not read", fr: "non lu" });
}

// Contrôles ---------------------------------------------------------------------------------

function unknownChecks(why: string, lang: Locale): Check[] {
  return specs(lang).map((spec) => ({
    ...spec,
    category: spec.id.split(".")[0] as CategoryId,
    status: "unknown",
    observed: tr(lang, {
      en: `Could not read: ${why}`,
      fr: `Lecture impossible : ${why}`,
    }),
    items: [],
    advice: null,
  }));
}

function checksFrom(reads: AgentReads, lang: Locale): Check[] {
  const audit = get(reads, "audit.checks");
  if (!audit?.checks)
    return unknownChecks(reason(reads, "audit.checks", lang), lang);
  const byId = new Map(audit.checks.map((c) => [c.id, c]));
  return specs(lang).map((spec) => {
    const c = byId.get(spec.id);
    if (!c) {
      return {
        ...unknownChecks(
          tr(lang, {
            en: "check missing from the answer",
            fr: "contrôle absent de la réponse",
          }),
          lang,
        )[0],
        ...spec,
        category: spec.id.split(".")[0] as CategoryId,
        advice: null,
      };
    }
    return {
      id: c.id,
      category: spec.id.split(".")[0] as CategoryId,
      title: c.title || spec.title,
      short: spec.short,
      severity: SEVERITIES.includes(c.severity as Severity)
        ? (c.severity as Severity)
        : spec.severity,
      status: STATUSES.includes(c.status as Status)
        ? (c.status as Status)
        : "unknown",
      observed: c.observed,
      expected: c.expected || spec.expected,
      advice: c.advice,
      items: c.items ?? [],
      sources: c.sources?.length ? c.sources : spec.sources,
    };
  });
}

function checkStatus(checks: Check[], id: string): Status | null {
  const check = checks.find((c) => c.id === id);
  return check && check.status !== "unknown" ? check.status : null;
}

// Système -----------------------------------------------------------------------------------

/** « (GMT+01:00) Amsterdam, Berlin… » et « Amsterdam » donnent « UTC+1, Amsterdam ». */
function timeZone(
  label: string | null | undefined,
  zone: string | null | undefined,
): string {
  const m = label ? /GMT([+-])(\d{2}):(\d{2})/.exec(label) : null;
  const offset = m
    ? `UTC${m[1] === "-" ? "−" : "+"}${Number(m[2])}${m[3] !== "00" ? `:${m[3]}` : ""}`
    : null;
  return [offset, zone].filter(Boolean).join(", ") || "–";
}

/** Décalage du NAS en minutes, lu dans le libellé du fuseau. */
function offsetMinutes(label: string | null | undefined): number {
  const m = label ? /GMT([+-])(\d{2}):(\d{2})/.exec(label) : null;
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

// Stockage ----------------------------------------------------------------------------------

const RAID_LABEL: Record<string, string> = {
  shr_without_disk_protect: "SHR",
  shr_with_1_disk_protect: "SHR",
  shr: "SHR",
  shr_with_2_disk_protect: "SHR-2",
  shr_2: "SHR-2",
  raid_0: "RAID 0",
  raid_1: "RAID 1",
  raid_5: "RAID 5",
  raid_6: "RAID 6",
  raid_10: "RAID 10",
  raid_f1: "RAID F1",
  basic: "Basic",
  jbod: "JBOD",
};

function raid(code: string | null | undefined): string {
  if (!code) return "–";
  return (
    RAID_LABEL[code.toLowerCase()] ?? code.replace(/_/g, " ").toUpperCase()
  );
}

function fsLabel(fs: string | null | undefined): string {
  if (!fs) return "–";
  return fs.toLowerCase() === "btrfs" ? "Btrfs" : fs;
}

function disks(n: number, lang: Locale): string {
  return tr(lang, {
    en: `${n} ${n === 1 ? "disk" : "disks"}`,
    fr: `${n} ${n > 1 ? "disques" : "disque"}`,
  });
}

// Sauvegardes -------------------------------------------------------------------------------

function taskKind(kind: string | null | undefined, lang: Locale): string {
  const k = (kind ?? "").toLowerCase();
  const where = /cloud|s3|c2|azure|google|dropbox|onedrive|webdav/.test(k)
    ? "Cloud"
    : /remote|rsync|vault|network/.test(k)
      ? tr(lang, { en: "Remote", fr: "Distante" })
      : /local|usb/.test(k)
        ? tr(lang, { en: "Local", fr: "Locale" })
        : tr(lang, { en: "Other", fr: "Autre" });
  return k.startsWith("image")
    ? tr(lang, { en: `${where}, multi-version`, fr: `${where}, multiversion` })
    : where;
}

/** Programmation à l'heure du NAS ; `nasClock` la signale quand les fuseaux diffèrent. */
function scheduleLabel(
  s: BackupSchedule | null | undefined,
  nasClock: boolean,
  lang: Locale,
): string {
  if (!s || s.enabled === false)
    return tr(lang, { en: "Run by hand", fr: "Lancée à la main" });
  const at =
    s.hour != null
      ? `${s.hour}:${String(s.minute ?? 0).padStart(2, "0")}${nasClock ? tr(lang, { en: " (NAS time)", fr: " (heure du NAS)" }) : ""}`
      : null;
  if (s.repeat_every_hours)
    return tr(lang, {
      en: `Every ${s.repeat_every_hours} h${at ? ` from ${at}` : ""}`,
      fr: `Toutes les ${s.repeat_every_hours} h${at ? ` dès ${at}` : ""}`,
    });
  const days = s.week_days ?? [];
  const names = weekdayNames(lang);
  const atText = at ? tr(lang, { en: ` at ${at}`, fr: ` à ${at}` }) : "";
  if (days.length === 7 || days.length === 0)
    return tr(lang, { en: `Every day${atText}`, fr: `Chaque jour${atText}` });
  if (days.length === 1)
    return tr(lang, {
      en: `${names[days[0]] ?? "?"}s${atText}`,
      fr: `Le ${names[days[0]] ?? "?"}${atText}`,
    });
  return `${days.map((d) => names[d] ?? "?").join(", ")}${atText}`;
}

// Derniers résultats de Hyper Backup, tels que DSM les code.
const LAST_RESULT: Record<string, Texts> = {
  failed: { en: "backup failed", fr: "échec de la sauvegarde" },
  failed_checking: {
    en: "check before backup failed (destination missing, full or write-protected)",
    fr: "échec de la vérification avant sauvegarde (destination absente, pleine ou protégée en écriture)",
  },
  partial: { en: "partial backup", fr: "sauvegarde partielle" },
  canceled: { en: "backup canceled", fr: "sauvegarde annulée" },
  cancelled: { en: "backup canceled", fr: "sauvegarde annulée" },
  suspended: { en: "backup suspended", fr: "sauvegarde suspendue" },
};

function lastResultText(code: string | null | undefined, lang: Locale): string {
  const what = code
    ? (LAST_RESULT[code]?.[lang] ?? code)
    : tr(lang, { en: "error", fr: "erreur" });
  return tr(lang, {
    en: `Last result: ${what}`,
    fr: `Dernier résultat : ${what}`,
  });
}

/** Contexte des heures : instant de lecture, fuseau de la console, décalage du NAS. */
type Clock = { now: Date; tz: string; offset: number; lang: Locale };

function tasksFrom(
  reads: AgentReads,
  checks: Check[],
  clock: Clock,
): BackupTask[] {
  const { now, tz, offset, lang } = clock;
  const at = (local: string | null | undefined) =>
    instantFromNasLocal(local, offset);
  const when = (local: string | null | undefined) =>
    formatDateTime(at(local), now, tz, lang);
  const never = tr(lang, { en: "never", fr: "jamais" });
  const nasClock = tzOffsetMinutes(tz, now) !== offset;
  const data = get(reads, "backup.hyperbackup.tasks");
  const recent = checks.find((c) => c.id === "backup.recent_success");
  const integrity = checks.find((c) => c.id === "backup.integrity");
  return (data?.tasks ?? []).map((t) => {
    // L'agent écrit « nom : … » en français, « name: … » en anglais.
    const prefix = tr(lang, { en: `${t.name}: `, fr: `${t.name} : ` });
    const lateItem = recent?.items.find((i) => i.startsWith(prefix));
    let result: BackupTask["result"];
    if (t.failed) {
      result = {
        status: "failed",
        text: t.last_error || lastResultText(t.last_result, lang),
      };
    } else if (lateItem && recent) {
      result = {
        status: recent.status === "ok" ? "warning" : recent.status,
        text: lateItem.slice(prefix.length),
      };
    } else {
      result = {
        status: "ok",
        text: tr(lang, { en: "Succeeded", fr: "Réussie" }),
      };
    }
    const ic = t.integrity_check;
    const integrityLate = integrity?.items.some((i) => i.startsWith(prefix));
    return {
      name: t.name,
      kind: taskKind(t.kind, lang),
      destination: t.destination_share || t.destination_target || "–",
      schedule: scheduleLabel(t.schedule, nasClock, lang),
      lastRun: t.last_started_at
        ? since(at(t.last_started_at), now, lang)
        : never,
      lastSuccess: t.last_success_at ? when(t.last_success_at) : never,
      result,
      nextRun: t.schedule?.next_run_at
        ? when(t.schedule.next_run_at)
        : tr(lang, { en: "none", fr: "aucune" }),
      integrityLast: ic?.never_checked
        ? never
        : ic?.last_at
          ? when(ic.last_at)
          : integrityLate
            ? tr(lang, { en: "overdue", fr: "en retard" })
            : "–",
      integrityNext: ic?.next_run_at
        ? when(ic.next_run_at)
        : ic?.scheduled
          ? tr(lang, { en: "scheduled", fr: "planifié" })
          : tr(lang, { en: "not scheduled", fr: "non planifié" }),
      lastSuccessAt: at(t.last_success_at),
      lastRunAt: at(t.last_started_at),
      running: Boolean(t.running),
    };
  });
}

// Sécurité ----------------------------------------------------------------------------------

function securityFrom(
  reads: AgentReads,
  checks: Check[],
  lang: Locale,
): SecuritySetting[] {
  const s = get(reads, "security.settings");
  if (!s) return [];
  const st = (id: string, fallback: SettingState): SettingState =>
    checkStatus(checks, id) ?? fallback;
  const fw = s.firewall ?? {};
  const ab = s.auto_block ?? {};
  const enforced = (s.two_factor_enforced ?? "none").toLowerCase();
  const on = tr(lang, { en: "On", fr: "Actif" });
  const off = tr(lang, { en: "Off", fr: "Coupé" });
  const open = tr(lang, { en: "Open", fr: "Ouvert" });
  const rows: SecuritySetting[] = [
    {
      label: tr(lang, { en: "Firewall", fr: "Pare-feu" }),
      state: st("access.firewall", fw.enabled ? "ok" : "failed"),
      value: fw.enabled
        ? `${on}${
            fw.profile && fw.profile !== "default"
              ? tr(lang, {
                  en: `, profile “${fw.profile}”`,
                  fr: `, profil « ${fw.profile} »`,
                })
              : ""
          }`
        : off,
    },
    {
      label: tr(lang, { en: "Auto block", fr: "Blocage automatique" }),
      state: st("access.auto_block", ab.enabled ? "ok" : "failed"),
      value: ab.enabled
        ? `${on}${
            ab.attempts
              ? tr(lang, {
                  en: `, ${ab.attempts} failures within ${ab.within_minutes ?? "?"} min`,
                  fr: `, ${ab.attempts} échecs en ${ab.within_minutes ?? "?"} min`,
                })
              : ""
          }`
        : off,
    },
    {
      label: tr(lang, {
        en: "Account protection",
        fr: "Protection des comptes",
      }),
      state: st(
        "accounts.protection",
        s.account_protection_enabled ? "ok" : "warning",
      ),
      value: s.account_protection_enabled
        ? tr(lang, { en: "On", fr: "Active" })
        : tr(lang, { en: "Off", fr: "Coupée" }),
    },
    {
      label: tr(lang, {
        en: "Two-factor authentication enforced",
        fr: "Double authentification imposée",
      }),
      state: enforced === "none" ? "neutral" : "ok",
      value:
        enforced === "none"
          ? tr(lang, { en: "For nobody", fr: "À personne" })
          : enforced.startsWith("admin")
            ? tr(lang, { en: "For administrators", fr: "Aux administrateurs" })
            : tr(lang, { en: "For everyone", fr: "À tous" }),
    },
    {
      label: "SSH",
      state: st("access.ssh", s.ssh?.enabled ? "warning" : "ok"),
      value: s.ssh?.enabled
        ? tr(lang, {
            en: `Open, port ${s.ssh.port ?? "?"}`,
            fr: `Ouvert, port ${s.ssh.port ?? "?"}`,
          })
        : off,
    },
    {
      label: "Telnet",
      state: st("access.telnet", s.telnet_enabled ? "failed" : "ok"),
      value: s.telnet_enabled ? open : off,
    },
    {
      label: "QuickConnect",
      state: st(
        "access.quickconnect",
        s.quickconnect?.enabled ? "warning" : "ok",
      ),
      value: s.quickconnect?.enabled ? on : off,
    },
  ];
  const pw = s.password_policy;
  if (pw) {
    const parts = [
      tr(lang, {
        en: `at least ${pw.min_length ?? 0} characters`,
        fr: `au moins ${pw.min_length ?? 0} caractères`,
      }),
      pw.exclude_common
        ? tr(lang, { en: "common ones refused", fr: "courants refusés" })
        : tr(lang, { en: "common ones accepted", fr: "courants acceptés" }),
    ];
    rows.push({
      label: tr(lang, { en: "Passwords", fr: "Mots de passe" }),
      state: st("accounts.password_policy", "neutral"),
      value: parts.join(", "),
    });
  }
  rows.push(...servicesRows(reads, checks, lang));
  if (s.session?.timeout_minutes != null) {
    rows.push({
      label: tr(lang, {
        en: "Sign-out after inactivity",
        fr: "Déconnexion après inactivité",
      }),
      state: "neutral",
      value: `${s.session.timeout_minutes} min`,
    });
  }
  return rows;
}

/** Services de fichiers et DSM sur le web (`services.list`), à la suite des réglages. */
function servicesRows(
  reads: AgentReads,
  checks: Check[],
  lang: Locale,
): SecuritySetting[] {
  const sv = get(reads, "services.list");
  if (!sv) return [];
  const st = (id: string, fallback: SettingState): SettingState =>
    checkStatus(checks, id) ?? fallback;
  const off = tr(lang, { en: "Off", fr: "Coupé" });
  const on = tr(lang, { en: "On", fr: "Actif" });
  const rows: SecuritySetting[] = [];
  if (sv.smb) {
    rows.push({
      label: "SMB",
      state: sv.smb.enabled ? st("access.smb1", "ok") : "neutral",
      value: sv.smb.enabled
        ? tr(lang, {
            en: `On, minimum ${sv.smb.min_protocol ?? "?"}${sv.smb.ntlmv1 ? ", NTLMv1 accepted" : ""}`,
            fr: `Actif, minimum ${sv.smb.min_protocol ?? "?"}${sv.smb.ntlmv1 ? ", NTLMv1 accepté" : ""}`,
          })
        : off,
    });
  }
  const clear = st("access.cleartext", "ok");
  if (sv.ftp) {
    rows.push({
      label: "FTP",
      state: sv.ftp.enabled ? clear : "neutral",
      value: sv.ftp.enabled
        ? tr(lang, { en: "On, unencrypted", fr: "Actif, sans chiffrement" })
        : sv.ftp.ftps_enabled
          ? tr(lang, { en: "FTPS only", fr: "FTPS seulement" })
          : off,
    });
  }
  if (sv.sftp)
    rows.push({
      label: "SFTP",
      state: "neutral",
      value: sv.sftp.enabled ? on : off,
    });
  if (sv.rsync) {
    rows.push({
      label: "rsync",
      state: sv.rsync.enabled && sv.rsync.rsync_accounts ? clear : "neutral",
      value: sv.rsync.enabled
        ? sv.rsync.rsync_accounts
          ? tr(lang, { en: "On, daemon mode", fr: "Actif, mode démon" })
          : on
        : off,
    });
  }
  if (sv.snmp) {
    rows.push({
      label: "SNMP",
      state: sv.snmp.enabled && sv.snmp.v1v2c ? clear : "neutral",
      value: sv.snmp.enabled
        ? sv.snmp.v1v2c
          ? tr(lang, { en: "On, v1/v2c", fr: "Actif, v1/v2c" })
          : tr(lang, { en: "On, v3", fr: "Actif, v3" })
        : off,
    });
  }
  if (sv.afp_enabled != null)
    rows.push({
      label: "AFP",
      state: sv.afp_enabled ? clear : "neutral",
      value: sv.afp_enabled ? on : off,
    });
  if (sv.web?.https_redirect != null)
    rows.push({
      label: tr(lang, { en: "DSM over HTTPS", fr: "DSM en HTTPS" }),
      state: st("access.https", sv.web.https_redirect ? "ok" : "warning"),
      value: sv.web.https_redirect
        ? tr(lang, { en: "HTTP redirected", fr: "HTTP redirigé" })
        : tr(lang, {
            en: `HTTP still open (port ${sv.web.http_port ?? 5000})`,
            fr: `HTTP encore ouvert (port ${sv.web.http_port ?? 5000})`,
          }),
    });
  return rows;
}

const ADVISOR_GROUP: Record<string, Texts> = {
  home: { en: "Home", fr: "Maison" },
  business: { en: "Business", fr: "Entreprise" },
  custom: { en: "Custom", fr: "Personnalisé" },
};
const ADVISOR_AREA: Record<string, Texts> = {
  malware: { en: "Malware", fr: "Logiciels malveillants" },
  network: { en: "Network", fr: "Réseau" },
  system: { en: "System", fr: "Système" },
  updates: { en: "Updates", fr: "Mises à jour" },
  accounts: { en: "Accounts", fr: "Comptes" },
};
const ADVISOR_RULE: [RegExp, Texts][] = [
  [
    /sshPortCheck/i,
    { en: "Default SSH port (22)", fr: "Port SSH par défaut (22)" },
  ],
  [
    /enable_notification/i,
    {
      en: "DSM update notifications",
      fr: "Notifications de mise à jour de DSM",
    },
  ],
  [/telnet/i, { en: "Telnet open", fr: "Telnet ouvert" }],
  [/firewall/i, { en: "Firewall", fr: "Pare-feu" }],
  [/autoblock/i, { en: "Auto block", fr: "Blocage automatique" }],
  [/admin/i, { en: "Administrator account", fr: "Compte administrateur" }],
];

// Verbes du journal de transfert de DSM ; un verbe inconnu reste tel quel.
const FILE_VERBS: Record<string, Texts> = {
  create: { en: "Created", fr: "A créé" },
  "create folder": { en: "Created the folder", fr: "A créé le dossier" },
  mkdir: { en: "Created the folder", fr: "A créé le dossier" },
  delete: { en: "Deleted", fr: "A supprimé" },
  rename: { en: "Renamed", fr: "A renommé" },
  move: { en: "Moved", fr: "A déplacé" },
  copy: { en: "Copied", fr: "A copié" },
  write: { en: "Modified", fr: "A modifié" },
  upload: { en: "Uploaded", fr: "A envoyé" },
  download: { en: "Downloaded", fr: "A téléchargé" },
  read: { en: "Read", fr: "A lu" },
};

function fileEventText(
  e: NonNullable<FileLogs["entries"]>[number],
  lang: Locale,
): string {
  const action = e.action?.toLowerCase() ?? "";
  const verb =
    FILE_VERBS[action]?.[lang] ??
    (action
      ? tr(lang, {
          en: `Action “${action}” on`,
          fr: `Action « ${action} » sur`,
        })
      : tr(lang, { en: "Action on", fr: "Action sur" }));
  const what = e.path
    ? tr(lang, { en: `“${e.path}”`, fr: `« ${e.path} »` })
    : tr(lang, { en: "a file", fr: "un fichier" });
  const to = e.destination
    ? tr(lang, {
        en: ` ${action === "rename" ? "to" : "to"} “${e.destination}”`,
        fr: ` ${action === "rename" ? "en" : "vers"} « ${e.destination} »`,
      })
    : "";
  return `${verb} ${what}${to}${e.protocol ? ` (${e.protocol})` : ""}.`;
}

function ruleTitle(id: string, lang: Locale): string {
  for (const [re, label] of ADVISOR_RULE) if (re.test(id)) return label[lang];
  return id.split(".").pop() ?? id;
}

// Assemblage --------------------------------------------------------------------------------

function base(agent: AgentConfig, lang: Locale): Omit<Nas, "checks" | "agent"> {
  return {
    id: agent.id,
    name: agent.name,
    place: agent.place,
    model: "–",
    dsm: "–",
    timeZone: "–",
    reachable: true,
    real: false,
    live: true,
    readAt: null,
    problem: null,
    vitals: {
      cpu: null,
      ram: null,
      temp: null,
      uptime: tr(lang, { en: "unknown", fr: "inconnue" }),
      netBps: null,
      source: null,
    },
    volumes: [],
    pools: [],
    disks: [],
    shares: [],
    tasks: [],
    security: [],
    advisor: {
      group: "–",
      rules: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      lastRun: "–",
      failedRules: [],
    },
    certificates: [],
    accounts: [],
    ups: tr(lang, { en: "Unknown", fr: "Inconnu" }),
    connected: [],
    activity: [],
    fileLogs: "unknown",
    agentHistory: false,
    beszel: { kind: "none" },
    tzOffsetMin: null,
    backupLog: [],
    backupLogFrom: null,
    backupLogRead: false,
    seen: {},
    ramMb: null,
    dsmUpdate: null,
    packages: null,
    network: null,
  };
}

const AUTO_UPDATE: Record<string, Texts> = {
  "hotfix-security": {
    en: "Security fixes installed automatically",
    fr: "Correctifs de sécurité installés seuls",
  },
  hotfix: {
    en: "Important fixes installed automatically",
    fr: "Correctifs importants installés seuls",
  },
  notify: { en: "Notify only", fr: "Avertir seulement" },
};

function systemFrom(
  reads: AgentReads,
  lang: Locale,
): Pick<Nas, "dsmUpdate" | "packages" | "network"> {
  const upd = get(reads, "dsm.update");
  const pkgs = get(reads, "packages.list");
  const net = get(reads, "network.overview");
  return {
    dsmUpdate: upd
      ? {
          current: upd.current_version ?? "–",
          checkOk: upd.check_ok ?? null,
          available: upd.update_available ? (upd.update_version ?? "?") : null,
          major: upd.major_upgrade_available
            ? (upd.major_upgrade_version ?? "?")
            : null,
          auto: upd.auto_update
            ? (AUTO_UPDATE[upd.auto_update]?.[lang] ?? upd.auto_update)
            : "–",
        }
      : null,
    packages: pkgs
      ? (pkgs.packages ?? []).map((p) => ({
          id: p.id ?? undefined,
          name: p.name ?? p.id ?? "–",
          version: p.version ?? "–",
          running: p.status === "running",
          system: Boolean(p.system),
          update: p.update_available ? (p.available_version ?? "?") : null,
          security: Boolean(p.security_update),
        }))
      : null,
    network: net
      ? {
          hostname: net.hostname ?? null,
          gateway: net.gateway?.address ?? null,
          dns: net.dns_servers ?? [],
          interfaces: (net.interfaces ?? []).map((i) => ({
            name: i.name ?? "–",
            kind: i.kind ?? null,
            connected: i.connected ?? null,
            address: i.address ?? null,
            speedMbps: i.speed_mbps ?? null,
          })),
        }
      : null,
  };
}

function upsLine(
  ups: NonNullable<Payloads["ups.status"]>,
  lang: Locale,
): string {
  if (!ups.enabled)
    return tr(lang, {
      en: "No UPS configured",
      fr: "Aucun onduleur configuré",
    });
  const name =
    [ups.manufacturer, ups.model].filter(Boolean).join(" ") ||
    tr(lang, { en: "UPS", fr: "Onduleur" });
  const mode = ups.mode ? `, ${ups.mode.toUpperCase()}` : "";
  const c = ups.charge_percent;
  return tr(lang, {
    en: `${name}${mode}: ${ups.on_battery ? "on battery" : "on mains power"}${c != null ? `, ${c}% charge` : ""}`,
    fr: `${name}${mode} : ${ups.on_battery ? "sur batterie" : "sur secteur"}${c != null ? `, charge ${c} %` : ""}`,
  });
}

/** Un NAS dont l'agent ne répond pas (ou refuse la console) : rien d'inventé, tout est
 * « inconnu ». */
export function offlineNas(
  agent: AgentConfig,
  why: string,
  kind: "down" | "denied",
  lang: Locale,
): Nas {
  return {
    ...base(agent, lang),
    agent: { kind, reason: why, lastReadAt: null },
    reachable: false,
    problem: why,
    checks: unknownChecks(why, lang),
  };
}

/** Ce que SMART dit d'un disque, par son identifiant DSM (« sata1 »). */
function smartOf(reads: AgentReads, id: string | null | undefined) {
  if (!id) return null;
  return get(reads, "storage.smart")?.disks?.find((d) => d.id === id) ?? null;
}

/** Le verdict du contrôle « Disques qui faiblissent » sur ce disque, s'il le nomme : ses
 * éléments commencent par le nom du disque (« Drive 1 : 8 secteurs en attente »). */
function wearStatus(
  checks: Check[],
  name: string | null | undefined,
): "failed" | "warning" | null {
  const check = checks.find((c) => c.id === "storage.disk_wear");
  if (!check || !name) return null;
  if (check.status !== "failed" && check.status !== "warning") return null;
  const named = check.items.some(
    (i) => i.startsWith(`${name} :`) || i.startsWith(`${name}:`),
  );
  return named ? check.status : null;
}

/** Active Backup for Business, appareil par appareil ; `null` sans le paquet. */
export function activeBackupFrom(reads: AgentReads): AbbInfo | null {
  const a = get(reads, "backup.activebackup");
  if (!a) return null;
  const devices: AbbInfo["devices"] = [];
  for (const task of a.tasks ?? []) {
    const units = task.devices?.length ? task.devices : [null];
    for (const d of units) {
      devices.push({
        name: d?.name ?? task.name ?? "?",
        task: task.name ?? null,
        type: task.type ?? null,
        os: d?.os ?? null,
        lastSuccessAt: d?.last_success_at ?? task.last_success_at ?? null,
        lastResult: task.last_result ?? null,
        running: Boolean(task.running),
      });
    }
  }
  return { activated: a.activated ?? null, devices };
}

/** Microsoft 365 et Google Workspace ; `null` sans aucun des deux paquets. */
export function cloudBackupsFrom(reads: AgentReads): CloudBackupsInfo | null {
  const c = get(reads, "backup.activebackup_cloud");
  if (!c) return null;
  const suites = (["microsoft365", "google_workspace"] as const).filter(
    (k) => c[k] != null,
  );
  if (!suites.length) return null;
  return {
    suites: [...suites],
    tasks: suites.flatMap((suite) =>
      (c[suite]?.tasks ?? []).map((t) => ({
        suite,
        activated: c[suite]?.activated ?? null,
        name: t.name ?? suite,
        state: t.state ?? null,
        continuous: t.continuous ?? null,
        lastRunAt: t.last_run_at ?? null,
        lastResult: t.last_result ?? null,
        errors: t.errors ?? 0,
        accounts: t.accounts ?? null,
      })),
    ),
  };
}

/** Failles et suivi du modèle lus chez Synology par l'agent ; `null` si la lecture manque. */
export function synologyFrom(reads: AgentReads): SynologyInfo | null {
  const s = get(reads, "updates.synology");
  if (!s) return null;
  const life = s.lifecycle;
  return {
    read: Boolean(s.read),
    error: s.error ?? null,
    readAt: s.feed_read_at ?? null,
    known: s.advisories_known ?? 0,
    lifecycle: life
      ? {
          model: life.model,
          listed: life.listed,
          updates: life.updates ?? null,
          warrantyYears: life.warranty_years ?? null,
        }
      : null,
    // Seuls les liens vers www.synology.com passent : l'adresse vient d'une page lue en ligne.
    findings: (s.findings ?? [])
      .filter((f) => f.url.startsWith("https://www.synology.com/"))
      .map((f) => ({
        id: f.id,
        url: f.url,
        severity: f.severity ?? null,
        product: f.product,
        state: f.state,
        fixedIn: f.fixed_in ?? null,
        otherBranch: Boolean(f.other_branch),
        scheduledBy: f.scheduled_by ?? null,
      })),
  };
}

/** Conteneurs lus par l'agent ; `null` si la lecture manque (Container Manager absent). */
function containersFrom(reads: AgentReads): AgentContainer[] | null {
  const list = get(reads, "containers.list")?.containers;
  if (!list) return null;
  return list.map((c) => ({
    name: c.name,
    image: c.image ?? null,
    project: c.project ?? null,
    state: c.state ?? null,
    health: c.health ?? null,
    exitCode: c.exit_code ?? null,
    oomKilled: Boolean(c.oom_killed),
    startedAt: c.started_at ?? null,
    cpu: c.cpu_pct ?? null,
    memoryBytes: c.memory_bytes ?? null,
  }));
}

export function mapNas(
  agent: AgentConfig,
  reads: AgentReads,
  now: Date,
  tz: string,
  lang: Locale,
): Nas {
  // L'historique ne touche pas à DSM : il répond même quand DSM ne répond plus, et ne dit
  // donc ni si l'agent lit son NAS, ni l'heure de la lecture.
  const fromDsm = Object.entries(reads)
    .filter(([key]) => key !== "metrics.history")
    .map(([, r]) => r);
  const ok = fromDsm.filter((r) => r?.ok);
  if (ok.length === 0) {
    const failed = fromDsm.filter((r) => r && !r.ok);
    // 401 ou 403 partout : l'agent répond, mais refuse le jeton ou l'adresse de la console.
    const denied = failed.find(
      (r) => r && !r.ok && (r.status === 401 || r.status === 403),
    );
    const first = denied ?? failed[0];
    return offlineNas(
      agent,
      first && !first.ok
        ? first.reason[lang]
        : tr(lang, { en: "agent unreachable", fr: "agent injoignable" }),
      denied ? "denied" : "down",
      lang,
    );
  }

  const checks = checksFrom(reads, lang);
  const unknownWord = tr(lang, { en: "unknown", fr: "inconnu" });
  const info = get(reads, "system.info");
  const util = get(reads, "system.utilization");
  const time = get(reads, "system.time");
  const storage = get(reads, "storage.overview");
  // Le décalage mesuré par l'agent (heure d'été comprise) ; à défaut, celui du libellé du
  // fuseau, qui reste à l'heure d'hiver toute l'année.
  const measured = time?.utc_offset_minutes;
  const offset =
    typeof measured === "number"
      ? measured
      : offsetMinutes(time?.time_zone_label);
  const offsetKnown =
    typeof measured === "number" ||
    /GMT[+-]\d{2}:\d{2}/.test(time?.time_zone_label ?? "");
  const at = (local: string | null | undefined) =>
    instantFromNasLocal(local, offset);

  // Heure de lecture : la plus récente des lectures réussies, celle de « Relire ». L'agent
  // garde certaines réponses plus longtemps (mises à jour, paquets) : chaque partie le dit.
  const readAt =
    ok
      .map((r) => (r?.ok ? new Date(r.fetchedAt).getTime() : 0))
      .filter((t) => Number.isFinite(t) && t > 0)
      .sort((a, b) => b - a)
      .map((t) => new Date(t).toISOString())[0] ?? null;

  const pools = storage?.pools ?? [];
  const advisor = get(reads, "security.advisor");
  const ups = get(reads, "ups.status");
  const accounts: Account[] = (get(reads, "users.list")?.accounts ?? []).map(
    (a) => ({
      name: a.name,
      role: a.admin
        ? a.agent_account
          ? tr(lang, {
              en: "Administrator, the agent’s account",
              fr: "Administrateur, compte de l'agent",
            })
          : a.name === "admin"
            ? tr(lang, {
                en: "Built-in administrator",
                fr: "Administrateur d'origine",
              })
            : tr(lang, { en: "Administrator", fr: "Administrateur" })
        : a.name === "guest"
          ? tr(lang, { en: "Guest", fr: "Invité" })
          : tr(lang, { en: "User", fr: "Utilisateur" }),
      state: a.disabled
        ? tr(lang, { en: "Disabled", fr: "Désactivé" })
        : tr(lang, { en: "Active", fr: "Actif" }),
      twoFactor: Boolean(a.two_factor),
    }),
  );

  const events: (ActivityEvent & { at: string })[] = [];
  for (const [key, source] of [
    ["logs.connection", "connections"],
    ["logs.system", "settings"],
  ] as const) {
    for (const e of get(reads, key)?.entries ?? []) {
      const when = at(e.time);
      if (!when) continue;
      events.push({
        at: when,
        day: formatDayTitle(when, now, tz, lang),
        time: formatClock(when, tz, lang),
        level: e.level === "warning" || e.level === "error" ? "warning" : "ok",
        source,
        who: e.account ?? "–",
        text: e.event ?? "",
      });
    }
  }
  const files = get(reads, "logs.files");
  for (const e of files?.entries ?? []) {
    const when = at(e.time);
    if (!when) continue;
    events.push({
      at: when,
      day: formatDayTitle(when, now, tz, lang),
      time: formatClock(when, tz, lang),
      level: e.action?.toLowerCase() === "delete" ? "warning" : "ok",
      source: "files",
      who: e.account ?? "–",
      text: fileEventText(e, lang),
    });
  }
  const logging = files?.logging;
  const fileLogs: FileLogState = !logging
    ? "unknown"
    : Object.values(logging).some((on) => on === true)
      ? "on"
      : "off";
  const seen = new Set<string>();
  const activity = events
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((e) => {
      const key = `${e.at}|${e.who}|${e.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ at: _at, ...e }) => e);

  const backupLog: BackupLogEntry[] = [];
  for (const e of get(reads, "backup.hyperbackup.logs")?.entries ?? []) {
    const when = at(e.time);
    if (!when) continue;
    backupLog.push({
      at: when,
      task: e.task ?? null,
      outcome: e.outcome ?? null,
    });
  }
  backupLog.sort((a, b) => b.at.localeCompare(a.at));

  // Une information, une source : avec l'historique, la valeur du moment est son dernier
  // relevé, comme sa courbe ; sans lui (ou relevé arrêté), la lecture instantanée.
  const history = get(reads, "metrics.history");
  const recorded = history ? historyVitals(history, now) : null;
  const vitals = recorded
    ? { cpu: recorded.cpu, ram: recorded.ram, temp: recorded.temp }
    : {
        cpu: util?.cpu?.total_pct ?? null,
        ram: util?.memory?.real_usage_pct ?? null,
        temp: info?.temperature_c ?? null,
      };

  return {
    ...base(agent, lang),
    agent: { kind: "ok", readAt: readAt ?? now.toISOString() },
    tzOffsetMin: offsetKnown ? offset : null,
    ramMb: info?.ram_mb ?? null,
    ...systemFrom(reads, lang),
    // L'agent du projet : le NAS porte le nom que lui donne DSM.
    name:
      (agent.autoName && get(reads, "network.overview")?.hostname) ||
      agent.name,
    backupLog,
    backupLogFrom: backupLog.at(-1)?.at ?? null,
    backupLogRead: get(reads, "backup.hyperbackup.logs") != null,
    model: info?.model ?? "–",
    dsm: info?.dsm_version ?? "–",
    timeZone: time ? timeZone(time.time_zone_label, time.time_zone) : "–",
    readAt,
    vitals: {
      ...vitals,
      uptime: uptime(info?.uptime_s, lang),
      netBps: recorded?.netBps ?? null,
      source: Object.values(vitals).some((v) => v != null) ? "agent" : null,
    },
    agentHistory: keepsHistory(history),
    volumes: (storage?.volumes ?? []).map((v) => {
      const pool = pools.find((p) => p.id === v.pool_id);
      const n = pool?.disks?.length;
      return {
        id: v.id ?? null,
        path: v.path ?? v.id ?? "–",
        fs: fsLabel(v.fs_type),
        raid: n ? `${raid(v.raid)}, ${disks(n, lang)}` : raid(v.raid),
        pct: v.used_pct ?? 0,
        used: bytes(v.size_used_bytes, lang),
        total: bytes(v.size_total_bytes, lang),
        status: v.status ?? unknownWord,
        totalBytes: v.size_total_bytes ?? null,
        usedBytes: v.size_used_bytes ?? null,
      };
    }),
    pools: pools.map((p, i) => ({
      name: tr(lang, {
        en: `Storage pool ${i + 1}`,
        fr: `Groupe de stockage ${i + 1}`,
      }),
      raid: raid(p.raid),
      status: p.status ?? unknownWord,
    })),
    disks: (storage?.disks ?? []).map((d, i) => {
      const sm = smartOf(reads, d.id);
      return {
        bay: Number(/(\d+)\s*$/.exec(d.name ?? "")?.[1] ?? i + 1),
        size: bytes(d.size_bytes, lang),
        temp: d.temperature_c ?? 0,
        smart: d.smart_status ?? unknownWord,
        status: d.status ?? unknownWord,
        healthy: d.healthy !== false,
        device: d.id ?? null,
        model: d.model ?? null,
        hours: sm?.power_on_hours ?? null,
        sizeBytes: d.size_bytes ?? null,
        wear: sm
          ? {
              reallocated: sm.reallocated_sectors ?? null,
              pending: sm.pending_sectors ?? null,
              uncorrectable: sm.uncorrectable_sectors ?? null,
              crc: sm.crc_errors ?? null,
              ssdLife: sm.ssd_life_pct ?? null,
              lastTest: sm.last_test_result ?? null,
              status: wearStatus(checks, sm.name),
            }
          : null,
      };
    }),
    containers: containersFrom(reads),
    synology: synologyFrom(reads),
    activeBackup: activeBackupFrom(reads),
    cloudBackups: cloudBackupsFrom(reads),
    shares: (get(reads, "shares.list")?.shares ?? []).map((s) => {
      const snap = s.snapshots;
      const count = snap?.count ?? 0;
      return {
        name: s.name,
        recycleBin: Boolean(s.recycle_bin),
        snapshots:
          snap?.supported === false
            ? tr(lang, { en: "not supported", fr: "non pris en charge" })
            : count
              ? tr(lang, {
                  en: `${count} ${count === 1 ? "snapshot" : "snapshots"}, ${snap?.scheduled ? "scheduled" : "not scheduled"}`,
                  fr: `${count} ${count > 1 ? "instantanés" : "instantané"}, ${snap?.scheduled ? "planifiés" : "non planifiés"}`,
                })
              : snap?.scheduled
                ? tr(lang, { en: "none, scheduled", fr: "aucun, planifiés" })
                : tr(lang, { en: "none", fr: "aucun" }),
      };
    }),
    tasks: tasksFrom(reads, checks, { now, tz, offset, lang }),
    security: securityFrom(reads, checks, lang),
    advisor: advisor
      ? {
          group:
            ADVISOR_GROUP[advisor.group ?? ""]?.[lang] ?? advisor.group ?? "–",
          rules: advisor.summary?.rules ?? 0,
          passed: advisor.summary?.passed ?? 0,
          failed: advisor.summary?.failed ?? 0,
          skipped: advisor.summary?.skipped ?? 0,
          lastRun: advisor.last_scan_at
            ? formatDateTime(at(advisor.last_scan_at), now, tz, lang)
            : tr(lang, { en: "never", fr: "jamais" }),
          failedRules: (advisor.failed_rules ?? []).map((r) => ({
            state:
              r.severity === "danger" || r.severity === "risk"
                ? "failed"
                : r.severity === "warning"
                  ? "warning"
                  : "neutral",
            title: ruleTitle(r.id, lang),
            area: ADVISOR_AREA[r.category ?? ""]?.[lang] ?? r.category ?? "–",
          })),
        }
      : base(agent, lang).advisor,
    certificates: (get(reads, "certificates.list")?.certificates ?? []).map(
      (c) => ({
        name: c.common_name ?? c.description ?? "–",
        issuer: c.self_signed
          ? tr(lang, { en: "Self-signed", fr: "Autosigné" })
          : (c.issuer ?? "–"),
        until: date(c.valid_until, lang),
        days: c.expires_in_days ?? 0,
        services: c.services?.length ?? 0,
        isDefault: Boolean(c.is_default),
      }),
    ),
    accounts,
    ups: ups ? upsLine(ups, lang) : tr(lang, { en: "Unknown", fr: "Inconnu" }),
    connected: (get(reads, "connections.current")?.sessions ?? []).map((c) => ({
      who: c.account ?? "–",
      protocol:
        c.service === "DiskStation Manager"
          ? "DSM"
          : (c.service ?? c.protocol ?? "–"),
      from: c.address ?? "–",
      since:
        at(c.since) && formatDate(at(c.since), now, tz, "en") === "today"
          ? formatClock(at(c.since), tz, lang)
          : formatDateTime(at(c.since), now, tz, lang),
      device: c.client ?? c.protocol ?? "–",
      isAgent: Boolean(c.is_agent),
    })),
    activity,
    fileLogs,
    checks,
  };
}

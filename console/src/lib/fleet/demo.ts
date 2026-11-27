// Parc de démonstration, en anglais et en français. Le NAS d'essai reprend les verdicts et
// valeurs lus le 2026-11-09 (adresses remplacées par des adresses de documentation) ; les
// autres sont fictifs, dont un NAS « Sans agent ». Noms de NAS, de dossiers, de tâches et de
// comptes suivent la langue : le parc sert aux captures du site. Les instants se calculent à
// partir de l'heure de la page, et les courbes sont synthétiques, déterministes (une graine
// par NAS).

import { type Locale, type Texts, tr } from "@/i18n";
import { bytes } from "@/lib/agents/time";
import { type Metric, PERIODS, type Period, type Point } from "./series";
import { buildChecks, specs, type Verdicts } from "./specs";
import type {
  AbbInfo,
  BackupLogEntry,
  BackupOutcome,
  BackupTask,
  Nas,
  Status,
  Volume,
} from "./types";

const allOk = (observed: string): Verdicts =>
  Object.fromEntries(specs("en").map((s) => [s.id, ["ok", observed]]));

/** Les contrôles du 2026-11-26, verts et dits comme l'agent les dit : les NAS fictifs n'ont
 * rien à signaler sur eux, sauf ce que chaque NAS précise. */
function newOk(lang: Locale, model: string): Verdicts {
  const ok = (en: string, fr: string): [Status, string] => [
    "ok",
    tr(lang, { en, fr }),
  ];
  return {
    "system.reachable": ok("DSM answers.", "DSM répond."),
    "system.cpu": ok(
      "Processor at 6 % on average over 15 min.",
      "Processeur à 6 % en moyenne sur 15 min.",
    ),
    "system.memory": ok(
      "Memory at 41 % on average over 15 min.",
      "Mémoire à 41 % en moyenne sur 15 min.",
    ),
    "system.temperature": ok(
      "Normal: system at 44 °C, hottest disk at 36 °C.",
      "Températures normales : système à 44 °C, disque le plus chaud à 36 °C.",
    ),
    "system.ntp": ok(
      "Clock synchronized with pool.ntp.org.",
      "Heure synchronisée avec pool.ntp.org.",
    ),
    "updates.reboot": ok(
      "No restart pending.",
      "Aucun redémarrage en attente.",
    ),
    "accounts.password_policy": ok(
      "At least 12 characters, common passwords refused.",
      "Au moins 12 caractères, mots de passe courants refusés.",
    ),
    "accounts.protection": ok(
      "Account protection on.",
      "Protection des comptes active.",
    ),
    "access.smb1": ok(
      "SMB1 refused, minimum SMB2.",
      "SMB1 refusé, protocole minimal SMB2.",
    ),
    "access.cleartext": ok(
      "No service sends in clear text.",
      "Aucun service ne transmet en clair.",
    ),
    "access.https": ok(
      "DSM redirects HTTP to HTTPS.",
      "DSM redirige HTTP vers HTTPS.",
    ),
    "access.logins": ok(
      "2 failed sign-ins in 24 h.",
      "2 échecs de connexion en 24 h.",
    ),
    "backup.offsite": ok(
      "1 task backs up off the NAS.",
      "1 tâche sauvegarde hors du NAS.",
    ),
    "backup.coverage": ok(
      "Every shared folder is in a backup.",
      "Chaque dossier partagé est dans une sauvegarde.",
    ),
    "backup.encryption": ok(
      "Copies off the NAS encrypted.",
      "Copies hors du NAS chiffrées.",
    ),
    "backup.abb_devices": ok(
      "Not applicable: no Active Backup task.",
      "Sans objet : aucune tâche Active Backup.",
    ),
    "backup.abb_offsite": ok(
      "Not applicable: no Active Backup task.",
      "Sans objet : aucune tâche Active Backup.",
    ),
    "backup.cloud_accounts": ok(
      "Not applicable: neither Active Backup for Microsoft 365 nor for Google Workspace.",
      "Sans objet : ni Active Backup for Microsoft 365 ni for Google Workspace.",
    ),
    "updates.advisories": ok(
      "No flaw published by Synology affects this NAS (140 advisories read).",
      "Aucune faille publiée par Synology ne touche ce NAS (140 avis lus).",
    ),
    "updates.lifecycle": ok(
      `Synology supports the ${model}: full updates.`,
      `Synology suit le ${model} : mises à jour complètes.`,
    ),
    "storage.disk_wear": ok(
      "4 disks without signs of wear, the oldest running for 2.6 years.",
      "4 disques sans signe d'usure, le plus ancien en marche depuis 2,6 ans.",
    ),
    "storage.smart_tests": ok(
      "2 SMART tests scheduled.",
      "2 tests SMART planifiés.",
    ),
    "storage.scrubbing": ok(
      "Data scrubbing scheduled or recent.",
      "Nettoyage des données planifié ou récent.",
    ),
    "storage.redundancy": ok(
      "Every storage pool survives the loss of a disk.",
      "Chaque groupe de stockage survit à la perte d'un disque.",
    ),
    "containers.state": ok(
      "6 containers, 6 running, none in trouble.",
      "6 conteneurs, 6 en marche, aucun en difficulté.",
    ),
    "shares.file_activity": ok(
      "31 deletions and 12 renames in 24 h, no burst.",
      "31 suppressions et 12 renommages en 24 h, aucune rafale.",
    ),
  };
}

/** Les postes et le serveur du Cabinet sous Active Backup for Business (fictifs). */
function demoAbb(lang: Locale, ago: (ms: number) => string): AbbInfo {
  const pc = (name: Texts, os: string, hours: number) => ({
    name: tr(lang, name),
    task: tr(lang, { en: "Workstations", fr: "Postes" }),
    type: "pc" as const,
    os,
    lastSuccessAt: ago(hours * HOUR),
    lastResult: "success",
    running: false,
  });
  return {
    activated: true,
    devices: [
      {
        name: tr(lang, { en: "srv-files", fr: "srv-dossiers" }),
        task: tr(lang, { en: "File server", fr: "Serveur de dossiers" }),
        type: "server",
        os: "Windows Server 2022",
        lastSuccessAt: ago(5 * HOUR),
        lastResult: "success",
        running: false,
      },
      pc({ en: "reception-pc", fr: "accueil-pc" }, "Windows 11", 17),
      pc({ en: "accounts-1", fr: "compta-1" }, "Windows 11", 18),
      pc({ en: "accounts-2", fr: "compta-2" }, "Windows 11", 18),
      pc({ en: "manager-mac", fr: "direction-mac" }, "macOS 26", 20),
      pc({ en: "lawyer-1", fr: "juriste-1" }, "Windows 11", 41),
      pc({ en: "lawyer-2", fr: "juriste-2" }, "Windows 11", 66),
    ],
  };
}

/** Les failles que les vrais avis de Synology (lus le 2026-11-26) trouvent à DSM 7.2.1-69057
 * Update 5, version de l'Entrepôt : identifiant, gravité, version qui corrige, ligne. */
const WAREHOUSE_FLAWS: [string, string, string, string][] = [
  ["Synology-SA-26:21", "Critical", "7.2.1-69057-14", "DSM 7.2.1"],
  ["Synology-SA-26:20", "Critical", "7.2.1-69057-14", "DSM 7.2.1"],
  ["Synology-SA-26:19", "Critical", "7.2.1-69057-13", "DSM 7.2"],
  ["Synology-SA-26:13", "Critical", "7.2.1-69057-12", "DSM 7.2.1"],
  ["Synology-SA-26:07", "Moderate", "7.2.1-69057-10", "DSM 7.2.1"],
  ["Synology-SA-26:06", "Important", "7.2.1-69057-10", "DSM 7.2.1"],
  ["Synology-SA-26:03", "Critical", "7.2.1-69057-11", "DSM 7.2.1"],
  ["Synology-SA-25:03", "Important", "7.2.1-69057-7", "DSM 7.2.1"],
  ["Synology-SA-25:01", "Moderate", "7.2.1-69057-7", "DSM 7.2.1"],
  ["Synology-SA-24:20", "Critical", "7.2.1-69057-6", "DSM 7.2.1"],
];

const SEVERITY_WORD: Record<string, Texts> = {
  Critical: { en: "critical", fr: "critique" },
  Important: { en: "important", fr: "importante" },
  Moderate: { en: "moderate", fr: "modérée" },
  Low: { en: "low", fr: "faible" },
};

const UNITS = ["o", "Ko", "Mo", "Go", "To", "Po"];

/** « 10,5 To » vers des octets (unités binaires, comme DSM) : les tailles du parc s'écrivent
 * à la française dans ce fichier et s'affichent dans la langue de la page. */
function parseSize(text: string): number | null {
  const m = /^([\d,.]+)\s*(o|Ko|Mo|Go|To|Po)$/.exec(text.trim());
  if (!m) return null;
  return Math.round(
    Number(m[1].replace(",", ".")) * 1024 ** UNITS.indexOf(m[2]),
  );
}

const disks = (lang: Locale, count: number, size: string, baseTemp: number) =>
  Array.from({ length: count }, (_, i) => ({
    bay: i + 1,
    size: bytes(parseSize(size), lang),
    temp: baseTemp + (i % 4),
    smart: "normal",
    status: "normal",
    healthy: true,
    device: `sata${i + 1}`,
    model: null,
    hours: 21_000 + i * 1_337 + baseTemp * 100,
    sizeBytes: null,
  }));

type V2Keys =
  | "ramMb"
  | "dsmUpdate"
  | "packages"
  | "network"
  | "agent"
  | "agentHistory"
  | "beszel"
  | "tzOffsetMin"
  | "backupLog"
  | "backupLogFrom"
  | "backupLogRead"
  | "seen"
  | "vitals"
  | "volumes"
  | "tasks";

/** Un NAS fictif tel qu'écrit à la main ; `demoFleetAt` lui ajoute instants et liens. */
type DemoBase = Omit<Nas, V2Keys> & {
  /** Minutes depuis la dernière lecture de l'agent fictif. */
  readMinutesAgo: number;
  vitals: Pick<Nas["vitals"], "cpu" | "ram" | "temp" | "uptime">;
  /** Tailles à la française (« 10,5 To »), rendues dans la langue par `demoFleetAt`. */
  volumes: Omit<Volume, "id" | "totalBytes" | "usedBytes">[];
  tasks: Omit<BackupTask, "lastSuccessAt" | "lastRunAt" | "running">[];
};

function base(lang: Locale): DemoBase[] {
  const t = (texts: Texts) => tr(lang, texts);
  const en = lang === "en";

  // Mots qui reviennent.
  const off = t({ en: "Off", fr: "Coupé" });
  const on = t({ en: "On", fr: "Actif" });
  const onF = t({ en: "On", fr: "Active" });
  const offF = t({ en: "Off", fr: "Coupée" });
  const none = t({ en: "none", fr: "aucun" });
  const succeeded = t({ en: "Succeeded", fr: "Réussie" });
  const today = t({ en: "Today", fr: "Aujourd'hui" });
  const tomorrow = (at: string) =>
    t({ en: `tomorrow, ${at}`, fr: `demain, ${at}` });
  const todayAt = (at: string) =>
    t({ en: `today, ${at}`, fr: `aujourd'hui, ${at}` });
  const hoursAgo = (h: number) => t({ en: `${h} h ago`, fr: `il y a ${h} h` });
  const daysAgo = (d: number) =>
    t({ en: `${d} days ago`, fr: `il y a ${d} jours` });
  const inDays = (d: number) =>
    t({ en: `in ${d} days`, fr: `dans ${d} jours` });
  const localMulti = t({
    en: "Local, multi-version",
    fr: "Locale, multiversion",
  });
  const cloudMulti = t({
    en: "Cloud, multi-version",
    fr: "Cloud, multiversion",
  });
  const pool1 = t({ en: "Storage pool 1", fr: "Groupe de stockage 1" });
  const firewall = t({ en: "Firewall", fr: "Pare-feu" });
  const autoBlock = t({ en: "Auto block", fr: "Blocage automatique" });
  const protection = t({
    en: "Account protection",
    fr: "Protection des comptes",
  });
  const enforced = t({
    en: "Two-factor authentication enforced",
    fr: "Double authentification imposée",
  });
  const signOut = t({
    en: "Sign-out after inactivity",
    fr: "Déconnexion après inactivité",
  });
  const forAdmins = t({ en: "For administrators", fr: "Aux administrateurs" });
  const forNobody = t({ en: "For nobody", fr: "À personne" });
  const business = t({ en: "Business", fr: "Entreprise" });
  const builtinAdmin = t({
    en: "Built-in administrator",
    fr: "Administrateur d'origine",
  });
  const administrator = t({ en: "Administrator", fr: "Administrateur" });
  const userRole = t({ en: "User", fr: "Utilisateur" });
  const guestRole = t({ en: "Guest", fr: "Invité" });
  const disabled = t({ en: "Disabled", fr: "Désactivé" });
  const active = t({ en: "Active", fr: "Actif" });
  const selfSigned = t({ en: "Self-signed", fr: "Autosigné" });
  const dsmBrowser = t({ en: "DSM, browser", fr: "DSM, navigateur" });
  const asExpected = t({ en: "As expected.", fr: "Conforme." });
  const colon = en ? ":" : " :";
  const q = (text: string) => (en ? `“${text}”` : `« ${text} »`);

  // Noms propres au parc, dans la langue de la page.
  const user = t({ en: "user", fr: "utilisateur" });
  const oldAccount = t({ en: "old-account", fr: "ancien-compte" });
  const manager = t({ en: "manager", fr: "gestion" });
  const accountant = t({ en: "accountant", fr: "comptable" });
  const reception = t({ en: "reception", fr: "secretariat" });
  const workshopUser = t({ en: "workshop", fr: "atelier" });
  const logistics = t({ en: "logistics", fr: "logistique" });
  const backups = t({ en: "backups", fr: "sauvegardes" });
  const testShare = t({ en: "test", fr: "essai" });
  const summerBooks = t({ en: "Summer books", fr: "Compta été" });
  const accounting = t({ en: "Accounting", fr: "Comptabilité" });
  const failingTest = t({ en: "Failing test", fr: "Essai en échec" });
  const localTest = t({ en: "Local test", fr: "Essai local" });
  const office = t({ en: "Office", fr: "Cabinet" });
  const officeDomain = en ? "nas.office.example.com" : "nas.cabinet-exemple.fr";
  const workshopDomain = en ? "workshop.example.com" : "atelier.exemple.fr";

  return [
    {
      id: "essai",
      name: t({ en: "Test NAS", fr: "NAS d'essai" }),
      model: "DS420+",
      dsm: "DSM 7.4.1-90080 Update 1",
      timeZone: "UTC+1, Amsterdam",
      place: t({ en: "Living room", fr: "Salon" }),
      readMinutesAgo: 2,
      reachable: true,
      real: true,
      live: false,
      readAt: null,
      problem: null,
      vitals: {
        cpu: 4,
        ram: 31,
        temp: 40,
        uptime: t({ en: "2 d 21 h", fr: "2 j 21 h" }),
      },
      volumes: [
        {
          path: "/volume1",
          fs: "Btrfs",
          raid: t({ en: "SHR, 1 disk", fr: "SHR, 1 disque" }),
          pct: 0,
          used: "102 Mo",
          total: "10,5 To",
          status: "normal",
        },
      ],
      pools: [{ name: pool1, raid: "SHR", status: "normal" }],
      disks: disks(lang, 1, "12 To", 38),
      shares: [
        {
          name: summerBooks,
          recycleBin: true,
          snapshots: t({
            en: "1 snapshot, not scheduled",
            fr: "1 instantané, non planifié",
          }),
        },
        { name: "docker", recycleBin: false, snapshots: none },
        {
          name: testShare,
          recycleBin: false,
          snapshots: t({
            en: "2 snapshots, every day",
            fr: "2 instantanés, chaque jour",
          }),
        },
        { name: "homes", recycleBin: false, snapshots: none },
        { name: backups, recycleBin: false, snapshots: none },
      ],
      tasks: [
        {
          name: failingTest,
          kind: localMulti,
          destination: backups,
          schedule: t({ en: "Run by hand", fr: "Lancée à la main" }),
          lastRun: hoursAgo(18),
          lastSuccess: t({
            en: "Sun, Nov 8, 4:57 PM",
            fr: "dim. 8 nov., 16:57",
          }),
          result: {
            status: "failed",
            text: t({
              en: "Destination write-protected",
              fr: "Destination protégée en écriture",
            }),
          },
          nextRun: t({ en: "none", fr: "aucune" }),
          integrityLast: t({ en: "never", fr: "jamais" }),
          integrityNext: t({ en: "not scheduled", fr: "non planifié" }),
        },
        {
          name: localTest,
          kind: localMulti,
          destination: backups,
          schedule: t({ en: "Every day at 3:00", fr: "Chaque jour à 3:00" }),
          lastRun: hoursAgo(67),
          lastSuccess: t({
            en: "Fri, Nov 6, 4:15 PM",
            fr: "ven. 6 nov., 16:15",
          }),
          result: {
            status: "failed",
            text: t({
              en: "Succeeded, but late: 67 h for 26 h expected",
              fr: "Réussie, mais en retard : 67 h pour 26 h attendues",
            }),
          },
          nextRun: tomorrow(en ? "3:00 AM" : "3:00"),
          integrityLast: todayAt(en ? "10:35 AM" : "10:35"),
          integrityNext: t({
            en: "Sun, Nov 15, 4:00 AM",
            fr: "dim. 15 nov., 4:00",
          }),
        },
      ],
      security: [
        { label: firewall, state: "failed", value: off },
        {
          label: autoBlock,
          state: "ok",
          value: t({
            en: "On, 10 failures within 5 min",
            fr: "Actif, 10 échecs en 5 min",
          }),
        },
        { label: protection, state: "neutral", value: offF },
        { label: enforced, state: "neutral", value: forNobody },
        {
          label: "SSH",
          state: "warning",
          value: t({ en: "Open, port 22", fr: "Ouvert, port 22" }),
        },
        { label: "Telnet", state: "ok", value: off },
        { label: "QuickConnect", state: "ok", value: off },
        { label: signOut, state: "neutral", value: "15 min" },
      ],
      advisor: {
        group: t({ en: "Home", fr: "Maison" }),
        rules: 31,
        passed: 21,
        failed: 2,
        skipped: 8,
        lastRun: todayAt(en ? "7:39 AM" : "7:39"),
        failedRules: [
          {
            state: "failed",
            title: t({
              en: "Default SSH port (22)",
              fr: "Port SSH par défaut (22)",
            }),
            area: t({ en: "Network", fr: "Réseau" }),
          },
          {
            state: "neutral",
            title: t({
              en: "DSM update notifications",
              fr: "Notifications de mise à jour de DSM",
            }),
            area: t({ en: "Updates, info", fr: "Mises à jour, info" }),
          },
        ],
      },
      certificates: [
        {
          name: "synology",
          issuer: selfSigned,
          until: t({ en: "Nov 7, 2027", fr: "7 nov. 2027" }),
          days: 363,
          services: 4,
          isDefault: true,
        },
      ],
      accounts: [
        {
          name: "admin",
          role: builtinAdmin,
          state: disabled,
          twoFactor: false,
        },
        { name: user, role: administrator, state: active, twoFactor: false },
        {
          name: "claude",
          role: t({
            en: "Administrator, the agent’s account",
            fr: "Administrateur, compte de l'agent",
          }),
          state: active,
          twoFactor: false,
        },
        { name: "guest", role: guestRole, state: disabled, twoFactor: false },
      ],
      ups: t({ en: "No UPS configured", fr: "Aucun onduleur configuré" }),
      connected: [
        {
          who: user,
          protocol: dsmBrowser,
          from: "192.0.2.10",
          since: en ? "9:58 AM" : "9:58",
          device: "Safari, macOS",
        },
        {
          who: "claude",
          protocol: t({ en: "DSM API", fr: "API de DSM" }),
          from: "192.0.2.20",
          since: en ? "10:37 AM" : "10:37",
          device: "nas-agent",
          isAgent: true,
        },
      ],
      activity: [
        {
          day: today,
          time: en ? "10:37 AM" : "10:37",
          level: "ok",
          source: "connections",
          who: "claude",
          text: t({
            en: "Signed in to DSM, through the API.",
            fr: "Connexion à DSM réussie, par l'API.",
          }),
        },
        {
          day: today,
          time: en ? "10:35 AM" : "10:35",
          level: "ok",
          source: "settings",
          who: "SYSTEM_ADMIN",
          text: t({
            en: `Hyper Backup: integrity check of ${q(localTest)} started.`,
            fr: `Hyper Backup : contrôle d'intégrité de ${q(localTest)} lancé.`,
          }),
        },
        {
          day: today,
          time: en ? "9:58 AM" : "9:58",
          level: "ok",
          source: "connections",
          who: user,
          text: t({
            en: "Signed in to DSM from 192.0.2.10.",
            fr: "Connexion à DSM réussie, depuis 192.0.2.10.",
          }),
        },
        {
          day: today,
          time: en ? "7:40 AM" : "7:40",
          level: "ok",
          source: "settings",
          who: "SYSTEM_ADMIN",
          text: t({
            en: `Scheduled task ${q("Snapshot of the test folder")} created.`,
            fr: `Tâche planifiée ${q("Instantané du dossier essai")} créée.`,
          }),
        },
        ...[en ? "1:10 PM" : "13:10", en ? "1:09 PM" : "13:09"].map((time) => ({
          day: t({ en: "Friday, November 6", fr: "Vendredi 6 novembre" }),
          time,
          level: "warning" as const,
          source: "connections" as const,
          who: oldAccount,
          text: t({
            en: "DSM sign-in refused from 192.0.2.1: access denied.",
            fr: "Connexion à DSM refusée depuis 192.0.2.1 : autorisation refusée.",
          }),
        })),
      ],
      fileLogs: "off",
      checks: buildChecks(
        {
          ...newOk(lang, "DS420+"),
          // Contrôles du 2026-11-26, lus en direct sur le NAS d'essai ce jour-là.
          "system.cpu": [
            "ok",
            t({
              en: "Processor at 8 % right now.",
              fr: "Processeur à 8 % en ce moment.",
            }),
          ],
          "system.memory": [
            "ok",
            t({
              en: "Memory at 35 % right now.",
              fr: "Mémoire à 35 % en ce moment.",
            }),
          ],
          "system.temperature": [
            "ok",
            t({
              en: "Normal: system at 40 °C, hottest disk at 32 °C.",
              fr: "Températures normales : système à 40 °C, disque le plus chaud à 32 °C.",
            }),
          ],
          "system.ntp": [
            "ok",
            t({
              en: "Clock synchronized with time.google.com.",
              fr: "Heure synchronisée avec time.google.com.",
            }),
          ],
          "accounts.password_policy": [
            "warning",
            t({ en: "Passwords too easy.", fr: "Mots de passe trop faciles." }),
            [
              t({
                en: "minimum length 8 (at least 10 expected)",
                fr: "longueur minimale 8 (au moins 10 attendus)",
              }),
              t({
                en: "common passwords accepted",
                fr: "mots de passe courants acceptés",
              }),
            ],
          ],
          "accounts.protection": [
            "warning",
            t({
              en: "Account protection off: nothing slows down password guessing on an account.",
              fr: "Protection des comptes coupée : rien ne freine les essais de mots de passe sur un compte.",
            }),
          ],
          "access.https": [
            "warning",
            t({
              en: "DSM still answers over HTTP (port 5000) without redirecting to HTTPS.",
              fr: "DSM répond encore en HTTP (port 5000) sans redirection vers HTTPS.",
            }),
          ],
          "access.logins": [
            "ok",
            t({
              en: "0 failed sign-ins in 24 h.",
              fr: "0 échec de connexion en 24 h.",
            }),
          ],
          "backup.offsite": [
            "warning",
            t({
              en: "2 tasks, all to the NAS itself or a disk plugged into it: a theft, a fire or ransomware would take them along.",
              fr: "2 tâches, toutes vers le NAS lui-même ou un disque branché dessus : un vol, un incendie ou un rançongiciel les emporterait avec lui.",
            }),
          ],
          "backup.coverage": [
            "warning",
            t({
              en: "3 shared folders in no backup.",
              fr: "3 dossiers partagés dans aucune sauvegarde.",
            }),
            [summerBooks, "docker", "homes"],
          ],
          "backup.encryption": [
            "ok",
            t({
              en: "Not applicable: no copy off the NAS.",
              fr: "Sans objet : aucune copie hors du NAS.",
            }),
          ],
          "storage.disk_wear": [
            "ok",
            t({
              en: "1 disk without signs of wear, the oldest running for 5.4 years.",
              fr: "1 disque sans signe d'usure, le plus ancien en marche depuis 5,4 ans.",
            }),
          ],
          "storage.smart_tests": [
            "warning",
            t({
              en: "No SMART test scheduled.",
              fr: "Aucun test SMART planifié.",
            }),
          ],
          "storage.scrubbing": [
            "ok",
            t({
              en: "Not applicable: no redundant storage pool to scrub.",
              fr: "Sans objet : aucun groupe de stockage redondant à nettoyer.",
            }),
          ],
          "storage.redundancy": [
            "warning",
            t({
              en: "1 pool without redundancy: one failing disk and the volume is lost.",
              fr: "1 groupe sans redondance : un disque qui lâche et le volume est perdu.",
            }),
            [
              t({
                en: "/volume1: SHR without protection",
                fr: "/volume1 : SHR sans protection",
              }),
            ],
          ],
          "containers.state": [
            "ok",
            t({
              en: "5 containers, 5 running, none in trouble.",
              fr: "5 conteneurs, 5 en marche, aucun en difficulté.",
            }),
          ],
          "shares.file_activity": [
            "unknown",
            t({
              en: "Transfer log off: a mass deletion would go unnoticed.",
              fr: "Journal des transferts coupé : une suppression en masse passerait inaperçue.",
            }),
          ],
          "updates.dsm": [
            "ok",
            t({
              en: "DSM 7.4.1-90080 Update 1, up to date.",
              fr: "DSM 7.4.1-90080 Update 1, à jour.",
            }),
          ],
          "updates.packages": [
            "ok",
            t({ en: "13 packages, up to date.", fr: "13 paquets, à jour." }),
          ],
          "accounts.admin_two_factor": [
            "failed",
            t({
              en: "1 active administrator without two-factor authentication, the agent’s account excluded; two-factor authentication enforced for: nobody.",
              fr: "1 administrateur actif sans double authentification, compte de l'agent exclu ; double authentification imposée : à personne.",
            }),
            [user],
          ],
          "accounts.builtin_admin": [
            "ok",
            t({
              en: "“admin” account disabled.",
              fr: "Compte « admin » désactivé.",
            }),
          ],
          "accounts.guest": [
            "ok",
            t({
              en: "“guest” account disabled.",
              fr: "Compte « guest » désactivé.",
            }),
          ],
          "access.ssh": [
            "warning",
            t({ en: "SSH open, port 22.", fr: "SSH ouvert, port 22." }),
          ],
          "access.telnet": [
            "ok",
            t({ en: "Telnet off.", fr: "Telnet coupé." }),
          ],
          "access.firewall": [
            "failed",
            t({ en: "Firewall off.", fr: "Pare-feu coupé." }),
          ],
          "access.auto_block": [
            "ok",
            t({
              en: "Auto block on: 10 failures within 5 min.",
              fr: "Blocage automatique actif : 10 échecs en 5 min.",
            }),
          ],
          "access.quickconnect": [
            "ok",
            t({ en: "QuickConnect off.", fr: "QuickConnect coupé." }),
          ],
          "certificates.validity": [
            "ok",
            t({
              en: "1 certificate in use, valid.",
              fr: "1 certificat utilisé, valide.",
            }),
          ],
          "backup.recent_success": [
            "failed",
            t({
              en: "2 tasks at fault out of 2.",
              fr: "2 tâches en cause sur 2.",
            }),
            [
              t({
                en: `${failingTest}: not scheduled, last success 18 h ago`,
                fr: `${failingTest} : sans planning, dernière réussite il y a 18 h`,
              }),
              t({
                en: `${localTest}: last success 67 h ago, at most 26 h expected`,
                fr: `${localTest} : dernière réussite il y a 67 h, au plus 26 h attendues`,
              }),
            ],
          ],
          "backup.last_result": [
            "failed",
            t({
              en: "1 task in error out of 2.",
              fr: "1 tâche en erreur sur 2.",
            }),
            [`${failingTest}${colon} failed_checking`],
          ],
          "backup.integrity": [
            "warning",
            t({
              en: "1 task at fault out of 2.",
              fr: "1 tâche en cause sur 2.",
            }),
            [
              t({
                en: `${failingTest}: never checked`,
                fr: `${failingTest} : jamais contrôlée`,
              }),
            ],
          ],
          "storage.volume_usage": [
            "ok",
            t({ en: "1 volume, below 80 %.", fr: "1 volume, sous 80 %." }),
          ],
          "storage.disks": [
            "ok",
            t({ en: "1 disk, healthy.", fr: "1 disque, sain." }),
          ],
          "storage.pools": [
            "ok",
            t({
              en: "1 storage pool and 1 volume in normal state.",
              fr: "1 groupe de stockage et 1 volume en état normal.",
            }),
          ],
          "ups.configured": [
            "warning",
            t({ en: "No UPS configured.", fr: "Aucun onduleur configuré." }),
          ],
          "security_advisor.critical": [
            "failed",
            t({
              en: "1 critical issue, 0 warnings; last scan less than a day ago, rule set “home”.",
              fr: "1 point critique, 0 avertissement ; dernière analyse il y a moins d'un jour, groupe de règles « home ».",
            }),
            ["ruleDB.Terminal.SSH.sshPortCheck (risk)"],
          ],
          "shares.recycle_bin": [
            "warning",
            t({
              en: "4 shared folders without a recycle bin.",
              fr: "4 dossiers partagés sans corbeille.",
            }),
            ["docker", testShare, "homes", backups],
          ],
          "shares.snapshots": [
            "warning",
            t({
              en: "4 shared folders without scheduled snapshots.",
              fr: "4 dossiers partagés sans instantanés planifiés.",
            }),
            [summerBooks, "docker", "homes", backups],
          ],
        },
        lang,
      ),
    },
    {
      id: "cabinet",
      name: office,
      model: "DS923+",
      dsm: "DSM 7.4.1-90080 Update 2",
      timeZone: "UTC+1, Paris",
      place: t({ en: "Office, network rack", fr: "Bureau, baie réseau" }),
      readMinutesAgo: 4,
      reachable: true,
      real: false,
      live: false,
      readAt: null,
      problem: null,
      vitals: {
        cpu: 22,
        ram: 58,
        temp: 46,
        uptime: t({ en: "41 d", fr: "41 j" }),
      },
      volumes: [
        {
          path: "/volume1",
          fs: "Btrfs",
          raid: t({ en: "SHR, 4 disks", fr: "SHR, 4 disques" }),
          pct: 83.4,
          used: "13,4 To",
          total: "16,1 To",
          status: "normal",
        },
      ],
      pools: [{ name: pool1, raid: "SHR", status: "normal" }],
      disks: disks(lang, 4, "6 To", 40),
      shares: [
        {
          name: "Clients",
          recycleBin: true,
          snapshots: t({
            en: "every day, 30 days kept",
            fr: "chaque jour, 30 jours gardés",
          }),
        },
        {
          name: accounting,
          recycleBin: true,
          snapshots: t({
            en: "every day, 30 days kept",
            fr: "chaque jour, 30 jours gardés",
          }),
        },
        { name: "Scans", recycleBin: true, snapshots: none },
        { name: "homes", recycleBin: true, snapshots: none },
      ],
      tasks: [
        {
          name: t({ en: "Server to the cloud", fr: "Serveur vers le cloud" }),
          kind: cloudMulti,
          destination: "Synology C2",
          schedule: t({ en: "Every day at 1:00", fr: "Chaque jour à 1:00" }),
          lastRun: hoursAgo(9),
          lastSuccess: todayAt(en ? "1:42 AM" : "1:42"),
          result: { status: "ok", text: succeeded },
          nextRun: tomorrow(en ? "1:00 AM" : "1:00"),
          integrityLast: daysAgo(12),
          integrityNext: inDays(18),
        },
        {
          name: t({ en: "Weekly USB copy", fr: "Copie USB hebdomadaire" }),
          kind: localMulti,
          destination: t({ en: "USB disk", fr: "Disque USB" }),
          schedule: t({ en: "Sundays at 22:00", fr: "Le dimanche à 22:00" }),
          lastRun: t({ en: "2 d ago", fr: "il y a 2 j" }),
          lastSuccess: t({
            en: "Sun, Nov 8, 11:10 PM",
            fr: "dim. 8 nov., 23:10",
          }),
          result: { status: "ok", text: succeeded },
          nextRun: t({
            en: "Sun, Nov 15, 10:00 PM",
            fr: "dim. 15 nov., 22:00",
          }),
          integrityLast: daysAgo(9),
          integrityNext: inDays(21),
        },
      ],
      security: [
        {
          label: firewall,
          state: "ok",
          value: t({
            en: "On, profile “Office”",
            fr: "Actif, profil « Bureau »",
          }),
        },
        {
          label: autoBlock,
          state: "ok",
          value: t({
            en: "On, 5 failures within 10 min",
            fr: "Actif, 5 échecs en 10 min",
          }),
        },
        { label: protection, state: "ok", value: onF },
        { label: enforced, state: "ok", value: forAdmins },
        { label: "SSH", state: "ok", value: off },
        { label: "Telnet", state: "ok", value: off },
        { label: "QuickConnect", state: "ok", value: off },
        { label: signOut, state: "neutral", value: "15 min" },
      ],
      advisor: {
        group: business,
        rules: 44,
        passed: 41,
        failed: 0,
        skipped: 3,
        lastRun: todayAt(en ? "3:00 AM" : "3:00"),
        failedRules: [],
      },
      certificates: [
        {
          name: officeDomain,
          issuer: "Let's Encrypt",
          until: t({ en: "Nov 30, 2026", fr: "30 nov. 2026" }),
          days: 21,
          services: 3,
          isDefault: true,
        },
      ],
      accounts: [
        {
          name: "admin",
          role: builtinAdmin,
          state: disabled,
          twoFactor: false,
        },
        { name: manager, role: administrator, state: active, twoFactor: true },
        { name: accountant, role: userRole, state: active, twoFactor: true },
        { name: reception, role: userRole, state: active, twoFactor: false },
        { name: "guest", role: guestRole, state: disabled, twoFactor: false },
      ],
      ups: t({
        en: "APC Back-UPS, USB: on mains power, 100% charge",
        fr: "APC Back-UPS, USB : sur secteur, charge 100 %",
      }),
      connected: [
        {
          who: accountant,
          protocol: "SMB",
          from: "192.0.2.41",
          since: en ? "8:31 AM" : "8:31",
          device: "Windows 11",
        },
        {
          who: reception,
          protocol: "SMB",
          from: "192.0.2.42",
          since: en ? "8:47 AM" : "8:47",
          device: "Windows 11",
        },
        {
          who: manager,
          protocol: dsmBrowser,
          from: "198.51.100.7",
          since: en ? "10:20 AM" : "10:20",
          device: "Firefox, Windows",
        },
      ],
      activity: [
        {
          day: today,
          time: en ? "10:31 AM" : "10:31",
          level: "warning",
          source: "files",
          who: reception,
          text: t({
            en: "Deleted “Clients/2024/Martin quote.pdf” (SMB).",
            fr: "A supprimé « Clients/2024/Devis Martin.pdf » (SMB).",
          }),
        },
        {
          day: today,
          time: en ? "10:22 AM" : "10:22",
          level: "ok",
          source: "settings",
          who: manager,
          text: t({
            en: "Changed the shared folder “Scans”: quota raised to 200 GB.",
            fr: "A modifié le dossier partagé « Scans » : quota porté à 200 Go.",
          }),
        },
        {
          day: today,
          time: en ? "10:20 AM" : "10:20",
          level: "ok",
          source: "connections",
          who: manager,
          text: t({
            en: "Signed in to DSM from 198.51.100.7, with two-factor authentication.",
            fr: "Connexion à DSM réussie, depuis 198.51.100.7, double authentification.",
          }),
        },
        {
          day: today,
          time: en ? "9:12 AM" : "9:12",
          level: "ok",
          source: "files",
          who: accountant,
          text: t({
            en: `Moved 14 files from “Scans” to “${accounting}/2026/10” (SMB).`,
            fr: `A déplacé 14 fichiers de « Scans » vers « ${accounting}/2026/10 » (SMB).`,
          }),
        },
        {
          day: today,
          time: en ? "8:47 AM" : "8:47",
          level: "ok",
          source: "connections",
          who: reception,
          text: t({
            en: "SMB connection from 192.0.2.42.",
            fr: "Connexion SMB depuis 192.0.2.42.",
          }),
        },
        {
          day: t({ en: "Sunday, November 8", fr: "Dimanche 8 novembre" }),
          time: en ? "11:58 PM" : "23:58",
          level: "warning",
          source: "connections",
          who: "admin",
          text: t({
            en: "5 sign-ins refused from 203.0.113.80: address blocked.",
            fr: "5 connexions refusées depuis 203.0.113.80 : adresse bloquée.",
          }),
        },
      ],
      fileLogs: "on",
      checks: buildChecks(
        {
          ...newOk(lang, "DS923+"),
          ...allOk(asExpected),
          "updates.dsm": [
            "ok",
            t({
              en: "DSM 7.4.1-90080 Update 2, up to date.",
              fr: "DSM 7.4.1-90080 Update 2, à jour.",
            }),
          ],
          "backup.abb_devices": [
            "ok",
            t({
              en: "7 devices backed up on time.",
              fr: "7 appareils sauvegardés à temps.",
            }),
          ],
          "backup.abb_offsite": [
            "ok",
            t({
              en: "Device backups copied off the NAS by Hyper Backup.",
              fr: "Sauvegardes des appareils copiées hors du NAS par Hyper Backup.",
            }),
          ],
          "backup.cloud_accounts": [
            "ok",
            t({
              en: "1 task backed up on time.",
              fr: "1 tâche sauvegardée à temps.",
            }),
          ],
          "updates.packages": [
            "ok",
            t({ en: "9 packages, up to date.", fr: "9 paquets, à jour." }),
          ],
          "accounts.admin_two_factor": [
            "ok",
            t({
              en: "0 active administrators without two-factor authentication; two-factor authentication enforced for: administrators.",
              fr: "0 administrateur actif sans double authentification ; double authentification imposée : aux administrateurs.",
            }),
          ],
          "access.firewall": [
            "ok",
            t({
              en: "Firewall on, profile “Office”.",
              fr: "Pare-feu actif, profil « Bureau ».",
            }),
          ],
          "access.auto_block": [
            "ok",
            t({
              en: "Auto block on: 5 failures within 10 min.",
              fr: "Blocage automatique actif : 5 échecs en 10 min.",
            }),
          ],
          "certificates.validity": [
            "warning",
            t({
              en: "1 certificate in use to renew.",
              fr: "1 certificat utilisé à renouveler.",
            }),
            [
              t({
                en: `${officeDomain}: expires in 21 days`,
                fr: `${officeDomain} : expire dans 21 jours`,
              }),
            ],
          ],
          "backup.recent_success": [
            "ok",
            t({
              en: "2 tasks, succeeded on time.",
              fr: "2 tâches, réussies dans les délais.",
            }),
          ],
          "backup.last_result": [
            "ok",
            t({
              en: "No task in error out of 2.",
              fr: "Aucune tâche en erreur sur 2.",
            }),
          ],
          "backup.integrity": [
            "ok",
            t({
              en: "2 tasks checked on time.",
              fr: "2 tâches contrôlées à temps.",
            }),
          ],
          "storage.volume_usage": [
            "warning",
            t({
              en: "1 volume above 80 %.",
              fr: "1 volume au-dessus de 80 %.",
            }),
            [en ? "/volume1: 83.4 %" : "/volume1 : 83,4 %"],
          ],
          "storage.disks": [
            "ok",
            t({ en: "4 disks, healthy.", fr: "4 disques, sains." }),
          ],
          "ups.configured": [
            "ok",
            t({
              en: "UPS (usb) on mains power.",
              fr: "Onduleur (USB) sur secteur.",
            }),
          ],
          "security_advisor.critical": [
            "ok",
            t({
              en: "0 critical issues, 0 warnings; last scan less than a day ago, rule set “business”.",
              fr: "0 point critique, 0 avertissement ; dernière analyse il y a moins d'un jour, groupe de règles « business ».",
            }),
          ],
          "shares.snapshots": [
            "warning",
            t({
              en: "2 shared folders without scheduled snapshots.",
              fr: "2 dossiers partagés sans instantanés planifiés.",
            }),
            ["Scans", "homes"],
          ],
        },
        lang,
      ),
    },
    {
      id: "atelier",
      name: t({ en: "Workshop", fr: "Atelier" }),
      model: "DS224+",
      dsm: "DSM 7.4.1-90080 Update 2",
      timeZone: "UTC+1, Paris",
      place: t({ en: "Workshop", fr: "Atelier" }),
      readMinutesAgo: 3,
      reachable: true,
      real: false,
      live: false,
      readAt: null,
      problem: null,
      vitals: {
        cpu: 7,
        ram: 36,
        temp: 38,
        uptime: t({ en: "18 d", fr: "18 j" }),
      },
      volumes: [
        {
          path: "/volume1",
          fs: "Btrfs",
          raid: t({ en: "SHR, 2 disks", fr: "SHR, 2 disques" }),
          pct: 41.2,
          used: "1,5 To",
          total: "3,6 To",
          status: "normal",
        },
      ],
      pools: [{ name: pool1, raid: "SHR", status: "normal" }],
      disks: disks(lang, 2, "4 To", 37),
      shares: [
        {
          name: t({ en: "Drawings", fr: "Plans" }),
          recycleBin: true,
          snapshots: t({ en: "every 4 h", fr: "toutes les 4 h" }),
        },
        {
          name: "Photos",
          recycleBin: true,
          snapshots: t({ en: "every day", fr: "chaque jour" }),
        },
      ],
      tasks: [
        {
          name: t({ en: "To the Office NAS", fr: "Vers le NAS du Cabinet" }),
          kind: t({
            en: "Remote, multi-version",
            fr: "Distante, multiversion",
          }),
          destination: `${office}, Hyper Backup Vault`,
          schedule: t({ en: "Every day at 2:00", fr: "Chaque jour à 2:00" }),
          lastRun: hoursAgo(8),
          lastSuccess: todayAt(en ? "2:24 AM" : "2:24"),
          result: { status: "ok", text: succeeded },
          nextRun: tomorrow(en ? "2:00 AM" : "2:00"),
          integrityLast: daysAgo(4),
          integrityNext: inDays(26),
        },
      ],
      security: [
        { label: firewall, state: "ok", value: on },
        { label: autoBlock, state: "ok", value: on },
        { label: protection, state: "ok", value: onF },
        { label: enforced, state: "ok", value: forAdmins },
        { label: "SSH", state: "ok", value: off },
        { label: "Telnet", state: "ok", value: off },
        { label: "QuickConnect", state: "ok", value: off },
        { label: signOut, state: "neutral", value: "15 min" },
      ],
      advisor: {
        group: business,
        rules: 44,
        passed: 42,
        failed: 0,
        skipped: 2,
        lastRun: t({ en: "Sun, Nov 8, 3:00 AM", fr: "dim. 8 nov., 3:00" }),
        failedRules: [],
      },
      certificates: [
        {
          name: workshopDomain,
          issuer: "Let's Encrypt",
          until: t({ en: "Feb 2, 2027", fr: "2 févr. 2027" }),
          days: 85,
          services: 2,
          isDefault: true,
        },
      ],
      accounts: [
        {
          name: "admin",
          role: builtinAdmin,
          state: disabled,
          twoFactor: false,
        },
        { name: manager, role: administrator, state: active, twoFactor: true },
        { name: workshopUser, role: userRole, state: active, twoFactor: false },
      ],
      ups: t({
        en: "Eaton Ellipse, USB: on mains power, 100% charge",
        fr: "Eaton Ellipse, USB : sur secteur, charge 100 %",
      }),
      connected: [
        {
          who: workshopUser,
          protocol: "SMB",
          from: "192.0.2.61",
          since: en ? "7:55 AM" : "7:55",
          device: "macOS",
        },
      ],
      activity: [
        {
          day: today,
          time: en ? "7:55 AM" : "7:55",
          level: "ok",
          source: "connections",
          who: workshopUser,
          text: t({
            en: "SMB connection from 192.0.2.61.",
            fr: "Connexion SMB depuis 192.0.2.61.",
          }),
        },
        {
          day: today,
          time: en ? "2:24 AM" : "2:24",
          level: "ok",
          source: "settings",
          who: "SYSTEM",
          text: t({
            en: `Hyper Backup: ${q("To the Office NAS")} succeeded.`,
            fr: `Hyper Backup : ${q("Vers le NAS du Cabinet")} réussie.`,
          }),
        },
      ],
      fileLogs: "off",
      checks: buildChecks(allOk(asExpected), lang),
    },
    {
      id: "entrepot",
      name: t({ en: "Warehouse", fr: "Entrepôt" }),
      model: "RS1221+",
      dsm: "DSM 7.2.1-69057 Update 5",
      timeZone: "UTC+1, Paris",
      place: t({
        en: "Warehouse, server room",
        fr: "Entrepôt, local technique",
      }),
      readMinutesAgo: 192,
      reachable: false,
      real: false,
      live: false,
      readAt: null,
      problem: null,
      vitals: {
        cpu: null,
        ram: null,
        temp: 51,
        uptime: t({ en: "unknown", fr: "inconnue" }),
      },
      volumes: [
        {
          path: "/volume1",
          fs: "Btrfs",
          raid: t({ en: "RAID 6, 8 disks", fr: "RAID 6, 8 disques" }),
          pct: 61,
          used: "39 To",
          total: "64 To",
          status: "normal",
        },
      ],
      pools: [{ name: pool1, raid: "RAID 6", status: "normal" }],
      disks: disks(lang, 8, "12 To", 40),
      shares: [
        {
          name: "Archives",
          recycleBin: true,
          snapshots: t({ en: "every week", fr: "chaque semaine" }),
        },
        {
          name: t({ en: "Video", fr: "Vidéo" }),
          recycleBin: false,
          snapshots: none,
        },
      ],
      tasks: [
        {
          name: t({
            en: "Archives to the cloud",
            fr: "Archives vers le cloud",
          }),
          kind: cloudMulti,
          destination: t({ en: "S3 storage", fr: "Stockage S3" }),
          schedule: t({ en: "Saturdays at 20:00", fr: "Le samedi à 20:00" }),
          lastRun: t({ en: "2 d ago", fr: "il y a 2 j" }),
          lastSuccess: t({
            en: "Sat, Nov 7, 11:51 PM",
            fr: "sam. 7 nov., 23:51",
          }),
          result: { status: "ok", text: succeeded },
          nextRun: t({ en: "Sat, Nov 14, 8:00 PM", fr: "sam. 14 nov., 20:00" }),
          integrityLast: daysAgo(33),
          integrityNext: t({ en: "not scheduled", fr: "non planifié" }),
        },
      ],
      security: [
        { label: firewall, state: "ok", value: on },
        { label: autoBlock, state: "ok", value: on },
        { label: protection, state: "ok", value: onF },
        { label: enforced, state: "neutral", value: forNobody },
        { label: "SSH", state: "ok", value: off },
        { label: "Telnet", state: "ok", value: off },
        { label: "QuickConnect", state: "warning", value: on },
        { label: signOut, state: "neutral", value: "30 min" },
      ],
      advisor: {
        group: business,
        rules: 44,
        passed: 43,
        failed: 0,
        skipped: 1,
        lastRun: daysAgo(6),
        failedRules: [],
      },
      certificates: [
        {
          name: "synology",
          issuer: selfSigned,
          until: t({ en: "Mar 3, 2027", fr: "3 mars 2027" }),
          days: 114,
          services: 4,
          isDefault: true,
        },
      ],
      accounts: [
        {
          name: "admin",
          role: builtinAdmin,
          state: disabled,
          twoFactor: false,
        },
        {
          name: logistics,
          role: administrator,
          state: active,
          twoFactor: true,
        },
      ],
      ups: t({
        en: "Network UPS (client): last known state, on mains power",
        fr: "Onduleur réseau (client) : dernier état connu, sur secteur",
      }),
      connected: [],
      activity: [
        {
          day: today,
          time: en ? "7:30 AM" : "7:30",
          level: "warning",
          source: "connections",
          who: "agent",
          text: t({
            en: "Last successful read. Since then, the agent no longer answers over Tailscale.",
            fr: "Dernière lecture réussie. Depuis, l'agent ne répond plus sur Tailscale.",
          }),
        },
      ],
      fileLogs: "off",
      checks: buildChecks(
        {
          ...newOk(lang, "RS1221+"),
          ...allOk(
            t({
              en: "As expected at the last read.",
              fr: "Conforme à la dernière lecture.",
            }),
          ),
          "access.quickconnect": [
            "warning",
            t({
              en: "QuickConnect on: DSM is reachable through Synology’s relays.",
              fr: "QuickConnect actif : DSM est joignable par les relais de Synology.",
            }),
          ],
          "backup.integrity": [
            "ok",
            t({
              en: "1 task checked on time (33 days).",
              fr: "1 tâche contrôlée à temps (33 jours).",
            }),
          ],
          // Resté en Update 5 : DSM propose l'Update 14, que les avis demandent.
          "updates.dsm": [
            "warning",
            t({
              en: "DSM 7.2.1-69057 Update 5; update available: DSM 7.2.1-69057 Update 14.",
              fr: "DSM 7.2.1-69057 Update 5 ; mise à jour disponible : DSM 7.2.1-69057 Update 14.",
            }),
            ["DSM 7.2.1-69057 Update 14"],
          ],
          // Les vrais avis de Synology lus le 2026-11-26, face à DSM 7.2.1-69057 Update 5.
          "updates.advisories": [
            "failed",
            t({
              en: "10 flaws published by Synology affect this NAS, 10 with a fix.",
              fr: "10 failles publiées par Synology touchent ce NAS, 10 avec un correctif.",
            }),
            WAREHOUSE_FLAWS.map(([id, sev, fix]) =>
              t({
                en: `${id}, ${SEVERITY_WORD[sev].en}: DSM ${fix} fixes it`,
                fr: `${id}, ${SEVERITY_WORD[sev].fr} : DSM ${fix} la corrige`,
              }),
            ),
          ],
        },
        lang,
      ),
    },
    {
      id: "bz-demo-cave",
      name: t({ en: "Basement", fr: "Cave" }),
      model: "–",
      dsm: "–",
      timeZone: "–",
      place: "",
      readMinutesAgo: 0,
      reachable: true,
      real: false,
      live: false,
      readAt: null,
      problem: null,
      vitals: {
        cpu: null,
        ram: null,
        temp: null,
        uptime: t({ en: "12 d", fr: "12 j" }),
      },
      volumes: [],
      pools: [],
      disks: disks(lang, 2, "8 To", 35),
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
      ups: t({ en: "Unknown", fr: "Inconnu" }),
      connected: [],
      activity: [],
      fileLogs: "unknown",
      checks: [],
    },
  ];
}

// Ce que chaque NAS fictif ajoute au modèle v2 -------------------------------------------------

interface DemoTask {
  /** Heures depuis le dernier lancement et la dernière réussite. */
  runH: number;
  successH: number;
  /** Jours (avant aujourd'hui, heure du NAS) sans exécution, en échec ou partiels. */
  skip?: number[];
  fail?: number[];
  partial?: number[];
  /** Jour de la semaine (0 = dimanche) pour une tâche hebdomadaire. */
  weekday?: number;
}

interface DemoExtra {
  agent: "ok" | "down" | "none";
  /** Minutes depuis le dernier relevé de Beszel ; hors ligne au-delà de 5. */
  beszelMin: number;
  vitals: {
    cpu: number | null;
    ram: number | null;
    temp: number | null;
    netBps: number | null;
  };
  /** Une entrée par tâche de sauvegarde, dans l'ordre de `tasks` : les noms suivent la langue. */
  tasks: DemoTask[];
}

const EXTRA: Record<string, DemoExtra> = {
  essai: {
    agent: "ok",
    beszelMin: 1,
    vitals: { cpu: 4, ram: 31, temp: 40, netBps: 2_051 },
    tasks: [
      { runH: 18, successH: 66, fail: [0, 1, 2] },
      { runH: 67, successH: 67, skip: [0, 1] },
    ],
  },
  cabinet: {
    agent: "ok",
    beszelMin: 1,
    vitals: { cpu: 22, ram: 58, temp: 46, netBps: 1_850_000 },
    tasks: [
      { runH: 9, successH: 9, partial: [12], fail: [19] },
      { runH: 48, successH: 48, weekday: 0 },
    ],
  },
  atelier: {
    agent: "ok",
    beszelMin: 1,
    vitals: { cpu: 7, ram: 36, temp: 38, netBps: 420_000 },
    tasks: [{ runH: 8, successH: 8, skip: [23] }],
  },
  entrepot: {
    agent: "down",
    beszelMin: 190,
    vitals: { cpu: null, ram: null, temp: 51, netBps: null },
    tasks: [{ runH: 48, successH: 48, weekday: 6 }],
  },
  "bz-demo-cave": {
    agent: "none",
    beszelMin: 1,
    vitals: { cpu: 3, ram: 27, temp: 41, netBps: 12_000 },
    tasks: [],
  },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET_MIN = 60;

/** Journal synthétique de 30 jours : une exécution à 3:00, heure du NAS. */
function demoLog(now: Date, tasks: [string, DemoTask][]): BackupLogEntry[] {
  const log: BackupLogEntry[] = [];
  const nasNow = now.getTime() + OFFSET_MIN * 60_000;
  const today = Math.floor(nasNow / DAY) * DAY;
  for (const [name, t] of tasks) {
    for (let d = 0; d < 30; d += 1) {
      const dayStart = today - d * DAY;
      if (t.weekday != null && new Date(dayStart).getUTCDay() !== t.weekday)
        continue;
      if (t.skip?.includes(d)) continue;
      const start = dayStart + 3 * HOUR - OFFSET_MIN * 60_000;
      if (start > now.getTime()) continue;
      const outcome: BackupOutcome = t.fail?.includes(d)
        ? "failure"
        : t.partial?.includes(d)
          ? "partial"
          : "success";
      log.push({
        at: new Date(start).toISOString(),
        task: name,
        outcome: null,
      });
      log.push({
        at: new Date(start + 7 * 60_000).toISOString(),
        task: name,
        outcome,
      });
    }
  }
  return log.sort((a, b) => b.at.localeCompare(a.at));
}

function v2(base: DemoBase, now: Date, lang: Locale): Nas {
  const x = EXTRA[base.id];
  const t = now.getTime();
  const ago = (ms: number) => new Date(t - ms).toISOString();
  const readAt = ago(base.readMinutesAgo * 60_000);
  const systemId = `demo${base.id.replace(/[^a-z0-9]/g, "")}`;
  const beszelAt = ago(x.beszelMin * 60_000);
  const backupLog = demoLog(
    now,
    base.tasks.map((task, i) => [task.name, x.tasks[i]]),
  );
  const seen: Record<string, string> = {};
  base.checks
    .filter((c) => c.status !== "ok")
    .forEach((c, i) => {
      seen[c.id] = ago((3 + i * 2) * DAY);
    });
  const { readMinutesAgo: _minutes, ...rest } = base;
  return {
    ...rest,
    agent:
      x.agent === "ok"
        ? { kind: "ok", readAt }
        : x.agent === "down"
          ? {
              kind: "down",
              reason: tr(lang, {
                en: "agent unreachable",
                fr: "agent injoignable",
              }),
              lastReadAt: readAt,
            }
          : { kind: "none" },
    beszel:
      x.beszelMin <= 5
        ? { kind: "ok", systemId, lastAt: beszelAt }
        : {
            kind: "down",
            systemId,
            lastAt: beszelAt,
            reason: tr(lang, {
              en: "Beszel no longer sees the NAS",
              fr: "Beszel ne voit plus le NAS",
            }),
          },
    readAt: x.agent === "ok" ? readAt : null,
    // Comme un vrai NAS : l'agent qui répond tient ses constantes, sinon Beszel.
    agentHistory: x.agent === "ok",
    vitals: {
      ...base.vitals,
      ...x.vitals,
      source: x.agent === "ok" ? "agent" : "beszel",
    },
    tzOffsetMin: x.agent === "none" ? null : OFFSET_MIN,
    volumes: base.volumes.map((v) => {
      const totalBytes = parseSize(v.total);
      const usedBytes = parseSize(v.used);
      return {
        ...v,
        used: bytes(usedBytes, lang),
        total: bytes(totalBytes, lang),
        id: null,
        totalBytes,
        usedBytes,
      };
    }),
    tasks: base.tasks.map((task, i) => {
      const d = x.tasks[i];
      return {
        ...task,
        lastRunAt: d ? ago(d.runH * HOUR) : null,
        lastSuccessAt: d ? ago(d.successH * HOUR) : null,
        running: false,
      };
    }),
    backupLog,
    backupLogFrom: backupLog.at(-1)?.at ?? null,
    backupLogRead: true,
    seen,
    ramMb: null,
    dsmUpdate: null,
    packages: null,
    network: null,
    activeBackup: base.id === "cabinet" ? demoAbb(lang, ago) : undefined,
    cloudBackups:
      base.id === "cabinet"
        ? {
            suites: ["microsoft365"],
            tasks: [
              {
                suite: "microsoft365",
                activated: true,
                name: tr(lang, {
                  en: "Firm's Microsoft 365",
                  fr: "Microsoft 365 du cabinet",
                }),
                state: "active",
                continuous: true,
                lastRunAt: ago(25 * 60_000),
                lastResult: "success",
                errors: 0,
                accounts: 12,
              },
            ],
          }
        : undefined,
    synology:
      x.agent === "none"
        ? undefined
        : {
            read: true,
            error: null,
            readAt: ago(2 * HOUR),
            known: 140,
            lifecycle: {
              model: base.model,
              listed: true,
              updates: "full",
              warrantyYears: base.model === "DS224+" ? 2 : 3,
            },
            findings:
              base.id === "entrepot"
                ? WAREHOUSE_FLAWS.map(([id, severity, fixedIn, product]) => ({
                    id,
                    url: `https://www.synology.com/en-global/security/advisory/${id.replace("Synology-SA-", "Synology_SA_").replace(":", "_")}`,
                    severity,
                    product,
                    state: "affected" as const,
                    fixedIn,
                    otherBranch: false,
                    scheduledBy: null,
                  }))
                : [],
          },
  };
}

/** Le parc fictif à un instant donné, dans la langue de la page. */
export function demoFleetAt(now: Date, lang: Locale): Nas[] {
  return base(lang).map((b) => v2(b, now, lang));
}

/** Identifiants des NAS fictifs, sans dépendre de l'heure ni de la langue. */
export const DEMO_FLEET: Nas[] = demoFleetAt(
  new Date(Date.UTC(2026, 10, 9, 15, 30)),
  "en",
);

const NAMES: Record<Locale, Map<string, string>> = {
  en: new Map(base("en").map((b) => [b.id, b.name])),
  fr: new Map(base("fr").map((b) => [b.id, b.name])),
};

/** Nom d'un NAS fictif dans la langue (titre de l'onglet du navigateur). */
export function demoName(id: string, lang: Locale): string | undefined {
  return NAMES[lang].get(id);
}

/** Graine stable d'une chaîne (FNV-1a). */
function seed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Courbe synthétique d'un NAS fictif : déterministe, autour de sa valeur du moment ; elle
 * s'arrête au dernier relevé d'un NAS que Beszel ne voit plus. */
export function demoSeries(
  nas: Nas,
  metric: Metric,
  period: Period,
  now: Date,
): Point[] {
  const level =
    metric === "cpu"
      ? nas.vitals.cpu
      : metric === "mem"
        ? nas.vitals.ram
        : metric === "temp"
          ? nas.vitals.temp
          : nas.vitals.netBps;
  if (level == null && nas.beszel.kind === "ok") return [];
  const base =
    level ?? (metric === "temp" ? 50 : metric === "net" ? 1_000_000 : 20);
  const { ms, stepMin } = PERIODS[period];
  const step = stepMin * 60_000;
  const end =
    nas.beszel.kind === "down" && nas.beszel.lastAt
      ? Date.parse(nas.beszel.lastAt)
      : now.getTime();
  const s = seed(`${nas.id}:${metric}`);
  const points: Point[] = [];
  for (
    let at = Math.floor((now.getTime() - ms) / step) * step + step;
    at <= end;
    at += step
  ) {
    const day = Math.sin(((at / HOUR + (s % 24)) / 24) * 2 * Math.PI);
    const noise =
      Math.sin(at / step + s) * 0.5 +
      Math.sin((at / step) * 0.37 + s / 7) * 0.5;
    const amplitude = metric === "temp" ? 0.08 : metric === "mem" ? 0.05 : 0.35;
    const v = base * (1 + amplitude * (0.6 * day + 0.4 * noise));
    const bounded =
      metric === "cpu" || metric === "mem"
        ? Math.min(100, Math.max(0, v))
        : Math.max(0, v);
    points.push({
      t: new Date(at).toISOString(),
      v: Math.round(bounded * 100) / 100,
    });
  }
  return points;
}

/** Remplissage synthétique d'un volume fictif sur 30 jours : une pente propre à chaque NAS. */
export function demoFill(
  nas: Nas,
  volume: Volume,
  now: Date,
): { t: string; usedBytes: number }[] {
  if (volume.usedBytes == null || volume.totalBytes == null) return [];
  const slope = ((seed(`${nas.id}:fill`) % 5) / 1000) * volume.totalBytes;
  return Array.from({ length: 31 }, (_, i) => ({
    t: new Date(now.getTime() - (30 - i) * DAY).toISOString(),
    usedBytes: Math.max(0, (volume.usedBytes as number) - (30 - i) * slope),
  }));
}

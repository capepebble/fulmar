// Modèle de données de la console. Les contrôles reprennent le contrat de l'opération
// `audit.checks` de l'agent (agent/src/nas_agent/catalog/ops/checks.py).

export type Status = "ok" | "warning" | "failed" | "unknown";
export type Severity = "high" | "medium" | "info";

export type CategoryId =
  | "system"
  | "containers"
  | "updates"
  | "accounts"
  | "access"
  | "certificates"
  | "backup"
  | "storage"
  | "ups"
  | "security_advisor"
  | "shares";

export interface Check {
  id: string;
  category: CategoryId;
  title: string;
  /** Libellé court, inscrit sous le module. */
  short: string;
  severity: Severity;
  status: Status;
  observed: string;
  expected: string;
  /** Absent quand le contrôle est bon. */
  advice: string | null;
  items: string[];
  /** Opérations du catalogue d'où vient le verdict. */
  sources: string[];
  /** Faux quand on ne suit plus ce contrôle (suivi choisi, mémoire de la console) : sa lecture
   * reste, mais il ne colore plus rien. Absent : suivi. */
  followed?: boolean;
}

export interface AuditSummary {
  /** Le pire des contrôles, ceux « à titre indicatif » exclus. */
  status: Status;
  total: number;
  ok: number;
  warning: number;
  failed: number;
  unknown: number;
}

export interface Volume {
  /** Identifiant DSM (« volume_1 »), celui des séries de l'historique de l'agent. */
  id: string | null;
  path: string;
  fs: string;
  raid: string;
  pct: number;
  used: string;
  total: string;
  status: string;
  totalBytes: number | null;
  usedBytes: number | null;
}

export interface Pool {
  name: string;
  raid: string;
  status: string;
}

export interface Disk {
  bay: number;
  /** Faux quand l'agent juge le disque en mauvais état (état ou SMART). */
  healthy: boolean;
  size: string;
  temp: number;
  smart: string;
  status: string;
  /** Nom du disque pour DSM et Beszel (« sata1 »). */
  device: string | null;
  model: string | null;
  /** Heures de marche, lues dans SMART par l'agent, sinon dans Beszel. */
  hours: number | null;
  sizeBytes: number | null;
  /** Ce que SMART dit de l'usure (agent, 2026-11-26) ; absent sans lecture. */
  wear?: DiskWear | null;
}

export interface DiskWear {
  reallocated: number | null;
  pending: number | null;
  uncorrectable: number | null;
  crc: number | null;
  ssdLife: number | null;
  /** Dernier test SMART, comme DSM le dit (« completed », « damage »…). */
  lastTest: string | null;
  /** Verdict de l'agent sur ce disque (contrôle « Disques qui faiblissent ») ; `null` s'il
   * ne le nomme pas. */
  status: "failed" | "warning" | null;
}

/** Un conteneur de Container Manager, lu par l'agent (2026-11-26). */
export interface AgentContainer {
  name: string;
  image: string | null;
  project: string | null;
  state: string | null;
  health: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  cpu: number | null;
  memoryBytes: number | null;
}

export interface Share {
  name: string;
  recycleBin: boolean;
  snapshots: string;
}

export interface BackupTask {
  name: string;
  kind: string;
  destination: string;
  schedule: string;
  lastRun: string;
  lastSuccess: string;
  result: { status: Status; text: string };
  nextRun: string;
  integrityLast: string;
  integrityNext: string;
  /** Instants (ISO, UTC). */
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  /** Sauvegarde en cours : ni réussie ni échouée. */
  running: boolean;
}

export type SettingState = Status | "neutral";

export interface SecuritySetting {
  label: string;
  state: SettingState;
  value: string;
}

export interface Advisor {
  group: string;
  rules: number;
  passed: number;
  failed: number;
  skipped: number;
  lastRun: string;
  failedRules: { state: SettingState; title: string; area: string }[];
}

export interface Certificate {
  name: string;
  issuer: string;
  until: string;
  days: number;
  services: number;
  isDefault: boolean;
}

export interface Account {
  name: string;
  role: string;
  state: string;
  twoFactor: boolean;
}

export interface Connection {
  who: string;
  protocol: string;
  from: string;
  since: string;
  device: string;
  isAgent?: boolean;
}

export type ActivitySource = "connections" | "settings" | "files";

export type FileLogState = "on" | "off" | "unknown";

export interface ActivityEvent {
  day: string;
  time: string;
  level: "ok" | "warning";
  source: ActivitySource;
  who: string;
  text: string;
}

/** Lien avec l'agent du NAS. */
export type AgentLink =
  | { kind: "ok"; readAt: string }
  | { kind: "none" }
  | { kind: "down" | "denied"; reason: string; lastReadAt: string | null };

/** Lien avec Beszel. « missing » : le système désigné n'est pas vu par le compte de la console. */
export type BeszelLink =
  | { kind: "ok"; systemId: string; lastAt: string }
  | { kind: "none" }
  | {
      kind: "down";
      systemId: string;
      lastAt: string | null;
      reason: string;
      /** Le hub lui-même ne répond pas (et non le NAS qu'il ne voit plus). */
      hub?: boolean;
    }
  | { kind: "missing"; systemId: string };

export type BackupOutcome = "success" | "failure" | "partial";

/** Une ligne du journal de Hyper Backup, comprise par l'agent. */
export interface BackupLogEntry {
  at: string;
  task: string | null;
  outcome: BackupOutcome | null;
}

/** Le groupe où la console range un NAS (client, catégorie ou autre). */
export interface NasFolder {
  id: string;
  name: string;
  kind: "client" | "category" | "other";
  /** Rang du groupe, pour l'ordre des listes. */
  rank: number;
}

export interface Nas {
  id: string;
  name: string;
  model: string;
  dsm: string;
  timeZone: string;
  place: string;
  /** Son groupe dans la console, s'il est rangé (posé à la lecture du parc). */
  folder?: NasFolder | null;
  reachable: boolean;
  /** Valeurs relevées sur le NAS d'essai ; les autres NAS sont fictifs. */
  real: boolean;
  /** Lu en direct par son agent (sinon : parc de démonstration). */
  live: boolean;
  /** Heure de la dernière lecture réussie (ISO, UTC), quand elle est connue. */
  readAt: string | null;
  /** Pourquoi l'agent n'a pas pu être lu, quand il ne répond pas. */
  problem: string | null;
  vitals: {
    cpu: number | null;
    ram: number | null;
    temp: number | null;
    uptime: string;
    /** Réseau, envoyé plus reçu, en octets par seconde. */
    netBps: number | null;
    /** D'où viennent les constantes : une information, une source. */
    source: "beszel" | "agent" | null;
  };
  volumes: Volume[];
  pools: Pool[];
  disks: Disk[];
  shares: Share[];
  tasks: BackupTask[];
  security: SecuritySetting[];
  advisor: Advisor;
  certificates: Certificate[];
  accounts: Account[];
  ups: string;
  connected: Connection[];
  activity: ActivityEvent[];
  /**
   * Journal de transfert de DSM : « on » si DSM note au moins un protocole, « off » s'il n'en
   * note aucun, « unknown » si la console n'a pas pu le lire.
   */
  fileLogs: FileLogState;
  checks: Check[];
  agent: AgentLink;
  /** L'agent tient l'historique des constantes (`metrics.history`) et l'a rendu à la
   * dernière lecture : ses courbes, sa valeur du moment et le remplissage de ses volumes
   * viennent de lui, pas de Beszel. */
  agentHistory: boolean;
  beszel: BeszelLink;
  /** Décalage du NAS sur UTC, en minutes, quand l'agent l'a lu. */
  tzOffsetMin: number | null;
  /** Journal de Hyper Backup, du plus récent au plus ancien. */
  backupLog: BackupLogEntry[];
  /** La plus ancienne entrée lue du journal. */
  backupLogFrom: string | null;
  /** Le journal de Hyper Backup a répondu, même vide. */
  backupLogRead: boolean;
  /** Contrôle vers l'instant de la première lecture dans son état (mémoire de la console). */
  seen: Record<string, string>;
  /** Mémoire vive installée, en Mo. */
  ramMb: number | null;
  /** DSM et ses mises à jour ; `null` si la lecture a manqué. */
  dsmUpdate: DsmUpdate | null;
  /** Paquets installés ; `null` si la lecture a manqué. */
  packages: Package[] | null;
  /** Réseau du NAS ; `null` si la lecture a manqué. */
  network: NetworkInfo | null;
  /** Conteneurs lus par l'agent ; `null` sans Container Manager ou lecture manquée, absent
   * pour un NAS fictif. */
  containers?: AgentContainer[] | null;
  /** Failles publiées par Synology et suivi du modèle ; `null` si la lecture a manqué, absent
   * pour un NAS fictif sans agent. */
  synology?: SynologyInfo | null;
  /** Active Backup for Business ; `null` sans le paquet ou lecture manquée, absent pour un
   * NAS fictif. */
  activeBackup?: AbbInfo | null;
  /** Microsoft 365 et Google Workspace ; `null` sans aucun des deux paquets. */
  cloudBackups?: CloudBackupsInfo | null;
}

/** Une tâche Active Backup for Microsoft 365 ou for Google Workspace. */
export interface CloudBackupsInfo {
  tasks: {
    suite: "microsoft365" | "google_workspace";
    activated: boolean | null;
    name: string;
    state: "active" | "starting" | "inactive" | "error" | null;
    continuous: boolean | null;
    lastRunAt: string | null;
    lastResult: string | null;
    errors: number;
    accounts: number | null;
  }[];
  /** Paquets présents, même sans tâche. */
  suites: ("microsoft365" | "google_workspace")[];
}

/** Active Backup for Business lu par l'agent (`backup.activebackup`). */
export interface AbbInfo {
  activated: boolean | null;
  devices: {
    name: string;
    task: string | null;
    type: "pc" | "server" | "vm" | "file_server" | "dsm" | null;
    os: string | null;
    lastSuccessAt: string | null;
    lastResult: string | null;
    running: boolean;
  }[];
}

/** Ce que l'agent a lu chez Synology pour ce NAS (`updates.synology`). */
export interface SynologyInfo {
  read: boolean;
  error: string | null;
  readAt: string | null;
  known: number;
  lifecycle: {
    model: string;
    listed: boolean;
    updates: "full" | "limited" | "end_of_life" | null;
    warrantyYears: number | null;
  } | null;
  findings: {
    id: string;
    url: string;
    severity: string | null;
    product: string;
    state: "affected" | "no_fix" | "wont_fix";
    fixedIn: string | null;
    /** Corrigée seulement sur une branche de DSM plus récente. */
    otherBranch: boolean;
    scheduledBy: string | null;
  }[];
}

export interface DsmUpdate {
  current: string;
  /** DSM a pu interroger Synology. */
  checkOk: boolean | null;
  /** Mise à jour de la même version majeure, ou nouvelle version majeure. */
  available: string | null;
  major: string | null;
  /** Réglage des mises à jour automatiques, en clair. */
  auto: string;
}

export interface Package {
  /** Identifiant DSM du paquet (« TextEditor ») : celui que la mise à jour demande. */
  id?: string;
  name: string;
  version: string;
  running: boolean;
  system: boolean;
  /** Version disponible, si une mise à jour existe. */
  update: string | null;
  security: boolean;
}

export interface NetworkInfo {
  hostname: string | null;
  gateway: string | null;
  dns: string[];
  interfaces: {
    name: string;
    kind: string | null;
    connected: boolean | null;
    address: string | null;
    speedMbps: number | null;
  }[];
}

// Ce que rendent les opérations de l'agent (champs lus par la console seulement).
// Le contrat complet est le catalogue de l'agent : agent/src/nas_agent/catalog/ops/.

import type { Texts } from "@/i18n";

export interface AgentConfig {
  id: string;
  name: string;
  place: string;
  /** Identifiant de l'enregistrement `systems` du NAS dans Beszel. */
  beszelSystem?: string;
  /** Adresse de l'agent, par exemple https://nas-agent-essai.tailnet.ts.net */
  url: string;
  /** Nom de la variable d'environnement qui porte le jeton. */
  tokenEnv: string;
  /** Fichier qui porte le jeton (l'agent du projet l'écrit dans un volume partagé). */
  tokenFile?: string;
  /** Nommer le NAS comme DSM le nomme (l'agent du projet, les NAS ajoutés au hub). */
  autoName?: boolean;
  /** Ajouté au hub par la console : il se retire du parc depuis sa page. */
  member?: boolean;
}

export interface SystemInfo {
  model?: string | null;
  ram_mb?: number | null;
  dsm_version?: string | null;
  uptime_s?: number | null;
  temperature_c?: number | null;
}

export interface SystemUtilization {
  cpu?: { total_pct?: number | null } | null;
  memory?: { real_usage_pct?: number | null } | null;
}

export interface SystemTime {
  time_zone?: string | null;
  time_zone_label?: string | null;
  local_time?: string | null;
  /** Décalage sur UTC mesuré par l'agent à la lecture, heure d'été comprise. */
  utc_offset_minutes?: number | null;
}

export interface StorageOverview {
  volumes?: {
    id?: string | null;
    path?: string | null;
    status?: string | null;
    fs_type?: string | null;
    raid?: string | null;
    pool_id?: string | null;
    size_total_bytes?: number | null;
    size_used_bytes?: number | null;
    used_pct?: number | null;
  }[];
  pools?: {
    id?: string | null;
    status?: string | null;
    raid?: string | null;
    disks?: string[];
  }[];
  disks?: {
    id?: string | null;
    name?: string | null;
    size_bytes?: number | null;
    status?: string | null;
    smart_status?: string | null;
    temperature_c?: number | null;
    healthy?: boolean | null;
    model?: string | null;
  }[];
}

export interface SharesList {
  shares?: {
    name: string;
    recycle_bin?: boolean | null;
    snapshots?: {
      supported?: boolean | null;
      count?: number | null;
      scheduled?: boolean | null;
    } | null;
  }[];
}

export interface BackupSchedule {
  enabled?: boolean | null;
  week_days?: number[] | null;
  hour?: number | null;
  minute?: number | null;
  repeat_every_hours?: number | null;
  next_run_at?: string | null;
}

export interface BackupTasks {
  tasks?: {
    name: string;
    kind?: string | null;
    destination_share?: string | null;
    destination_target?: string | null;
    last_result?: string | null;
    last_started_at?: string | null;
    last_success_at?: string | null;
    last_error?: string | null;
    failed?: boolean | null;
    running?: boolean | null;
    schedule?: BackupSchedule | null;
    integrity_check?: {
      last_at?: string | null;
      never_checked?: boolean | null;
      scheduled?: boolean | null;
      next_run_at?: string | null;
    } | null;
  }[];
}

export interface SecuritySettings {
  firewall?: { enabled?: boolean | null; profile?: string | null } | null;
  auto_block?: {
    enabled?: boolean | null;
    attempts?: number | null;
    within_minutes?: number | null;
  } | null;
  account_protection_enabled?: boolean | null;
  two_factor_enforced?: string | null;
  ssh?: { enabled?: boolean | null; port?: number | null } | null;
  telnet_enabled?: boolean | null;
  quickconnect?: { enabled?: boolean | null } | null;
  session?: { timeout_minutes?: number | null } | null;
  password_policy?: {
    min_length?: number | null;
    mixed_case?: boolean | null;
    numbers?: boolean | null;
    special_chars?: boolean | null;
    exclude_common?: boolean | null;
  } | null;
}

/** `services.list` (2026-11-26). Un service illisible vaut `null`. */
export interface ServicesList {
  smb?: {
    enabled?: boolean | null;
    min_protocol?: string | null;
    ntlmv1?: boolean | null;
  } | null;
  afp_enabled?: boolean | null;
  nfs_enabled?: boolean | null;
  ftp?: { enabled?: boolean | null; ftps_enabled?: boolean | null } | null;
  sftp?: { enabled?: boolean | null; port?: number | null } | null;
  rsync?: { enabled?: boolean | null; rsync_accounts?: boolean | null } | null;
  snmp?: {
    enabled?: boolean | null;
    v1v2c?: boolean | null;
    v3?: boolean | null;
  } | null;
  web?: {
    http_port?: number | null;
    https_port?: number | null;
    https_redirect?: boolean | null;
    hsts?: boolean | null;
  } | null;
}

/** `containers.list` (2026-11-26). */
export interface ContainersList {
  containers?: {
    name: string;
    image?: string | null;
    project?: string | null;
    state?: string | null;
    exit_code?: number | null;
    oom_killed?: boolean | null;
    health?: string | null;
    started_at?: string | null;
    cpu_pct?: number | null;
    memory_bytes?: number | null;
  }[];
}

/** `backup.activebackup` (2026-11-26) : Active Backup for Business. */
export interface ActiveBackup {
  activated?: boolean | null;
  storages?: string[];
  tasks?: {
    id?: number | null;
    name?: string | null;
    type?: "pc" | "server" | "vm" | "file_server" | "dsm" | null;
    destination_share?: string | null;
    devices?: {
      id?: number | null;
      name?: string | null;
      os?: string | null;
      agent_version?: string | null;
      last_success_at?: string | null;
    }[];
    running?: boolean;
    last_result?: string | null;
    last_success_at?: string | null;
    next_run_at?: string | null;
    failed?: boolean;
  }[];
}

/** `backup.activebackup_cloud` (2026-11-26) : Microsoft 365 et Google Workspace. */
export interface CloudSuiteRead {
  activated?: boolean | null;
  tasks?: {
    name?: string | null;
    state?: "active" | "starting" | "inactive" | "error" | null;
    continuous?: boolean | null;
    last_run_at?: string | null;
    last_result?: string | null;
    errors?: number;
    warnings?: number;
    accounts?: number | null;
    services?: string[];
  }[];
}
export interface CloudBackups {
  microsoft365?: CloudSuiteRead | null;
  google_workspace?: CloudSuiteRead | null;
}

/** `updates.synology` (2026-11-26, conception 2026-11-26-failles-fin-de-vie). */
export interface SynologyStatus {
  read?: boolean;
  error?: string | null;
  feed_read_at?: string | null;
  advisories_known?: number;
  dsm_version?: string | null;
  lifecycle?: {
    model: string;
    listed: boolean;
    updates?: "full" | "limited" | "end_of_life" | null;
    support?: string | null;
    availability?: string | null;
    warranty_years?: number | null;
  } | null;
  findings?: {
    id: string;
    title: string;
    url: string;
    published_at?: string | null;
    severity?: string | null;
    product: string;
    state: "affected" | "no_fix" | "wont_fix";
    fixed_in?: string | null;
    other_branch?: boolean;
    scheduled_by?: string | null;
  }[];
  fixed?: number;
}

/** `storage.smart` (2026-11-26). */
export interface StorageSmart {
  disks?: {
    id?: string | null;
    name?: string | null;
    is_ssd?: boolean | null;
    power_on_hours?: number | null;
    reallocated_sectors?: number | null;
    pending_sectors?: number | null;
    uncorrectable_sectors?: number | null;
    crc_errors?: number | null;
    ssd_life_pct?: number | null;
    last_test_result?: string | null;
  }[];
  scheduled_tests?:
    | {
        name?: string | null;
        action?: string | null;
        enabled?: boolean | null;
      }[]
    | null;
}

export interface SecurityAdvisor {
  last_scan_at?: string | null;
  group?: string | null;
  summary?: {
    rules?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
  } | null;
  failed_rules?: {
    id: string;
    category?: string | null;
    severity?: string | null;
  }[];
}

export interface CertificatesList {
  certificates?: {
    common_name?: string | null;
    description?: string | null;
    issuer?: string | null;
    self_signed?: boolean | null;
    is_default?: boolean | null;
    valid_until?: string | null;
    expires_in_days?: number | null;
    services?: unknown[] | null;
  }[];
}

export interface UsersList {
  accounts?: {
    name: string;
    admin?: boolean | null;
    disabled?: boolean | null;
    two_factor?: boolean | null;
    agent_account?: boolean | null;
  }[];
}

export interface UpsStatus {
  enabled?: boolean | null;
  mode?: string | null;
  on_battery?: boolean | null;
  charge_percent?: number | null;
  manufacturer?: string | null;
  model?: string | null;
}

export interface Connections {
  sessions?: {
    account?: string | null;
    service?: string | null;
    protocol?: string | null;
    address?: string | null;
    since?: string | null;
    client?: string | null;
    is_agent?: boolean | null;
  }[];
}

export interface Logs {
  entries?: {
    time?: string | null;
    level?: string | null;
    account?: string | null;
    event?: string | null;
  }[];
}

export interface FileLogs {
  total?: number | null;
  /** Protocoles dont DSM note les transferts ; absent si le réglage est illisible. */
  logging?: Partial<
    Record<
      "smb" | "file_station" | "ftp" | "webdav" | "afp" | "tftp",
      boolean | null
    >
  > | null;
  entries?: {
    time?: string | null;
    protocol?: string | null;
    account?: string | null;
    address?: string | null;
    action?: string | null;
    path?: string | null;
    /** Nouveau chemin d'un fichier renommé, déplacé ou copié. */
    destination?: string | null;
    is_dir?: boolean | null;
    size?: number | null;
  }[];
}

export interface PackagesList {
  packages?: {
    id?: string | null;
    name?: string | null;
    version?: string | null;
    status?: string | null;
    system?: boolean | null;
    available_version?: string | null;
    update_available?: boolean | null;
    security_update?: boolean | null;
  }[];
}

export interface DsmUpdateInfo {
  current_version?: string | null;
  check_ok?: boolean | null;
  update_available?: boolean | null;
  update_version?: string | null;
  major_upgrade_available?: boolean | null;
  major_upgrade_version?: string | null;
  auto_update?: string | null;
  reboot_pending?: boolean | null;
}

export interface NetworkOverview {
  hostname?: string | null;
  gateway?: { address?: string | null; interface?: string | null } | null;
  dns_servers?: string[];
  interfaces?: {
    name?: string | null;
    kind?: string | null;
    connected?: boolean | null;
    address?: string | null;
    speed_mbps?: number | null;
  }[];
}

export interface BackupLogs {
  entries?: {
    time?: string | null;
    task?: string | null;
    outcome?: "success" | "failure" | "partial" | null;
  }[];
}

export interface AuditChecks {
  checks?: {
    id: string;
    category: string;
    title: string;
    severity: string;
    status: string;
    observed: string;
    expected: string;
    advice: string | null;
    items: string[];
    sources: string[];
  }[];
}

export type HistoryMetric =
  | "cpu_pct"
  | "memory_pct"
  | "temperature_c"
  | "network_rx_bps"
  | "network_tx_bps"
  | "volume_used_bytes"
  | "volume_total_bytes"
  | "disk_temperature_c";

export interface HistoryPoint {
  /** Début du palier, en UTC. */
  t: string;
  avg: number;
  max: number;
  /** Nombre de relevés d'une minute résumés dans le point. */
  n: number;
}

/** Historique des constantes relevées par l'agent (`metrics.history`). */
export interface MetricsHistory {
  tier?: string;
  step_s?: number;
  since?: string;
  until?: string;
  storage_included?: boolean;
  sampling?: {
    enabled?: boolean;
    running?: boolean;
    last_sample_at?: string | null;
  } | null;
  series?: {
    metric: HistoryMetric | string;
    subject?: string | null;
    latest?: { t: string; value: number } | null;
    points?: HistoryPoint[];
  }[];
}

export interface Payloads {
  "system.info": SystemInfo;
  "system.utilization": SystemUtilization;
  "system.time": SystemTime;
  "storage.overview": StorageOverview;
  "shares.list": SharesList;
  "backup.hyperbackup.tasks": BackupTasks;
  "security.settings": SecuritySettings;
  "security.advisor": SecurityAdvisor;
  "certificates.list": CertificatesList;
  "users.list": UsersList;
  "ups.status": UpsStatus;
  "connections.current": Connections;
  "logs.connection": Logs;
  "logs.system": Logs;
  "logs.files": FileLogs;
  "backup.hyperbackup.logs": BackupLogs;
  "packages.list": PackagesList;
  "dsm.update": DsmUpdateInfo;
  "network.overview": NetworkOverview;
  "audit.checks": AuditChecks;
  "metrics.history": MetricsHistory;
  "containers.list": ContainersList;
  "storage.smart": StorageSmart;
  "services.list": ServicesList;
  "updates.synology": SynologyStatus;
  "backup.activebackup": ActiveBackup;
  "backup.activebackup_cloud": CloudBackups;
}

export type ReadKey = keyof Payloads;

export type Read<T> =
  | { ok: true; fetchedAt: string; data: T }
  | { ok: false; reason: Texts; status?: number };

export type AgentReads = { [K in ReadKey]?: Read<Payloads[K]> };

/** Chemin REST de chaque lecture (préfixe /v1). */
export const READ_PATHS: Record<ReadKey, string> = {
  "system.info": "/system/info",
  "system.utilization": "/system/utilization",
  "system.time": "/system/time",
  "storage.overview": "/storage/overview",
  "shares.list": "/shares",
  "backup.hyperbackup.tasks": "/backup/hyperbackup/tasks",
  "security.settings": "/security/settings",
  "security.advisor": "/security/advisor",
  "certificates.list": "/certificates",
  "users.list": "/users",
  "ups.status": "/ups",
  "connections.current": "/connections",
  "logs.connection": "/logs?kind=connection&limit=50",
  "logs.system": "/logs?kind=system&limit=50",
  "logs.files": "/logs/files?limit=50",
  "backup.hyperbackup.logs": "/backup/hyperbackup/logs?limit=200",
  "packages.list": "/packages",
  "dsm.update": "/dsm/update",
  "network.overview": "/network",
  "audit.checks": "/audit/checks",
  // Courbes de 24 h et valeur du moment ; lu par `history.ts`, gardé 60 s.
  "metrics.history": "/metrics/history?tier=20m&hours=24",
  "containers.list": "/containers",
  "storage.smart": "/storage/smart",
  "services.list": "/services",
  "updates.synology": "/updates/synology",
  "backup.activebackup": "/backup/activebackup",
  "backup.activebackup_cloud": "/backup/activebackup/cloud",
};

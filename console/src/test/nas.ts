// Fabrique de NAS pour les tests : un NAS complet, sans rien, que chaque test complète.

import type { BackupTask, Check, Nas, Volume } from "@/lib/fleet/types";

export function makeNas(over: Partial<Nas> = {}): Nas {
  return {
    id: "n",
    name: "NAS",
    model: "DS420+",
    dsm: "DSM 7.4.1",
    timeZone: "UTC+1, Amsterdam",
    place: "",
    reachable: true,
    real: false,
    live: true,
    readAt: "2026-11-21T09:00:00.000Z",
    problem: null,
    vitals: {
      cpu: null,
      ram: null,
      temp: null,
      uptime: "inconnue",
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
    ups: "Inconnu",
    connected: [],
    activity: [],
    fileLogs: "unknown",
    checks: [],
    agent: { kind: "ok", readAt: "2026-11-21T09:00:00.000Z" },
    agentHistory: false,
    beszel: { kind: "none" },
    tzOffsetMin: 60,
    backupLog: [],
    backupLogFrom: null,
    backupLogRead: false,
    seen: {},
    ramMb: null,
    dsmUpdate: null,
    packages: null,
    network: null,
    ...over,
  };
}

export function makeCheck(over: Partial<Check> = {}): Check {
  return {
    id: "access.firewall",
    category: "access",
    title: "Pare-feu actif",
    short: "Pare-feu",
    severity: "high",
    status: "ok",
    observed: "",
    expected: "",
    advice: null,
    items: [],
    sources: [],
    ...over,
  };
}

export function makeTask(over: Partial<BackupTask> = {}): BackupTask {
  return {
    name: "Nuit",
    kind: "Locale",
    destination: "sauvegardes",
    schedule: "Chaque jour à 3:00",
    lastRun: "–",
    lastSuccess: "–",
    result: { status: "ok", text: "Réussie" },
    nextRun: "–",
    integrityLast: "–",
    integrityNext: "–",
    lastSuccessAt: null,
    lastRunAt: null,
    running: false,
    ...over,
  };
}

export function makeVolume(over: Partial<Volume> = {}): Volume {
  return {
    id: "volume_1",
    path: "/volume1",
    fs: "Btrfs",
    raid: "SHR",
    pct: 50,
    used: "–",
    total: "–",
    status: "normal",
    totalBytes: null,
    usedBytes: null,
    ...over,
  };
}

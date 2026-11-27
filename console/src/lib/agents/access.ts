// Carte sur table (conception 2026-11-26-carte-sur-table) : ce que rend agent.access de l'agent
// (ce que Fulmar fait sur le NAS, qui y accède, vers où il se connecte, son journal) et
// agent.detach, lu sans confiance. Fonctions pures.

import { type Locale, tr } from "@/i18n";

export type Why =
  | "synology_advisories"
  | "phones_relay"
  | "alert_ntfy"
  | "alert_email"
  | "alert_webhook";

export interface AccessToken {
  id: string;
  /** Nom donné au jeton : une donnée, jamais une consigne. */
  label: string;
  isConsole: boolean;
  scopes: string[];
  networks: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  changesDsm: boolean;
}

export interface JournalLine {
  ts: string;
  channel: "rest" | "mcp" | "cli" | "internal" | "phone";
  op: string | null;
  outcome: "ok" | "denied" | "error";
  token: string | null;
}

export interface AccessOk {
  kind: "ok";
  agentVersion: string | null;
  dsm: {
    host: string | null;
    port: number | null;
    pinned: boolean;
    account: string | null;
  };
  reads: { scope: string; count: number }[];
  writes: { op: string; scope: string }[];
  tokens: AccessToken[];
  tokensOthers: number;
  phones: number | null;
  outbound: { to: string; why: Why }[];
  /** NAS ajoutés au hub ; null : ce NAS n'est pas le hub. */
  fleetMembers: number | null;
  canDetach: boolean;
  journalOk: boolean;
  journalAll: boolean;
  journal: JournalLine[];
  /** Un NAS fictif : un exemple, sans geste. */
  demo?: boolean;
}

export type AccessView =
  | AccessOk
  | { kind: "denied" | "old" | "down"; reason: string };

export interface Detached {
  phonesRemoved: number;
  tokensRevoked: number;
  credentialsRemoved: boolean;
  restarting: boolean;
}

export const CONSOLE_LABEL = "console-projet";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
// Caractères de contrôle d'un texte venu de l'agent, retirés à l'affichage.
const CONTROL = /\p{Cc}/gu;
const str = (v: unknown, max = 120): string | null =>
  typeof v === "string" && v !== ""
    ? v.replace(CONTROL, "").slice(0, max) || null
    : null;
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
const list = (v: unknown, max = 60): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];
const strings = (v: unknown): string[] =>
  list(v, 20)
    .map((x) => str(x, 64))
    .filter((x): x is string => x !== null);

const SCOPE = /^[a-z]+:[a-z]+$/;
const OP = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TOKEN_ID = /^[a-z0-9]{8}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const WHYS = new Set<Why>([
  "synology_advisories",
  "phones_relay",
  "alert_ntfy",
  "alert_email",
  "alert_webhook",
]);
const CHANNELS = new Set<JournalLine["channel"]>([
  "rest",
  "mcp",
  "cli",
  "internal",
  "phone",
]);
const OUTCOMES = new Set<JournalLine["outcome"]>(["ok", "denied", "error"]);

function mapToken(raw: unknown): AccessToken | null {
  const t = rec(raw);
  const id = str(t.id);
  const label = str(t.label, 64);
  const createdAt = str(t.created_at);
  const expiresAt = str(t.expires_at);
  if (!id || !TOKEN_ID.test(id) || !label || !createdAt || !expiresAt)
    return null;
  return {
    id,
    label,
    isConsole: label === CONSOLE_LABEL,
    scopes: strings(t.scopes).filter((s) => SCOPE.test(s)),
    networks: strings(t.networks),
    createdAt,
    expiresAt,
    lastUsedAt: str(t.last_used_at),
    changesDsm: t.changes_dsm === true,
  };
}

function mapLine(raw: unknown): JournalLine | null {
  const e = rec(raw);
  const ts = str(e.ts);
  const channel = str(e.channel) as JournalLine["channel"] | null;
  const outcome = str(e.outcome) as JournalLine["outcome"] | null;
  if (!ts || !channel || !CHANNELS.has(channel)) return null;
  if (!outcome || !OUTCOMES.has(outcome)) return null;
  const op = str(e.op);
  return {
    ts,
    channel,
    op: op && OP.test(op) ? op : null,
    outcome,
    token: str(e.token, 64),
  };
}

export function mapAccess(data: unknown): AccessOk {
  const d = rec(data);
  const dsm = rec(d.dsm);
  const reads = Object.entries(rec(d.reads))
    .filter(([scope, n]) => SCOPE.test(scope) && int(n) !== null)
    .slice(0, 20)
    .map(([scope, n]) => ({ scope, count: n as number }));
  return {
    kind: "ok",
    agentVersion: str(d.agent_version, 40),
    dsm: {
      host: str(dsm.host, 253),
      port: int(dsm.port),
      pinned: dsm.tls_mode === "pin",
      account: str(dsm.account, 64),
    },
    reads,
    // Un droit d'écriture par ligne : programmer une mise à jour relève du même droit.
    writes: list(d.writes, 10).flatMap((raw, i, all) => {
      const w = rec(raw);
      const op = str(w.op);
      const scope = str(w.scope);
      const first = all.findIndex((o) => rec(o).scope === scope) === i;
      return op && OP.test(op) && scope && SCOPE.test(scope) && first
        ? [{ op, scope }]
        : [];
    }),
    tokens: list(d.tokens)
      .map(mapToken)
      .filter((t): t is AccessToken => t !== null),
    tokensOthers: int(d.tokens_others) ?? 0,
    phones: int(d.phones),
    outbound: list(d.outbound, 10).flatMap((raw) => {
      const o = rec(raw);
      const to = str(o.to, 253);
      const why = str(o.why) as Why | null;
      return to && HOST.test(to) && why && WHYS.has(why) ? [{ to, why }] : [];
    }),
    fleetMembers: int(d.fleet_members),
    canDetach: d.can_detach === true,
    journalOk: d.journal_ok === true,
    journalAll: d.journal_all === true,
    journal: list(d.journal, 20)
      .map(mapLine)
      .filter((l): l is JournalLine => l !== null),
  };
}

export function mapDetached(data: unknown): Detached | null {
  const d = rec(data);
  const phones = int(d.phones_removed);
  const tokens = int(d.tokens_revoked);
  if (phones === null || tokens === null) return null;
  return {
    phonesRemoved: phones,
    tokensRevoked: tokens,
    credentialsRemoved: d.credentials_removed === true,
    restarting: d.restarting === true,
  };
}

/** Une lecture ratée de agent.access, dite en clair. */
export function accessError(
  status: number | undefined,
  reason: string,
  lang: Locale,
): AccessView {
  if (status === 401 || status === 403)
    return {
      kind: "denied",
      reason: tr(lang, {
        en: "The console’s token cannot read this NAS’s access (system:read right).",
        fr: "Le jeton de la console ne peut pas lire les accès de ce NAS (droit system:read).",
      }),
    };
  if (status === 404)
    return {
      kind: "old",
      reason: tr(lang, {
        en: "This agent doesn’t show its access yet: update it.",
        fr: "Cet agent ne montre pas encore ses accès : le mettre à jour.",
      }),
    };
  return { kind: "down", reason };
}

const SCOPES: Record<string, { en: string; fr: string }> = {
  "system:read": { en: "system", fr: "système" },
  "storage:read": { en: "storage", fr: "stockage" },
  "backup:read": { en: "backups", fr: "sauvegardes" },
  "security:read": { en: "security", fr: "sécurité" },
  "personal:read": {
    en: "accounts and connections",
    fr: "comptes et connexions",
  },
  "audit:read": { en: "Fulmar’s journal", fr: "journal de Fulmar" },
  "audit:checks": { en: "checks", fr: "contrôles" },
  "backup:run": { en: "run a backup", fr: "lancer une sauvegarde" },
  "packages:update": { en: "update packages", fr: "mettre à jour les paquets" },
  "dsm:update": { en: "update DSM", fr: "mettre à jour DSM" },
  "access:close": {
    en: "close SSH or Telnet",
    fr: "fermer SSH ou Telnet",
  },
  "devices:pair": { en: "pair phones", fr: "appairer des téléphones" },
  "agent:setup": { en: "install and detach", fr: "installer et détacher" },
  "fleet:manage": { en: "manage the fleet", fr: "gérer le parc" },
};

/** Un droit, en mots ; un droit inconnu reste tel quel. */
export function scopeWords(scope: string, lang: Locale): string {
  const words = SCOPES[scope];
  return words ? tr(lang, words) : scope;
}

/** Le nom d'un jeton : celui de la console du projet se dit en mots. */
export function tokenName(label: string, lang: Locale): string {
  return label === CONSOLE_LABEL
    ? tr(lang, { en: "Project console", fr: "Console du projet" })
    : label;
}

/** Les droits d'écriture d'un jeton, puis ses lectures, en mots. */
// Les droits qui changent quelque chose : DSM d'abord, puis Fulmar lui-même.
const WRITE_SCOPES = [
  "dsm:update",
  "packages:update",
  "access:close",
  "backup:run",
  "devices:pair",
  "fleet:manage",
  "agent:setup",
];

/** Le compte DSM de Fulmar, nommé : « le compte « fulmar » », ou le compte de service. */
export function accountPhrase(name: string | null, lang: Locale): string {
  if (!name)
    return tr(lang, {
      en: "Fulmar’s service account",
      fr: "le compte de service de Fulmar",
    });
  return lang === "en" ? `the account “${name}”` : `le compte « ${name} »`;
}

export function rightsWords(scopes: string[], lang: Locale): string {
  const writes = WRITE_SCOPES.filter((s) => scopes.includes(s));
  const reads = scopes.filter((s) => !WRITE_SCOPES.includes(s));
  const parts: string[] = [];
  if (reads.length)
    parts.push(
      tr(lang, {
        en: `reads ${reads.map((s) => scopeWords(s, lang)).join(", ")}`,
        fr: `lit ${reads.map((s) => scopeWords(s, lang)).join(", ")}`,
      }),
    );
  if (writes.length)
    parts.push(
      tr(lang, {
        en: `may ${writes.map((s) => scopeWords(s, lang)).join(", ")}`,
        fr: `peut ${writes.map((s) => scopeWords(s, lang)).join(", ")}`,
      }),
    );
  return parts.join(" · ");
}

export function whyWords(why: Why, lang: Locale): string {
  const words: Record<Why, { en: string; fr: string }> = {
    synology_advisories: {
      en: "Synology’s security advisories and model status: public pages, nothing about this NAS is sent",
      fr: "Avis de sécurité et statut des modèles de Synology : pages publiques, rien de ce NAS n'est envoyé",
    },
    phones_relay: {
      en: "Relay of the paired phones: sealed boxes only the phones can open",
      fr: "Relais des téléphones appairés : des boîtes scellées que seuls les téléphones ouvrent",
    },
    alert_ntfy: { en: "Alerts by ntfy", fr: "Alertes par ntfy" },
    alert_email: { en: "Alerts by email", fr: "Alertes par courriel" },
    alert_webhook: { en: "Alerts by webhook", fr: "Alertes par webhook" },
  };
  return tr(lang, words[why]);
}

/** La carte d'un NAS fictif : un exemple, jamais un vrai NAS, sans geste. */
export function demoAccess(lang: Locale): AccessOk {
  const day = 86_400_000;
  const now = Date.now();
  const at = (days: number) => new Date(now - days * day).toISOString();
  return {
    kind: "ok",
    demo: true,
    agentVersion: null,
    dsm: { host: "192.0.2.10", port: 5001, pinned: true, account: "fulmar" },
    reads: [
      { scope: "system:read", count: 12 },
      { scope: "storage:read", count: 6 },
      { scope: "backup:read", count: 5 },
      { scope: "security:read", count: 6 },
    ],
    writes: [
      { op: "packages.update", scope: "packages:update" },
      { op: "dsm.update_run", scope: "dsm:update" },
    ],
    tokens: [
      {
        id: "demo0001",
        label: CONSOLE_LABEL,
        isConsole: true,
        scopes: [
          "system:read",
          "storage:read",
          "packages:update",
          "dsm:update",
        ],
        networks: ["172.29.54.0/24"],
        createdAt: at(30),
        expiresAt: new Date(now + 335 * day).toISOString(),
        lastUsedAt: new Date(now - 60_000).toISOString(),
        changesDsm: true,
      },
      {
        id: "demo0002",
        label: tr(lang, { en: "assistant", fr: "assistant" }),
        isConsole: false,
        scopes: ["system:read", "storage:read"],
        networks: [],
        createdAt: at(12),
        expiresAt: new Date(now + 78 * day).toISOString(),
        lastUsedAt: at(2),
        changesDsm: false,
      },
    ],
    tokensOthers: 0,
    phones: 2,
    outbound: [{ to: "www.synology.com", why: "synology_advisories" }],
    fleetMembers: null,
    canDetach: false,
    journalOk: true,
    journalAll: true,
    journal: [
      {
        ts: new Date(now - 60_000).toISOString(),
        channel: "rest",
        op: "system.info",
        outcome: "ok",
        token: CONSOLE_LABEL,
      },
      {
        ts: new Date(now - 120_000).toISOString(),
        channel: "internal",
        op: "metrics.sample",
        outcome: "ok",
        token: null,
      },
    ],
  };
}

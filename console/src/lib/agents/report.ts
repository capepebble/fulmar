// Le bilan du mois (conception 2026-11-26-bilan-du-mois) : ce que rend report.month de l'agent,
// lu sans confiance, et ses phrases. Fonctions pures.

import { type Locale, tr } from "@/i18n";
import { number, plural } from "@/lib/format";

export interface ReportIncident {
  checkId: string;
  title: string;
  status: "warning" | "failed";
  at: string;
  recoveredAt: string | null;
}

export interface MonthReport {
  month: string;
  inProgress: boolean;
  endState: {
    source: "frozen" | "current" | "none";
    ok: number;
    warning: number;
    failed: number;
    failing: { id: string; title: string; status: "warning" | "failed" }[];
  };
  incidents: ReportIncident[];
  availability: { readPct: number | null; since: string | null };
  vitals: {
    cpuAvg: number | null;
    cpuMax: number | null;
    memoryAvg: number | null;
    memoryMax: number | null;
    temperatureMax: number | null;
  } | null;
  volumes: {
    volume: string;
    startPct: number | null;
    endPct: number | null;
    grownBytes: number | null;
  }[];
  updates: {
    kind: "packages" | "dsm";
    name: string;
    from: string;
    to: string;
    state: string;
    endedAt: string | null;
  }[];
  fulmar: {
    calls: number;
    denied: number;
    writes: { op: string; count: number }[];
  };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CONTROL = /\p{Cc}/gu;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown, max = 80): string | null =>
  typeof v === "string" && v !== ""
    ? v.replace(CONTROL, "").slice(0, max) || null
    : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const count = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
const list = (v: unknown, max = 200): unknown[] =>
  Array.isArray(v) ? v.slice(0, max) : [];
const bad = (v: unknown): v is "warning" | "failed" =>
  v === "warning" || v === "failed";

export function mapReport(data: unknown): MonthReport | null {
  const d = rec(data);
  const month = str(d.month, 7);
  if (!month || !MONTH.test(month)) return null;
  const end = rec(d.end_state);
  const vitals = d.vitals ? rec(d.vitals) : null;
  const av = rec(d.availability);
  const fulmar = rec(d.fulmar);
  const source =
    end.source === "frozen" || end.source === "current" ? end.source : "none";
  return {
    month,
    inProgress: d.in_progress === true,
    endState: {
      source,
      ok: count(end.ok),
      warning: count(end.warning),
      failed: count(end.failed),
      failing: list(end.failing, 60).flatMap((raw) => {
        const f = rec(raw);
        const id = str(f.id);
        return id && bad(f.status)
          ? [{ id, title: str(f.title) ?? id, status: f.status }]
          : [];
      }),
    },
    incidents: list(d.incidents).flatMap((raw) => {
      const i = rec(raw);
      const checkId = str(i.check_id);
      const at = str(i.at, 40);
      if (!checkId || !at || !bad(i.status)) return [];
      return [
        {
          checkId,
          title: str(i.title) ?? checkId,
          status: i.status,
          at,
          recoveredAt: str(i.recovered_at, 40),
        },
      ];
    }),
    availability: { readPct: num(av.read_pct), since: str(av.since, 40) },
    vitals: vitals
      ? {
          cpuAvg: num(vitals.cpu_avg),
          cpuMax: num(vitals.cpu_max),
          memoryAvg: num(vitals.memory_avg),
          memoryMax: num(vitals.memory_max),
          temperatureMax: num(vitals.temperature_max),
        }
      : null,
    volumes: list(d.volumes, 32).flatMap((raw) => {
      const v = rec(raw);
      const volume = str(v.volume, 40);
      return volume
        ? [
            {
              volume,
              startPct: num(v.start_pct),
              endPct: num(v.end_pct),
              grownBytes: num(v.grown_bytes),
            },
          ]
        : [];
    }),
    updates: list(d.updates, 60).flatMap((raw) => {
      const u = rec(raw);
      const name = str(u.name);
      return name
        ? [
            {
              kind: u.kind === "dsm" ? ("dsm" as const) : ("packages" as const),
              name,
              from: str(u.from_version, 40) ?? "?",
              to: str(u.to_version, 40) ?? "?",
              state: str(u.state, 20) ?? "?",
              endedAt: str(u.ended_at, 40),
            },
          ]
        : [];
    }),
    fulmar: {
      calls: count(fulmar.calls),
      denied: count(fulmar.denied),
      writes: list(fulmar.writes, 30).flatMap((raw) => {
        const w = rec(raw);
        const op = str(w.op, 60);
        return op && /^[a-z_.]+$/.test(op)
          ? [{ op, count: count(w.count) }]
          : [];
      }),
    },
  };
}

/** « volume_1 » de DSM, dit « Volume 1 ». */
export function volumeName(id: string): string {
  const n = id.match(/^volume_(\d+)$/)?.[1];
  return n ? `Volume ${n}` : id;
}

/** « 1 incident, résolu ; lu 99,8 % du temps ; Volume 1 à 64 % ; 1 mise à jour faite. » */
export function briefLine(r: MonthReport, lang: Locale): string {
  const parts: string[] = [];
  const open = r.incidents.filter((i) => !i.recoveredAt).length;
  const n = r.incidents.length;
  if (!n) parts.push(tr(lang, { en: "no incident", fr: "aucun incident" }));
  else {
    const what =
      lang === "en"
        ? plural(n, "incident", "incidents", lang)
        : plural(n, "incident", "incidents", lang);
    const state =
      open === 0
        ? tr(lang, {
            en: n > 1 ? "all resolved" : "resolved",
            fr: n > 1 ? "tous résolus" : "résolu",
          })
        : tr(lang, {
            en: `${open} still open`,
            fr: `${open} encore ${open > 1 ? "ouverts" : "ouvert"}`,
          });
    parts.push(`${what}, ${state}`);
  }
  if (r.availability.readPct !== null)
    parts.push(
      tr(lang, {
        en: `read ${number(r.availability.readPct, 1, lang)}% of the time`,
        fr: `lu ${number(r.availability.readPct, 1, lang)} % du temps`,
      }),
    );
  for (const v of r.volumes.slice(0, 3))
    if (v.endPct !== null)
      parts.push(
        tr(lang, {
          en: `${volumeName(v.volume)} at ${Math.round(v.endPct)}%`,
          fr: `${volumeName(v.volume)} à ${Math.round(v.endPct)} %`,
        }),
      );
  const done = r.updates.filter((u) => u.state === "done").length;
  if (done)
    parts.push(
      lang === "en"
        ? plural(done, "update done", "updates done", lang)
        : plural(done, "mise à jour faite", "mises à jour faites", lang),
    );
  const text = parts.join(lang === "en" ? "; " : " ; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Les `n` derniers mois (UTC), le plus récent d'abord. */
export function monthsBack(
  now: Date,
  n: number,
  lang: Locale,
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    out.push({
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: new Intl.DateTimeFormat(lang, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(d),
    });
  }
  return out;
}

/** Le bilan d'un NAS fictif : un exemple, jamais un vrai NAS. */
export function demoReport(month: string, lang: Locale): MonthReport {
  const at = (day: number, h: number) =>
    `${month}-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00+00:00`;
  return {
    month,
    inProgress: false,
    endState: { source: "frozen", ok: 44, warning: 2, failed: 0, failing: [] },
    incidents: [
      {
        checkId: "backup.task_result",
        title: tr(lang, { en: "Backups", fr: "Sauvegardes" }),
        status: "failed",
        at: at(12, 3),
        recoveredAt: at(13, 3),
      },
      {
        checkId: "system.temperature",
        title: tr(lang, { en: "Temperature", fr: "Température" }),
        status: "warning",
        at: at(20, 15),
        recoveredAt: at(20, 18),
      },
    ],
    availability: { readPct: 99.7, since: at(1, 0) },
    vitals: {
      cpuAvg: 9.4,
      cpuMax: 71,
      memoryAvg: 38,
      memoryMax: 57,
      temperatureMax: 55,
    },
    volumes: [
      { volume: "volume_1", startPct: 61.2, endPct: 63.8, grownBytes: 2.6e11 },
    ],
    updates: [
      {
        kind: "packages",
        name: "Hyper Backup",
        from: "4.2.1",
        to: "4.2.2",
        state: "done",
        endedAt: at(8, 2),
      },
    ],
    fulmar: {
      calls: 43200,
      denied: 0,
      writes: [{ op: "packages.update", count: 1 }],
    },
  };
}

const WRITES: Record<string, [en: string, fr: string]> = {
  "packages.update": ["package updates", "mises à jour de paquets"],
  "dsm.update_run": ["DSM updates", "mises à jour de DSM"],
  "updates.schedule": ["updates scheduled", "mises à jour programmées"],
  "updates.unschedule": ["schedules cancelled", "rendez-vous annulés"],
  "updates.protect": ["protections changed", "protections changées"],
  "access.close": ["access closed", "accès fermés"],
  "access.extend": ["deadlines pushed back", "échéances repoussées"],
  "access.policy": ["access rules set", "règles d'accès posées"],
  "agent.detach": ["NAS detached", "NAS détaché"],
  "devices.pair": ["pairing codes opened", "codes d'appairage ouverts"],
  "devices.revoke": ["phones removed", "téléphones retirés"],
};

/** Une écriture du mois, dite en mots : « 4 protections changées ». */
export function writeWords(
  w: { op: string; count: number },
  lang: Locale,
): string {
  const words = WRITES[w.op];
  if (!words) return `${w.op} (${w.count})`;
  return `${w.count} ${lang === "en" ? words[0] : words[1]}`;
}

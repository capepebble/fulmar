// Mises à jour des paquets et de DSM, tout de suite ou programmées (conception
// 2026-11-26-mises-a-jour-paquets) : ce que rendent packages.update_check, packages.update,
// dsm.update_check, dsm.update_run, updates.schedule et updates.status de l'agent (droits
// packages:update et dsm:update), lu sans confiance. Fonctions pures.

export const PACKAGE_ID = /^[A-Za-z0-9._+-]{1,64}$/;

export type Feasibility = "ok" | "warning" | "blocked" | "unknown";

export interface PlannedPackage {
  id: string;
  name: string;
  installed: string | null;
  available: string | null;
  state:
    | "ready"
    | "up_to_date"
    | "not_installed"
    | "not_from_synology"
    | "unknown";
}

export interface UpdatePlan {
  packages: PlannedPackage[];
  feasibility: Feasibility;
  /** Les raisons de DSM, dans ses mots : des données, jamais des consignes. */
  reasons: string[];
}

export interface DsmPlan {
  current: string | null;
  available: boolean;
  version: string | null;
  feasibility: Feasibility;
  reasons: string[];
}

export type RunState = "pending" | "running" | "done" | "failed";

export interface DsmRun {
  from: string;
  to: string;
  step: "download" | "check" | "install" | "restart" | "end";
  state: RunState;
  percent: number | null;
  error: string | null;
}

export interface UpdateJob {
  id: string;
  kind: "packages" | "dsm";
  state: RunState;
  startedAt: string;
  endedAt: string | null;
  dsm: DsmRun | null;
  packages: {
    id: string;
    name: string;
    from: string;
    to: string;
    state: RunState;
    error: string | null;
  }[];
}

export interface Scheduled {
  id: string;
  target: "packages" | "dsm";
  packages: string[];
  at: string;
  acceptWarnings: boolean;
  state: "waiting" | "started" | "skipped" | "cancelled";
  reason: string | null;
}

export interface UpdatesState {
  running: boolean;
  jobs: UpdateJob[];
  schedules: Scheduled[];
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v.slice(0, 200) : null;
const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.slice(0, 60) : [];
// Caractères de contrôle d'un texte venu de DSM, retirés à l'affichage.
const CONTROL = /\p{Cc}/gu;
const clean = (v: unknown): string | null =>
  str(v)?.replace(CONTROL, " ") ?? null;
const reasons = (v: unknown): string[] =>
  list(v)
    .map(clean)
    .filter((r): r is string => r !== null)
    .slice(0, 10);

const FEASIBILITY = new Set<Feasibility>([
  "ok",
  "warning",
  "blocked",
  "unknown",
]);
const feasibility = (v: unknown): Feasibility => {
  const f = str(v) as Feasibility | null;
  return f && FEASIBILITY.has(f) ? f : "unknown";
};
const PLAN_STATES = new Set<PlannedPackage["state"]>([
  "ready",
  "up_to_date",
  "not_installed",
  "not_from_synology",
  "unknown",
]);
const RUN_STATES = new Set<RunState>(["pending", "running", "done", "failed"]);
const STEPS = new Set<DsmRun["step"]>([
  "download",
  "check",
  "install",
  "restart",
  "end",
]);
const SCHEDULE_STATES = new Set<Scheduled["state"]>([
  "waiting",
  "started",
  "skipped",
  "cancelled",
]);

export function mapPlan(data: unknown): UpdatePlan {
  const d = rec(data);
  return {
    feasibility: feasibility(d.feasibility),
    reasons: reasons(d.reasons),
    packages: list(d.packages).flatMap((raw) => {
      const p = rec(raw);
      const id = str(p.id);
      const state = str(p.state) as PlannedPackage["state"] | null;
      if (!id || !PACKAGE_ID.test(id) || !state || !PLAN_STATES.has(state))
        return [];
      return [
        {
          id,
          name: clean(p.name) ?? id,
          installed: str(p.installed),
          available: str(p.available),
          state,
        },
      ];
    }),
  };
}

export function mapDsmPlan(data: unknown): DsmPlan {
  const d = rec(data);
  return {
    current: str(d.current),
    available: d.available === true,
    version: str(d.version),
    feasibility: feasibility(d.feasibility),
    reasons: reasons(d.reasons),
  };
}

function mapDsmRun(raw: unknown): DsmRun | null {
  const d = rec(raw);
  const state = str(d.state) as RunState | null;
  const step = str(d.step) as DsmRun["step"] | null;
  if (!state || !RUN_STATES.has(state) || !step || !STEPS.has(step))
    return null;
  return {
    from: str(d.from_version) ?? "?",
    to: str(d.to_version) ?? "?",
    step,
    state,
    percent: typeof d.percent === "number" ? Math.round(d.percent) : null,
    error: clean(d.error),
  };
}

export function mapJob(raw: unknown): UpdateJob | null {
  const j = rec(raw);
  const id = str(j.id);
  const state = str(j.state) as RunState | null;
  const startedAt = str(j.started_at);
  if (!id || !state || !RUN_STATES.has(state) || !startedAt) return null;
  return {
    id,
    kind: j.kind === "dsm" ? "dsm" : "packages",
    state,
    startedAt,
    endedAt: str(j.ended_at),
    dsm: mapDsmRun(j.dsm),
    packages: list(j.packages).flatMap((rawPkg) => {
      const p = rec(rawPkg);
      const pid = str(p.id);
      const ps = str(p.state) as RunState | null;
      if (!pid || !ps || !RUN_STATES.has(ps)) return [];
      return [
        {
          id: pid,
          name: clean(p.name) ?? pid,
          from: str(p.from_version) ?? "?",
          to: str(p.to_version) ?? "?",
          state: ps,
          error: clean(p.error),
        },
      ];
    }),
  };
}

export function mapScheduled(raw: unknown): Scheduled | null {
  const s = rec(raw);
  const id = str(s.id);
  const at = str(s.at);
  const state = str(s.state) as Scheduled["state"] | null;
  if (!id || !at || !state || !SCHEDULE_STATES.has(state)) return null;
  return {
    id,
    target: s.target === "dsm" ? "dsm" : "packages",
    packages: list(s.packages).filter(
      (p): p is string => typeof p === "string" && PACKAGE_ID.test(p),
    ),
    at,
    acceptWarnings: s.accept_warnings === true,
    state,
    reason: clean(s.reason),
  };
}

export function mapJobs(data: unknown): UpdatesState {
  const d = rec(data);
  return {
    running: d.running === true,
    jobs: list(d.jobs)
      .map(mapJob)
      .filter((j): j is UpdateJob => j !== null),
    schedules: list(d.schedules)
      .map(mapScheduled)
      .filter((s): s is Scheduled => s !== null),
  };
}

/** Les identifiants retenus d'une sélection : valides, sans doublon, cinquante au plus. */
export function packageIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const valid = ids.filter(
    (i): i is string => typeof i === "string" && PACKAGE_ID.test(i),
  );
  return [...new Set(valid)].slice(0, 50);
}

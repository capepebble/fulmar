// Mises à jour du parc (conception 2026-11-26-groupes-protections-parc, section 3) : ce que
// rendent les routes /v1/fleet/rollouts du hub, lu sans confiance. Fonctions pures.

import { LOCAL_AGENT_ID } from "./config-ids";

export type StepState =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed"
  | "stopped";
export type RolloutState =
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface RolloutStep {
  nas: string;
  state: StepState;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Rollout {
  id: string;
  target: "packages" | "dsm";
  at: string;
  acceptWarnings: boolean;
  createdAt: string;
  state: RolloutState;
  reason: string | null;
  endedAt: string | null;
  cancel: boolean;
  steps: RolloutStep[];
}

export const HUB_KEY = "hub";
const NAS_KEY = /^(hub|[0-9a-f]{8})$/;
const ROLLOUT_ID = /^[0-9a-f]{8}$/;
const STEP_STATES = new Set<StepState>([
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
  "stopped",
]);
const ROLLOUT_STATES = new Set<RolloutState>([
  "waiting",
  "running",
  "done",
  "failed",
  "cancelled",
]);
const CONTROL = /\p{Cc}/gu;

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown, max = 60): string | null =>
  typeof v === "string" && v !== "" ? v.slice(0, max) : null;
const text = (v: unknown): string | null =>
  str(v, 300)?.replace(CONTROL, " ") ?? null;

function mapRollout(raw: unknown): Rollout | null {
  const r = rec(raw);
  const id = str(r.id);
  const state = str(r.state) as RolloutState | null;
  if (!id || !ROLLOUT_ID.test(id) || !state || !ROLLOUT_STATES.has(state))
    return null;
  return {
    id,
    target: r.target === "dsm" ? "dsm" : "packages",
    at: str(r.at) ?? "",
    acceptWarnings: r.accept_warnings === true,
    createdAt: str(r.created_at) ?? "",
    state,
    reason: text(r.reason),
    endedAt: str(r.ended_at),
    cancel: r.cancel === true,
    steps: (Array.isArray(r.steps) ? r.steps.slice(0, 501) : []).flatMap(
      (rawStep) => {
        const s = rec(rawStep);
        const nas = str(s.nas);
        const st = str(s.state) as StepState | null;
        if (!nas || !NAS_KEY.test(nas) || !st || !STEP_STATES.has(st))
          return [];
        return [
          {
            nas,
            state: st,
            reason: text(s.reason),
            startedAt: str(s.started_at),
            endedAt: str(s.ended_at),
          },
        ];
      },
    ),
  };
}

export function mapRollouts(data: unknown): {
  running: boolean;
  rollouts: Rollout[];
} {
  const d = rec(data);
  return {
    running: d.running === true,
    rollouts: (Array.isArray(d.rollouts) ? d.rollouts.slice(0, 10) : [])
      .map(mapRollout)
      .filter((r): r is Rollout => r !== null),
  };
}

/** La clé d'un NAS pour le hub : « hub » pour le NAS du projet, l'identifiant d'un NAS ajouté ;
 * `null` pour un NAS que le hub ne mène pas. */
export function rolloutKey(agent: {
  id: string;
  member?: boolean;
}): string | null {
  if (agent.member) return /^[0-9a-f]{8}$/.test(agent.id) ? agent.id : null;
  return agent.id === LOCAL_AGENT_ID ? HUB_KEY : null;
}

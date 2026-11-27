import type { NasState } from "@/lib/fleet/state";
import type { Status } from "@/lib/fleet/types";

/** Teinte d'un état : rouge, ambre, vert, gris. Jamais seule : toujours doublée d'un mot. */
export type Tone = "crit" | "warn" | "ok" | "off";

export const STATE_TONE: Record<NasState | Status, Tone> = {
  offline: "crit",
  failed: "crit",
  denied: "warn",
  agent_down: "warn",
  warning: "warn",
  unknown: "off",
  beszel_only: "off",
  ok: "ok",
};

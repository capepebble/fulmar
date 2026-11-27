// État d'un NAS (conception, § 6) : le pire de son accessibilité et de ses contrôles, ceux « à
// titre indicatif » exclus. Un seul jeu de mots, partout.

import type { Texts } from "@/i18n";
import type { Nas, Status } from "./types";

export type NasState =
  | "offline"
  | "failed"
  | "denied"
  | "agent_down"
  | "warning"
  | "unknown"
  | "beszel_only"
  | "ok";

/** Du pire au meilleur. */
export const NAS_STATE_ORDER: NasState[] = [
  "offline",
  "failed",
  "denied",
  "agent_down",
  "warning",
  "unknown",
  "beszel_only",
  "ok",
];

export const NAS_STATE_LABEL: Record<NasState, Texts> = {
  offline: { en: "Offline", fr: "Hors ligne" },
  failed: { en: "Failed", fr: "En échec" },
  denied: { en: "Access denied", fr: "Accès refusé" },
  agent_down: { en: "Agent unreachable", fr: "Agent injoignable" },
  warning: { en: "Warning", fr: "À surveiller" },
  unknown: { en: "Unknown", fr: "Inconnu" },
  beszel_only: { en: "No agent", fr: "Sans agent" },
  ok: { en: "OK", fr: "OK" },
};

export const SEVERITY_LABEL: Record<"high" | "medium" | "info", Texts> = {
  high: { en: "High severity", fr: "Gravité haute" },
  medium: { en: "Medium severity", fr: "Gravité moyenne" },
  info: { en: "For information", fr: "À titre indicatif" },
};

export const STATUS_LABEL: Record<Status, Texts> = {
  failed: { en: "Failed", fr: "En échec" },
  warning: { en: "Warning", fr: "À surveiller" },
  ok: { en: "OK", fr: "OK" },
  unknown: { en: "Unknown", fr: "Inconnu" },
};

/** Un contrôle compte pour l'état : suivi, et pas « à titre indicatif ». */
export function counts(c: Nas["checks"][number]): boolean {
  return c.severity !== "info" && c.followed !== false;
}

/** Le pire des contrôles suivis, ceux « à titre indicatif » exclus. */
export function checksStatus(nas: Nas): Status {
  const counted = nas.checks.filter(counts);
  for (const s of ["failed", "warning", "unknown"] as const)
    if (counted.some((c) => c.status === s)) return s;
  return "ok";
}

export function nasState(nas: Nas): NasState {
  const seen = nas.beszel.kind === "ok";
  switch (nas.agent.kind) {
    case "none":
      // Hub muet : on ne sait rien du NAS, ce n'est pas lui qui est hors ligne.
      if (nas.beszel.kind === "down" && nas.beszel.hub) return "unknown";
      return seen ? "beszel_only" : "offline";
    case "down":
      return seen ? "agent_down" : "offline";
    case "denied":
      return "denied";
    case "ok":
      return checksStatus(nas);
  }
}

/** Tri du pire au meilleur ; à égalité, l'ordre du parc est gardé (tri stable). */
export function byState(a: Nas, b: Nas): number {
  return (
    NAS_STATE_ORDER.indexOf(nasState(a)) - NAS_STATE_ORDER.indexOf(nasState(b))
  );
}

/** Comptes des contrôles d'un NAS, les mêmes partout (en-tête, onglet, carte) : les contrôles
 * « à titre indicatif » qui ne sont pas OK comptent à part. */
export function checkCounts(nas: Nas): {
  failed: number;
  warning: number;
  ok: number;
  unknown: number;
  info: number;
  /** Contrôles qu'on ne suit plus. */
  muted: number;
} {
  const c = nas.checks.filter((x) => x.followed !== false);
  const counted = (s: Status) =>
    c.filter((x) => x.status === s && x.severity !== "info").length;
  return {
    failed: counted("failed"),
    warning: counted("warning"),
    ok: c.filter((x) => x.status === "ok").length,
    unknown: c.filter((x) => x.status === "unknown").length,
    info: c.filter(
      (x) =>
        x.severity === "info" &&
        (x.status === "failed" || x.status === "warning"),
    ).length,
    muted: nas.checks.length - c.length,
  };
}

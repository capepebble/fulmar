// Fermer un accès resté ouvert (conception 2026-11-26-fermer-acces) : ce que rendent
// access.watch, access.close, access.extend et access.policy de l'agent, lu sans confiance.
// Fonctions pures.

import { type Locale, tr } from "@/i18n";

export type AccessService = "ssh" | "telnet";
export type AccessMode = "off" | "remind" | "close";

export interface ServiceWatch {
  service: AccessService;
  /** Ouvert dans DSM ; `null` avant la première lecture. */
  open: boolean | null;
  openSince: string | null;
  deadline: string | null;
  closedAt: string | null;
  mode: AccessMode;
  minutes: number;
}

export interface WatchOk {
  kind: "ok";
  watching: boolean;
  canAct: boolean;
  services: ServiceWatch[];
  demo?: boolean;
}

export type WatchView =
  | WatchOk
  | { kind: "denied" | "old" | "down"; reason: string };

export const SERVICES: AccessService[] = ["ssh", "telnet"];
export const MODES: AccessMode[] = ["off", "remind", "close"];
export const DURATIONS = [15, 30, 60, 120, 240, 480];

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" && v.length <= 40 ? v : null;

export function mapServiceWatch(raw: unknown): ServiceWatch | null {
  const d = rec(raw);
  if (!SERVICES.includes(d.service as AccessService)) return null;
  const policy = rec(d.policy);
  const mode = MODES.includes(policy.mode as AccessMode)
    ? (policy.mode as AccessMode)
    : "off";
  const minutes =
    typeof policy.minutes === "number" &&
    Number.isInteger(policy.minutes) &&
    policy.minutes >= 15 &&
    policy.minutes <= 1440
      ? policy.minutes
      : 60;
  return {
    service: d.service as AccessService,
    open: typeof d.open === "boolean" ? d.open : null,
    openSince: str(d.open_since),
    deadline: str(d.deadline),
    closedAt: str(d.closed_at),
    mode: mode === "off" && policy.mode !== "off" ? "off" : mode,
    minutes: mode === "off" && policy.mode !== "off" ? 60 : minutes,
  };
}

export function mapWatch(data: unknown): WatchView {
  const d = rec(data);
  const services = (Array.isArray(d.services) ? d.services : [])
    .map(mapServiceWatch)
    .filter((s): s is ServiceWatch => s !== null);
  return {
    kind: "ok",
    watching: d.watching === true,
    canAct: d.can_act === true,
    services: SERVICES.flatMap((s) =>
      services.filter((w) => w.service === s).slice(0, 1),
    ),
  };
}

export function watchError(
  status: number | undefined,
  reason: string,
  lang: Locale,
): WatchView {
  if (status === 401 || status === 403)
    return {
      kind: "denied",
      reason: tr(lang, {
        en: "The console’s token cannot read this NAS’s access (security:read right).",
        fr: "Le jeton de la console ne peut pas lire les accès de ce NAS (droit security:read).",
      }),
    };
  if (status === 404)
    return {
      kind: "old",
      reason: tr(lang, {
        en: "This agent cannot close an access yet: update it.",
        fr: "Cet agent ne sait pas encore fermer un accès : le mettre à jour.",
      }),
    };
  return { kind: "down", reason };
}

/** Un NAS fictif : SSH ouvert depuis vingt minutes, fermé dans quarante ; aucun geste. */
export function demoWatch(now: Date): WatchOk {
  const at = (min: number) =>
    new Date(now.getTime() + min * 60_000).toISOString();
  return {
    kind: "ok",
    demo: true,
    watching: true,
    canAct: false,
    services: [
      {
        service: "ssh",
        open: true,
        openSince: at(-20),
        deadline: at(40),
        closedAt: null,
        mode: "close",
        minutes: 60,
      },
      {
        service: "telnet",
        open: false,
        openSince: null,
        deadline: null,
        closedAt: null,
        mode: "off",
        minutes: 60,
      },
    ],
  };
}

export type AccessChange =
  | { kind: "close" }
  | { kind: "extend"; minutes: number }
  | { kind: "policy"; mode: AccessMode; minutes: number };

/** Le chemin d'un geste, ses paramètres revérifiés ; null si quelque chose ne va pas. */
export function changePath(service: unknown, change: unknown): string | null {
  if (!SERVICES.includes(service as AccessService)) return null;
  const c = change as AccessChange | null;
  if (!c || typeof c !== "object") return null;
  if (c.kind === "close") return `/access/close?service=${service}`;
  if (c.kind === "extend" && DURATIONS.includes(c.minutes))
    return `/access/extend?service=${service}&minutes=${c.minutes}`;
  if (
    c.kind === "policy" &&
    MODES.includes(c.mode) &&
    DURATIONS.includes(c.minutes)
  )
    return `/access/policy?service=${service}&mode=${c.mode}&minutes=${c.minutes}`;
  return null;
}

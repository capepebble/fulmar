// La vue du parc (conception 2026-11-24, section 4) : ce que montre chaque NAS, sans texte,
// et les groupes d'état des filtres et des colonnes.

import type { Locale, Texts } from "@/i18n";
import { type CategoryLight, greenShare, lights } from "./lights";
import {
  NAS_STATE_LABEL,
  NAS_STATE_ORDER,
  type NasState,
  nasState,
} from "./state";
import type { Nas, NasFolder } from "./types";
import { fullestVolume } from "./vitals";

/** Les quatre groupes d'état : colonnes de la vue en colonnes et pastilles de filtre. */
export type StateGroup = "failed" | "watch" | "unreachable" | "ok";

export const STATE_GROUPS: { id: StateGroup; label: Texts }[] = [
  { id: "failed", label: { en: "Failed", fr: "En échec" } },
  { id: "watch", label: { en: "Warning", fr: "À surveiller" } },
  { id: "unreachable", label: { en: "Unreachable", fr: "Injoignables" } },
  { id: "ok", label: { en: "OK", fr: "OK" } },
];

export function stateGroup(state: NasState): StateGroup {
  switch (state) {
    case "failed":
      return "failed";
    case "warning":
    case "unknown":
      return "watch";
    case "offline":
    case "agent_down":
    case "denied":
      return "unreachable";
    default:
      return "ok";
  }
}

/** Une ligne (ou une carte) du parc : rien que des valeurs sérialisables. */
export interface BoardItem {
  id: string;
  name: string;
  place: string;
  folder: NasFolder | null;
  model: string;
  state: NasState;
  stateLabel: string;
  group: StateGroup;
  /** Rang de l'état, du pire (0) au meilleur. */
  rank: number;
  lights: CategoryLight[];
  green: { ok: number; total: number };
  cpu: number | null;
  ram: number | null;
  /** Le volume le plus rempli, en %. */
  volume: number | null;
  temp: number | null;
  readAt: string | null;
  fictive: boolean;
  withAgent: boolean;
}

export function boardItem(nas: Nas, lang: Locale): BoardItem {
  const state = nasState(nas);
  const fullest = fullestVolume(nas.volumes);
  return {
    id: nas.id,
    name: nas.name,
    place: nas.place && nas.place !== "–" ? nas.place : "",
    folder: nas.folder ?? null,
    model: nas.model && nas.model !== "–" ? nas.model : "",
    state,
    stateLabel: NAS_STATE_LABEL[state][lang],
    group: stateGroup(state),
    rank: NAS_STATE_ORDER.indexOf(state),
    lights: lights(nas),
    green: greenShare(nas),
    cpu: nas.vitals.cpu,
    ram: nas.vitals.ram,
    volume: fullest ? fullest.pct : null,
    temp: nas.vitals.temp,
    readAt:
      nas.agent.kind === "ok"
        ? nas.agent.readAt
        : nas.agent.kind === "down" || nas.agent.kind === "denied"
          ? nas.agent.lastReadAt
          : null,
    fictive: !nas.live,
    withAgent: nas.agent.kind !== "none",
  };
}

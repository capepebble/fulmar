// Composition du parc (conception, § 8) : les NAS de agents.json, chacun avec son agent et,
// s'il désigne son système (`beszelSystem`), avec Beszel ; plus chaque système que le compte
// de la console voit dans Beszel et qu'aucune entrée ne désigne, en NAS « Sans agent ».
// Une information, une source : les constantes viennent de l'historique de l'agent quand il
// le tient (conception du 2026-11-23), sinon de Beszel quand il voit le NAS.

import { type Locale, type Texts, tr } from "@/i18n";
import { instantFromBeszel, uptime } from "@/lib/agents/time";
import type { AgentConfig } from "@/lib/agents/types";
import type { BzResult } from "@/lib/beszel/client";
import { latestVitals } from "@/lib/beszel/map";
import type { BzStats, BzSystem } from "@/lib/beszel/types";
import type { BeszelLink, Nas } from "./types";

export interface FleetInput {
  agents: AgentConfig[];
  /** NAS lus par leur agent, par identifiant de configuration. */
  agentNas: Map<string, Nas>;
  /** Systèmes vus par Beszel ; `null` si Beszel n'est pas branché. */
  systems: BzResult<BzSystem[]> | null;
  /** Dernier relevé de chaque système, quand la page l'a lu. */
  latest: Map<string, BzStats>;
  /** Langue de la page. */
  lang: Locale;
}

function linkOf(
  systemId: string | undefined,
  systems: BzResult<BzSystem[]> | null,
  lang: Locale,
): { link: BeszelLink; system: BzSystem | null } {
  if (!systemId || !systems) return { link: { kind: "none" }, system: null };
  if (!systems.ok)
    return {
      link: {
        kind: "down",
        systemId,
        lastAt: null,
        reason: systems.reason[lang],
        hub: true,
      },
      system: null,
    };
  const system = systems.data.find((s) => s.id === systemId) ?? null;
  if (!system) return { link: { kind: "missing", systemId }, system: null };
  const lastAt = system.updated ? instantFromBeszel(system.updated) : null;
  if (system.status === "up")
    return {
      link: { kind: "ok", systemId, lastAt: lastAt ?? systems.at },
      system,
    };
  return {
    link: {
      kind: "down",
      systemId,
      lastAt,
      reason:
        system.status === "paused"
          ? tr(lang, {
              en: "monitoring paused in Beszel",
              fr: "suivi suspendu dans Beszel",
            })
          : tr(lang, {
              en: "Beszel no longer sees the NAS",
              fr: "Beszel ne voit plus le NAS",
            }),
    },
    system,
  };
}

/** Constantes de Beszel, valeur du moment comprise, pour que le chiffre et sa courbe
 * concordent ; le temps de marche reste celui de l'agent quand il est lu. */
function withBeszel(
  nas: Nas,
  system: BzSystem,
  last: BzStats | null,
  lang: Locale,
): Nas {
  const v = latestVitals(system, last);
  return {
    ...nas,
    vitals: {
      cpu: v.cpu,
      ram: v.ram,
      temp: v.temp,
      netBps: v.netBps,
      uptime:
        nas.agent.kind === "ok" ? nas.vitals.uptime : uptime(v.uptimeS, lang),
      source: "beszel",
    },
  };
}

function beszelOnlyNas(system: BzSystem, link: BeszelLink, lang: Locale): Nas {
  return {
    id: `bz-${system.id}`,
    name: system.name,
    model: "–",
    dsm: "–",
    timeZone: "–",
    place: "",
    reachable: link.kind === "ok",
    real: false,
    live: true,
    readAt: null,
    problem: link.kind === "down" ? link.reason : null,
    vitals: {
      cpu: null,
      ram: null,
      temp: null,
      uptime: tr(lang, { en: "unknown", fr: "inconnue" }),
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
    ups: tr(lang, { en: "Unknown", fr: "Inconnu" }),
    connected: [],
    activity: [],
    fileLogs: "unknown",
    checks: [],
    agent: { kind: "none" },
    agentHistory: false,
    beszel: link,
    tzOffsetMin: null,
    backupLog: [],
    backupLogFrom: null,
    backupLogRead: false,
    seen: {},
    ramMb: null,
    dsmUpdate: null,
    packages: null,
    network: null,
  };
}

export function composeFleet(input: FleetInput): Nas[] {
  const { agents, agentNas, systems, latest } = input;
  const fleet: Nas[] = [];
  for (const agent of agents) {
    const nas = agentNas.get(agent.id);
    if (!nas) continue;
    const { link, system } = linkOf(agent.beszelSystem, systems, input.lang);
    const linked = { ...nas, beszel: link };
    // L'agent qui tient son historique garde ses constantes ; Beszel ne sert qu'aux autres.
    fleet.push(
      link.kind === "ok" && system && !nas.agentHistory
        ? withBeszel(linked, system, latest.get(system.id) ?? null, input.lang)
        : linked,
    );
  }
  if (systems?.ok) {
    const designated = new Set(
      agents.map((a) => a.beszelSystem).filter(Boolean),
    );
    const others = systems.data
      .filter((s) => !designated.has(s.id))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
    for (const system of others) {
      const { link } = linkOf(system.id, systems, input.lang);
      const nas = beszelOnlyNas(system, link, input.lang);
      fleet.push(
        link.kind === "ok"
          ? withBeszel(nas, system, latest.get(system.id) ?? null, input.lang)
          : nas,
      );
    }
  }
  return fleet;
}

/** Un NAS « Sans agent » quand le hub ne répond pas : on ne connaît ni son nom ni son état,
 * mais sa page s'ouvre et dit pourquoi. */
export function unreadableBeszelNas(
  id: string,
  reason: Texts,
  lang: Locale,
): Nas {
  const systemId = id.replace(/^bz-/, "");
  return beszelOnlyNas(
    {
      id: systemId,
      name: tr(lang, { en: "NAS without agent", fr: "NAS sans agent" }),
    },
    { kind: "down", systemId, lastAt: null, reason: reason[lang], hub: true },
    lang,
  );
}

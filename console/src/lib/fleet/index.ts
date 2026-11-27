import "server-only";

import { connection } from "next/server";
import type { Locale } from "@/i18n";
import { demoEnabled, loadAgents } from "@/lib/agents/config";
import { loadNas, readName } from "@/lib/agents/read";
import type { AgentConfig } from "@/lib/agents/types";
import { type BeszelClient, type BzResult, beszel } from "@/lib/beszel/client";
import type { BzStats, BzSystem } from "@/lib/beszel/types";
import { memory } from "@/lib/store/memory";
import { composeFleet, unreadableBeszelNas } from "./compose";
import { DEMO_FLEET, demoFleetAt, demoName } from "./demo";
import { applyFollow } from "./follow";
import type { Nas } from "./types";

export { categoryLabel, specs } from "./specs";
export * from "./types";

// Source de données : les agents de data/agents.json, lus à la demande ; sans agent, le parc
// de démonstration. Les NAS fictifs ne s'ajoutent aux vrais qu'avec NAS_CONSOLE_DEMO=1.

function demoFleet(agentIds: string[], lang: Locale): Nas[] {
  return demoFleetAt(new Date(), lang).filter(
    (nas) => !agentIds.includes(nas.id),
  );
}

/** Les NAS fictifs : sans agent ni Beszel, ou à côté des vrais avec NAS_CONSOLE_DEMO=1. */
function withDemo(agents: AgentConfig[]): boolean {
  return agents.length === 0 ? beszel() === null : demoEnabled(agents);
}

let pruned = false;

/** Une fois par démarrage : la mémoire oublie les NAS retirés de agents.json. */
function pruneOnce(): void {
  if (pruned) return;
  pruned = true;
  // Les NAS fictifs restent : leurs groupes s'essaient comme les autres.
  memory().prune(listNasIds());
}

/** Fenêtre du relevé « du moment » : le palier d'une minute en garde une heure. */
const LATEST_WINDOW_MS = 5 * 60_000;

/** Dernier relevé de chaque système, au palier d'une minute : le chiffre du moment se lit
 * comme sa courbe (même capteur de température). Une lecture ratée n'en donne aucun : on
 * retombe sur le résumé du système. */
async function latestStats(
  bz: BeszelClient,
  systems: BzResult<BzSystem[]>,
): Promise<Map<string, BzStats>> {
  const latest = new Map<string, BzStats>();
  if (!systems.ok || systems.data.length === 0) return latest;
  const read = await bz.stats(
    systems.data.map((s) => s.id),
    "1m",
    new Date(Date.now() - LATEST_WINDOW_MS),
  );
  // Relevés du plus ancien au plus récent : le dernier l'emporte.
  if (read.ok) for (const r of read.data) latest.set(r.system, r.stats ?? {});
  return latest;
}

/** Agents et Beszel lus en parallèle : un Beszel en panne ne retarde l'agent que de son délai. */
async function readFleet(agents: AgentConfig[], lang: Locale): Promise<Nas[]> {
  const bz = beszel();
  const [agentNas, read] = await Promise.all([
    Promise.all(agents.map((agent) => loadNas(agent, lang))),
    bz
      ? bz.systems().then(async (systems) => ({
          systems,
          latest: await latestStats(bz, systems),
        }))
      : Promise.resolve(null),
  ]);
  return composeFleet({
    agents,
    agentNas: new Map(agents.map((a, i) => [a.id, agentNas[i]])),
    systems: read?.systems ?? null,
    latest: read?.latest ?? new Map(),
    lang,
  });
}

/** Pourquoi Beszel ne répond pas, ou `null` s'il répond ou n'est pas branché. */
export async function beszelTrouble(lang: Locale): Promise<string | null> {
  const bz = beszel();
  if (!bz) return null;
  // Lu en parallèle de getFleet() : la page doit déjà être déclarée « à la requête » ici,
  // la lecture prenant l'heure.
  await connection();
  const systems = await bz.systems();
  return systems.ok ? null : systems.reason[lang];
}

/** Le suivi choisi, appliqué dès la lecture : toutes les vues en tiennent compte. */
/** Le suivi choisi, puis le groupe de chaque NAS, tels que la mémoire de la console les garde. */
function followed(list: Nas[]): Nas[] {
  const m = memory();
  const rules = m.unfollowed();
  const folders = new Map(
    m
      .folders()
      .map((f, rank) => [f.id, { id: f.id, name: f.name, kind: f.kind, rank }]),
  );
  const placed = m.nasFolders();
  return list.map((nas) => ({
    ...applyFollow(nas, rules),
    folder: folders.get(placed[nas.id] ?? "") ?? null,
  }));
}

export async function getFleet(lang: Locale): Promise<Nas[]> {
  const agents = loadAgents();
  // Lecture à la requête : jamais figée au moment de la construction.
  await connection();
  if (agents.length === 0 && beszel() === null)
    return followed(demoFleetAt(new Date(), lang));
  pruneOnce();
  const live = await readFleet(agents, lang);
  const demo = withDemo(agents)
    ? demoFleet(
        live.map((n) => n.id),
        lang,
      )
    : [];
  return followed([...live, ...demo]);
}

/** Identifiants connus sans rien lire : pour préparer les pages à la construction. */
export function listNasIds(): string[] {
  const agents = loadAgents();
  const ids = agents.map((a) => a.id);
  const demo = withDemo(agents)
    ? DEMO_FLEET.filter((n) => !ids.includes(n.id))
    : [];
  return [...ids, ...demo.map((n) => n.id)];
}

/** Nom d'un NAS sans rien lire (titre de l'onglet du navigateur), dans la langue de la page. */
export function nasName(id: string, lang: Locale): string | undefined {
  const agent = loadAgents().find((a) => a.id === id);
  if (agent?.autoName) return readName(id) ?? agent.name;
  return agent?.name ?? demoName(id, lang);
}

/** Un NAS : son agent et Beszel, ou un NAS « Sans agent » (`bz-<système>`), ou un NAS fictif. */
export async function getNas(
  id: string,
  lang: Locale,
): Promise<Nas | undefined> {
  const nas = await readNas(id, lang);
  return nas ? followed([nas])[0] : undefined;
}

async function readNas(id: string, lang: Locale): Promise<Nas | undefined> {
  const agents = loadAgents();
  await connection();
  const agent = agents.find((a) => a.id === id);
  if (agent) return (await readFleet([agent], lang))[0];
  const bz = beszel();
  if (id.startsWith("bz-") && bz) {
    const fleet = await readFleet(agents, lang);
    const found = fleet.find((n) => n.id === id);
    if (found) return found;
    const systems = await bz.systems();
    return systems.ok
      ? undefined
      : unreadableBeszelNas(id, systems.reason, lang);
  }
  return withDemo(agents)
    ? demoFleet(
        agents.map((a) => a.id),
        lang,
      ).find((n) => n.id === id)
    : undefined;
}

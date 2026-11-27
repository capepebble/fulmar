import "server-only";

import { type Locale, tr } from "@/i18n";
import type { Nas } from "@/lib/fleet/types";
import { memory } from "@/lib/store/memory";
import { ReadCache } from "./cache";
import { agentToken, tokenSource } from "./config";
import { readPath } from "./fetch";
import { forgetHistory, readHistory } from "./history";
import { mapNas, offlineNas } from "./map";
import { consoleTimeZone } from "./time";
import {
  type AgentConfig,
  type AgentReads,
  READ_PATHS,
  type ReadKey,
} from "./types";

// Lecture à la demande : toutes les opérations d'un NAS en parallèle, gardées 30 s en mémoire
// du serveur ; « Relire » les oublie. Le suivi en continu viendra avec le hub. L'historique
// des constantes passe par sa propre mémoire (`history.ts`), que les courbes relisent.

// 30 s de vie ; « Relire » n'oublie que les lectures d'au moins 5 s.
const cache = new ReadCache<Nas>({ ttlMs: 30_000, minForgetMs: 5_000 });

async function readAgent(agent: AgentConfig, lang: Locale): Promise<Nas> {
  const token = agentToken(agent);
  if (!token)
    return remember(
      offlineNas(
        agent,
        tr(lang, {
          en: `token missing (${tokenSource(agent)})`,
          fr: `jeton absent (${tokenSource(agent)})`,
        }),
        "denied",
        lang,
      ),
    );
  const keys = Object.keys(READ_PATHS) as ReadKey[];
  const results = await Promise.all(
    keys.map((key) =>
      key === "metrics.history"
        ? readHistory(agent, "24h", token)
        : readPath(agent, token, READ_PATHS[key], "GET", lang),
    ),
  );
  const reads = Object.fromEntries(
    keys.map((key, i) => [key, results[i]]),
  ) as AgentReads;
  return remember(mapNas(agent, reads, new Date(), consoleTimeZone(), lang));
}

/** Le nom lu dans DSM, pour les NAS nommés comme DSM les nomme (agent du projet, NAS ajoutés
 * au hub) : le titre de l'onglet le donne sans rien relire. */
const names = new Map<string, string>();

export function readName(nasId: string): string | undefined {
  return names.get(nasId);
}

/** Après chaque lecture neuve : la mémoire note les états et la lecture réussie, puis donne
 * « vu le » de chaque point et la dernière lecture d'un agent muet. */
function remember(nas: Nas): Nas {
  const m = memory();
  if (nas.agent.kind === "ok") {
    names.set(nas.id, nas.name);
    m.observe(nas.id, nas.checks, nas.agent.readAt);
    m.agentRead(nas.id, nas.agent.readAt);
    const seen: Record<string, string> = {};
    for (const c of nas.checks) {
      if (c.status === "ok" || c.status === "unknown") continue;
      const at = m.seenSince(nas.id, c.id);
      if (at) seen[c.id] = at;
    }
    return { ...nas, seen };
  }
  if (nas.agent.kind === "down" || nas.agent.kind === "denied")
    return {
      ...nas,
      agent: { ...nas.agent, lastReadAt: m.lastAgentRead(nas.id) },
    };
  return nas;
}

/** Une lecture par langue : l'agent rend ses verdicts dans la langue demandée. */
export function loadNas(agent: AgentConfig, lang: Locale): Promise<Nas> {
  const key = `${lang}:${agent.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const nas = readAgent(agent, lang);
  cache.set(key, nas);
  return nas;
}

/** « Relire » : oublie les lectures assez anciennes, historiques compris ; la prochaine page
 * relit ces agents. */
export function forgetReads(): void {
  cache.forget();
  forgetHistory();
}

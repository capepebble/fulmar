import "server-only";

import { PERIODS, type Period } from "@/lib/fleet/series";
import { ReadCache } from "./cache";
import { agentToken, loadAgents, tokenSource } from "./config";
import { readPath } from "./fetch";
import type { AgentConfig, MetricsHistory, Read } from "./types";

// Historique des constantes tenu par chaque agent (`metrics.history`), lu à la demande et
// gardé 60 s (l'agent relève à la minute) : une lecture par agent et par période. Celle de
// 24 h part avec les autres lectures de l'agent ; « Relire » les oublie.

const cache = new ReadCache<Read<MetricsHistory>>({
  ttlMs: 60_000,
  minForgetMs: 5_000,
});

/** Adresse de l'historique d'une période : son palier, sur toute la période. */
export function historyPath(period: Period): string {
  const { tier, ms } = PERIODS[period];
  return `/metrics/history?tier=${tier}&hours=${ms / 3_600_000}`;
}

export function readHistory(
  agent: AgentConfig,
  period: Period,
  token: string | undefined = agentToken(agent),
): Promise<Read<MetricsHistory>> {
  if (!token)
    return Promise.resolve({
      ok: false,
      reason: {
        en: `no token (${tokenSource(agent)})`,
        fr: `jeton absent (${tokenSource(agent)})`,
      },
    });
  const key = `${agent.id}|${agent.url}|${period}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const value = readPath(agent, token, historyPath(period)) as Promise<
    Read<MetricsHistory>
  >;
  cache.set(key, value);
  return value;
}

/** « Relire » : oublie les historiques assez anciens. */
export function forgetHistory(): void {
  cache.forget();
}

/** Ce que les courbes demandent : l'historique d'un NAS par son identifiant, `null` s'il
 * n'a pas d'agent dans agents.json. Remplaçable dans les tests. */
export interface HistoryReader {
  read(nasId: string, period: Period): Promise<Read<MetricsHistory>> | null;
}

export function agentHistory(): HistoryReader {
  return {
    read(nasId, period) {
      const agent = loadAgents().find((a) => a.id === nasId);
      return agent ? readHistory(agent, period) : null;
    },
  };
}

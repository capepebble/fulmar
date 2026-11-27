import "server-only";

import type { Texts } from "@/i18n";
import { ReadCache } from "@/lib/agents/cache";
import {
  type BeszelConfig,
  type BeszelDeps,
  BeszelError,
  BeszelSession,
  beszelConfig,
  downReason,
  ratePause,
  rateReason,
  statusReason,
  UNREADABLE,
} from "./session";
import type {
  BzContainerRecord,
  BzDetails,
  BzPage,
  BzSmart,
  BzStatsRecord,
  BzSystem,
  Tier,
} from "./types";

// Lectures de Beszel, côté serveur seulement : `GET /api/collections/<c>/records`, toutes les
// pages, 10 s au plus, réponses gardées 60 s (une entrée par adresse). Une lecture ratée rend
// `ok: false` et une raison en deux langues : la page s'affiche avec les données de l'agent.

export type BzResult<T> =
  | { ok: true; data: T; at: string }
  | { ok: false; reason: Texts };

export interface BeszelClient {
  systems(): Promise<BzResult<BzSystem[]>>;
  stats(
    systemIds: string[],
    tier: Tier,
    since: Date,
  ): Promise<BzResult<BzStatsRecord[]>>;
  smart(systemId: string): Promise<BzResult<BzSmart[]>>;
  details(systemId: string): Promise<BzResult<BzDetails | null>>;
  containers(systemId: string): Promise<BzResult<BzContainerRecord | null>>;
  /** « Relire » : oublie les lectures assez anciennes. */
  forget(): void;
}

const TIMEOUT_MS = 10_000;
const PER_PAGE = 500;
const MAX_PAGES = 20;
/** En deçà, un jeton vient d'être obtenu : une liste vide est vraie. */
const FRESH_TOKEN_MS = 30_000;

/** Identifiant PocketBase : lettres et chiffres seulement, rien d'autre n'entre dans un filtre. */
const SAFE_ID = /^[a-z0-9]+$/i;

/** « 2026-11-20 10:00:00.000Z », la forme des dates de PocketBase. */
function pbDate(d: Date): string {
  return d.toISOString().replace("T", " ");
}

function query(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function createBeszelClient(
  cfg: BeszelConfig,
  deps: BeszelDeps = {},
): BeszelClient {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const session = new BeszelSession(cfg, { fetch: fetchFn, now });
  const cache = new ReadCache<BzResult<unknown>>({
    ttlMs: 60_000,
    minForgetMs: 5_000,
  });

  async function get<T>(path: string): Promise<BzResult<T>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await session.token();
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof BeszelError ? error.texts : downReason(error),
        };
      }
      let response: Response;
      try {
        response = await fetchFn(`${cfg.url}${path}`, {
          headers: { Authorization: token, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (error) {
        return { ok: false, reason: downReason(error) };
      }
      if (response.status === 401) {
        session.invalidate();
        continue;
      }
      // Jeton valable, droits insuffisants : se reconnecter n'y changerait rien.
      if (response.status === 403)
        return {
          ok: false,
          reason: {
            en: "access refused by Beszel (rights of the console account)",
            fr: "accès refusé par Beszel (droits du compte de la console)",
          },
        };
      if (response.status === 429) {
        session.pause(ratePause(response));
        return {
          ok: false,
          reason: rateReason(session.pausedFor()),
        };
      }
      if (!response.ok)
        return { ok: false, reason: statusReason(response.status) };
      try {
        return {
          ok: true,
          data: (await response.json()) as T,
          at: new Date(now()).toISOString(),
        };
      } catch {
        return { ok: false, reason: UNREADABLE };
      }
    }
    return {
      ok: false,
      reason: { en: "access refused by Beszel", fr: "accès refusé par Beszel" },
    };
  }

  /** Tous les enregistrements d'une collection, page après page, gardés 60 s. */
  function records<T>(
    collection: string,
    params: Record<string, string | number>,
    onePage = false,
    fresh = false,
  ): Promise<BzResult<T[]>> {
    const key = `${collection}?${query(params)}${onePage ? "#1" : ""}`;
    const hit = fresh ? undefined : cache.get(key, now());
    if (hit) return hit as Promise<BzResult<T[]>>;
    const value = (async (): Promise<BzResult<T[]>> => {
      const all: T[] = [];
      let at = "";
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const r = await get<BzPage<T>>(
          `/api/collections/${collection}/records?${query({ page, perPage: PER_PAGE, ...params })}`,
        );
        if (!r.ok) return r;
        at = r.at;
        all.push(...(r.data.items ?? []));
        if (onePage || page >= (r.data.totalPages ?? 1)) break;
      }
      return { ok: true, data: all, at };
    })();
    cache.set(key, value, now());
    return value;
  }

  const bySystem = (id: string) => `system='${id}'`;
  const unsafe = {
    ok: false as const,
    reason: {
      en: "Beszel system badly named",
      fr: "système Beszel mal désigné",
    },
  };
  const first = <T>(r: BzResult<T[]>): BzResult<T | null> =>
    r.ok ? { ok: true, data: r.data[0] ?? null, at: r.at } : r;

  return {
    async systems() {
      const params = { sort: "name" };
      const r = await records<BzSystem>("systems", params);
      const age = session.tokenAge();
      if (!r.ok || r.data.length > 0 || age == null || age < FRESH_TOKEN_MS)
        return r;
      // PocketBase lit un jeton devenu invalide comme un invité, qui ne voit aucun système :
      // une liste vide avec un jeton ancien se vérifie par une reconnexion.
      session.invalidate();
      return records<BzSystem>("systems", params, false, true);
    },

    forget: () => cache.forget(now()),

    async stats(systemIds, tier, since) {
      const ids = systemIds.filter((id) => SAFE_ID.test(id));
      if (ids.length === 0)
        return { ok: true, data: [], at: new Date(now()).toISOString() };
      // À la minute près : une même page relue garde la même adresse, donc la même réponse.
      const from = new Date(Math.floor(since.getTime() / 60_000) * 60_000);
      const filter = `(type='${tier}' && created>='${pbDate(from)}') && (${ids.map(bySystem).join(" || ")})`;
      return records<BzStatsRecord>("system_stats", {
        sort: "created",
        filter,
      });
    },

    async smart(systemId) {
      if (!SAFE_ID.test(systemId)) return unsafe;
      return records<BzSmart>("smart_devices", { filter: bySystem(systemId) });
    },

    async details(systemId) {
      if (!SAFE_ID.test(systemId)) return unsafe;
      return first(
        await records<BzDetails>("system_details", {
          filter: bySystem(systemId),
        }),
      );
    },

    async containers(systemId) {
      if (!SAFE_ID.test(systemId)) return unsafe;
      return first(
        await records<BzContainerRecord>(
          "container_stats",
          { sort: "-created", filter: bySystem(systemId), perPage: 1 },
          true,
        ),
      );
    },
  };
}

let instance: BeszelClient | null | undefined;

/** Le client de la console, unique ; `null` sans configuration de Beszel. */
export function beszel(): BeszelClient | null {
  if (instance === undefined) {
    const cfg = beszelConfig();
    instance = cfg ? createBeszelClient(cfg) : null;
  }
  return instance;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { mapNas, offlineNas } from "@/lib/agents/map";
import {
  type AgentConfig,
  type AgentReads,
  READ_PATHS,
  type ReadKey,
} from "@/lib/agents/types";
import type { BzSystem } from "@/lib/beszel/types";
import { composeFleet, unreadableBeszelNas } from "./compose";
import { nasState } from "./state";

const AGENTS_DIR = join(__dirname, "..", "agents", "__fixtures__", "essai");
const BZ_DIR = join(__dirname, "..", "beszel", "__fixtures__", "essai");

function reads(): AgentReads {
  return Object.fromEntries(
    (Object.keys(READ_PATHS) as ReadKey[]).map((k) => {
      const file = `${READ_PATHS[k].slice(1).replace(/[/?=&]/g, "_")}.json`;
      const env = JSON.parse(readFileSync(join(AGENTS_DIR, file), "utf8"));
      return [k, { ok: true, fetchedAt: env.fetched_at, data: env.data }];
    }),
  ) as AgentReads;
}

const SYSTEM: BzSystem = JSON.parse(
  readFileSync(join(BZ_DIR, "systems.json"), "utf8"),
).items[0];
const NOW = new Date("2026-11-21T09:10:00Z");
const AT = "2026-11-21T09:10:00.000Z";

const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "essai",
  name: "NAS d'essai",
  place: "Salon",
  url: "http://127.0.0.1:18765",
  tokenEnv: "T",
  beszelSystem: SYSTEM.id,
  ...over,
});

function compose(
  a: AgentConfig,
  nas: ReturnType<typeof mapNas>,
  systems: Parameters<typeof composeFleet>[0]["systems"],
) {
  return composeFleet({
    agents: [a],
    agentNas: new Map([[a.id, nas]]),
    systems,
    latest: new Map(),
    lang: "fr",
  });
}

/** Un agent d'avant l'historique : `metrics.history` lui est inconnu (404). */
function readsWithoutHistory(): AgentReads {
  return {
    ...reads(),
    "metrics.history": {
      ok: false,
      status: 404,
      reason: {
        en: "404 : Opération inconnue : metrics.history",
        fr: "404 : Opération inconnue : metrics.history",
      },
    },
  };
}

describe("composition du parc", () => {
  test("l'agent tient son historique : ses constantes, pas celles de Beszel", () => {
    const readAt = new Date("2026-11-09T15:27:00Z");
    const [nas] = compose(
      agent(),
      mapNas(agent(), reads(), readAt, "Europe/Paris", "fr"),
      {
        ok: true,
        data: [SYSTEM],
        at: AT,
      },
    );
    expect(nas.agentHistory).toBe(true);
    expect(nas.vitals).toMatchObject({
      source: "agent",
      cpu: 9,
      ram: 24,
      temp: 40,
      netBps: 154646,
    });
    // Beszel reste branché : disques et conteneurs.
    expect(nas.beszel.kind).toBe("ok");
  });

  test("agent sans historique, Beszel répond : constantes de Beszel", () => {
    const [nas] = compose(
      agent(),
      mapNas(agent(), readsWithoutHistory(), NOW, "Europe/Paris", "fr"),
      {
        ok: true,
        data: [SYSTEM],
        at: AT,
      },
    );
    expect(nas.agentHistory).toBe(false);
    expect(nas.vitals).toMatchObject({
      source: "beszel",
      cpu: 1.06,
      ram: 43.71,
      temp: 35,
      netBps: 2051,
    });
    expect(nas.beszel).toEqual({
      kind: "ok",
      systemId: SYSTEM.id,
      lastAt: "2026-11-21T09:08:48.379Z",
    });
    expect(nas.agent.kind).toBe("ok");
    expect(nas.checks).toHaveLength(47);
  });

  test("Beszel seul : agent_down", () => {
    const a = agent();
    const [nas] = compose(a, offlineNas(a, "agent injoignable", "down", "fr"), {
      ok: true,
      data: [SYSTEM],
      at: AT,
    });
    expect(nasState(nas)).toBe("agent_down");
    expect(nas.vitals.source).toBe("beszel");
    expect(nas.vitals.uptime).toBe("3 j 2 h");
  });

  test("agent seul, Beszel en panne : constantes de l'agent, état des contrôles", () => {
    const a = agent();
    const [nas] = compose(a, mapNas(a, reads(), NOW, "Europe/Paris", "fr"), {
      ok: false,
      reason: { en: "Beszel injoignable", fr: "Beszel injoignable" },
    });
    expect(nas.vitals).toMatchObject({
      source: "agent",
      cpu: 9,
      ram: 24,
      netBps: null,
    });
    expect(nas.beszel).toEqual({
      kind: "down",
      systemId: SYSTEM.id,
      lastAt: null,
      reason: "Beszel injoignable",
      hub: true,
    });
    expect(nasState(nas)).toBe("failed");
  });

  test("Beszel non branché : beszel none, aucune courbe", () => {
    const a = agent();
    const [nas] = compose(
      a,
      mapNas(a, reads(), NOW, "Europe/Paris", "fr"),
      null,
    );
    expect(nas.beszel).toEqual({ kind: "none" });
    expect(nas.vitals.source).toBe("agent");
  });

  test("un NAS sans beszelSystem n'a pas de courbes, même si Beszel répond", () => {
    const a = agent({ beszelSystem: undefined });
    const fleet = compose(a, mapNas(a, reads(), NOW, "Europe/Paris", "fr"), {
      ok: true,
      data: [SYSTEM],
      at: AT,
    });
    expect(fleet[0].beszel).toEqual({ kind: "none" });
    // Le système, que personne ne désigne, entre en NAS « Sans agent ».
    expect(fleet).toHaveLength(2);
  });

  test("un système non désigné devient Sans agent", () => {
    const a = agent();
    const fleet = compose(a, mapNas(a, reads(), NOW, "Europe/Paris", "fr"), {
      ok: true,
      data: [
        SYSTEM,
        {
          id: "x2",
          name: "Grenier",
          status: "down",
          updated: "2026-11-21 06:00:00.000Z",
          info: {},
        },
        {
          id: "x1",
          name: "Cave",
          status: "up",
          updated: "2026-11-21 09:09:00.000Z",
          info: { cpu: 3, mp: 20, u: 3600 },
        },
      ],
      at: AT,
    });
    expect(fleet.map((n) => n.id)).toEqual(["essai", "bz-x1", "bz-x2"]);
    expect(fleet[1]).toMatchObject({
      id: "bz-x1",
      name: "Cave",
      agent: { kind: "none" },
    });
    expect(fleet[1].vitals).toMatchObject({
      source: "beszel",
      cpu: 3,
      ram: 20,
      uptime: "1 h 00",
    });
    expect(fleet[1].checks).toEqual([]);
    expect(nasState(fleet[1])).toBe("beszel_only");
    expect(nasState(fleet[2])).toBe("offline");
    expect(fleet[2].beszel).toMatchObject({
      kind: "down",
      lastAt: "2026-11-21T06:00:00.000Z",
    });
  });

  test("beszelSystem introuvable : missing, le NAS garde son agent", () => {
    const a = agent({ beszelSystem: "introuvable" });
    const fleet = compose(a, mapNas(a, reads(), NOW, "Europe/Paris", "fr"), {
      ok: true,
      data: [SYSTEM],
      at: AT,
    });
    expect(fleet[0].beszel).toEqual({
      kind: "missing",
      systemId: "introuvable",
    });
    expect(fleet[0].vitals.source).toBe("agent");
    expect(fleet[0].checks).toHaveLength(47);
    expect(nasState(fleet[0])).toBe("failed");
  });

  test("un 401 de l'agent donne Accès refusé, pas injoignable", () => {
    const a = agent();
    const denied = Object.fromEntries(
      (Object.keys(READ_PATHS) as ReadKey[]).map((k) => [
        k,
        {
          ok: false,
          status: 401,
          reason: { en: "401: unauthorized", fr: "401 : jeton refusé" },
        },
      ]),
    ) as AgentReads;
    const [nas] = compose(a, mapNas(a, denied, NOW, "Europe/Paris", "fr"), {
      ok: true,
      data: [SYSTEM],
      at: AT,
    });
    expect(nas.agent).toEqual({
      kind: "denied",
      reason: "401 : jeton refusé",
      lastReadAt: null,
    });
    expect(nasState(nas)).toBe("denied");
  });
});

describe("hub Beszel muet", () => {
  test("un NAS sans agent reste ouvrable, à l'état inconnu", () => {
    const nas = unreadableBeszelNas(
      "bz-x1",
      { en: "Beszel injoignable", fr: "Beszel injoignable" },
      "fr",
    );
    expect(nas).toMatchObject({
      id: "bz-x1",
      agent: { kind: "none" },
      beszel: {
        kind: "down",
        systemId: "x1",
        hub: true,
        reason: "Beszel injoignable",
      },
    });
    expect(nasState(nas)).toBe("unknown");
  });
});

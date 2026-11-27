import { beforeEach, describe, expect, test, vi } from "vitest";

// Ordre des appels : Next.js exige que la page soit déclarée « à la requête » (`connection()`)
// avant toute lecture qui prend l'heure, sans quoi il le signale à chaque rendu.
const order: string[] = [];
const AT = "2026-11-21T10:00:00Z";

vi.mock("next/server", () => ({
  connection: async () => {
    order.push("connection");
  },
}));

// Le client Beszel de chaque test : un hub muet par défaut.
const hub: {
  systems: () => Promise<unknown>;
  stats: (...a: unknown[]) => Promise<unknown>;
} = {
  systems: async () => ({
    ok: false,
    reason: { en: "silent hub", fr: "hub muet" },
  }),
  stats: async () => ({ ok: true, data: [], at: AT }),
};

vi.mock("@/lib/beszel/client", () => ({
  beszel: () => ({
    systems: () => {
      order.push("systems");
      return hub.systems();
    },
    stats: (...args: unknown[]) => hub.stats(...args),
  }),
}));

// Aucun agent : le parc est fait des seuls systèmes de Beszel.
process.env.NAS_CONSOLE_AGENTS_FILE = "/nonexistent/agents.json";

const { beszelTrouble, getFleet } = await import("./index");

describe("beszelTrouble", () => {
  beforeEach(() => {
    order.length = 0;
  });

  test("déclare la lecture à la requête avant de lire Beszel", async () => {
    expect(await beszelTrouble("fr")).toBe("hub muet");
    expect(order).toEqual(["connection", "systems"]);
  });
});

describe("constantes du moment", () => {
  test("la température vient du dernier relevé, comme sa courbe, pas du capteur le plus chaud", async () => {
    const tiers: unknown[] = [];
    hub.systems = async () => ({
      ok: true,
      at: AT,
      data: [
        {
          id: "a1",
          name: "NAS",
          status: "up",
          updated: "2026-11-21 09:59:00.000Z",
          info: { cpu: 3, mp: 40, dt: 55 },
        },
      ],
    });
    hub.stats = async (ids, tier) => {
      tiers.push([ids, tier]);
      return {
        ok: true,
        at: AT,
        data: [
          {
            system: "a1",
            created: "2026-11-21 09:59:00.000Z",
            type: "1m",
            stats: {
              cpu: 2,
              mp: 41,
              t: { coretemp_package_id_0: 41, sata1: 55 },
            },
          },
        ],
      };
    };
    const fleet = await getFleet("fr");
    expect(fleet).toHaveLength(1);
    expect(fleet[0].vitals.temp).toBe(41);
    expect(fleet[0].vitals.cpu).toBe(2);
    expect(tiers).toEqual([[["a1"], "1m"]]);
  });
});

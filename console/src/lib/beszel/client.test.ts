import { describe, expect, test } from "vitest";
import { createBeszelClient } from "./client";

const CFG = { url: "http://hub", email: "lecture@example.org", password: "x" };
const T0 = Date.parse("2026-11-21T10:00:00Z");
const TOKEN = `e30.${Buffer.from(JSON.stringify({ exp: T0 / 1000 + 5 * 86_400 })).toString("base64url")}.sig`;

type Answer = (url: string) => Response;

function fakeHub(reads: Answer[]) {
  const urls: string[] = [];
  let auths = 0;
  const fetch = (async (url: string) => {
    if (url.includes("/auth-with-password")) {
      auths += 1;
      return new Response(JSON.stringify({ token: TOKEN }));
    }
    urls.push(url);
    const next = reads.shift();
    if (!next) throw new Error("lecture inattendue");
    return next(url);
  }) as unknown as typeof globalThis.fetch;
  return { urls, fetch, auths: () => auths };
}

const page =
  (items: unknown[], page = 1, totalPages = 1) =>
  () =>
    new Response(JSON.stringify({ page, totalPages, items }));

describe("client Beszel", () => {
  test("stats filtre le palier, la date et les systèmes", async () => {
    const hub = fakeHub([page([])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => T0 });
    const r = await c.stats(
      ["a", "b"],
      "20m",
      new Date("2026-11-20T10:00:00Z"),
    );
    expect(r.ok).toBe(true);
    expect(decodeURIComponent(hub.urls[0])).toContain(
      "filter=(type='20m' && created>='2026-11-20 10:00:00.000Z') && (system='a' || system='b')",
    );
    expect(hub.urls[0]).toContain("/api/collections/system_stats/records?");
  });

  test("toutes les pages sont lues", async () => {
    const hub = fakeHub([page([{ id: "a" }], 1, 2), page([{ id: "b" }], 2, 2)]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => T0 });
    const r = await c.systems();
    expect(r.ok && r.data.map((s) => s.id)).toEqual(["a", "b"]);
    expect(hub.urls[1]).toContain("page=2");
  });

  test("un 401 oublie le jeton et réessaie une fois", async () => {
    const denied = () => new Response("{}", { status: 401 });
    const hub = fakeHub([denied, page([{ id: "a" }])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => T0 });
    const r = await c.systems();
    expect(r.ok).toBe(true);
    expect(hub.auths()).toBe(2);

    const again = fakeHub([denied, denied]);
    const c2 = createBeszelClient(CFG, { fetch: again.fetch, now: () => T0 });
    const r2 = await c2.systems();
    expect(r2).toEqual({
      ok: false,
      reason: { en: "access refused by Beszel", fr: "accès refusé par Beszel" },
    });
    expect(again.urls).toHaveLength(2);
  });

  test("un 403 ne relance pas d'authentification : accès refusé", async () => {
    const forbidden = () => new Response("{}", { status: 403 });
    const hub = fakeHub([forbidden]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => T0 });
    expect(await c.systems()).toEqual({
      ok: false,
      reason: {
        en: "access refused by Beszel (rights of the console account)",
        fr: "accès refusé par Beszel (droits du compte de la console)",
      },
    });
    expect(hub.auths()).toBe(1);
    expect(hub.urls).toHaveLength(1);
  });

  test("liste des systèmes vide avec un jeton ancien : reconnexion et relecture", async () => {
    // PocketBase lit un jeton invalide comme un invité, qui ne voit aucun système.
    let t = T0;
    const hub = fakeHub([page([{ id: "a" }]), page([]), page([{ id: "a" }])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => t });
    expect((await c.systems()).ok).toBe(true);
    t += 120_000;
    const r = await c.systems();
    expect(r.ok && r.data.map((s) => s.id)).toEqual(["a"]);
    expect(hub.auths()).toBe(2);
  });

  test("liste des systèmes vide avec un jeton tout frais : pas de reconnexion", async () => {
    const hub = fakeHub([page([])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => T0 });
    const r = await c.systems();
    expect(r.ok && r.data).toEqual([]);
    expect(hub.auths()).toBe(1);
  });

  test("« Relire » oublie aussi les lectures de Beszel", async () => {
    let t = T0;
    const hub = fakeHub([page([{ id: "a" }]), page([{ id: "b" }])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => t });
    await c.systems();
    t += 10_000;
    c.forget();
    const r = await c.systems();
    expect(r.ok && r.data.map((s) => s.id)).toEqual(["b"]);
  });

  test("Beszel injoignable : ok false, raison en français", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = createBeszelClient(CFG, { fetch, now: () => T0 });
    const r = await c.systems();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason.fr).toMatch(/^Beszel injoignable/);
    expect(!r.ok && r.reason.en).toMatch(/^Beszel unreachable/);
  });

  test("une même lecture est gardée 60 s", async () => {
    let now = T0;
    const hub = fakeHub([page([{ id: "a" }]), page([{ id: "a" }])]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => now });
    await c.systems();
    now = T0 + 59_000;
    await c.systems();
    expect(hub.urls).toHaveLength(1);
    now = T0 + 61_000;
    await c.systems();
    expect(hub.urls).toHaveLength(2);
  });

  test("Beszel qui limite les requêtes : la page reste lisible, pas de nouvel essai", async () => {
    let now = T0;
    const hub = fakeHub([() => new Response("{}", { status: 429 })]);
    const c = createBeszelClient(CFG, { fetch: hub.fetch, now: () => now });
    const r = await c.systems();
    expect(r).toEqual({
      ok: false,
      reason: {
        en: "Beszel is limiting requests, next try in 60 s",
        fr: "Beszel limite les requêtes, nouvel essai dans 60 s",
      },
    });
    now = T0 + 30_000;
    const r2 = await c.stats(["a"], "1m", new Date(T0 - 3_600_000));
    expect(r2.ok).toBe(false);
    expect(hub.urls).toHaveLength(1);
    expect(hub.auths()).toBe(1);
  });
});

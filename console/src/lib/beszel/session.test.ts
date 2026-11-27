import { describe, expect, test } from "vitest";
import { BeszelError, BeszelSession, beszelConfig } from "./session";

const CFG = { url: "http://hub", email: "lecture@example.org", password: "x" };
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-21T10:00:00Z");

/** Jeton au format JWT, expiration `exp` en millisecondes. */
function jwt(exp: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(exp / 1000) }),
  ).toString("base64url");
  return `e30.${payload}.sig`;
}

function fakeHub(answers: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("appel inattendu");
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const ok = (token: string) => () =>
  new Response(JSON.stringify({ token }), { status: 200 });
const tooMany = (retryAfter?: number) => () =>
  new Response("{}", {
    status: 429,
    headers: retryAfter ? { "Retry-After": String(retryAfter) } : {},
  });

describe("configuration", () => {
  test("les trois variables sont requises", () => {
    expect(beszelConfig({ BESZEL_URL: "http://hub" })).toBeNull();
    expect(
      beszelConfig({
        BESZEL_URL: "http://hub/",
        BESZEL_EMAIL: "a@b.c",
        BESZEL_PASSWORD: "p",
      }),
    ).toEqual({ url: "http://hub", email: "a@b.c", password: "p" });
  });
});

describe("session", () => {
  test("une seule authentification pour trois appels simultanés", async () => {
    const hub = fakeHub([ok(jwt(T0 + 5 * DAY))]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => T0 });
    const tokens = await Promise.all([s.token(), s.token(), s.token()]);
    expect(new Set(tokens).size).toBe(1);
    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0].url).toBe(
      "http://hub/api/collections/users/auth-with-password",
    );
    expect(JSON.parse(String(hub.calls[0].init?.body))).toEqual({
      identity: CFG.email,
      password: CFG.password,
    });
  });

  test("renouvelle le jeton à moins d'un jour de son expiration", async () => {
    let now = T0;
    const first = jwt(T0 + 5 * DAY);
    const hub = fakeHub([ok(first), ok(jwt(T0 + 10 * DAY))]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => now });
    expect(await s.token()).toBe(first);
    now = T0 + 3 * DAY;
    expect(await s.token()).toBe(first);
    expect(hub.calls).toHaveLength(1);
    now = T0 + 4 * DAY + 60_000;
    expect(await s.token()).not.toBe(first);
    expect(hub.calls[1].url).toBe(
      "http://hub/api/collections/users/auth-refresh",
    );
    expect(new Headers(hub.calls[1].init?.headers).get("Authorization")).toBe(
      first,
    );
  });

  test("un jeton de courte durée n'est renouvelé qu'au dernier quart de sa vie", async () => {
    const HOUR = 3_600_000;
    let t = T0;
    const hub = fakeHub([ok(jwt(T0 + 2 * HOUR)), ok(jwt(T0 + 4 * HOUR))]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => t });
    await s.token();
    t = T0 + HOUR;
    await s.token();
    expect(hub.calls).toHaveLength(1);
    t = T0 + 100 * 60_000;
    await s.token();
    expect(hub.calls).toHaveLength(2);
    expect(hub.calls[1].url).toContain("auth-refresh");
  });

  test("après un 429, plus aucune tentative pendant 60 s", async () => {
    let now = T0;
    const hub = fakeHub([tooMany(), ok(jwt(T0 + 5 * DAY))]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => now });
    await expect(s.token()).rejects.toMatchObject({ kind: "rate" });
    now = T0 + 30_000;
    await expect(s.token()).rejects.toBeInstanceOf(BeszelError);
    expect(hub.calls).toHaveLength(1);
    now = T0 + 61_000;
    await expect(s.token()).resolves.toBeTypeOf("string");
    expect(hub.calls).toHaveLength(2);
  });

  test("Retry-After plus long que 60 s est respecté", async () => {
    let now = T0;
    const hub = fakeHub([tooMany(120), ok(jwt(T0 + 5 * DAY))]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => now });
    await expect(s.token()).rejects.toMatchObject({ kind: "rate" });
    now = T0 + 61_000;
    await expect(s.token()).rejects.toMatchObject({ kind: "rate" });
    expect(hub.calls).toHaveLength(1);
    now = T0 + 121_000;
    await expect(s.token()).resolves.toBeTypeOf("string");
  });

  test("identifiants refusés : erreur « auth »", async () => {
    const hub = fakeHub([() => new Response("{}", { status: 400 })]);
    const s = new BeszelSession(CFG, { fetch: hub.fetch, now: () => T0 });
    await expect(s.token()).rejects.toMatchObject({ kind: "auth" });
  });

  test("hub injoignable : erreur « down »", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const s = new BeszelSession(CFG, { fetch, now: () => T0 });
    await expect(s.token()).rejects.toMatchObject({ kind: "down" });
  });
});

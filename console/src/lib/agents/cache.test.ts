import { describe, expect, it } from "vitest";
import { ReadCache } from "./cache";

describe("ReadCache", () => {
  it("garde une lecture pendant sa durée de vie", () => {
    const cache = new ReadCache<string>({ ttlMs: 30_000, minForgetMs: 5_000 });
    cache.set("essai", Promise.resolve("a"), 0);
    expect(cache.get("essai", 29_999)).toBeDefined();
    expect(cache.get("essai", 30_000)).toBeUndefined();
  });

  it("« Relire » n'oublie que les lectures assez anciennes : pas d'amplification", () => {
    const cache = new ReadCache<string>({ ttlMs: 30_000, minForgetMs: 5_000 });
    cache.set("ancien", Promise.resolve("a"), 0);
    cache.set("recent", Promise.resolve("b"), 8_000);
    cache.forget(10_000);
    expect(cache.get("ancien", 10_000)).toBeUndefined();
    expect(cache.get("recent", 10_000)).toBeDefined();
    // Des « Relire » répétés ne relancent pas de lecture tant que la dernière est fraîche.
    cache.forget(10_001);
    cache.forget(10_002);
    expect(cache.get("recent", 10_002)).toBeDefined();
  });

  it("oublie une lecture ratée", async () => {
    const cache = new ReadCache<string>({ ttlMs: 30_000, minForgetMs: 5_000 });
    const failing = Promise.reject(new Error("panne"));
    cache.set("essai", failing, 0);
    await failing.catch(() => undefined);
    await Promise.resolve();
    expect(cache.get("essai", 1)).toBeUndefined();
  });
});

describe("mémoire bornée", () => {
  it("les lectures périmées sont retirées, la mémoire ne grandit pas", () => {
    const cache = new ReadCache<number>({ ttlMs: 60_000, minForgetMs: 5_000 });
    for (let minute = 0; minute < 100; minute += 1)
      cache.set(
        `stats?since=${minute}`,
        Promise.resolve(minute),
        minute * 60_000,
      );
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});

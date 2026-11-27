import { describe, expect, it } from "vitest";
import { Throttle } from "./throttle";

describe("essais de connexion", () => {
  it("cinq échecs en quinze minutes, puis attente", () => {
    const t = new Throttle(5, 15 * 60_000);
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) t.fail("192.168.1.20", now + i);
    expect(t.blocked("192.168.1.20", now + 10)).toBe(false);
    t.fail("192.168.1.20", now + 11);
    expect(t.blocked("192.168.1.20", now + 12)).toBe(true);
    expect(t.blocked("192.168.1.21", now + 12)).toBe(false);
    expect(t.blocked("192.168.1.20", now + 15 * 60_000 + 20)).toBe(false);
  });

  it("une connexion réussie efface les échecs", () => {
    const t = new Throttle(2, 60_000);
    t.fail("a", 1);
    t.reset("a");
    t.fail("a", 2);
    expect(t.blocked("a", 3)).toBe(false);
  });
});

import { LoginAttempts } from "./throttle";

describe("essais de connexion, tous appareils confondus", () => {
  it("vingt échecs d'où que ce soit, et tout le monde attend", () => {
    const attempts = new LoginAttempts();
    for (let i = 0; i < 19; i++) attempts.fail(`10.0.0.${i}`, 1000 + i);
    expect(attempts.blocked("192.168.1.20", 1100)).toBe(false);
    attempts.fail("10.0.1.1", 1101);
    // Une adresse inventée à chaque essai ne suffit pas à passer.
    expect(attempts.blocked("192.168.1.20", 1102)).toBe(true);
  });

  it("une adresse seule attend après cinq échecs", () => {
    const attempts = new LoginAttempts();
    for (let i = 0; i < 5; i++) attempts.fail("a", i);
    expect(attempts.blocked("a", 10)).toBe(true);
    expect(attempts.blocked("b", 10)).toBe(false);
  });
});

describe("essais simultanés", () => {
  it("chaque essai est compté avant la vérification, et rendu s'il réussit", () => {
    const attempts = new LoginAttempts();
    // Cinq essais lancés ensemble : le sixième attend, avant même la fin des vérifications.
    const tickets = Array.from({ length: 5 }, (_, i) => attempts.begin("a", i));
    expect(tickets.every((t) => t !== null)).toBe(true);
    expect(attempts.begin("a", 6)).toBeNull();
    // Un essai qui réussit rend sa place.
    attempts.success("a", tickets[0] as number);
    expect(attempts.begin("a", 7)).not.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_S, signSession, verifySession } from "./session";

const key = Buffer.alloc(32, 7);
const now = Date.UTC(2026, 10, 25, 9, 0, 0);

describe("session signée", () => {
  it("se vérifie avec sa clé, jusqu'à son échéance", () => {
    const value = signSession(key, now);
    expect(verifySession(key, value, now)).toBe(true);
    expect(
      verifySession(key, value, now + (SESSION_MAX_AGE_S - 60) * 1000),
    ).toBe(true);
    expect(
      verifySession(key, value, now + (SESSION_MAX_AGE_S + 1) * 1000),
    ).toBe(false);
  });

  it("tombe quand la clé change (mot de passe changé)", () => {
    const value = signSession(key, now);
    expect(verifySession(Buffer.alloc(32, 8), value, now)).toBe(false);
  });

  it("refuse une session retouchée ou absente", () => {
    const value = signSession(key, now);
    const [v, exp, nonce, mac] = value.split(".");
    const later = `${v}.${Number(exp) + 999999}.${nonce}.${mac}`;
    expect(verifySession(key, later, now)).toBe(false);
    expect(verifySession(key, `${value}x`, now)).toBe(false);
    expect(verifySession(key, "", now)).toBe(false);
    expect(verifySession(key, undefined, now)).toBe(false);
    expect(verifySession(key, "v1.1.2", now)).toBe(false);
  });

  it("n'est jamais deux fois la même", () => {
    expect(signSession(key, now)).not.toBe(signSession(key, now));
  });
});

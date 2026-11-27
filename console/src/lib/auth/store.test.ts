import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStore, formatInstallCode } from "./store";

function fresh(): { dir: string; store: AuthStore } {
  const dir = mkdtempSync(join(tmpdir(), "auth-"));
  return { dir, store: new AuthStore(dir) };
}

describe("compte de la console", () => {
  it("se crée une seule fois, en fichier privé", async () => {
    const { dir, store } = fresh();
    expect(store.hasAccount()).toBe(false);
    await store.createAccount("un mot de passe solide");
    expect(store.hasAccount()).toBe(true);
    expect(statSync(join(dir, "account.json")).mode & 0o777).toBe(0o600);
    await expect(
      store.createAccount("un autre mot de passe"),
    ).rejects.toThrow();
    expect(await store.checkPassword("un mot de passe solide")).toBe(true);
    expect(await store.checkPassword("un autre mot de passe")).toBe(false);
  });

  it("change de clé de session avec le mot de passe", async () => {
    const { store } = fresh();
    await store.createAccount("un mot de passe solide");
    const before = store.sessionKey();
    expect(store.sessionKey().equals(before)).toBe(true);
    await store.changePassword("un nouveau mot de passe");
    expect(store.sessionKey().equals(before)).toBe(false);
    expect(await store.checkPassword("un nouveau mot de passe")).toBe(true);
  });

  it("garde sa clé de session dans un fichier privé", () => {
    const { dir, store } = fresh();
    expect(store.sessionKey()).toHaveLength(32);
    expect(statSync(join(dir, "session.key")).mode & 0o777).toBe(0o600);
  });
});

describe("code d'installation", () => {
  it("dix chiffres, stables jusqu'à leur emploi, qui ne servent qu'une fois", () => {
    const { dir, store } = fresh();
    const code = store.installCode() ?? "";
    expect(code).toMatch(/^\d{10}$/);
    expect(store.installCode()).toBe(code);
    expect(statSync(join(dir, "install-code")).mode & 0o777).toBe(0o600);
    expect(store.consumeInstallCode("0000000000")).toBe(code === "0000000000");
    expect(store.consumeInstallCode(formatInstallCode(code))).toBe(true);
    expect(store.consumeInstallCode(code)).toBe(false);
    expect(readdirSync(dir)).not.toContain("install-code");
  });

  it("n'existe plus une fois le compte créé", async () => {
    const { store } = fresh();
    await store.createAccount("un mot de passe solide");
    expect(store.installCode()).toBeNull();
  });

  it("s'écrit en deux groupes et se relit avec ou sans espaces", () => {
    expect(formatInstallCode("1234567890")).toBe("12345 67890");
  });
});

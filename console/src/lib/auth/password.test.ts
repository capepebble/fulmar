import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "./password";

describe("mot de passe", () => {
  it("se vérifie par son empreinte scrypt, jamais en clair", async () => {
    const stored = await hashPassword("un mot de passe solide");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain("solide");
    expect(await verifyPassword("un mot de passe solide", stored)).toBe(true);
    expect(await verifyPassword("un mot de passe faux!", stored)).toBe(false);
  });

  it("refuse une empreinte illisible sans lever", async () => {
    expect(await verifyPassword("x", "n'importe quoi")).toBe(false);
  });

  it("exige douze caractères et la même saisie deux fois", () => {
    expect(passwordProblem("court", "court")?.fr).toMatch(/12 caractères/);
    expect(passwordProblem("court", "court")?.en).toMatch(/12 characters/);
    expect(passwordProblem("assez long ici", "assez long là")?.fr).toMatch(
      /identiques/,
    );
    expect(passwordProblem("assez long ici", "assez long ici")).toBeNull();
  });
});

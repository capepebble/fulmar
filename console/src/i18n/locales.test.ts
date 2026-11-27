import { describe, expect, it } from "vitest";
import { fromAcceptLanguage, pickLocale, splitLocale } from "./locales";

describe("langue de la console", () => {
  it("suit le cookie, puis le navigateur, puis l'anglais", () => {
    expect(pickLocale("fr", "en-US")).toBe("fr");
    expect(pickLocale("de", "fr-FR,fr;q=0.9")).toBe("fr");
    expect(pickLocale(undefined, "de-DE,en;q=0.5")).toBe("en");
    expect(pickLocale(undefined, "es")).toBe("en");
    expect(pickLocale(null, null)).toBe("en");
  });

  it("lit les poids de l'en-tête", () => {
    expect(fromAcceptLanguage("de-DE,fr;q=0.5,en;q=0.7")).toBe("en");
    expect(fromAcceptLanguage("de-DE,fr;q=0.5")).toBe("fr");
    expect(fromAcceptLanguage("fr;q=0")).toBeNull();
    expect(fromAcceptLanguage("fr-CA")).toBe("fr");
  });

  it("sépare la langue d'une adresse préfixée", () => {
    expect(splitLocale("/fr/nas/essai")).toEqual({
      locale: "fr",
      rest: "/nas/essai",
    });
    expect(splitLocale("/en")).toEqual({ locale: "en", rest: "/" });
    expect(splitLocale("/nas/essai")).toBeNull();
    expect(splitLocale("/de/nas")).toBeNull();
  });
});

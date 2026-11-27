import { describe, expect, it } from "vitest";
import { agentProblem } from "./problems";

describe("refus de l'API d'un agent", () => {
  it("garde le code en anglais et le traduit en français", () => {
    expect(agentProblem(403, "forbidden")).toEqual({
      en: "403: forbidden",
      fr: "403 : droit manquant",
    });
    expect(agentProblem(503, "dsm_unreachable")).toEqual({
      en: "503: dsm unreachable",
      fr: "503 : DSM ne répond pas",
    });
  });

  it("montre un code inconnu tel quel, dans les deux langues", () => {
    expect(agentProblem(418, "teapot_mode")).toEqual({
      en: "418: teapot mode",
      fr: "418 : teapot mode",
    });
  });

  it("traduit chaque refus que le moteur de l'agent peut rendre", () => {
    for (const code of [
      "unauthorized",
      "rate_limited",
      "not_found",
      "invalid_params",
      "unsupported",
      "dsm_certificate",
      "dsm_error",
      "internal",
      "not_configured",
    ]) {
      expect(agentProblem(400, code).fr).not.toContain("_");
      expect(agentProblem(400, code).fr).not.toBe(`400 : ${code}`);
    }
  });
});

import { describe, expect, it } from "vitest";
import { setupProblem } from "./setup-errors";

const at = { host: "172.29.54.1", port: 5001 };

describe("erreurs de l'enrôlement", () => {
  it("traduit un refus de DSM par son code", () => {
    const texts = setupProblem(
      { status: 400, code: "login_failed", dsm_code: 400, detail: "…" },
      at,
    );
    expect(texts.en).toBe(
      "DSM refused the sign-in: unknown account or wrong password.",
    );
    expect(texts.fr).toBe(
      "Connexion refusée par DSM : compte inconnu ou mot de passe faux.",
    );
  });

  it("garde un motif générique pour un code de DSM inconnu", () => {
    const texts = setupProblem(
      { status: 400, code: "login_failed", dsm_code: 499 },
      at,
    );
    expect(texts.en).toBe("DSM refused the sign-in: no known reason.");
  });

  it("nomme l'adresse quand DSM ne répond pas", () => {
    const texts = setupProblem({ status: 502, code: "dsm_unreachable" }, at);
    expect(texts.en).toBe(
      "DSM does not answer over HTTPS at 172.29.54.1:5001.",
    );
  });

  it("garde le texte de l'agent, en anglais, pour un code inconnu", () => {
    const texts = setupProblem(
      { status: 418, code: "teapot", detail: "I am a teapot." },
      at,
    );
    expect(texts.en).toBe("I am a teapot.");
    expect(texts.fr).toBe("L'agent a refusé cette demande (418).");
  });

  it("n'affiche jamais un corps qui n'est pas un texte", () => {
    const texts = setupProblem({ status: 500, detail: { x: 1 } }, at);
    expect(texts.en).toBe("The agent refused this request (500).");
    expect(texts.fr).toBe("L'agent a refusé cette demande (500).");
  });

  it("dit les refus du parc du hub", () => {
    expect(setupProblem({ status: 409, code: "already_followed" }, at).fr).toBe(
      "Ce NAS est déjà dans le parc.",
    );
    expect(setupProblem({ status: 409, code: "fleet_full" }, at).en).toMatch(
      /NAS_AGENT_FLEET_MAX/,
    );
    expect(setupProblem({ status: 404, code: "not_found" }, at).en).toBe(
      "This hub does not follow this NAS.",
    );
    // Adresse refusée par l'agent (validation de la requête) : sans le détail technique.
    expect(
      setupProblem({ status: 422, detail: [{ loc: ["body", "host"] }] }, at).fr,
    ).toBe("L'adresse ou le nom du certificat n'est pas valide.");
  });
});

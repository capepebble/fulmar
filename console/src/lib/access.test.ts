import { describe, expect, it } from "vitest";
import { accessDecision } from "./access";

// En-têtes d'une requête directe au poste local, tels que Next.js les complète lui-même.
const local = {
  host: "127.0.0.1:3410",
  login: null,
  forwarded: null,
  forwardedFor: "127.0.0.1",
  allowlist: [],
  hosts: [],
  production: false,
  localOnly: false,
};

describe("accessDecision sans liste d'identités", () => {
  it("laisse passer le poste local en développement", () => {
    expect(accessDecision(local)).toEqual({ allowed: true });
    expect(accessDecision({ ...local, host: "localhost:3410" })).toEqual({
      allowed: true,
    });
    expect(
      accessDecision({ ...local, host: "[::1]:3410", forwardedFor: "::1" }),
    ).toEqual({ allowed: true });
  });

  it("refuse un autre nom d'hôte", () => {
    expect(
      accessDecision({ ...local, host: "nas-console.tailnet.ts.net" }).allowed,
    ).toBe(false);
  });

  it("refuse un Host local forgé derrière tailscale serve (identité ajoutée par Serve)", () => {
    expect(accessDecision({ ...local, login: "quelquun@github" }).allowed).toBe(
      false,
    );
  });

  it("refuse un Host local forgé quand une adresse du tailnet a relayé la requête", () => {
    expect(
      accessDecision({ ...local, forwardedFor: "100.101.102.103, 127.0.0.1" })
        .allowed,
    ).toBe(false);
    expect(
      accessDecision({ ...local, forwarded: "for=100.101.102.103" }).allowed,
    ).toBe(false);
  });

  it("en production, refuse tout sans liste, sauf ouverture locale explicite", () => {
    expect(accessDecision({ ...local, production: true }).allowed).toBe(false);
    expect(
      accessDecision({ ...local, production: true, localOnly: true }),
    ).toEqual({ allowed: true });
    expect(
      accessDecision({
        ...local,
        production: true,
        localOnly: true,
        login: "x@github",
      }).allowed,
    ).toBe(false);
  });
});

describe("accessDecision avec une liste d'identités", () => {
  const allowlist = ["proprietaire@github"];
  const host = "nas-console.tailnet.ts.net";
  const hosts = [host];

  it("n'admet que les identités Tailscale de la liste, en production comme en développement", () => {
    for (const production of [false, true]) {
      const base = { ...local, host, allowlist, hosts, production };
      expect(accessDecision({ ...base, login: "proprietaire@github" })).toEqual(
        {
          allowed: true,
        },
      );
      expect(accessDecision({ ...base, login: "PROPRIETAIRE@github" })).toEqual(
        {
          allowed: true,
        },
      );
      expect(accessDecision({ ...base, login: "autre@github" }).allowed).toBe(
        false,
      );
      expect(accessDecision({ ...base, login: null }).allowed).toBe(false);
    }
  });

  it("le poste local doit aussi présenter une identité admise", () => {
    expect(accessDecision({ ...local, allowlist, hosts }).allowed).toBe(false);
  });

  // Une page piégée qui fait pointer son propre nom sur 127.0.0.1 (DNS rebinding) envoie ses
  // requêtes en « même origine » : elle peut y ajouter Tailscale-User-Login, mais le navigateur
  // garde son nom à elle dans Host. Seul le nom publié par tailscale serve entre.
  it("refuse une identité admise arrivée sous un autre nom (DNS rebinding)", () => {
    const login = "proprietaire@github";
    for (const forged of ["piege.example:3411", "127.0.0.1:3411", null]) {
      expect(
        accessDecision({ ...local, host: forged, login, allowlist, hosts })
          .allowed,
      ).toBe(false);
    }
  });

  it("admet le nom publié, avec ou sans port 443 ni point final, quelle que soit la casse", () => {
    const login = "proprietaire@github";
    for (const named of [
      "nas-console.tailnet.ts.net",
      "NAS-Console.tailnet.ts.net:443",
      "nas-console.tailnet.ts.net.",
    ]) {
      expect(
        accessDecision({ ...local, host: named, login, allowlist, hosts }),
      ).toEqual({ allowed: true });
    }
  });

  it("refuse tout si la liste des noms admis manque", () => {
    expect(
      accessDecision({
        ...local,
        host,
        login: "proprietaire@github",
        allowlist,
      }).allowed,
    ).toBe(false);
  });
});

import { passwordAccess } from "./access";

describe("passwordAccess, la console du projet", () => {
  const base = {
    path: "/",
    method: "GET",
    hasAccount: true,
    session: false,
  };

  it("sans compte, tout mène à la bienvenue", () => {
    expect(passwordAccess({ ...base, hasAccount: false })).toEqual({
      action: "redirect",
      to: "/welcome",
    });
    expect(
      passwordAccess({ ...base, hasAccount: false, path: "/welcome" }),
    ).toEqual({ action: "next" });
    expect(
      passwordAccess({ ...base, hasAccount: false, path: "/sign-in" }),
    ).toEqual({ action: "redirect", to: "/welcome" });
  });

  it("avec un compte et sans session, la connexion, en gardant la page voulue", () => {
    expect(passwordAccess({ ...base, path: "/nas/local/checks" })).toEqual({
      action: "redirect",
      to: "/sign-in?next=%2Fnas%2Flocal%2Fchecks",
    });
    expect(passwordAccess({ ...base, path: "/sign-in" })).toEqual({
      action: "next",
    });
    expect(passwordAccess({ ...base, path: "/welcome" })).toEqual({
      action: "redirect",
      to: "/sign-in",
    });
  });

  it("refuse une action serveur sans session au lieu de rediriger", () => {
    expect(passwordAccess({ ...base, method: "POST", path: "/" })).toEqual({
      action: "deny",
      status: 401,
      reason: { en: "sign-in required", fr: "connexion requise" },
    });
  });

  it("avec une session, tout s'ouvre, et la connexion renvoie au parc", () => {
    const signed = { ...base, session: true };
    expect(passwordAccess({ ...signed, path: "/nas/local" })).toEqual({
      action: "next",
    });
    expect(passwordAccess({ ...signed, path: "/sign-in" })).toEqual({
      action: "redirect",
      to: "/",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  accessError,
  accountPhrase,
  demoAccess,
  mapAccess,
  mapDetached,
  rightsWords,
  scopeWords,
  tokenName,
} from "./access";

// La forme de agent.access (conception 2026-11-26-carte-sur-table), telle que la rend l'agent
// au jeton de la console du projet.
const ACCESS = {
  agent_version: "0.9.0",
  dsm: { host: "172.17.0.1", port: 5001, tls_mode: "pin", account: "fulmar" },
  reads: { "system:read": 12, "storage:read": 6, "backup:read": 4 },
  writes: [
    {
      op: "packages.update",
      scope: "packages:update",
      title: "Packages: update",
    },
    { op: "dsm.update_run", scope: "dsm:update", title: "DSM: update" },
    {
      op: "updates.schedule",
      scope: "packages:update",
      title: "Updates: schedule",
    },
  ],
  tokens: [
    {
      id: "abcd1234",
      label: "console-projet",
      scopes: ["dsm:update", "packages:update", "system:read"],
      networks: ["172.29.54.0/24"],
      created_at: "2026-11-20T10:00:00+00:00",
      expires_at: "2027-11-20T10:00:00+00:00",
      last_used_at: "2026-11-26T09:58:00+00:00",
      changes_dsm: true,
    },
    {
      id: "efgh5678",
      label: "claude-mcp\u0007",
      scopes: ["system:read"],
      networks: [],
      created_at: "2026-11-21T10:00:00+00:00",
      expires_at: "2027-02-19T10:00:00+00:00",
      last_used_at: null,
      changes_dsm: false,
    },
    { id: "bad", label: "x" },
  ],
  tokens_others: 0,
  phones: 2,
  outbound: [
    { to: "www.synology.com", why: "synology_advisories" },
    { to: "api.nasrelay.com", why: "phones_relay" },
    { to: "evil.example", why: "exfiltrate" },
  ],
  fleet_members: 0,
  can_detach: true,
  journal_ok: true,
  journal_all: true,
  journal: [
    {
      ts: "2026-11-26T09:58:00+00:00",
      channel: "rest",
      op: "system.info",
      outcome: "ok",
      token: "console-projet",
    },
    { ts: "2026-11-26T09:57:00+00:00", channel: "?", outcome: "nope" },
  ],
};

describe("mapAccess", () => {
  it("reads the table and drops what it does not recognise", () => {
    const view = mapAccess(ACCESS);
    expect(view.dsm).toEqual({
      host: "172.17.0.1",
      port: 5001,
      pinned: true,
      account: "fulmar",
    });
    expect(view.reads).toEqual([
      { scope: "system:read", count: 12 },
      { scope: "storage:read", count: 6 },
      { scope: "backup:read", count: 4 },
    ]);
    expect(view.writes.map((w) => w.scope)).toEqual([
      "packages:update",
      "dsm:update",
    ]);
    expect(view.tokens.map((t) => t.id)).toEqual(["abcd1234", "efgh5678"]);
    // Un nom venu de l'agent : une donnée, ses caractères de contrôle effacés.
    expect(view.tokens[1].label).toBe("claude-mcp");
    expect(view.tokens[0].isConsole).toBe(true);
    expect(view.outbound).toEqual([
      { to: "www.synology.com", why: "synology_advisories" },
      { to: "api.nasrelay.com", why: "phones_relay" },
    ]);
    expect(view.phones).toBe(2);
    expect(view.fleetMembers).toBe(0);
    expect(view.canDetach).toBe(true);
    expect(view.journal).toHaveLength(1);
    expect(view.journal[0]).toMatchObject({ op: "system.info", outcome: "ok" });
  });

  it("never offers detaching on a doubtful answer", () => {
    const view = mapAccess({ ...ACCESS, can_detach: "yes" });
    expect(view.canDetach).toBe(false);
    expect(mapAccess(null).tokens).toEqual([]);
    expect(mapAccess(null).fleetMembers).toBeNull();
  });
});

describe("words", () => {
  it("says each right and each token plainly", () => {
    expect(scopeWords("dsm:update", "fr")).toBe("mettre à jour DSM");
    expect(scopeWords("packages:update", "en")).toBe("update packages");
    expect(scopeWords("made:up", "fr")).toBe("made:up");
    expect(tokenName("console-projet", "fr")).toBe("Console du projet");
    expect(tokenName("claude-mcp", "fr")).toBe("claude-mcp");
    expect(
      rightsWords(["audit:checks", "system:read", "dsm:update"], "fr"),
    ).toBe("lit contrôles, système · peut mettre à jour DSM");
    expect(accountPhrase("fulmar", "fr")).toBe("le compte « fulmar »");
    expect(accountPhrase(null, "en")).toBe("Fulmar’s service account");
  });

  it("explains an old agent and a missing right", () => {
    expect(accessError(404, "x", "fr").kind).toBe("old");
    expect(accessError(403, "x", "fr").kind).toBe("denied");
    expect(accessError(undefined, "injoignable", "fr")).toEqual({
      kind: "down",
      reason: "injoignable",
    });
  });
});

describe("mapDetached", () => {
  it("reads what the agent undid", () => {
    expect(
      mapDetached({
        phones_removed: 2,
        tokens_revoked: 1,
        credentials_removed: true,
        restarting: true,
      }),
    ).toEqual({
      phonesRemoved: 2,
      tokensRevoked: 1,
      credentialsRemoved: true,
      restarting: true,
    });
    expect(mapDetached({ phones_removed: "2" })).toBeNull();
  });
});

describe("demoAccess", () => {
  it("is an example without any gesture", () => {
    const view = demoAccess("fr");
    expect(view.canDetach).toBe(false);
    expect(view.dsm.account).toBe("fulmar");
    expect(view.tokens.length).toBeGreaterThan(0);
  });
});

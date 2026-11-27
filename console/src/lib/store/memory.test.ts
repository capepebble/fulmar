import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Memory, openMemory } from "./memory";

let dir: string;
let file: string;
let m: Memory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nas-console-memory-"));
  file = join(dir, "memory.sqlite");
  m = openMemory(file);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("mémoire de la console", () => {
  test("le suivi choisi : un contrôle qu'on ne suit plus, sur un NAS ou partout", () => {
    expect(m.unfollowed()).toEqual([]);
    m.setFollow("essai", "ups.configured", false);
    m.setFollow("*", "shares.recycle_bin", false);
    m.setFollow("*", "shares.recycle_bin", false);
    expect(m.unfollowed()).toEqual([
      { scope: "*", checkId: "shares.recycle_bin" },
      { scope: "essai", checkId: "ups.configured" },
    ]);
    m.setFollow("essai", "ups.configured", true);
    expect(m.unfollowed()).toEqual([
      { scope: "*", checkId: "shares.recycle_bin" },
    ]);
  });

  test("le suivi d'un NAS retiré est oublié, celui du parc reste", () => {
    m.setFollow("ancien", "ups.configured", false);
    m.setFollow("*", "ups.configured", false);
    m.prune(["essai"]);
    expect(m.unfollowed()).toEqual([{ scope: "*", checkId: "ups.configured" }]);
  });

  test("un état garde l'heure de sa première lecture", () => {
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-09T10:00:00Z",
    );
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-21T10:00:00Z",
    );
    expect(m.seenSince("essai", "access.firewall")).toBe(
      "2026-11-09T10:00:00Z",
    );
  });

  test("un changement d'état repart de zéro", () => {
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-09T10:00:00Z",
    );
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "ok" }],
      "2026-11-21T10:00:00Z",
    );
    expect(m.seenSince("essai", "access.firewall")).toBe(
      "2026-11-21T10:00:00Z",
    );
  });

  test("une lecture inconnue passagère ne remet pas la date à zéro", () => {
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-09T10:00:00Z",
    );
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "unknown" }],
      "2026-11-20T10:00:00Z",
    );
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-21T10:00:00Z",
    );
    expect(m.seenSince("essai", "access.firewall")).toBe(
      "2026-11-09T10:00:00Z",
    );
  });

  test("un contrôle jamais lu n'a pas de date", () =>
    expect(m.seenSince("essai", "access.ssh")).toBeNull());

  test("la mémoire survit à une réouverture du fichier", () => {
    m.observe(
      "essai",
      [{ id: "access.firewall", status: "failed" }],
      "2026-11-09T10:00:00Z",
    );
    m.agentRead("essai", "2026-11-21T09:00:00Z");
    const again = openMemory(file);
    expect(again.seenSince("essai", "access.firewall")).toBe(
      "2026-11-09T10:00:00Z",
    );
    expect(again.lastAgentRead("essai")).toBe("2026-11-21T09:00:00Z");
  });

  test("dernière lecture réussie de l'agent", () => {
    expect(m.lastAgentRead("essai")).toBeNull();
    m.agentRead("essai", "2026-11-21T09:00:00Z");
    m.agentRead("essai", "2026-11-21T10:00:00Z");
    expect(m.lastAgentRead("essai")).toBe("2026-11-21T10:00:00Z");
  });

  test("prune retire les NAS disparus", () => {
    m.observe("essai", [{ id: "a", status: "ok" }], "2026-11-21T10:00:00Z");
    m.observe("ancien", [{ id: "a", status: "ok" }], "2026-11-21T10:00:00Z");
    m.agentRead("ancien", "2026-11-21T10:00:00Z");
    m.prune(["essai"]);
    expect(m.seenSince("essai", "a")).toBe("2026-11-21T10:00:00Z");
    expect(m.seenSince("ancien", "a")).toBeNull();
    expect(m.lastAgentRead("ancien")).toBeNull();
  });

  test("sans fichier, rien n'est retenu", () => {
    const none = openMemory(null);
    none.observe("x", [{ id: "y", status: "failed" }], "2026-11-21T10:00:00Z");
    none.agentRead("x", "2026-11-21T10:00:00Z");
    expect(none.seenSince("x", "y")).toBeNull();
    expect(none.lastAgentRead("x")).toBeNull();
  });

  test("ni éléments ni valeurs : les tables et leurs seules colonnes", () => {
    m.observe("essai", [{ id: "a", status: "ok" }], "2026-11-21T10:00:00Z");
    const db = new DatabaseSync(file, { readOnly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    // « unfollow » ne garde qu'une préférence : quel contrôle on ne suit plus, et où ; les
    // groupes, que des noms tapés dans la console, jamais un texte venu d'un NAS.
    expect(tables).toEqual([
      "agent_read",
      "check_state",
      "folders",
      "nas_folder",
      "unfollow",
    ]);
    const columns = (t: string) =>
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((r) => r.name);
    expect(columns("check_state")).toEqual([
      "nas_id",
      "check_id",
      "status",
      "since",
    ]);
    expect(columns("agent_read")).toEqual(["nas_id", "at"]);
    expect(columns("unfollow")).toEqual(["scope", "check_id"]);
    expect(columns("folders")).toEqual(["id", "name", "kind", "position"]);
    expect(columns("nas_folder")).toEqual(["nas_id", "folder_id"]);
    db.close();
  });
});

describe("groupes de NAS", () => {
  test("créer, renommer, changer le type, ordonner, supprimer", () => {
    const a = m.createFolder("Dupont", "client");
    const b = m.createFolder("Maison", "category");
    expect(m.folders().map((f) => [f.name, f.kind])).toEqual([
      ["Dupont", "client"],
      ["Maison", "category"],
    ]);
    m.updateFolder(a.id, { name: "Cabinet Dupont", kind: "other" });
    m.moveFolder(b.id, -1);
    expect(m.folders().map((f) => [f.name, f.kind])).toEqual([
      ["Maison", "category"],
      ["Cabinet Dupont", "other"],
    ]);
    m.setNasFolder("essai", a.id);
    m.setNasFolder("atelier", b.id);
    expect(m.nasFolders()).toEqual({ essai: a.id, atelier: b.id });
    m.deleteFolder(a.id);
    expect(m.folders().map((f) => f.name)).toEqual(["Maison"]);
    // Ses NAS redeviennent sans groupe ; rien d'autre ne s'efface.
    expect(m.nasFolders()).toEqual({ atelier: b.id });
  });

  test("un NAS n'est que dans un groupe, et peut en sortir", () => {
    const a = m.createFolder("A", "other");
    const b = m.createFolder("B", "other");
    m.setNasFolder("essai", a.id);
    m.setNasFolder("essai", b.id);
    expect(m.nasFolders()).toEqual({ essai: b.id });
    m.setNasFolder("essai", null);
    expect(m.nasFolders()).toEqual({});
  });

  test("un groupe inconnu n'est pas donné à un NAS", () => {
    m.setNasFolder("essai", "nope0000");
    expect(m.nasFolders()).toEqual({});
  });

  test("un NAS retiré du parc quitte son groupe", () => {
    const a = m.createFolder("A", "other");
    m.setNasFolder("essai", a.id);
    m.setNasFolder("ancien", a.id);
    m.prune(["essai"]);
    expect(m.nasFolders()).toEqual({ essai: a.id });
    m.forget("essai");
    expect(m.nasFolders()).toEqual({});
    expect(m.folders()).toHaveLength(1);
  });

  test("les groupes survivent à la réouverture", () => {
    const a = m.createFolder("Dupont", "client");
    m.setNasFolder("essai", a.id);
    const again = openMemory(file);
    expect(again.folders()).toEqual([
      { id: a.id, name: "Dupont", kind: "client", position: 0 },
    ]);
    expect(again.nasFolders()).toEqual({ essai: a.id });
  });
});

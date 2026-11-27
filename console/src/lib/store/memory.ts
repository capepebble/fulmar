import "server-only";

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FolderKind } from "@/lib/fleet/folders";
import type { Status } from "@/lib/fleet/types";

// Mémoire de la console : depuis quand chaque contrôle a son état, la dernière lecture réussie
// de chaque agent, le suivi choisi (quel contrôle on ne suit plus, sur un NAS ou partout) et
// les groupes de NAS (conception 2026-11-26-groupes-protections-parc, section 1).
// Rien d'autre : ni éléments, ni valeurs, ni texte venu d'un NAS.
// Fichier `NAS_CONSOLE_MEMORY_FILE` ; sans lui, une mémoire vide qui ne retient rien.

export interface Memory {
  /** Faux quand la console n'a pas de fichier de mémoire : rien n'est retenu. */
  persistent: boolean;
  /** Note l'état de chaque contrôle ; la date ne change que si l'état change, et un état
   * inconnu n'est pas noté. */
  observe(
    nasId: string,
    checks: { id: string; status: Status }[],
    at: string,
  ): void;
  /** Instant depuis lequel le contrôle a son état actuel, `null` s'il n'a jamais été lu. */
  seenSince(nasId: string, checkId: string): string | null;
  /** Note une lecture réussie de l'agent. */
  agentRead(nasId: string, at: string): void;
  lastAgentRead(nasId: string): string | null;
  /** Les contrôles qu'on ne suit plus : `scope` est un NAS ou « * » (tout le parc). */
  unfollowed(): FollowRule[];
  /** Suivre ou ne plus suivre un contrôle, sur un NAS ou sur tout le parc. */
  setFollow(scope: string, checkId: string, follow: boolean): void;
  /** Oublie les NAS qui ne sont plus dans la configuration. */
  prune(keep: string[]): void;
  /** Oublie tout d'un NAS retiré du parc : ses états, sa dernière lecture, son suivi, son
   * groupe. */
  forget(nasId: string): void;
  /** Les groupes, dans leur ordre. */
  folders(): Folder[];
  createFolder(name: string, kind: FolderKind): Folder;
  updateFolder(id: string, change: { name?: string; kind?: FolderKind }): void;
  /** Monte (-1) ou descend (1) un groupe d'un rang. */
  moveFolder(id: string, step: -1 | 1): void;
  /** Supprime un groupe ; ses NAS redeviennent sans groupe. */
  deleteFolder(id: string): void;
  /** Le groupe de chaque NAS rangé. */
  nasFolders(): Record<string, string>;
  /** Range un NAS dans un groupe existant, ou l'en sort (`null`). */
  setNasFolder(nasId: string, folderId: string | null): void;
}

export type { FolderKind } from "@/lib/fleet/folders";

export interface Folder {
  id: string;
  name: string;
  kind: FolderKind;
  position: number;
}

export interface FollowRule {
  scope: string;
  checkId: string;
}

const NONE: Memory = {
  persistent: false,
  observe() {},
  seenSince: () => null,
  agentRead() {},
  lastAgentRead: () => null,
  unfollowed: () => [],
  setFollow() {},
  prune() {},
  forget() {},
  folders: () => [],
  createFolder() {
    throw new Error("The console has no memory.");
  },
  updateFolder() {},
  moveFolder() {},
  deleteFolder() {},
  nasFolders: () => ({}),
  setNasFolder() {},
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS check_state (
  nas_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (nas_id, check_id)
);
CREATE TABLE IF NOT EXISTS agent_read (
  nas_id TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unfollow (
  scope TEXT NOT NULL,
  check_id TEXT NOT NULL,
  PRIMARY KEY (scope, check_id)
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nas_folder (
  nas_id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders (id) ON DELETE CASCADE
);`;

export function openMemory(file: string | null): Memory {
  if (!file) return NONE;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO check_state (nas_id, check_id, status, since) VALUES (?, ?, ?, ?)
    ON CONFLICT (nas_id, check_id) DO UPDATE
      SET status = excluded.status, since = excluded.since
      WHERE check_state.status != excluded.status`);
  const since = db.prepare(
    "SELECT since FROM check_state WHERE nas_id = ? AND check_id = ?",
  );
  const read = db.prepare(`
    INSERT INTO agent_read (nas_id, at) VALUES (?, ?)
    ON CONFLICT (nas_id) DO UPDATE SET at = excluded.at
      WHERE excluded.at > agent_read.at`);
  const lastRead = db.prepare("SELECT at FROM agent_read WHERE nas_id = ?");
  const unfollowAll = db.prepare(
    "SELECT scope, check_id FROM unfollow ORDER BY scope, check_id",
  );
  const unfollowAdd = db.prepare(
    "INSERT OR IGNORE INTO unfollow (scope, check_id) VALUES (?, ?)",
  );
  const unfollowDel = db.prepare(
    "DELETE FROM unfollow WHERE scope = ? AND check_id = ?",
  );
  const folderList = db.prepare(
    "SELECT id, name, kind, position FROM folders ORDER BY position, name",
  );
  const folderAdd = db.prepare(
    "INSERT INTO folders (id, name, kind, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM folders))",
  );
  const folderGet = db.prepare(
    "SELECT id, name, kind, position FROM folders WHERE id = ?",
  );
  const nasFolderList = db.prepare(
    "SELECT nas_id, folder_id FROM nas_folder ORDER BY nas_id",
  );

  /** Renumérote les rangs dans l'ordre donné, de 0 à n - 1. */
  function renumber(ids: string[]): void {
    const set = db.prepare("UPDATE folders SET position = ? WHERE id = ?");
    ids.forEach((id, i) => {
      set.run(i, id);
    });
  }

  return {
    persistent: true,
    observe(nasId, checks, at) {
      db.exec("BEGIN");
      try {
        // Une lecture inconnue (DSM qui hoquette) ne dit rien de l'état : elle ne remet pas
        // la date à zéro.
        for (const c of checks)
          if (c.status !== "unknown") upsert.run(nasId, c.id, c.status, at);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    seenSince(nasId, checkId) {
      const row = since.get(nasId, checkId) as { since?: string } | undefined;
      return row?.since ?? null;
    },
    agentRead(nasId, at) {
      read.run(nasId, at);
    },
    lastAgentRead(nasId) {
      const row = lastRead.get(nasId) as { at?: string } | undefined;
      return row?.at ?? null;
    },
    unfollowed() {
      return (unfollowAll.all() as { scope: string; check_id: string }[]).map(
        (r) => ({ scope: r.scope, checkId: r.check_id }),
      );
    },
    setFollow(scope, checkId, follow) {
      if (follow) unfollowDel.run(scope, checkId);
      else unfollowAdd.run(scope, checkId);
    },
    prune(keep) {
      const list = JSON.stringify(keep);
      for (const table of ["check_state", "agent_read"]) {
        db.prepare(
          `DELETE FROM ${table} WHERE nas_id NOT IN (SELECT value FROM json_each(?))`,
        ).run(list);
      }
      // Le suivi d'un NAS retiré s'oublie ; celui de tout le parc (« * ») reste.
      db.prepare(
        "DELETE FROM unfollow WHERE scope != '*' AND scope NOT IN (SELECT value FROM json_each(?))",
      ).run(list);
      db.prepare(
        "DELETE FROM nas_folder WHERE nas_id NOT IN (SELECT value FROM json_each(?))",
      ).run(list);
    },
    forget(nasId) {
      for (const table of ["check_state", "agent_read", "nas_folder"])
        db.prepare(`DELETE FROM ${table} WHERE nas_id = ?`).run(nasId);
      db.prepare("DELETE FROM unfollow WHERE scope = ?").run(nasId);
    },
    folders() {
      return folderList.all() as unknown as Folder[];
    },
    createFolder(name, kind) {
      const id = randomBytes(4).toString("hex");
      folderAdd.run(id, name, kind);
      return folderGet.get(id) as unknown as Folder;
    },
    updateFolder(id, change) {
      if (change.name !== undefined)
        db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(
          change.name,
          id,
        );
      if (change.kind !== undefined)
        db.prepare("UPDATE folders SET kind = ? WHERE id = ?").run(
          change.kind,
          id,
        );
    },
    moveFolder(id, step) {
      const ids = (folderList.all() as unknown as Folder[]).map((f) => f.id);
      const i = ids.indexOf(id);
      const j = i + step;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      renumber(ids);
    },
    deleteFolder(id) {
      db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      renumber((folderList.all() as unknown as Folder[]).map((f) => f.id));
    },
    nasFolders() {
      const out: Record<string, string> = {};
      for (const row of nasFolderList.all() as {
        nas_id: string;
        folder_id: string;
      }[])
        out[row.nas_id] = row.folder_id;
      return out;
    },
    setNasFolder(nasId, folderId) {
      if (folderId === null) {
        db.prepare("DELETE FROM nas_folder WHERE nas_id = ?").run(nasId);
        return;
      }
      if (!folderGet.get(folderId)) return;
      db.prepare(
        "INSERT INTO nas_folder (nas_id, folder_id) VALUES (?, ?) ON CONFLICT (nas_id) DO UPDATE SET folder_id = excluded.folder_id",
      ).run(nasId, folderId);
    },
  };
}

let instance: Memory | undefined;

/** La mémoire de la console, unique ; vide si le fichier manque ou ne s'ouvre pas. */
export function memory(): Memory {
  if (!instance) {
    // En développement, une mémoire par défaut dans data/ (jamais versionné) : le suivi choisi
    // s'essaie sans réglage. En production, le fichier est donné par le projet Compose.
    const file =
      process.env.NAS_CONSOLE_MEMORY_FILE?.trim() ||
      (process.env.NODE_ENV === "development" ? "data/memory.sqlite" : null);
    try {
      instance = openMemory(file);
    } catch (error) {
      console.error(
        `Mémoire de la console indisponible (${file}) :`,
        error instanceof Error ? error.message : error,
      );
      instance = NONE;
    }
  }
  return instance;
}

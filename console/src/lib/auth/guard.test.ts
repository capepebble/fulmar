import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Next.js appelle une action serveur par son identifiant, quelle que soit la page visée : une
// requête vers une page ouverte sans session (/connexion) peut viser n'importe quelle action.
// Chaque action vérifie donc elle-même la session, sauf celles qui l'ouvrent.
const OPEN_ACTIONS = new Set(["welcome", "signIn"]);

function serverActionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return serverActionFiles(path);
    return /\.tsx?$/.test(name) &&
      readFileSync(path, "utf8").trimStart().startsWith('"use server"')
      ? [path]
      : [];
  });
}

describe("actions serveur", () => {
  it("chacune vérifie la session, sauf bienvenue et connexion", () => {
    const files = serverActionFiles(join(__dirname, "..", "..", "app"));
    expect(files.length).toBeGreaterThan(0);
    const unguarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const parts = source.split(/^export async function /m).slice(1);
      for (const part of parts) {
        const name = part.match(/^(\w+)/)?.[1] ?? "?";
        const body = part.slice(0, part.indexOf("\n}\n") + 1);
        if (!OPEN_ACTIONS.has(name) && !body.includes("await requireSession()"))
          unguarded.push(name);
      }
    }
    expect(unguarded).toEqual([]);
  });
});

import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./types";

// Liste des agents : console/data/agents.json, ignoré par git (adresses et noms des NAS des
// clients n'entrent jamais dans le dépôt). Les jetons sont dans l'environnement, jamais ici.

export function agentsFile(): string {
  return (
    process.env.NAS_CONSOLE_AGENTS_FILE ??
    join(process.cwd(), "data", "agents.json")
  );
}

function isAgent(value: unknown): value is AgentConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const optional = (k: string) =>
    v[k] === undefined || (typeof v[k] === "string" && v[k] !== "");
  return (
    ["id", "name", "place", "url", "tokenEnv"].every(
      (k) => typeof v[k] === "string" && v[k] !== "",
    ) && optional("beszelSystem")
  );
}

/** L'agent du projet du moteur : même projet Compose, jeton écrit par l'agent lui-même. */
import { LOCAL_AGENT_ID } from "./config-ids";

export { LOCAL_AGENT_ID };

export function localAgent(): AgentConfig | null {
  const url = process.env.NAS_CONSOLE_AGENT_URL?.trim();
  const tokenFile = process.env.NAS_CONSOLE_AGENT_TOKEN_FILE?.trim();
  if (!url || !tokenFile) return null;
  return {
    id: LOCAL_AGENT_ID,
    name: process.env.NAS_CONSOLE_AGENT_NAME?.trim() || "Ce NAS",
    place: process.env.NAS_CONSOLE_AGENT_PLACE?.trim() ?? "",
    url: url.replace(/\/+$/, ""),
    tokenEnv: "",
    tokenFile,
    autoName: !process.env.NAS_CONSOLE_AGENT_NAME?.trim(),
  };
}

/** Le jeton d'un agent : dans son fichier, ou dans sa variable d'environnement. */
export function agentToken(agent: AgentConfig): string | undefined {
  if (agent.tokenFile) {
    try {
      return (
        readFileSync(
          /*turbopackIgnore: true*/ agent.tokenFile,
          "utf8",
        ).trim() || undefined
      );
    } catch {
      return undefined;
    }
  }
  return process.env[agent.tokenEnv] || undefined;
}

/** D'où vient le jeton, pour dire pourquoi il manque. */
export function tokenSource(agent: AgentConfig): string {
  return agent.tokenFile
    ? `fichier ${agent.tokenFile}`
    : `variable ${agent.tokenEnv}`;
}

/** Un NAS ajouté au hub (conception 2026-11-26-parc-du-moteur) : l'agent du projet le sert
 * sous /nas/<id>, avec son propre jeton. */
export interface FleetMember {
  id: string;
  host: string;
  port: number;
  addedAt: string;
}

const MEMBER_ID = /^[0-9a-f]{8}$/;

/** Les NAS ajoutés, lus dans `fleet.json`, que l'agent tient à côté du jeton de la console :
 * un agent arrêté laisse ses NAS dans le parc, dits injoignables. */
export function fleetMembers(local = localAgent()): FleetMember[] {
  if (!local?.tokenFile) return [];
  const file = join(dirname(local.tokenFile), "fleet.json");
  if (!existsSync(/*turbopackIgnore: true*/ file)) return [];
  try {
    const parsed = JSON.parse(
      readFileSync(/*turbopackIgnore: true*/ file, "utf8"),
    ) as { nas?: unknown };
    if (!Array.isArray(parsed.nas)) return [];
    return parsed.nas.flatMap((raw: unknown) => {
      const v = (raw ?? {}) as Record<string, unknown>;
      if (typeof v.id !== "string" || !MEMBER_ID.test(v.id)) return [];
      if (typeof v.host !== "string" || !v.host) return [];
      return [
        {
          id: v.id,
          host: v.host,
          port: typeof v.port === "number" ? v.port : 5001,
          addedAt: typeof v.added_at === "string" ? v.added_at : "",
        },
      ];
    });
  } catch (error) {
    console.error(`Console : ${file} illisible`, error);
    return [];
  }
}

/** Le NAS ajouté vu comme un agent : l'adresse de l'agent du projet suivie de /nas/<id>. */
export function memberAgent(
  local: AgentConfig,
  member: FleetMember,
): AgentConfig {
  return {
    id: member.id,
    name: member.host,
    place: "",
    url: `${local.url}/nas/${member.id}`,
    tokenEnv: "",
    tokenFile: join(dirname(local.tokenFile ?? ""), "nas", member.id),
    autoName: true,
    member: true,
  };
}

export function loadAgents(): AgentConfig[] {
  const local = localAgent();
  const fromHub = local
    ? [local, ...fleetMembers(local).map((m) => memberAgent(local, m))]
    : [];
  const ids = new Set(fromHub.map((a) => a.id));
  return [...fromHub, ...fileAgents().filter((a) => !ids.has(a.id))];
}

function fileAgents(): AgentConfig[] {
  const file = agentsFile();
  // Fichier lu à l'exécution, hors du suivi des fichiers de la compilation.
  if (!existsSync(/*turbopackIgnore: true*/ file)) return [];
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(/*turbopackIgnore: true*/ file, "utf8"),
    );
    const list = Array.isArray(parsed) ? parsed : [];
    const agents = list.filter(isAgent);
    if (agents.length !== list.length) {
      console.error(
        `Console : ${list.length - agents.length} entrée(s) invalide(s) ignorée(s) dans ${file}`,
      );
    }
    return agents.map((a) => ({
      ...a,
      url: a.url.replace(/\/+$/, ""),
    }));
  } catch (error) {
    console.error(`Console : ${file} illisible`, error);
    return [];
  }
}

/** Les NAS fictifs s'affichent sans agent, ou à côté des agents si NAS_CONSOLE_DEMO=1. */
export function demoEnabled(agents: AgentConfig[]): boolean {
  return agents.length === 0 || process.env.NAS_CONSOLE_DEMO === "1";
}

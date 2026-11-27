import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentToken,
  fleetMembers,
  LOCAL_AGENT_ID,
  loadAgents,
  tokenSource,
} from "./config";

vi.mock("server-only", () => ({}));

afterEach(() => vi.unstubAllEnvs());

function noFile(): string {
  return join(mkdtempSync(join(tmpdir(), "agents-")), "agents.json");
}

describe("l'agent du projet", () => {
  it("vient de l'environnement, en tête du parc, avec son jeton en fichier", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-"));
    writeFileSync(join(dir, "console-token"), "nag_abcdefgh_secret\n");
    vi.stubEnv("NAS_CONSOLE_AGENTS_FILE", noFile());
    vi.stubEnv("NAS_CONSOLE_AGENT_URL", "http://agent:8765/");
    vi.stubEnv("NAS_CONSOLE_AGENT_TOKEN_FILE", join(dir, "console-token"));
    const [local] = loadAgents();
    expect(local).toMatchObject({
      id: LOCAL_AGENT_ID,
      url: "http://agent:8765",
      autoName: true,
    });
    expect(agentToken(local)).toBe("nag_abcdefgh_secret");
    expect(tokenSource(local)).toMatch(/^fichier /);
  });

  it("n'existe pas sans adresse ni fichier de jeton", () => {
    vi.stubEnv("NAS_CONSOLE_AGENTS_FILE", noFile());
    vi.stubEnv("NAS_CONSOLE_AGENT_URL", "");
    expect(loadAgents()).toEqual([]);
  });

  it("n'a pas de jeton tant que l'agent ne l'a pas écrit", () => {
    vi.stubEnv("NAS_CONSOLE_AGENTS_FILE", noFile());
    vi.stubEnv("NAS_CONSOLE_AGENT_URL", "http://agent:8765");
    vi.stubEnv("NAS_CONSOLE_AGENT_TOKEN_FILE", "/nulle/part/console-token");
    const [local] = loadAgents();
    expect(agentToken(local)).toBeUndefined();
  });

  it("garde les jetons des autres agents dans l'environnement", () => {
    vi.stubEnv("NAS_AGENT_ESSAI_TOKEN", "nag_essai");
    const agent = {
      id: "essai",
      name: "NAS d'essai",
      place: "Salon",
      url: "https://x",
      tokenEnv: "NAS_AGENT_ESSAI_TOKEN",
    };
    expect(agentToken(agent)).toBe("nag_essai");
    expect(tokenSource(agent)).toBe("variable NAS_AGENT_ESSAI_TOKEN");
  });
});

describe("les NAS ajoutés au hub", () => {
  function hub(manifest: unknown, agentsFile = noFile()) {
    const dir = mkdtempSync(join(tmpdir(), "shared-"));
    writeFileSync(join(dir, "console-token"), "nag_hub_secret\n");
    writeFileSync(join(dir, "fleet.json"), JSON.stringify(manifest));
    vi.stubEnv("NAS_CONSOLE_AGENTS_FILE", agentsFile);
    vi.stubEnv("NAS_CONSOLE_AGENT_URL", "http://agent:8765");
    vi.stubEnv("NAS_CONSOLE_AGENT_TOKEN_FILE", join(dir, "console-token"));
    return dir;
  }

  it("suivent le NAS du hub, sous son agent, chacun avec son jeton", () => {
    const dir = hub({
      nas: [
        {
          id: "3f9a2c10",
          host: "192.168.1.20",
          port: 5001,
          added_at: "2026-11-26T09:00:00+00:00",
        },
      ],
    });
    mkdirSync(join(dir, "nas"));
    writeFileSync(join(dir, "nas", "3f9a2c10"), "nag_member\n");
    const [local, member] = loadAgents();
    expect(local.id).toBe(LOCAL_AGENT_ID);
    expect(member).toMatchObject({
      id: "3f9a2c10",
      name: "192.168.1.20",
      url: "http://agent:8765/nas/3f9a2c10",
      tokenFile: join(dir, "nas", "3f9a2c10"),
      autoName: true,
      member: true,
    });
    expect(agentToken(member)).toBe("nag_member");
  });

  it("écartent une entrée dont l'identifiant n'est pas celui de l'agent", () => {
    hub({
      nas: [
        { id: "../etc", host: "192.168.1.20" },
        { id: "ABCDEF12", host: "192.168.1.21" },
        { id: "0123abcd", host: "" },
        { id: "0123abcd", host: "nas.local" },
      ],
    });
    expect(fleetMembers().map((m) => [m.id, m.host, m.port])).toEqual([
      ["0123abcd", "nas.local", 5001],
    ]);
  });

  it("n'existent pas sans agent de projet, ni sans liste lisible", () => {
    vi.stubEnv("NAS_CONSOLE_AGENT_URL", "");
    expect(fleetMembers()).toEqual([]);
    hub("pas une liste");
    expect(fleetMembers()).toEqual([]);
  });

  it("passent avant un agent de agents.json qui aurait le même identifiant", () => {
    const file = noFile();
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "0123abcd",
          name: "Autre",
          place: "",
          url: "https://x",
          tokenEnv: "T",
        },
      ]),
    );
    hub({ nas: [{ id: "0123abcd", host: "nas.local", port: 5001 }] }, file);
    const ids = loadAgents().map((a) => [a.id, a.name]);
    expect(ids).toEqual([
      [LOCAL_AGENT_ID, "Ce NAS"],
      ["0123abcd", "nas.local"],
    ]);
  });
});

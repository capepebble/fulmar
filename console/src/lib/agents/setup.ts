import "server-only";

import type { Texts } from "@/i18n";
import { agentToken, localAgent } from "./config";
import { setupProblem } from "./setup-errors";

// L'enrôlement de l'agent du projet par la console (moteur installable, section 3) : l'agent
// attend, la console lui donne l'adresse de DSM, l'empreinte confirmée et le compte.

export type SetupStatus =
  | { kind: "none" }
  | { kind: "enrolled" }
  | { kind: "waiting"; host: string; port: number }
  | { kind: "unreachable"; reason: Texts };

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 10_000,
  method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET",
): Promise<Reply | { failure: Texts }> {
  const agent = localAgent();
  const token = agent ? agentToken(agent) : undefined;
  if (!agent)
    return {
      failure: {
        en: "there is no agent in this project",
        fr: "pas d'agent dans ce projet",
      },
    };
  if (!token)
    return {
      failure: {
        en: "the agent has not written the console token yet",
        fr: "l'agent n'a pas encore écrit le jeton de la console",
      },
    };
  try {
    const response = await fetch(`${agent.url}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // Corps sans JSON : le code suffit.
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      failure:
        name === "TimeoutError"
          ? {
              en: "the agent did not answer in time",
              fr: "l'agent n'a pas répondu à temps",
            }
          : {
              en: "the agent does not answer (it may be starting)",
              fr: "l'agent ne répond pas (il démarre peut-être)",
            },
    };
  }
}

function refusal(reply: Reply, at: { host: string; port: number }): Texts {
  return setupProblem({ status: reply.status, ...reply.body }, at);
}

export async function localSetupStatus(): Promise<SetupStatus> {
  if (!localAgent()) return { kind: "none" };
  const reply = await call("/setup");
  if ("failure" in reply) return { kind: "unreachable", reason: reply.failure };
  if (reply.status !== 200)
    return {
      kind: "unreachable",
      reason: refusal(reply, { host: "", port: 0 }),
    };
  if (reply.body.enrolled === true) return { kind: "enrolled" };
  const dsm = (reply.body.dsm ?? {}) as { host?: unknown; port?: unknown };
  return {
    kind: "waiting",
    host: typeof dsm.host === "string" ? dsm.host : "",
    port: typeof dsm.port === "number" ? dsm.port : 5001,
  };
}

export type CertificateResult =
  | { ok: true; fingerprint: string; verifies: boolean }
  | { ok: false; error: Texts };

export async function readCertificate(
  host: string,
  port: number,
  serverName: string | null,
): Promise<CertificateResult> {
  const reply = await call("/setup/certificate", {
    host,
    port,
    server_name: serverName,
  });
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status !== 200)
    return { ok: false, error: refusal(reply, { host, port }) };
  return {
    ok: true,
    fingerprint: String(reply.body.fingerprint ?? ""),
    verifies: reply.body.verifies === true,
  };
}

export interface EnrollInput {
  host: string;
  port: number;
  serverName: string | null;
  fingerprint: string;
  username: string;
  password: string;
  otp: string | null;
}

export type EnrollResult =
  | { ok: true }
  | { ok: false; error: Texts; code?: string };

export async function enrollLocal(input: EnrollInput): Promise<EnrollResult> {
  // La connexion à DSM et la double authentification peuvent prendre plusieurs secondes.
  const reply = await call(
    "/setup/enroll",
    {
      host: input.host,
      port: input.port,
      server_name: input.serverName,
      fingerprint: input.fingerprint,
      username: input.username,
      password: input.password,
      otp: input.otp,
    },
    45_000,
  );
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status === 200) return { ok: true };
  return {
    ok: false,
    error: refusal(reply, input),
    code: typeof reply.body.code === "string" ? reply.body.code : undefined,
  };
}

// Le parc du hub (conception 2026-11-26-parc-du-moteur) : ajouter un NAS par l'adresse de son
// DSM, le retirer. Mêmes gestes que l'enrôlement, sur l'API du parc de l'agent du projet.

/** L'adresse et le nom du certificat, tels que l'agent les admet (nom d'hôte ou adresse IP). */
export const HOST_PATTERN = /^[A-Za-z0-9.:[\]-]+$/;

export async function readFleetCertificate(
  host: string,
  port: number,
  serverName: string | null,
): Promise<CertificateResult> {
  const reply = await call("/fleet/certificate", {
    host,
    port,
    server_name: serverName,
  });
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status !== 200)
    return { ok: false, error: refusal(reply, { host, port }) };
  return {
    ok: true,
    fingerprint: String(reply.body.fingerprint ?? ""),
    verifies: reply.body.verifies === true,
  };
}

export type AddResult =
  | { ok: true; id: string }
  | { ok: false; error: Texts; code?: string };

export async function addToFleet(input: EnrollInput): Promise<AddResult> {
  const reply = await call(
    "/fleet",
    {
      host: input.host,
      port: input.port,
      server_name: input.serverName,
      fingerprint: input.fingerprint,
      username: input.username,
      password: input.password,
      otp: input.otp,
    },
    45_000,
  );
  if ("failure" in reply) return { ok: false, error: reply.failure };
  const nas = (reply.body.nas ?? {}) as { id?: unknown };
  if (reply.status === 201 && typeof nas.id === "string")
    return { ok: true, id: nas.id };
  return {
    ok: false,
    error: refusal(reply, input),
    code: typeof reply.body.code === "string" ? reply.body.code : undefined,
  };
}

export async function removeFromFleet(
  id: string,
): Promise<{ ok: true } | { ok: false; error: Texts }> {
  const reply = await call(
    `/fleet/${encodeURIComponent(id)}`,
    undefined,
    20_000,
    "DELETE",
  );
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status === 204) return { ok: true };
  return { ok: false, error: refusal(reply, { host: "", port: 0 }) };
}

// Les mises à jour du parc (conception 2026-11-26-groupes-protections-parc, section 3) : le
// hub mène, un NAS après l'autre ; la console lit, lance et arrête.

export async function fleetRollouts(): Promise<
  { ok: true; body: unknown } | { ok: false; error: Texts }
> {
  const reply = await call("/fleet/rollouts");
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status === 200) return { ok: true, body: reply.body };
  return { ok: false, error: refusal(reply, { host: "", port: 0 }) };
}

export async function planFleetRollout(input: {
  target: "packages" | "dsm";
  nas: string[];
  at: string | null;
  acceptWarnings: boolean;
}): Promise<{ ok: true; body: unknown } | { ok: false; error: Texts }> {
  const reply = await call("/fleet/rollouts", {
    target: input.target,
    nas: input.nas,
    ...(input.at ? { at: input.at } : {}),
    accept_warnings: input.acceptWarnings,
  });
  if ("failure" in reply) return { ok: false, error: reply.failure };
  if (reply.status === 201) return { ok: true, body: reply.body.rollout };
  const detail = typeof reply.body.detail === "string" ? reply.body.detail : "";
  return {
    ok: false,
    error: detail
      ? { en: detail, fr: detail }
      : refusal(reply, { host: "", port: 0 }),
  };
}

export async function cancelFleetRollout(
  id: string,
): Promise<{ ok: boolean; error?: Texts }> {
  const reply = await call(
    `/fleet/rollouts/${encodeURIComponent(id)}/cancel`,
    {},
  );
  if ("failure" in reply) return { ok: false, error: reply.failure };
  return { ok: reply.status === 200 && reply.body.cancelled === true };
}

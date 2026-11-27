import "server-only";

import type { Locale } from "@/i18n";
import { agentProblem } from "./problems";
import type { AgentConfig, Read } from "./types";

// Une lecture de l'API REST d'un agent (ou une de ses actions, en POST : téléphones), côté
// serveur : 10 s au plus, jamais de cache HTTP.
// Une réponse en erreur rend son statut et son code, dits dans chaque langue (problems.ts).

const TIMEOUT_MS = 10_000;

export async function readPath(
  agent: AgentConfig,
  token: string,
  path: string,
  method: "GET" | "POST" = "GET",
  lang?: Locale,
): Promise<Read<unknown>> {
  try {
    const response = await fetch(`${agent.url}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // Les verdicts de l'agent dans la langue de la page.
        ...(lang ? { "Accept-Language": lang } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      let code = response.statusText;
      try {
        const body = (await response.json()) as { code?: unknown };
        if (typeof body.code === "string") code = body.code;
      } catch {
        // Corps sans JSON : le statut suffit.
      }
      return {
        ok: false,
        status: response.status,
        reason: agentProblem(response.status, code),
      };
    }
    const envelope = (await response.json()) as {
      fetched_at?: string;
      data?: unknown;
    };
    return {
      ok: true,
      fetchedAt: envelope.fetched_at ?? new Date().toISOString(),
      data: envelope.data,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return {
      ok: false,
      reason:
        name === "TimeoutError"
          ? {
              en: "the agent did not answer in time",
              fr: "l'agent n'a pas répondu à temps",
            }
          : { en: "agent unreachable", fr: "agent injoignable" },
    };
  }
}

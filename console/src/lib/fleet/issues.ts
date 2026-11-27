// Points à traiter (conception, § 6) : un point par contrôle qui n'est pas OK, plus un point
// par NAS hors ligne, à l'accès refusé ou à l'agent injoignable. La console n'invente aucun
// autre verdict ; le « Que faire » d'un contrôle est son conseil, tel que l'agent le donne.

import { type Locale, tr } from "@/i18n";
import { nasState } from "./state";
import type { Check, Nas } from "./types";

export type IssueLevel =
  | "offline"
  | "denied"
  | "agent_down"
  | "failed"
  | "warning";

export interface Issue {
  nas: Nas;
  level: IssueLevel;
  title: string;
  todo: string;
  since: { label: "depuis" | "vu le"; at: string } | null;
  checkId: string | null;
}

const LEVEL_ORDER: IssueLevel[] = [
  "offline",
  "denied",
  "agent_down",
  "failed",
  "warning",
];
const SEVERITY_ORDER = { high: 0, medium: 1, info: 2 } as const;

function latest(...at: (string | null | undefined)[]): string | null {
  const known = at.filter((t): t is string => Boolean(t)).sort();
  return known.at(-1) ?? null;
}

/** Point d'accessibilité d'un NAS, ou rien s'il répond. */
function reachIssue(nas: Nas, lang: Locale): Issue | null {
  const site = tr(lang, {
    en: "Check the power and the site’s connection.",
    fr: "Vérifier le courant et la connexion du site.",
  });
  const state = nasState(nas);
  const agentAt =
    nas.agent.kind === "down" || nas.agent.kind === "denied"
      ? nas.agent.lastReadAt
      : null;
  const beszelAt =
    nas.beszel.kind === "ok" || nas.beszel.kind === "down"
      ? nas.beszel.lastAt
      : null;
  const since = (at: string | null) =>
    at ? { label: "depuis" as const, at } : null;
  const base = { nas, checkId: null };
  if (state === "offline") {
    const todo =
      nas.agent.kind === "none"
        ? tr(lang, {
            en: `Beszel no longer sees it. ${site}`,
            fr: `Beszel ne le voit plus. ${site}`,
          })
        : nas.beszel.kind === "none" || nas.beszel.kind === "missing"
          ? tr(lang, {
              en: `The agent doesn’t answer. ${site}`,
              fr: `L'agent ne répond pas. ${site}`,
            })
          : tr(lang, {
              en: `Neither the agent nor Beszel answers. ${site}`,
              fr: `Ni l'agent ni Beszel ne répondent. ${site}`,
            });
    return {
      ...base,
      level: "offline",
      title: tr(lang, {
        en: "The NAS no longer answers",
        fr: "Le NAS ne répond plus",
      }),
      todo,
      since: since(latest(agentAt, beszelAt)),
    };
  }
  if (state === "denied")
    return {
      ...base,
      level: "denied",
      title: tr(lang, {
        en: "The agent refuses the console",
        fr: "L'agent refuse la console",
      }),
      todo: tr(lang, {
        en: "Token expired, revoked or address not allowed: renew the console’s token.",
        fr: "Jeton expiré, révoqué ou adresse non admise : renouveler le jeton de la console.",
      }),
      since: since(agentAt),
    };
  if (state === "agent_down")
    return {
      ...base,
      level: "agent_down",
      title: tr(lang, {
        en: "The agent no longer answers",
        fr: "L'agent ne répond plus",
      }),
      todo: tr(lang, {
        en: "The NAS is running (Beszel sees it), but its checks are not read. Check the agent’s container.",
        fr: "Le NAS tourne (Beszel le voit), mais ses contrôles ne sont pas lus. Vérifier le conteneur de l'agent.",
      }),
      since: since(agentAt),
    };
  return null;
}

const SINCE_LAST_SUCCESS = new Set([
  "backup.last_result",
  "backup.recent_success",
]);

/** Sauvegarde en échec : depuis la dernière réussite des tâches en cause, quand toutes en ont
 * une ; sinon, ce que la mémoire a vu. */
function checkSince(nas: Nas, check: Check): Issue["since"] {
  if (SINCE_LAST_SUCCESS.has(check.id)) {
    const named = nas.tasks.filter((t) =>
      // L'agent écrit « nom : … » en français, « name: … » en anglais.
      check.items.some(
        (i) =>
          i === t.name ||
          i.startsWith(`${t.name} : `) ||
          i.startsWith(`${t.name}: `),
      ),
    );
    const tasks = named.length
      ? named
      : nas.tasks.filter((t) => t.result.status === "failed");
    const successes = tasks.map((t) => t.lastSuccessAt);
    if (tasks.length && successes.every(Boolean))
      return { label: "depuis", at: (successes as string[]).sort()[0] };
  }
  const seen = nas.seen[check.id];
  return seen ? { label: "vu le", at: seen } : null;
}

export function fleetIssues(fleet: Nas[], lang: Locale): Issue[] {
  const issues: (Issue & { order: number; severity: number })[] = [];
  fleet.forEach((nas, order) => {
    const reach = reachIssue(nas, lang);
    if (reach) {
      issues.push({ ...reach, order, severity: 0 });
      return;
    }
    if (nas.agent.kind !== "ok") return;
    for (const check of nas.checks) {
      if (check.status !== "failed" && check.status !== "warning") continue;
      // Suivi choisi : ce qu'on ne suit plus n'est pas « à traiter ».
      if (check.followed === false) continue;
      // « À titre indicatif » : ni dans l'état du NAS, ni dans les points.
      if (check.severity === "info") continue;
      issues.push({
        nas,
        level: check.status,
        title: check.title,
        todo: check.advice ?? "",
        since: checkSince(nas, check),
        checkId: check.id,
        order,
        severity: SEVERITY_ORDER[check.severity],
      });
    }
  });
  return issues
    .sort(
      (a, b) =>
        LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
        a.severity - b.severity ||
        // Le plus ancien d'abord ; un point sans date passe après les points datés.
        (a.since?.at ?? "￿").localeCompare(b.since?.at ?? "￿") ||
        a.order - b.order,
    )
    .map(({ order: _o, severity: _s, ...issue }) => issue);
}

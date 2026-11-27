// Phrase d'état et chiffres du parc (conception, § 6), en anglais ou en français (vouvoiement,
// conception du moteur en anglais). Les NAS sans agent ne demandent pas d'attention tant que
// Beszel les voit ; les contrôles et les sauvegardes ne portent que sur les NAS qui ont un agent.

import { type Locale, tr } from "@/i18n";
import { NAS_STATE_ORDER, type NasState, nasState } from "./state";
import type { Nas, Volume } from "./types";

// [singulier, pluriel] dans chaque langue.
const ATTENTION_WORDS: Partial<
  Record<NasState, Record<Locale, [string, string]>>
> = {
  offline: { en: ["offline", "offline"], fr: ["hors ligne", "hors ligne"] },
  failed: { en: ["failed", "failed"], fr: ["en échec", "en échec"] },
  denied: {
    en: ["access denied", "access denied"],
    fr: ["accès refusé", "accès refusés"],
  },
  agent_down: {
    en: ["agent unreachable", "agents unreachable"],
    fr: ["agent injoignable", "agents injoignables"],
  },
  warning: { en: ["warning", "warning"], fr: ["à surveiller", "à surveiller"] },
};

export function fleetSentence(fleet: Nas[], lang: Locale): string {
  const total = fleet.length;
  if (total === 0) return tr(lang, { en: "No NAS", fr: "Aucun NAS" });
  const states = fleet.map(nasState);
  const count = (s: NasState) => states.filter((x) => x === s).length;
  const parts = NAS_STATE_ORDER.flatMap((s) => {
    const words = ATTENTION_WORDS[s]?.[lang];
    const n = count(s);
    const single = lang === "en" ? n === 1 : n <= 1;
    return words && n ? [`${n} ${single ? words[0] : words[1]}`] : [];
  });
  const attention = NAS_STATE_ORDER.filter((s) => ATTENTION_WORDS[s]).reduce(
    (sum, s) => sum + count(s),
    0,
  );
  // Un NAS à l'état inconnu n'a pas de point à traiter : il se dit à part.
  const unknown = count("unknown");
  const beszelOnly = count("beszel_only");
  const tail = beszelOnly
    ? tr(lang, {
        en: ` · ${beszelOnly} followed by Beszel only`,
        fr: ` · ${beszelOnly} ${beszelOnly > 1 ? "suivis" : "suivi"} par Beszel seulement`,
      })
    : "";
  if (attention === 0 && unknown === 0)
    return total === 1
      ? tr(lang, { en: `The NAS is fine${tail}`, fr: `Le NAS va bien${tail}` })
      : tr(lang, {
          en: `All ${total} NAS are fine${tail}`,
          fr: `Les ${total} NAS vont bien${tail}`,
        });
  if (attention === 0)
    return tr(lang, {
      en: `Nothing to handle · ${unknown} NAS in an unknown state${tail}`,
      fr: `Aucun point à traiter · ${unknown} NAS à l'état inconnu${tail}`,
    });
  const unknownPart = unknown
    ? tr(lang, {
        en: ` · ${unknown} in an unknown state`,
        fr: ` · ${unknown} à l'état inconnu`,
      })
    : "";
  return tr(lang, {
    en: `${attention} of ${total} NAS ${attention === 1 ? "needs" : "need"} your attention · ${parts.join(", ")}${unknownPart}${tail}`,
    fr: `${attention} NAS sur ${total} ${attention > 1 ? "demandent" : "demande"} votre attention · ${parts.join(", ")}${unknownPart}${tail}`,
  });
}

export interface FleetStats {
  online: { n: number; total: number };
  /** Contrôles en échec et à surveiller, sur les NAS dont l'agent a été lu. */
  checks: { failed: number; warning: number; agentNas: number };
  /** Sauvegardes lancées depuis 24 h et terminées, celles qui ont réussi, et la première en
   * échec. Une sauvegarde en cours ne compte pas. */
  backups: {
    ok: number;
    considered: number;
    failed: { nas: Nas; task: string } | null;
  };
  fullest: { nas: Nas; volume: Volume } | null;
}

const DAY_MS = 86_400_000;

export function fleetStats(fleet: Nas[], now: Date): FleetStats {
  const withAgent = fleet.filter((n) => n.agent.kind === "ok");
  const counted = withAgent.flatMap((n) =>
    n.checks.filter((c) => c.severity !== "info"),
  );
  const since = now.getTime() - DAY_MS;
  const recent = withAgent
    .flatMap((nas) => nas.tasks.map((t) => ({ nas, t })))
    .filter(
      ({ t }) => !t.running && t.lastRunAt && Date.parse(t.lastRunAt) >= since,
    );
  const succeeded = ({ t }: (typeof recent)[number]) =>
    Boolean(
      t.lastSuccessAt &&
        t.lastRunAt &&
        Date.parse(t.lastSuccessAt) >= Date.parse(t.lastRunAt),
    );
  const firstFailed = recent.find((r) => !succeeded(r));
  let fullest: FleetStats["fullest"] = null;
  for (const nas of withAgent)
    for (const volume of nas.volumes)
      if (!fullest || volume.pct > fullest.volume.pct)
        fullest = { nas, volume };
  return {
    online: {
      n: fleet.filter((n) => nasState(n) !== "offline").length,
      total: fleet.length,
    },
    checks: {
      failed: counted.filter((c) => c.status === "failed").length,
      warning: counted.filter((c) => c.status === "warning").length,
      agentNas: withAgent.length,
    },
    backups: {
      ok: recent.filter(succeeded).length,
      considered: recent.length,
      failed: firstFailed
        ? { nas: firstFailed.nas, task: firstFailed.t.name }
        : null,
    },
    fullest,
  };
}

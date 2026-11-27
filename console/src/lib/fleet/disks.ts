import { type Locale, tr } from "@/i18n";
// Disques vus par l'agent (état, verdict de santé) et par Beszel (heures de marche, test
// S.M.A.R.T.) : rapprochés par le nom du périphérique, puis par modèle et capacité. Un disque
// que seul Beszel voit reste affiché.

import type { BeszelDisk } from "@/lib/beszel/map";
import type { Disk, DiskWear } from "./types";

export interface DiskPair {
  agent: Disk | null;
  beszel: BeszelDisk | null;
}

function sameModelAndSize(a: Disk, b: BeszelDisk): boolean {
  if (!a.model || !b.model || a.model !== b.model) return false;
  if (a.sizeBytes == null || b.capacityBytes == null) return false;
  return Math.abs(a.sizeBytes - b.capacityBytes) / a.sizeBytes <= 0.01;
}

export function matchDisks(agent: Disk[], beszel: BeszelDisk[]): DiskPair[] {
  const free = [...beszel];
  const take = (pred: (b: BeszelDisk) => boolean) => {
    const i = free.findIndex(pred);
    return i < 0 ? null : free.splice(i, 1)[0];
  };
  const pairs: DiskPair[] = agent.map((d) => ({
    agent: d,
    beszel: d.device ? take((b) => b.device === d.device) : null,
  }));
  for (const p of pairs) {
    if (!p.beszel && p.agent) {
      const d = p.agent;
      p.beszel = take((b) => sameModelAndSize(d, b));
    }
  }
  return [...pairs, ...free.map((b) => ({ agent: null, beszel: b }))];
}

/** Verdict d'un disque : celui de l'agent quand il le lit ; vu par Beszel seul, rouge
 * seulement si le test S.M.A.R.T. échoue, gris s'il n'en dit rien. */
export function diskVerdict(
  pair: DiskPair,
  lang: Locale,
): {
  tone: "ok" | "warn" | "crit" | "off";
  label: string;
} {
  const healthy = tr(lang, { en: "Healthy", fr: "Sain" });
  // Le contrôle « Disques qui faiblissent » de l'agent nomme le disque : son verdict d'abord.
  const wear = pair.agent?.wear?.status;
  if (wear === "failed")
    return {
      tone: "crit",
      label: tr(lang, { en: "Weakening", fr: "Faiblit" }),
    };
  if (wear === "warning")
    return {
      tone: "warn",
      label: tr(lang, { en: "Watch", fr: "À surveiller" }),
    };
  if (pair.agent)
    return pair.agent.healthy
      ? { tone: "ok", label: healthy }
      : {
          tone: "crit",
          label: tr(lang, { en: "In bad health", fr: "En mauvais état" }),
        };
  const state = pair.beszel?.state?.toUpperCase();
  if (state === "PASSED") return { tone: "ok", label: healthy };
  if (state === "FAILED")
    return {
      tone: "crit",
      label: tr(lang, {
        en: "S.M.A.R.T. test failed",
        fr: "Test S.M.A.R.T. échoué",
      }),
    };
  return { tone: "off", label: tr(lang, { en: "Unknown", fr: "Inconnu" }) };
}

const TEST_RESULT: Record<string, { en: string; fr: string }> = {
  damage: { en: "attention required", fr: "à vérifier" },
  aborted: { en: "aborted", fr: "interrompu" },
  interrupted: { en: "interrupted", fr: "interrompu" },
  extended_test_suggested: {
    en: "extended test advised",
    fr: "test étendu conseillé",
  },
};

/** Ce que SMART dit de l'usure, seulement ce qui compte ; `null` quand rien n'est à dire. */
export function wearText(w: DiskWear, lang: Locale): string | null {
  const parts: string[] = [];
  const n = (count: number, en: [string, string], fr: [string, string]) =>
    tr(lang, {
      en: `${count} ${count === 1 ? en[0] : en[1]}`,
      fr: `${count} ${count === 1 ? fr[0] : fr[1]}`,
    });
  if (w.reallocated)
    parts.push(
      n(
        w.reallocated,
        ["reallocated sector", "reallocated sectors"],
        ["secteur réalloué", "secteurs réalloués"],
      ),
    );
  if (w.pending)
    parts.push(
      parts.length
        ? n(w.pending, ["pending", "pending"], ["en attente", "en attente"])
        : n(
            w.pending,
            ["pending sector", "pending sectors"],
            ["secteur en attente", "secteurs en attente"],
          ),
    );
  if (w.uncorrectable)
    parts.push(
      n(
        w.uncorrectable,
        ["unreadable sector", "unreadable sectors"],
        ["secteur illisible", "secteurs illisibles"],
      ),
    );
  if (w.crc)
    parts.push(
      n(
        w.crc,
        ["cable error", "cable errors"],
        ["erreur de câble", "erreurs de câble"],
      ),
    );
  if (w.ssdLife != null)
    parts.push(
      tr(lang, {
        en: `${w.ssdLife} % life left`,
        fr: `${w.ssdLife} % de vie restante`,
      }),
    );
  const test = w.lastTest ? TEST_RESULT[w.lastTest] : undefined;
  if (test)
    parts.push(
      tr(lang, {
        en: `last SMART test: ${test.en}`,
        fr: `dernier test SMART : ${test.fr}`,
      }),
    );
  return parts.length ? parts.join(", ") : null;
}

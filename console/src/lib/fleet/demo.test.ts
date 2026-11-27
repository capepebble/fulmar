import { describe, expect, it } from "vitest";
import { DEMO_FLEET, demoFleetAt, demoName } from "./demo";

const NOW = new Date(Date.UTC(2026, 10, 25, 10, 0));

// Accents, guillemets et mots courants du français : rien de tel dans le parc en anglais.
const FRENCH =
  /[éèêàùçôîûâëœ«»]|\b(le|la|les|des|du|une|est|pour|sur|aucun|aucune|avec|sans|ou|et|dans|par|il y a|jours?|tâches?|dossiers?|disques?|coupée?|actif|réussie|jamais|chaque|demain|aujourd'hui)\b/i;

/** Tous les textes d'une valeur, avec leur chemin. */
function texts(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value))
    return value.flatMap((v, i) => texts(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => texts(v, `${path}.${k}`));
  return [];
}

describe("parc de démonstration", () => {
  it("parle anglais sans un mot de français", () => {
    const french = texts(demoFleetAt(NOW, "en")).filter(([, t]) =>
      FRENCH.test(t),
    );
    expect(french).toEqual([]);
  });

  it("garde les mêmes NAS, verdicts et tâches dans les deux langues", () => {
    const en = demoFleetAt(NOW, "en");
    const fr = demoFleetAt(NOW, "fr");
    expect(en.map((n) => n.id)).toEqual(fr.map((n) => n.id));
    for (const [i, nas] of en.entries()) {
      const other = fr[i];
      expect(nas.checks.map((c) => [c.id, c.status])).toEqual(
        other.checks.map((c) => [c.id, c.status]),
      );
      expect(nas.tasks.map((t) => t.result.status)).toEqual(
        other.tasks.map((t) => t.result.status),
      );
      expect(nas.backupLog.length).toBe(other.backupLog.length);
      expect(nas.volumes.map((v) => v.usedBytes)).toEqual(
        other.volumes.map((v) => v.usedBytes),
      );
    }
  });

  it("relie le journal de chaque sauvegarde à sa tâche, dans chaque langue", () => {
    for (const lang of ["en", "fr"] as const) {
      for (const nas of demoFleetAt(NOW, lang)) {
        const names = new Set(nas.tasks.map((t) => t.name));
        for (const entry of nas.backupLog) expect(names).toContain(entry.task);
        for (const task of nas.tasks) expect(task.lastRunAt).not.toBeNull();
      }
    }
  });

  it("écrit les tailles dans la langue de la page", () => {
    const essai = (lang: "en" | "fr") =>
      demoFleetAt(NOW, lang).find((n) => n.id === "essai");
    expect(essai("en")?.volumes[0].total).toBe("10.5 TB");
    expect(essai("fr")?.volumes[0].total).toBe("10,5 To");
  });

  it("nomme chaque NAS dans chaque langue, sans lire l'heure", () => {
    expect(DEMO_FLEET.map((n) => n.id)).toContain("essai");
    expect(demoName("essai", "en")).toBe("Test NAS");
    expect(demoName("essai", "fr")).toBe("NAS d'essai");
    expect(demoName("nope", "en")).toBeUndefined();
  });
});

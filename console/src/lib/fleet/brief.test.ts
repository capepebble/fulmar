import { describe, expect, it } from "vitest";
import { briefTiles, nasVerdict } from "./brief";
import { demoFleetAt } from "./demo";
import type { Check, Nas } from "./types";

const NOW = new Date(Date.UTC(2026, 10, 25, 10, 0));
const TZ = "Europe/Paris";

function nas(id: string, lang: "en" | "fr" = "en"): Nas {
  const found = demoFleetAt(NOW, lang).find((n) => n.id === id);
  if (!found) throw new Error(id);
  return found;
}

/** Le même NAS, ses contrôles retouchés. */
function withChecks(base: Nas, change: (c: Check) => Partial<Check>): Nas {
  return { ...base, checks: base.checks.map((c) => ({ ...c, ...change(c) })) };
}

const tiles = (n: Nas, lang: "en" | "fr" = "en") =>
  briefTiles(n, { now: NOW, tz: TZ, lang });

describe("verdict d'un NAS", () => {
  it("dit « Tout va bien » quand tout ce qu'on suit est vert", () => {
    const v = nasVerdict(nas("atelier"), NOW, TZ, "en");
    expect(v).toMatchObject({ tone: "ok", title: "All good", ring: true });
    expect(v.sub).toBe("All 44 followed checks are green.");
    expect(nasVerdict(nas("atelier", "fr"), NOW, TZ, "fr").title).toBe(
      "Tout va bien",
    );
  });

  it("compte les problèmes à régler, puis ce qui est à surveiller", () => {
    const v = nasVerdict(nas("essai"), NOW, TZ, "en");
    expect(v).toMatchObject({ tone: "crit", ring: true });
    expect(v.title).toBe("5 problems to fix, 10 to watch");
    expect(nasVerdict(nas("essai", "fr"), NOW, TZ, "fr").title).toBe(
      "5 problèmes à régler, 10 à surveiller",
    );
  });

  it("compte ce qui est à surveiller, au singulier comme au pluriel", () => {
    expect(nasVerdict(nas("cabinet"), NOW, TZ, "en").title).toBe(
      "2 things to watch",
    );
    expect(nasVerdict(nas("cabinet", "fr"), NOW, TZ, "fr")).toMatchObject({
      tone: "warn",
      title: "2 points à surveiller",
      sub: "42 contrôles verts sur 44 suivis.",
    });
    const one = withChecks(nas("cabinet", "fr"), (c) =>
      c.status === "warning" && c.id !== "certificates.validity"
        ? { status: "ok" }
        : {},
    );
    expect(nasVerdict(one, NOW, TZ, "fr").title).toBe("1 point à surveiller");
  });

  it("dit d'abord qu'un NAS ne répond plus, sans anneau", () => {
    const v = nasVerdict(nas("entrepot"), NOW, TZ, "en");
    expect(v).toMatchObject({ tone: "crit", ring: false, state: "offline" });
    expect(v.title).toMatch(/^Offline/);
    expect(v.sub).toMatch(/^Last checks read /);
    expect(nasVerdict(nas("entrepot", "fr"), NOW, TZ, "fr").title).toMatch(
      /^Hors ligne/,
    );
  });

  it("dit qu'un NAS sans agent n'a pas de contrôles", () => {
    const v = nasVerdict(nas("bz-demo-cave"), NOW, TZ, "fr");
    expect(v).toMatchObject({ tone: "off", ring: false, title: "Sans agent" });
  });

  it("signale les contrôles qu'on ne suit plus", () => {
    const muted = withChecks(nas("atelier", "fr"), (c) =>
      c.id === "access.ssh" ? { followed: false } : {},
    );
    expect(nasVerdict(muted, NOW, TZ, "fr").sub).toBe(
      "Les 43 contrôles suivis sont verts · 1 contrôle n'est plus suivi.",
    );
  });
});

describe("tuiles de la fiche en bref", () => {
  it("montre six tuiles quand l'agent répond, dans l'ordre de lecture", () => {
    expect(tiles(nas("cabinet")).map((t) => t.id)).toEqual([
      "backup",
      "storage",
      "updates",
      "security",
      "ups",
      "machine",
    ]);
  });

  it("ne garde que le stockage et la machine sans agent", () => {
    expect(tiles(nas("bz-demo-cave")).map((t) => t.id)).toEqual([
      "storage",
      "machine",
    ]);
  });

  it("dit un mot par tuile quand tout va bien", () => {
    const byId = Object.fromEntries(
      tiles(nas("atelier", "fr"), "fr").map((t) => [t.id, t]),
    );
    expect(byId.backup).toMatchObject({ tone: "ok", value: "À jour" });
    expect(byId.backup.line).toMatch(/^dernière /);
    expect(byId.updates).toMatchObject({ tone: "ok", value: "À jour" });
    expect(byId.security).toMatchObject({ tone: "ok", value: "Conforme" });
    expect(byId.ups).toMatchObject({ tone: "ok", value: "En place" });
    expect(byId.storage).toMatchObject({ value: "41\u202f%", meter: 41.2 });
    expect(byId.storage.line).toBe("2 disques sains");
    // Depuis le 2026-11-26, la tuile Machine prend le ton des contrôles Système et Conteneurs.
    expect(byId.machine.tone).toBe("ok");
  });

  it("nomme ce qui ne va pas, le plus grave d'abord", () => {
    const n = withChecks(nas("atelier"), (c) =>
      c.id === "access.ssh"
        ? { status: "warning" }
        : c.id === "access.firewall"
          ? { status: "failed" }
          : c.id === "certificates.validity"
            ? { status: "warning" }
            : {},
    );
    const security = tiles(n).find((t) => t.id === "security");
    expect(security).toMatchObject({
      tone: "crit",
      value: "Failed",
      line: "Firewall, SSH +1",
    });
  });

  it("nomme la tâche de sauvegarde en échec", () => {
    const backup = tiles(nas("essai")).find((t) => t.id === "backup");
    expect(backup?.tone).toBe("crit");
    expect(backup?.value).toBe("Failed");
    expect(backup?.line).toContain(nas("essai").tasks[0].name);
  });

  it("dit le disque en mauvais état avant tout le reste", () => {
    const base = nas("cabinet");
    const sick = {
      ...base,
      disks: base.disks.map((d, i) => (i === 2 ? { ...d, healthy: false } : d)),
    };
    expect(tiles(sick).find((t) => t.id === "storage")?.line).toBe(
      "1 disk in poor health",
    );
  });

  it("donne la date de remplissage quand elle se calcule", () => {
    const storage = briefTiles(nas("cabinet", "fr"), {
      now: NOW,
      tz: TZ,
      lang: "fr",
      forecast: { kind: "date", at: "2027-03-12T12:00:00Z" },
    }).find((t) => t.id === "storage");
    expect(storage?.line).toBe("plein vers le 12 mars 2027");
  });

  it("donne la version de DSM qui attend", () => {
    const base = nas("atelier", "fr");
    const n = withChecks(
      {
        ...base,
        dsmUpdate: {
          current: "7.2.2",
          checkOk: true,
          available: "7.3",
          major: null,
          auto: "",
        },
      },
      (c) => (c.id === "updates.dsm" ? { status: "warning" } : {}),
    );
    expect(tiles(n, "fr").find((t) => t.id === "updates")).toMatchObject({
      tone: "warn",
      value: "À surveiller",
      line: "DSM 7.3 disponible",
    });
  });

  it("n'écrit pas DSM deux fois", () => {
    const base = nas("atelier", "fr");
    const n = {
      ...base,
      dsmUpdate: {
        current: "DSM 7.4.1-90080 Update 2",
        checkOk: true,
        available: null,
        major: null,
        auto: "",
      },
    };
    expect(tiles(n, "fr").find((t) => t.id === "updates")?.line).toBe(
      "DSM 7.4.1-90080 Update 2",
    );
  });

  it("ne dit pas « Pas de mesure » sous une température lue", () => {
    const base = nas("atelier", "fr");
    const n = { ...base, vitals: { ...base.vitals, cpu: null, ram: null } };
    expect(tiles(n, "fr").find((t) => t.id === "machine")).toMatchObject({
      value: expect.stringMatching(/°C$/),
      line: "Température du système",
    });
  });

  it("parle anglais sans un mot de français", () => {
    for (const id of ["essai", "cabinet", "atelier", "entrepot"]) {
      for (const t of tiles(nas(id)))
        expect(`${t.label} ${t.value} ${t.line}`).not.toMatch(
          /[éèàù]|\b(disques?|dernière|aucune?|plein|libres)\b/i,
        );
    }
  });
});

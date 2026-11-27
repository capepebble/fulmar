import { describe, expect, test } from "vitest";
import { makeCheck, makeNas, makeTask } from "@/test/nas";
import { fleetIssues } from "./issues";

const up = {
  kind: "ok",
  systemId: "s",
  lastAt: "2026-11-21T09:00:00Z",
} as const;
const down = (lastReadAt: string | null = null) =>
  ({ kind: "down", reason: "agent injoignable", lastReadAt }) as const;

describe("points à traiter", () => {
  test("l'accessibilité passe avant les échecs, puis gravité, puis ancienneté", () => {
    const fleet = [
      makeNas({
        id: "a",
        checks: [
          makeCheck({ id: "w", status: "warning", severity: "high" }),
          makeCheck({ id: "m", status: "failed", severity: "medium" }),
          makeCheck({ id: "h-new", status: "failed", severity: "high" }),
          makeCheck({ id: "h-old", status: "failed", severity: "high" }),
          makeCheck({ id: "i", status: "failed", severity: "info" }),
          makeCheck({ id: "u", status: "unknown" }),
          makeCheck({ id: "ok" }),
        ],
        seen: {
          "h-new": "2026-11-20T10:00:00Z",
          "h-old": "2026-11-09T10:00:00Z",
        },
      }),
      makeNas({ id: "down", agent: down(), beszel: up }),
      makeNas({
        id: "denied",
        agent: { kind: "denied", reason: "401", lastReadAt: null },
      }),
      makeNas({ id: "off", agent: down() }),
    ];
    const issues = fleetIssues(fleet, "fr");
    expect(issues.map((i) => [i.nas.id, i.level, i.checkId])).toEqual([
      ["off", "offline", null],
      ["denied", "denied", null],
      ["down", "agent_down", null],
      ["a", "failed", "h-old"],
      ["a", "failed", "h-new"],
      ["a", "failed", "m"],
      ["a", "warning", "w"],
    ]);
  });

  test("textes exacts de l'accessibilité", () => {
    const byId = (id: string, nas: Parameters<typeof makeNas>[0]) =>
      fleetIssues([makeNas({ id, ...nas })], "fr")[0];
    expect(
      byId("a", {
        agent: down(),
        beszel: { kind: "down", systemId: "s", lastAt: null, reason: "x" },
      }),
    ).toMatchObject({
      title: "Le NAS ne répond plus",
      todo: "Ni l'agent ni Beszel ne répondent. Vérifier le courant et la connexion du site.",
    });
    expect(
      byId("b", {
        agent: { kind: "none" },
        beszel: { kind: "down", systemId: "s", lastAt: null, reason: "x" },
      }),
    ).toMatchObject({
      title: "Le NAS ne répond plus",
      todo: "Beszel ne le voit plus. Vérifier le courant et la connexion du site.",
    });
    expect(byId("c", { agent: down() })).toMatchObject({
      title: "Le NAS ne répond plus",
      todo: "L'agent ne répond pas. Vérifier le courant et la connexion du site.",
    });
    expect(byId("d", { agent: down(), beszel: up })).toMatchObject({
      title: "L'agent ne répond plus",
      todo: "Le NAS tourne (Beszel le voit), mais ses contrôles ne sont pas lus. Vérifier le conteneur de l'agent.",
    });
    expect(
      byId("e", { agent: { kind: "denied", reason: "401", lastReadAt: null } }),
    ).toMatchObject({
      title: "L'agent refuse la console",
      todo: "Jeton expiré, révoqué ou adresse non admise : renouveler le jeton de la console.",
    });
  });

  test("hors ligne depuis la dernière donnée reçue, la plus récente des deux sources", () => {
    const [issue] = fleetIssues(
      [
        makeNas({
          agent: down("2026-11-21T08:00:00Z"),
          beszel: {
            kind: "down",
            systemId: "s",
            lastAt: "2026-11-21T08:34:00Z",
            reason: "x",
          },
        }),
      ],
      "fr",
    );
    expect(issue.since).toEqual({
      label: "depuis",
      at: "2026-11-21T08:34:00Z",
    });
  });

  test("une sauvegarde en échec dit depuis sa dernière réussite", () => {
    const [issue] = fleetIssues(
      [
        makeNas({
          checks: [
            makeCheck({
              id: "backup.last_result",
              category: "backup",
              status: "failed",
              items: ["Essai en échec : failed"],
              advice: "Ouvrir Hyper Backup.",
            }),
          ],
          tasks: [
            makeTask({
              name: "Essai local",
              lastSuccessAt: "2026-11-21T02:00:00.000Z",
            }),
            makeTask({
              name: "Essai en échec",
              result: { status: "failed", text: "x" },
              lastSuccessAt: "2026-11-08T15:57:38.000Z",
            }),
          ],
          seen: { "backup.last_result": "2026-11-09T10:00:00Z" },
        }),
      ],
      "fr",
    );
    expect(issue.since).toEqual({
      label: "depuis",
      at: "2026-11-08T15:57:38.000Z",
    });
    expect(issue.todo).toBe("Ouvrir Hyper Backup.");
  });

  test("les autres points disent vu le, d'après la mémoire", () => {
    const [seen, unseen] = fleetIssues(
      [
        makeNas({
          checks: [
            makeCheck({ id: "a", status: "failed" }),
            makeCheck({ id: "b", status: "failed" }),
          ],
          seen: { a: "2026-11-09T10:00:00Z" },
        }),
      ],
      "fr",
    );
    expect(seen.since).toEqual({ label: "vu le", at: "2026-11-09T10:00:00Z" });
    expect(unseen.since).toBeNull();
  });

  test("un NAS Sans agent ne crée aucun point tant que Beszel le voit", () => {
    expect(
      fleetIssues([makeNas({ agent: { kind: "none" }, beszel: up })], "fr"),
    ).toEqual([]);
  });
});

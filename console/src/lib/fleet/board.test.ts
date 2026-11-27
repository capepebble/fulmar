import { describe, expect, test } from "vitest";
import { makeCheck, makeNas } from "@/test/nas";
import { boardItem, stateGroup } from "./board";

describe("la vue du parc", () => {
  test("quatre groupes d'état, du rouge au vert", () => {
    expect(stateGroup("failed")).toBe("failed");
    expect(stateGroup("warning")).toBe("watch");
    expect(stateGroup("unknown")).toBe("watch");
    expect(stateGroup("offline")).toBe("unreachable");
    expect(stateGroup("agent_down")).toBe("unreachable");
    expect(stateGroup("denied")).toBe("unreachable");
    expect(stateGroup("ok")).toBe("ok");
    expect(stateGroup("beszel_only")).toBe("ok");
  });

  test("une ligne : état, voyants, anneau et constantes, sans texte venu du NAS en plus", () => {
    const item = boardItem(
      makeNas({
        id: "essai",
        name: "NAS d'essai",
        checks: [makeCheck({ status: "failed" })],
      }),
      "fr",
    );
    expect(item).toMatchObject({
      id: "essai",
      state: "failed",
      group: "failed",
      rank: 1,
      green: { ok: 0, total: 1 },
    });
    expect(item.lights.map((l) => [l.id, l.light])).toEqual([
      ["access", "failed"],
    ]);
  });
});

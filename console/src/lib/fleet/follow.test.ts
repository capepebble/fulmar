import { describe, expect, test } from "vitest";
import { makeCheck, makeNas } from "@/test/nas";
import { applyFollow, isFollowed } from "./follow";
import { fleetIssues } from "./issues";
import { checkCounts, nasState } from "./state";

const ups = makeCheck({
  id: "ups.configured",
  category: "ups",
  severity: "medium",
  status: "warning",
});
const firewall = makeCheck({ id: "access.firewall", status: "ok" });

describe("le suivi choisi", () => {
  test("un contrôle se suit sauf s'il est retiré sur ce NAS ou sur tout le parc", () => {
    const rules = [
      { scope: "essai", checkId: "ups.configured" },
      { scope: "*", checkId: "shares.recycle_bin" },
    ];
    expect(isFollowed(rules, "essai", "ups.configured")).toBe(false);
    expect(isFollowed(rules, "autre", "ups.configured")).toBe(true);
    expect(isFollowed(rules, "autre", "shares.recycle_bin")).toBe(false);
    expect(isFollowed(rules, "essai", "access.firewall")).toBe(true);
  });

  test("ce qu'on ne suit plus ne colore plus le NAS : tout ce qu'on suit est vert, il est vert", () => {
    const nas = makeNas({ id: "essai", checks: [ups, firewall] });
    expect(nasState(nas)).toBe("warning");
    const mine = applyFollow(nas, [
      { scope: "essai", checkId: "ups.configured" },
    ]);
    expect(nasState(mine)).toBe("ok");
    expect(checkCounts(mine)).toMatchObject({ warning: 0, muted: 1 });
    // La lecture reste : seule sa couleur ne compte plus.
    expect(mine.checks.find((c) => c.id === "ups.configured")).toMatchObject({
      status: "warning",
      followed: false,
    });
    expect(
      fleetIssues([mine], "fr").filter((i) => i.checkId === "ups.configured"),
    ).toEqual([]);
  });

  test("sans règle, rien ne change", () => {
    const nas = makeNas({ checks: [ups, firewall] });
    expect(applyFollow(nas, [])).toBe(nas);
  });
});

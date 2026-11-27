import { describe, expect, test } from "vitest";
import { makeCheck, makeNas } from "@/test/nas";
import { applyFollow } from "./follow";
import { greenShare, lights } from "./lights";
import type { CategoryId, Severity, Status } from "./types";

const c = (
  id: string,
  category: CategoryId,
  status: Status,
  severity: Severity = "high",
) => makeCheck({ id, category, status, severity });

describe("les voyants d'un NAS", () => {
  const nas = makeNas({
    id: "essai",
    checks: [
      c("access.firewall", "access", "failed"),
      c("access.ssh", "access", "warning", "medium"),
      c("backup.last_result", "backup", "ok"),
      c("ups.configured", "ups", "warning", "medium"),
      c("shares.recycle_bin", "shares", "warning", "info"),
      c("storage.disks", "storage", "unknown"),
    ],
  });

  test("un voyant par catégorie présente, dans l'ordre de lecture ; rien pour ce qui n'existe pas", () => {
    expect(lights(nas).map((l) => [l.id, l.light])).toEqual([
      ["backup", "ok"],
      ["storage", "unknown"],
      ["access", "failed"],
      ["ups", "warning"],
      // « À titre indicatif » : vu, mais ne colore pas.
      ["shares", "ok"],
    ]);
  });

  test("un voyant dont on ne suit plus rien est creux", () => {
    const mine = applyFollow(nas, [{ scope: "*", checkId: "ups.configured" }]);
    expect(lights(mine).find((l) => l.id === "ups")?.light).toBe("muted");
  });

  test("l'anneau : la part de vert sur ce qu'on suit, « à titre indicatif » exclus", () => {
    expect(greenShare(nas)).toEqual({ ok: 1, total: 5 });
    const mine = applyFollow(nas, [
      { scope: "essai", checkId: "access.firewall" },
      { scope: "essai", checkId: "access.ssh" },
      { scope: "essai", checkId: "ups.configured" },
      { scope: "essai", checkId: "storage.disks" },
    ]);
    expect(greenShare(mine)).toEqual({ ok: 1, total: 1 });
  });
});

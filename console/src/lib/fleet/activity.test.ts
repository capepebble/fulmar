import { describe, expect, it } from "vitest";
import { groupRepeats } from "./activity";
import type { ActivityEvent } from "./types";

const ssh = (time: string): ActivityEvent => ({
  day: "Aujourd'hui",
  time,
  level: "ok",
  source: "connections",
  who: "claude",
  text: "User [claude] logged in successfully via [SSH].",
});

describe("groupRepeats", () => {
  it("regroupe les lignes identiques qui se suivent, de la plus récente à la plus ancienne", () => {
    const other: ActivityEvent = {
      ...ssh("21:25"),
      source: "settings",
      who: "SYSTEM_ADMIN",
      text: "System successfully enabled File Station transfer log.",
    };
    expect(
      groupRepeats([
        ssh("21:27"),
        ssh("21:26"),
        ssh("21:25"),
        other,
        ssh("21:25"),
      ]),
    ).toEqual([
      { ...ssh("21:27"), count: 3, since: "21:25" },
      { ...other, count: 1, since: "21:25" },
      { ...ssh("21:25"), count: 1, since: "21:25" },
    ]);
  });

  it("ne regroupe pas d'un jour à l'autre ni entre comptes", () => {
    const yesterday = { ...ssh("23:59"), day: "Hier" };
    const other = { ...ssh("21:26"), who: "paul" };
    expect(
      groupRepeats([ssh("21:27"), other, ssh("0:01"), yesterday]).map(
        (e) => e.count,
      ),
    ).toEqual([1, 1, 1, 1]);
  });
});

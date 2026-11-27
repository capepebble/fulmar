import { describe, expect, it } from "vitest";
import {
  changePath,
  demoWatch,
  mapServiceWatch,
  mapWatch,
  watchError,
} from "./close-access";

const SSH = {
  service: "ssh",
  open: true,
  open_since: "2026-11-26T14:00:00+00:00",
  deadline: "2026-11-26T15:00:00+00:00",
  closed_at: null,
  checked_at: "2026-11-26T14:20:00+00:00",
  policy: { mode: "close", minutes: 60 },
};

describe("mapWatch", () => {
  it("lit les deux accès et le droit d'agir", () => {
    const view = mapWatch({
      watching: true,
      can_act: true,
      services: [
        SSH,
        {
          ...SSH,
          service: "telnet",
          open: false,
          deadline: null,
          policy: { mode: "off", minutes: 60 },
        },
        { ...SSH, service: "ftp" },
      ],
    });
    expect(view.kind).toBe("ok");
    if (view.kind !== "ok") return;
    expect(view.canAct).toBe(true);
    expect(view.services.map((s) => s.service)).toEqual(["ssh", "telnet"]);
    expect(view.services[0]).toMatchObject({
      open: true,
      deadline: "2026-11-26T15:00:00+00:00",
      mode: "close",
      minutes: 60,
    });
  });

  it("ne fait confiance à rien de douteux", () => {
    const view = mapWatch({
      can_act: "yes",
      services: [{ ...SSH, policy: { mode: "explode", minutes: -3 } }],
    });
    if (view.kind !== "ok") throw new Error("ok attendu");
    expect(view.canAct).toBe(false);
    expect(view.services[0]).toMatchObject({ mode: "off", minutes: 60 });
    expect(mapServiceWatch({ service: "ssh" })?.open).toBeNull();
    expect(mapServiceWatch({ service: "http" })).toBeNull();
  });
});

describe("watchError et démonstration", () => {
  it("un agent ancien, un droit manquant", () => {
    expect(watchError(404, "x", "fr").kind).toBe("old");
    expect(watchError(403, "x", "fr").kind).toBe("denied");
  });

  it("un exemple sans geste", () => {
    const view = demoWatch(new Date("2026-11-26T14:20:00Z"));
    expect(view.canAct).toBe(false);
    expect(view.demo).toBe(true);
    expect(view.services[0].open).toBe(true);
  });
});

describe("changePath", () => {
  it("ne laisse passer que les gestes prévus, revérifiés", () => {
    expect(changePath("ssh", { kind: "close" })).toBe(
      "/access/close?service=ssh",
    );
    expect(changePath("telnet", { kind: "extend", minutes: 60 })).toBe(
      "/access/extend?service=telnet&minutes=60",
    );
    expect(
      changePath("ssh", { kind: "policy", mode: "close", minutes: 120 }),
    ).toBe("/access/policy?service=ssh&mode=close&minutes=120");
    expect(changePath("http", { kind: "close" })).toBeNull();
    expect(changePath("ssh", { kind: "open" })).toBeNull();
    expect(changePath("ssh", { kind: "extend", minutes: 7 })).toBeNull();
    expect(
      changePath("ssh", { kind: "policy", mode: "close", minutes: 15 }),
    ).toBe("/access/policy?service=ssh&mode=close&minutes=15");
    expect(
      changePath("ssh", { kind: "policy", mode: "open", minutes: 60 }),
    ).toBeNull();
    expect(changePath("ssh&x=1", { kind: "close" })).toBeNull();
  });
});

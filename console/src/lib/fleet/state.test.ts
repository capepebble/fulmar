import { describe, expect, test } from "vitest";
import { makeCheck, makeNas } from "@/test/nas";
import {
  byState,
  checkCounts,
  NAS_STATE_LABEL,
  NAS_STATE_ORDER,
  type NasState,
  nasState,
} from "./state";

const up = {
  kind: "ok",
  systemId: "s1",
  lastAt: "2026-11-21T09:00:00Z",
} as const;
const gone = {
  kind: "down",
  systemId: "s1",
  lastAt: "2026-11-21T06:00:00Z",
  reason: "Beszel ne voit plus le NAS",
} as const;
const agentDown = {
  kind: "down",
  reason: "agent injoignable",
  lastReadAt: null,
} as const;

describe("état d'un NAS", () => {
  test("ordre des états", () =>
    expect(NAS_STATE_ORDER).toEqual([
      "offline",
      "failed",
      "denied",
      "agent_down",
      "warning",
      "unknown",
      "beszel_only",
      "ok",
    ]));

  test("le tri suit cet ordre", () => {
    const states: NasState[] = [
      "ok",
      "beszel_only",
      "warning",
      "offline",
      "denied",
      "failed",
      "unknown",
      "agent_down",
    ];
    const make = (s: NasState) => {
      switch (s) {
        case "offline":
          return makeNas({ id: s, agent: agentDown, beszel: gone });
        case "agent_down":
          return makeNas({ id: s, agent: agentDown, beszel: up });
        case "denied":
          return makeNas({
            id: s,
            agent: { kind: "denied", reason: "401", lastReadAt: null },
          });
        case "beszel_only":
          return makeNas({ id: s, agent: { kind: "none" }, beszel: up });
        case "ok":
          return makeNas({ id: s, checks: [makeCheck()] });
        default:
          return makeNas({ id: s, checks: [makeCheck({ status: s })] });
      }
    };
    const sorted = states.map(make).sort(byState).map(nasState);
    expect(sorted).toEqual(NAS_STATE_ORDER);
  });

  test("agent muet et Beszel muet : hors ligne", () =>
    expect(
      nasState(makeNas({ agent: agentDown, beszel: { kind: "none" } })),
    ).toBe("offline"));
  test("agent muet, Beszel le voit : agent injoignable", () =>
    expect(nasState(makeNas({ agent: agentDown, beszel: up }))).toBe(
      "agent_down",
    ));
  test("sans agent : Sans agent tant que Beszel le voit, sinon hors ligne", () => {
    expect(nasState(makeNas({ agent: { kind: "none" }, beszel: up }))).toBe(
      "beszel_only",
    );
    expect(nasState(makeNas({ agent: { kind: "none" }, beszel: gone }))).toBe(
      "offline",
    );
  });
  test("hub Beszel muet : un NAS sans agent est inconnu, pas hors ligne", () =>
    expect(
      nasState(
        makeNas({
          agent: { kind: "none" },
          beszel: {
            kind: "down",
            systemId: "s1",
            lastAt: null,
            reason: "Beszel injoignable",
            hub: true,
          },
        }),
      ),
    ).toBe("unknown"));
  test("les contrôles à titre indicatif ne comptent pas", () =>
    expect(
      nasState(
        makeNas({
          checks: [
            makeCheck({ severity: "info", status: "failed" }),
            makeCheck(),
          ],
        }),
      ),
    ).toBe("ok"));
  test("un contrôle inconnu rend le NAS inconnu", () =>
    expect(
      nasState(
        makeNas({ checks: [makeCheck(), makeCheck({ status: "unknown" })] }),
      ),
    ).toBe("unknown"));
  test("libellés", () => {
    expect(NAS_STATE_LABEL.beszel_only.fr).toBe("Sans agent");
    expect(NAS_STATE_LABEL.agent_down.fr).toBe("Agent injoignable");
    expect(NAS_STATE_LABEL.agent_down.en).toBe("Agent unreachable");
  });
});

test("comptes des contrôles, les mêmes partout : l'indicatif à part", () =>
  expect(
    checkCounts(
      makeNas({
        checks: [
          makeCheck({ status: "failed" }),
          makeCheck({ id: "b", status: "warning" }),
          makeCheck({ id: "c", status: "warning", severity: "info" }),
          makeCheck({ id: "d" }),
          makeCheck({ id: "e", status: "unknown" }),
        ],
      }),
    ),
  ).toEqual({ failed: 1, warning: 1, ok: 1, unknown: 1, info: 1, muted: 0 }));

import { describe, expect, test } from "vitest";
import {
  DEVICE_ID,
  demoPhones,
  mapOffer,
  mapPhones,
  phonesError,
  qrPath,
} from "./phones";

const ID = "a".repeat(32);

describe("mapPhones", () => {
  test("lit devices.list, sans faire confiance", () => {
    const view = mapPhones(
      {
        nas: "n",
        relay: {
          configured: true,
          joined: true,
          relay_host: "api.nasrelay.com",
          direct_urls: ["https://nas-agent-x.ts.net", 4],
          last_deposit_at: "2026-11-23T10:00:00Z",
          last_error: null,
        },
        pairing: { open: true, expires_at: "2026-11-23T10:10:00Z" },
        devices: [
          {
            id: ID,
            name: "Pixel\u0007 de Marc",
            via: "relay",
            paired_at: "2026-11-20T08:00:00Z",
            last_read_at: null,
          },
          {
            id: "pas-un-id",
            name: "x",
            via: "relay",
            paired_at: "2026-11-20T08:00:00Z",
          },
          {
            id: "b".repeat(32),
            name: "",
            via: "autre",
            paired_at: "2026-11-21T08:00:00Z",
            last_read_at: "2026-11-23T09:00:00Z",
          },
          { id: "c".repeat(32), name: "sans date" },
        ],
      },
      "fr",
    );
    expect(view.relay).toEqual({
      configured: true,
      joined: true,
      host: "api.nasrelay.com",
      directUrls: ["https://nas-agent-x.ts.net"],
      lastDepositAt: "2026-11-23T10:00:00Z",
      lastError: null,
    });
    expect(view.pairing).toEqual({
      open: true,
      expiresAt: "2026-11-23T10:10:00Z",
    });
    expect(view.phones.map((p) => [p.name, p.via])).toEqual([
      ["Pixel  de Marc", "relay"],
      ["Téléphone", "direct"],
    ]);
  });

  test("une réponse informe donne une liste vide, jamais une erreur", () => {
    expect(mapPhones(null, "fr")).toMatchObject({
      kind: "ok",
      phones: [],
      relay: { configured: false, joined: false },
    });
  });
});

describe("phonesError", () => {
  test("droit manquant, agent ancien, agent injoignable", () => {
    expect(phonesError(403, "403", "fr").kind).toBe("denied");
    expect(phonesError(404, "404", "fr").kind).toBe("old");
    expect(phonesError(undefined, "agent injoignable", "fr")).toEqual({
      kind: "down",
      reason: "agent injoignable",
    });
  });

  test("moteur sans le relais : les téléphones viennent avec l'appli", () => {
    const fr = phonesError(501, "501", "fr");
    const en = phonesError(501, "501", "en");
    expect(fr.kind).toBe("absent");
    expect(fr.kind !== "ok" && fr.reason).toContain("appli Fulmar");
    expect(en.kind !== "ok" && en.reason).toContain("Fulmar app");
  });
});

describe("mapOffer", () => {
  const square = (n: number) =>
    Array.from({ length: n }, (_, y) =>
      "01".repeat(n).slice(y % 2, (y % 2) + n),
    );

  test("offre valide", () => {
    const offer = mapOffer({
      code_id: "c",
      uri: "nasrelay://pair?v=1&n=x",
      modules: square(21),
      expires_at: "2026-11-23T10:10:00Z",
      relay: true,
      direct_urls: ["https://a"],
    });
    expect(offer?.modules).toHaveLength(21);
    expect(offer?.relay).toBe(true);
  });

  test("refus : autre schéma, modules non carrés ou qui ne sont pas des 0 et des 1", () => {
    const base = {
      uri: "nasrelay://pair?v=1",
      modules: square(21),
      expires_at: "t",
    };
    expect(mapOffer({ ...base, uri: "https://evil.example" })).toBeNull();
    expect(mapOffer({ ...base, modules: square(21).slice(1) })).toBeNull();
    expect(
      mapOffer({ ...base, modules: [...square(20), "2".repeat(21)] }),
    ).toBeNull();
    expect(mapOffer({ ...base, modules: square(10) })).toBeNull();
    expect(mapOffer({ ...base, expires_at: null })).toBeNull();
  });
});

describe("qrPath", () => {
  test("suites de modules sombres fondues, marge comprise", () => {
    expect(qrPath(["110", "011"], 1)).toBe("M1 1h2v1h-2zM2 2h2v1h-2z");
    expect(qrPath(["000"], 4)).toBe("");
  });
});

test("les téléphones fictifs ont des identifiants valides et le dire", () => {
  const demo = demoPhones(new Date("2026-11-23T10:00:00Z"), "fr");
  expect(
    demo.phones.every((p) => DEVICE_ID.test(p.id) && p.name.includes("fictif")),
  ).toBe(true);
});

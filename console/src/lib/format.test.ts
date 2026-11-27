import { describe, expect, test } from "vitest";
import { ago, formatPct, formatRate, formatTemp, plural } from "./format";

describe("nombres à la française", () => {
  test("pourcentages, espace fine insécable", () => {
    expect(formatPct(1.06, "fr")).toBe("1\u202f%");
    expect(formatPct(43.71, "fr", 1)).toBe("43,7\u202f%");
    expect(formatPct(null, "fr")).toBe("–");
  });
  test("températures", () => {
    expect(formatTemp(35, "fr")).toBe("35\u202f°C");
    expect(formatTemp(null, "fr")).toBe("–");
  });
  test("débits", () => {
    expect(formatRate(2051, "fr")).toBe("2\u202fKo/s");
    expect(formatRate(1_850_000, "fr")).toBe("1,8\u202fMo/s");
    expect(formatRate(null, "fr")).toBe("–");
  });
  test("durées et accords", () => {
    expect(ago(0, "fr")).toBe("à l'instant");
    expect(ago(4, "fr")).toBe("il y a 4 min");
    expect(ago(192, "fr")).toBe("il y a 3 h 12");
    expect(plural(0, "NAS", "NAS", "fr")).toBe("0 NAS");
    expect(plural(1, "contrôle", "contrôles", "fr")).toBe("1 contrôle");
    expect(plural(0, "contrôle", "contrôles", "fr")).toBe("0 contrôle");
  });
});

describe("numbers in English", () => {
  test("percentages, temperatures, rates", () => {
    expect(formatPct(43.71, "en", 1)).toBe("43.7%");
    expect(formatTemp(35, "en")).toBe("35 °C");
    expect(formatRate(1_850_000, "en")).toBe("1.8 MB/s");
  });
  test("durations and plurals", () => {
    expect(ago(0, "en")).toBe("just now");
    expect(ago(4, "en")).toBe("4 min ago");
    expect(ago(192, "en")).toBe("3 h 12 min ago");
    expect(plural(0, "check", "checks", "en")).toBe("0 checks");
    expect(plural(1, "check", "checks", "en")).toBe("1 check");
    expect(plural(1200, "check", "checks", "en")).toBe("1,200 checks");
  });
});

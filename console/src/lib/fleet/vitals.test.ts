import { describe, expect, it } from "vitest";
import type { Volume } from "./types";
import { fullestVolume } from "./vitals";

const volume = (path: string, pct: number): Volume => ({
  id: null,
  path,
  fs: "btrfs",
  raid: "SHR",
  pct,
  used: "1 To",
  total: "4 To",
  status: "normal",
  totalBytes: null,
  usedBytes: null,
});

describe("fullestVolume", () => {
  it("rend null quand aucun volume n'est lu (stockage illisible)", () => {
    expect(fullestVolume([])).toBeNull();
  });

  it("rend le volume le plus rempli", () => {
    const v2 = volume("/volume2", 91);
    expect(
      fullestVolume([volume("/volume1", 40), v2, volume("/volume3", 12)]),
    ).toBe(v2);
  });
});

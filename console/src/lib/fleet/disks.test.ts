import { describe, expect, test } from "vitest";
import type { BeszelDisk } from "@/lib/beszel/map";
import { diskVerdict, matchDisks, wearText } from "./disks";
import type { Disk } from "./types";

const disk = (over: Partial<Disk>): Disk => ({
  bay: 1,
  healthy: true,
  size: "10,9 To",
  temp: 31,
  smart: "normal",
  status: "normal",
  device: "sata1",
  model: "ST12000NM001G-2MV103",
  hours: null,
  sizeBytes: 12_000_138_625_024,
  ...over,
});
const bz = (over: Partial<BeszelDisk>): BeszelDisk => ({
  device: "sata1",
  model: "ST12000NM001G-2MV103",
  state: "PASSED",
  temp: 31,
  hours: 46880,
  capacityBytes: 12_000_138_625_024,
  ...over,
});

describe("disques de l'agent et de Beszel", () => {
  test("par le nom du périphérique", () => {
    const m = matchDisks([disk({})], [bz({})]);
    expect(m).toHaveLength(1);
    expect(m[0].agent?.device).toBe("sata1");
    expect(m[0].beszel?.hours).toBe(46880);
  });

  test("puis par modèle et capacité", () => {
    const m = matchDisks(
      [
        disk({ device: "sda", bay: 1 }),
        disk({ device: "sdb", bay: 2, model: "WD80EFAX" }),
      ],
      [bz({ device: "sata9" })],
    );
    expect(m.map((x) => [x.agent?.device, x.beszel?.device ?? null])).toEqual([
      ["sda", "sata9"],
      ["sdb", null],
    ]);
  });

  test("un disque que seul Beszel voit reste affiché", () => {
    const m = matchDisks([], [bz({ device: "nvme0n1", model: "Samsung" })]);
    expect(m).toEqual([
      { agent: null, beszel: expect.objectContaining({ device: "nvme0n1" }) },
    ]);
  });

  test("un même disque de Beszel ne sert qu'une fois", () => {
    const m = matchDisks(
      [disk({ device: "sda" }), disk({ device: "sdb", bay: 2 })],
      [bz({ device: "x" })],
    );
    expect(m.filter((x) => x.beszel)).toHaveLength(1);
  });
});

describe("verdict d'un disque", () => {
  const fr = (pair: Parameters<typeof diskVerdict>[0]) =>
    diskVerdict(pair, "fr");
  test("celui de l'agent quand il le lit", () => {
    expect(fr({ agent: disk({}), beszel: bz({ state: "FAILED" }) })).toEqual({
      tone: "ok",
      label: "Sain",
    });
    expect(fr({ agent: disk({ healthy: false }), beszel: null })).toEqual({
      tone: "crit",
      label: "En mauvais état",
    });
  });
  test("vu par Beszel seul : rouge seulement en échec", () => {
    expect(fr({ agent: null, beszel: bz({ state: "PASSED" }) })).toEqual({
      tone: "ok",
      label: "Sain",
    });
    expect(fr({ agent: null, beszel: bz({ state: "FAILED" }) })).toEqual({
      tone: "crit",
      label: "Test S.M.A.R.T. échoué",
    });
    expect(fr({ agent: null, beszel: bz({ state: null }) })).toEqual({
      tone: "off",
      label: "Inconnu",
    });
    expect(fr({ agent: null, beszel: bz({ state: "UNKNOWN" }) })).toEqual({
      tone: "off",
      label: "Inconnu",
    });
  });
  test("en anglais", () => {
    expect(
      diskVerdict({ agent: null, beszel: bz({ state: "FAILED" }) }, "en"),
    ).toEqual({ tone: "crit", label: "S.M.A.R.T. test failed" });
  });
});

describe("usure d'un disque (SMART, 2026-11-26)", () => {
  const wear = (w: Partial<NonNullable<ReturnType<typeof disk>["wear"]>>) => ({
    reallocated: 0,
    pending: 0,
    uncorrectable: 0,
    crc: 0,
    ssdLife: null,
    lastTest: "completed",
    status: null,
    ...w,
  });
  test("le verdict de l'agent passe avant l'état de DSM", () => {
    expect(
      diskVerdict(
        { agent: disk({ wear: wear({ status: "failed" }) }), beszel: null },
        "fr",
      ),
    ).toEqual({ tone: "crit", label: "Faiblit" });
    expect(
      diskVerdict(
        { agent: disk({ wear: wear({ status: "warning" }) }), beszel: null },
        "en",
      ),
    ).toEqual({ tone: "warn", label: "Watch" });
    expect(
      diskVerdict({ agent: disk({ wear: wear({}) }), beszel: null }, "fr"),
    ).toEqual({
      tone: "ok",
      label: "Sain",
    });
  });
  test("ne dit que ce qui compte, dans les deux langues", () => {
    expect(wearText(wear({}), "fr")).toBe(null);
    expect(wearText(wear({ reallocated: 8, pending: 2, crc: 1 }), "fr")).toBe(
      "8 secteurs réalloués, 2 en attente, 1 erreur de câble",
    );
    expect(wearText(wear({ ssdLife: 37 }), "en")).toBe("37 % life left");
    expect(wearText(wear({ lastTest: "damage" }), "en")).toBe(
      "last SMART test: attention required",
    );
  });
});

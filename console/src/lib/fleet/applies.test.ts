import { describe, expect, test } from "vitest";
import { makeNas, makeTask } from "@/test/nas";
import { hasHyperBackup } from "./applies";

const pkg = (name: string) => ({
  name,
  version: "1",
  running: true,
  system: false,
  update: null,
  security: false,
});

describe("ce qui concerne un NAS", () => {
  test("Hyper Backup : des tâches ou le paquet installé ; sans lecture des paquets, on montre", () => {
    expect(
      hasHyperBackup(makeNas({ tasks: [], packages: [pkg("Hyper Backup")] })),
    ).toBe(true);
    expect(hasHyperBackup(makeNas({ tasks: [makeTask()], packages: [] }))).toBe(
      true,
    );
    expect(hasHyperBackup(makeNas({ tasks: [], packages: null }))).toBe(true);
    expect(
      hasHyperBackup(
        makeNas({ tasks: [], packages: [pkg("Synology Photos")] }),
      ),
    ).toBe(false);
  });
});

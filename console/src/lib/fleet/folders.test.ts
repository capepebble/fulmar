import { describe, expect, it } from "vitest";
import { cleanFolderName, FOLDER_KINDS, folderSections } from "./folders";

const a = { id: "aaaa0001", name: "Dupont", rank: 1 };
const b = { id: "bbbb0002", name: "Maison", rank: 0 };

describe("folderSections", () => {
  it("rangs des groupes, ordre des NAS gardé, puis les NAS sans groupe", () => {
    const items = [
      { id: "1", folder: a },
      { id: "2", folder: null },
      { id: "3", folder: b },
      { id: "4", folder: a },
    ];
    expect(
      folderSections(items).map((s) => [
        s.folder?.name ?? null,
        s.items.map((i) => i.id),
      ]),
    ).toEqual([
      ["Maison", ["3"]],
      ["Dupont", ["1", "4"]],
      [null, ["2"]],
    ]);
  });

  it("sans aucun groupe : une seule section, sans titre", () => {
    expect(folderSections([{ id: "1", folder: null }])).toEqual([
      { key: "none", folder: null, items: [{ id: "1", folder: null }] },
    ]);
  });
});

describe("cleanFolderName", () => {
  it("garde un nom tapé, sans caractère de contrôle ni espace en trop", () => {
    expect(cleanFolderName("  Cabinet\u0007  Dupont ")).toBe("Cabinet Dupont");
    expect(cleanFolderName("")).toBeNull();
    expect(cleanFolderName("x".repeat(41))).toBeNull();
    expect(cleanFolderName(42)).toBeNull();
  });

  it("connaît trois types", () => {
    expect(FOLDER_KINDS).toEqual(["client", "category", "other"]);
  });
});

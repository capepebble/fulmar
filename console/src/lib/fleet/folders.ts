// Les groupes de NAS (conception 2026-11-26-groupes-protections-parc, section 1) : un NAS est
// dans un groupe au plus ; les listes se rangent par groupe, dans l'ordre des groupes, puis
// « Sans groupe ». Fonctions pures.

export const FOLDER_KINDS = ["client", "category", "other"] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export const FOLDER_KIND_LABEL: Record<FolderKind, { en: string; fr: string }> =
  {
    client: { en: "Client", fr: "Client" },
    category: { en: "Category", fr: "Catégorie" },
    other: { en: "Other", fr: "Autre" },
  };

export const FOLDER_ID = /^[0-9a-f]{8}$/;
const NAME_MAX = 40;
const CONTROL = /\p{Cc}/gu;

interface Ranked {
  id: string;
  name: string;
  rank: number;
}

export interface FolderSection<T> {
  key: string;
  /** Le groupe ; `null` pour les NAS sans groupe. */
  folder: Ranked | null;
  items: T[];
}

/** Les éléments rangés par groupe ; l'ordre reçu est gardé dans chaque groupe. */
export function folderSections<T extends { folder: Ranked | null }>(
  items: T[],
): FolderSection<T>[] {
  const byId = new Map<string, FolderSection<T>>();
  const loose: T[] = [];
  for (const item of items) {
    if (!item.folder) {
      loose.push(item);
      continue;
    }
    const section = byId.get(item.folder.id) ?? {
      key: item.folder.id,
      folder: item.folder,
      items: [],
    };
    section.items.push(item);
    byId.set(item.folder.id, section);
  }
  const sections = [...byId.values()].sort(
    (x, y) => (x.folder?.rank ?? 0) - (y.folder?.rank ?? 0),
  );
  return loose.length
    ? [...sections, { key: "none", folder: null, items: loose }]
    : sections;
}

/** Un nom de groupe tapé : sans caractère de contrôle, espaces resserrés, 1 à 40 caractères. */
export function cleanFolderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

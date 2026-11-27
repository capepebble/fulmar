// Lecture de la fiche d'un NAS : en bref ou en détail (conception 2026-11-25-fiche-en-bref).
// Le choix vit dans un cookie de préférence, lu par le serveur ; en bref par défaut.

export type View = "brief" | "detail";

export const VIEW_COOKIE = "view";

export function viewOf(value: string | undefined): View {
  return value === "detail" ? "detail" : "brief";
}

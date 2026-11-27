import type { Volume } from "./types";

/** Le volume le plus rempli, ou null quand aucun n'a été lu (stockage illisible). */
export function fullestVolume(volumes: Volume[]): Volume | null {
  let fullest: Volume | null = null;
  for (const v of volumes) if (!fullest || v.pct > fullest.pct) fullest = v;
  return fullest;
}

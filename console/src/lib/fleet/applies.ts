// Ce qui concerne un NAS (conception 2026-11-24, section 1) : on ne montre pas une section
// sans objet. Sans réponse, on ne cache rien : l'absence n'est sûre que si elle a été lue.

import type { Nas } from "./types";

/** Hyper Backup concerne ce NAS : il a des tâches, ou le paquet est installé, ou la liste des
 * paquets n'a pas été lue (dans le doute, on montre). */
export function hasHyperBackup(nas: Nas): boolean {
  if (nas.tasks.length > 0) return true;
  if (nas.packages === null) return true;
  return nas.packages.some((p) => /hyper\s*backup/i.test(p.name));
}

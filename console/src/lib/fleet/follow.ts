// Le suivi choisi (conception 2026-11-24, section 3) : un contrôle qu'on ne suit plus, sur un
// NAS ou sur tout le parc, garde sa lecture mais ne colore plus ni ses voyants, ni l'état du
// NAS, ni « À traiter ». Tout ce qu'on suit est vert : le NAS est vert.

import type { Nas } from "./types";

export interface FollowRule {
  /** Un NAS, ou « * » pour tout le parc. */
  scope: string;
  checkId: string;
}

export function isFollowed(
  rules: readonly FollowRule[],
  nasId: string,
  checkId: string,
): boolean {
  return !rules.some(
    (r) => r.checkId === checkId && (r.scope === "*" || r.scope === nasId),
  );
}

/** Le NAS avec ses contrôles marqués suivis ou non ; le même objet s'il n'y a rien à marquer. */
export function applyFollow(nas: Nas, rules: readonly FollowRule[]): Nas {
  if (rules.length === 0) return nas;
  let changed = false;
  const checks = nas.checks.map((c) => {
    const followed = isFollowed(rules, nas.id, c.id);
    if (followed === (c.followed !== false)) return c;
    changed = true;
    return { ...c, followed };
  });
  return changed ? { ...nas, checks } : nas;
}

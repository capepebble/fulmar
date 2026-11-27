import type { ActivityEvent } from "./types";

export interface GroupedEvent extends ActivityEvent {
  /** Lignes identiques regroupées (1 : ligne seule). */
  count: number;
  /** Heure de la plus ancienne ligne du groupe. */
  since: string;
}

function same(a: ActivityEvent, b: ActivityEvent): boolean {
  return (
    a.day === b.day &&
    a.source === b.source &&
    a.who === b.who &&
    a.level === b.level &&
    a.text === b.text
  );
}

/**
 * Regroupe les lignes identiques qui se suivent (connexions SSH en série, tâche relancée) :
 * le journal reste dans l'ordre, sans qu'une rafale noie le reste. Entrée et sortie vont de la
 * plus récente à la plus ancienne.
 */
export function groupRepeats(events: ActivityEvent[]): GroupedEvent[] {
  const out: GroupedEvent[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && same(last, e)) {
      last.count += 1;
      last.since = e.time;
    } else {
      out.push({ ...e, count: 1, since: e.time });
    }
  }
  return out;
}

/**
 * Lectures gardées en mémoire du serveur, une par agent. « Relire » n'oublie que les lectures
 * assez anciennes : des clics répétés ne peuvent pas relancer sans fin les appels aux agents.
 */
export class ReadCache<T> {
  private readonly entries = new Map<
    string,
    { at: number; value: Promise<T> }
  >();

  constructor(
    private readonly limits: { ttlMs: number; minForgetMs: number },
  ) {}

  /** Nombre d'entrées gardées (tests). */
  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): Promise<T> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (now - hit.at >= this.limits.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: Promise<T>, now = Date.now()): void {
    // Les lectures périmées partent à chaque écriture : des adresses qui changent à chaque
    // minute (courbes) ne font pas grandir la mémoire d'un service qui tourne en permanence.
    for (const [k, e] of this.entries)
      if (now - e.at >= this.limits.ttlMs) this.entries.delete(k);
    const entry = { at: now, value };
    this.entries.set(key, entry);
    // Une lecture ratée ne doit pas rester en mémoire.
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
  }

  /** Oublie les lectures d'au moins `minForgetMs` ; les plus récentes restent. */
  forget(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.limits.minForgetMs) this.entries.delete(key);
    }
  }
}

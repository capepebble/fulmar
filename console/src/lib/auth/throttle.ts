// Les essais de connexion, par adresse : passé `max` échecs dans la fenêtre, on attend qu'elle
// glisse. En mémoire du serveur : un redémarrage les oublie, ce qui reste sans gravité.

export class Throttle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter(
      (t) => t > now - this.windowMs,
    );
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
    if (this.failures.size > 10_000) {
      for (const k of [...this.failures.keys()]) this.recent(k, now);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  /** Retire un échec compté d'avance (l'essai a réussi). */
  undo(key: string, at: number): void {
    const list = this.failures.get(key);
    const i = list?.lastIndexOf(at) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }
}

/** Par adresse, et tous appareils confondus : l'adresse vient d'un en-tête que le client peut
 * remplir, une adresse inventée à chaque essai ne doit pas suffire. Au pire, le propriétaire
 * attend un quart d'heure ; un mot de passe de 12 caractères haché par scrypt ou un code de
 * dix chiffres ne se devinent pas à vingt essais par quart d'heure. */
export class LoginAttempts {
  constructor(
    private readonly perClient = new Throttle(5, 15 * 60_000),
    private readonly all = new Throttle(20, 15 * 60_000),
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.perClient.blocked(key, now) || this.all.blocked("*", now);
  }

  fail(key: string, now = Date.now()): void {
    this.perClient.fail(key, now);
    this.all.fail("*", now);
  }

  /** Compte l'essai avant de le vérifier : des essais lancés ensemble ne passent pas tous le
   * contrôle avant que le premier échec soit noté. Rend l'instant de l'essai, ou null s'il faut
   * attendre. */
  begin(key: string, now = Date.now()): number | null {
    if (this.blocked(key, now)) return null;
    this.fail(key, now);
    return now;
  }

  /** L'essai commencé à `at` a réussi : il ne compte plus, l'adresse repart de zéro. */
  success(key: string, at: number): void {
    this.all.undo("*", at);
    this.perClient.reset(key);
  }
}

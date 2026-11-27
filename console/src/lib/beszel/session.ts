import "server-only";

// Session de la console auprès du hub Beszel : un compte en lecture seule, un jeton gardé en
// mémoire du serveur. Le hub limite les connexions (429) : une seule authentification à la
// fois, le jeton est renouvelé (auth-refresh) dans le dernier quart de sa durée (un jour au plus
// avant son expiration), et après un refus plus aucune tentative avant 60 s ou le délai que le
// hub demande.

import type { Texts } from "@/i18n";

export interface BeszelConfig {
  url: string;
  email: string;
  password: string;
}

export type BeszelErrorKind = "auth" | "rate" | "down";

export class BeszelError extends Error {
  constructor(
    readonly kind: BeszelErrorKind,
    readonly texts: Texts,
  ) {
    super(texts.en);
    this.name = "BeszelError";
  }
}

export interface BeszelDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const RATE_PAUSE_MS = 60_000;

/** `BESZEL_URL`, `BESZEL_EMAIL` et `BESZEL_PASSWORD`, tous requis ; sinon pas de Beszel. */
export function beszelConfig(
  env: Record<string, string | undefined> = process.env,
): BeszelConfig | null {
  const url = env.BESZEL_URL?.trim().replace(/\/+$/, "");
  const email = env.BESZEL_EMAIL?.trim();
  const password = env.BESZEL_PASSWORD;
  if (!url || !email || !password) return null;
  return { url, email, password };
}

/** Expiration d'un jeton JWT, en millisecondes ; une heure si elle ne se lit pas. */
function expiresAt(token: string, now: number): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {
    // Jeton illisible : durée prudente.
  }
  return now + 3_600_000;
}

/** Marge de renouvellement : le dernier quart de la durée du jeton, un jour au plus. Un jeton
 * court n'est donc pas renouvelé à chaque lecture. */
function renewWithin(cur: { exp: number; issued: number }): number {
  return Math.min(DAY_MS, (cur.exp - cur.issued) / 4);
}

/** Durée d'attente demandée par le hub, au moins 60 s. */
export function ratePause(response: Response): number {
  const s = Number(response.headers.get("Retry-After"));
  return Number.isFinite(s) && s > 0
    ? Math.max(RATE_PAUSE_MS, s * 1000)
    : RATE_PAUSE_MS;
}

export function downReason(error: unknown): Texts {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? {
        en: "Beszel unreachable (timed out)",
        fr: "Beszel injoignable (délai dépassé)",
      }
    : { en: "Beszel unreachable", fr: "Beszel injoignable" };
}

/** Beszel répond avec une erreur. */
export function statusReason(status: number): Texts {
  return {
    en: `Beszel unreachable (error ${status})`,
    fr: `Beszel injoignable (erreur ${status})`,
  };
}

/** Beszel répond, mais pas en JSON lisible. */
export const UNREADABLE: Texts = {
  en: "Beszel unreachable (unreadable answer)",
  fr: "Beszel injoignable (réponse illisible)",
};

/** Beszel demande d'attendre avant le prochain essai. */
export function rateReason(seconds: number): Texts {
  return {
    en: `Beszel is limiting requests, next try in ${seconds} s`,
    fr: `Beszel limite les requêtes, nouvel essai dans ${seconds} s`,
  };
}

export class BeszelSession {
  private current: { token: string; exp: number; issued: number } | null = null;
  private pending: Promise<string> | null = null;
  private blockedUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly cfg: BeszelConfig,
    deps: BeszelDeps = {},
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Jeton valable ; une seule authentification à la fois. */
  token(): Promise<string> {
    const now = this.now();
    if (now < this.blockedUntil) return Promise.reject(this.rateError(now));
    const cur = this.current;
    if (cur && cur.exp - now > renewWithin(cur))
      return Promise.resolve(cur.token);
    if (!this.pending) {
      const run = cur && cur.exp > now ? this.refresh(cur.token) : this.login();
      this.pending = run.finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** Âge du jeton en millisecondes, `null` sans jeton. */
  tokenAge(): number | null {
    return this.current ? this.now() - this.current.issued : null;
  }

  /** Oublie le jeton (refusé par le hub). */
  invalidate(): void {
    this.current = null;
  }

  /** Le hub a répondu 429 : plus aucune tentative pendant `ms`. */
  pause(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** Secondes restantes avant un nouvel essai, 0 si rien n'est suspendu. */
  pausedFor(): number {
    return Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000));
  }

  private rateError(now: number): BeszelError {
    const s = Math.max(1, Math.ceil((this.blockedUntil - now) / 1000));
    return new BeszelError("rate", rateReason(s));
  }

  private async login(): Promise<string> {
    return this.authenticate("auth-with-password", {
      body: JSON.stringify({
        identity: this.cfg.email,
        password: this.cfg.password,
      }),
    });
  }

  private async refresh(token: string): Promise<string> {
    try {
      return await this.authenticate("auth-refresh", {
        headers: { Authorization: token },
      });
    } catch (error) {
      if (error instanceof BeszelError && error.kind === "auth") {
        this.current = null;
        return this.login();
      }
      throw error;
    }
  }

  private async authenticate(
    action: "auth-with-password" | "auth-refresh",
    init: { body?: string; headers?: Record<string, string> },
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetch(
        `${this.cfg.url}/api/collections/users/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...init.headers },
          body: init.body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        },
      );
    } catch (error) {
      throw new BeszelError("down", downReason(error));
    }
    if (response.status === 429) {
      this.pause(ratePause(response));
      throw this.rateError(this.now());
    }
    if (response.status >= 400 && response.status < 500)
      throw new BeszelError("auth", {
        en: "credentials refused by Beszel",
        fr: "identifiants refusés par Beszel",
      });
    if (!response.ok)
      throw new BeszelError("down", statusReason(response.status));
    const body = (await response.json().catch(() => ({}))) as {
      token?: unknown;
    };
    if (typeof body.token !== "string")
      throw new BeszelError("down", UNREADABLE);
    const issued = this.now();
    this.current = {
      token: body.token,
      exp: expiresAt(body.token, issued),
      issued,
    };
    return body.token;
  }
}

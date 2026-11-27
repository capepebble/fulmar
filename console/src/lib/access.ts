// Qui peut ouvrir la console. Elle n'écoute que sur la boucle locale (127.0.0.1) : on ne
// l'atteint que depuis la machine, ou par `tailscale serve`, qui retire les en-têtes
// d'identité forgés par le client et ajoute l'identité réelle (Tailscale-User-Login).
//
// L'en-tête Host se forge : il ne prouve jamais à lui seul qu'une requête est locale. D'où :
// - avec une liste d'identités : seules ces identités Tailscale entrent, et seulement sous un
//   nom publié par Serve (NAS_CONSOLE_HOSTS). Une page piégée qui fait pointer son nom sur
//   127.0.0.1 (DNS rebinding) peut ajouter l'en-tête d'identité à ses requêtes, mais le
//   navigateur y garde son nom à elle dans Host ;
// - sans liste : le poste local n'entre qu'en développement, ou avec une ouverture locale
//   explicite, et jamais si la requête porte une trace de relais (identité Tailscale,
//   Forwarded, adresse non locale) ;
// - en production sans liste ni ouverture locale : personne.

import type { Texts } from "@/i18n";

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDR =
  /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i;

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: Texts };

export interface AccessRequest {
  /** En-tête Host. */
  host: string | null;
  /** Identité Tailscale, quand `tailscale serve` l'a ajoutée. */
  login: string | null;
  /** En-tête Forwarded (RFC 7239). */
  forwarded: string | null;
  /** En-tête X-Forwarded-For ; Next.js y met lui-même l'adresse du client direct. */
  forwardedFor: string | null;
  /** NAS_CONSOLE_ALLOWED_LOGINS, en minuscules. */
  allowlist: string[];
  /** NAS_CONSOLE_HOSTS : noms sous lesquels Serve publie la console, requis avec une liste d'identités. */
  hosts: string[];
  production: boolean;
  /** NAS_CONSOLE_LOCAL_ONLY=1 : ouverture au seul poste local, jamais derrière Serve. */
  localOnly: boolean;
}

function relayed(r: AccessRequest): boolean {
  if (r.login || r.forwarded) return true;
  const hops = (r.forwardedFor ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops.some((hop) => !LOOPBACK_ADDR.test(hop));
}

/** Nom d'hôte comparable : minuscules, sans port 443 ni point final. */
function hostName(value: string): string {
  return value.trim().toLowerCase().replace(/:443$/, "").replace(/\.$/, "");
}

export function accessDecision(r: AccessRequest): AccessDecision {
  if (r.allowlist.length > 0) {
    const hosts = r.hosts.map(hostName);
    if (hosts.length === 0)
      return {
        allowed: false,
        reason: {
          en: "allowed host names required with an identity list (NAS_CONSOLE_HOSTS)",
          fr: "noms admis requis avec une liste d'identités (NAS_CONSOLE_HOSTS)",
        },
      };
    if (!r.host || !hosts.includes(hostName(r.host)))
      return {
        allowed: false,
        reason: { en: "host name not allowed", fr: "nom d'hôte non admis" },
      };
    if (r.login && r.allowlist.includes(r.login.trim().toLowerCase()))
      return { allowed: true };
    return {
      allowed: false,
      reason: {
        en: "Tailscale identity missing or not allowed",
        fr: "identité Tailscale absente ou non admise",
      },
    };
  }
  if (r.production && !r.localOnly) {
    return {
      allowed: false,
      reason: {
        en: "identity list required in production (NAS_CONSOLE_ALLOWED_LOGINS)",
        fr: "liste d'identités requise en production (NAS_CONSOLE_ALLOWED_LOGINS)",
      },
    };
  }
  if (r.host && LOOPBACK_HOST.test(r.host.trim()) && !relayed(r))
    return { allowed: true };
  return {
    allowed: false,
    reason: {
      en: "without an identity list (NAS_CONSOLE_ALLOWED_LOGINS), only this computer gets in",
      fr: "sans liste d'identités (NAS_CONSOLE_ALLOWED_LOGINS), seul le poste local entre",
    },
  };
}

export function parseAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// La console du projet du moteur (NAS_CONSOLE_AUTH=password, conception du moteur
// installable, section 4) : un compte, un mot de passe, une session signée. Sans compte, tout
// mène à la bienvenue (code d'installation, puis mot de passe) ; sans session, à la connexion.

export interface PasswordRequest {
  path: string;
  method: string;
  hasAccount: boolean;
  /** Cookie de session présent, bien signé et pas échu. */
  session: boolean;
}

export type PasswordDecision =
  | { action: "next" }
  | { action: "redirect"; to: string }
  | { action: "deny"; status: number; reason: Texts };

export function passwordAccess(r: PasswordRequest): PasswordDecision {
  if (!r.hasAccount)
    return r.path === "/welcome"
      ? { action: "next" }
      : { action: "redirect", to: "/welcome" };
  if (r.path === "/welcome")
    return { action: "redirect", to: r.session ? "/" : "/sign-in" };
  if (r.path === "/sign-in")
    return r.session ? { action: "redirect", to: "/" } : { action: "next" };
  if (r.session) return { action: "next" };
  if (r.method !== "GET" && r.method !== "HEAD")
    return {
      action: "deny",
      status: 401,
      reason: { en: "sign-in required", fr: "connexion requise" },
    };
  return {
    action: "redirect",
    to:
      r.path === "/"
        ? "/sign-in"
        : `/sign-in?next=${encodeURIComponent(r.path)}`,
  };
}

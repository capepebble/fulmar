import { type NextRequest, NextResponse } from "next/server";
import type { Texts } from "@/i18n";
import {
  LOCALE_COOKIE,
  LOCALE_HEADER,
  type Locale,
  pickLocale,
  splitLocale,
} from "@/i18n/locales";
import { accessDecision, parseAllowlist, passwordAccess } from "@/lib/access";
import { authStore, passwordMode } from "@/lib/auth";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

function refused(status: number, reason: Texts, locale: Locale): NextResponse {
  const text =
    locale === "en"
      ? `Access refused: ${reason.en}.\n`
      : `Accès refusé : ${reason.fr}.\n`;
  return new NextResponse(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** La page dans la langue choisie : le proxy pose la langue sur la requête, et les réécritures
 * de next.config.ts servent /nas/essai par /fr/nas/essai, sans changer l'adresse (conception
 * du moteur en anglais). Pas de `NextResponse.rewrite` : Next.js compare sa destination à son
 * adresse d'écoute (127.0.0.1, 0.0.0.0), pas à celle qu'il donne au proxy (localhost), la prend
 * pour une adresse externe et se relaie la requête, ce qui échoue derrière un proxy HTTPS. La
 * valeur posée remplace toujours celle qu'un client enverrait. */
function localized(request: NextRequest, locale: Locale): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(LOCALE_HEADER, locale);
  return NextResponse.next({ request: { headers } });
}

function redirectTo(request: NextRequest, to: string): NextResponse {
  const url = request.nextUrl.clone();
  const [pathname, search] = to.split("?");
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  return NextResponse.redirect(url);
}

/** La console du projet : compte, mot de passe et session signée (moteur installable). */
function withPassword(request: NextRequest, locale: Locale): NextResponse {
  const store = authStore();
  const hasAccount = store.hasAccount();
  const session =
    hasAccount &&
    verifySession(
      store.sessionKey(),
      request.cookies.get(SESSION_COOKIE)?.value,
      Date.now(),
    );
  const d = passwordAccess({
    path: request.nextUrl.pathname,
    method: request.method,
    hasAccount,
    session,
  });
  if (d.action === "next") return localized(request, locale);
  if (d.action === "deny") return refused(d.status, d.reason, locale);
  return redirectTo(request, d.to);
}

// Toute requête (pages, actions serveur comme « Relire ») passe par ce contrôle.
export function proxy(request: NextRequest) {
  // Une adresse préfixée (/fr/…) mène à la même adresse sans préfixe, et retient la langue.
  const prefixed = splitLocale(request.nextUrl.pathname);
  if (prefixed) {
    const response = redirectTo(
      request,
      `${prefixed.rest}${request.nextUrl.search}`,
    );
    response.cookies.set(LOCALE_COOKIE, prefixed.locale, {
      path: "/",
      maxAge: 31_536_000,
      sameSite: "lax",
    });
    return response;
  }
  const locale = pickLocale(
    request.cookies.get(LOCALE_COOKIE)?.value,
    request.headers.get("accept-language"),
  );
  if (passwordMode()) return withPassword(request, locale);
  const decision = accessDecision({
    host: request.headers.get("host"),
    login: request.headers.get("tailscale-user-login"),
    forwarded: request.headers.get("forwarded"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    allowlist: parseAllowlist(process.env.NAS_CONSOLE_ALLOWED_LOGINS),
    hosts: parseAllowlist(process.env.NAS_CONSOLE_HOSTS),
    production: process.env.NODE_ENV === "production",
    localOnly: process.env.NAS_CONSOLE_LOCAL_ONLY === "1",
  });
  if (decision.allowed) return localized(request, locale);
  return refused(403, decision.reason, locale);
}

export const config = {
  // Les fichiers internes de Next.js et les icônes ne portent aucune donnée du parc, ni texte.
  matcher: ["/((?!_next/|favicon.ico|icon.svg).*)"],
};

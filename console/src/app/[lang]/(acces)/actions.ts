"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Texts } from "@/i18n";
import { authStore, loginAttempts, passwordMode } from "@/lib/auth";
import { requireSession } from "@/lib/auth/guard";
import { passwordProblem } from "@/lib/auth/password";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  signSession,
} from "@/lib/auth/session";

// Bienvenue, connexion, déconnexion de la console du projet (moteur installable, section 4).

export interface FormState {
  error?: Texts;
}

const NO_SIGN_IN: Texts = {
  en: "This console has no sign-in.",
  fr: "Cette console n'a pas de connexion.",
};

/** L'adresse ajoutée par le dernier relais (Next.js ou le proxy inversé de DSM) ; elle reste
 * falsifiable, d'où la limite globale de `LoginAttempts`. */
async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}

async function openSession(): Promise<void> {
  const h = await headers();
  (await cookies()).set(
    SESSION_COOKIE,
    signSession(authStore().sessionKey(), Date.now()),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: h.get("x-forwarded-proto") === "https",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
    },
  );
}

/** Une page de la console, jamais une adresse d'un autre site. */
function safeNext(value: FormDataEntryValue | null): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
    ? value
    : "/";
}

// Par appareil ou tous appareils confondus (LoginAttempts) ; redémarrer la console efface les
// compteurs, si le propriétaire est bloqué par les essais d'un autre appareil.
const TOO_MANY: Texts = {
  en: "Too many attempts: wait a quarter of an hour before trying again, or restart the console.",
  fr: "Trop d'essais : attendez un quart d'heure avant de recommencer, ou redémarrez la console.",
};

export async function welcome(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  if (!passwordMode()) return { error: NO_SIGN_IN };
  const store = authStore();
  if (store.hasAccount()) redirect("/sign-in");
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password, String(form.get("confirm") ?? ""));
  if (problem) return { error: problem };
  const key = await clientKey();
  const attempts = loginAttempts();
  const ticket = attempts.begin(key);
  if (ticket === null) return { error: TOO_MANY };
  if (!store.consumeInstallCode(String(form.get("code") ?? ""))) {
    console.warn(`Bienvenue : code d'installation faux, depuis ${key}.`);
    return {
      error: {
        en: "That is not the install code. Read it again in the console log.",
        fr: "Ce n'est pas le code d'installation. Relisez-le dans le journal de la console.",
      },
    };
  }
  attempts.success(key, ticket);
  await store.createAccount(password);
  console.log(`Console : mot de passe choisi, depuis ${key}.`);
  await openSession();
  redirect("/");
}

export async function signIn(
  _prev: FormState,
  form: FormData,
): Promise<FormState> {
  if (!passwordMode()) return { error: NO_SIGN_IN };
  const key = await clientKey();
  const attempts = loginAttempts();
  const ticket = attempts.begin(key);
  if (ticket === null) return { error: TOO_MANY };
  if (!(await authStore().checkPassword(String(form.get("password") ?? "")))) {
    console.warn(`Connexion refusée : mot de passe faux, depuis ${key}.`);
    return { error: { en: "Wrong password.", fr: "Mot de passe faux." } };
  }
  attempts.success(key, ticket);
  await openSession();
  redirect(safeNext(form.get("next")));
}

/** Se déconnecter partout : un seul compte, une seule clé ; la changer fait tomber toutes les
 * sessions, y compris un cookie qui aurait été copié. */
export async function signOut(): Promise<void> {
  await requireSession();
  authStore().rotateSessionKey();
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/sign-in");
}

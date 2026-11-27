import { cookies } from "next/headers";
import { authStore, passwordMode } from ".";
import { SESSION_COOKIE, verifySession } from "./session";

/** À l'entrée de chaque action serveur, sauf bienvenue et connexion : Next.js appelle une action
 * par son identifiant, quelle que soit la page visée, et /connexion s'ouvre sans session. Dans
 * les autres modes, le contrôle d'accès vaut pour toutes les adresses et suffit. */
export async function requireSession(): Promise<void> {
  if (!passwordMode()) return;
  const store = authStore();
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (
    !store.hasAccount() ||
    !verifySession(store.sessionKey(), value, Date.now())
  )
    throw new Error("Connexion requise.");
}

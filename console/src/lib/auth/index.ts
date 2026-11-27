import { join } from "node:path";
import { AuthStore } from "./store";
import { LoginAttempts } from "./throttle";

// La console du projet du moteur ouvre sa propre connexion (NAS_CONSOLE_AUTH=password) ; les
// autres modes (identités Tailscale, poste local) restent ceux de `access.ts`.

export function passwordMode(): boolean {
  return process.env.NAS_CONSOLE_AUTH === "password";
}

export function consoleDataDir(): string {
  return process.env.NAS_CONSOLE_DATA_DIR ?? join(process.cwd(), "data");
}

export function authStore(): AuthStore {
  return new AuthStore(join(consoleDataDir(), "auth"));
}

const shared = globalThis as unknown as { __consoleAttempts?: LoginAttempts };

/** Les essais de connexion, partagés par toutes les requêtes du serveur. */
export function loginAttempts(): LoginAttempts {
  shared.__consoleAttempts ??= new LoginAttempts();
  return shared.__consoleAttempts;
}

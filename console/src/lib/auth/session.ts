import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// La session de la console du projet (conception du moteur installable, section 4) : un cookie
// signé, vérifié sans lire la base. Changer le mot de passe change la clé : toutes tombent.

export const SESSION_COOKIE = "nas_console_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

function mac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function signSession(key: Buffer, nowMs: number): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_MAX_AGE_S;
  const body = `v1.${exp}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${mac(key, body)}`;
}

export function verifySession(
  key: Buffer,
  value: string | null | undefined,
  nowMs: number,
): boolean {
  const parts = (value ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [v, exp, nonce, given] = parts;
  const expected = Buffer.from(mac(key, `${v}.${exp}.${nonce}`));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return false;
  const until = Number(exp);
  return Number.isInteger(until) && until * 1000 > nowMs;
}

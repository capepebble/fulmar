import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Texts } from "@/i18n";

// Le mot de passe de la console : haché par scrypt, jamais gardé en clair.

export const MIN_PASSWORD = 12;
const N = 32768;
const R = 8;
const P = 1;
const LENGTH = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize("NFC"),
      salt,
      LENGTH,
      { N: n, r, p, maxmem: MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  try {
    const key = await derive(
      password,
      Buffer.from(salt, "base64url"),
      Number(n),
      Number(r),
      Number(p),
    );
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Ce qui ne va pas dans un nouveau mot de passe, dans les mots de la page ; null s'il va. */
export function passwordProblem(
  password: string,
  confirm: string,
): Texts | null {
  if ([...password].length < MIN_PASSWORD)
    return {
      en: `The password needs at least ${MIN_PASSWORD} characters.`,
      fr: `Le mot de passe fait au moins ${MIN_PASSWORD} caractères.`,
    };
  if (password !== confirm)
    return {
      en: "The two entries are not the same.",
      fr: "Les deux saisies ne sont pas identiques.",
    };
  return null;
}

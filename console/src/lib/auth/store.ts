import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "./password";

// Le compte, la clé de session et le code d'installation de la console du projet, en fichiers
// privés (mode 600) dans son dossier de données. Le contrôle d'accès les lit sans base.

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** « 12345 67890 » : le code se lit plus sûrement en deux groupes. */
export function formatInstallCode(code: string): string {
  return `${code.slice(0, 5)} ${code.slice(5)}`;
}

export class AuthStore {
  constructor(private readonly dir: string) {}

  private path(name: string): string {
    return join(this.dir, name);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  hasAccount(): boolean {
    return existsSync(this.path("account.json"));
  }

  private storedHash(): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.path("account.json"), "utf8"));
      return typeof raw?.hash === "string" ? raw.hash : null;
    } catch {
      return null;
    }
  }

  async createAccount(password: string): Promise<void> {
    if (this.hasAccount()) throw new Error("Le compte existe déjà.");
    this.ensureDir();
    const hash = await hashPassword(password);
    writeFileSync(
      this.path("account.json"),
      JSON.stringify({ v: 1, hash, created: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
    rmSync(this.path("install-code"), { force: true });
  }

  async checkPassword(password: string): Promise<boolean> {
    const hash = this.storedHash();
    return hash ? verifyPassword(password, hash) : false;
  }

  async changePassword(password: string): Promise<void> {
    const hash = await hashPassword(password);
    writePrivate(
      this.path("account.json"),
      JSON.stringify({ v: 1, hash, changed: new Date().toISOString() }),
    );
    this.rotateSessionKey();
  }

  sessionKey(): Buffer {
    const file = this.path("session.key");
    if (existsSync(file)) {
      const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
      if (key.length === 32) return key;
    }
    this.ensureDir();
    const key = randomBytes(32);
    writePrivate(file, key.toString("hex"));
    return key;
  }

  rotateSessionKey(): void {
    this.ensureDir();
    writePrivate(this.path("session.key"), randomBytes(32).toString("hex"));
  }

  /** Le code d'installation, tiré une fois ; null quand le compte existe. */
  installCode(): string | null {
    if (this.hasAccount()) return null;
    const file = this.path("install-code");
    if (existsSync(file)) {
      const code = readFileSync(file, "utf8").trim();
      if (/^\d{10}$/.test(code)) return code;
    }
    this.ensureDir();
    const code = Array.from({ length: 10 }, () => randomInt(10)).join("");
    writePrivate(file, code);
    return code;
  }

  /** Vrai si le code est le bon ; il ne sert alors plus. */
  consumeInstallCode(given: string): boolean {
    const file = this.path("install-code");
    if (!existsSync(file)) return false;
    const code = readFileSync(file, "utf8").trim();
    const typed = Buffer.from(given.replace(/\D/g, ""));
    const expected = Buffer.from(code);
    const ok =
      typed.length === expected.length && timingSafeEqual(typed, expected);
    if (ok) rmSync(file, { force: true });
    return ok;
  }
}

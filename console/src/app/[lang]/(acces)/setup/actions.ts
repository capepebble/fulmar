"use server";

import {
  type CertificateResult,
  type EnrollResult,
  enrollLocal,
  readCertificate,
} from "@/lib/agents/setup";
import { requireSession } from "@/lib/auth/guard";

// Les gestes de l'enrôlement, côté serveur : le mot de passe de DSM va de la console à
// l'agent par le réseau du projet, sans être gardé par la console.

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function port(form: FormData): number {
  const value = Number(text(form, "port") || 5001);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 5001;
}

export async function certificateAction(
  form: FormData,
): Promise<CertificateResult> {
  await requireSession();
  const host = text(form, "host");
  if (!host)
    return {
      ok: false,
      error: {
        en: "DSM's address is missing.",
        fr: "L'adresse de DSM manque.",
      },
    };
  return readCertificate(host, port(form), text(form, "server_name") || null);
}

export async function enrollAction(form: FormData): Promise<EnrollResult> {
  await requireSession();
  const username = text(form, "username");
  const password = String(form.get("password") ?? "");
  if (!username || !password)
    return {
      ok: false,
      error: {
        en: "The account and its password are required.",
        fr: "Le compte et son mot de passe sont requis.",
      },
    };
  return enrollLocal({
    host: text(form, "host"),
    port: port(form),
    serverName: text(form, "server_name") || null,
    fingerprint: text(form, "fingerprint"),
    username,
    password,
    otp: text(form, "otp") || null,
  });
}

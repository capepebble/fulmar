"use server";

import type { LinkResult } from "@/components/setup/dsm-wizard";
import type { Texts } from "@/i18n";
import {
  addToFleet,
  type CertificateResult,
  HOST_PATTERN,
  readFleetCertificate,
} from "@/lib/agents/setup";
import { requireSession } from "@/lib/auth/guard";

// Ajouter un NAS au hub (conception 2026-11-26-parc-du-moteur) : les gestes de l'installation,
// vers l'API du parc de l'agent du projet. Le mot de passe de DSM va de la console à l'agent
// par le réseau du projet, sans être gardé par la console.

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function port(form: FormData): number {
  const value = Number(text(form, "port") || 5001);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 5001;
}

/** L'adresse et le nom du certificat, vérifiés avant d'aller à l'agent ; `null` s'ils vont. */
function addressProblem(form: FormData): Texts | null {
  const host = text(form, "host");
  const name = text(form, "server_name");
  if (!host)
    return {
      en: "The NAS address is missing.",
      fr: "L'adresse du NAS manque.",
    };
  if (!HOST_PATTERN.test(host) || (name && !HOST_PATTERN.test(name)))
    return {
      en: "Write an IP address or a name: letters, digits, dots and dashes only.",
      fr: "Écrivez une adresse IP ou un nom : lettres, chiffres, points et tirets seulement.",
    };
  return null;
}

export async function fleetCertificateAction(
  form: FormData,
): Promise<CertificateResult> {
  await requireSession();
  const problem = addressProblem(form);
  if (problem) return { ok: false, error: problem };
  return readFleetCertificate(
    text(form, "host"),
    port(form),
    text(form, "server_name") || null,
  );
}

export async function addNasAction(form: FormData): Promise<LinkResult> {
  await requireSession();
  const problem = addressProblem(form);
  if (problem) return { ok: false, error: problem };
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
  return addToFleet({
    host: text(form, "host"),
    port: port(form),
    serverName: text(form, "server_name") || null,
    fingerprint: text(form, "fingerprint"),
    username,
    password,
    otp: text(form, "otp") || null,
  });
}

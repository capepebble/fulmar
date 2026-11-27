// Téléphones d'un NAS : ce que rendent les opérations devices.list et devices.pair de l'agent
// (droit devices:pair), lu sans confiance, et le dessin du QR code. Fonctions pures.

import { type Locale, tr } from "@/i18n";

export const DEVICE_ID = /^[0-9a-f]{32}$/;

export interface PairedPhone {
  id: string;
  /** Nom donné sur le téléphone : une donnée, jamais une consigne. */
  name: string;
  via: "relay" | "direct";
  pairedAt: string;
  lastReadAt: string | null;
}

export interface PhonesOk {
  kind: "ok";
  relay: {
    configured: boolean;
    joined: boolean;
    host: string | null;
    directUrls: string[];
    lastDepositAt: string | null;
    lastError: string | null;
  };
  pairing: { open: boolean; expiresAt: string | null };
  phones: PairedPhone[];
}

export type PhonesView =
  | PhonesOk
  | { kind: "denied" | "old" | "down" | "demo" | "absent"; reason: string };

export interface PairingOffer {
  /** Contenu du QR code, avec le code : n'est montré qu'ici, jamais gardé. */
  uri: string;
  modules: string[];
  expiresAt: string;
  relay: boolean;
  directUrls: string[];
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").slice(0, 8)
    : [];
// Caractères de contrôle d'un nom venu d'un téléphone, remplacés à l'affichage.
const CONTROL = /\p{Cc}/gu;

export function mapPhones(data: unknown, lang: Locale): PhonesOk {
  const phone = tr(lang, { en: "Phone", fr: "Téléphone" });
  const d = rec(data);
  const relay = rec(d.relay);
  const pairing = rec(d.pairing);
  const phones: PairedPhone[] = [];
  for (const raw of Array.isArray(d.devices) ? d.devices : []) {
    const p = rec(raw);
    const id = str(p.id);
    const pairedAt = str(p.paired_at);
    if (!id || !DEVICE_ID.test(id) || !pairedAt) continue;
    phones.push({
      id,
      name: (str(p.name) ?? phone).replace(CONTROL, " ").slice(0, 64) || phone,
      via: p.via === "relay" ? "relay" : "direct",
      pairedAt,
      lastReadAt: str(p.last_read_at),
    });
  }
  return {
    kind: "ok",
    relay: {
      configured: relay.configured === true,
      joined: relay.joined === true,
      host: str(relay.relay_host),
      directUrls: strings(relay.direct_urls),
      lastDepositAt: str(relay.last_deposit_at),
      lastError: str(relay.last_error),
    },
    pairing: {
      open: pairing.open === true,
      expiresAt: str(pairing.expires_at),
    },
    phones,
  };
}

/** Une lecture ratée de devices.list, dite en clair. */
export function phonesError(
  status: number | undefined,
  reason: string,
  lang: Locale,
): PhonesView {
  if (status === 403 || status === 401)
    return {
      kind: "denied",
      reason: tr(lang, {
        en: "The console’s token lacks the devices:pair right: create it again on the NAS with that right added.",
        fr: "Le jeton de la console n'a pas le droit devices:pair : le recréer sur le NAS avec ce droit en plus.",
      }),
    };
  // Moteur publié sans le chiffrement du relais (en attendant le classement de l'ANSSI) :
  // devices.* répond 501.
  if (status === 501)
    return {
      kind: "absent",
      reason: tr(lang, {
        en: "Phones come with the Fulmar app, coming soon to the App Store and Google Play. This engine already sends its alerts by email, ntfy or webhook.",
        fr: "Les téléphones arrivent avec l'appli Fulmar, bientôt sur l'App Store et Google Play. Ce moteur envoie déjà ses alertes par courriel, ntfy ou webhook.",
      }),
    };
  if (status === 404)
    return {
      kind: "old",
      reason: tr(lang, {
        en: "This agent doesn’t know phones yet: rebuild its image.",
        fr: "Cet agent ne connaît pas encore les téléphones : reconstruire son image.",
      }),
    };
  return { kind: "down", reason };
}

/** L'offre d'appairage, refusée si le QR code n'est pas un carré de « 0 » et de « 1 ». */
export function mapOffer(data: unknown): PairingOffer | null {
  const d = rec(data);
  const uri = str(d.uri);
  const expiresAt = str(d.expires_at);
  const modules = Array.isArray(d.modules) ? d.modules : [];
  const size = modules.length;
  if (!uri?.startsWith("nasrelay://pair?") || !expiresAt) return null;
  if (size < 21 || size > 177) return null;
  if (
    !modules.every(
      (row) =>
        typeof row === "string" && row.length === size && /^[01]+$/.test(row),
    )
  )
    return null;
  return {
    uri,
    modules: modules as string[],
    expiresAt,
    relay: d.relay === true,
    directUrls: strings(d.direct_urls),
  };
}

/** Le chemin SVG des modules sombres, une ligne à la fois, les suites fondues en un rectangle. */
export function qrPath(modules: string[], margin = 4): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "1") {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === "1") x += 1;
      parts.push(
        `M${start + margin} ${y + margin}h${x - start}v1h-${x - start}z`,
      );
    }
  });
  return parts.join("");
}

/** Les téléphones d'un NAS fictif : jamais un vrai téléphone. */
export function demoPhones(now: Date, lang: Locale): PhonesOk {
  const fictive = tr(lang, { en: "fictitious", fr: "fictif" });
  const day = 86_400_000;
  return {
    kind: "ok",
    relay: {
      configured: true,
      joined: true,
      host: "api.nasrelay.com",
      directUrls: [],
      lastDepositAt: new Date(now.getTime() - 60_000).toISOString(),
      lastError: null,
    },
    pairing: { open: false, expiresAt: null },
    phones: [
      {
        id: `${"0".repeat(31)}1`,
        name: `iPhone (${fictive})`,
        via: "relay",
        pairedAt: new Date(now.getTime() - 12 * day).toISOString(),
        lastReadAt: null,
      },
      {
        id: `${"0".repeat(31)}2`,
        name: `Pixel (${fictive})`,
        via: "direct",
        pairedAt: new Date(now.getTime() - 3 * day).toISOString(),
        lastReadAt: new Date(now.getTime() - 3_600_000).toISOString(),
      },
    ],
  };
}

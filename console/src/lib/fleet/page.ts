import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Texts } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { getNas, nasName } from "./index";
import type { Nas } from "./types";

type NasParams = { params: Promise<{ lang: string; nasId: string }> };

/** Le NAS d'une page `/nas/[nasId]/…`, dans la langue de la page, ou la page 404. */
export async function nasFromParams(
  params: Promise<{ lang: string; nasId: string }>,
): Promise<Nas> {
  const nas = await getNas((await params).nasId, await pageLocale(params));
  if (!nas) notFound();
  return nas;
}

/** Titre d'onglet du navigateur : « Santé · NAS d'essai · Fulmar ». */
export function tabMetadata(label: Texts) {
  return async ({ params }: NasParams): Promise<Metadata> => {
    const lang = await pageLocale(params);
    const name = nasName((await params).nasId, lang);
    const text = label[lang];
    return { title: name ? `${text} · ${name}` : text };
  };
}

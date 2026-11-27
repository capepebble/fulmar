import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Theme } from "@/components/theme";
import { tr } from "@/i18n";
import { LocaleProvider } from "@/i18n/client";
import { isLocale, LOCALES } from "@/i18n/locales";
import { PRODUCT_NAME } from "@/lib/product";
import "../globals.css";

// Racine de la console, une par langue (conception du moteur en anglais) : le contrôle d'accès
// réécrit chaque adresse vers /en/… ou /fr/… sans la changer, et chaque page est prérendue
// dans les deux langues.

export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const l = isLocale(lang) ? lang : "en";
  return {
    title: {
      default: `${tr(l, { en: "Fleet", fr: "Le parc" })} · ${PRODUCT_NAME}`,
      template: `%s · ${PRODUCT_NAME}`,
    },
    description: tr(l, {
      en: "Fleet of NAS read by their agents, read-only.",
      fr: "Suivi d'un parc de NAS par leurs agents, en lecture seule.",
    }),
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return (
    <html lang={lang} className="antialiased" suppressHydrationWarning>
      <body className="min-h-dvh">
        <LocaleProvider locale={lang}>
          <Theme>{children}</Theme>
        </LocaleProvider>
      </body>
    </html>
  );
}

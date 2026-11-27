import type { NextConfig } from "next";
import { LOCALE_HEADER, LOCALES } from "./src/i18n/locales";

const nextConfig: NextConfig = {
  // Construction autonome pour l'image de la console (console/deploy/Dockerfile).
  output: "standalone",
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // La langue choisie par le proxy (en-tête de la requête) : /nas/essai servie par
  // /fr/nas/essai, sans changer l'adresse. Réécritures internes de Next.js, toujours relatives
  // (voir `localized` dans src/proxy.ts).
  rewrites() {
    return {
      beforeFiles: LOCALES.map((locale) => ({
        source: "/:path*",
        has: [{ type: "header" as const, key: LOCALE_HEADER, value: locale }],
        destination: `/${locale}/:path*`,
      })),
      afterFiles: [],
      fallback: [],
    };
  },
  // Anciennes adresses des onglets d'un NAS (avant la refonte du 2026-11-21).
  redirects() {
    return [
      {
        source: "/nas/:nasId/health",
        destination: "/nas/:nasId/checks",
        permanent: true,
      },
      {
        source: "/nas/:nasId/connected",
        destination: "/nas/:nasId/activity",
        permanent: true,
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

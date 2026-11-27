"use client";

import { ThemeProvider } from "next-themes";

/** Le thème (système, clair ou sombre) de toutes les pages, coque comme pages d'accès. */
export function Theme({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}

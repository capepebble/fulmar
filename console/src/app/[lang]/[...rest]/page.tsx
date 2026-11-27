import { notFound } from "next/navigation";

// Toute adresse inconnue : la page « introuvable » de la langue. Rien à précharger ni à
// valider pour une navigation instantanée : elle ne rend jamais que la 404.
export const instant = false;

export default function Unknown() {
  notFound();
}

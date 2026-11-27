import type { Tone } from "./tone";

/** Barre de remplissage ; neutre tant que l'agent ne dit pas mieux (ambre, rouge). Elle double
 * le pourcentage écrit à côté : les lecteurs d'écran lisent le chiffre, pas la barre. */
export function FillBar({
  pct,
  tone = "ok",
  width = 72,
}: {
  pct: number;
  tone?: Tone;
  width?: number | "full";
}) {
  const shown = Math.min(100, Math.max(0, pct));
  return (
    <span
      className="bar"
      style={{ width: width === "full" ? "100%" : width }}
      aria-hidden="true"
    >
      <span
        className={tone === "off" ? "fill-ok" : `fill-${tone}`}
        style={{ width: `${shown}%` }}
      />
    </span>
  );
}

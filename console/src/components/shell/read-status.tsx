"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { formatAgo } from "@/lib/agents/time";
import { cn } from "@/lib/format";
import { useConsole } from "../console-provider";

/** « Lu il y a 12 s », compté depuis l'heure réelle de la lecture, et le bouton Relire. */
export function ReadStatus({
  readAt,
  tz,
  initial,
}: {
  readAt: string | null;
  tz: string;
  /** Le texte rendu par le serveur, gardé jusqu'à la première mesure dans le navigateur. */
  initial: string | null;
}) {
  const { reload, reading } = useConsole();
  const lang = useLocale();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  const ago = readAt && now ? formatAgo(readAt, now, tz, lang) : null;
  const text = reading
    ? tr(lang, { en: "Reading…", fr: "Lecture…" })
    : ago
      ? tr(lang, { en: `Read ${ago}`, fr: `Lu ${ago}` })
      : initial;
  return (
    <div className="flex items-center gap-3">
      {text ? (
        <span className="meta" aria-live="polite">
          {text}
        </span>
      ) : null}
      <button
        type="button"
        className="btn hidden md:inline-flex"
        onClick={reload}
        disabled={reading}
        title={tr(lang, { en: "Read again (R)", fr: "Relire (R)" })}
      >
        <RefreshCw
          className={cn(
            "icon",
            reading && "animate-spin [animation-duration:900ms]",
          )}
          aria-hidden="true"
        />
        {tr(lang, { en: "Read again", fr: "Relire" })}
      </button>
    </div>
  );
}

import { type Locale, tr } from "@/i18n";
import { consoleTimeZone, formatAgo } from "@/lib/agents/time";
import type { NasState } from "@/lib/fleet/state";
import type { Status } from "@/lib/fleet/types";
import { Dot } from "../ui/dot";
import { ReadStatus } from "./read-status";

/** « Lu il y a 12 s », « Read 12 s ago ». */
export function readLine(ago: string, lang: Locale): string {
  return tr(lang, { en: `Read ${ago}`, fr: `Lu ${ago}` });
}

/** En-tête d'une page : titre, phrase d'état (la première partie en gras), « Lu il y a » et
 * Relire. Sur téléphone, Relire est dans l'en-tête collant. */
export function PageHeader({
  lang,
  title,
  sentence,
  state,
  readAt = null,
  now,
  badges,
  actions,
  children,
}: {
  lang: Locale;
  title: React.ReactNode;
  /** Badges de compte, à droite du titre. */
  badges?: React.ReactNode;
  sentence?: string;
  state?: NasState | Status;
  readAt?: string | null;
  /** Heure du rendu, pour le premier « Lu il y a » écrit par le serveur. */
  now?: Date;
  /** Les gestes de la page (« Ajouter un NAS »), à gauche de « Relire ». */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const tz = consoleTimeZone();
  const [head, ...rest] = sentence ? sentence.split(" · ") : [];
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 font-bold text-[28px] leading-[1.15] tracking-[0.004em] max-md:text-[30px]">
            {title}
          </h1>
          {badges}
        </div>
        {sentence ? (
          <div className="flex items-start gap-2 text-[14px] text-fg-2 max-md:text-[14.5px]">
            {state ? (
              <span className="mt-[7px] flex">
                <Dot state={state} />
              </span>
            ) : null}
            <span className="min-w-0">
              <strong className="font-semibold text-fg">{head}</strong>
              {rest.length ? ` · ${rest.join(" · ")}` : null}
            </span>
          </div>
        ) : null}
        {children}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <ReadStatus
          readAt={readAt}
          tz={tz}
          initial={
            readAt && now
              ? readLine(formatAgo(readAt, now, tz, lang), lang)
              : null
          }
        />
      </div>
    </header>
  );
}

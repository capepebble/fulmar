import { ChevronRight } from "lucide-react";
import { type Locale, tr } from "@/i18n";
import { INTL_TAG } from "@/i18n/locales";
import { nasVerdict } from "@/lib/fleet/brief";
import { LIGHT_LABEL, LIGHT_WORD, lights } from "@/lib/fleet/lights";
import { STATUS_LABEL } from "@/lib/fleet/state";
import type { Check, Nas } from "@/lib/fleet/types";
import { cn, plural } from "@/lib/format";
import { memory } from "@/lib/store/memory";
import type { View } from "@/lib/view";
import { LightDot } from "../ui/lights";
import { FollowSwitch } from "./follow-switch";
import { VerdictHead } from "./verdict";

// La synthèse d'un NAS en détail (conception 2026-11-24, section 5) : le verdict (le même haut
// qu'en bref, conception 2026-11-25-fiche-en-bref), puis un voyant par catégorie, chacun
// dépliable : ses contrôles (lu, attendu, conseil, depuis quand) et l'interrupteur « Suivre ».

const DOT: Record<Check["status"], string> = {
  failed: "d-crit",
  warning: "d-warn",
  ok: "d-ok",
  unknown: "d-off",
};

export function Synthesis({
  nas,
  view,
  now,
  tz,
  lang,
}: {
  nas: Nas;
  view: View;
  now: Date;
  tz: string;
  lang: Locale;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const ls = lights(nas);
  if (ls.length === 0) return null;
  const everywhere = new Set(
    memory()
      .unfollowed()
      .filter((r) => r.scope === "*")
      .map((r) => r.checkId),
  );
  const since = new Intl.DateTimeFormat(INTL_TAG[lang], {
    day: "numeric",
    month: "short",
    timeZone: tz,
  });

  return (
    <section className="card overflow-clip" aria-labelledby="synthese">
      <VerdictHead
        nas={nas}
        verdict={nasVerdict(nas, now, tz, lang)}
        view={view}
      />
      <ul className="m-0 list-none p-0">
        {ls.map((l) => {
          const checks = nas.checks.filter((c) => c.category === l.id);
          return (
            <li key={l.id} className="row !p-0">
              <details
                className="group w-full"
                open={l.light === "failed" || undefined}
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-[18px] py-2.5 hover:bg-[var(--hover)] [&::-webkit-details-marker]:hidden">
                  <LightDot id={l.id} light={l.light} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {LIGHT_LABEL[l.id][lang]}
                    </span>
                    <span className="meta block">
                      {LIGHT_WORD[l.light][lang]} ·{" "}
                      {lang === "en"
                        ? plural(checks.length, "check", "checks", lang)
                        : plural(checks.length, "contrôle", "contrôles", lang)}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-4 text-fg-3 transition-transform duration-200 group-open:rotate-90"
                    aria-hidden="true"
                  />
                </summary>
                <div className="flex flex-col gap-2 px-[18px] pb-4">
                  {checks.map((c) => {
                    const off = c.followed === false;
                    const seen = nas.seen[c.id];
                    return (
                      <div
                        key={c.id}
                        id={c.id}
                        className="flex flex-col gap-1.5 rounded-[10px] bg-surface-2 px-3.5 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div
                            className={cn(
                              "flex min-w-0 items-start gap-2",
                              off && "opacity-55",
                            )}
                          >
                            <span
                              className={cn("dot mt-[6px]", DOT[c.status])}
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              <span className="block font-semibold">
                                {c.title}
                              </span>
                              <span className="meta block">
                                {off
                                  ? t("Not followed · ", "Non suivi · ")
                                  : ""}
                                {STATUS_LABEL[c.status][lang]}
                                {c.severity === "info"
                                  ? t(
                                      " · for information",
                                      " · à titre indicatif",
                                    )
                                  : ""}
                                {seen && c.status !== "unknown"
                                  ? t(
                                      ` · since ${since.format(new Date(seen))}`,
                                      ` · depuis le ${since.format(new Date(seen))}`,
                                    )
                                  : ""}
                              </span>
                            </span>
                          </div>
                          <FollowSwitch
                            nasId={nas.id}
                            checkId={c.id}
                            title={c.title}
                            followed={!off}
                            everywhere={everywhere.has(c.id)}
                          />
                        </div>
                        <p
                          className={cn(
                            "m-0 text-[13px] text-fg-2",
                            off && "opacity-55",
                          )}
                        >
                          {c.observed}
                        </p>
                        {c.advice && c.status !== "ok" && !off ? (
                          <p className="m-0 text-[13px]">
                            <span className="font-semibold">
                              {t("To do: ", "À faire : ")}
                            </span>
                            {c.advice}
                          </p>
                        ) : null}
                        {c.items.length && !off ? (
                          <ul className="meta m-0 list-disc pl-5">
                            {c.items.slice(0, 6).map((it) => (
                              <li key={it}>{it}</li>
                            ))}
                            {c.items.length > 6 ? (
                              <li>
                                {t(
                                  `and ${c.items.length - 6} more`,
                                  `et ${c.items.length - 6} autres`,
                                )}
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

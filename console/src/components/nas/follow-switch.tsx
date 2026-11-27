"use client";

import { useState, useTransition } from "react";
import { setFollow } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { cn } from "@/lib/format";

// Le suivi choisi (conception 2026-11-24, section 3) : un interrupteur par contrôle, sur ce
// NAS ; « sur tout le parc » à part. Une préférence de la console, jamais une action sur le NAS.

export function FollowSwitch({
  nasId,
  checkId,
  title,
  followed,
  everywhere,
}: {
  nasId: string;
  checkId: string;
  title: string;
  followed: boolean;
  /** Non suivi sur tout le parc (et non sur ce seul NAS). */
  everywhere: boolean;
}) {
  const [on, setOn] = useState(followed);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const change = (scope: string, follow: boolean) =>
    start(async () => {
      setError(null);
      if (scope === nasId) setOn(follow);
      const r = await setFollow(scope, checkId, follow, lang);
      if (!r.ok) {
        if (scope === nasId) setOn(!follow);
        setError(
          r.reason ??
            t(
              "The choice could not be kept.",
              "Le choix n'a pas pu être retenu.",
            ),
        );
      }
    });

  if (everywhere)
    return (
      <span className="flex flex-col items-end gap-0.5 text-right">
        <span className="meta">
          {t("Not followed across the fleet", "Non suivi sur tout le parc")}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => change("*", true)}
          className="text-[12px] text-[var(--accent)] disabled:opacity-50"
        >
          {t("Follow again everywhere", "Suivre de nouveau partout")}
        </button>
      </span>
    );

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t(
          `Follow “${title}” on this NAS`,
          `Suivre « ${title} » sur ce NAS`,
        )}
        disabled={pending}
        onClick={() => change(nasId, !on)}
        className={cn(
          "relative h-[22px] w-[38px] flex-none rounded-full transition-colors duration-200 disabled:opacity-60",
          on ? "bg-[var(--accent)]" : "bg-[var(--segmented)]",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-[2px] left-[2px] size-[18px] rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.2)] transition-transform duration-300 [transition-timing-function:var(--spring)]",
            on && "translate-x-4",
          )}
        />
      </button>
      {error ? (
        <span
          role="alert"
          className="max-w-[220px] text-right text-[11.5px] text-crit-text"
        >
          {error}
        </span>
      ) : null}
      {on ? null : (
        <button
          type="button"
          disabled={pending}
          onClick={() => change("*", false)}
          className="text-[11.5px] text-fg-3 hover:text-fg disabled:opacity-50"
        >
          {t("Follow it nowhere", "Ne le suivre nulle part")}
        </button>
      )}
    </span>
  );
}

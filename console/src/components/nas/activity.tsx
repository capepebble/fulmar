"use client";

import { useState } from "react";
import { type Texts, tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { groupRepeats } from "@/lib/fleet/activity";
import type {
  ActivityEvent,
  ActivitySource,
  Connection,
  FileLogState,
} from "@/lib/fleet/types";
import { Card, CardHeader } from "../ui/card";

const SOURCES: { value: ActivitySource; label: Texts }[] = [
  { value: "connections", label: { en: "Sign-ins", fr: "Connexions" } },
  {
    value: "settings",
    label: { en: "DSM settings and tasks", fr: "Réglages et tâches DSM" },
  },
  { value: "files", label: { en: "Files", fr: "Fichiers" } },
];

const FILES_NOTE: Record<FileLogState, Texts | null> = {
  on: null,
  off: {
    en: "DSM’s transfer logs are off on this NAS: only the actions logged before remain visible.",
    fr: "Les journaux de transfert de DSM sont coupés sur ce NAS : seules les actions notées avant restent visibles.",
  },
  unknown: {
    en: "Transfer log setting unreadable: the console doesn’t know whether DSM logs files.",
    fr: "Réglage des journaux de transfert illisible : la console ne sait pas si DSM note les fichiers.",
  },
};

/** Qui est connecté maintenant. */
export function ConnectedCard({ connected }: { connected: Connection[] }) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <Card labelledBy="connectes">
      <CardHeader
        id="connectes"
        title={t("Signed in now", "Connectés maintenant")}
        meta={
          connected.length ? `${connected.length}` : t("nobody", "personne")
        }
      />
      {connected.map((c, i) => (
        <div key={`${c.who}-${c.protocol}-${i}`} className="row flex-wrap">
          <span className="font-semibold">{c.who}</span>
          {c.isAgent ? <span className="tag">agent</span> : null}
          <span className="text-fg-2">
            {c.protocol} · {c.device}
          </span>
          <span className="meta ml-auto">
            {t(`since ${c.since}`, `depuis ${c.since}`)} · {c.from}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** Le journal d'un NAS, par jour, filtrable par source ; les rafales identiques regroupées. */
export function ActivityJournal({
  events,
  fileLogs,
  limit,
}: {
  events: ActivityEvent[];
  fileLogs: FileLogState;
  /** Aperçu (vue d'ensemble) : les N dernières lignes, sans filtre. */
  limit?: number;
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const note = FILES_NOTE[fileLogs]?.[lang] ?? null;
  const filesReadable =
    fileLogs === "on" || events.some((e) => e.source === "files");
  const [shown, setShown] = useState<Set<ActivitySource>>(
    new Set(
      filesReadable
        ? ["connections", "settings", "files"]
        : ["connections", "settings"],
    ),
  );
  const visible = (
    limit ? events : events.filter((e) => shown.has(e.source))
  ).slice(0, limit ?? events.length);
  const days = [...new Set(visible.map((e) => e.day))];
  const toggle = (s: ActivitySource) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      {limit ? null : (
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">
            {t("Log sources", "Sources du journal")}
          </legend>
          {SOURCES.map((s) => {
            const disabled = s.value === "files" && !filesReadable;
            return (
              <button
                key={s.value}
                type="button"
                className="chip"
                aria-pressed={shown.has(s.value)}
                aria-current={shown.has(s.value) ? "page" : undefined}
                disabled={disabled}
                onClick={() => toggle(s.value)}
                title={disabled ? (note ?? undefined) : undefined}
              >
                {s.label[lang]}
              </button>
            );
          })}
        </fieldset>
      )}
      {!limit && note ? <p className="meta m-0">{note}</p> : null}
      {days.length === 0 ? (
        <p className="m-0 text-fg-2">
          {t(
            "Nothing in the log for these sources.",
            "Rien dans le journal pour ces sources.",
          )}
        </p>
      ) : (
        days.map((day) => (
          <section key={day} className="card" aria-label={day}>
            <h3 className="m-0 px-[18px] pt-3 pb-2 font-semibold text-[13.5px]">
              {day}
            </h3>
            <ol className="m-0 list-none p-0">
              {groupRepeats(visible.filter((e) => e.day === day)).map(
                (e, i) => (
                  <li
                    // DSM note parfois la même ligne plusieurs fois dans la même minute.
                    key={`${i}-${e.time}-${e.who}-${e.text}`}
                    className="flex items-start gap-3.5 border-border border-t px-[18px] py-2.5 text-[13.5px]"
                  >
                    <span
                      className={`flex-none text-fg-3 ${lang === "en" ? "w-[4.5rem]" : "w-11"}`}
                    >
                      {e.time}
                    </span>
                    <span
                      className={`dot mt-1.5 ${e.level === "warning" ? "d-warn" : "d-off"}`}
                      role="img"
                      aria-label={
                        e.level === "warning"
                          ? t("Warning", "À surveiller")
                          : t("Information", "Information")
                      }
                    />
                    <span className="min-w-0 grow">
                      <span className="font-semibold">{e.who}</span> {e.text}
                    </span>
                    {e.count > 1 ? (
                      <span className="meta whitespace-nowrap">
                        {e.since === e.time
                          ? t(`${e.count} times`, `${e.count} fois`)
                          : t(
                              `${e.count} times, from ${e.since} to ${e.time}`,
                              `${e.count} fois, de ${e.since} à ${e.time}`,
                            )}
                      </span>
                    ) : null}
                  </li>
                ),
              )}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

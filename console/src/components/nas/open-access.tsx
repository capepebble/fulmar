"use client";

import { useState, useTransition } from "react";
import { changeNasAccess } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import {
  type AccessChange,
  type AccessMode,
  DURATIONS,
  type ServiceWatch,
  type WatchView,
} from "@/lib/agents/close-access";
import { formatClock } from "@/lib/agents/time";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";

const NAME = { ssh: "SSH", telnet: "Telnet" } as const;
const SELECT = "btn h-[30px] appearance-none pr-3 font-normal max-md:h-9";

/** « Accès ouverts » (onglet Sécurité) : SSH et Telnet, la règle de chacun, son échéance, et
 * « Fermer maintenant ». Fulmar ferme, il n'ouvre jamais (conception 2026-11-26-fermer-acces). */
export function OpenAccess({
  nasId,
  initial,
  tz,
}: {
  nasId: string;
  initial: WatchView;
  tz: string;
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (view.kind !== "ok")
    return (
      <Card labelledBy="acces-ouverts">
        <CardHeader
          id="acces-ouverts"
          title={t("Open access", "Accès ouverts")}
        />
        <p className="m-0 px-[18px] py-4 text-fg-2">{view.reason}</p>
      </Card>
    );

  const clock = (iso: string) => formatClock(iso, tz, lang);
  const durations = DURATIONS.map((m) => ({
    value: m,
    label: m < 60 ? `${m} min` : `${m / 60} h`,
  }));
  const modeLabel: Record<AccessMode, string> = {
    off: t("Do nothing", "Ne rien faire"),
    remind: t("Remind me", "Me le rappeler"),
    close: t("Close it", "Le fermer"),
  };
  const act = !view.demo && view.canAct;

  function change(service: ServiceWatch["service"], c: AccessChange) {
    setError(null);
    start(async () => {
      const result = await changeNasAccess(nasId, service, c, lang);
      setConfirming(null);
      if (!result.ok) return setError(result.reason);
      setView((v) =>
        v.kind === "ok"
          ? {
              ...v,
              services: v.services.map((s) =>
                s.service === service ? result.value : s,
              ),
            }
          : v,
      );
    });
  }

  function stateLine(s: ServiceWatch): string {
    if (s.open === null) return t("State not read yet", "État pas encore lu");
    if (!s.open)
      return s.closedAt
        ? t(
            `Closed by Fulmar at ${clock(s.closedAt)}`,
            `Fermé par Fulmar à ${clock(s.closedAt)}`,
          )
        : t("Closed", "Fermé");
    return s.openSince
      ? t(
          `Open since ${clock(s.openSince)}`,
          `Ouvert depuis ${clock(s.openSince)}`,
        )
      : t("Open", "Ouvert");
  }

  function deadlineLine(s: ServiceWatch): string | null {
    if (!s.open || !s.deadline || s.mode === "off") return null;
    return s.mode === "close"
      ? t(
          `Fulmar closes it at ${clock(s.deadline)}, with a reminder 10 minutes before.`,
          `Fulmar le ferme à ${clock(s.deadline)}, avec un rappel 10 minutes avant.`,
        )
      : t(
          `Reminder at ${clock(s.deadline)} if it is still open.`,
          `Rappel à ${clock(s.deadline)} s'il est encore ouvert.`,
        );
  }

  return (
    <Card labelledBy="acces-ouverts">
      <CardHeader
        id="acces-ouverts"
        title={t("Open access", "Accès ouverts")}
        meta={t(
          "Fulmar closes, it never opens",
          "Fulmar ferme, il n'ouvre jamais",
        )}
      />
      {view.services.map((s) => {
        const deadline = deadlineLine(s);
        return (
          <div key={s.service} className="row flex-wrap items-start gap-y-3">
            <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                {NAME[s.service]}
                {s.open ? (
                  <ToneBadge tone={s.service === "telnet" ? "crit" : "warn"}>
                    {t("open", "ouvert")}
                  </ToneBadge>
                ) : s.open === false ? (
                  <ToneBadge tone="ok">{t("closed", "fermé")}</ToneBadge>
                ) : null}
              </span>
              <span className="meta">{stateLine(s)}</span>
              {deadline ? <span className="meta">{deadline}</span> : null}
            </div>
            {act ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
                  <span className="sr-only">
                    {t(
                      `Rule for ${NAME[s.service]}`,
                      `Règle pour ${NAME[s.service]}`,
                    )}
                  </span>
                  <select
                    className={SELECT}
                    value={s.mode}
                    disabled={busy}
                    onChange={(e) =>
                      change(s.service, {
                        kind: "policy",
                        mode: e.target.value as AccessMode,
                        minutes: DURATIONS.includes(s.minutes) ? s.minutes : 60,
                      })
                    }
                  >
                    {(["off", "remind", "close"] as const).map((m) => (
                      <option key={m} value={m}>
                        {modeLabel[m]}
                      </option>
                    ))}
                  </select>
                </label>
                {s.mode !== "off" ? (
                  <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
                    <span>{t("after", "après")}</span>
                    <select
                      className={SELECT}
                      value={DURATIONS.includes(s.minutes) ? s.minutes : 60}
                      disabled={busy}
                      onChange={(e) =>
                        change(s.service, {
                          kind: "policy",
                          mode: s.mode,
                          minutes: Number(e.target.value),
                        })
                      }
                    >
                      {durations.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {s.open && s.deadline && s.mode !== "off" ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      change(s.service, { kind: "extend", minutes: 60 })
                    }
                  >
                    {t("One more hour", "Une heure de plus")}
                  </button>
                ) : null}
                {s.open ? (
                  confirming === s.service ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={busy}
                        onClick={() => change(s.service, { kind: "close" })}
                      >
                        {t(
                          `Close ${NAME[s.service]}`,
                          `Fermer ${NAME[s.service]}`,
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setConfirming(null)}
                      >
                        {t("Cancel", "Annuler")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setConfirming(s.service)}
                    >
                      {t("Close now…", "Fermer maintenant…")}
                    </button>
                  )
                ) : null}
              </div>
            ) : null}
            {confirming === s.service && s.service === "ssh" ? (
              <p className="meta m-0 w-full">
                {t(
                  "Open SSH sessions are cut. Fulmar cannot open SSH again: that is done in DSM (Control Panel, Terminal & SNMP).",
                  "Les sessions SSH ouvertes sont coupées. Fulmar ne peut pas rouvrir SSH : cela se fait dans DSM (Panneau de configuration, Terminal et SNMP).",
                )}
              </p>
            ) : null}
          </div>
        );
      })}
      <p className="meta m-0 px-[18px] py-3">
        {view.demo
          ? t(
              "Fictitious NAS: an example, without any gesture.",
              "NAS fictif : un exemple, sans geste.",
            )
          : !view.canAct
            ? t(
                "This console’s token lacks the access:close right: create it again on the NAS with that right.",
                "Le jeton de cette console n'a pas le droit access:close : le recréer sur le NAS avec ce droit.",
              )
            : t(
                "Alerts go to the engine’s channels and to the paired phones.",
                "Les rappels partent par les canaux d'alerte du moteur et vers les téléphones appairés.",
              )}
      </p>
      {error ? (
        <p
          role="alert"
          className="m-0 px-[18px] pb-3 text-[14px] text-crit-text"
        >
          {error}
        </p>
      ) : null}
    </Card>
  );
}

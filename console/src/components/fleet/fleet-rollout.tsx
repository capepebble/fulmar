"use client";

import { useEffect, useState, useTransition } from "react";
import { cancelRollout, planRollout, rolloutsOf } from "@/app/actions";
import { type Locale, tr } from "@/i18n";
import type { Rollout, StepState } from "@/lib/agents/rollouts";
import { folderSections } from "@/lib/fleet/folders";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";
import type { UpdatableNas } from "./updates-board";

// « Mettre à jour le parc » (conception 2026-11-26-groupes-protections-parc, section 3) : le
// hub met à jour un NAS après l'autre, saute ce qui est protégé, s'arrête au premier échec.

const POLL_MS = 5_000;

const STEP_TONE: Record<StepState, Tone> = {
  pending: "off",
  running: "off",
  done: "ok",
  skipped: "off",
  failed: "crit",
  stopped: "off",
};

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FleetRollout({
  lang,
  fleet,
  initial,
}: {
  lang: Locale;
  fleet: UpdatableNas[];
  initial: { running: boolean; rollouts: Rollout[] } | { reason: string };
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const [state, setState] = useState(initial);
  const [target, setTarget] = useState<"packages" | "dsm">("packages");
  const [chosen, setChosen] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [accept, setAccept] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const members = fleet.filter((n) => n.live && n.rolloutKey);
  const byKey = new Map(members.map((n) => [n.rolloutKey as string, n]));
  const active =
    "rollouts" in state
      ? state.rollouts.find(
          (r) => r.state === "waiting" || r.state === "running",
        )
      : undefined;
  const last = "rollouts" in state ? state.rollouts[0] : undefined;

  // Pendant un déroulé : relire toutes les cinq secondes.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(async () => {
      const got = await rolloutsOf(lang);
      if (got.ok) setState(got.value);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [active, lang]);

  if (!members.length) return null;

  const blocked = (n: UpdatableNas) =>
    Boolean(n.held?.frozen || (target === "dsm" && n.held?.dsmLocked));
  const nameOf = (key: string) => byKey.get(key)?.name ?? key;
  const order = members
    .filter((n) => chosen.includes(n.rolloutKey as string))
    .map((n) => n.rolloutKey as string)
    .sort((a, b) => (a === "hub" ? 1 : b === "hub" ? -1 : 0));

  function toggle(keys: string[], on: boolean) {
    setConfirming(false);
    setChosen((c) =>
      on ? [...new Set([...c, ...keys])] : c.filter((k) => !keys.includes(k)),
    );
  }

  function launch() {
    setError(null);
    start(async () => {
      const got = await planRollout(
        {
          target,
          nas: order,
          at: later && when ? new Date(when).toISOString() : null,
          acceptWarnings: accept,
        },
        lang,
      );
      setConfirming(false);
      if (!got.ok) return setError(got.reason);
      setChosen([]);
      const fresh = await rolloutsOf(lang);
      if (fresh.ok) setState(fresh.value);
    });
  }

  function stop(id: string) {
    start(async () => {
      const got = await cancelRollout(id, lang);
      if (!got.ok && got.reason) setError(got.reason);
      const fresh = await rolloutsOf(lang);
      if (fresh.ok) setState(fresh.value);
    });
  }

  const stepWord = (s: StepState) =>
    ({
      pending: t("Waiting", "En attente"),
      running: t("Updating…", "En cours…"),
      done: t("Done", "Fait"),
      skipped: t("Skipped", "Sauté"),
      failed: t("Failed", "En échec"),
      stopped: t("Not run", "Pas lancé"),
    })[s];

  const shown = active ?? (last && last.state !== "waiting" ? last : undefined);

  return (
    <Card labelledBy="maj-parc">
      <CardHeader
        id="maj-parc"
        title={t("Update the fleet", "Mettre à jour le parc")}
        meta={t(
          "one NAS after the other, stopping at the first failure",
          "un NAS après l'autre, arrêt au premier échec",
        )}
      />
      {"reason" in state ? (
        <p className="m-0 px-[18px] py-4 text-fg-2">{state.reason}</p>
      ) : null}
      {shown ? (
        <div className="flex flex-col">
          <div className="row justify-between">
            <span className="flex flex-col">
              <span className="font-medium">
                {shown.target === "dsm" ? "DSM" : t("Packages", "Paquets")}
                {" · "}
                {
                  {
                    waiting: t(
                      `planned for ${new Date(shown.at).toLocaleString(lang)}`,
                      `prévu le ${new Date(shown.at).toLocaleString(lang)}`,
                    ),
                    running: t("running", "en cours"),
                    done: t("finished", "terminé"),
                    failed: t("stopped on a failure", "arrêté sur un échec"),
                    cancelled: t("stopped", "arrêté"),
                  }[shown.state]
                }
              </span>
              {shown.reason ? (
                <span className="meta">{shown.reason}</span>
              ) : null}
            </span>
            {active ? (
              <button
                type="button"
                className="btn"
                disabled={busy || active.cancel}
                onClick={() => stop(active.id)}
              >
                {active.cancel
                  ? t("Stopping after this NAS…", "Arrêt après ce NAS…")
                  : active.state === "waiting"
                    ? t("Cancel", "Annuler")
                    : t("Stop after this NAS", "Arrêter après ce NAS")}
              </button>
            ) : null}
          </div>
          {shown.steps.map((s) => (
            <div key={s.nas} className="row justify-between gap-3 py-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{nameOf(s.nas)}</span>
                {s.reason ? <span className="meta">{s.reason}</span> : null}
              </span>
              <ToneBadge tone={STEP_TONE[s.state]}>
                {stepWord(s.state)}
              </ToneBadge>
            </div>
          ))}
        </div>
      ) : null}
      {!active ? (
        <div className="flex flex-col gap-3 px-[18px] py-4">
          <fieldset
            className="seg w-fit"
            aria-label={t("What to update", "Quoi mettre à jour")}
          >
            {(["packages", "dsm"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="seg-b"
                aria-current={target === k}
                onClick={() => {
                  setTarget(k);
                  setConfirming(false);
                }}
              >
                {k === "dsm" ? "DSM" : t("Packages", "Paquets")}
              </button>
            ))}
          </fieldset>
          {folderSections(members).map((section) => {
            const keys = section.items
              .filter((n) => !blocked(n))
              .map((n) => n.rolloutKey as string);
            const all =
              keys.length > 0 && keys.every((k) => chosen.includes(k));
            return (
              <div key={section.key} className="flex flex-col gap-1">
                <label className="meta flex cursor-pointer items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={all}
                    disabled={!keys.length || busy}
                    onChange={() => toggle(keys, !all)}
                  />
                  {section.folder?.name ?? t("No group", "Sans groupe")}
                </label>
                {section.items.map((n) => {
                  const key = n.rolloutKey as string;
                  const off = blocked(n);
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 pl-6 text-[14px]"
                    >
                      <input
                        type="checkbox"
                        checked={!off && chosen.includes(key)}
                        disabled={off || busy}
                        onChange={() => toggle([key], !chosen.includes(key))}
                      />
                      <span>{n.name}</span>
                      {off ? (
                        <span className="meta">
                          {n.held?.frozen
                            ? t("frozen", "gelé")
                            : t("DSM locked", "DSM verrouillé")}
                          {n.held?.note ? ` · « ${n.held.note} »` : ""}
                        </span>
                      ) : key === "hub" ? (
                        <span className="meta">
                          {t(
                            "this hub, always last",
                            "ce hub, toujours en dernier",
                          )}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3 text-[14px]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={later}
                onChange={() => setLater((l) => !l)}
              />
              {t("At a set time", "À une heure dite")}
            </label>
            {later ? (
              <input
                type="datetime-local"
                className="field h-[34px] w-auto text-[14px]"
                value={when}
                min={localInput(new Date(Date.now() + 2 * 60_000))}
                onChange={(e) => setWhen(e.target.value)}
              />
            ) : null}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={accept}
                onChange={() => setAccept((a) => !a)}
              />
              {t(
                "Go on despite DSM’s warnings",
                "Continuer malgré les avertissements de DSM",
              )}
            </label>
          </div>
          {confirming ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-[14px] text-fg-2">
                {t("In this order: ", "Dans cet ordre : ")}
                {order.map(nameOf).join(" → ")}
                {target === "dsm"
                  ? t(". Each NAS restarts.", ". Chaque NAS redémarre.")
                  : "."}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || (later && !when)}
                  onClick={launch}
                >
                  {t(
                    `Start on ${order.length} NAS`,
                    `Lancer sur ${order.length} NAS`,
                  )}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirming(false)}
                >
                  {t("Cancel", "Annuler")}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="btn"
                disabled={busy || !order.length || (later && !when)}
                onClick={() => setConfirming(true)}
              >
                {t("Start…", "Lancer…")}
              </button>
            </div>
          )}
          {error ? (
            <p role="alert" className="m-0 text-[14px] text-crit-text">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

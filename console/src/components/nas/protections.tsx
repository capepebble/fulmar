"use client";

import { Lock, LockOpen } from "lucide-react";
import { useState, useTransition } from "react";
import { changeProtections } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import {
  heldWords,
  type ProtectionChange,
  type ProtectionsView,
} from "@/lib/agents/protections";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";

/** « Ce que Fulmar ne touche pas » (onglet Accès) : geler le NAS, verrouiller DSM, protéger
 * des paquets, et la note qui dit pourquoi (conception 2026-11-26-groupes-protections-parc). */
export function ProtectionsCard({
  nasId,
  initial,
  packages,
  live,
}: {
  nasId: string;
  initial: ProtectionsView | { reason: string };
  packages: { id: string; name: string }[];
  live: boolean;
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const [view, setView] = useState(initial);
  const [note, setNote] = useState(
    "note" in initial ? (initial.note ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const names = Object.fromEntries(packages.map((p) => [p.id, p.name]));

  function apply(change: ProtectionChange) {
    setError(null);
    start(async () => {
      const result = await changeProtections(nasId, change, lang);
      if (!result.ok) return setError(result.reason);
      setView(result.value);
      setNote(result.value.note ?? "");
    });
  }

  if (!("frozen" in view))
    return (
      <Card labelledBy="protections">
        <CardHeader
          id="protections"
          title={t("What Fulmar leaves alone", "Ce que Fulmar ne touche pas")}
        />
        <p className="m-0 px-[18px] py-4 text-fg-2">{view.reason}</p>
      </Card>
    );

  const act = live && !busy;
  const toggle = (
    label: string,
    hint: string,
    on: boolean,
    change: ProtectionChange,
  ) => (
    <label className="row cursor-pointer justify-between gap-3">
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="meta">{hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={on}
        className="size-5 shrink-0 accent-[var(--accent)]"
        checked={on}
        disabled={!act}
        onChange={() => apply(change)}
      />
    </label>
  );

  return (
    <Card labelledBy="protections">
      <CardHeader
        id="protections"
        title={t("What Fulmar leaves alone", "Ce que Fulmar ne touche pas")}
        meta={t(
          "applied by the agent, whoever asks",
          "appliqué par l'agent, quel que soit l'appelant",
        )}
      />
      {toggle(
        t("Freeze this NAS", "Geler ce NAS"),
        t(
          "Fulmar updates nothing here, neither packages nor DSM.",
          "Fulmar n'y met plus rien à jour, ni paquet ni DSM.",
        ),
        view.frozen,
        { frozen: !view.frozen },
      )}
      {toggle(
        t("No DSM update", "Pas de mise à jour de DSM"),
        t(
          "So Fulmar never restarts this NAS.",
          "Ainsi Fulmar ne redémarre jamais ce NAS.",
        ),
        view.dsmLocked || view.frozen,
        { dsmLocked: !view.dsmLocked },
      )}
      <form
        className="row flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ note });
        }}
      >
        <input
          className="field h-[34px] min-w-[220px] flex-1 text-[14px]"
          value={note}
          maxLength={200}
          disabled={!live}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t(
            "Why (e.g. client cameras: never stop during the day)",
            "Pourquoi (par exemple : caméras du client, jamais d'arrêt en journée)",
          )}
          aria-label={t("Note", "Note")}
        />
        <button
          type="submit"
          className="btn"
          disabled={!act || note === (view.note ?? "")}
        >
          {t("Save the note", "Enregistrer la note")}
        </button>
      </form>
      <div className="px-[18px] pt-3 pb-1">
        <h3 className="meta m-0 font-medium uppercase tracking-[0.04em]">
          {t("Packages", "Paquets")}
        </h3>
      </div>
      {packages.map((p) => {
        const reason = view.held[p.id];
        const locked = view.packages.includes(p.id);
        const byDependency = reason?.startsWith("needed by ");
        return (
          <div key={p.id} className="row justify-between gap-3 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{p.name}</span>
              {p.id === "ContainerManager" ? (
                <span className="meta">
                  {t(
                    "Its update stops every container, Fulmar included.",
                    "Sa mise à jour arrête tous les conteneurs, Fulmar compris.",
                  )}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {reason && !locked ? (
                <ToneBadge tone="off" dot={false}>
                  {heldWords(reason, lang, names)}
                </ToneBadge>
              ) : null}
              {byDependency && !locked ? null : (
                <button
                  type="button"
                  className="btn h-[30px]"
                  disabled={!act || view.frozen}
                  aria-pressed={locked}
                  onClick={() =>
                    apply(locked ? { unlock: [p.id] } : { lock: [p.id] })
                  }
                  aria-label={
                    locked
                      ? t(`Release ${p.name}`, `Libérer ${p.name}`)
                      : t(`Protect ${p.name}`, `Protéger ${p.name}`)
                  }
                >
                  {locked ? (
                    <Lock
                      className="size-3.5 text-[var(--accent)]"
                      aria-hidden="true"
                    />
                  ) : (
                    <LockOpen
                      className="size-3.5 text-fg-3"
                      aria-hidden="true"
                    />
                  )}
                  {locked
                    ? t("Protected", "Protégé")
                    : t("Protect", "Protéger")}
                </button>
              )}
            </span>
          </div>
        );
      })}
      <p className="meta m-0 px-[18px] py-3">
        {!live
          ? t(
              "Fictitious NAS: an example, without any gesture.",
              "NAS fictif : un exemple, sans geste.",
            )
          : t(
              "A package that a protected one depends on is protected too: DSM stops it while updating.",
              "Un paquet dont dépend un paquet protégé l'est aussi : DSM l'arrête pendant sa mise à jour.",
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

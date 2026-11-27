"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  cancelScheduledUpdate,
  checkDsmUpdate,
  checkPackageUpdates,
  packageUpdateStatus,
  scheduleNasUpdate,
  startDsmUpdate,
  startPackageUpdates,
} from "@/app/actions";
import { type Locale, tr } from "@/i18n";
import { heldWords } from "@/lib/agents/protections";
import type {
  DsmRun,
  Feasibility,
  Scheduled,
  UpdateJob,
} from "@/lib/agents/updates";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";

// Page « Mises à jour » (conception 2026-11-26-mises-a-jour-paquets, sections 4 et 6.3) :
// cocher des paquets et DSM sur plusieurs NAS, faire dire à DSM ce que la mise à jour
// couperait, lancer tout de suite ou programmer, suivre. Un avertissement demande une
// confirmation ; un blocage retire le NAS du lot.

/** La ligne DSM dans la sélection : jamais un identifiant de paquet (« @ » n'y entre pas). */
const DSM = "@dsm";

export interface UpdatableNas {
  id: string;
  name: string;
  model: string;
  /** NAS fictif : rien ne part d'ici. */
  live: boolean;
  /** Ce que Fulmar laisse sur ce NAS (protections lues sur son agent) ; null : inconnu. */
  held: {
    frozen: boolean;
    dsmLocked: boolean;
    note: string | null;
    reasons: Record<string, string>;
  } | null;
  /** Son groupe, pour les mises à jour du parc. */
  folder: { id: string; name: string; rank: number } | null;
  /** Sa clé pour le hub (« hub » ou l'identifiant d'un NAS ajouté) ; null hors du parc du hub. */
  rolloutKey: string | null;
  dsm: { current: string; available: string } | null;
  packages: {
    id: string;
    name: string;
    version: string;
    update: string;
    security: boolean;
  }[];
}

interface Checked {
  feasibility: Feasibility;
  reasons: string[];
  ids: string[];
  dsm: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "checked"; plan: Checked }
  | { kind: "running"; job: UpdateJob }
  | { kind: "error"; reason: string };

const RUN_TONE: Record<UpdateJob["state"], Tone> = {
  pending: "off",
  running: "off",
  done: "ok",
  failed: "crit",
};

const WORST: Feasibility[] = ["ok", "warning", "unknown", "blocked"];
const worst = (a: Feasibility, b: Feasibility): Feasibility =>
  WORST.indexOf(a) >= WORST.indexOf(b) ? a : b;

/** « 2026-11-27T03:00 » dans le fuseau du navigateur, cinq minutes devant au plus tôt. */
/** Les noms des paquets d'un NAS, pour dire « Requis par Surveillance Station ». */
function names(n: UpdatableNas): Record<string, string> {
  return Object.fromEntries(n.packages.map((p) => [p.id, p.name]));
}

/** DSM laissé sur ce NAS : gelé ou verrouillé. */
function dsmHeld(n: UpdatableNas): boolean {
  return Boolean(n.held && (n.held.frozen || n.held.dsmLocked));
}

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function UpdatesBoard({
  lang,
  fleet,
}: {
  lang: Locale;
  fleet: UpdatableNas[];
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [phases, setPhases] = useState<Record<string, Phase>>({});
  const [schedules, setSchedules] = useState<Record<string, Scheduled[]>>({});
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [when, setWhen] = useState("");
  const [acceptLater, setAcceptLater] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const polling = useRef<Record<string, boolean>>({});
  // DSM à lancer quand les paquets du même NAS ont fini (un travail à la fois par NAS).
  const dsmAfter = useRef<Record<string, { accept: boolean } | null>>({});

  const live = fleet.filter((n) => n.live);
  const count = Object.values(selected).reduce((n, ids) => n + ids.length, 0);
  const setPhase = (id: string, phase: Phase) =>
    setPhases((p) => ({ ...p, [id]: phase }));
  const when_ = (iso: string) =>
    new Intl.DateTimeFormat(lang, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));

  function toggle(nasId: string, id: string) {
    setConfirm(false);
    setSelected((s) => {
      const now = s[nasId] ?? [];
      return {
        ...s,
        [nasId]: now.includes(id) ? now.filter((i) => i !== id) : [...now, id],
      };
    });
  }

  function selectAll() {
    setConfirm(false);
    setSelected(
      Object.fromEntries(
        live.map((n) => [
          n.id,
          [
            ...(n.dsm && !dsmHeld(n) ? [DSM] : []),
            ...n.packages
              .filter((p) => !n.held?.reasons[p.id])
              .map((p) => p.id),
          ],
        ]),
      ),
    );
  }

  async function refreshState(nasId: string) {
    const status = await packageUpdateStatus(nasId, lang);
    if (status.ok)
      setSchedules((s) => ({ ...s, [nasId]: status.value.schedules }));
    return status;
  }

  async function follow(nasId: string) {
    if (polling.current[nasId]) return;
    polling.current[nasId] = true;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        const status = await refreshState(nasId);
        if (!status.ok) {
          // Pendant le redémarrage du NAS, l'agent peut se taire : on réessaie.
          continue;
        }
        const job = status.value.jobs[0];
        if (job) setPhase(nasId, { kind: "running", job });
        if (!status.value.running) break;
      }
      const next = dsmAfter.current[nasId];
      if (next) {
        dsmAfter.current[nasId] = null;
        const started = await startDsmUpdate(nasId, next.accept, lang);
        if (!started.ok)
          setPhase(nasId, { kind: "error", reason: started.reason });
        else {
          setPhase(nasId, { kind: "running", job: started.value });
          polling.current[nasId] = false;
          void follow(nasId);
          return;
        }
      }
    } finally {
      polling.current[nasId] = false;
      if (!Object.values(polling.current).some(Boolean)) router.refresh();
    }
  }

  async function check(nasId: string, ids: string[]): Promise<Checked | null> {
    const pkgs = ids.filter((i) => i !== DSM);
    const withDsm = ids.includes(DSM);
    let plan: Checked = {
      feasibility: "ok",
      reasons: [],
      ids: [],
      dsm: false,
    };
    if (pkgs.length) {
      const got = await checkPackageUpdates(nasId, pkgs, lang);
      if (!got.ok) {
        setPhase(nasId, { kind: "error", reason: got.reason });
        return null;
      }
      plan = {
        ...plan,
        feasibility: got.value.feasibility,
        reasons: got.value.reasons,
        ids: got.value.packages
          .filter((p) => p.state === "ready")
          .map((p) => p.id),
      };
    }
    if (withDsm) {
      const got = await checkDsmUpdate(nasId, lang);
      if (!got.ok) {
        setPhase(nasId, { kind: "error", reason: got.reason });
        return null;
      }
      plan = {
        ...plan,
        feasibility: worst(plan.feasibility, got.value.feasibility),
        reasons: [...plan.reasons, ...got.value.reasons],
        dsm: got.value.available,
      };
    }
    return plan;
  }

  async function run() {
    setBusy(true);
    setNotice(null);
    const targets = Object.entries(selected).filter(([, ids]) => ids.length);
    // 1. Ce que DSM dit, NAS par NAS.
    const plans: Record<string, Checked> = {};
    await Promise.all(
      targets.map(async ([nasId, ids]) => {
        setPhase(nasId, { kind: "checking" });
        const plan = await check(nasId, ids);
        if (plan) {
          plans[nasId] = plan;
          setPhase(nasId, { kind: "checked", plan });
        }
      }),
    );
    if (
      Object.values(plans).some((p) => p.feasibility === "warning") &&
      !confirm
    ) {
      setConfirm(true);
      setBusy(false);
      return;
    }
    // 2. Le lancement, là où DSM ne bloque pas : les paquets d'abord, DSM ensuite.
    await Promise.all(
      Object.entries(plans).map(async ([nasId, plan]) => {
        if (plan.feasibility === "blocked" || plan.feasibility === "unknown")
          return;
        const accept = plan.feasibility === "warning";
        const started = plan.ids.length
          ? await startPackageUpdates(nasId, plan.ids, accept, lang)
          : plan.dsm
            ? await startDsmUpdate(nasId, accept, lang)
            : null;
        if (!started) return;
        if (!started.ok) {
          setPhase(nasId, { kind: "error", reason: started.reason });
          return;
        }
        dsmAfter.current[nasId] =
          plan.ids.length > 0 && plan.dsm ? { accept } : null;
        setPhase(nasId, { kind: "running", job: started.value });
        void follow(nasId);
      }),
    );
    setSelected({});
    setBusy(false);
  }

  async function schedule() {
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return;
    setBusy(true);
    setNotice(null);
    const errors: string[] = [];
    let done = 0;
    for (const [nasId, ids] of Object.entries(selected)) {
      const pkgs = ids.filter((i) => i !== DSM);
      const parts: ["packages" | "dsm", string[]][] = [
        ...(pkgs.length ? [["packages", pkgs] as ["packages", string[]]] : []),
        ...(ids.includes(DSM) ? [["dsm", []] as ["dsm", string[]]] : []),
      ];
      for (const [target, list] of parts) {
        const got = await scheduleNasUpdate(
          nasId,
          target,
          list,
          at.toISOString(),
          acceptLater,
          lang,
        );
        if (got.ok) done += 1;
        else
          errors.push(
            `${fleet.find((n) => n.id === nasId)?.name}: ${got.reason}`,
          );
      }
      await refreshState(nasId);
    }
    setNotice(
      errors.length
        ? errors.join(" · ")
        : t(
            `${done} scheduled for ${when_(at.toISOString())}.`,
            `${done} programmée${done > 1 ? "s" : ""} pour le ${when_(at.toISOString())}.`,
          ),
    );
    setSelected({});
    setPlanning(false);
    setBusy(false);
  }

  async function cancel(nasId: string, id: string) {
    const got = await cancelScheduledUpdate(nasId, id, lang);
    if (!got.ok) setNotice(got.reason);
    await refreshState(nasId);
  }

  // À l'ouverture : les rendez-vous de chaque NAS, et le suivi d'un travail en cours.
  // biome-ignore lint/correctness/useExhaustiveDependencies: une seule lecture à l'ouverture
  useEffect(() => {
    for (const nas of live) {
      void refreshState(nas.id).then((s) => {
        if (s.ok && s.value.running && s.value.jobs[0]) {
          setPhase(nas.id, { kind: "running", job: s.value.jobs[0] });
          void follow(nas.id);
        }
      });
    }
  }, []);

  const waiting = live.flatMap((nas) =>
    (schedules[nas.id] ?? [])
      .filter((s) => s.state === "waiting" || s.state === "skipped")
      .map((s) => ({ nas, s })),
  );
  const shown = fleet.filter((n) => n.packages.length || n.dsm || phases[n.id]);

  const dsmStep = (d: DsmRun): string =>
    d.state === "done"
      ? t("Updated", "Mis à jour")
      : d.state === "failed"
        ? t("Failed", "En échec")
        : {
            download: t(
              `Downloading${d.percent != null ? ` ${d.percent} %` : "…"}`,
              `Téléchargement${d.percent != null ? ` ${d.percent} %` : "…"}`,
            ),
            check: t("Checks…", "Vérifications…"),
            install: t("Installing…", "Installation…"),
            restart: t("NAS restarting…", "Redémarrage du NAS…"),
            end: t("Updated", "Mis à jour"),
          }[d.step];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          onClick={selectAll}
          disabled={busy || !live.length}
        >
          {t("Select all", "Tout cocher")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={run}
          disabled={busy || !count}
        >
          {busy
            ? t("Checking…", "Vérification…")
            : confirm
              ? t(
                  `Update despite the warnings (${count})`,
                  `Mettre à jour malgré les avertissements (${count})`,
                )
              : t(`Update now (${count})`, `Mettre à jour (${count})`)}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPlanning((p) => !p);
            if (!when) setWhen(localInput(new Date(Date.now() + 60 * 60_000)));
          }}
          disabled={busy || !count}
          aria-expanded={planning}
        >
          {t("Schedule…", "Programmer…")}
        </button>
        <span className="text-fg-3 text-sm">
          {t(
            "DSM first says what an update would stop; nothing starts if it blocks.",
            "DSM dit d'abord ce qu'une mise à jour couperait ; rien ne part s'il bloque.",
          )}
        </span>
      </div>
      {planning ? (
        <Card labelledBy="maj-programmer">
          <CardHeader
            id="maj-programmer"
            title={t("Schedule the selection", "Programmer la sélection")}
            meta={t(
              "every check runs again at that time",
              "toutes les vérifications sont refaites à l'heure dite",
            )}
          />
          <div className="row flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span>{t("When", "Quand")}</span>
              <input
                type="datetime-local"
                className="btn font-normal"
                value={when}
                min={localInput(new Date(Date.now() + 5 * 60_000))}
                onChange={(e) => setWhen(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={acceptLater}
                onChange={(e) => setAcceptLater(e.target.checked)}
              />
              <span>{t("even if DSM warns", "même si DSM avertit")}</span>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              onClick={schedule}
              disabled={busy || !count || !when}
            >
              {t(`Schedule (${count})`, `Programmer (${count})`)}
            </button>
          </div>
        </Card>
      ) : null}
      {notice ? <p className="m-0 text-fg-2">{notice}</p> : null}
      {waiting.length ? (
        <Card labelledBy="maj-programmees">
          <CardHeader
            id="maj-programmees"
            title={t("Scheduled", "Programmées")}
            meta={t(
              "in your browser's time zone",
              "à l'heure de votre navigateur",
            )}
          />
          {waiting.map(({ nas, s }) => (
            <div
              key={`${nas.id}-${s.id}`}
              className="row justify-between gap-3"
            >
              <span className="grow">
                <span className="block font-medium">
                  {nas.name} ·{" "}
                  {s.target === "dsm"
                    ? "DSM"
                    : s.packages
                        .map(
                          (id) =>
                            nas.packages.find((p) => p.id === id)?.name ?? id,
                        )
                        .join(", ")}
                </span>
                <span className="meta">
                  {when_(s.at)}
                  {s.acceptWarnings
                    ? t(" · even if DSM warns", " · même si DSM avertit")
                    : ""}
                  {s.state === "skipped" && s.reason
                    ? ` · ${t("did not start:", "pas partie :")} ${s.reason}`
                    : ""}
                </span>
              </span>
              {s.state === "waiting" ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => cancel(nas.id, s.id)}
                >
                  {t("Cancel", "Annuler")}
                </button>
              ) : (
                <ToneBadge tone="warn">{t("Skipped", "Sautée")}</ToneBadge>
              )}
            </div>
          ))}
        </Card>
      ) : null}
      {!shown.length ? (
        <Card labelledBy="maj-vide">
          <CardHeader
            id="maj-vide"
            title={t("All up to date", "Tout est à jour")}
          />
          <p className="m-0 px-[18px] py-4 text-fg-2">
            {t(
              "No package and no DSM of the fleet waits for an update.",
              "Aucun paquet ni aucun DSM du parc n'attend de mise à jour.",
            )}
          </p>
        </Card>
      ) : null}
      {shown.map((nas) => {
        const phase = phases[nas.id] ?? { kind: "idle" };
        const total = nas.packages.length + (nas.dsm ? 1 : 0);
        return (
          <Card key={nas.id} labelledBy={`maj-${nas.id}`}>
            <CardHeader
              id={`maj-${nas.id}`}
              title={nas.name}
              action={
                nas.live ? (
                  <Link
                    href={`/nas/${nas.id}/access#protections`}
                    className="meta inline-flex items-center gap-1 text-fg-2"
                  >
                    <Lock className="size-3" aria-hidden="true" />
                    {t("Protections", "Protections")}
                  </Link>
                ) : undefined
              }
              meta={
                nas.live
                  ? `${nas.model && nas.model !== "–" ? `${nas.model} · ` : ""}${t(
                      `${total} ${total === 1 ? "update" : "updates"}`,
                      `${total} ${total > 1 ? "mises à jour" : "mise à jour"}`,
                    )}`
                  : t(
                      "fictitious NAS: nothing is sent from here",
                      "NAS fictif : rien ne part d'ici",
                    )
              }
            />
            {nas.held?.note || nas.held?.frozen ? (
              <p className="meta m-0 px-[18px] pt-2">
                {nas.held.frozen
                  ? t(
                      "Frozen: Fulmar updates nothing here.",
                      "Gelé : Fulmar n'y met rien à jour.",
                    )
                  : null}
                {nas.held.frozen && nas.held.note ? " " : null}
                {nas.held.note ? `« ${nas.held.note} »` : null}
              </p>
            ) : null}
            {phase.kind === "checked" && phase.plan.feasibility !== "ok" ? (
              <div className="row flex-col items-start gap-1">
                <ToneBadge
                  tone={phase.plan.feasibility === "warning" ? "warn" : "crit"}
                >
                  {phase.plan.feasibility === "warning"
                    ? t("DSM warns", "DSM avertit")
                    : t("DSM blocks the update", "DSM bloque la mise à jour")}
                </ToneBadge>
                {phase.plan.reasons.map((r) => (
                  <span key={r} className="meta">
                    {r}
                  </span>
                ))}
              </div>
            ) : null}
            {phase.kind === "error" ? (
              <div className="row">
                <ToneBadge tone="crit">{phase.reason}</ToneBadge>
              </div>
            ) : null}
            {phase.kind === "running" ? (
              phase.job.kind === "dsm" && phase.job.dsm ? (
                <div className="row justify-between gap-3">
                  <span className="grow">
                    <span className="block font-medium">DSM</span>
                    <span className="meta">
                      {phase.job.dsm.from} → {phase.job.dsm.to}
                      {phase.job.dsm.error ? ` · ${phase.job.dsm.error}` : ""}
                    </span>
                  </span>
                  <ToneBadge tone={RUN_TONE[phase.job.dsm.state]}>
                    {dsmStep(phase.job.dsm)}
                  </ToneBadge>
                </div>
              ) : (
                phase.job.packages.map((p) => (
                  <div key={p.id} className="row justify-between gap-3">
                    <span className="grow">
                      <span className="block font-medium">{p.name}</span>
                      <span className="meta">
                        {p.from} → {p.to}
                        {p.error ? ` · ${p.error}` : ""}
                      </span>
                    </span>
                    <ToneBadge tone={RUN_TONE[p.state]}>
                      {
                        {
                          pending: t("Waiting", "En attente"),
                          running: t("Updating…", "Mise à jour…"),
                          done: t("Updated", "Mis à jour"),
                          failed: t("Failed", "En échec"),
                        }[p.state]
                      }
                    </ToneBadge>
                  </div>
                ))
              )
            ) : (
              <>
                {nas.dsm ? (
                  <label className="row cursor-pointer justify-between gap-3">
                    <span className="flex grow items-center gap-3">
                      <input
                        type="checkbox"
                        checked={(selected[nas.id] ?? []).includes(DSM)}
                        disabled={!nas.live || busy || dsmHeld(nas)}
                        onChange={() => toggle(nas.id, DSM)}
                        aria-label={t("Update DSM", "Mettre à jour DSM")}
                      />
                      <span>
                        <span className="block font-medium">DSM</span>
                        <span className="meta">
                          {nas.dsm.current} → {nas.dsm.available}
                        </span>
                      </span>
                    </span>
                    {dsmHeld(nas) ? (
                      <ToneBadge tone="off" dot={false}>
                        <Lock className="size-3" aria-hidden="true" />
                        {t("Locked", "Verrouillé")}
                      </ToneBadge>
                    ) : (
                      <ToneBadge tone="warn">
                        {t("Restarts the NAS", "Redémarre le NAS")}
                      </ToneBadge>
                    )}
                  </label>
                ) : null}
                {nas.packages.map((p) => {
                  const checked = (selected[nas.id] ?? []).includes(p.id);
                  const held = nas.held?.reasons[p.id];
                  return (
                    <label
                      key={p.id}
                      className="row cursor-pointer justify-between gap-3"
                    >
                      <span className="flex grow items-center gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!nas.live || busy || Boolean(held)}
                          onChange={() => toggle(nas.id, p.id)}
                          aria-label={t(
                            `Update ${p.name}`,
                            `Mettre à jour ${p.name}`,
                          )}
                        />
                        <span>
                          <span className="block font-medium">{p.name}</span>
                          <span className="meta">
                            {p.version} → {p.update}
                          </span>
                        </span>
                      </span>
                      {held ? (
                        <ToneBadge tone="off" dot={false}>
                          <Lock className="size-3" aria-hidden="true" />
                          {heldWords(held, lang, names(nas))}
                        </ToneBadge>
                      ) : p.security ? (
                        <ToneBadge tone="warn">
                          {t("Security", "Sécurité")}
                        </ToneBadge>
                      ) : null}
                    </label>
                  );
                })}
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}

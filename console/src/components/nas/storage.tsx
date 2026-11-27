import { HardDrive } from "lucide-react";
import { type Locale, type Texts, tr } from "@/i18n";
import { type DiskPair, diskVerdict, wearText } from "@/lib/fleet/disks";
import type { FillForecast } from "@/lib/fleet/forecast";
import {
  formatMonthDay,
  formatPowerOn,
  volumeName,
  volumeTone,
} from "@/lib/fleet/present";
import type { Point } from "@/lib/fleet/series";
import type { Nas, Volume } from "@/lib/fleet/types";
import { formatPct, formatTemp } from "@/lib/format";
import { ToneBadge } from "../ui/badge";
import { FillBar } from "../ui/bar";
import { Card, CardHeader } from "../ui/card";
import { Sparkline } from "../ui/sparkline";

const STATUS_TEXT: Record<string, Texts> = {
  normal: { en: "normal", fr: "normal" },
  degraded: { en: "degraded", fr: "dégradé" },
  crashed: { en: "crashed", fr: "en panne" },
  warning: { en: "warning", fr: "à surveiller" },
};

function statusText(status: string, lang: Locale): string {
  return STATUS_TEXT[status]?.[lang] ?? status;
}

function forecastText(
  f: FillForecast | undefined,
  now: Date,
  tz: string,
  lang: Locale,
): string | null {
  if (!f || f.kind === "unknown") return null;
  if (f.kind === "date") {
    const when = formatMonthDay(f.at, now, tz, lang);
    return tr(lang, { en: `full around ${when}`, fr: `plein vers le ${when}` });
  }
  return tr(lang, {
    en: "stable over 30 days, no fill date in sight",
    fr: "stable sur 30 jours, aucune date de remplissage en vue",
  });
}

export function VolumeLine({
  lang,
  nas,
  volume,
  forecast,
  history,
  now,
  tz,
}: {
  lang: Locale;
  nas: Nas;
  volume: Volume;
  forecast?: FillForecast;
  /** Remplissage sur 30 jours, en % (onglet Stockage). */
  history?: Point[];
  now: Date;
  tz: string;
}) {
  const tone = volumeTone(nas, volume);
  const meta = [
    volume.fs,
    volume.raid,
    volume.status !== "normal"
      ? tr(lang, {
          en: `state ${statusText(volume.status, lang)}`,
          fr: `état ${statusText(volume.status, lang)}`,
        })
      : null,
    forecastText(forecast, now, tz, lang),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{volumeName(volume.path)}</span>
        <span
          className={`text-[13px] ${tone === "ok" ? "text-fg-2" : `t-${tone}`}`}
        >
          {tr(lang, {
            en: `${volume.used} of ${volume.total}`,
            fr: `${volume.used} sur ${volume.total}`,
          })}{" "}
          · {formatPct(volume.pct, lang, 1)}
        </span>
      </div>
      <FillBar pct={volume.pct} tone={tone} width="full" />
      {meta ? <div className="meta">{meta}</div> : null}
      {history?.length ? (
        <Sparkline
          lang={lang}
          points={history}
          max={100}
          color="c1"
          label={tr(lang, {
            en: `Usage of ${volumeName(volume.path)} over 30 days`,
            fr: `Remplissage de ${volumeName(volume.path)} sur 30 jours`,
          })}
          format={(v) => formatPct(v, lang, 1)}
          width={240}
          height={40}
          fluid
          span={{ from: now.getTime() - 30 * 86_400_000, to: now.getTime() }}
        />
      ) : null}
    </div>
  );
}

export function DiskLine({ pair, lang }: { pair: DiskPair; lang: Locale }) {
  const { agent, beszel } = pair;
  const verdict = diskVerdict(pair, lang);
  const disk = tr(lang, { en: "Disk", fr: "Disque" });
  const title = [
    agent ? `${disk} ${agent.bay}` : disk,
    agent?.model ?? beszel?.model,
    agent?.size,
  ]
    .filter(Boolean)
    .join(" · ");
  const temp = beszel?.temp ?? agent?.temp ?? null;
  const wear = agent?.wear ? wearText(agent.wear, lang) : null;
  const meta = [
    temp != null ? formatTemp(temp, lang) : null,
    formatPowerOn(agent?.hours ?? beszel?.hours ?? null, lang) || null,
    wear,
    agent?.wear && !wear
      ? agent.wear.lastTest === "completed"
        ? tr(lang, {
            en: "S.M.A.R.T. test passed",
            fr: "test S.M.A.R.T. réussi",
          })
        : tr(lang, { en: "no sign of wear", fr: "aucun signe d'usure" })
      : beszel?.state
        ? beszel.state === "PASSED"
          ? tr(lang, {
              en: "S.M.A.R.T. test passed",
              fr: "test S.M.A.R.T. réussi",
            })
          : tr(lang, {
              en: `S.M.A.R.T. test: ${beszel.state}`,
              fr: `test S.M.A.R.T. : ${beszel.state}`,
            })
        : agent
          ? `S.M.A.R.T. ${agent.smart}`
          : null,
    agent ? null : tr(lang, { en: "seen by Beszel", fr: "vu par Beszel" }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-3">
      <HardDrive className="icon text-fg-3" aria-hidden="true" />
      <div className="flex min-w-0 grow flex-col">
        <span className="font-medium">{title}</span>
        {meta ? <span className="meta">{meta}</span> : null}
      </div>
      <ToneBadge tone={verdict.tone}>{verdict.label}</ToneBadge>
    </div>
  );
}

/** Onglet Stockage : volumes, grappes, disques, dossiers partagés. */
export function StorageSection({
  lang,
  nas,
  pairs,
  forecasts,
  histories,
  now,
  tz,
}: {
  lang: Locale;
  nas: Nas;
  pairs: DiskPair[];
  forecasts: Map<string, FillForecast>;
  histories: Map<string, Point[]>;
  now: Date;
  tz: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <>
      {nas.volumes.length ? (
        <Card labelledBy="volumes">
          <CardHeader
            id="volumes"
            title="Volumes"
            meta={t(
              "usage, fill date over 30 days",
              "remplissage, date de remplissage sur 30 jours",
            )}
          />
          <div className="flex flex-col gap-5 px-[18px] py-4">
            {nas.volumes.map((v) => (
              <VolumeLine
                key={v.path}
                lang={lang}
                nas={nas}
                volume={v}
                forecast={forecasts.get(v.path)}
                history={histories.get(v.path)}
                now={now}
                tz={tz}
              />
            ))}
          </div>
        </Card>
      ) : null}
      {nas.pools.length ? (
        <Card labelledBy="grappes">
          <CardHeader
            id="grappes"
            title={t("Storage pools", "Groupes de stockage")}
          />
          {nas.pools.map((p) => (
            <div key={p.name} className="row justify-between">
              <span className="font-medium">{p.name}</span>
              <span className="text-fg-2">
                {p.raid} · {statusText(p.status, lang)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
      <Card labelledBy="disques">
        <CardHeader
          id="disques"
          title={t("Disks", "Disques")}
          meta={
            pairs.some((p) => p.beszel)
              ? t(
                  "power-on hours and S.M.A.R.T. test by Beszel",
                  "heures de marche et test S.M.A.R.T. par Beszel",
                )
              : undefined
          }
        />
        {pairs.length ? (
          <div className="flex flex-col gap-3.5 px-[18px] py-4">
            {pairs.map((p, i) => (
              <DiskLine
                key={p.agent?.device ?? p.beszel?.device ?? i}
                pair={p}
                lang={lang}
              />
            ))}
          </div>
        ) : (
          <p className="m-0 px-[18px] py-4 text-fg-2">
            {t("No disk read.", "Aucun disque lu.")}
          </p>
        )}
      </Card>
      {nas.shares.length ? (
        <Card labelledBy="partages">
          <CardHeader
            id="partages"
            title={t("Shared folders", "Dossiers partagés")}
          />
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("Folder", "Dossier")}</th>
                  <th scope="col">{t("Recycle bin", "Corbeille")}</th>
                  <th scope="col">{t("Snapshots", "Instantanés")}</th>
                </tr>
              </thead>
              <tbody>
                {nas.shares.map((s) => (
                  <tr key={s.name}>
                    <td className="font-medium">{s.name}</td>
                    <td>
                      {s.recycleBin ? t("On", "Active") : t("Off", "Coupée")}
                    </td>
                    <td>{s.snapshots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

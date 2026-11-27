import { cookies } from "next/headers";
import Link from "next/link";
import { TaskStrip } from "@/components/backup/task-strip";
import { TimeChart } from "@/components/chart/time-chart";
import { ActivityJournal } from "@/components/nas/activity";
import { Brief } from "@/components/nas/brief";
import { MetricCard } from "@/components/nas/metric-card";
import { DiskLine, VolumeLine } from "@/components/nas/storage";
import { Synthesis } from "@/components/nas/synthesis";
import { VitalsDetail } from "@/components/nas/vitals-detail";
import { nasHref } from "@/components/shell/nav";
import { OverviewSkeleton } from "@/components/skeleton";
import { Card, CardHeader } from "@/components/ui/card";
import { PeriodPicker } from "@/components/ui/period";
import { WithNas } from "@/components/with-nas";
import { type Locale, tr } from "@/i18n";
import { bytes, consoleTimeZone } from "@/lib/agents/time";
import {
  type NasCurves,
  nasBeszel,
  readCurves,
  vitalsDetail,
  volumeForecast,
} from "@/lib/fleet/curves";
import { matchDisks } from "@/lib/fleet/disks";
import { noCurvesReason, seriesSummary } from "@/lib/fleet/present";
import { PERIODS, type Period, type Point } from "@/lib/fleet/series";
import type { Nas } from "@/lib/fleet/types";
import { formatPct, formatRate, formatTemp, plural } from "@/lib/format";
import { VIEW_COOKIE, viewOf } from "@/lib/view";

function periodOf(value: string | string[] | undefined): Period {
  return typeof value === "string" && value in PERIODS
    ? (value as Period)
    : "24h";
}

export default function NasOverview({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string; nasId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <WithNas params={params} fallback={<OverviewSkeleton />}>
      {(nas, lang) => <Overview nas={nas} lang={lang} search={searchParams} />}
    </WithNas>
  );
}

async function Overview({
  nas,
  lang,
  search,
}: {
  nas: Nas;
  lang: Locale;
  search: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const now = new Date();
  const tz = consoleTimeZone();
  // En bref par défaut ; en détail si on l'a choisi (cookie). En bref ne lit pas les courbes.
  const view = viewOf((await cookies()).get(VIEW_COOKIE)?.value);
  if (view === "brief")
    return <Brief nas={nas} view={view} now={now} tz={tz} lang={lang} />;
  const period = periodOf((await search).period);
  const [day, chosen, bz, detail] = await Promise.all([
    readCurves([nas], "24h", now),
    period === "24h" ? null : readCurves([nas], period, now),
    nasBeszel(nas),
    vitalsDetail(nas),
  ]);
  const c24 = day.curves.get(nas.id) ?? null;
  const shown = period === "24h" || !chosen ? day : chosen;
  const cp = shown.curves.get(nas.id) ?? null;
  const fullest = [...nas.volumes].sort((a, b) => b.pct - a.pct)[0];
  const forecast = fullest
    ? await volumeForecast(nas, fullest, now)
    : undefined;
  const reason = noCurvesReason(nas, now, tz, lang, shown.failure);

  return (
    <>
      <Synthesis nas={nas} view={view} now={now} tz={tz} lang={lang} />
      <MetricCards nas={nas} curves={c24} now={now} tz={tz} lang={lang} />
      <Card labelledBy="charge">
        <div className="card-h">
          <div className="flex flex-wrap items-center gap-[18px]">
            <h2 className="h2" id="charge">
              {t("Processor and memory", "Processeur et mémoire")}
            </h2>
            <Legend color="c1" label={t("Processor", "Processeur")} />
            <Legend color="c2" label={t("Memory", "Mémoire")} />
          </div>
          <PeriodPicker value={period} hrefs={periodHrefs(nas.id)} />
        </div>
        {cp ? (
          <TimeChart
            series={[
              {
                label: t("Processor", "Processeur"),
                color: "c1",
                points: cp.cpu,
              },
              { label: t("Memory", "Mémoire"), color: "c2", points: cp.mem },
            ]}
            period={period}
            tz={tz}
            now={now.toISOString()}
            label={chartLabel(cp, period, lang)}
          />
        ) : (
          <p className="m-0 px-[18px] py-6 text-fg-2">
            {t(
              `Charts unavailable: ${reason}.`,
              `Courbes indisponibles : ${reason}.`,
            )}
          </p>
        )}
      </Card>
      <VitalsDetail lang={lang} detail={detail} now={now} tz={tz} />

      <div className="grid items-start gap-4 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
        <div className="flex flex-col gap-4">
          <Card labelledBy="stockage">
            <CardHeader
              id="stockage"
              title={t("Storage", "Stockage")}
              action={
                <Link
                  href={nasHref(nas.id, "storage")}
                  className="font-medium text-[13px]"
                >
                  {t("Details", "Détails")}
                </Link>
              }
            />
            <div className="flex flex-col gap-4 px-[18px] py-4">
              {fullest ? (
                <VolumeLine
                  lang={lang}
                  nas={nas}
                  volume={fullest}
                  forecast={forecast}
                  now={now}
                  tz={tz}
                />
              ) : null}
              {matchDisks(nas.disks, bz.disks ?? []).map((p, i) => (
                <div
                  key={p.agent?.device ?? p.beszel?.device ?? i}
                  className={
                    fullest || i ? "border-border border-t pt-3.5" : ""
                  }
                >
                  <DiskLine pair={p} lang={lang} />
                </div>
              ))}
              {!fullest && !nas.disks.length && !bz.disks?.length ? (
                <p className="m-0 text-fg-2">
                  {t("Storage not read.", "Stockage non lu.")}
                </p>
              ) : null}
            </div>
          </Card>
          {nas.agent.kind === "ok" && nas.tasks.length ? (
            <Card labelledBy="sauvegardes">
              <CardHeader
                id="sauvegardes"
                title={t("Backups", "Sauvegardes")}
                meta={t("Last 30 days", "30 derniers jours")}
              />
              {nas.tasks.map((task) => (
                <TaskStrip
                  key={task.name}
                  nas={nas}
                  task={task}
                  now={now}
                  tz={tz}
                  lang={lang}
                />
              ))}
            </Card>
          ) : null}
        </div>
      </div>

      {nas.agent.kind === "ok" && nas.activity.length ? (
        <Card labelledBy="activite">
          <CardHeader
            id="activite"
            title={t("Recent activity", "Activité récente")}
            meta={
              nas.connected.length
                ? lang === "en"
                  ? plural(
                      nas.connected.length,
                      "person signed in",
                      "people signed in",
                      lang,
                    )
                  : plural(
                      nas.connected.length,
                      "personne connectée",
                      "personnes connectées",
                      lang,
                    )
                : t("nobody signed in", "personne de connecté")
            }
            action={
              <Link
                href={nasHref(nas.id, "activity")}
                className="font-medium text-[13px]"
              >
                {t("See all", "Tout voir")}
              </Link>
            }
          />
          <div className="p-3">
            <ActivityJournal
              events={nas.activity}
              fileLogs={nas.fileLogs}
              limit={6}
            />
          </div>
        </Card>
      ) : null}
    </>
  );
}

function Legend({ color, label }: { color: "c1" | "c2"; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
      <span
        className="h-0.5 w-2.5 rounded"
        style={{ background: `var(--${color})` }}
      />
      {label}
    </span>
  );
}

function chartLabel(c: NasCurves, period: Period, lang: Locale): string {
  const range = (pts: Point[]) => {
    const v = pts.map((p) => p.v).filter((x): x is number => x != null);
    if (!v.length) return tr(lang, { en: "no value", fr: "sans valeur" });
    const lo = formatPct(Math.min(...v), lang);
    const hi = formatPct(Math.max(...v), lang);
    return tr(lang, {
      en: `between ${lo} and ${hi}`,
      fr: `entre ${lo} et ${hi}`,
    });
  };
  const span = {
    "1h": { en: "the last hour", fr: "la dernière heure" },
    "24h": { en: "24 hours", fr: "24 heures" },
    "7d": { en: "7 days", fr: "7 jours" },
    "30d": { en: "30 days", fr: "30 jours" },
  }[period][lang];
  return tr(lang, {
    en: `Processor and memory over ${span}: processor ${range(c.cpu)}, memory ${range(c.mem)}`,
    fr: `Processeur et mémoire sur ${span} : processeur ${range(c.cpu)}, mémoire ${range(c.mem)}`,
  });
}

/** Les quatre cartes de constantes : valeur du moment, explication, courbe de 24 h. */
function MetricCards({
  nas,
  curves,
  now,
  tz,
  lang,
}: {
  nas: Nas;
  curves: NasCurves | null;
  now: Date;
  tz: string;
  lang: Locale;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const v = nas.vitals;
  const sum = (m: keyof NasCurves) =>
    curves ? seriesSummary(curves[m], now, tz, lang) : null;
  const cpu = sum("cpu");
  const mem = sum("mem");
  const temp = sum("temp");
  const net = sum("net");
  const total = nas.ramMb ? nas.ramMb * 1024 * 1024 : null;
  const diskTemps = nas.disks.map((d) => d.temp).filter((x) => x > 0);
  const pct = (x: number | null | undefined) => formatPct(x, lang);
  const rate = (x: number | null | undefined) => formatRate(x, lang);
  const deg = (x: number | null | undefined) => formatTemp(x, lang);
  const peak = (avg: string, max: string, at: string) =>
    t(
      `Average ${avg} · peak ${max} at ${at}`,
      `Moyenne ${avg} · pic ${max} à ${at}`,
    );
  const source =
    v.source !== "agent"
      ? t("No reading", "Pas de mesure")
      : nas.agentHistory
        ? t(
            "Read by the agent, no chart yet",
            "Relevée par l'agent, pas encore de courbe",
          )
        : t(
            "Value read by the agent, no chart",
            "Valeur lue par l'agent, sans courbe",
          );
  return (
    <section
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] md:gap-4"
      aria-label={t("Vitals", "Constantes")}
    >
      <MetricCard
        lang={lang}
        label={t("Processor", "Processeur")}
        value={pct(v.cpu)}
        sub={cpu ? peak(pct(cpu.avg), pct(cpu.max), cpu.maxAt) : source}
        points={curves?.cpu ?? null}
        color="c1"
        max={100}
        format={(x) => formatPct(x, lang)}
        now={now}
      />
      <MetricCard
        lang={lang}
        label={t("Memory", "Mémoire")}
        value={pct(v.ram)}
        sub={
          total && v.ram != null
            ? t(
                `${bytes((v.ram / 100) * total, lang)} used of ${bytes(total, lang)}`,
                `${bytes((v.ram / 100) * total, lang)} utilisés sur ${bytes(total, lang)}`,
              )
            : mem
              ? peak(pct(mem.avg), pct(mem.max), mem.maxAt)
              : source
        }
        points={curves?.mem ?? null}
        color="c2"
        max={100}
        format={(x) => formatPct(x, lang)}
        now={now}
      />
      <MetricCard
        lang={lang}
        label={t("Temperature", "Température")}
        value={deg(v.temp)}
        sub={[
          v.source === "beszel"
            ? t("Processor", "Processeur")
            : t("System", "Système"),
          temp ? `max ${deg(temp.max)}` : null,
          diskTemps.length
            ? t(
                `disk ${deg(Math.max(...diskTemps))}`,
                `disque ${deg(Math.max(...diskTemps))}`,
              )
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        points={curves?.temp ?? null}
        color="c1"
        max={80}
        format={(x) => formatTemp(x, lang)}
        now={now}
      />
      <MetricCard
        lang={lang}
        label={t("Network", "Réseau")}
        value={rate(v.netBps)}
        sub={
          net
            ? peak(rate(net.avg), rate(net.max), net.maxAt)
            : t("No reading", "Pas de mesure")
        }
        points={curves?.net ?? null}
        color="c1"
        max={1}
        format={(x) => formatRate(x, lang)}
        now={now}
      />
    </section>
  );
}

/** L'adresse de chaque période ; 24 h, la vue par défaut, sans paramètre. */
function periodHrefs(nasId: string): Record<Period, string> {
  const at = (p: Period) =>
    `${nasHref(nasId)}${p === "24h" ? "" : `?period=${p}`}`;
  return { "1h": at("1h"), "24h": at("24h"), "7d": at("7d"), "30d": at("30d") };
}

import { type Locale, tr } from "@/i18n";
import type { DetailSeries } from "@/lib/agents/history-map";
import { seriesSummary } from "@/lib/fleet/present";
import { formatPct, formatRate, number } from "@/lib/format";
import { MetricCard } from "./metric-card";

// Les constantes en détail, à la manière de Beszel (2026-11-26) : charge, swap, réseau par
// interface et débit de chaque disque, chacune sa carte et sa courbe de 24 h. Rien sans
// historique de l'agent.

export function VitalsDetail({
  lang,
  detail,
  now,
  tz,
}: {
  lang: Locale;
  detail: DetailSeries[];
  now: Date;
  tz: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  if (!detail.length) return null;
  const load = (x: number | null | undefined) =>
    x == null ? "–" : number(x, 2, lang);
  return (
    <section
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] md:gap-4"
      aria-label={t("Vitals in detail", "Constantes en détail")}
    >
      {detail.map((d) => {
        const s = seriesSummary(d.points, now, tz, lang);
        const peak = (fmt: (x: number) => string) =>
          s
            ? t(
                `Average ${fmt(s.avg)} · peak ${fmt(s.max)}`,
                `Moyenne ${fmt(s.avg)} · pic ${fmt(s.max)}`,
              )
            : t("No reading", "Pas de mesure");
        if (d.kind === "load")
          return (
            <MetricCard
              key="load"
              lang={lang}
              label={t("Load (1 min)", "Charge (1 min)")}
              value={load(d.value)}
              sub={t(
                `5 min ${load(d.extra?.load5)} · 15 min ${load(d.extra?.load15)}`,
                `5 min ${load(d.extra?.load5)} · 15 min ${load(d.extra?.load15)}`,
              )}
              points={d.points}
              color="c1"
              max={Math.max(1, ...d.points.map((p) => p.v ?? 0))}
              format={(x) => load(x)}
              now={now}
            />
          );
        if (d.kind === "swap")
          return (
            <MetricCard
              key="swap"
              lang={lang}
              label="Swap"
              value={formatPct(d.value, lang)}
              sub={peak((x) => formatPct(x, lang))}
              points={d.points}
              color="c2"
              max={100}
              format={(x) => formatPct(x, lang)}
              now={now}
            />
          );
        const label =
          d.kind === "interface"
            ? t(`Network ${d.subject}`, `Réseau ${d.subject}`)
            : t(`Disk ${d.subject}`, `Disque ${d.subject}`);
        return (
          <MetricCard
            key={`${d.kind}:${d.subject}`}
            lang={lang}
            label={label}
            value={formatRate(d.value, lang)}
            sub={
              d.kind === "interface"
                ? t("Received and sent", "Reçu et envoyé")
                : t("Read and written", "Lu et écrit")
            }
            points={d.points}
            color={d.kind === "interface" ? "c1" : "c2"}
            max={Math.max(1, ...d.points.map((p) => p.v ?? 0))}
            format={(x) => formatRate(x, lang)}
            now={now}
          />
        );
      })}
    </section>
  );
}

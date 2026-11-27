import {
  Archive,
  ChevronRight,
  Cpu,
  HardDrive,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { type Locale, tr } from "@/i18n";
import { nasLocalDay, tzOffsetMinutes } from "@/lib/agents/time";
import {
  briefTiles,
  isStale,
  nasVerdict,
  type Tile,
  type TileId,
} from "@/lib/fleet/brief";
import { volumeForecast } from "@/lib/fleet/curves";
import { fleetIssues, type Issue } from "@/lib/fleet/issues";
import {
  formatSince,
  ISSUE_LEVEL_TONE,
  withFillDates,
} from "@/lib/fleet/present";
import { backupStrip, mergeStrips, type StripCell } from "@/lib/fleet/strip";
import type { Nas } from "@/lib/fleet/types";
import { cn } from "@/lib/format";
import type { View } from "@/lib/view";
import { issueHref, nasHref } from "../shell/nav";
import { FillBar } from "../ui/bar";
import { BackupStrip } from "../ui/strip";
import { TONE_DISC, TONE_TEXT, VerdictHead } from "./verdict";

// La fiche en bref (conception 2026-11-25-fiche-en-bref) : le verdict et ce qu'il y a à faire
// dans une carte, puis une tuile par grand sujet. Le détail reste à un appui : la lecture
// « En détail » ou l'onglet de chaque tuile.

const ICON: Record<TileId, LucideIcon> = {
  backup: Archive,
  storage: HardDrive,
  updates: RefreshCw,
  security: ShieldCheck,
  ups: Zap,
  machine: Cpu,
};

/** Points montrés avant « Voir les N points ». */
const TODO_SHOWN = 3;

export async function Brief({
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
  const verdict = nasVerdict(nas, now, tz, lang);
  const fullest = [...nas.volumes].sort((a, b) => b.pct - a.pct)[0];
  const forecast =
    fullest && nas.agent.kind === "ok"
      ? await volumeForecast(nas, fullest, now)
      : undefined;
  const dates = new Map(
    forecast?.kind === "date" ? [[nas.id, forecast.at] as const] : [],
  );
  const issues = withFillDates(fleetIssues([nas], lang), dates, now, tz, lang);
  const tiles = briefTiles(nas, { now, tz, lang, forecast });
  const stale = isStale(nas);

  return (
    <>
      <section className="card overflow-clip" aria-labelledby="synthese">
        <VerdictHead nas={nas} verdict={verdict} view={view} />
        {issues.length ? (
          <div className="border-border border-t">
            <h3 className="m-0 px-[18px] pt-3 font-semibold text-[13px] text-fg-2">
              {t("To do", "À faire")}
            </h3>
            <ul className="m-0 list-none p-0 pb-1.5">
              {issues.slice(0, TODO_SHOWN).map((issue) => (
                <TodoRow
                  key={`${issue.level}-${issue.checkId ?? "reach"}`}
                  issue={issue}
                  now={now}
                  tz={tz}
                  lang={lang}
                />
              ))}
            </ul>
            {issues.length > TODO_SHOWN ? (
              <Link
                href={nasHref(nas.id, "checks")}
                className="flex items-center gap-1 border-border border-t px-[18px] py-3 font-medium text-[13px]"
              >
                {t(
                  `See all ${issues.length} issues`,
                  `Voir les ${issues.length} points`,
                )}
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        aria-label={t("At a glance", "En bref")}
        className={cn(
          "grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4",
          stale && "opacity-55",
        )}
      >
        {tiles.map((tile) => (
          <TileCard
            key={tile.id}
            nas={nas}
            tile={tile}
            strip={tile.id === "backup" ? backupCells(nas, now, tz) : null}
          />
        ))}
      </section>
    </>
  );
}

/** Les 30 derniers jours de toutes les tâches, le pire résultat de chaque jour. */
function backupCells(nas: Nas, now: Date, tz: string): StripCell[] | null {
  if (!nas.tasks.length || !nas.backupLogRead) return null;
  const offset = nas.tzOffsetMin ?? tzOffsetMinutes(tz, now);
  const today = nasLocalDay(now.toISOString(), offset);
  return mergeStrips(
    nas.tasks.map((task) =>
      backupStrip(nas.backupLog, task.name, offset, today, nas.backupLogFrom),
    ),
  );
}

const DOT = { crit: "d-crit", warn: "d-warn" } as const;

function TodoRow({
  issue,
  now,
  tz,
  lang,
}: {
  issue: Issue;
  now: Date;
  tz: string;
  lang: Locale;
}) {
  const since = formatSince(issue.since, now, tz, lang);
  const body = (
    <>
      <span
        className={cn(
          "dot mt-[7px] flex-none",
          DOT[ISSUE_LEVEL_TONE[issue.level]],
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-semibold">{issue.title}</span>
          {since ? (
            <span className="meta flex-none whitespace-nowrap">{since}</span>
          ) : null}
        </span>
        {issue.todo ? (
          <span className="mt-0.5 line-clamp-2 text-[13px] text-fg-2">
            {issue.todo}
          </span>
        ) : null}
      </span>
    </>
  );
  const row = "flex gap-3 px-[18px] py-2.5";
  return (
    <li>
      {issue.checkId ? (
        <Link
          href={issueHref(issue.nas.id, issue.checkId)}
          className={cn(
            row,
            "text-fg hover:bg-[var(--hover)] hover:no-underline",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

function TileCard({
  nas,
  tile,
  strip,
}: {
  nas: Nas;
  tile: Tile;
  strip: StripCell[] | null;
}) {
  const Icon = ICON[tile.id];
  return (
    <Link
      href={nasHref(nas.id, tile.section)}
      className="card tile flex min-w-0 flex-col gap-1.5 p-3.5 text-fg hover:no-underline md:p-4"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "inline-flex size-7 flex-none items-center justify-center rounded-full",
            TONE_DISC[tile.tone],
          )}
          aria-hidden="true"
        >
          <Icon className="size-[15px]" strokeWidth={2} />
        </span>
        <span className="truncate font-medium text-[13px] text-fg-2">
          {tile.label}
        </span>
        <ChevronRight
          className="ml-auto size-4 flex-none text-fg-3"
          aria-hidden="true"
        />
      </span>
      <span
        className={cn(
          "mt-1 truncate font-semibold text-[22px] tabular-nums leading-[1.15] tracking-[-0.012em]",
          TONE_TEXT[tile.tone],
        )}
      >
        {tile.value}
      </span>
      {tile.meter != null ? (
        <FillBar
          pct={tile.meter}
          tone={tile.tone === "neutral" ? "ok" : tile.tone}
          width="full"
        />
      ) : null}
      {strip ? <BackupStrip cells={strip} label={tile.label} mini /> : null}
      <span className="meta line-clamp-2 break-words" title={tile.line}>
        {tile.line}
      </span>
    </Link>
  );
}

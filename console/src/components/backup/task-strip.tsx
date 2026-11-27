import Link from "next/link";
import { type Locale, type Texts, tr } from "@/i18n";
import {
  formatDateTime,
  formatDay,
  nasLocalDay,
  tzOffsetMinutes,
} from "@/lib/agents/time";
import { backupLogNote } from "@/lib/fleet/present";
import { backupStrip } from "@/lib/fleet/strip";
import type { BackupTask, Nas, Status } from "@/lib/fleet/types";
import { nasHref } from "../shell/nav";
import { StateBadge } from "../ui/badge";
import { BackupStrip } from "../ui/strip";

const RESULT_LABEL: Record<Status, Texts> = {
  ok: { en: "Succeeded", fr: "Réussie" },
  warning: { en: "Warning", fr: "À surveiller" },
  failed: { en: "Failed", fr: "En échec" },
  unknown: { en: "Unknown", fr: "Inconnu" },
};

/** Une tâche Hyper Backup : son nom, sa programmation, sa bande des 30 jours (jours du NAS),
 * son dernier résultat et, en échec, l'erreur telle que DSM la donne. */
export function TaskStrip({
  nas,
  task,
  now,
  tz,
  lang,
  showNas = false,
}: {
  nas: Nas;
  task: BackupTask;
  now: Date;
  tz: string;
  lang: Locale;
  showNas?: boolean;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const offset = nas.tzOffsetMin ?? tzOffsetMinutes(tz, now);
  const today = nasLocalDay(now.toISOString(), offset);
  const cells = backupStrip(
    nas.backupLog,
    task.name,
    offset,
    today,
    nas.backupLogFrom,
  );
  const before = cells.some((c) => c.kind === "before");
  const logNote = backupLogNote(nas, lang);
  const last = task.lastSuccessAt
    ? formatDateTime(task.lastSuccessAt, now, tz, lang)
    : null;
  const next =
    task.nextRun !== "aucune" && task.nextRun !== "none" ? task.nextRun : null;
  const sub = [
    task.schedule,
    last
      ? t(`last success ${last}`, `dernière réussite ${last}`)
      : t("never succeeded", "jamais réussie"),
    next ? t(`next ${next}`, `prochaine ${next}`) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-2.5 border-border border-t px-[18px] py-3.5 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold">
            {task.name}
            {showNas ? (
              <>
                <span className="font-normal text-fg-3"> · </span>
                <Link href={nasHref(nas.id, "backups")} className="font-medium">
                  {nas.name}
                </Link>
              </>
            ) : null}
          </span>
          <span className="meta">{sub}</span>
        </div>
        <StateBadge
          state={task.result.status}
          label={RESULT_LABEL[task.result.status][lang]}
        />
      </div>
      <BackupStrip
        cells={cells}
        label={t(`Backup “${task.name}”`, `Sauvegarde « ${task.name} »`)}
      />
      <div className="meta flex justify-between">
        <span>{formatDay(cells[0].day, lang)}</span>
        <span>{t("Today", "Aujourd'hui")}</span>
      </div>
      {before && nas.backupLogFrom ? (
        <p className="meta m-0">
          {t("Log available since", "Journal disponible depuis le")}{" "}
          {formatDay(nasLocalDay(nas.backupLogFrom, offset), lang)}
        </p>
      ) : null}
      {logNote ? <p className="meta m-0">{logNote}</p> : null}
      {task.result.status === "failed" || task.result.status === "warning" ? (
        <div
          className={`rounded-[8px] px-2.5 py-2 text-[13px] ${task.result.status === "failed" ? "bg-crit-bg text-crit-text" : "bg-warn-bg text-warn-text"}`}
        >
          {task.result.text}
        </div>
      ) : null}
    </div>
  );
}

import { type Locale, type Texts, tr } from "@/i18n";
import { formatDateTime } from "@/lib/agents/time";
import type { Nas } from "@/lib/fleet/types";
import { TaskStrip } from "../backup/task-strip";
import { Card, CardHeader } from "../ui/card";
import { ActiveBackupCard } from "./active-backup";
import { CloudBackupsCard } from "./cloud-backups";

const OUTCOME: Record<"success" | "failure" | "partial", Texts> = {
  success: { en: "succeeded", fr: "réussie" },
  failure: { en: "failed", fr: "en échec" },
  partial: { en: "partial", fr: "partielle" },
};

/** Onglet Sauvegardes : chaque tâche Hyper Backup et sa bande, Active Backup for Business
 * appareil par appareil, Microsoft 365 et Google Workspace, puis un extrait du journal. */
export function BackupsSection({
  nas,
  now,
  tz,
  lang,
}: {
  nas: Nas;
  now: Date;
  tz: string;
  lang: Locale;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const recent = nas.backupLog.filter((e) => e.outcome).slice(0, 12);
  return (
    <>
      <Card labelledBy="taches">
        <CardHeader
          id="taches"
          title={t("Hyper Backup tasks", "Tâches Hyper Backup")}
          meta={t("Last 30 days, NAS days", "30 derniers jours, jours du NAS")}
        />
        {nas.tasks.length ? (
          nas.tasks.map((task) => (
            <TaskStrip
              key={task.name}
              nas={nas}
              task={task}
              now={now}
              tz={tz}
              lang={lang}
            />
          ))
        ) : (
          <p className="m-0 px-[18px] py-4 text-fg-2">
            {t("No Hyper Backup task.", "Aucune tâche Hyper Backup.")}
          </p>
        )}
      </Card>
      {nas.activeBackup ? (
        <ActiveBackupCard
          lang={lang}
          info={nas.activeBackup}
          checks={nas.checks}
          now={now}
        />
      ) : null}
      {nas.cloudBackups ? (
        <CloudBackupsCard
          lang={lang}
          info={nas.cloudBackups}
          checks={nas.checks}
          now={now}
        />
      ) : null}
      {recent.length ? (
        <Card labelledBy="journal">
          <CardHeader
            id="journal"
            title={t("Log", "Journal")}
            meta={t("latest finished runs", "dernières exécutions terminées")}
          />
          {recent.map((e) => (
            <div key={`${e.at}-${e.task}`} className="row">
              <span
                className={`dot d-${e.outcome === "success" ? "ok" : e.outcome === "failure" ? "crit" : "warn"}`}
                aria-hidden="true"
              />
              <span className="grow">
                {t(
                  `“${e.task ?? "?"}” ${OUTCOME[e.outcome as keyof typeof OUTCOME]?.en ?? e.outcome}`,
                  `« ${e.task ?? "?"} » ${OUTCOME[e.outcome as keyof typeof OUTCOME]?.fr ?? e.outcome}`,
                )}
              </span>
              <span className="meta">
                {formatDateTime(e.at, now, tz, lang)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

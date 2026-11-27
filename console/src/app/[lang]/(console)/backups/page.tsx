import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { TaskStrip } from "@/components/backup/task-strip";
import { nasHref } from "@/components/shell/nav";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { consoleTimeZone } from "@/lib/agents/time";
import { getFleet } from "@/lib/fleet";
import { NAS_STATE_LABEL, nasState } from "@/lib/fleet/state";
import { plural } from "@/lib/format";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Backups", fr: "Sauvegardes" }) };
}

export default async function BackupsPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const lang = await pageLocale(params);
  return (
    <Suspense
      fallback={
        <div aria-hidden="true" className="flex flex-col gap-6">
          <PageHeader
            lang={lang}
            title={tr(lang, { en: "Backups", fr: "Sauvegardes" })}
            sentence={tr(lang, {
              en: "Reading the fleet…",
              fr: "Lecture du parc…",
            })}
          />
          <div className="card h-[320px] animate-pulse" />
        </div>
      }
    >
      <Backups lang={lang} />
    </Suspense>
  );
}

/** Les tâches Hyper Backup de tous les NAS avec agent, chacune avec sa bande des 30 jours. */
async function Backups({ lang }: { lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const fleet = await getFleet(lang);
  const now = new Date();
  const tz = consoleTimeZone();
  const withAgent = fleet.filter((n) => n.agent.kind !== "none");
  const tasks = withAgent.flatMap((n) => n.tasks);
  const failed = tasks.filter((t) => t.result.status === "failed").length;
  const warning = tasks.filter((t) => t.result.status === "warning").length;
  const parts = [
    failed ? t(`${failed} failed`, `${failed} en échec`) : null,
    warning ? t(`${warning} to watch`, `${warning} à surveiller`) : null,
  ].filter(Boolean);
  const taskWord = (n: number) =>
    lang === "en"
      ? plural(n, "task", "tasks", lang)
      : plural(n, "tâche", "tâches", lang);
  const readAt =
    fleet
      .flatMap((n) => (n.agent.kind === "ok" ? [n.agent.readAt] : []))
      .sort()
      .at(-1) ?? null;
  return (
    <>
      <PageHeader
        lang={lang}
        title={t("Backups", "Sauvegardes")}
        sentence={t(
          `${taskWord(tasks.length)} on ${plural(withAgent.length, "NAS", "NAS", lang)} with an agent · ${parts.length ? parts.join(", ") : "all up to date"}`,
          `${taskWord(tasks.length)} sur ${plural(withAgent.length, "NAS", "NAS", lang)} avec agent · ${parts.length ? parts.join(", ") : "toutes à jour"}`,
        )}
        state={failed ? "failed" : warning ? "warning" : "ok"}
        readAt={readAt}
        now={now}
      />
      {withAgent.map((nas) => {
        const id = `sauvegardes-${nas.id}`;
        const read = nas.agent.kind === "ok";
        return (
          <Card key={nas.id} labelledBy={id}>
            <CardHeader
              id={id}
              title={
                <Link href={nasHref(nas.id, "backups")} className="text-fg">
                  {nas.name}
                </Link>
              }
              meta={
                read
                  ? nas.tasks.length
                    ? t(
                        `${taskWord(nas.tasks.length)} · last 30 days, NAS days`,
                        `${taskWord(nas.tasks.length)} · 30 derniers jours, jours du NAS`,
                      )
                    : t("No Hyper Backup task", "Aucune tâche Hyper Backup")
                  : t(
                      `${NAS_STATE_LABEL[nasState(nas)].en}: backups not read`,
                      `${NAS_STATE_LABEL[nasState(nas)].fr} : sauvegardes non lues`,
                    )
              }
            />
            {read
              ? nas.tasks.map((task) => (
                  <TaskStrip
                    key={task.name}
                    nas={nas}
                    task={task}
                    now={now}
                    tz={tz}
                    lang={lang}
                  />
                ))
              : null}
          </Card>
        );
      })}
    </>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { IssueList } from "@/components/fleet/issue-list";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { consoleTimeZone } from "@/lib/agents/time";
import { getFleet } from "@/lib/fleet";
import { fillDates } from "@/lib/fleet/curves";
import { fleetIssues, type IssueLevel } from "@/lib/fleet/issues";
import { issueLevelLabel, withFillDates } from "@/lib/fleet/present";
import { plural } from "@/lib/format";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "To handle", fr: "À traiter" }) };
}

const LEVELS: IssueLevel[] = [
  "offline",
  "denied",
  "agent_down",
  "failed",
  "warning",
];
const LEVEL_STATE = {
  offline: "offline",
  denied: "denied",
  agent_down: "agent_down",
  failed: "failed",
  warning: "warning",
} as const;

export default async function IssuesPage({
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
            title={tr(lang, { en: "To handle", fr: "À traiter" })}
            sentence={tr(lang, {
              en: "Reading the fleet…",
              fr: "Lecture du parc…",
            })}
          />
          <div className="card h-[320px] animate-pulse" />
        </div>
      }
    >
      <Issues lang={lang} />
    </Suspense>
  );
}

/** Tous les points du parc, groupés par état ; chacun mène au contrôle sur la page du NAS. */
async function Issues({ lang }: { lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const fleet = await getFleet(lang);
  const now = new Date();
  const tz = consoleTimeZone();
  const issues = withFillDates(
    fleetIssues(fleet, lang),
    await fillDates(fleet, now),
    now,
    tz,
    lang,
  );
  const nasCount = new Set(issues.map((i) => i.nas.id)).size;
  const readAt =
    fleet
      .flatMap((n) => (n.agent.kind === "ok" ? [n.agent.readAt] : []))
      .sort()
      .at(-1) ?? null;
  return (
    <>
      <PageHeader
        lang={lang}
        title={t("To handle", "À traiter")}
        sentence={
          issues.length
            ? t(
                `${plural(issues.length, "item", "items", lang)} on ${plural(nasCount, "NAS", "NAS", lang)} · most serious first`,
                `${plural(issues.length, "point", "points", lang)} sur ${plural(nasCount, "NAS", "NAS", lang)} · du plus grave au moins grave`,
              )
            : t(
                "Nothing to handle · every check read is fine and every NAS answers",
                "Rien à traiter · tous les contrôles lus sont bons et chaque NAS répond",
              )
        }
        state={issues.length ? LEVEL_STATE[issues[0].level] : "ok"}
        readAt={readAt}
        now={now}
      />
      {LEVELS.map((level) => {
        const group = issues.filter((i) => i.level === level);
        if (!group.length) return null;
        return (
          <Card key={level} labelledBy={`niveau-${level}`}>
            <CardHeader
              id={`niveau-${level}`}
              title={issueLevelLabel(level, lang)}
              meta={
                lang === "en"
                  ? plural(group.length, "item", "items", lang)
                  : plural(group.length, "point", "points", lang)
              }
            />
            <IssueList issues={group} now={now} tz={tz} lang={lang} />
          </Card>
        );
      })}
    </>
  );
}

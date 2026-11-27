import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { Locale } from "@/i18n";
import type { Issue } from "@/lib/fleet/issues";
import {
  formatSince,
  ISSUE_LEVEL_TONE,
  issueLevelLabel,
} from "@/lib/fleet/present";
import { issueHref } from "../shell/nav";
import { ToneBadge } from "../ui/badge";

/** Points à traiter : état, titre et que faire, NAS et depuis quand ; chacun mène au contrôle. */
export function IssueList({
  issues,
  now,
  tz,
  lang,
  showNas = true,
}: {
  issues: Issue[];
  now: Date;
  tz: string;
  lang: Locale;
  showNas?: boolean;
}) {
  return (
    <div className="@container">
      {issues.map((issue) => {
        const since = formatSince(issue.since, now, tz, lang);
        return (
          <Link
            key={`${issue.nas.id}-${issue.checkId ?? issue.level}`}
            href={issueHref(issue.nas.id, issue.checkId)}
            className="row flex-col items-stretch gap-1.5 @xl:flex-row @xl:items-center @xl:gap-4"
          >
            <span className="flex items-center justify-between gap-2 @xl:w-[132px] @xl:flex-none">
              <ToneBadge tone={ISSUE_LEVEL_TONE[issue.level]}>
                {issueLevelLabel(issue.level, lang)}
              </ToneBadge>
              <span className="meta @xl:hidden">
                {[showNas ? issue.nas.name : null, since || null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="flex min-w-0 grow flex-col gap-0.5">
              <span className="font-semibold text-[14px] text-fg @max-xl:text-[15px]">
                {issue.title}
              </span>
              {issue.todo ? (
                <span className="text-[13px] text-fg-2 @max-xl:text-[13.5px]">
                  {issue.todo}
                </span>
              ) : null}
            </span>
            <span className="hidden w-[160px] flex-none flex-col items-end gap-0.5 text-right @xl:flex">
              {showNas ? (
                <span className="font-medium text-[13px] text-fg">
                  {issue.nas.name}
                </span>
              ) : null}
              {since ? <span className="meta">{since}</span> : null}
            </span>
            <ChevronRight
              className="icon chev hidden @xl:block"
              aria-hidden="true"
            />
          </Link>
        );
      })}
    </div>
  );
}

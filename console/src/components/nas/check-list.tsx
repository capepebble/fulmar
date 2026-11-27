import { type Locale, tr } from "@/i18n";
import { formatSince } from "@/lib/fleet/present";
import { categoryLabel } from "@/lib/fleet/specs";
import { SEVERITY_LABEL, STATUS_LABEL } from "@/lib/fleet/state";
import type { Check, Nas, Status } from "@/lib/fleet/types";
import { plural } from "@/lib/format";
import { StateBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import { OpenFromHash } from "./open-hash";

const ORDER: Status[] = ["failed", "warning", "unknown", "ok"];

/** Les contrôles de l'agent, groupés par état ; chacun se déplie (observé, attendu, que
 * faire, éléments, opérations sources). Ancre : l'identifiant du contrôle. */
export function CheckList({
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
  return (
    <>
      <OpenFromHash />
      {ORDER.map((status) => {
        const checks = nas.checks.filter((c) => c.status === status);
        if (!checks.length) return null;
        const id = `controles-${status}`;
        return (
          <Card key={status} labelledBy={id}>
            <CardHeader
              id={id}
              title={STATUS_LABEL[status][lang]}
              meta={
                lang === "en"
                  ? plural(checks.length, "check", "checks", lang)
                  : plural(checks.length, "contrôle", "contrôles", lang)
              }
            />
            {checks.map((c) => (
              <CheckItem
                key={c.id}
                check={c}
                seen={nas.seen[c.id]}
                now={now}
                tz={tz}
                lang={lang}
              />
            ))}
          </Card>
        );
      })}
    </>
  );
}

function CheckItem({
  check,
  seen,
  now,
  tz,
  lang,
}: {
  check: Check;
  seen: string | undefined;
  now: Date;
  tz: string;
  lang: Locale;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const since = seen
    ? formatSince({ label: "vu le", at: seen }, now, tz, lang)
    : "";
  return (
    <details
      id={check.id}
      className="group scroll-mt-24 border-border border-t first-of-type:border-t-0"
      open={check.status === "failed" || check.status === "warning"}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3.5 px-[18px] py-3 hover:bg-hover [&::-webkit-details-marker]:hidden">
        <span className="w-[112px] flex-none pt-px">
          <StateBadge state={check.status} />
        </span>
        <span className="flex min-w-0 grow flex-col gap-0.5">
          <span className="font-semibold">{check.title}</span>
          <span className="text-[13px] text-fg-2">{check.observed}</span>
        </span>
        <span className="meta hidden flex-none text-right md:block">
          {categoryLabel(check.category, lang)} ·{" "}
          {SEVERITY_LABEL[check.severity][lang]}
          {since ? (
            <>
              <br />
              {since}
            </>
          ) : null}
        </span>
      </summary>
      <dl className="m-0 grid gap-x-6 gap-y-2 px-[18px] pt-1 pb-4 text-[13.5px] md:grid-cols-[140px_1fr] md:pl-[144px]">
        <dt className="text-fg-3">{t("Expected", "Attendu")}</dt>
        <dd className="m-0">{check.expected}</dd>
        {check.advice ? (
          <>
            <dt className="text-fg-3">{t("What to do", "Que faire")}</dt>
            <dd className="m-0">{check.advice}</dd>
          </>
        ) : null}
        {check.items.length ? (
          <>
            <dt className="text-fg-3">{t("At fault", "En cause")}</dt>
            <dd className="m-0">
              <ul className="m-0 list-disc pl-4">
                {check.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt className="text-fg-3">{t("Read from", "Lu dans")}</dt>
        <dd className="m-0 font-mono text-[12px] text-fg-2">
          {check.sources.join(", ") || "–"}
        </dd>
      </dl>
    </details>
  );
}

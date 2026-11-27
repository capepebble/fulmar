import { type Locale, tr } from "@/i18n";
import {
  briefLine,
  type MonthReport,
  volumeName,
  writeWords,
} from "@/lib/agents/report";
import { number } from "@/lib/format";
import { PRODUCT_NAME } from "@/lib/product";

// Le bilan du mois, en feuilles A4 (conception 2026-11-26-bilan-du-mois, section 3) : une page
// de garde quand il porte sur plusieurs NAS, puis une feuille par NAS. Toujours sur papier
// blanc, à l'écran comme à l'impression ; les états gardent leur mot à côté de leur couleur.

export interface ReportNas {
  id: string;
  name: string;
  context: string;
  report: MonthReport | null;
  reason: string | null;
}

const TONE = {
  ok: "text-[#248a3d]",
  warning: "text-[#b25000]",
  failed: "text-[#d70015]",
} as const;

function whenFormat(lang: Locale, tz: string) {
  const f = new Intl.DateTimeFormat(lang, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
  return (iso: string | null) => (iso ? f.format(new Date(iso)) : "–");
}

function bytes(n: number | null, lang: Locale): string {
  if (n === null) return "–";
  const sign = n < 0 ? "−" : "+";
  const abs = Math.abs(n);
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const en = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = abs;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${sign}${number(v, v < 10 ? 1 : 0, lang)} ${(lang === "en" ? en : units)[i]}`;
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-7 mb-2 font-semibold text-[13px] text-[#6e6e73] uppercase tracking-[0.04em]">
      {children}
    </h3>
  );
}

/** Un tableau du bilan ; chaque ligne porte sa clé, chaque cellule celle de sa colonne. */
function Table({
  head,
  rows,
}: {
  head: string[];
  rows: { key: string; cells: React.ReactNode[] }[];
}) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="border-[#d2d2d7] border-b-[0.5px] py-1.5 pr-3 text-left font-medium text-[#6e6e73]"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {r.cells.map((c, j) => (
              <td
                key={head[j]}
                className="border-[#e8e8ed] border-b-[0.5px] py-1.5 pr-3 align-top"
              >
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NasSheet({
  nas,
  lang,
  tz,
  monthLabel,
}: {
  nas: ReportNas;
  lang: Locale;
  tz: string;
  monthLabel: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const when = whenFormat(lang, tz);
  const r = nas.report;
  const word = (s: "ok" | "warning" | "failed") =>
    ({
      ok: t("ok", "conforme"),
      warning: t("warning", "attention"),
      failed: t("failed", "en échec"),
    })[s];
  return (
    <section className="sheet">
      <div className="flex items-baseline justify-between gap-4 border-[#d2d2d7] border-b-[0.5px] pb-3">
        <div>
          <h2 className="m-0 font-bold text-[24px] tracking-[-0.02em]">
            {nas.name}
          </h2>
          <p className="m-0 text-[13px] text-[#6e6e73]">{nas.context}</p>
        </div>
        <p className="m-0 text-right text-[13px] text-[#6e6e73]">
          {t("Report for", "Bilan de")} {monthLabel}
          {r?.inProgress ? t(" (month in progress)", " (mois en cours)") : ""}
        </p>
      </div>
      {!r ? (
        <p className="mt-6 text-[14px]">{nas.reason}</p>
      ) : (
        <>
          <H3>{t("In brief", "En bref")}</H3>
          <p className="m-0 text-[15px] leading-relaxed">
            {briefLine(r, lang)}
          </p>
          <p className="mt-2 mb-0 text-[13px] text-[#424245]">
            {r.endState.source === "none"
              ? t("End state not recorded.", "État de fin non relevé.")
              : t(
                  `${r.endState.source === "current" ? "Now" : "At the end of the month"}: ${r.endState.ok} checks ok, ${r.endState.warning} to watch, ${r.endState.failed} failed.`,
                  `${r.endState.source === "current" ? "Aujourd'hui" : "À la fin du mois"} : ${r.endState.ok} contrôles conformes, ${r.endState.warning} à surveiller, ${r.endState.failed} en échec.`,
                )}
          </p>
          {r.endState.failing.length ? (
            <ul className="mt-1 mb-0 pl-5 text-[13px]">
              {r.endState.failing.map((f) => (
                <li key={f.id}>
                  {f.title} :{" "}
                  <span className={TONE[f.status]}>{word(f.status)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <H3>{t("Incidents", "Incidents")}</H3>
          {r.incidents.length ? (
            <Table
              head={[
                t("Check", "Contrôle"),
                t("State", "État"),
                t("Since", "Depuis"),
                t("Back", "Revenu"),
              ]}
              rows={r.incidents.map((i) => ({
                key: `${i.checkId}-${i.at}`,
                cells: [
                  i.title,
                  <span key="s" className={TONE[i.status]}>
                    {word(i.status)}
                  </span>,
                  when(i.at),
                  i.recoveredAt
                    ? when(i.recoveredAt)
                    : t("still open", "encore ouvert"),
                ],
              }))}
            />
          ) : (
            <p className="m-0 text-[13px] text-[#424245]">
              {t(
                "No check went wrong this month.",
                "Aucun contrôle n'est passé en alerte ce mois-ci.",
              )}
            </p>
          )}

          <H3>{t("Availability and vitals", "Disponibilité et constantes")}</H3>
          <p className="m-0 text-[13px] text-[#424245]">
            {r.availability.readPct === null
              ? t(
                  "Not recorded (history off).",
                  "Non relevé (historique coupé).",
                )
              : t(
                  `Fulmar read the NAS ${number(r.availability.readPct, 1, lang)}% of the time, since ${when(r.availability.since)}.`,
                  `Fulmar a lu le NAS ${number(r.availability.readPct, 1, lang)} % du temps, depuis le ${when(r.availability.since)}.`,
                )}
            {r.vitals
              ? t(
                  ` Processor ${number(r.vitals.cpuAvg ?? 0, 0, lang)}% on average (peak ${number(r.vitals.cpuMax ?? 0, 0, lang)}%), memory ${number(r.vitals.memoryAvg ?? 0, 0, lang)}% (peak ${number(r.vitals.memoryMax ?? 0, 0, lang)}%), highest temperature ${number(r.vitals.temperatureMax ?? 0, 0, lang)} °C.`,
                  ` Processeur à ${number(r.vitals.cpuAvg ?? 0, 0, lang)} % en moyenne (pointe à ${number(r.vitals.cpuMax ?? 0, 0, lang)} %), mémoire à ${number(r.vitals.memoryAvg ?? 0, 0, lang)} % (pointe à ${number(r.vitals.memoryMax ?? 0, 0, lang)} %), température la plus haute ${number(r.vitals.temperatureMax ?? 0, 0, lang)} °C.`,
                )
              : ""}
          </p>

          <H3>{t("Storage", "Stockage")}</H3>
          {r.volumes.length ? (
            <Table
              head={[
                t("Volume", "Volume"),
                t("Start", "Début"),
                t("End", "Fin"),
                t("Taken", "Pris"),
              ]}
              rows={r.volumes.map((v) => ({
                key: v.volume,
                cells: [
                  volumeName(v.volume),
                  v.startPct === null
                    ? "–"
                    : `${number(v.startPct, 1, lang)} %`,
                  v.endPct === null ? "–" : `${number(v.endPct, 1, lang)} %`,
                  bytes(v.grownBytes, lang),
                ],
              }))}
            />
          ) : (
            <p className="m-0 text-[13px] text-[#424245]">
              {t("Not recorded.", "Non relevé.")}
            </p>
          )}

          <H3>{t("Updates", "Mises à jour")}</H3>
          {r.updates.length ? (
            <Table
              head={[
                t("What", "Quoi"),
                t("From", "De"),
                t("To", "À"),
                t("When", "Quand"),
              ]}
              rows={r.updates.map((u) => ({
                key: `${u.name}-${u.endedAt}`,
                cells: [
                  <span key="n">
                    {u.name}
                    {u.state !== "done" ? (
                      <span className={TONE.failed}>
                        {" "}
                        · {t("failed", "en échec")}
                      </span>
                    ) : null}
                  </span>,
                  u.from,
                  u.to,
                  when(u.endedAt),
                ],
              }))}
            />
          ) : (
            <p className="m-0 text-[13px] text-[#424245]">
              {t(
                "Fulmar updated nothing this month.",
                "Fulmar n'a rien mis à jour ce mois-ci.",
              )}
            </p>
          )}

          <H3>{t("What Fulmar did", "Ce que Fulmar a fait")}</H3>
          <p className="m-0 text-[13px] text-[#424245]">
            {t(
              `${number(r.fulmar.calls, 0, lang)} calls logged, ${r.fulmar.denied} refused.`,
              `${number(r.fulmar.calls, 0, lang)} appels notés au journal, ${r.fulmar.denied} refusés.`,
            )}{" "}
            {r.fulmar.writes.length
              ? t(
                  `Changes: ${r.fulmar.writes.map((w) => writeWords(w, lang)).join(", ")}.`,
                  `Modifications : ${r.fulmar.writes.map((w) => writeWords(w, lang)).join(", ")}.`,
                )
              : t("No change made to the NAS.", "Aucune modification du NAS.")}
          </p>
        </>
      )}
      <footer className="mt-8 text-[11px] text-[#86868b]">
        {PRODUCT_NAME} · {t("times in", "heures en")} {tz}
      </footer>
    </section>
  );
}

export function ReportDocument({
  lang,
  tz,
  monthLabel,
  scopeLabel,
  nas,
  generatedAt,
}: {
  lang: Locale;
  tz: string;
  monthLabel: string;
  scopeLabel: string;
  nas: ReportNas[];
  generatedAt: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const when = whenFormat(lang, tz);
  return (
    <div className="flex flex-col items-center gap-6">
      {nas.length > 1 ? (
        <section className="sheet">
          <p className="m-0 font-semibold text-[#cc4700] text-[13px]">
            {PRODUCT_NAME}
          </p>
          <h1 className="mt-6 mb-1 font-bold text-[34px] tracking-[-0.025em]">
            {t("Report for", "Bilan de")} {monthLabel}
          </h1>
          <p className="m-0 text-[17px] text-[#424245]">{scopeLabel}</p>
          <p className="mt-1 mb-0 text-[13px] text-[#6e6e73]">
            {t("Made on", "Établi le")} {when(generatedAt.toISOString())}
          </p>
          <H3>{t("The NAS", "Les NAS")}</H3>
          <Table
            head={[t("NAS", "NAS"), t("The month", "Le mois")]}
            rows={nas.map((n) => ({
              key: n.id,
              cells: [
                <span key="n" className="font-medium">
                  {n.name}
                </span>,
                n.report ? briefLine(n.report, lang) : (n.reason ?? "–"),
              ],
            }))}
          />
        </section>
      ) : null}
      {nas.map((n) => (
        <NasSheet
          key={n.id}
          nas={n}
          lang={lang}
          tz={tz}
          monthLabel={monthLabel}
        />
      ))}
    </div>
  );
}

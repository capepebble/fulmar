import { Globe, KeyRound, Server, Smartphone } from "lucide-react";
import Link from "next/link";
import { type Locale, tr } from "@/i18n";
import {
  type AccessOk,
  type AccessView,
  accountPhrase,
  type JournalLine,
  rightsWords,
  scopeWords,
  tokenName,
  whyWords,
} from "@/lib/agents/access";
import { date, formatDateTime } from "@/lib/agents/time";
import { plural } from "@/lib/format";
import { nasHref } from "../shell/nav";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import { DetachNas } from "./detach-nas";
import { RemoveNas } from "./remove-nas";

// Onglet Accès (conception 2026-11-26-carte-sur-table) : ce que Fulmar fait sur ce NAS, qui y
// accède, vers où il se connecte, comment le couper depuis DSM, son journal ; puis le geste
// pour le détacher (NAS du projet) ou le retirer du parc (NAS ajouté au hub).

type Where = "engine" | "member" | "agent";

function account(view: AccessOk, lang: Locale): string {
  return accountPhrase(view.dsm.account, lang);
}

function Lead({ view, lang }: { view: AccessOk; lang: Locale }) {
  const who = view.tokens.length + view.tokensOthers;
  const phones = view.phones ?? 0;
  const parts = [
    lang === "en"
      ? plural(who, "token", "tokens", lang)
      : plural(who, "jeton", "jetons", lang),
    ...(phones
      ? [
          lang === "en"
            ? plural(phones, "phone", "phones", lang)
            : plural(phones, "téléphone", "téléphones", lang),
        ]
      : []),
  ].join(tr(lang, { en: " and ", fr: " et " }));
  return (
    <p className="m-0 max-w-[68ch] text-[15px] text-fg-2">
      {tr(lang, {
        en: `Fulmar reads this NAS with ${account(view, lang)}. It may update its packages and DSM and close SSH or Telnet, nothing else. ${parts} ${who + phones > 1 ? "reach" : "reaches"} it.`,
        fr: `Fulmar lit ce NAS avec ${account(view, lang)}. Il peut mettre à jour ses paquets et DSM, et fermer SSH ou Telnet ; rien d'autre. ${parts} y ${who + phones > 1 ? "accèdent" : "accède"}.`,
      })}
    </p>
  );
}

function WhatItDoes({ view, lang }: { view: AccessOk; lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <Card labelledBy="ce-que-fulmar-fait">
      <CardHeader
        id="ce-que-fulmar-fait"
        title={t("What Fulmar does here", "Ce que Fulmar fait ici")}
        meta={view.agentVersion ? `agent ${view.agentVersion}` : undefined}
      />
      <div className="px-[18px] pt-3 pb-1">
        <h3 className="meta m-0 font-medium uppercase tracking-[0.04em]">
          {t("Reads", "Lit")}
        </h3>
      </div>
      {view.reads.map((r) => (
        <div key={r.scope} className="row justify-between py-2.5">
          <span className="first-letter:uppercase">
            {scopeWords(r.scope, lang)}
          </span>
          <span className="meta tabular-nums">
            {lang === "en"
              ? plural(r.count, "read", "reads", lang)
              : plural(r.count, "lecture", "lectures", lang)}
          </span>
        </div>
      ))}
      <div className="px-[18px] pt-4 pb-1">
        <h3 className="meta m-0 font-medium uppercase tracking-[0.04em]">
          {t("May change", "Peut modifier")}
        </h3>
      </div>
      {view.writes.map((w) => {
        const holders = view.tokens
          .filter((tk) => tk.scopes.includes(w.scope))
          .map((tk) => tokenName(tk.label, lang));
        return (
          <div key={w.op} className="row justify-between py-2.5">
            <div className="flex min-w-0 flex-col">
              <span className="first-letter:uppercase">
                {scopeWords(w.scope, lang)}
                {w.scope === "dsm:update"
                  ? t(" (restarts the NAS)", " (redémarre le NAS)")
                  : w.scope === "access:close"
                    ? t(" (never open them)", " (jamais les ouvrir)")
                    : ""}
              </span>
              <span className="meta">
                {holders.length
                  ? t(
                      `right held by ${holders.join(", ")}`,
                      `droit tenu par ${holders.join(", ")}`,
                    )
                  : t(
                      "no token shown here holds this right",
                      "aucun jeton montré ici n'a ce droit",
                    )}
              </span>
            </div>
          </div>
        );
      })}
      <p className="meta m-0 px-[18px] pt-2 pb-4">
        {t(
          "Nothing else: every read and every change is a fixed call of the agent’s catalog, logged in its journal.",
          "Rien d'autre : chaque lecture et chaque modification est un appel fixe du catalogue de l'agent, noté à son journal.",
        )}
      </p>
    </Card>
  );
}

function Connections({ view, lang }: { view: AccessOk; lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <Card labelledBy="vers-ou">
      <CardHeader
        id="vers-ou"
        title={t("Where it connects", "Vers où il se connecte")}
      />
      <div className="row items-start">
        <Server className="icon mt-0.5 shrink-0 text-fg-3" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="font-medium">
            {t("This NAS’s DSM", "Le DSM de ce NAS")}
          </span>
          <span className="meta break-all">
            {view.dsm.host
              ? `${view.dsm.host}${view.dsm.port ? `:${view.dsm.port}` : ""}`
              : "–"}{" "}
            ·{" "}
            {view.dsm.pinned
              ? t("certificate pinned", "certificat épinglé")
              : t(
                  "certificate checked by name",
                  "certificat vérifié par son nom",
                )}
          </span>
        </div>
      </div>
      {view.outbound.map((o) => (
        <div key={`${o.why}-${o.to}`} className="row items-start">
          <Globe
            className="icon mt-0.5 shrink-0 text-fg-3"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col">
            <span className="break-all font-medium font-mono text-[13px]">
              {o.to}
            </span>
            <span className="meta">{whyWords(o.why, lang)}</span>
          </div>
        </div>
      ))}
      {view.outbound.length === 0 ? (
        <p className="meta m-0 px-[18px] pt-1 pb-4">
          {t("No connection outside the NAS.", "Aucune connexion hors du NAS.")}
        </p>
      ) : (
        <p className="meta m-0 px-[18px] pt-1 pb-4">
          {t("Nothing else leaves the NAS.", "Rien d'autre ne sort du NAS.")}
        </p>
      )}
    </Card>
  );
}

function Who({
  view,
  lang,
  nasId,
  now,
  tz,
}: {
  view: AccessOk;
  lang: Locale;
  nasId: string;
  now: Date;
  tz: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const count = view.tokens.length + view.tokensOthers;
  return (
    <Card labelledBy="qui-y-accede">
      <CardHeader
        id="qui-y-accede"
        title={t("Who reaches it", "Qui y accède")}
        meta={
          lang === "en"
            ? plural(count, "active token", "active tokens", lang)
            : plural(count, "jeton actif", "jetons actifs", lang)
        }
      />
      {view.tokens.map((tk) => (
        <div key={tk.id} className="row items-start justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <KeyRound
              className="icon mt-0.5 shrink-0 text-fg-3"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {tokenName(tk.label, lang)}
                {tk.changesDsm ? (
                  <ToneBadge tone="off" dot={false}>
                    {t("may change DSM", "peut modifier DSM")}
                  </ToneBadge>
                ) : null}
              </span>
              <span className="meta">{rightsWords(tk.scopes, lang)}</span>
              <span className="meta">
                {tk.lastUsedAt
                  ? t(
                      `last used ${formatDateTime(tk.lastUsedAt, now, tz, lang)}`,
                      `dernier usage ${formatDateTime(tk.lastUsedAt, now, tz, lang)}`,
                    )
                  : t("never used", "jamais utilisé")}{" "}
                ·{" "}
                {t(
                  `expires ${date(tk.expiresAt, lang)}`,
                  `expire le ${date(tk.expiresAt, lang)}`,
                )}{" "}
                ·{" "}
                {tk.networks.length
                  ? t(
                      `from ${tk.networks.join(", ")}`,
                      `depuis ${tk.networks.join(", ")}`,
                    )
                  : t("from any address", "depuis toute adresse")}
              </span>
            </div>
          </div>
        </div>
      ))}
      {view.tokensOthers > 0 ? (
        <p className="meta m-0 px-[18px] py-3">
          {lang === "en"
            ? `And ${plural(view.tokensOthers, "other token", "other tokens", lang)}, listed only to the project console.`
            : `Et ${plural(view.tokensOthers, "autre jeton", "autres jetons", lang)}, montrés à la seule console du projet.`}
        </p>
      ) : null}
      {view.phones !== null ? (
        <Link href={nasHref(nasId, "phones")} className="row">
          <Smartphone className="icon shrink-0 text-fg-3" aria-hidden="true" />
          <span className="flex-1">
            {view.phones === 0
              ? t("No paired phone", "Aucun téléphone appairé")
              : lang === "en"
                ? `${plural(view.phones, "paired phone", "paired phones", lang)}, reading only`
                : `${plural(view.phones, "téléphone appairé", "téléphones appairés", lang)}, en lecture seule`}
          </span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </Link>
      ) : null}
      {view.fleetMembers ? (
        <p className="meta m-0 px-[18px] py-3">
          {lang === "en"
            ? `This hub also reads ${plural(view.fleetMembers, "added NAS", "added NAS", lang)}, each with its own account and token.`
            : `Ce hub lit aussi ${plural(view.fleetMembers, "NAS ajouté", "NAS ajoutés", lang)}, chacun avec son compte et son jeton.`}
        </p>
      ) : null}
    </Card>
  );
}

function CutFromDsm({
  view,
  lang,
  where,
}: {
  view: AccessOk;
  lang: Locale;
  where: Where;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const who = account(view, lang);
  const steps = [
    t(
      `See it connected: Resource Monitor › Connections lists ${who} with the address it reads from; Log Center keeps its sign-ins.`,
      `Le voir connecté : Moniteur de ressources › Connexions montre ${who} et l'adresse d'où il lit ; le Centre des journaux garde ses connexions.`,
    ),
    t(
      `Cut it at once: Control Panel › User & Group, delete ${who} or change its password. Fulmar reads nothing more, and the trusted device of its two-factor sign-in goes with the account.`,
      `Le couper à l'instant : Panneau de configuration › Utilisateur et groupe, supprimer ${who} ou changer son mot de passe. Fulmar ne lit plus rien, et l'appareil de confiance de sa double authentification part avec le compte.`,
    ),
    where === "member"
      ? t(
          "Nothing is installed on this NAS: the hub reads it over the network. Deleting the account is enough; “Remove from the fleet” erases what the hub keeps of it.",
          "Rien n'est installé sur ce NAS : le hub le lit par le réseau. Supprimer le compte suffit ; « Retirer du parc » efface ce que le hub en garde.",
        )
      : t(
          "Remove it: Container Manager › Project, stop then delete Fulmar’s project.",
          "Le retirer : Container Manager › Projet, arrêter puis supprimer le projet de Fulmar.",
        ),
  ];
  return (
    <Card labelledBy="couper-depuis-dsm">
      <CardHeader
        id="couper-depuis-dsm"
        title={t("Cut it from DSM", "Le couper depuis DSM")}
        meta={t("no need for this console", "sans passer par cette console")}
      />
      <ol className="m-0 flex list-none flex-col gap-3 px-[18px] py-4">
        {steps.map((step, i) => (
          <li key={step} className="flex gap-3">
            <span
              className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--hover)] font-semibold text-[11px] tabular-nums"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span className="text-fg-2">{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function channelWords(line: JournalLine, lang: Locale): string {
  const words: Record<JournalLine["channel"], { en: string; fr: string }> = {
    rest: { en: "API", fr: "API" },
    mcp: { en: "MCP", fr: "MCP" },
    cli: { en: "command line", fr: "ligne de commande" },
    internal: { en: "agent", fr: "agent" },
    phone: { en: "phone", fr: "téléphone" },
  };
  return tr(lang, words[line.channel]);
}

function Journal({
  view,
  lang,
  now,
  tz,
}: {
  view: AccessOk;
  lang: Locale;
  now: Date;
  tz: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <Card labelledBy="journal">
      <CardHeader
        id="journal"
        title={t("Journal", "Journal")}
        meta={
          view.journalAll
            ? t("latest calls", "derniers appels")
            : t("this token’s calls only", "les appels de ce jeton seulement")
        }
        action={
          view.journalOk ? (
            <ToneBadge tone="ok">
              {t("Chain intact", "Chaîne intacte")}
            </ToneBadge>
          ) : (
            <ToneBadge tone="crit">
              {t("Chain broken", "Chaîne rompue")}
            </ToneBadge>
          )
        }
      />
      {view.journal.length === 0 ? (
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {t("No call yet.", "Aucun appel pour l'instant.")}
        </p>
      ) : (
        view.journal.map((line, i) => (
          <div
            // Deux lignes peuvent tomber à la même seconde : l'ordre du journal départage.
            key={`${line.ts}-${i}`}
            className="row justify-between py-2.5"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[13px]">
                {line.op ?? "–"}
              </span>
              <span className="meta">
                {channelWords(line, lang)}
                {line.token ? ` · ${tokenName(line.token, lang)}` : ""}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              {line.outcome === "ok" ? null : (
                <ToneBadge tone={line.outcome === "denied" ? "warn" : "crit"}>
                  {line.outcome === "denied"
                    ? t("refused", "refusé")
                    : t("failed", "échec")}
                </ToneBadge>
              )}
              <span className="meta tabular-nums">
                {formatDateTime(line.ts, now, tz, lang)}
              </span>
            </span>
          </div>
        ))
      )}
    </Card>
  );
}

export function AccessSection({
  view,
  lang,
  nasId,
  nasName,
  member,
  now,
  tz,
  children,
}: {
  /** Ce qui suit « Ce que Fulmar fait ici » : les protections. */
  children?: React.ReactNode;
  view: AccessView;
  lang: Locale;
  nasId: string;
  nasName: string;
  member: boolean;
  now: Date;
  tz: string;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  if (view.kind !== "ok")
    return (
      <Card labelledBy="acces">
        <CardHeader id="acces" title={t("Access", "Accès")} />
        <p className="m-0 px-[18px] py-4 text-fg-2">{view.reason}</p>
      </Card>
    );
  const where: Where = member
    ? "member"
    : view.fleetMembers !== null
      ? "engine"
      : "agent";
  return (
    <div className="flex flex-col gap-4">
      <Lead view={view} lang={lang} />
      {view.demo ? (
        <p className="meta m-0">
          {t(
            "Fictitious NAS: an example, without any gesture.",
            "NAS fictif : un exemple, sans geste.",
          )}
        </p>
      ) : null}
      <div className="grid items-start gap-4 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
        <WhatItDoes view={view} lang={lang} />
        <Connections view={view} lang={lang} />
      </div>
      {children}
      <Who view={view} lang={lang} nasId={nasId} now={now} tz={tz} />
      <div className="grid items-start gap-4 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
        <CutFromDsm view={view} lang={lang} where={where} />
        {member ? (
          <RemoveNas nasId={nasId} name={nasName} />
        ) : view.canDetach && !view.demo ? (
          <DetachNas
            nasId={nasId}
            name={nasName}
            account={view.dsm.account}
            members={view.fleetMembers ?? 0}
          />
        ) : null}
      </div>
      <Journal view={view} lang={lang} now={now} tz={tz} />
    </div>
  );
}

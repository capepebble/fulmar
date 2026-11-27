import { type Locale, tr } from "@/i18n";
import { since } from "@/lib/agents/time";
import type { Check, CloudBackupsInfo } from "@/lib/fleet/types";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";

// Active Backup for Microsoft 365 et for Google Workspace (2026-11-26) : une ligne par tâche,
// sans jamais un compte sauvegardé (l'agent n'en donne que le nombre). Le ton d'une tâche en
// cause vient du contrôle « Microsoft 365 et Google Workspace », qui la nomme.

const SUITE = {
  microsoft365: "Microsoft 365",
  google_workspace: "Google Workspace",
};

function stateOf(
  t: CloudBackupsInfo["tasks"][number],
  check: Check | undefined,
  lang: Locale,
): { tone: Tone; label: string } {
  const tx = (en: string, fr: string) => tr(lang, { en, fr });
  const item = check?.items.find(
    (i) => i.startsWith(`${t.name} :`) || i.startsWith(`${t.name}:`),
  );
  if (item && (check?.status === "failed" || check?.status === "warning")) {
    const why = item.slice(item.indexOf(":") + 1).trim();
    return {
      tone: check.status === "failed" ? "crit" : "warn",
      label: why.charAt(0).toUpperCase() + why.slice(1),
    };
  }
  if (t.lastResult === "running")
    return { tone: "off", label: tx("Backing up", "En cours") };
  if (t.lastResult === "success")
    return { tone: "ok", label: tx("Backed up", "Sauvegardé") };
  return { tone: "off", label: tx("Waiting", "En attente") };
}

export function CloudBackupsCard({
  lang,
  info,
  checks,
  now,
}: {
  lang: Locale;
  info: CloudBackupsInfo;
  checks: Check[];
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const check = checks.find((c) => c.id === "backup.cloud_accounts");
  return (
    <Card labelledBy="cloud-backups">
      <CardHeader
        id="cloud-backups"
        title={info.suites.map((s) => SUITE[s]).join(" · ")}
        meta="Active Backup"
      />
      {info.tasks.length ? (
        info.tasks.map((task) => {
          const state = stateOf(task, check, lang);
          const accounts =
            task.accounts == null
              ? null
              : t(
                  `${task.accounts} ${task.accounts === 1 ? "account" : "accounts"}`,
                  `${task.accounts} ${task.accounts > 1 ? "comptes" : "compte"}`,
                );
          const mode = task.continuous
            ? t("continuous backup", "sauvegarde continue")
            : t("scheduled", "planifiée");
          return (
            <div
              key={`${task.suite}-${task.name}`}
              className="row justify-between gap-3"
            >
              <span className="grow">
                <span className="block font-medium">{task.name}</span>
                <span className="meta">
                  {[
                    SUITE[task.suite],
                    accounts,
                    mode,
                    task.lastRunAt
                      ? t(
                          `last run ${since(task.lastRunAt, now, lang)}`,
                          `dernière exécution ${since(task.lastRunAt, now, lang)}`,
                        )
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
            </div>
          );
        })
      ) : (
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {t(
            "Installed, no backup task.",
            "Installé, aucune tâche de sauvegarde.",
          )}
        </p>
      )}
    </Card>
  );
}

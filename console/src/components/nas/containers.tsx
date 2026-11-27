import { type Locale, tr } from "@/i18n";
import { bytes, since } from "@/lib/agents/time";
import type { AgentContainer, Check } from "@/lib/fleet/types";
import { formatPct } from "@/lib/format";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";

// Les conteneurs lus par l'agent dans Container Manager (2026-11-26). Le ton d'un conteneur
// en difficulté vient du contrôle « Conteneurs » de l'agent, qui le nomme ; sinon, l'état
// seul, sans verdict : en marche, arrêté, en pause.

function stateOf(
  c: AgentContainer,
  check: Check | undefined,
  lang: Locale,
): { tone: Tone; label: string } {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const item = check?.items.find(
    (i) => i.startsWith(`${c.name} :`) || i.startsWith(`${c.name}:`),
  );
  if (item && (check?.status === "failed" || check?.status === "warning")) {
    const why = item.slice(item.indexOf(":") + 1).trim();
    return {
      tone: check.status === "failed" ? "crit" : "warn",
      label: why.charAt(0).toUpperCase() + why.slice(1),
    };
  }
  if (c.state === "running")
    return {
      tone: "ok",
      label:
        c.health === "healthy"
          ? t("Running, healthy", "En marche, en bonne santé")
          : t("Running", "En marche"),
    };
  if (c.state === "paused")
    return { tone: "off", label: t("Paused", "En pause") };
  return { tone: "off", label: t("Stopped", "Arrêté") };
}

export function ContainersCard({
  lang,
  containers,
  checks,
  now,
}: {
  lang: Locale;
  containers: AgentContainer[];
  checks: Check[];
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const check = checks.find((c) => c.id === "containers.state");
  const running = containers.filter((c) => c.state === "running").length;
  return (
    <Card labelledBy="conteneurs">
      <CardHeader
        id="conteneurs"
        title={t("Containers", "Conteneurs")}
        meta={t(
          `${running} of ${containers.length} running`,
          `${running} en marche sur ${containers.length}`,
        )}
      />
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">{t("Container", "Conteneur")}</th>
              <th scope="col">{t("State", "État")}</th>
              <th scope="col">{t("Processor", "Processeur")}</th>
              <th scope="col">{t("Memory", "Mémoire")}</th>
              <th scope="col">{t("Started", "Démarré")}</th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c) => {
              const state = stateOf(c, check, lang);
              return (
                <tr key={c.name}>
                  <td>
                    <span className="block font-medium">{c.name}</span>
                    {c.image ? <span className="meta">{c.image}</span> : null}
                  </td>
                  <td>
                    <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
                  </td>
                  <td>{formatPct(c.cpu, lang, 1)}</td>
                  <td>
                    {c.memoryBytes != null ? bytes(c.memoryBytes, lang) : "–"}
                  </td>
                  <td>
                    {c.state === "running" && c.startedAt
                      ? since(c.startedAt, now, lang)
                      : "–"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

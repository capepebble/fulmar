import { type Locale, type Texts, tr } from "@/i18n";
import { since } from "@/lib/agents/time";
import type { AbbInfo, Check } from "@/lib/fleet/types";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";

// Active Backup for Business, appareil par appareil (2026-11-26). Le ton d'un appareil en
// retard ou en échec vient du contrôle « Active Backup : appareils sauvegardés », qui le nomme ;
// sinon l'état seul.

const TYPE: Record<string, Texts> = {
  pc: { en: "Computer", fr: "Poste" },
  server: { en: "Physical server", fr: "Serveur physique" },
  vm: { en: "Virtual machine", fr: "Machine virtuelle" },
  file_server: { en: "File server", fr: "Serveur de fichiers" },
  dsm: { en: "DSM", fr: "DSM" },
};

function stateOf(
  d: AbbInfo["devices"][number],
  check: Check | undefined,
  lang: Locale,
): { tone: Tone; label: string } {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const item = check?.items.find(
    (i) => i.startsWith(`${d.name} :`) || i.startsWith(`${d.name}:`),
  );
  if (item && (check?.status === "failed" || check?.status === "warning")) {
    const why = item.slice(item.indexOf(":") + 1).trim();
    return {
      tone: check.status === "failed" ? "crit" : "warn",
      label: why.charAt(0).toUpperCase() + why.slice(1),
    };
  }
  if (d.running) return { tone: "off", label: t("Backing up", "En cours") };
  if (d.lastResult === "success")
    return { tone: "ok", label: t("Backed up", "Sauvegardé") };
  return { tone: "off", label: t("Waiting", "En attente") };
}

export function ActiveBackupCard({
  lang,
  info,
  checks,
  now,
}: {
  lang: Locale;
  info: AbbInfo;
  checks: Check[];
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const check = checks.find((c) => c.id === "backup.abb_devices");
  return (
    <Card labelledBy="active-backup">
      <CardHeader
        id="active-backup"
        title="Active Backup for Business"
        meta={
          info.activated === false
            ? t("not activated", "non activé")
            : t(
                `${info.devices.length} ${info.devices.length === 1 ? "device" : "devices"}`,
                `${info.devices.length} ${info.devices.length > 1 ? "appareils" : "appareil"}`,
              )
        }
      />
      {info.devices.length ? (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t("Device", "Appareil")}</th>
                <th scope="col">{t("Type", "Type")}</th>
                <th scope="col">{t("State", "État")}</th>
                <th scope="col">{t("Last success", "Dernière réussite")}</th>
              </tr>
            </thead>
            <tbody>
              {info.devices.map((d) => {
                const state = stateOf(d, check, lang);
                return (
                  <tr key={`${d.task}-${d.name}`}>
                    <td>
                      <span className="block font-medium">{d.name}</span>
                      {d.os ? <span className="meta">{d.os}</span> : null}
                    </td>
                    <td>{d.type ? TYPE[d.type]?.[lang] : "–"}</td>
                    <td>
                      <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
                    </td>
                    <td>
                      {d.lastSuccessAt
                        ? since(d.lastSuccessAt, now, lang)
                        : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {info.activated === false
            ? t(
                "Installed but not activated: no backup runs.",
                "Installé mais pas activé : aucune sauvegarde ne part.",
              )
            : t("No Active Backup task.", "Aucune tâche Active Backup.")}
        </p>
      )}
    </Card>
  );
}

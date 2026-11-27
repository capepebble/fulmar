import { type Locale, tr } from "@/i18n";
import { bytes } from "@/lib/agents/time";
import type { BzContainerRecord, BzDetails } from "@/lib/beszel/types";
import type { Nas } from "@/lib/fleet/types";
import { formatPct } from "@/lib/format";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import { ContainersCard } from "./containers";

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(120px,200px)_1fr] gap-x-6 gap-y-2.5 px-[18px] py-4 text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="m-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Onglet Système : matériel, DSM et ses mises à jour, paquets, onduleur, réseau, heure,
 * conteneurs lus par l'agent (sinon vus par Beszel). */
export function SystemSection({
  lang,
  nas,
  details,
  containers,
  now,
}: {
  lang: Locale;
  nas: Nas;
  details: BzDetails | null;
  containers: BzContainerRecord | null;
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const ram = nas.ramMb
    ? bytes(nas.ramMb * 1024 * 1024, lang)
    : details?.memory
      ? bytes(details.memory, lang)
      : "–";
  const upd = nas.dsmUpdate;
  const withAgent = nas.agent.kind !== "none";
  const updateText = !upd ? (
    t("Could not read", "Lecture impossible")
  ) : upd.available || upd.major ? (
    <ToneBadge tone="warn">
      {upd.available
        ? t(`${upd.available} available`, `${upd.available} disponible`)
        : t(
            `${upd.major} available (major version)`,
            `${upd.major} disponible (version majeure)`,
          )}
    </ToneBadge>
  ) : upd.checkOk === false ? (
    t("DSM could not ask Synology", "DSM n'a pas pu interroger Synology")
  ) : (
    t("Up to date", "À jour")
  );
  return (
    <>
      {nas.beszel.kind === "missing" ? (
        <div className="card px-[18px] py-3.5 text-[13.5px] text-warn-text">
          {t(
            `System not found in Beszel: the console’s account doesn’t see the system “${nas.beszel.systemId}” named for this NAS. Check the sharing in Beszel or the beszelSystem field.`,
            `Système introuvable dans Beszel : le compte de la console ne voit pas le système « ${nas.beszel.systemId} » désigné pour ce NAS. Vérifier le partage dans Beszel ou le champ beszelSystem.`,
          )}
        </div>
      ) : null}
      <Card labelledBy="materiel">
        <CardHeader id="materiel" title={t("Hardware", "Matériel")} />
        <Facts
          rows={[
            [t("Model", "Modèle"), nas.model],
            [
              t("Processor", "Processeur"),
              details?.cpu
                ? `${details.cpu}${details.cores ? t(`, ${details.cores} cores`, `, ${details.cores} cœurs`) : ""}${details.threads && details.threads !== details.cores ? t(`, ${details.threads} threads`, `, ${details.threads} fils`) : ""}`
                : "–",
            ],
            [t("Memory", "Mémoire"), ram],
            // Temps de marche de l'agent, sinon de Beszel (`vitals`).
            [t("Up for", "Allumé depuis"), nas.vitals.uptime],
            ["Architecture", details?.arch ?? "–"],
          ]}
        />
      </Card>
      {withAgent ? (
        <Card labelledBy="dsm">
          <CardHeader
            id="dsm"
            title={t("DSM and updates", "DSM et mises à jour")}
          />
          <Facts
            rows={[
              ["Version", upd?.current ?? nas.dsm],
              [t("Update", "Mise à jour"), updateText],
              [
                t("Automatic updates", "Mises à jour automatiques"),
                upd?.auto ?? "–",
              ],
              [t("Time zone", "Fuseau"), nas.timeZone],
              [t("UPS", "Onduleur"), nas.ups],
            ]}
          />
        </Card>
      ) : null}
      {nas.packages ? (
        <Card labelledBy="paquets">
          <CardHeader
            id="paquets"
            title={t("Packages", "Paquets")}
            meta={t(
              `${nas.packages.length} installed · ${nas.packages.filter((p) => p.update).length} to update`,
              `${nas.packages.length} installés · ${nas.packages.filter((p) => p.update).length} à mettre à jour`,
            )}
          />
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("Package", "Paquet")}</th>
                  <th scope="col">Version</th>
                  <th scope="col">{t("State", "État")}</th>
                  <th scope="col">{t("Update", "Mise à jour")}</th>
                </tr>
              </thead>
              <tbody>
                {nas.packages.map((p) => (
                  <tr key={p.name}>
                    <td className="font-medium">{p.name}</td>
                    <td>{p.version}</td>
                    <td>
                      {p.running
                        ? t("Running", "En marche")
                        : t("Stopped", "Arrêté")}
                    </td>
                    <td>
                      {p.update ? (
                        <ToneBadge tone={p.security ? "crit" : "warn"}>
                          {p.update}
                          {p.security ? t(" · security", " · sécurité") : ""}
                        </ToneBadge>
                      ) : (
                        <span className="text-fg-3">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {nas.network ? (
        <Card labelledBy="reseau">
          <CardHeader id="reseau" title={t("Network", "Réseau")} />
          <Facts
            rows={[
              [t("Gateway", "Passerelle"), nas.network.gateway ?? "–"],
              ["DNS", nas.network.dns.join(", ") || "–"],
            ]}
          />
          <div className="overflow-x-auto border-border border-t">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Interface</th>
                  <th scope="col">{t("Address", "Adresse")}</th>
                  <th scope="col">{t("Link", "Lien")}</th>
                </tr>
              </thead>
              <tbody>
                {nas.network.interfaces.map((i) => (
                  <tr key={i.name}>
                    <td className="font-medium">{i.name}</td>
                    <td>{i.address ?? "–"}</td>
                    <td>
                      {i.connected === false
                        ? t("Disconnected", "Déconnectée")
                        : i.speedMbps
                          ? `${i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gb/s` : `${i.speedMbps} Mb/s`}`
                          : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {nas.containers?.length ? (
        <ContainersCard
          lang={lang}
          containers={nas.containers}
          checks={nas.checks}
          now={now}
        />
      ) : containers?.stats.length ? (
        <Card labelledBy="conteneurs">
          <CardHeader
            id="conteneurs"
            title={t("Containers", "Conteneurs")}
            meta={t("seen by Beszel", "vus par Beszel")}
          />
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("Container", "Conteneur")}</th>
                  <th scope="col">{t("Processor", "Processeur")}</th>
                  <th scope="col">{t("Memory", "Mémoire")}</th>
                </tr>
              </thead>
              <tbody>
                {containers.stats.map((c) => (
                  <tr key={c.n}>
                    <td className="font-medium">{c.n}</td>
                    <td>{formatPct(c.c ?? null, lang, 1)}</td>
                    <td>
                      {c.m != null ? bytes(c.m * 1024 * 1024, lang) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

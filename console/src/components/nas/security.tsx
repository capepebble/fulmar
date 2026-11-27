import { type Locale, type Texts, tr } from "@/i18n";
import type { Nas, SettingState } from "@/lib/fleet/types";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";
import type { Tone } from "../ui/tone";
import { SynologyCard } from "./synology";

const SETTING_TONE: Record<SettingState, Tone | null> = {
  ok: "ok",
  warning: "warn",
  failed: "crit",
  unknown: "off",
  neutral: null,
};
const SETTING_WORD: Record<SettingState, Texts> = {
  ok: { en: "OK", fr: "OK" },
  warning: { en: "Warning", fr: "À surveiller" },
  failed: { en: "Failed", fr: "En échec" },
  unknown: { en: "Unknown", fr: "Inconnu" },
  neutral: { en: "", fr: "" },
};

/** Onglet Sécurité : réglages, Security Advisor, certificats, comptes. */
export function SecuritySection({
  nas,
  lang,
  now,
}: {
  nas: Nas;
  lang: Locale;
  now: Date;
}) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const a = nas.advisor;
  return (
    <>
      <Card labelledBy="reglages">
        <CardHeader id="reglages" title={t("Settings", "Réglages")} />
        {nas.security.length ? (
          nas.security.map((s) => {
            const tone = SETTING_TONE[s.state];
            return (
              <div key={s.label} className="row justify-between">
                <span className="font-medium">{s.label}</span>
                <span className="flex items-center gap-3">
                  <span className="text-fg-2">{s.value}</span>
                  {tone ? (
                    <ToneBadge tone={tone}>
                      {SETTING_WORD[s.state][lang]}
                    </ToneBadge>
                  ) : null}
                </span>
              </div>
            );
          })
        ) : (
          <p className="m-0 px-[18px] py-4 text-fg-2">
            {t("Settings not read.", "Réglages non lus.")}
          </p>
        )}
      </Card>
      {nas.synology ? (
        <SynologyCard lang={lang} info={nas.synology} now={now} />
      ) : null}
      <Card labelledBy="advisor">
        <CardHeader
          id="advisor"
          title="Security Advisor"
          meta={t(
            `${a.group} · last scan ${a.lastRun}`,
            `${a.group} · dernière analyse ${a.lastRun}`,
          )}
        />
        <div className="grid grid-cols-3 gap-4 px-[18px] py-4">
          {[
            [t("Passed", "Réussies"), a.passed],
            [t("Failed", "En échec"), a.failed],
            [t("Skipped", "Ignorées"), a.skipped],
          ].map(([label, n]) => (
            <div key={label} className="flex flex-col">
              <span className="meta">{label}</span>
              <span className="font-semibold text-[20px]">{n}</span>
            </div>
          ))}
        </div>
        {a.failedRules.map((r) => (
          <div key={r.title} className="row justify-between">
            <span>{r.title}</span>
            <span className="meta">{r.area}</span>
          </div>
        ))}
      </Card>
      {nas.certificates.length ? (
        <Card labelledBy="certificats">
          <CardHeader
            id="certificats"
            title={t("Certificates", "Certificats")}
          />
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("Name", "Nom")}</th>
                  <th scope="col">{t("Issuer", "Émetteur")}</th>
                  <th scope="col">{t("Expires", "Expire le")}</th>
                  <th scope="col">Services</th>
                </tr>
              </thead>
              <tbody>
                {nas.certificates.map((c) => (
                  <tr key={`${c.name}-${c.until}`}>
                    <td className="font-medium">
                      {c.name}
                      {c.isDefault ? (
                        <span className="tag ml-2">
                          {t("default", "par défaut")}
                        </span>
                      ) : null}
                    </td>
                    <td>{c.issuer}</td>
                    <td
                      className={
                        c.days < 0 ? "t-crit" : c.days < 30 ? "t-warn" : ""
                      }
                    >
                      {c.until} (
                      {c.days < 0
                        ? t("expired", "expiré")
                        : t(`${c.days} d`, `${c.days} j`)}
                      )
                    </td>
                    <td>{c.services}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {nas.accounts.length ? (
        <Card labelledBy="comptes">
          <CardHeader id="comptes" title={t("Accounts", "Comptes")} />
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t("Account", "Compte")}</th>
                  <th scope="col">{t("Role", "Rôle")}</th>
                  <th scope="col">{t("State", "État")}</th>
                  <th scope="col">
                    {t("Two-factor authentication", "Double authentification")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {nas.accounts.map((c) => (
                  <tr key={c.name}>
                    <td className="font-medium">{c.name}</td>
                    <td>{c.role}</td>
                    <td>{c.state}</td>
                    <td>{c.twoFactor ? t("On", "Activée") : t("No", "Non")}</td>
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

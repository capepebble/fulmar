"use client";

import { QrCode, Smartphone } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { forgetPhone, pairPhone, phonesOf } from "@/app/actions";
import { type Locale, tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import type { PairingOffer, PhonesOk, PhonesView } from "@/lib/agents/phones";
import { qrPath } from "@/lib/agents/phones";
import { formatClock, formatDate, formatDateTime } from "@/lib/agents/time";
import { plural } from "@/lib/format";
import { ToneBadge } from "../ui/badge";
import { Card, CardHeader } from "../ui/card";

const POLL_MS = 3_000;
const MARGIN = 4;

/** Le QR code, sombre sur clair dans les deux thèmes : c'est ce que lisent les appareils photo.
 * Seule exception aux jetons de couleur de la console. */
function Qr({ modules }: { modules: string[] }) {
  const size = modules.length + 2 * MARGIN;
  const lang = useLocale();
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={232}
      height={232}
      role="img"
      aria-label={tr(lang, {
        en: "Pairing QR code",
        fr: "QR code d'appairage",
      })}
      shapeRendering="crispEdges"
      className="rounded-[8px] border border-[var(--border)]"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={qrPath(modules, MARGIN)} fill="#000000" />
    </svg>
  );
}

function relayLine(view: PhonesOk, lang: Locale): string {
  const r = view.relay;
  if (r.joined)
    return tr(lang, {
      en: `Through the relay: ${r.host ?? "joined"}.`,
      fr: `Par le relais : ${r.host ?? "inscrit"}.`,
    });
  if (r.configured)
    return tr(lang, {
      en: "Relay configured but agent not joined: run nas-agent relay join on the NAS.",
      fr: "Relais configuré mais agent non inscrit : lancer nas-agent relay join sur le NAS.",
    });
  return tr(lang, {
    en: "No relay: direct reading only, on the tailnet or the local network.",
    fr: "Sans relais : lecture directe seulement, sur le tailnet ou le réseau local.",
  });
}

/** Onglet Téléphones : appairer par QR code, voir et retirer les téléphones appairés. */
export function PhonesSection({
  nasId,
  live,
  initial,
  tz,
  nowIso,
}: {
  nasId: string;
  live: boolean;
  initial: PhonesView;
  tz: string;
  nowIso: string;
}) {
  const [view, setView] = useState<PhonesView>(initial);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date(nowIso));
  const [pending, startTransition] = useTransition();
  const known = useRef<Set<string>>(new Set());
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });

  // Pendant qu'un QR code est affiché : relire les téléphones, repérer le nouveau, masquer le
  // code à son échéance.
  useEffect(() => {
    if (!offer) return;
    const expires = Date.parse(offer.expiresAt);
    const id = window.setInterval(async () => {
      setNow(new Date());
      if (Date.now() >= expires) {
        setOffer(null);
        return;
      }
      const next = await phonesOf(nasId, lang);
      if (next.kind !== "ok") return;
      setView(next);
      const fresh = next.phones.find((p) => !known.current.has(p.id));
      if (fresh) {
        setPaired(fresh.name);
        setOffer(null);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [offer, nasId, lang]);

  function open() {
    setError(null);
    setPaired(null);
    known.current = new Set(
      view.kind === "ok" ? view.phones.map((p) => p.id) : [],
    );
    startTransition(async () => {
      const result = await pairPhone(nasId, lang);
      if (result.ok) {
        setOffer(result.offer);
        setNow(new Date());
      } else {
        setError(result.reason);
      }
    });
  }

  function revoke(deviceId: string) {
    setError(null);
    setPaired(null);
    startTransition(async () => {
      const result = await forgetPhone(nasId, deviceId, lang);
      setConfirming(null);
      if (!result.ok)
        setError(
          result.reason ??
            t("Removal refused by the agent.", "Retrait refusé par l'agent."),
        );
      const next = await phonesOf(nasId, lang);
      if (next.kind === "ok") setView(next);
    });
  }

  if (view.kind !== "ok") {
    return (
      <Card labelledBy="telephones">
        <CardHeader id="telephones" title={t("Phones", "Téléphones")} />
        <p className="m-0 px-[18px] py-4 text-fg-2">{view.reason}</p>
      </Card>
    );
  }

  const minutes = offer
    ? Math.max(
        0,
        Math.ceil((Date.parse(offer.expiresAt) - now.getTime()) / 60_000),
      )
    : 0;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[repeat(auto-fit,minmax(340px,1fr))]">
      <Card labelledBy="appairer">
        <CardHeader
          id="appairer"
          title={t("Pair a phone", "Appairer un téléphone")}
          meta={t(
            "10-minute code, single use",
            "code de 10 minutes, à usage unique",
          )}
        />
        <div className="flex flex-col gap-3 px-[18px] py-4">
          {offer ? (
            <>
              <Qr modules={offer.modules} />
              <p className="m-0 text-fg-2">
                {t(
                  `Valid until ${formatClock(offer.expiresAt, tz, lang)}, ${plural(minutes, "minute", "minutes", lang)} left. Show it only to the phone to pair: it opens reading of this NAS.`,
                  `Valable jusqu'à ${formatClock(offer.expiresAt, tz, lang)}, encore ${plural(minutes, "minute", "minutes", lang)}. Ne le montrer qu'au téléphone à appairer : il ouvre la lecture de ce NAS.`,
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={open}
                  disabled={pending}
                >
                  {t("New code", "Nouveau code")}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOffer(null)}
                >
                  {t("Hide", "Masquer")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="m-0 text-fg-2">
                {t(
                  "In the app, tap “Pair” and scan the QR code. Phones already paired are told of every new pairing.",
                  "Dans l'appli, toucher « Appairer » et scanner le QR code. Les téléphones déjà appairés sont prévenus de chaque nouvel appairage.",
                )}
              </p>
              <p className="meta m-0">{relayLine(view, lang)}</p>
              <p className="meta m-0">
                {view.relay.directUrls.length
                  ? t(
                      `Direct: ${view.relay.directUrls.join(", ")}`,
                      `En direct : ${view.relay.directUrls.join(", ")}`,
                    )
                  : t(
                      "No direct reading address.",
                      "Aucune adresse de lecture directe.",
                    )}
              </p>
              {live ? (
                <div>
                  <button
                    type="button"
                    className="btn"
                    onClick={open}
                    disabled={pending}
                  >
                    <QrCode className="icon" aria-hidden="true" />
                    {t("Show the QR code", "Afficher le QR code")}
                  </button>
                </div>
              ) : (
                <p className="meta m-0">
                  {t(
                    "Fictitious NAS: no pairing.",
                    "NAS fictif : pas d'appairage.",
                  )}
                </p>
              )}
            </>
          )}
          {paired ? (
            <p className="m-0 flex items-center gap-2" aria-live="polite">
              <ToneBadge tone="ok">{t("Paired", "Appairé")}</ToneBadge>
              {t(
                `Phone “${paired}” paired.`,
                `Téléphone « ${paired} » appairé.`,
              )}
            </p>
          ) : null}
          {error ? (
            <p className="m-0 text-fg-2" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Card>
      <Card labelledBy="appaires">
        <CardHeader
          id="appaires"
          title={t("Paired phones", "Téléphones appairés")}
          meta={
            lang === "en"
              ? plural(view.phones.length, "phone", "phones", lang)
              : plural(view.phones.length, "téléphone", "téléphones", lang)
          }
        />
        {view.phones.length === 0 ? (
          <p className="m-0 px-[18px] py-4 text-fg-2">
            {t("No paired phone.", "Aucun téléphone appairé.")}
          </p>
        ) : (
          view.phones.map((phone) => (
            <div key={phone.id} className="row justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Smartphone
                  className="icon shrink-0 text-fg-3"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{phone.name}</span>
                  <span className="meta">
                    {phone.via === "relay"
                      ? t("through the relay", "par le relais")
                      : t("direct", "en direct")}{" "}
                    ·{" "}
                    {t(
                      `paired ${formatDate(phone.pairedAt, now, tz, lang)}`,
                      `appairé ${formatDate(phone.pairedAt, now, tz, lang)}`,
                    )}
                    {phone.lastReadAt
                      ? t(
                          ` · read directly ${formatDateTime(phone.lastReadAt, now, tz, lang)}`,
                          ` · lu en direct ${formatDateTime(phone.lastReadAt, now, tz, lang)}`,
                        )
                      : ""}
                  </span>
                </div>
              </div>
              {live ? (
                confirming === phone.id ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => revoke(phone.id)}
                      disabled={pending}
                    >
                      {t("Confirm removal", "Confirmer le retrait")}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setConfirming(null)}
                    >
                      {t("Cancel", "Annuler")}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn shrink-0"
                    onClick={() => setConfirming(phone.id)}
                    aria-label={t(
                      `Remove ${phone.name}`,
                      `Retirer ${phone.name}`,
                    )}
                  >
                    {t("Remove", "Retirer")}
                  </button>
                )
              ) : null}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type Texts, tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import type { CertificateResult } from "@/lib/agents/setup";
import { Field } from "../ui/field";

// Relier un agent à un DSM, en trois étapes : l'adresse, le certificat confirmé, le compte de
// service. À l'installation, le NAS du projet ; dans le parc, un NAS ajouté au hub
// (conception 2026-11-26-parc-du-moteur).

type Step = "address" | "certificate" | "account" | "done";

export type LinkResult =
  | { ok: true; id?: string }
  | { ok: false; error: Texts; code?: string };

export type WizardMode = "setup" | "add";

/** « AB:CD:… » en quatre lignes de huit octets : l'empreinte se compare d'un coup d'œil. */
function fingerprintLines(fp: string): string[] {
  const bytes = fp.toUpperCase().match(/.{2}/g) ?? [];
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 8)
    lines.push(bytes.slice(i, i + 8).join(":"));
  return lines;
}

export function DsmWizard({
  mode,
  host,
  port,
  readCertificate: certificateAction,
  link: linkAction,
}: {
  mode: WizardMode;
  host: string;
  port: number;
  readCertificate: (form: FormData) => Promise<CertificateResult>;
  link: (form: FormData) => Promise<LinkResult>;
}) {
  const router = useRouter();
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const adding = mode === "add";
  const [step, setStep] = useState<Step>("address");
  const [address, setAddress] = useState({
    host,
    port: String(port),
    serverName: "",
  });
  const [certificate, setCertificate] = useState<{
    fingerprint: string;
    verifies: boolean;
  } | null>(null);
  const [needOtp, setNeedOtp] = useState(false);
  const [error, setError] = useState<Texts | null>(null);
  const [busy, start] = useTransition();

  function addressForm(form: FormData) {
    form.set("host", address.host);
    form.set("port", address.port);
    form.set("server_name", address.serverName);
    return form;
  }

  function readCertificate() {
    setError(null);
    start(async () => {
      const result = await certificateAction(addressForm(new FormData()));
      if (!result.ok) return setError(result.error);
      setCertificate(result);
      setStep("certificate");
    });
  }

  function enroll(form: FormData) {
    setError(null);
    addressForm(form);
    form.set("fingerprint", certificate?.fingerprint ?? "");
    start(async () => {
      const result = await linkAction(form);
      if (result.ok) {
        setStep("done");
        // L'agent passe en marche normale (ou démarre le NAS ajouté), puis fait sa première
        // lecture.
        const next = adding && result.id ? `/nas/${result.id}` : "/";
        setTimeout(() => router.replace(next), adding ? 1500 : 2500);
        return;
      }
      if (result.code === "otp_required") {
        setNeedOtp(true);
        return setError({
          en: "DSM asks for the two-factor code.",
          fr: "DSM demande le code de double authentification.",
        });
      }
      if (result.code === "certificate_changed") {
        setCertificate(null);
        setStep("address");
      }
      setError(result.error);
    });
  }

  const errorLine = error ? (
    <p role="alert" className="m-0 text-[14px] text-crit-text">
      {error[lang]}
    </p>
  ) : null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-bold text-[28px] tracking-[-0.02em]">
          {adding
            ? t("Add a NAS", "Ajouter un NAS")
            : t("Link the agent to DSM", "Relier l'agent à DSM")}
        </h1>
        <p className="m-0 text-[15px] text-fg-2">
          {adding
            ? t(
                "This hub reads the NAS through the service account you created in its DSM, with nothing to install on it. It changes nothing but the updates and access closings you ask for.",
                "Ce hub lit le NAS par le compte de service que vous avez créé dans son DSM, sans rien installer dessus. Il n'y change rien, sauf les mises à jour et les fermetures d'accès que vous demandez.",
              )
            : t(
                "The agent reads this NAS through the service account you created in DSM. It changes nothing but the updates and access closings you ask for.",
                "L'agent lit ce NAS par le compte de service que vous avez créé dans DSM. Il n'y change rien, sauf les mises à jour et les fermetures d'accès que vous demandez.",
              )}
        </p>
      </div>

      <ol className="m-0 flex list-none gap-2 p-0 text-[12.5px] text-fg-3">
        {(["address", "certificate", "account"] as const).map((s, i) => (
          <li
            key={s}
            className={
              step === s || (step === "done" && s === "account")
                ? "font-semibold text-fg"
                : undefined
            }
          >
            {i + 1}.{" "}
            {
              (lang === "en"
                ? ["Address", "Certificate", "Account"]
                : ["Adresse", "Certificat", "Compte"])[i]
            }
          </li>
        ))}
      </ol>

      {step === "address" ? (
        <form
          action={readCertificate}
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            readCertificate();
          }}
        >
          <Field
            label={
              adding
                ? t(
                    "NAS address on your network",
                    "Adresse du NAS sur votre réseau",
                  )
                : t(
                    "DSM address, as the agent sees it",
                    "Adresse de DSM, vue de l'agent",
                  )
            }
            value={address.host}
            onChange={(e) => setAddress({ ...address, host: e.target.value })}
            placeholder={adding ? "192.168.1.20" : undefined}
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={adding}
            hint={
              adding
                ? t(
                    "Its IP address or its name. If its firewall is on, it must let this hub reach DSM's HTTPS port.",
                    "Son adresse IP ou son nom. Si son pare-feu est actif, il doit laisser ce hub joindre le port HTTPS de DSM.",
                  )
                : t(
                    "Already filled in: this is this NAS, seen from the project.",
                    "Déjà remplie : c'est ce NAS, vu du projet.",
                  )
            }
            required
          />
          <Field
            label={t("DSM HTTPS port", "Port HTTPS de DSM")}
            inputMode="numeric"
            value={address.port}
            onChange={(e) => setAddress({ ...address, port: e.target.value })}
            required
          />
          <Field
            label={t(
              "DSM certificate name (optional)",
              "Nom du certificat de DSM (facultatif)",
            )}
            value={address.serverName}
            onChange={(e) =>
              setAddress({ ...address, serverName: e.target.value })
            }
            placeholder={t("nas.example.com", "nas.exemple.fr")}
            hint={
              adding
                ? t(
                    "Only if DSM has a certificate in its name; otherwise this hub keeps the certificate's fingerprint.",
                    "Seulement si DSM a un certificat à son nom ; sinon, ce hub retient l'empreinte du certificat.",
                  )
                : t(
                    "Only if DSM has a certificate in its name; otherwise the agent keeps the certificate's fingerprint.",
                    "Seulement si DSM a un certificat à son nom ; sinon, l'agent retient l'empreinte du certificat.",
                  )
            }
          />
          {errorLine}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy
              ? t("Reading the certificate…", "Lecture du certificat…")
              : t("Read the certificate", "Lire le certificat")}
          </button>
        </form>
      ) : null}

      {step === "certificate" && certificate ? (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-[15px]">
            {certificate.verifies
              ? adding
                ? t(
                    `The certificate is valid for ${address.serverName}: this hub will trust it.`,
                    `Le certificat se vérifie pour ${address.serverName} : ce hub s'y fiera.`,
                  )
                : t(
                    `The certificate is valid for ${address.serverName}: the agent will trust it.`,
                    `Le certificat se vérifie pour ${address.serverName} : l'agent s'y fiera.`,
                  )
              : adding
                ? t(
                    "The NAS presents this certificate. This hub will talk only to it: if it changes one day, you will confirm it again.",
                    "Le NAS présente ce certificat. Ce hub ne parlera qu'à lui : s'il change un jour, il faudra le confirmer de nouveau.",
                  )
                : t(
                    "DSM presents this certificate. The agent will talk only to it: if it changes one day, you will confirm it again.",
                    "DSM présente ce certificat. L'agent ne parlera qu'à lui : s'il change un jour, il faudra le confirmer de nouveau.",
                  )}
          </p>
          <div className="card px-[18px] py-3.5">
            <p className="meta m-0 mb-1.5">
              {t("SHA-256 fingerprint", "Empreinte SHA-256")}
            </p>
            <code className="block font-mono text-[13px] leading-[1.6]">
              {fingerprintLines(certificate.fingerprint).map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </code>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep("account")}
            >
              {t("This is my NAS", "C'est bien mon NAS")}
            </button>
            <button
              type="button"
              className="btn justify-center"
              onClick={() => setStep("address")}
            >
              {t("Change the address", "Changer d'adresse")}
            </button>
          </div>
        </div>
      ) : null}

      {step === "account" ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            enroll(new FormData(e.currentTarget));
          }}
        >
          <Field
            label={t("Service account", "Compte de service")}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="fulmar"
            hint={t(
              "Name it fulmar, with this description in DSM: “Fulmar: reads this NAS, may update its packages and DSM, and close SSH. Deleting this account cuts Fulmar.”",
              "Nommez-le fulmar, avec cette description dans DSM : « Fulmar : lit ce NAS, peut mettre à jour ses paquets et DSM, et fermer SSH. Supprimer ce compte coupe Fulmar. »",
            )}
            required
          />
          <Field
            label={t("Account password", "Mot de passe du compte")}
            name="password"
            type="password"
            autoComplete="current-password"
            hint={
              adding
                ? t(
                    "Kept by the hub's agent alone, in a private file on its volume; never by the console.",
                    "Gardé par l'agent du hub seul, dans un fichier privé de son volume ; jamais par la console.",
                  )
                : t(
                    "Kept by the agent alone, in a private file on its volume; never by the console.",
                    "Gardé par l'agent seul, dans un fichier privé de son volume ; jamais par la console.",
                  )
            }
            required
          />
          {needOtp ? (
            <Field
              label={t("Two-factor code", "Code de double authentification")}
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          ) : null}
          {errorLine}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy
              ? t("Signing in to DSM…", "Connexion à DSM…")
              : adding
                ? t("Add this NAS", "Ajouter ce NAS")
                : t("Link the agent", "Relier l'agent")}
          </button>
        </form>
      ) : null}

      {step === "done" ? (
        <output className="block text-[15px]">
          {adding
            ? t(
                "The NAS is in the fleet. First reading…",
                "Le NAS est dans le parc. Première lecture…",
              )
            : t(
                "The agent is linked to DSM. First reading of the NAS…",
                "L'agent est relié à DSM. Première lecture du NAS…",
              )}
        </output>
      ) : null}
    </>
  );
}

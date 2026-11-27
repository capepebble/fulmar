import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { DsmWizard } from "@/components/setup/dsm-wizard";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { localSetupStatus } from "@/lib/agents/setup";
import { addNasAction, fleetCertificateAction } from "./actions";

// Ajouter un NAS au hub (conception 2026-11-26-parc-du-moteur) : dans le moteur seulement,
// une fois le NAS du hub relié à DSM.

type Props = { params: Promise<{ lang: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Add a NAS", fr: "Ajouter un NAS" }) };
}

async function Add({ lang }: { lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const status = await localSetupStatus();
  if (status.kind === "waiting") redirect("/setup");
  if (status.kind === "none")
    return (
      <p className="m-0 text-[15px] text-fg-2">
        {t(
          "This console has no project agent: its NAS are declared in agents.json.",
          "Cette console n'a pas d'agent de projet : ses NAS se déclarent dans agents.json.",
        )}
      </p>
    );
  if (status.kind === "unreachable")
    return (
      <>
        <p className="m-0 text-[15px] text-fg-2">
          {t(
            `The hub's agent is not answering: ${status.reason.en}.`,
            `L'agent du hub ne répond pas : ${status.reason.fr}.`,
          )}
        </p>
        <Link href="/nas/add" className="btn btn-primary">
          {t("Try again", "Réessayer")}
        </Link>
      </>
    );
  return (
    <DsmWizard
      mode="add"
      host=""
      port={5001}
      readCertificate={fleetCertificateAction}
      link={addNasAction}
    />
  );
}

export default async function AddNas({ params }: Props) {
  const lang = await pageLocale(params);
  return (
    <div className="flex w-full max-w-[480px] flex-col gap-6">
      <Suspense
        fallback={
          <p className="meta m-0">
            {tr(lang, {
              en: "Reading the hub's agent…",
              fr: "Lecture de l'agent du hub…",
            })}
          </p>
        }
      >
        <Add lang={lang} />
      </Suspense>
    </div>
  );
}

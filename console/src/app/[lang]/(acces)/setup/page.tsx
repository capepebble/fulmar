import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { DsmWizard } from "@/components/setup/dsm-wizard";
import { type Locale, tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { localSetupStatus } from "@/lib/agents/setup";
import { certificateAction, enrollAction } from "./actions";

type Props = { params: Promise<{ lang: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Setup", fr: "Installation" }) };
}

async function Setup({ lang }: { lang: Locale }) {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const status = await localSetupStatus();
  if (status.kind === "enrolled" || status.kind === "none") redirect("/");
  if (status.kind === "unreachable")
    return (
      <>
        <h1 className="m-0 font-bold text-[28px] tracking-[-0.02em]">
          {t("Setup", "Installation")}
        </h1>
        <p className="m-0 text-[15px] text-fg-2">
          {t(
            `The agent is not answering yet: ${status.reason.en}. If it just started, try again in a moment.`,
            `L'agent ne répond pas encore : ${status.reason.fr}. S'il vient de démarrer, réessayez dans un instant.`,
          )}
        </p>
        <Link href="/setup" className="btn btn-primary">
          {t("Try again", "Réessayer")}
        </Link>
      </>
    );
  return (
    <DsmWizard
      mode="setup"
      host={status.host}
      port={status.port}
      readCertificate={certificateAction}
      link={enrollAction}
    />
  );
}

export default async function Installation({ params }: Props) {
  const lang = await pageLocale(params);
  return (
    <Suspense
      fallback={
        <p className="meta m-0">
          {tr(lang, { en: "Reading the agent…", fr: "Lecture de l'agent…" })}
        </p>
      }
    >
      <Setup lang={lang} />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { AccessForm, Field, PlainHttpNotice } from "../access-form";
import { welcome } from "../actions";

type Props = { params: Promise<{ lang: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Welcome", fr: "Bienvenue" }) };
}

export default async function Welcome({ params }: Props) {
  const lang = await pageLocale(params);
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-bold text-[28px] tracking-[-0.02em]">
          {t("Welcome", "Bienvenue")}
        </h1>
        <p className="m-0 text-[15px] text-fg-2">
          {t(
            "Choose this console's password. To prove you administer this NAS, first enter the install code: it is in the console log (Container Manager, Project, Log).",
            "Choisissez le mot de passe de cette console. Pour prouver que vous administrez ce NAS, saisissez d'abord le code d'installation : il est dans le journal de la console (Container Manager, Projet, Journal).",
          )}
        </p>
      </div>
      <AccessForm
        action={welcome}
        submit={t("Choose this password", "Choisir ce mot de passe")}
        pending={t("One moment…", "Un instant…")}
      >
        <Field
          label={t("Install code", "Code d'installation")}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="12345 67890"
          required
        />
        <Field
          label={t("Password", "Mot de passe")}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          hint={t("At least 12 characters.", "12 caractères au moins.")}
          required
        />
        <Field
          label={t("The same, once more", "Le même, une seconde fois")}
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </AccessForm>
      <PlainHttpNotice />
    </>
  );
}

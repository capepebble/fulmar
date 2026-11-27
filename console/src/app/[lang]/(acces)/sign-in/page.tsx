import type { Metadata } from "next";
import { Suspense } from "react";
import { tr } from "@/i18n";
import { pageLocale } from "@/i18n/locales";
import { AccessForm, Field, PlainHttpNotice } from "../access-form";
import { signIn } from "../actions";

type Props = {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  params,
}: Pick<Props, "params">): Promise<Metadata> {
  const lang = await pageLocale(params);
  return { title: tr(lang, { en: "Sign in", fr: "Connexion" }) };
}

async function Next({ search }: { search: Props["searchParams"] }) {
  const next = (await search).next;
  return (
    <input
      type="hidden"
      name="next"
      value={typeof next === "string" ? next : "/"}
    />
  );
}

export default async function SignIn({ params, searchParams }: Props) {
  const lang = await pageLocale(params);
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <>
      <h1 className="m-0 font-bold text-[28px] tracking-[-0.02em]">
        {t("Sign in", "Connexion")}
      </h1>
      <AccessForm
        action={signIn}
        submit={t("Sign in", "Se connecter")}
        pending={t("One moment…", "Un instant…")}
      >
        <Suspense fallback={null}>
          <Next search={searchParams} />
        </Suspense>
        <Field
          label={t("Password", "Mot de passe")}
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
        />
      </AccessForm>
      <PlainHttpNotice />
    </>
  );
}

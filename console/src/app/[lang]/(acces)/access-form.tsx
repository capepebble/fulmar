"use client";

import { useActionState, useEffect, useState } from "react";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import type { FormState } from "./actions";

/** Le formulaire d'une page d'accès : champs, erreur lue à voix haute, un seul bouton. */
export function AccessForm({
  action,
  submit,
  pending,
  children,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submit: string;
  pending: string;
  children: React.ReactNode;
}) {
  const lang = useLocale();
  const [state, run, busy] = useActionState(action, {});
  return (
    <form action={run} className="flex flex-col gap-4">
      {children}
      {state.error ? (
        <p role="alert" className="m-0 text-[14px] text-crit-text">
          {state.error[lang]}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? pending : submit}
      </button>
    </form>
  );
}

export { Field } from "@/components/ui/field";

/** Sur le réseau local sans HTTPS, le dire : le mot de passe passe en clair. */
export function PlainHttpNotice() {
  const lang = useLocale();
  const [plain, setPlain] = useState(false);
  useEffect(() => setPlain(window.location.protocol === "http:"), []);
  if (!plain) return null;
  return (
    <p className="meta m-0">
      {tr(lang, {
        en: "Unencrypted connection: on a network you do not control, open the console over HTTPS, through DSM's reverse proxy.",
        fr: "Connexion non chiffrée : sur un réseau que vous ne maîtrisez pas, ouvrez la console en HTTPS, par le proxy inversé de DSM.",
      })}
    </p>
  );
}

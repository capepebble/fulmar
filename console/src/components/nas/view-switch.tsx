"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { type Texts, tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import { VIEW_COOKIE, type View } from "@/lib/view";

const VIEWS: { id: View; label: Texts }[] = [
  { id: "brief", label: { en: "At a glance", fr: "En bref" } },
  { id: "detail", label: { en: "In detail", fr: "En détail" } },
];

/** En bref ou en détail : le choix change dès l'appui, puis la page se relit sans bouger. */
export function ViewSwitch({ value }: { value: View }) {
  const lang = useLocale();
  const router = useRouter();
  const [shown, setShown] = useState(value);
  const [pending, start] = useTransition();
  useEffect(() => setShown(value), [value]);
  function choose(next: View) {
    if (next === shown) return;
    setShown(next);
    // biome-ignore lint/suspicious/noDocumentCookie: un cookie de préférence, lu par le serveur.
    document.cookie = `${VIEW_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    start(() => router.refresh());
  }
  return (
    <fieldset
      className="seg view-switch m-0 min-w-0 border-0"
      aria-busy={pending || undefined}
    >
      <legend className="sr-only">
        {tr(lang, { en: "Reading", fr: "Lecture" })}
      </legend>
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          className="seg-b"
          aria-pressed={shown === v.id}
          aria-current={shown === v.id ? "true" : undefined}
          onClick={() => choose(v.id)}
        >
          {v.label[lang]}
        </button>
      ))}
    </fieldset>
  );
}

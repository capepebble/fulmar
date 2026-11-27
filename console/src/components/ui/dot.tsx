"use client";

import { useLocale } from "@/i18n/client";
import { NAS_STATE_LABEL, type NasState } from "@/lib/fleet/state";
import type { Status } from "@/lib/fleet/types";
import { STATE_TONE } from "./tone";

/** Pastille d'état, titrée : son mot se lit au survol et par les lecteurs d'écran. */
export function Dot({
  state,
  label,
}: {
  state: NasState | Status;
  label?: string;
}) {
  const lang = useLocale();
  const text = label ?? NAS_STATE_LABEL[state][lang];
  return (
    <span
      className={`dot d-${STATE_TONE[state]}`}
      role="img"
      aria-label={text}
      title={text}
    />
  );
}

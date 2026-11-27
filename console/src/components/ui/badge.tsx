"use client";

import { useLocale } from "@/i18n/client";
import { NAS_STATE_LABEL, type NasState } from "@/lib/fleet/state";
import type { Status } from "@/lib/fleet/types";
import { STATE_TONE, type Tone } from "./tone";

/** Badge d'état : pilule, pastille et mot. */
export function StateBadge({
  state,
  label,
}: {
  state: NasState | Status;
  label?: string;
}) {
  const lang = useLocale();
  return (
    <ToneBadge tone={STATE_TONE[state]}>
      {label ?? NAS_STATE_LABEL[state][lang]}
    </ToneBadge>
  );
}

export function ToneBadge({
  tone,
  children,
  dot = true,
}: {
  tone: Tone;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`b b-${tone}`}>
      {dot ? <span className="b-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

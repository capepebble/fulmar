import {
  Activity,
  CircleHelp,
  Lock,
  type LucideIcon,
  Unplug,
  WifiOff,
} from "lucide-react";
import type { BriefTone, Verdict } from "@/lib/fleet/brief";
import { greenShare } from "@/lib/fleet/lights";
import type { NasState } from "@/lib/fleet/state";
import type { Nas } from "@/lib/fleet/types";
import { cn } from "@/lib/format";
import type { View } from "@/lib/view";
import { Ring } from "../ui/ring";
import { ViewSwitch } from "./view-switch";

export const TONE_TEXT: Record<BriefTone | "neutral", string> = {
  crit: "text-crit-text",
  warn: "text-warn-text",
  ok: "",
  off: "text-fg-2",
  neutral: "",
};

export const TONE_DISC: Record<BriefTone | "neutral", string> = {
  crit: "bg-crit-bg text-crit-text",
  warn: "bg-warn-bg text-warn-text",
  ok: "bg-ok-bg text-ok-text",
  off: "bg-off-bg text-off-text",
  neutral: "bg-surface-2 text-fg-2",
};

const STATE_ICON: Partial<Record<NasState, LucideIcon>> = {
  offline: WifiOff,
  denied: Lock,
  agent_down: Unplug,
  beszel_only: Activity,
};

/** Le haut de la synthèse, le même en bref et en détail : l'anneau (ou l'état quand les
 * contrôles ne sont pas lus), le verdict en une phrase, et le choix de la lecture. */
export function VerdictHead({
  nas,
  verdict,
  view,
}: {
  nas: Nas;
  verdict: Verdict;
  view: View;
}) {
  const { ok, total } = greenShare(nas);
  const Icon = STATE_ICON[verdict.state] ?? CircleHelp;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3.5 px-[18px] py-4">
      {verdict.ring ? (
        <Ring ok={ok} total={total} size={84} />
      ) : (
        <span
          className={cn(
            "inline-flex size-[84px] flex-none items-center justify-center rounded-full",
            TONE_DISC[verdict.tone],
          )}
          aria-hidden="true"
        >
          <Icon className="size-9" strokeWidth={1.75} />
        </span>
      )}
      <div className="min-w-0 flex-1 basis-[180px]">
        <h2
          className={cn(
            "m-0 font-bold text-[22px] leading-[1.2] tracking-[-0.012em]",
            TONE_TEXT[verdict.tone],
          )}
          id="synthese"
        >
          {verdict.title}
        </h2>
        <p className="m-0 mt-1 text-[13.5px] text-fg-2">{verdict.sub}</p>
      </div>
      <div className="max-md:w-full">
        <ViewSwitch value={view} />
      </div>
    </div>
  );
}

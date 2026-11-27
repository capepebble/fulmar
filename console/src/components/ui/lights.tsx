"use client";

import {
  Archive,
  BadgeCheck,
  BatteryCharging,
  Container,
  Cpu,
  DoorOpen,
  Folder,
  HardDrive,
  type LucideIcon,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import {
  type CategoryLight,
  LIGHT_LABEL,
  LIGHT_WORD,
  type Light,
} from "@/lib/fleet/lights";
import type { CategoryId } from "@/lib/fleet/types";
import { cn } from "@/lib/format";

/** Un pictogramme par catégorie de contrôles (conception 2026-11-24, section 2). */
export const LIGHT_ICON: Record<CategoryId, LucideIcon> = {
  system: Cpu,
  containers: Container,
  backup: Archive,
  storage: HardDrive,
  updates: RefreshCw,
  security_advisor: ShieldCheck,
  access: DoorOpen,
  accounts: Users,
  certificates: BadgeCheck,
  ups: BatteryCharging,
  shares: Folder,
};

const LIGHT_CLASS: Record<Light, string> = {
  failed: "bg-crit-bg text-crit-text",
  warning: "bg-warn-bg text-warn-text",
  ok: "bg-ok-bg text-ok-text",
  unknown: "bg-off-bg text-off-text",
  muted: "text-fg-3 shadow-[inset_0_0_0_1px_var(--border-2)]",
};

/** Un voyant : le pictogramme dans une pastille teintée ; le mot dans l'infobulle et la
 * lecture d'écran, jamais la couleur seule. */
export function LightDot({
  id,
  light,
  size = "sm",
}: {
  id: CategoryId;
  light: Light;
  size?: "sm" | "md";
}) {
  const Icon = LIGHT_ICON[id];
  const lang = useLocale();
  const label = tr(lang, {
    en: `${LIGHT_LABEL[id].en}: ${LIGHT_WORD[light].en}`,
    fr: `${LIGHT_LABEL[id].fr} : ${LIGHT_WORD[light].fr}`,
  });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full",
        size === "sm" ? "size-[22px]" : "size-8",
        LIGHT_CLASS[light],
      )}
    >
      <Icon
        className={size === "sm" ? "size-3" : "size-4"}
        strokeWidth={2}
        aria-hidden="true"
      />
    </span>
  );
}

/** La rangée de voyants d'un NAS, toujours dans le même ordre ; rien pour ce qui n'existe pas. */
export function LightRow({
  lights,
  size = "sm",
  className,
}: {
  lights: CategoryLight[];
  size?: "sm" | "md";
  className?: string;
}) {
  const lang = useLocale();
  if (lights.length === 0)
    return (
      <span className="meta">
        {tr(lang, { en: "No check", fr: "Pas de contrôle" })}
      </span>
    );
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {lights.map((l) => (
        <LightDot key={l.id} id={l.id} light={l.light} size={size} />
      ))}
    </span>
  );
}

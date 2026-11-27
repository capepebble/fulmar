"use client";

import { Command } from "cmdk";
import {
  ArrowRight,
  CircleAlert,
  DatabaseBackup,
  FileText,
  FolderTree,
  LayoutGrid,
  Monitor,
  Moon,
  PackageCheck,
  RefreshCw,
  Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { tr } from "@/i18n";
import { useLocale, usePathname } from "@/i18n/client";
import { issueLevelLabel } from "@/lib/fleet/present";
import { NAS_STATE_LABEL } from "@/lib/fleet/state";
import { cn } from "@/lib/format";
import { useConsole, useFleet, useIssues } from "./console-provider";
import { issueHref, NAS_SECTIONS, nasHref } from "./shell/nav";
import { Dot } from "./ui/dot";
import { STATE_TONE } from "./ui/tone";

const ITEM = cn(
  "flex min-h-10 cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2 text-[13.5px] text-fg-2",
  "data-[selected=true]:bg-hover data-[selected=true]:text-fg",
);

const GROUP = cn(
  "px-2 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5",
  "[&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-fg-3",
);

/** Palette (⌘K ou /) : pages, NAS, sections du NAS ouvert, points à traiter, affichage. */
export function CommandPalette() {
  const fleet = useFleet();
  const issues = useIssues();
  const { paletteOpen, setPaletteOpen, reload } = useConsole();
  const router = useRouter();
  const pathname = usePathname();
  const { setTheme } = useTheme();
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const current = fleet.find(
    (n) =>
      pathname === nasHref(n.id) || pathname.startsWith(`${nasHref(n.id)}/`),
  );

  function go(href: string) {
    setPaletteOpen(false);
    router.push(href);
  }

  function run(action: () => void) {
    setPaletteOpen(false);
    action();
  }

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      label={t(
        "Go to a NAS, a page or an item",
        "Aller à un NAS, une page ou un point",
      )}
      overlayClassName="fixed inset-0 z-50 bg-black/25 dark:bg-black/55"
      contentClassName="fixed inset-x-3 top-[12vh] z-50 mx-auto max-w-[620px] overflow-hidden rounded-[12px] border border-border-2 bg-surface shadow-pop"
    >
      <div className="flex items-center gap-2 border-border border-b px-4">
        <Command.Input
          placeholder={t(
            "Go to a NAS, a page, an item…",
            "Aller à un NAS, une page, un point…",
          )}
          className="h-13 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3"
        />
        <span className="kbd">{t("Esc", "Échap")}</span>
      </div>
      <Command.List className="max-h-[min(60vh,460px)] overflow-y-auto overscroll-contain pb-2">
        <Command.Empty className="px-5 py-8 text-center text-fg-3">
          {t(
            "Nothing matches. Try a NAS name, “backup” or “firewall”.",
            "Rien ne correspond. Essayez un nom de NAS, « sauvegarde » ou « pare-feu ».",
          )}
        </Command.Empty>

        <Command.Group heading={t("Pages", "Pages")} className={GROUP}>
          <Item
            icon={<LayoutGrid className="icon text-fg-3" />}
            hint="0"
            onSelect={() => go("/")}
          >
            {t("Fleet", "Le parc")}
          </Item>
          <Item
            icon={<CircleAlert className="icon text-fg-3" />}
            onSelect={() => go("/issues")}
          >
            {t("To handle", "À traiter")}
          </Item>
          <Item
            icon={<DatabaseBackup className="icon text-fg-3" />}
            onSelect={() => go("/backups")}
          >
            {t("Backups", "Sauvegardes")}
          </Item>
          <Item
            icon={<PackageCheck className="icon text-fg-3" />}
            onSelect={() => go("/updates")}
          >
            {t("Updates", "Mises à jour")}
          </Item>
          <Item
            icon={<FileText className="icon text-fg-3" />}
            onSelect={() => go("/reports")}
          >
            {t("Reports", "Bilans")}
          </Item>
          <Item
            icon={<FolderTree className="icon text-fg-3" />}
            onSelect={() => go("/groups")}
          >
            {t("Groups", "Groupes")}
          </Item>
        </Command.Group>

        <Command.Group heading="NAS" className={GROUP}>
          {fleet.map((nas, i) => (
            <Command.Item
              key={nas.id}
              value={`${nas.name} ${nas.model} ${nas.place} ${nas.folder?.name ?? ""} ${nas.id}`}
              onSelect={() => go(nasHref(nas.id))}
              className={ITEM}
            >
              <Dot state={nas.status} />
              <span className="min-w-0 flex-1 truncate font-medium text-fg">
                {nas.name}
              </span>
              <span className={`text-[12.5px] t-${STATE_TONE[nas.status]}`}>
                {NAS_STATE_LABEL[nas.status][lang]}
              </span>
              {i < 9 ? <span className="kbd">{i + 1}</span> : null}
            </Command.Item>
          ))}
        </Command.Group>

        {current ? (
          <Command.Group heading={current.name} className={GROUP}>
            {NAS_SECTIONS.map((s) => (
              <Command.Item
                key={s.slug}
                value={`${current.name} ${s.label[lang]}`}
                onSelect={() => go(nasHref(current.id, s.slug))}
                className={ITEM}
              >
                <span className="flex-1">{s.label[lang]}</span>
                <ArrowRight className="size-3.5 text-fg-3" aria-hidden="true" />
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {issues.length ? (
          <Command.Group
            heading={t("To handle", "À traiter")}
            className={GROUP}
          >
            {issues.map((issue) => (
              <Command.Item
                key={`${issue.nasId}-${issue.checkId ?? issue.level}`}
                value={`${issue.nasName} ${issue.title} ${issue.checkId ?? ""}`}
                onSelect={() => go(issueHref(issue.nasId, issue.checkId))}
                className={ITEM}
              >
                <span
                  className={`dot d-${issue.level === "warning" || issue.level === "denied" || issue.level === "agent_down" ? "warn" : "crit"}`}
                  role="img"
                  aria-label={issueLevelLabel(issue.level, lang)}
                />
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                <span className="meta">{issue.nasName}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading={t("Display", "Affichage")} className={GROUP}>
          <Item
            icon={<RefreshCw className="icon text-fg-3" />}
            hint="R"
            onSelect={() => run(reload)}
          >
            {t("Read again now", "Relire maintenant")}
          </Item>
          <Item
            icon={<Monitor className="icon text-fg-3" />}
            onSelect={() => run(() => setTheme("system"))}
          >
            {t("System theme", "Thème du système")}
          </Item>
          <Item
            icon={<Sun className="icon text-fg-3" />}
            onSelect={() => run(() => setTheme("light"))}
          >
            {t("Light theme", "Thème clair")}
          </Item>
          <Item
            icon={<Moon className="icon text-fg-3" />}
            onSelect={() => run(() => setTheme("dark"))}
          >
            {t("Dark theme", "Thème sombre")}
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

function Item({
  icon,
  hint,
  children,
  onSelect,
}: {
  icon: ReactNode;
  hint?: string;
  children: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={children} onSelect={onSelect} className={ITEM}>
      {icon}
      <span className="flex-1">{children}</span>
      {hint ? <span className="kbd">{hint}</span> : null}
    </Command.Item>
  );
}

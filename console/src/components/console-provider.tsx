"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { reread } from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import type { IssueLevel } from "@/lib/fleet/issues";
import type { NasState } from "@/lib/fleet/state";

export interface FleetEntry {
  id: string;
  name: string;
  model: string;
  place: string;
  /** Son groupe, s'il est rangé. */
  folder: { id: string; name: string; rank: number } | null;
  /** État de la conception (§ 6). */
  status: NasState;
  /** NAS fictif du parc de démonstration. */
  fictive: boolean;
  /** Points à traiter de ce NAS. */
  issues: number;
}

/** Un point à traiter, pour la palette et la barre latérale. */
export interface IssueEntry {
  nasId: string;
  nasName: string;
  level: IssueLevel;
  title: string;
  checkId: string | null;
}

interface ConsoleContextValue {
  /** Le parc, en promesse : chaque composant qui le lit est sous un `<Suspense>`. */
  fleet: Promise<FleetEntry[]>;
  /** Les points à traiter du parc, dans l'ordre de la page À traiter. */
  issues: Promise<IssueEntry[]>;
  /** Relecture en cours. */
  reading: boolean;
  /** Heure de la dernière relecture faite depuis la console. */
  freshAt: number | null;
  reload: () => void;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function useConsole(): ConsoleContextValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole hors de ConsoleProvider");
  return value;
}

/** Le parc ; suspend tant que la lecture n'est pas arrivée. */
export function useFleet(): FleetEntry[] {
  return use(useConsole().fleet);
}

/** Les points à traiter ; suspend comme le parc. */
export function useIssues(): IssueEntry[] {
  return use(useConsole().issues);
}

// « Lecture… » reste affiché au moins ce temps, même quand la relecture est immédiate.
const MIN_READ = 450;

export function ConsoleProvider({
  fleet,
  issues,
  children,
}: {
  fleet: Promise<FleetEntry[]>;
  issues: Promise<IssueEntry[]>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [reading, setReading] = useState(false);
  const [freshAt, setFreshAt] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const [announce, setAnnounce] = useState("");
  const lang = useLocale();

  // Relire : le serveur oublie ses lectures et la page relit les agents et Beszel.
  const reload = useCallback(() => {
    window.clearTimeout(timer.current);
    startedAt.current = Date.now();
    setReading(true);
    setAnnounce(
      tr(lang, { en: "Reading the fleet again…", fr: "Relecture du parc…" }),
    );
    startRefresh(async () => {
      await reread();
      router.refresh();
    });
  }, [router, lang]);

  useEffect(() => {
    if (!reading || refreshing) return;
    const wait = Math.max(0, MIN_READ - (Date.now() - startedAt.current));
    timer.current = window.setTimeout(() => {
      setReading(false);
      setFreshAt(Date.now());
      setAnnounce(tr(lang, { en: "Read again.", fr: "Relecture terminée." }));
    }, wait);
  }, [reading, refreshing, lang]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ConsoleContext.Provider
      value={{
        fleet,
        issues,
        reading,
        freshAt,
        reload,
        paletteOpen,
        setPaletteOpen,
      }}
    >
      {children}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </ConsoleContext.Provider>
  );
}

/** Raccourcis : 0 le parc, 1 à 9 un NAS dans l'ordre de la liste, / ou ⌘K pour chercher,
 * R pour relire. Aucun ne s'active dans un champ de saisie. */
export function Shortcuts() {
  const fleet = useFleet();
  const { reload, setPaletteOpen } = useConsole();
  const router = useRouter();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key === "0") {
        router.push("/");
      } else if (/^[1-9]$/.test(event.key)) {
        const nas = fleet[Number(event.key) - 1];
        if (nas) router.push(`/nas/${nas.id}`);
      } else if (event.key.toLowerCase() === "r") {
        reload();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fleet, router, reload, setPaletteOpen]);

  return null;
}

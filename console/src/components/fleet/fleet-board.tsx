"use client";

import {
  ChevronDown,
  Columns3,
  Folder,
  LayoutList,
  ListFilter,
  MapPin,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Locale, type Texts, tr } from "@/i18n";
import { useLocale, usePathname } from "@/i18n/client";
import {
  type BoardItem,
  STATE_GROUPS,
  type StateGroup,
} from "@/lib/fleet/board";
import { folderSections } from "@/lib/fleet/folders";
import { LIGHT_LABEL, LIGHT_ORDER } from "@/lib/fleet/lights";
import type { CategoryId } from "@/lib/fleet/types";
import { ago, cn, duration } from "@/lib/format";
import { nasHref } from "../shell/nav";
import { LightDot, LightRow } from "../ui/lights";
import { Meter } from "../ui/meter";
import { Ring } from "../ui/ring";

// La vue du parc (conception 2026-11-24, section 4) : liste ou colonnes, recherche, tri,
// filtres cumulables, regroupement par groupe ou par lieu ; tout est gardé dans l'adresse, sous
// des noms neutres (view, sort, order, state, cause, place, folder, group, q), les mêmes dans
// toutes les langues.

type View = "list" | "columns";
type SortKey = "state" | "name" | "cpu" | "memory" | "volume" | "read";

const SORTS: { id: SortKey; label: Texts }[] = [
  { id: "state", label: { en: "State", fr: "État" } },
  { id: "name", label: { en: "Name", fr: "Nom" } },
  { id: "cpu", label: { en: "Processor", fr: "Processeur" } },
  { id: "memory", label: { en: "Memory", fr: "Mémoire" } },
  { id: "volume", label: { en: "Usage", fr: "Remplissage" } },
  { id: "read", label: { en: "Last read", fr: "Dernière lecture" } },
];

const GROUP_DOT: Record<StateGroup, string> = {
  failed: "d-crit",
  watch: "d-warn",
  unreachable: "d-off",
  ok: "d-ok",
};

/** Sens naturel de chaque tri : le pire ou le plus chargé d'abord, les noms de A à Z. */
const NATURAL_DESC: Record<SortKey, boolean> = {
  state: false,
  name: false,
  cpu: true,
  memory: true,
  volume: true,
  read: true,
};

function list(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

function compare(a: BoardItem, b: BoardItem, key: SortKey): number {
  const num = (x: number | null) => (x === null ? -1 : x);
  switch (key) {
    case "state":
      return a.rank - b.rank || a.name.localeCompare(b.name);
    case "name":
      return a.name.localeCompare(b.name);
    case "cpu":
      return num(a.cpu) - num(b.cpu);
    case "memory":
      return num(a.ram) - num(b.ram);
    case "volume":
      return num(a.volume) - num(b.volume);
    case "read":
      return (a.readAt ?? "").localeCompare(b.readAt ?? "");
  }
}

function minutesSince(at: string | null, now: number): number | null {
  if (!at) return null;
  return Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
}

export function FleetBoard({ items }: { items: BoardItem[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = useRef<HTMLInputElement>(null);
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });

  const view: View = params.get("view") === "columns" ? "columns" : "list";
  const sort = (SORTS.find((s) => s.id === params.get("sort"))?.id ??
    "state") as SortKey;
  const desc =
    params.get("order") === "reverse"
      ? !NATURAL_DESC[sort]
      : NATURAL_DESC[sort];
  const groups = list(params.get("state")) as StateGroup[];
  const causes = list(params.get("cause")) as CategoryId[];
  const places = list(params.get("place"));
  const folders = list(params.get("folder"));
  const byPlace = params.get("group") === "place";
  const byFolder = params.get("group") === "folder";
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [showFilters, setShowFilters] = useState(false);

  // L'adresse garde la vue : rechargée ou partagée, la page revient réglée de même.
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const toggle = (key: string, current: string[], value: string) => {
    const set = current.includes(value)
      ? current.filter((x) => x !== value)
      : [...current, value];
    update({ [key]: set.join(",") || null });
  };

  // La recherche suit la frappe sans attendre ; l'adresse, elle, suit un peu après.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== query) update({ q: query || null });
    }, 250);
    return () => clearTimeout(t);
  });

  // « / » ouvre la recherche, comme dans Beszel ; Échap la vide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allPlaces = useMemo(
    () =>
      [...new Set(items.map((i) => i.place).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [items],
  );

  // Les groupes présents dans le parc, dans leur ordre ; « none » pour les NAS sans groupe.
  const allFolders = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; rank: number }>();
    for (const i of items) if (i.folder) seen.set(i.folder.id, i.folder);
    return [...seen.values()].sort((a, b) => a.rank - b.rank);
  }, [items]);
  const hasLoose = items.some((i) => !i.folder);

  const q = query.trim().toLocaleLowerCase();
  const shown = useMemo(() => {
    const out = items.filter((i) => {
      if (q) {
        const hay =
          `${i.name} ${i.place} ${i.model} ${i.folder?.name ?? ""}`.toLocaleLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (groups.length && !groups.includes(i.group)) return false;
      if (places.length && !places.includes(i.place)) return false;
      if (folders.length && !folders.includes(i.folder?.id ?? "none"))
        return false;
      if (
        causes.length &&
        !causes.some((c) =>
          i.lights.some(
            (l) =>
              l.id === c && (l.light === "failed" || l.light === "warning"),
          ),
        )
      )
        return false;
      return true;
    });
    out.sort((a, b) => {
      const d = compare(a, b, sort);
      return desc ? -d : d;
    });
    return out;
  }, [items, q, groups, places, folders, causes, sort, desc]);

  // Les voyants en cause dans le parc : seulement ceux qui ne sont pas verts quelque part.
  const causeCounts = useMemo(() => {
    const counts = new Map<CategoryId, number>();
    for (const i of items)
      for (const l of i.lights)
        if (l.light === "failed" || l.light === "warning")
          counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    return LIGHT_ORDER.filter((c) => counts.has(c)).map((c) => ({
      id: c,
      count: counts.get(c) ?? 0,
    }));
  }, [items]);

  const groupCounts = useMemo(() => {
    const counts = new Map<StateGroup, number>();
    for (const i of items) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    return counts;
  }, [items]);

  const filtered =
    q !== "" ||
    groups.length > 0 ||
    causes.length > 0 ||
    places.length > 0 ||
    folders.length > 0;
  const now = Date.now();

  return (
    <section aria-label={t("Fleet", "Le parc")} className="flex flex-col gap-3">
      {/* Barre d'outils : recherche, présentation, tri, regroupement. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex h-[30px] min-w-[200px] flex-1 items-center md:max-w-[320px]">
          <Search
            className="icon pointer-events-none absolute left-2.5 size-3.5 text-fg-3"
            aria-hidden="true"
          />
          <span className="sr-only">
            {t("Search for a NAS", "Rechercher un NAS")}
          </span>
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder={t(
              "Search for a NAS, a place, a model",
              "Rechercher un NAS, un lieu, un modèle",
            )}
            className="h-full w-full rounded-[8px] bg-surface pr-8 pl-8 text-[13px] shadow-[var(--control)] outline-none placeholder:text-fg-3 focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_30%,transparent)] max-md:text-[15px]"
          />
          {query ? null : (
            <span className="kbd pointer-events-none absolute right-2 max-md:hidden">
              /
            </span>
          )}
        </label>
        <fieldset className="seg m-0">
          <legend className="sr-only">{t("Layout", "Présentation")}</legend>
          <button
            type="button"
            className="seg-b gap-1.5"
            aria-current={view === "list"}
            onClick={() => update({ view: null })}
          >
            <LayoutList className="size-3.5" aria-hidden="true" />
            {t("List", "Liste")}
          </button>
          <button
            type="button"
            className="seg-b gap-1.5"
            aria-current={view === "columns"}
            onClick={() => update({ view: "columns" })}
          >
            <Columns3 className="size-3.5" aria-hidden="true" />
            {t("Columns", "Colonnes")}
          </button>
        </fieldset>
        <label className="flex items-center gap-1.5 text-[13px] text-fg-2">
          <span className="max-md:sr-only">{t("Sort by", "Trier par")}</span>
          <select
            value={sort}
            onChange={(e) =>
              update({
                sort: e.target.value === "state" ? null : e.target.value,
                order: null,
              })
            }
            className="btn h-[30px] appearance-none pr-3 font-normal max-md:h-9"
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label[lang]}
              </option>
            ))}
          </select>
        </label>
        {allFolders.length ? (
          <button
            type="button"
            className="btn"
            aria-pressed={byFolder}
            onClick={() => update({ group: byFolder ? null : "folder" })}
          >
            <Folder
              className={cn("size-3.5", byFolder ? "text-[var(--accent)]" : "")}
              aria-hidden="true"
            />
            {t("By group", "Par groupe")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          aria-pressed={byPlace}
          onClick={() => update({ group: byPlace ? null : "place" })}
        >
          <MapPin
            className={cn("size-3.5", byPlace ? "text-[var(--accent)]" : "")}
            aria-hidden="true"
          />
          {t("By place", "Par lieu")}
        </button>
      </div>

      {/* Filtres : des pastilles qui se cumulent ; le compte dit ce qu'elles cachent. Au
          téléphone, elles se rangent derrière un bouton. */}
      <div className="flex items-center gap-2 md:hidden">
        <button
          type="button"
          className="btn"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <ListFilter className="size-4" aria-hidden="true" />
          {t("Filters", "Filtres")}
          {groups.length + causes.length + places.length ? (
            <span className="pill b-off">
              {groups.length + causes.length + places.length}
            </span>
          ) : null}
        </button>
        <span className="meta ml-auto tabular-nums">
          {filtered
            ? t(
                `${shown.length} of ${items.length} NAS`,
                `${shown.length} sur ${items.length} NAS`,
              )
            : `${items.length} NAS`}
        </span>
      </div>
      <div
        className={cn(
          "flex-wrap items-center gap-1.5 md:flex",
          showFilters ? "flex" : "hidden",
        )}
      >
        {STATE_GROUPS.filter((g) => groupCounts.has(g.id)).map((g) => (
          <FilterChip
            key={g.id}
            on={groups.includes(g.id)}
            onClick={() => toggle("state", groups, g.id)}
          >
            <span className={cn("dot", GROUP_DOT[g.id])} aria-hidden="true" />
            {g.label[lang]}
            <span className="text-fg-3 tabular-nums">
              {groupCounts.get(g.id)}
            </span>
          </FilterChip>
        ))}
        {causeCounts.length ? (
          <span className="mx-1 h-4 w-px bg-border-2" aria-hidden="true" />
        ) : null}
        {causeCounts.map((c) => (
          <FilterChip
            key={c.id}
            on={causes.includes(c.id)}
            onClick={() => toggle("cause", causes, c.id)}
            label={t(
              `${LIGHT_LABEL[c.id].en} at fault: ${c.count} NAS`,
              `${LIGHT_LABEL[c.id].fr} en cause : ${c.count} NAS`,
            )}
          >
            <LightDot id={c.id} light="warning" />
            <span className="max-md:hidden">{LIGHT_LABEL[c.id][lang]}</span>
            <span className="text-fg-3 tabular-nums">{c.count}</span>
          </FilterChip>
        ))}
        {allFolders.length ? (
          <span className="mx-1 h-4 w-px bg-border-2" aria-hidden="true" />
        ) : null}
        {allFolders.length
          ? [
              ...allFolders.map((f) => ({ id: f.id, name: f.name })),
              ...(hasLoose
                ? [{ id: "none", name: t("No group", "Sans groupe") }]
                : []),
            ].map((f) => (
              <FilterChip
                key={f.id}
                on={folders.includes(f.id)}
                onClick={() => toggle("folder", folders, f.id)}
              >
                {f.name}
              </FilterChip>
            ))
          : null}
        {allPlaces.length > 1 ? (
          <span className="mx-1 h-4 w-px bg-border-2" aria-hidden="true" />
        ) : null}
        {allPlaces.length > 1
          ? allPlaces.map((p) => (
              <FilterChip
                key={p}
                on={places.includes(p)}
                onClick={() => toggle("place", places, p)}
              >
                {p}
              </FilterChip>
            ))
          : null}
        <span className="meta ml-auto tabular-nums max-md:hidden">
          {filtered
            ? t(
                `${shown.length} of ${items.length} NAS`,
                `${shown.length} sur ${items.length} NAS`,
              )
            : `${items.length} NAS`}
        </span>
        {filtered ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--accent)]"
            onClick={() => {
              setQuery("");
              update({
                q: null,
                state: null,
                cause: null,
                place: null,
                folder: null,
              });
            }}
          >
            <X className="size-3" aria-hidden="true" />
            {t("Show all", "Tout afficher")}
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="m-0 font-semibold">
            {t("No NAS matches.", "Aucun NAS ne correspond.")}
          </p>
          <p className="meta m-0">
            {t(
              "Remove a filter or change the search.",
              "Retirez un filtre ou changez la recherche.",
            )}
          </p>
        </div>
      ) : view === "columns" ? (
        <Columns items={shown} now={now} />
      ) : byPlace || byFolder ? (
        <Grouped
          sections={
            byFolder ? folderGroups(shown, lang) : placeGroups(shown, lang)
          }
          items={shown}
          now={now}
          sort={sort}
          desc={desc}
          onSort={(k) => sortBy(k)}
        />
      ) : (
        <ListCard
          items={shown}
          now={now}
          sort={sort}
          desc={desc}
          onSort={(k) => sortBy(k)}
        />
      )}
    </section>
  );

  function sortBy(key: SortKey) {
    if (key === sort)
      update({ order: params.get("order") === "reverse" ? null : "reverse" });
    else update({ sort: key === "state" ? null : key, order: null });
  }
}

function FilterChip({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] transition-[background-color,transform] duration-100 active:scale-[0.96] max-md:h-8 max-md:text-[14px]",
        on
          ? "bg-[var(--accent-bg)] font-semibold text-fg shadow-[inset_0_0_0_1px_var(--accent)]"
          : "bg-surface text-fg-2 shadow-[var(--control)] hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

const COLS =
  "md:grid-cols-[minmax(170px,1.5fr)_minmax(120px,auto)_minmax(84px,1fr)_minmax(84px,1fr)_minmax(84px,1fr)_52px_88px]";

function ListCard(props: ListProps) {
  return (
    <div className="card overflow-clip">
      <ListHeader {...props} />
      <Rows items={props.items} now={props.now} />
    </div>
  );
}

interface ListProps {
  items: BoardItem[];
  now: number;
  sort: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
}

/** L'en-tête de la liste, collé en haut au défilement ; chaque colonne se trie d'un clic. */
function ListHeader({ sort, desc, onSort }: ListProps) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const head = (key: SortKey | null, label: string, right = false) =>
    key ? (
      <button
        type="button"
        onClick={() => onSort(key)}
        aria-label={
          sort === key
            ? t(
                `${label}, sorted ${desc ? "from highest to lowest" : "from lowest to highest"}`,
                `${label}, trié ${desc ? "du plus grand au plus petit" : "du plus petit au plus grand"}`,
              )
            : t(
                `Sort by ${label.toLocaleLowerCase()}`,
                `Trier par ${label.toLocaleLowerCase()}`,
              )
        }
        className={cn(
          "flex items-center gap-1 text-left hover:text-fg",
          right && "justify-end",
          sort === key && "font-semibold text-fg",
        )}
      >
        {label}
        {sort === key ? (
          <ChevronDown
            className={cn("size-3 transition-transform", !desc && "rotate-180")}
            aria-hidden="true"
          />
        ) : null}
      </button>
    ) : (
      <span className={cn(right && "text-right")}>{label}</span>
    );
  return (
    <div
      className={cn(
        "sticky top-0 z-10 hidden items-center gap-4 border-border-2 border-b-[0.5px] bg-surface/90 px-[18px] py-2 text-[12px] text-fg-3 backdrop-blur-md md:grid",
        COLS,
      )}
    >
      {head("state", "NAS")}
      {head(null, t("Lights", "Voyants"))}
      {head("cpu", t("Processor", "Processeur"))}
      {head("memory", t("Memory", "Mémoire"))}
      {head("volume", "Volume")}
      {head(null, "Temp.", true)}
      {head("read", t("Read", "Lu"), true)}
    </div>
  );
}

function Rows({ items, now }: { items: BoardItem[]; now: number }) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <ul className="m-0 list-none p-0">
      {items.map((i) => (
        <li
          key={i.id}
          className="row !p-0 [contain-intrinsic-size:auto_56px] [content-visibility:auto]"
        >
          <Link
            href={nasHref(i.id)}
            className={cn(
              "grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-[18px] py-3 text-fg hover:bg-[var(--hover)] hover:no-underline active:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] md:gap-y-0 md:py-2.5",
              COLS,
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5 max-md:col-span-2">
              <span
                className={cn("dot", GROUP_DOT[i.group])}
                role="img"
                aria-label={i.stateLabel}
                title={i.stateLabel}
              />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{i.name}</span>
                <span className="meta block truncate">
                  {[i.place, i.fictive ? t("fictitious", "fictif") : null]
                    .filter(Boolean)
                    .join(" · ") || " "}
                </span>
              </span>
            </span>
            {/* Un NAS injoignable montre sa dernière lecture, estompée : elle n'est plus sûre. */}
            <span
              className={cn(
                "flex items-center gap-2 max-md:col-span-2",
                i.group === "unreachable" && "opacity-45",
              )}
            >
              <Ring
                ok={i.green.ok}
                total={i.green.total}
                size={26}
                className="md:hidden"
              />
              <LightRow lights={i.lights} />
            </span>
            <span
              className={cn(
                "col-span-2 grid grid-cols-3 gap-3 md:contents",
                i.group === "unreachable" && "opacity-45",
              )}
            >
              <MeterCell
                value={i.cpu}
                label={t("Processor", "Processeur")}
                short="CPU"
              />
              <MeterCell
                value={i.ram}
                label={t("Memory", "Mémoire")}
                short={t("Mem.", "Mém.")}
              />
              <MeterCell
                value={i.volume}
                label={t("Fullest volume", "Volume le plus rempli")}
                short="Vol."
                warn={80}
                crit={90}
              />
            </span>
            <span className="text-right text-[12.5px] text-fg-2 tabular-nums max-md:hidden">
              {i.temp === null ? "–" : `${Math.round(i.temp)}°`}
            </span>
            <span className="meta text-right max-md:hidden">
              {readLabel(i.readAt, now, lang)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MeterCell({
  value,
  label,
  short,
  warn,
  crit,
  labelled = false,
}: {
  value: number | null;
  label: string;
  short: string;
  warn?: number;
  crit?: number;
  /** Toujours étiquetée (cartes des colonnes) ; sinon seulement au téléphone. */
  labelled?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("meta", !labelled && "md:hidden")}>{short}</span>
      <Meter value={value} label={label} warn={warn} crit={crit} />
    </span>
  );
}

function readLabel(at: string | null, now: number, lang: Locale): string {
  const m = minutesSince(at, now);
  return m === null ? "–" : m < 1 ? ago(m, lang) : duration(m, lang);
}

type Section = [title: string, items: BoardItem[]];

/** Par lieu : le lieu le plus mal en point d'abord. */
function placeGroups(items: BoardItem[], lang: Locale): Section[] {
  const byPlace = new Map<string, BoardItem[]>();
  for (const i of items) {
    const key = i.place || tr(lang, { en: "No place", fr: "Sans lieu" });
    byPlace.set(key, [...(byPlace.get(key) ?? []), i]);
  }
  return [...byPlace.entries()].sort(
    (a, b) =>
      Math.min(...a[1].map((i) => i.rank)) -
        Math.min(...b[1].map((i) => i.rank)) || a[0].localeCompare(b[0]),
  );
}

/** Par groupe : dans l'ordre choisi sur la page Groupes, puis les NAS sans groupe. */
function folderGroups(items: BoardItem[], lang: Locale): Section[] {
  return folderSections(items).map((s) => [
    s.folder?.name ?? tr(lang, { en: "No group", fr: "Sans groupe" }),
    s.items,
  ]);
}

/** Regroupé par groupe ou par lieu : les groupes tout verts se replient d'eux-mêmes. */
function Grouped({ sections, ...props }: ListProps & { sections: Section[] }) {
  const lang = useLocale();
  const groups = sections;
  return (
    <div className="flex flex-col gap-3">
      {groups.map(([place, items]) => {
        const allGreen = items.every((i) => i.group === "ok");
        return (
          <details
            key={place}
            open={!allGreen || groups.length === 1}
            className="card group overflow-clip"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-[18px] py-3 [&::-webkit-details-marker]:hidden">
              <ChevronDown
                className="size-4 -rotate-90 text-fg-3 transition-transform duration-200 group-open:rotate-0"
                aria-hidden="true"
              />
              <span className="font-semibold">{place}</span>
              <span className="meta">
                {items.length} NAS
                {allGreen
                  ? tr(lang, { en: ", all green", fr: ", tous verts" })
                  : ""}
              </span>
              <span className="ml-auto flex gap-1">
                {STATE_GROUPS.map((g) => {
                  const n = items.filter((i) => i.group === g.id).length;
                  return n ? (
                    <span
                      key={g.id}
                      className="meta flex items-center gap-1 tabular-nums"
                    >
                      <span
                        className={cn("dot", GROUP_DOT[g.id])}
                        aria-hidden="true"
                      />
                      <span className="sr-only">
                        {tr(lang, {
                          en: `${g.label.en}:`,
                          fr: `${g.label.fr} :`,
                        })}
                      </span>
                      {n}
                    </span>
                  ) : null;
                })}
              </span>
            </summary>
            <div className="border-border-2 border-t-[0.5px]">
              <ListHeader {...props} />
              <Rows items={items} now={props.now} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

/** Les colonnes (le « kanban ») : une par groupe d'état, une carte par NAS. */
function Columns({ items, now }: { items: BoardItem[]; now: number }) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {STATE_GROUPS.map((g) => {
        const col = items.filter((i) => i.group === g.id);
        return (
          <section
            key={g.id}
            aria-label={t(
              `${g.label.en}: ${col.length} NAS`,
              `${g.label.fr} : ${col.length} NAS`,
            )}
            className="flex min-w-0 flex-col gap-2 rounded-[12px] bg-[var(--segmented)] p-2"
          >
            <h3 className="m-0 flex items-center gap-2 px-1.5 pt-1 text-[13px] font-semibold">
              <span className={cn("dot", GROUP_DOT[g.id])} aria-hidden="true" />
              {g.label[lang]}
              <span className="meta font-normal tabular-nums">
                {col.length}
              </span>
            </h3>
            {col.length === 0 ? (
              <p className="meta m-0 px-1.5 pb-2">
                {t("No NAS.", "Aucun NAS.")}
              </p>
            ) : (
              col.map((i) => (
                <Link
                  key={i.id}
                  href={nasHref(i.id)}
                  className="card flex flex-col gap-2.5 p-3 text-fg transition-transform duration-100 hover:no-underline active:scale-[0.98] [contain-intrinsic-size:auto_132px] [content-visibility:auto]"
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">
                        {i.name}
                      </span>
                      <span className="meta block truncate">
                        {[i.place, readLabel(i.readAt, now, lang)]
                          .filter((x) => x && x !== "–")
                          .join(" · ") || " "}
                      </span>
                    </span>
                    <Ring
                      ok={i.green.ok}
                      total={i.green.total}
                      size={30}
                      className={
                        i.group === "unreachable" ? "opacity-45" : undefined
                      }
                    />
                  </span>
                  <LightRow
                    lights={i.lights}
                    className={
                      i.group === "unreachable" ? "opacity-45" : undefined
                    }
                  />
                  <span
                    className={cn(
                      "grid grid-cols-3 gap-2",
                      i.group === "unreachable" && "opacity-45",
                    )}
                  >
                    <MeterCell
                      value={i.cpu}
                      label={t("Processor", "Processeur")}
                      short="CPU"
                      labelled
                    />
                    <MeterCell
                      value={i.ram}
                      label={t("Memory", "Mémoire")}
                      short={t("Mem.", "Mém.")}
                      labelled
                    />
                    <MeterCell
                      value={i.volume}
                      label={t("Fullest volume", "Volume le plus rempli")}
                      short="Vol."
                      labelled
                    />
                  </span>
                </Link>
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}

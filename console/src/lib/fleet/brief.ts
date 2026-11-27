// La fiche d'un NAS en bref (conception 2026-11-25-fiche-en-bref) : un verdict en une phrase,
// ce qu'il y a à faire, puis une tuile par grand sujet, chacune un mot ou un chiffre et une
// ligne. Rien n'y est jugé à neuf : les teintes sont celles des voyants (les contrôles de
// l'agent) et de l'accessibilité du NAS ; la tuile Machine reste neutre.

import { type Locale, type Texts, tr } from "@/i18n";
import { bytes, formatDateTime } from "@/lib/agents/time";
import { formatPct, formatTemp, plural } from "@/lib/format";
import { hasHyperBackup } from "./applies";
import type { FillForecast } from "./forecast";
import { fleetIssues } from "./issues";
import { greenShare, LIGHT_WORD, type Light, lights } from "./lights";
import { formatMonthDay, formatSince, lastBackup } from "./present";
import { checkCounts, counts, type NasState, nasState } from "./state";
import type { CategoryId, Check, Nas } from "./types";

export type BriefTone = "ok" | "warn" | "crit" | "off";

export interface Verdict {
  state: NasState;
  tone: BriefTone;
  title: string;
  sub: string;
  /** Les contrôles viennent d'être lus : l'anneau dit leur part de vert. Sinon, l'état seul. */
  ring: boolean;
}

const UNREACHABLE: NasState[] = ["offline", "denied", "agent_down"];

const STATE_TITLE: Partial<Record<NasState, Texts>> = {
  offline: { en: "Offline", fr: "Hors ligne" },
  denied: { en: "Access denied", fr: "Accès refusé" },
  agent_down: { en: "Agent unreachable", fr: "Agent injoignable" },
  unknown: { en: "Unknown state", fr: "État inconnu" },
  beszel_only: { en: "No agent", fr: "Sans agent" },
};

const STATE_TONE: Record<NasState, BriefTone> = {
  offline: "crit",
  failed: "crit",
  denied: "warn",
  agent_down: "warn",
  warning: "warn",
  unknown: "off",
  beszel_only: "off",
  ok: "ok",
};

/** Un NAS injoignable : ses tuiles et ses voyants sont ceux de la dernière lecture. */
export function isStale(nas: Nas): boolean {
  return UNREACHABLE.includes(nasState(nas));
}

/** Le verdict d'un NAS en une phrase, puis ce qui l'appuie. */
export function nasVerdict(
  nas: Nas,
  now: Date,
  tz: string,
  lang: Locale,
): Verdict {
  const state = nasState(nas);
  const tone = STATE_TONE[state];
  const t = (en: string, fr: string) => tr(lang, { en, fr });

  if (UNREACHABLE.includes(state)) {
    const reach = fleetIssues([nas], lang)[0];
    const since = reach ? formatSince(reach.since, now, tz, lang) : "";
    const last =
      nas.agent.kind === "down" || nas.agent.kind === "denied"
        ? nas.agent.lastReadAt
        : null;
    const sub = last
      ? t(
          `Last checks read ${formatDateTime(last, now, tz, lang)}.`,
          `Derniers contrôles lus ${formatDateTime(last, now, tz, lang)}.`,
        )
      : nas.agent.kind === "none"
        ? t(
            "Followed by Beszel only, which no longer sees it.",
            "Suivi par Beszel seulement, qui ne le voit plus.",
          )
        : t("No check read yet.", "Aucun contrôle lu.");
    const title = (STATE_TITLE[state] as Texts)[lang];
    return {
      state,
      tone,
      title: since ? `${title} ${since}` : title,
      sub,
      ring: false,
    };
  }
  if (state === "beszel_only")
    return {
      state,
      tone,
      title: (STATE_TITLE.beszel_only as Texts)[lang],
      sub: t(
        "Followed by Beszel: vitals and disks, no checks.",
        "Suivi par Beszel : constantes et disques, sans contrôles.",
      ),
      ring: false,
    };

  const { failed, warning, unknown, muted } = checkCounts(nas);
  const { ok, total } = greenShare(nas);
  const mutedNote = muted
    ? lang === "en"
      ? ` · ${plural(muted, "check", "checks", lang)} no longer followed`
      : ` · ${plural(muted, "contrôle n'est", "contrôles ne sont", lang)} plus suivi${muted > 1 ? "s" : ""}`
    : "";
  const share =
    ok === total
      ? t(
          `All ${total} followed checks are green`,
          `Les ${total} contrôles suivis sont verts`,
        )
      : t(
          `${ok} green ${ok === 1 ? "check" : "checks"} out of ${total} followed`,
          `${ok} ${ok > 1 ? "contrôles verts" : "contrôle vert"} sur ${total} suivis`,
        );
  const sub = `${share}${mutedNote}.`;

  let title: string;
  if (failed) {
    const fix =
      lang === "en"
        ? plural(failed, "problem to fix", "problems to fix", lang)
        : plural(failed, "problème à régler", "problèmes à régler", lang);
    title = warning
      ? `${fix}, ${t(`${warning} to watch`, `${warning} à surveiller`)}`
      : fix;
  } else if (warning)
    title =
      lang === "en"
        ? plural(warning, "thing to watch", "things to watch", lang)
        : plural(warning, "point à surveiller", "points à surveiller", lang);
  else if (state === "unknown")
    title = `${(STATE_TITLE.unknown as Texts)[lang]}${
      unknown
        ? t(
            ` · ${plural(unknown, "check", "checks", lang)} not read`,
            ` · ${plural(unknown, "contrôle", "contrôles", lang)} non lu${unknown > 1 ? "s" : ""}`,
          )
        : ""
    }`;
  else title = t("All good", "Tout va bien");
  return { state, tone, title, sub, ring: true };
}

export type TileId =
  | "backup"
  | "storage"
  | "updates"
  | "security"
  | "ups"
  | "machine";

export interface Tile {
  id: TileId;
  tone: BriefTone | "neutral";
  label: string;
  value: string;
  line: string;
  /** Onglet de la fiche qui détaille la tuile. */
  section: string;
  /** Remplissage du volume le plus plein, en % (tuile Stockage). */
  meter: number | null;
}

const LIGHT_TONE: Record<Light, BriefTone> = {
  failed: "crit",
  warning: "warn",
  ok: "ok",
  unknown: "off",
  muted: "off",
};

/** Du pire au meilleur : la tuile prend le pire voyant de ses catégories. */
const LIGHT_RANK: Light[] = ["failed", "warning", "unknown", "ok", "muted"];

const GROUPS: Record<
  Exclude<TileId, "machine">,
  { categories: CategoryId[]; label: Texts; good: Texts; section: string }
> = {
  backup: {
    categories: ["backup"],
    label: { en: "Backups", fr: "Sauvegardes" },
    good: { en: "Up to date", fr: "À jour" },
    section: "backups",
  },
  storage: {
    categories: ["storage"],
    label: { en: "Storage", fr: "Stockage" },
    good: { en: "OK", fr: "OK" },
    section: "storage",
  },
  updates: {
    categories: ["updates"],
    label: { en: "Updates", fr: "Mises à jour" },
    good: { en: "Up to date", fr: "À jour" },
    section: "system",
  },
  security: {
    categories: [
      "security_advisor",
      "access",
      "accounts",
      "certificates",
      "shares",
    ],
    label: { en: "Security", fr: "Sécurité" },
    good: { en: "Compliant", fr: "Conforme" },
    section: "security",
  },
  ups: {
    categories: ["ups"],
    label: { en: "UPS", fr: "Onduleur" },
    good: { en: "In place", fr: "En place" },
    section: "system",
  },
};

/** Le pire voyant des catégories d'une tuile, ou `null` si aucune n'a de contrôle. */
function groupLight(nas: Nas, categories: CategoryId[]): Light | null {
  const found = lights(nas).filter((l) => categories.includes(l.id));
  if (!found.length) return null;
  return LIGHT_RANK.find((r) => found.some((l) => l.light === r)) ?? "ok";
}

/** Les contrôles en cause d'une tuile, en échec d'abord, par leur titre. */
function culprits(nas: Nas, categories: CategoryId[]): Check[] {
  const bad = nas.checks.filter(
    (c) =>
      categories.includes(c.category) &&
      counts(c) &&
      (c.status === "failed" || c.status === "warning"),
  );
  return [
    ...bad.filter((c) => c.status === "failed"),
    ...bad.filter((c) => c.status === "warning"),
  ];
}

/** « DSM 7.2.2 », que DSM donne la version avec son nom ou sans. */
function dsm(version: string): string {
  return /^DSM\b/i.test(version) ? version : `DSM ${version}`;
}

/** « Pare-feu, SSH +1 » : deux noms, puis le compte du reste. */
function names(list: string[]): string {
  const head = list.slice(0, 2).join(", ");
  return list.length > 2 ? `${head} +${list.length - 2}` : head;
}

/** La ligne d'une tuile qui n'est pas verte, faute de mieux : ce qui est en cause. */
function fallbackLine(
  nas: Nas,
  light: Light,
  categories: CategoryId[],
  lang: Locale,
): string {
  if (light === "muted")
    return tr(lang, { en: "Not followed", fr: "Non suivi" });
  const bad = culprits(nas, categories);
  if (bad.length) return names(bad.map((c) => c.title));
  return tr(lang, { en: "Not read", fr: "Non lu" });
}

export function briefTiles(
  nas: Nas,
  {
    now,
    tz,
    lang,
    forecast,
  }: { now: Date; tz: string; lang: Locale; forecast?: FillForecast },
): Tile[] {
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const out: Tile[] = [];
  const word = (light: Light, good: Texts) =>
    light === "ok" ? good[lang] : LIGHT_WORD[light][lang];
  const tile = (
    id: Exclude<TileId, "machine" | "storage">,
    light: Light,
    line: string,
  ): Tile => ({
    id,
    tone: LIGHT_TONE[light],
    label: GROUPS[id].label[lang],
    value: word(light, GROUPS[id].good),
    line,
    section: GROUPS[id].section,
    meter: null,
  });

  // Sauvegardes : la dernière lancée, ou la tâche en échec et depuis quand.
  const backup = groupLight(nas, GROUPS.backup.categories);
  if (backup && nas.agent.kind !== "none") {
    let line: string;
    const failedTasks = nas.tasks.filter((x) => x.result.status === "failed");
    if (backup === "failed" || backup === "warning") {
      const issue = fleetIssues([nas], lang).find((i) =>
        i.checkId?.startsWith("backup."),
      );
      const since = issue ? formatSince(issue.since, now, tz, lang) : "";
      line = failedTasks.length
        ? [names(failedTasks.map((x) => x.name)), since]
            .filter(Boolean)
            .join(" · ")
        : fallbackLine(nas, backup, GROUPS.backup.categories, lang);
    } else if (backup === "ok") {
      const last = lastBackup(nas, now, tz, lang);
      line = last.task
        ? t(`last ${last.text}`, `dernière ${last.text}`)
        : last.text;
    } else line = fallbackLine(nas, backup, GROUPS.backup.categories, lang);
    out.push({
      ...tile("backup", backup, line),
      section: hasHyperBackup(nas) ? "backups" : "checks",
    });
  }

  // Stockage : le volume le plus plein, puis le disque malade, la date de remplissage, les
  // disques sains ou la place libre.
  const storage = groupLight(nas, GROUPS.storage.categories);
  const fullest = [...nas.volumes].sort((a, b) => b.pct - a.pct)[0];
  if (storage || fullest || nas.disks.length) {
    const sick = nas.disks.filter((d) => !d.healthy).length;
    const bad = culprits(nas, GROUPS.storage.categories);
    const fillDate =
      forecast?.kind === "date"
        ? t(
            `full around ${formatMonthDay(forecast.at, now, tz, lang)}`,
            `plein vers le ${formatMonthDay(forecast.at, now, tz, lang)}`,
          )
        : null;
    const onlyFilling =
      bad.length > 0 && bad.every((c) => c.id === "storage.volume_usage");
    let line: string;
    if (sick)
      line =
        lang === "en"
          ? plural(sick, "disk in poor health", "disks in poor health", lang)
          : plural(
              sick,
              "disque en mauvais état",
              "disques en mauvais état",
              lang,
            );
    else if (bad.length && !(onlyFilling && fillDate))
      line = names(bad.map((c) => c.title));
    else if (fillDate) line = fillDate;
    else if (nas.disks.length)
      line =
        lang === "en"
          ? plural(nas.disks.length, "healthy disk", "healthy disks", lang)
          : plural(nas.disks.length, "disque sain", "disques sains", lang);
    else if (fullest?.totalBytes != null && fullest.usedBytes != null)
      line = t(
        `${bytes(fullest.totalBytes - fullest.usedBytes, lang)} free`,
        `${bytes(fullest.totalBytes - fullest.usedBytes, lang)} libres`,
      );
    else line = t("Not read", "Non lu");
    out.push({
      id: "storage",
      tone: storage ? LIGHT_TONE[storage] : "neutral",
      label: GROUPS.storage.label[lang],
      value: fullest ? formatPct(fullest.pct, lang) : "–",
      line,
      section: "storage",
      meter: fullest ? fullest.pct : null,
    });
  }

  // Mises à jour : la version de DSM qui attend, les paquets, ou la version en place.
  const updates = groupLight(nas, GROUPS.updates.categories);
  if (updates) {
    const upd = nas.dsmUpdate;
    const pending = nas.packages?.filter((p) => p.update).length ?? 0;
    let line: string;
    if (updates === "ok") line = upd?.current ? dsm(upd.current) : nas.dsm;
    else if (upd?.available)
      line = t(
        `${dsm(upd.available)} available`,
        `${dsm(upd.available)} disponible`,
      );
    else if (pending && updates !== "muted")
      line =
        lang === "en"
          ? plural(pending, "package to update", "packages to update", lang)
          : plural(
              pending,
              "paquet à mettre à jour",
              "paquets à mettre à jour",
              lang,
            );
    else line = fallbackLine(nas, updates, GROUPS.updates.categories, lang);
    out.push(tile("updates", updates, line));
  }

  // Sécurité : Security Advisor, accès, comptes, certificats et partages en une tuile.
  const security = groupLight(nas, GROUPS.security.categories);
  if (security) {
    const followed = nas.checks.filter(
      (c) => GROUPS.security.categories.includes(c.category) && counts(c),
    ).length;
    const line =
      security === "ok"
        ? lang === "en"
          ? plural(followed, "green check", "green checks", lang)
          : plural(followed, "contrôle vert", "contrôles verts", lang)
        : fallbackLine(nas, security, GROUPS.security.categories, lang);
    out.push(tile("security", security, line));
  }

  // Onduleur : ce que DSM en dit.
  const ups = groupLight(nas, GROUPS.ups.categories);
  if (ups) {
    const said = nas.ups && nas.ups !== "–" ? nas.ups : null;
    out.push(
      tile(
        "ups",
        ups,
        said ?? fallbackLine(nas, ups, GROUPS.ups.categories, lang),
      ),
    );
  }

  // Machine : les constantes du moment ; depuis le 2026-11-26, le ton des contrôles Système et
  // Conteneurs (DSM joignable, processeur, mémoire, températures, heure, conteneurs).
  const v = nas.vitals;
  const machine = groupLight(nas, ["system", "containers"]);
  const machineBad = machine && machine !== "ok" && machine !== "muted";
  const load = [
    v.cpu != null
      ? t(`CPU ${formatPct(v.cpu, lang)}`, `proc. ${formatPct(v.cpu, lang)}`)
      : null,
    v.ram != null
      ? t(`RAM ${formatPct(v.ram, lang)}`, `mém. ${formatPct(v.ram, lang)}`)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const culprit = machineBad
    ? culprits(nas, ["system", "containers"])[0]
    : undefined;
  out.push({
    id: "machine",
    tone: machine ? LIGHT_TONE[machine] : "neutral",
    label: t("Hardware", "Machine"),
    value: v.temp != null ? formatTemp(v.temp, lang) : formatPct(v.cpu, lang),
    line: culprit
      ? culprit.title
      : load ||
        (v.temp != null
          ? t("System temperature", "Température du système")
          : t("No reading", "Pas de mesure")),
    section: "system",
    meter: null,
  });
  return out;
}

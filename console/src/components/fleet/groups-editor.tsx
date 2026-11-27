"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  assignGroup,
  createGroup,
  deleteGroup,
  moveGroup,
  updateGroup,
} from "@/app/actions";
import { tr } from "@/i18n";
import { useLocale } from "@/i18n/client";
import {
  FOLDER_KIND_LABEL,
  FOLDER_KINDS,
  type FolderKind,
} from "@/lib/fleet/folders";
import { plural } from "@/lib/format";
import { Card, CardHeader } from "../ui/card";

interface Folder {
  id: string;
  name: string;
  kind: FolderKind;
}

interface NasRow {
  id: string;
  name: string;
  folderId: string | null;
}

const SELECT = "btn h-[30px] appearance-none pr-3 font-normal max-md:h-9";

/** La page Groupes : créer, renommer, ordonner et supprimer les groupes ; ranger chaque NAS. */
export function GroupsEditor({
  persistent,
  folders,
  nas,
}: {
  persistent: boolean;
  folders: Folder[];
  nas: NasRow[];
}) {
  const lang = useLocale();
  const t = (en: string, fr: string) => tr(lang, { en, fr });
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<FolderKind>("client");
  const [deleting, setDeleting] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; reason?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) setError(result.reason ?? t("Refused.", "Refusé."));
      router.refresh();
    });
  }

  if (!persistent)
    return (
      <Card>
        <p className="m-0 px-[18px] py-4 text-fg-2">
          {t(
            "This console has no memory (NAS_CONSOLE_MEMORY_FILE): groups cannot be kept.",
            "Cette console n'a pas de mémoire (NAS_CONSOLE_MEMORY_FILE) : les groupes ne peuvent pas être gardés.",
          )}
        </p>
      </Card>
    );

  const counts = new Map<string, number>();
  for (const n of nas)
    if (n.folderId) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
  const kindLabel = (k: FolderKind) => tr(lang, FOLDER_KIND_LABEL[k]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p role="alert" className="m-0 text-[14px] text-crit-text">
          {error}
        </p>
      ) : null}
      <Card labelledBy="les-groupes">
        <CardHeader
          id="les-groupes"
          title={t("Groups", "Groupes")}
          meta={
            lang === "en"
              ? plural(folders.length, "group", "groups", lang)
              : plural(folders.length, "groupe", "groupes", lang)
          }
        />
        {folders.length === 0 ? (
          <p className="m-0 px-[18px] pt-3 text-fg-2">
            {t(
              "No group yet. A client, a site, a family: name the first one below.",
              "Aucun groupe pour l'instant. Un client, un site, la famille : nommez le premier ci-dessous.",
            )}
          </p>
        ) : null}
        {folders.map((f, i) => (
          <div key={f.id} className="row flex-wrap gap-y-2">
            <input
              className="field h-[34px] max-w-[280px] flex-1 text-[14px]"
              defaultValue={f.name}
              maxLength={40}
              aria-label={t(`Name of ${f.name}`, `Nom de ${f.name}`)}
              onBlur={(e) => {
                const value = e.currentTarget.value;
                if (value.trim() && value.trim() !== f.name)
                  run(() => updateGroup(f.id, { name: value }, lang));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={busy}
            />
            <select
              className={SELECT}
              value={f.kind}
              aria-label={t(`Kind of ${f.name}`, `Type de ${f.name}`)}
              onChange={(e) =>
                run(() => updateGroup(f.id, { kind: e.target.value }, lang))
              }
              disabled={busy}
            >
              {FOLDER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
            <span className="meta min-w-[64px] tabular-nums">
              {plural(counts.get(f.id) ?? 0, "NAS", "NAS", lang)}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                className="btn h-[30px] px-2"
                onClick={() => run(() => moveGroup(f.id, -1, lang))}
                disabled={busy || i === 0}
                aria-label={t(`Move ${f.name} up`, `Monter ${f.name}`)}
              >
                <ChevronUp className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn h-[30px] px-2"
                onClick={() => run(() => moveGroup(f.id, 1, lang))}
                disabled={busy || i === folders.length - 1}
                aria-label={t(`Move ${f.name} down`, `Descendre ${f.name}`)}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </button>
              {deleting === f.id ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger h-[30px]"
                    onClick={() => {
                      setDeleting(null);
                      run(() => deleteGroup(f.id, lang));
                    }}
                    disabled={busy}
                  >
                    {t(`Delete ${f.name}`, `Supprimer ${f.name}`)}
                  </button>
                  <button
                    type="button"
                    className="btn h-[30px]"
                    onClick={() => setDeleting(null)}
                  >
                    {t("Cancel", "Annuler")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn h-[30px]"
                  onClick={() => setDeleting(f.id)}
                  disabled={busy}
                >
                  {t("Delete…", "Supprimer…")}
                </button>
              )}
            </span>
          </div>
        ))}
        <form
          className="flex flex-wrap items-center gap-2 px-[18px] py-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName;
            run(async () => {
              const result = await createGroup(name, newKind, lang);
              if (result.ok) setNewName("");
              return result;
            });
          }}
        >
          <input
            className="field h-[34px] max-w-[280px] flex-1 text-[14px]"
            placeholder={t("New group", "Nouveau groupe")}
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            aria-label={t("Name of the new group", "Nom du nouveau groupe")}
          />
          <select
            className={SELECT}
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as FolderKind)}
            aria-label={t("Kind of the new group", "Type du nouveau groupe")}
          >
            {FOLDER_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn"
            disabled={busy || !newName.trim()}
          >
            {t("Create", "Créer")}
          </button>
          <span className="meta">
            {t(
              "Deleting a group only unsorts its NAS.",
              "Supprimer un groupe ne fait que libérer ses NAS.",
            )}
          </span>
        </form>
      </Card>

      <Card labelledBy="ranger-les-nas">
        <CardHeader
          id="ranger-les-nas"
          title={t("Sort the NAS", "Ranger les NAS")}
          meta={plural(nas.length, "NAS", "NAS", lang)}
        />
        {nas.map((n) => (
          <div key={n.id} className="row justify-between">
            <span className="min-w-0 truncate font-medium">{n.name}</span>
            <select
              className={SELECT}
              value={n.folderId ?? ""}
              onChange={(e) =>
                run(() => assignGroup(n.id, e.target.value || null, lang))
              }
              disabled={busy || folders.length === 0}
              aria-label={t(`Group of ${n.name}`, `Groupe de ${n.name}`)}
            >
              <option value="">{t("No group", "Sans groupe")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </Card>
    </div>
  );
}

"use client";

import { Zap } from "lucide-react";
import Link from "next/link";
import { useLocale, usePathname } from "@/i18n/client";
import type { Tone } from "./tone";

export interface TabItem {
  href: string;
  label: string;
  count?: number;
  tone?: Tone;
  /** Actif seulement à cette adresse exacte (la synthèse). */
  exact?: boolean;
  /** Onglet d'action (il agit sur l'agent), rangé à part des onglets de lecture. */
  action?: boolean;
}

function isActive(pathname: string, item: TabItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Onglets en contrôle segmenté ; la lecture d'un côté, les actions à part, étiquetées.
 * Sur téléphone, des pastilles qui défilent à l'horizontale. */
export function Tabs({ items, label }: { items: TabItem[]; label: string }) {
  const lang = useLocale();
  const pathname = usePathname();
  const read = items.filter((i) => !i.action);
  const act = items.filter((i) => i.action);
  return (
    <>
      <nav className="hidden items-center gap-3 md:flex" aria-label={label}>
        <div className="tabs">
          {read.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="tab"
              aria-current={isActive(pathname, item) ? "page" : undefined}
            >
              {item.label}
              {item.count ? (
                <span
                  className={`pill ${item.tone ? `b-${item.tone}` : "b-off"}`}
                >
                  {item.count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
        {act.length ? (
          <div className="flex items-center gap-2">
            <span className="meta font-medium">
              {lang === "en" ? "Actions" : "Actions"}
            </span>
            <div className="tabs">
              {act.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="tab"
                  aria-current={isActive(pathname, item) ? "page" : undefined}
                >
                  <Zap
                    className="size-3.5 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </nav>
      <nav
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden"
        aria-label={label}
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="chip"
            aria-current={isActive(pathname, item) ? "page" : undefined}
          >
            {item.action ? (
              <Zap className="size-3.5" aria-hidden="true" />
            ) : null}
            {item.label}
            {item.count ? (
              <span className="text-[12.5px] opacity-75">{item.count}</span>
            ) : null}
          </Link>
        ))}
      </nav>
    </>
  );
}

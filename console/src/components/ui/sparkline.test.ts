import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Sparkline } from "./sparkline";

const t = (h: number) => new Date(Date.UTC(2026, 10, 21, h)).toISOString();

test("la courbe reste dans sa fenêtre de 24 h : un NAS éteint depuis 12 h garde son trou", () => {
  const html = renderToStaticMarkup(
    createElement(Sparkline, {
      lang: "fr",
      points: [
        { t: t(0), v: 10 },
        { t: t(12), v: 20 },
      ],
      max: 100,
      color: "c1",
      label: "Processeur sur 24 h",
      format: (v: number) => `${v}`,
      width: 72,
      span: { from: Date.parse(t(0)), to: Date.parse(t(24)) },
    }),
  );
  const line = /<path d="([^"]+)" style="fill:none/.exec(html)?.[1] ?? "";
  // Le dernier point tombe au milieu de la largeur, pas au bord droit.
  expect(line).toMatch(/L36 /);
});

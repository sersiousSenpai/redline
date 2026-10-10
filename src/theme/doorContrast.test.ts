// SPDX-License-Identifier: Apache-2.0
// Every text the Front Door and its compact card paint reaches 4.5:1 — WCAG
// 2.x AA for body text — in all fifteen themes (10/10 design, decision 12).
//
// The colours are read from the stylesheets that declare them, not restated
// here: each entry names the rule that sets a text's colour, the rule that
// sets what it sits on, and the surface under both, and the test evaluates
// those declarations against each theme's derived tokens. The ratio is the
// standard WCAG one, written out below rather than borrowed from derive.ts:
// an oracle shouldn't share the code it checks. A failure here is fixed in
// the tokens (derive.ts) or in the usage (the CSS) — never in this formula.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveTokens } from "./derive";
import { THEMES } from "./themes";

type RGBA = [number, number, number, number];

function relativeLuminance([r, g, b]: RGBA): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `top` painted over `under`. */
function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3] + under[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

/** Split on commas outside brackets: `:not(a, b)` is one selector. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(current.trim()); current = ""; } else current += ch;
  }
  return [...out, current.trim()].filter(Boolean);
}

const sheets = new Map<string, string>();
/** The last `property` declared for exactly `selector` in `file`. */
function declared(file: string, selector: string, property: string): string | null {
  if (!sheets.has(file)) sheets.set(file, readFileSync(join(process.cwd(), "src", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
  let found: string | null = null;
  for (const rule of sheets.get(file)!.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!splitTop(rule[1]).includes(selector)) continue;
    for (const declaration of rule[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (declaration.slice(0, colon).trim() === property) found = declaration.slice(colon + 1).replace("!important", "").trim();
    }
  }
  return found;
}

/** A colour as these stylesheets write one: a token, a hex, `transparent`,
 *  or `color-mix(in srgb, …)` — mixed premultiplied, as the browser does. */
function evaluate(value: string, tokens: Record<string, string>): RGBA {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const token = /^var\(--([\w-]+)\)$/.exec(v);
  if (token) return evaluate(tokens[token[1]], tokens);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const a = evaluate(mix[1], tokens), b = evaluate(mix[3], tokens), p = Number(mix[2]) / 100;
    const alpha = a[3] * p + b[3] * (1 - p);
    const channel = (i: number) => alpha === 0 ? 0 : (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
  }
  throw new Error(`can't read the colour ${v}`);
}

type Rule = [file: string, selector: string];
const ISLAND = "components/MonochatIsland.css", CARD = "components/MonochatCard.css", MENU = "components/ComposerMenu.css", APP = "styles.css";
/** Where a door or card text takes its colour (and any fade), what it sits on,
 *  and the surface under that. The door's paper backdrop is `--color-paper`;
 *  the card, the door's composer box and the pill are `--color-bg-elevated`. */
const TEXTS: Array<{ what: string; color: Rule; opacity?: Rule; background?: Rule; on: "color-paper" | "color-bg-elevated" }> = [
  { what: "the door's headline", color: [ISLAND, ".rl-fd-title"], on: "color-paper" },
  { what: "the door's subline", color: [APP, ".rl-fd-sub"], on: "color-paper" },
  { what: "a recents head", color: [ISLAND, ".rl-fd-recent-head"], on: "color-paper" },
  { what: "a recent plan or chat", color: [ISLAND, ".rl-monochat .rl-fd-recent.rl-fd-suggestion"], on: "color-paper" },
  { what: "a recent page", color: [ISLAND, ".rl-fd-browse"], on: "color-paper" },
  { what: "the room's heading and its New", color: [ISLAND, ".rl-monochat-heading"], on: "color-paper" },
  { what: "a context chip, in the door", color: [ISLAND, ".rl-context-chips button"], on: "color-paper" },
  { what: "a context chip, in the card", color: [ISLAND, ".rl-context-chips button"], on: "color-bg-elevated" },
  { what: "a context chip that is on", color: [ISLAND, '.rl-context-chips button[aria-pressed="true"]'], background: [ISLAND, '.rl-context-chips button[aria-pressed="true"]'], on: "color-bg-elevated" },
  { what: "the sentence being typed", color: [APP, ".rl-fd-input"], on: "color-bg-elevated" },
  { what: "the door's placeholder, on its composer box", color: [ISLAND, ".rl-monochat .rl-fd-input::placeholder"], background: [ISLAND, ".rl-monochat .rl-floating-composer.rl-frontdoor .rl-fd-island"], on: "color-paper" },
  { what: "the card's placeholder", color: [APP, ".rl-fd-input::placeholder"], on: "color-bg-elevated" },
  { what: "the composer's fix-it chip", color: [APP, ".rl-fd-setup"], background: [APP, ".rl-fd-setup"], on: "color-bg-elevated" },
  { what: "a composer menu, in the door", color: [MENU, ".rl-composer-chip"], background: [ISLAND, ".rl-monochat .rl-composer-chip:not(:hover, [aria-expanded=true])"], on: "color-bg-elevated" },
  { what: "a composer menu, in the card", color: [MENU, ".rl-composer-chip"], background: [CARD, ".rl-monochat-float .rl-composer-chip:not(:hover, [aria-expanded=true])"], on: "color-bg-elevated" },
  { what: "the card's heading", color: [CARD, ".rl-float-heading"], on: "color-bg-elevated" },
  { what: "the pill", color: [ISLAND, ".rl-portal-membrane"], background: [ISLAND, ".rl-portal-membrane"], on: "color-bg-elevated" },
  { what: "the pill's count of plans that arrived", color: [ISLAND, ".rl-monochat-news"], background: [ISLAND, ".rl-monochat-news"], on: "color-bg-elevated" },
  { what: "a launch in flight, in the door", color: [APP, ".rl-fd-flight-open"], background: [APP, ".rl-fd-flight"], on: "color-paper" },
  { what: "where that launch is running", color: [APP, ".rl-fd-detail"], opacity: [APP, ".rl-fd-flight-open .rl-fd-detail"], background: [APP, ".rl-fd-flight"], on: "color-paper" },
];

describe("the door and its card are legible in every theme", () => {
  it("reads every rule it checks", () => {
    for (const { what, color, background, opacity } of TEXTS) {
      expect(declared(...color, "color"), `${what}: no colour on ${color[1]}`).not.toBeNull();
      if (background) expect(declared(...background, "background") ?? declared(...background, "background-color"), `${what}: no background on ${background[1]}`).not.toBeNull();
      if (opacity) expect(declared(...opacity, "white-space"), `${what}: no rule ${opacity[1]}`).not.toBeNull();
    }
    expect(THEMES).toHaveLength(15);
  });

  it.each(THEMES.map((theme) => [theme.name, theme] as const))("%s: every text reaches 4.5:1", (_name, theme) => {
    const tokens = deriveTokens(theme.base) as unknown as Record<string, string>;
    const short: string[] = [];
    for (const { what, color, opacity, background, on } of TEXTS) {
      const surface = evaluate(`var(--${on})`, tokens);
      const fill = background ? declared(...background, "background") ?? declared(...background, "background-color") : null;
      const under = fill ? over(evaluate(fill, tokens), surface) : surface;
      const ink = evaluate(declared(...color, "color")!, tokens);
      const fade = opacity ? Number(declared(...opacity, "opacity") ?? 1) : 1;
      const ratio = contrast(over([ink[0], ink[1], ink[2], ink[3] * fade], under), under);
      if (ratio < 4.5) short.push(`${what}: ${ratio.toFixed(2)}`);
    }
    expect(short).toEqual([]);
  });

  it("the formula is the standard one", () => {
    // WCAG's own reference points: black on white is 21:1, #767676 on white
    // is the familiar 4.54:1 grey.
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrast([0x76, 0x76, 0x76, 1], [255, 255, 255, 1])).toBeCloseTo(4.54, 2);
  });
});

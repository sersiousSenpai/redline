// SPDX-License-Identifier: Apache-2.0
// Every text the Front Door, its compact card, the dictation strip that
// floats over them and the chat chrome paint reaches 4.5:1 — WCAG 2.x AA for
// body text — in all fifteen themes (10/10 design, decision 12). A glyph that
// is a control's only label (send ↑, ×) is held to the 3:1 non-text floor
// instead.
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

/** A colour as these stylesheets (and the tokens) write one: a token, a hex,
 *  `rgba(…)`, `transparent`, or `color-mix(in srgb, …)` — mixed
 *  premultiplied, as the browser does. */
function evaluate(value: string, tokens: Record<string, string>): RGBA {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const token = /^var\(--([\w-]+)\)$/.exec(v);
  if (token) return evaluate(tokens[token[1]], tokens);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/.exec(v);
  if (rgba) return rgba.slice(1).map(Number) as RGBA;
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
type Surface = "color-paper" | "color-bg-elevated" | "color-canvas";
interface Pair {
  what: string;
  /** The rule that sets its colour, or the colour it inherits. */
  color: Rule | string;
  opacity?: Rule;
  /** Fills between the surface and `background`, outermost first. */
  under?: Rule[];
  /** The rule that fills under it, or the fill an inline style gives it. */
  background?: Rule | string;
  /** Every surface it is read on. */
  on: Surface | readonly Surface[];
  /** 3 for a glyph that is a control's only label (WCAG 1.4.11). */
  min?: number;
}
const ISLAND = "components/MonochatIsland.css", CARD = "components/MonochatCard.css", MENU = "components/ComposerMenu.css", APP = "styles.css", STRIP = "components/DictationStrip.css";
/** Where a door or card text takes its colour (and any fade), what it sits on,
 *  and the surface under that. The door's paper backdrop is `--color-paper`;
 *  the card, the door's composer box and the pill are `--color-bg-elevated`.
 *  The recents are also read at rest, before the paper comes up: on the plate
 *  (paper) or, around it, the hull (`--color-canvas`). */
const RESTING: Surface[] = ["color-paper", "color-canvas"];
const TEXTS: Pair[] = [
  { what: "the door's headline", color: [ISLAND, ".rl-fd-title"], on: "color-paper" },
  { what: "the door's subline", color: [APP, ".rl-fd-sub"], on: "color-paper" },
  { what: "a recents head", color: [ISLAND, ".rl-fd-recent-head"], on: RESTING },
  // A title takes its entry's ink (`--fd-item`): brighter than the heads,
  // quieter than the sentence being typed.
  { what: "a recent plan or chat's title", color: [ISLAND, ".rl-monochat .rl-fd-recent.rl-fd-suggestion"], on: RESTING },
  { what: "a recent page", color: [ISLAND, ".rl-fd-browse"], on: RESTING },
  { what: "a recent page's host", color: [ISLAND, ".rl-fd-browse-host"], on: RESTING },
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
  // "Plan a build", "Continue draft" and "Working" alike: the label takes the
  // membrane's ink. The mark beside it is the app icon, decorative.
  { what: "the pill's label", color: [ISLAND, ".rl-portal-membrane"], background: [ISLAND, ".rl-portal-membrane"], on: "color-bg-elevated" },
  { what: "a launch in flight, in the door", color: [APP, ".rl-fd-flight-open"], background: [APP, ".rl-fd-flight"], on: "color-paper" },
  { what: "where that launch is running", color: [APP, ".rl-fd-detail"], opacity: [APP, ".rl-fd-flight-open .rl-fd-detail"], background: [APP, ".rl-fd-flight"], on: "color-paper" },
  // The dictation strip, over the door's box, the card or any composer.
  { what: "the words being dictated", color: [STRIP, ".rl-dictation-text"], background: [STRIP, ".rl-dictation-strip"], on: "color-paper" },
  { what: "the dictation strip's hint", color: [STRIP, ".rl-dictation-hint"], background: [STRIP, ".rl-dictation-strip"], on: "color-paper" },
  { what: "the dictation strip's Copy", color: [STRIP, ".rl-dictation-copy"], background: [STRIP, ".rl-dictation-copy"], on: "color-bg-elevated" },
];

const REPLY = "components/ReplyBlock.css", WORK = "components/ChatWorkbench.css", PAGE = "components/BrowserChat.css", BROWSER = "components/BrowserWorkspace.css";
/** A reply is read on the paper (the room, the dock, the page chat) and on a
 *  raised card (a plan comment's thread). */
const BOTH: Surface[] = ["color-paper", "color-bg-elevated"];
/** The chat chrome: the reply anatomy's byline, steps line and tail row, the
 *  queue tray, the composers' footers, and the page chat's header and rail. */
const CHAT: Pair[] = [
  { what: "a reply's byline", color: [REPLY, ".rl-reply-byline"], on: BOTH },
  { what: "a failed reply's byline", color: [REPLY, ".rl-reply-byline[data-error]"], on: BOTH },
  { what: "the steps line", color: [REPLY, ".rl-reply-steps"], on: BOTH },
  { what: "the steps, opened", color: [REPLY, ".rl-reply-steplist"], on: BOTH },
  { what: "the tail row's status and meter", color: [REPLY, ".rl-reply-tail"], on: BOTH },
  { what: "a stalled status", color: [REPLY, ".rl-reply-status[data-stalled]"], on: BOTH },
  { what: "a cut-off reply's mark", color: [REPLY, ".rl-reply-truncated"], on: BOTH },
  { what: "a reply's action", color: [REPLY, ".rl-reply-action"], on: BOTH },
  { what: "a reply's action in the accent", color: [REPLY, '.rl-reply-action[data-tone="info"]'], on: BOTH },
  { what: "a reply's action under the pointer", color: [REPLY, ".rl-reply-action:focus-visible"], background: [REPLY, ".rl-reply-action:focus-visible"], on: BOTH },
  { what: "a failed reply's sentence", color: [REPLY, ".rl-reply-error"], on: BOTH },
  { what: "a note at the end of the thread", color: [REPLY, ".rl-thread-note"], on: BOTH },
  { what: "the other view's streaming line", color: [REPLY, ".rl-thread-elsewhere"], on: BOTH },
  { what: "a turn's note", color: [REPLY, ".rl-turn-note"], on: BOTH },
  { what: "a turn's note's resend or retry", color: [REPLY, ".rl-turn-note-action"], on: BOTH },
  { what: "your own message, on its card", color: "var(--color-ink)", background: [REPLY, ".rl-user-turn"], on: "color-paper" },
  { what: "the queued pill", color: [WORK, ".rl-queue-pill"], background: [WORK, ".rl-queue-pill"], on: "color-paper" },
  { what: "the queued count", color: [WORK, ".rl-queue-count"], background: [WORK, ".rl-queue-pill"], on: "color-paper" },
  { what: "a queued message", color: "var(--color-ink)", background: [WORK, ".rl-queue-list"], on: "color-paper" },
  { what: "a queued message's mode", color: [WORK, ".rl-queue-mode"], background: [WORK, ".rl-queue-list"], on: "color-paper" },
  { what: "a queued message's Steer, Next and ×", color: [WORK, ".rl-queue-row button"], background: [WORK, ".rl-queue-list"], on: "color-paper" },
  { what: "a queued message's Steer, Next and × under the pointer", color: [WORK, ".rl-queue-row button:focus-visible"], under: [[WORK, ".rl-queue-list"]], background: [WORK, ".rl-queue-row button:focus-visible"], on: "color-paper" },
  { what: "the send button's arrow", color: [WORK, ".rl-send"], background: [WORK, ".rl-send"], on: "color-paper", min: 3 },
  { what: "the stop button's square", color: [WORK, '.rl-send[data-send="stop"]'], background: [WORK, '.rl-send[data-send="stop"]'], on: "color-paper", min: 3 },
  { what: "the mic face", color: [WORK, '.rl-send[data-send="mic"]'], background: [WORK, '.rl-send[data-send="mic"]'], on: BOTH, min: 3 },
  { what: "the mic, listening", color: [WORK, ".rl-send[data-listening]"], background: [WORK, ".rl-send[data-listening]"], on: "color-paper", min: 3 },
  { what: "the docked chat's sentence", color: [APP, ".rl-fd-input"], background: [APP, ".rl-fd-island"], on: "color-paper" },
  { what: "the docked chat's placeholder", color: [APP, ".rl-fd-input::placeholder"], background: [APP, ".rl-fd-island"], on: "color-paper" },
  { what: "a composer menu in the docked chat's footer", color: [MENU, ".rl-composer-chip"], under: [[APP, ".rl-fd-island"]], background: [MENU, ".rl-composer-chip"], on: "color-paper" },
  { what: "the docked chat's + and mic", color: [APP, ".rl-fd-tool"], under: [[APP, ".rl-fd-island"]], background: [APP, ".rl-fd-tool"], on: "color-paper", min: 3 },
  { what: "the page chat's sentence", color: [PAGE, ".rb-capsule-field"], background: [PAGE, ".rb-capsule"], on: "color-paper" },
  { what: "the page chat's placeholder", color: [PAGE, ".rb-capsule-field::placeholder"], background: [PAGE, ".rb-capsule"], on: "color-paper" },
  { what: "the page chat's note over its field", color: [PAGE, ".rb-capsule-note"], background: [PAGE, ".rb-capsule"], on: "color-paper" },
  { what: "the page chat's model, in its footer", color: [BROWSER, ".rb-harness-chip"], under: [[PAGE, ".rb-capsule"]], background: [BROWSER, ".rb-harness-chip"], on: "color-paper" },
  { what: "the page chat's model under the pointer", color: [BROWSER, ".rb-harness-chip:hover"], under: [[PAGE, ".rb-capsule"]], background: [BROWSER, ".rb-harness-chip:hover"], on: "color-paper" },
  { what: "the page chat's +", color: [PAGE, ".rb-capsule-plus"], background: [PAGE, ".rb-capsule"], on: "color-paper", min: 3 },
  { what: "a context chip", color: [PAGE, ".rb-chip"], under: [[PAGE, ".rb-capsule"]], background: [PAGE, ".rb-chip"], on: "color-paper" },
  { what: "a context chip's ×", color: [PAGE, ".rb-chip-x"], background: [PAGE, ".rb-chip"], on: "color-paper", min: 3 },
  { what: "the page chat's header: the page", color: [PAGE, ".rb-chat-title"], background: [BROWSER, ".rb-thread-tools"], on: "color-paper" },
  { what: "the page chat's header: where it is", color: [PAGE, ".rb-chat-title span + span"], background: [BROWSER, ".rb-thread-tools"], on: "color-paper" },
  { what: "the header's linked, ⋯ and ×", color: [BROWSER, ".rb-icon-button"], background: [BROWSER, ".rb-thread-tools"], on: "color-paper", min: 3 },
  { what: "a rail pill", color: [PAGE, ".rb-rail-pill"], background: [PAGE, ".rb-rail-pill"], on: "color-paper" },
  { what: "a rail tray", color: [PAGE, ".rb-tray-body"], background: [PAGE, ".rb-tray"], on: "color-paper" },
  { what: "a reply's work row", color: [PAGE, ".rb-work"], on: "color-paper" },
  { what: "a new chat's tip", color: [PAGE, ".rb-tip"], on: "color-paper" },
  { what: "a new chat's suggestion", color: [PAGE, ".rb-suggestion"], background: [PAGE, ".rb-suggestion"], on: "color-paper" },
  { what: "a new chat's suggestion under the pointer", color: [PAGE, ".rb-suggestion"], under: [[PAGE, ".rb-suggestion"]], background: [PAGE, ".rb-suggestion:hover"], on: "color-paper" },
  { what: "the header's linked, on", color: [BROWSER, '.rb-icon-button[aria-pressed="true"]'], under: [[BROWSER, ".rb-thread-tools"]], background: [BROWSER, '.rb-icon-button[aria-pressed="true"]'], on: "color-paper", min: 3 },
  { what: "the rail tray's Synthesize", color: [BROWSER, ".rb-button-primary"], background: [BROWSER, ".rb-button-primary"], on: "color-bg-elevated" },
  { what: "the chat's mode chip, in build", color: [WORK, ".rl-chat-mode-chip.is-build"], background: [WORK, ".rl-chat-mode-picker button"], on: BOTH },
  { what: "the build mode's warning", color: [WORK, ".rl-chat-build-warning"], on: BOTH },
  // Inline styles, held to these tokens by the scan below: the mission
  // chat's Synthesize and Save, a comment discussion's Attach and Update,
  // its entry row, its flags and the chat header's context links.
  { what: "a label on an info fill", color: "var(--color-on-info)", background: "var(--color-info)", on: "color-paper" },
  { what: "a label on a warning fill", color: "var(--color-on-warning)", background: "var(--color-warning)", on: "color-bg-elevated" },
  { what: "the info accent as text", color: "var(--color-info-text)", on: BOTH },
  { what: "the warning accent as text", color: "var(--color-warning-text)", on: BOTH },
];

const HINT = "components/plan/ContextHint.css";
const HINT_TEXTS: Pair[] = [
  // ContextHint: the plan panel's footer is on the paper; elsewhere a hint
  // may sit on the window or a raised card.
  { what: "a context hint", color: [HINT, ".rl-context-hint"], on: ["color-paper", "color-canvas", "color-bg-elevated"] },
];

describe("the context hint is legible in every theme", () => {
  it("reads every rule it checks", () => readsEveryRule(HINT_TEXTS));

  it.each(THEMES.map((theme) => [theme.name, theme] as const))("%s: every text reaches 4.5:1, every icon 3:1", (_name, theme) => {
    expect(shortfalls(HINT_TEXTS, tokensOf(theme))).toEqual([]);
  });
});

/** The chat surfaces that style their chrome inline. */
const INLINE_CHAT = ["ChatRoom", "BrowserChat", "BrowserChatParts", "MissionChat", "MemoryAsk", "CommentThread", "DrafterSidecar", "ReviewThread", "ChatContextChip", "ChatModePicker", "TurnNotes", "ReplyBlock", "QueueTray", "SendStopButton", "MonochatTrace"];

const fillOf = (rule: Rule | string) => typeof rule === "string" ? rule : declared(...rule, "background") ?? declared(...rule, "background-color");
const colorOf = (color: Pair["color"]) => typeof color === "string" ? color : declared(...color, "color");

/** Every pair under its floor in one theme, with its ratio. */
function shortfalls(pairs: readonly Pair[], tokens: Record<string, string>): string[] {
  const short: string[] = [];
  for (const { what, color, opacity, under = [], background, on, min = 4.5 } of pairs) {
    for (const surface of typeof on === "string" ? [on] : on) {
      let ground = evaluate(`var(--${surface})`, tokens);
      for (const layer of [...under, ...(background ? [background] : [])]) ground = over(evaluate(fillOf(layer)!, tokens), ground);
      const ink = evaluate(colorOf(color)!, tokens);
      const fade = opacity ? Number(declared(...opacity, "opacity") ?? 1) : 1;
      const ratio = contrast(over([ink[0], ink[1], ink[2], ink[3] * fade], ground), ground);
      if (ratio < min) short.push(`${what}${surface === "color-paper" ? "" : surface === "color-canvas" ? " (hull)" : " (raised)"}: ${ratio.toFixed(2)}`);
    }
  }
  return short;
}

function readsEveryRule(pairs: readonly Pair[]) {
  for (const { what, color, under = [], background, opacity } of pairs) {
    expect(colorOf(color), `${what}: no colour on ${color[1]}`).not.toBeNull();
    for (const layer of [...under, ...(background ? [background] : [])]) expect(fillOf(layer), `${what}: no background on ${layer[1]}`).not.toBeNull();
    if (opacity) expect(declared(...opacity, "white-space"), `${what}: no rule ${opacity[1]}`).not.toBeNull();
  }
  expect(THEMES).toHaveLength(15);
}

/** The door's own custom properties, declared on its room and read like a
 *  theme's tokens: `--fd-item` is the recents' ink, `--fd-quiet` their heads'
 *  and a page's host's. */
const ROOM_TOKENS: Record<string, string> = { "fd-item": declared(ISLAND, ".rl-monochat", "--fd-item")!, "fd-quiet": declared(ISLAND, ".rl-monochat", "--fd-quiet")! };
const tokensOf = (theme: (typeof THEMES)[number]): Record<string, string> => ({ ...(deriveTokens(theme.base) as unknown as Record<string, string>), ...ROOM_TOKENS });

describe("the door and its card are legible in every theme", () => {
  it("reads every rule it checks", () => {
    readsEveryRule(TEXTS);
    expect(ROOM_TOKENS["fd-item"]).toMatch(/^color-mix\(/);
    expect(ROOM_TOKENS["fd-quiet"]).toBe("var(--color-ink-quiet)");
  });

  // Three levels in every theme: the heads and a page's host step back from
  // the titles they label. Where the muted ink has to be the full ink to read
  // on a raised card (Redline, Novel, Ocean, Red Sand), the heads were the
  // titles' own colour and the recents read as one block.
  it.each(THEMES.map((theme) => [theme.name, theme] as const))("%s: the recents' heads and hosts are quieter than their titles", (_name, theme) => {
    const tokens = tokensOf(theme);
    const ratio = (rule: Rule, surface: Surface) => {
      const ground = evaluate(`var(--${surface})`, tokens);
      return contrast(over(evaluate(colorOf(rule)!, tokens), ground), ground);
    };
    for (const surface of RESTING) {
      const title = ratio([ISLAND, ".rl-monochat .rl-fd-recent.rl-fd-suggestion"], surface);
      for (const quiet of [[ISLAND, ".rl-fd-recent-head"], [ISLAND, ".rl-fd-browse-host"]] as Rule[]) {
        expect(title / ratio(quiet, surface), `${quiet[1]} on ${surface}`).toBeGreaterThanOrEqual(1.15);
      }
    }
  });

  it.each(THEMES.map((theme) => [theme.name, theme] as const))("%s: every text reaches 4.5:1", (_name, theme) => {
    expect(shortfalls(TEXTS, tokensOf(theme))).toEqual([]);
  });

  it("the formula is the standard one", () => {
    // WCAG's own reference points: black on white is 21:1, #767676 on white
    // is the familiar 4.54:1 grey.
    expect(contrast([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrast([0x76, 0x76, 0x76, 1], [255, 255, 255, 1])).toBeCloseTo(4.54, 2);
  });
});

describe("the chat chrome is legible in every theme", () => {
  it("reads every rule it checks", () => readsEveryRule(CHAT));

  it.each(THEMES.map((theme) => [theme.name, theme] as const))("%s: every pair reaches its floor", (_name, theme) => {
    expect(shortfalls(CHAT, tokensOf(theme))).toEqual([]);
  });

  it("holds the accents as text to 4.5:1 without repainting them where they already read", () => {
    // Silver Aerogel's blue on its grey paper was the 2.10:1 byline; Studio's
    // already read, so it keeps its exact hue.
    const silver = tokensOf(THEMES.find((theme) => theme.name === "silveraerogel")!);
    expect(contrast(evaluate("var(--color-info)", silver), evaluate("var(--color-paper)", silver))).toBeLessThan(2.2);
    expect(contrast(evaluate("var(--color-info-text)", silver), evaluate("var(--color-paper)", silver))).toBeGreaterThanOrEqual(4.5);
    const studio = tokensOf(THEMES.find((theme) => theme.name === "studio")!);
    expect(studio["color-info-text"]).toBe(studio["color-info"]);
    expect(studio["color-warning-text"]).toBe(studio["color-warning"]);
  });

  it("paints no accent straight as text, nor white on an accent, in a chat surface's inline styles", () => {
    // White on Studio's blue is 2.8:1 and on its yellow 1.8:1; the raw
    // accents as text fall to 1.6:1 (Silver Aerogel's yellow). The tokens
    // above are the ones held to the floor.
    for (const name of INLINE_CHAT) {
      const source = readFileSync(join(process.cwd(), "src/components", `${name}.tsx`), "utf8");
      expect(source, name).not.toMatch(/\bcolor: "var\(--color-(info|warning|on-accent)\)"/);
    }
    const fills = (name: string) => readFileSync(join(process.cwd(), "src/components", `${name}.tsx`), "utf8").match(/background: "var\(--color-(info|warning)\)",?\s*color: "[^"]+"/g) ?? [];
    expect(fills("MissionChat")).toEqual([
      'background: "var(--color-info)",\n            color: "var(--color-on-info)"',
      'background: "var(--color-info)", color: "var(--color-on-info)"',
    ]);
    expect(fills("CommentThread").map((fill) => fill.replace(/\s+/g, " "))).toEqual(Array(2).fill('background: "var(--color-warning)", color: "var(--color-on-warning)"'));
  });
});

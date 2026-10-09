// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Perf rule 6, "Paint is a budget too" (docs/perf-budget.md), asserted at the
// source.
//
// The default theme's plate border animated `background-position` on four
// pane-sized layers, forever. The compositor cannot animate that, so WebKit's
// GPU process repainted the gradients every frame at ~100% CPU and every
// keystroke's layer commit queued behind it — the app felt janky with nothing
// on screen moving that anyone would notice. This scan resolves every
// `animation` in src/ to the properties its @keyframes touch, and fails when
// an infinite animation, or one running longer than 300 ms, animates anything
// the compositor can't: only transform and opacity (and the individual
// transform properties) move without a repaint.
//
// A finite one-shot may exceed the 300 ms line only through ALLOWLIST, with a
// reason and a ceiling. An infinite paint animation has no allowlist: a
// steady-state repaint has no acceptable size.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(process.cwd(), "src");

/** Animated properties the compositor applies without repainting. */
const COMPOSITOR = new Set(["transform", "opacity", "translate", "rotate", "scale"]);

/** Longest duration any animation may run while animating a paint property. */
const PAINT_MS = 300;

/** Finite paint animations allowed past PAINT_MS. Each is bounded: one run on
 *  a click or a gesture, then the element is static again. */
const ALLOWLIST: Record<string, { maxMs: number; reason: string }> = {
  "rl-focus-flash-kf": {
    maxMs: 1200,
    reason:
      "one 1.2 s background fade on the comment highlight or block a focus gesture scrolled to — a text-run-sized box, painted for its run and never again",
  },
  "rl-tile-hail": {
    maxMs: 1600,
    reason:
      "one inset-glow bloom (`1 both`) on a terminal tile or sidebar row that was just pointed at — one element, one run, answering a click",
  },
  "rl-snap-glow": {
    maxMs: 320,
    reason:
      "one 320 ms ring on each plate acknowledging the deliberate snap-back gesture; the only plate-sized paint animation, and it ends",
  },
};

/** Properties that may appear in a keyframe without being animated. */
const KEYFRAME_META = new Set(["animation-timing-function", "animation-composition"]);

const SHORTHAND_KEYWORDS = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "forwards", "backwards", "both", "running", "paused", "linear", "ease",
  "ease-in", "ease-out", "ease-in-out", "step-start", "step-end", "initial",
  "inherit", "unset",
]);

interface Source {
  rel: string;
  text: string;
}

interface Usage {
  rel: string;
  line: number;
  where: string;
  name: string;
  /** Milliseconds, or null when the declaration doesn't say (a bare
   *  `animation-name` longhand) — treated as long-running. */
  ms: number | null;
  infinite: boolean;
}

/** Blank out comments without moving any offset, so line numbers stay true. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Index of the `}` closing the block whose `{` is at `open`. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
}

/** Split on commas (or whitespace) that are not inside parentheses. */
function splitTop(value: string, sep: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    const isSep = sep === "," ? ch === "," : /\s/.test(ch);
    if (isSep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every @keyframes name → the union of the properties its frames declare.
 *  A name defined twice (one copy inside a reduced-motion @media) unions. */
function parseKeyframes(sources: Source[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { text } of sources) {
    const css = stripComments(text);
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const body = css.slice(open + 1, blockEnd(css, open));
      const props = out.get(m[1]) ?? new Set<string>();
      for (const frame of body.matchAll(/\{([^{}]*)\}/g)) {
        for (const decl of frame[1].split(";")) {
          const colon = decl.indexOf(":");
          if (colon < 0) continue;
          const prop = decl.slice(0, colon).trim().toLowerCase();
          if (prop && !KEYFRAME_META.has(prop)) props.add(prop);
        }
      }
      out.set(m[1], props);
    }
  }
  return out;
}

function toMs(token: string): number {
  return token.endsWith("ms") ? parseFloat(token) : parseFloat(token) * 1000;
}

/** One entry of an `animation` shorthand list → its name, duration and
 *  whether it loops forever. Unknown words are returned as the name so an
 *  unresolvable reference fails loudly instead of passing silently. */
function parseShorthand(entry: string, known: Map<string, Set<string>>) {
  const tokens = splitTop(entry.replace(/!important/, ""), " ");
  const times = tokens.filter((t) => /^-?[\d.]+m?s$/.test(t));
  const names = tokens.filter(
    (t) =>
      !SHORTHAND_KEYWORDS.has(t) &&
      !t.includes("(") &&
      !/^-?[\d.]+(m?s)?$/.test(t),
  );
  const name = names.find((n) => known.has(n)) ?? names[0] ?? "none";
  return { name, ms: times.length ? toMs(times[0]) : 0, infinite: tokens.includes("infinite") };
}

/** Every animation applied in a stylesheet or an inline style. */
function parseUsages(sources: Source[], known: Map<string, Set<string>>): Usage[] {
  const out: Usage[] = [];
  for (const { rel, text } of sources) {
    const code = stripComments(text);
    if (rel.endsWith(".css")) {
      for (const m of code.matchAll(/(^|[\s;{])animation(-name)?\s*:\s*([^;{}]+)/g)) {
        const at = m.index! + m[1].length;
        const open = code.lastIndexOf("{", at);
        const prev = Math.max(code.lastIndexOf("}", open), code.lastIndexOf("{", open - 1));
        const where = code.slice(prev + 1, open).replace(/\s+/g, " ").trim();
        for (const entry of splitTop(m[3], ",")) {
          const parsed = m[2]
            ? { name: entry.replace(/!important/, "").trim(), ms: null, infinite: false }
            : parseShorthand(entry, known);
          if (parsed.name !== "none") out.push({ rel, line: lineOf(code, at), where, ...parsed });
        }
      }
    } else {
      // Inline styles: `style={{ animation: "redline-flash 0.9s …" }}` and
      // CSS written in template literals.
      for (const m of code.matchAll(/\banimation\s*:\s*(["'`])([^"'`]+)\1/g)) {
        for (const entry of splitTop(m[2], ",")) {
          const parsed = parseShorthand(entry, known);
          if (parsed.name !== "none") {
            out.push({ rel, line: lineOf(code, m.index!), where: "inline style", ...parsed });
          }
        }
      }
    }
  }
  return out;
}

function violations(sources: Source[]): string[] {
  const keyframes = parseKeyframes(sources);
  const out: string[] = [];
  for (const u of parseUsages(sources, keyframes)) {
    const at = `${u.rel}:${u.line} (${u.where}) → ${u.name}`;
    const props = keyframes.get(u.name);
    if (!props) {
      out.push(`${at}: no @keyframes ${u.name} in src/`);
      continue;
    }
    const paint = [...props].filter((p) => !COMPOSITOR.has(p));
    if (paint.length === 0) continue;
    const long = u.infinite || u.ms === null || u.ms > PAINT_MS;
    if (!long) continue;
    const allowed = ALLOWLIST[u.name];
    if (allowed && !u.infinite && u.ms !== null && u.ms <= allowed.maxMs) continue;
    const length = u.infinite ? "infinite" : u.ms === null ? "an unstated duration" : `${u.ms} ms`;
    out.push(`${at}: ${length} animation repaints ${paint.join(", ")}`);
  }
  return out;
}

function sourceFiles(dir: string): Source[] {
  const out: Source[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.css$|(?<!\.test)\.tsx?$/.test(entry.name)) {
      out.push({ rel: relative(SRC_ROOT, p), text: readFileSync(p, "utf8") });
    }
  }
  return out;
}

const sources = sourceFiles(SRC_ROOT);

describe("paint guard (perf rule 6)", () => {
  it("scans the stylesheets and the inline styles", () => {
    const keyframes = parseKeyframes(sources);
    const usages = parseUsages(sources, keyframes);
    // A broken scan passes everything, so prove it sees what it guards.
    expect(sources.filter((s) => s.rel.endsWith(".css")).length).toBeGreaterThan(5);
    expect(keyframes.get("rl-aurora-dawn")).toEqual(new Set(["opacity"]));
    expect(usages.some((u) => u.rel === "components/FlashOverlay.tsx" && u.name === "redline-flash")).toBe(true);
  });

  it("no infinite or long animation repaints — only transform and opacity move", () => {
    expect(violations(sources)).toEqual([]);
  });

  it("every allowlist entry is a live, reasoned, finite one-shot", () => {
    const keyframes = parseKeyframes(sources);
    const usages = parseUsages(sources, keyframes);
    for (const [name, { maxMs, reason }] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${name} needs a written reason`).toBeGreaterThan(40);
      const paints = [...(keyframes.get(name) ?? [])].some((p) => !COMPOSITOR.has(p));
      expect(paints, `${name} no longer paints — drop it from the allowlist`).toBe(true);
      const uses = usages.filter((u) => u.name === name);
      expect(uses.length, `${name} is no longer used — drop it from the allowlist`).toBeGreaterThan(0);
      expect(
        uses.some((u) => u.ms !== null && u.ms > PAINT_MS),
        `${name} runs under ${PAINT_MS} ms everywhere — it needs no allowlist entry`,
      ).toBe(true);
      expect(maxMs).toBeGreaterThan(PAINT_MS);
    }
  });

  it("the Aurora edge light only crossfades two static rings", () => {
    const styles = sources.find((s) => s.rel === "styles.css")!.text;
    const keyframes = parseKeyframes([{ rel: "styles.css", text: styles }]);
    const plate = parseUsages([{ rel: "styles.css", text: styles }], keyframes).filter((u) =>
      u.where.startsWith('html[data-theme="aurora"] .rl-plate'),
    );
    expect(plate.map((u) => u.name).sort()).toEqual(["rl-aurora-dawn", "rl-aurora-dusk"]);
    for (const u of plate) expect(keyframes.get(u.name)).toEqual(new Set(["opacity"]));
    // Focus brightens the rings through their own custom property. Set on the
    // plate, the same toggle would restyle the plate's whole subtree.
    const edgeRules = [...stripComments(styles).matchAll(/([^{}]+)\{[^{}]*--rl-aurora-edge\s*:/g)];
    expect(edgeRules.length).toBeGreaterThanOrEqual(2);
    for (const [, selector] of edgeRules) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/::(before|after)$/);
    }
  });

  it("would have caught the original Aurora plate border", () => {
    // The rule as it shipped in 9fe59d7, the one `sample` caught repainting.
    const original = `
      html[data-theme="aurora"] .rl-plate::after {
        background-size: 280% 280%;
        animation: rl-aurora-horizon 22s ease-in-out infinite;
      }
      @keyframes rl-aurora-horizon {
        0%, 100% { background-position: 0% 30%; transform: scale(1); }
        50% { background-position: 100% 70%; transform: scale(1.0015); }
      }`;
    expect(violations([{ rel: "styles.css", text: original }])).toEqual([
      'styles.css:4 (html[data-theme="aurora"] .rl-plate::after) → rl-aurora-horizon: infinite animation repaints background-position',
    ]);
  });

  it("parses the shorthand the way the stylesheet writes it", () => {
    const css = (body: string) => [
      {
        rel: "a.css",
        text: `
          @keyframes fade { to { opacity: 0; } }
          @keyframes tint { 50% { background: red; animation-timing-function: ease-in; } }
          @media (prefers-reduced-motion: reduce) { @keyframes grow { to { width: 2px; } } }
          .x { ${body} }`,
      },
    ];
    // Commas inside timing functions don't split the list.
    expect(violations(css("animation: fade 2s cubic-bezier(0.2, 0, 0, 1) infinite, tint 200ms steps(2, jump-none);"))).toEqual([]);
    // A short paint animation is fine; a long or endless one is not.
    expect(violations(css("animation: tint 0.3s ease-out;"))).toEqual([]);
    expect(violations(css("animation: tint 0.6s ease-out;"))).toHaveLength(1);
    expect(violations(css("animation: 1s infinite tint;"))).toHaveLength(1);
    // Keyframes declared inside an at-rule still resolve.
    expect(violations(css("animation: grow 1s;"))[0]).toContain("repaints width");
    // A bare animation-name has no duration to vouch for it.
    expect(violations(css("animation-name: tint;"))).toHaveLength(1);
    // A typo can't pass by resolving to nothing.
    expect(violations(css("animation: fdae 2s infinite;"))[0]).toContain("no @keyframes fdae");
    expect(violations(css("animation: none;"))).toEqual([]);
  });

  it("reads inline animations in components", () => {
    const sources = [
      { rel: "k.css", text: "@keyframes pulse { 50% { box-shadow: 0 0 4px red; } }" },
      { rel: "C.tsx", text: 'const s = { animation: "pulse 1.6s ease-in-out infinite" };' },
    ];
    expect(violations(sources)).toEqual([
      "C.tsx:1 (inline style) → pulse: infinite animation repaints box-shadow",
    ]);
  });
});

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
// transform properties) move without a repaint. Web Animations calls
// (`el.animate(…)`) are read the same way, and so are the package stylesheets
// src imports — whose endless animations must stay switched off.
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
  springInKeyframes: {
    maxMs: 620,
    reason:
      "the island-to-surface spring (SpringSwap): once per swap, the corners ease 18 → 24 → 14 px while the transform carries the motion",
  },
};

/** Package stylesheets' endless paint animations, by @keyframes name: the
 *  rule isn't ours to edit, so it passes only while no file using the package
 *  sets the switch that starts it. */
const PACKAGE_SWITCHES: Record<string, { pkg: string; on: RegExp; reason: string }> = {
  dashdraw: {
    pkg: "@xyflow/react",
    on: /\banimated\b/,
    reason:
      "React Flow's `animated` edge marches its dash (stroke-dashoffset) forever; the Runs canvas tints a live edge instead",
  },
};

/** `.animate(` calls that are not the Web Animations API. */
const NOT_WAAPI: Record<string, string> = {
  "components/memory-cosmos/scene.ts":
    "Planet.animate(t) steps a WebGL mesh by the scene clock; no element animates",
};

/** Properties that may appear in a keyframe without being animated. */
const KEYFRAME_META = new Set(["animation-timing-function", "animation-composition"]);
/** The same, for a Web Animations keyframe object. */
const WAAPI_META = new Set(["offset", "easing", "composite"]);

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
  /** A Web Animations call's own keyframe properties, or null when its
   *  keyframes can't be read; absent for a CSS animation (see `name`). */
  props?: Set<string> | null;
}

/** Blank out comments without moving any offset, so line numbers stay true. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** The same, plus `//` line comments — scripts only, where they exist. */
function stripScriptComments(text: string): string {
  return stripComments(text).replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Split on commas (or whitespace) that are not inside any bracket. */
function splitTop(value: string, sep: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
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
      const body = css.slice(open + 1, closeOf(css, open) - 1);
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
  const vars = tokens.filter((t) => t.startsWith("var("));
  const name = names.find((n) => known.has(n)) ?? names[0] ?? vars[0] ?? "none";
  // A duration behind var() is unknown, so it counts as long.
  const ms = times.length ? toMs(times[0]) : vars.length ? null : 0;
  return { name, ms, infinite: tokens.includes("infinite") };
}

/** Every Web Animations call, `el.animate(keyframes, options)`, read for what
 *  its keyframes animate. The keyframes must be an array literal or a call to
 *  a `function …(): Keyframe[]` in src; anything else can't be read, which
 *  fails rather than passing unseen. */
function parseScriptAnimations(sources: Source[]): Usage[] {
  const scripts = sources
    .filter((s) => !s.rel.endsWith(".css"))
    .map((s) => ({ rel: s.rel, code: stripScriptComments(s.text) }));
  const find = (pattern: RegExp) => {
    for (const { code } of scripts) {
      const m = pattern.exec(code);
      if (m) return { code, m };
    }
    return null;
  };
  const builder = (name: string) => {
    const hit = find(new RegExp(`function ${name}\\([^)]*\\)\\s*:\\s*Keyframe\\[\\]\\s*\\{`));
    if (!hit) return null;
    const open = hit.m.index + hit.m[0].length - 1;
    return hit.code.slice(open, closeOf(hit.code, open));
  };
  // A number, or a `const NAME = <number>;` anywhere in src; else unknown.
  const durationMs = (options: string): number | null => {
    const value = /^[\d.]+$/.test(options)
      ? options
      : (/\bduration\s*:\s*([^,}]+)/.exec(options)?.[1].trim() ?? "0");
    if (/^[\d.]+$/.test(value)) return Number(value);
    const constant = /^\w+$/.test(value) ? find(new RegExp(`\\bconst ${value}\\s*=\\s*([\\d.]+)\\s*;`)) : null;
    return constant ? Number(constant.m[1]) : null;
  };
  const out: Usage[] = [];
  for (const { rel, code } of scripts) {
    if (rel in NOT_WAAPI) continue;
    for (const m of code.matchAll(/\.animate\(/g)) {
      const open = m.index! + m[0].length - 1;
      const [frames = "", options = ""] = splitTop(code.slice(open + 1, closeOf(code, open) - 1), ",");
      const call = /^(\w+)\(/.exec(frames)?.[1];
      const body = frames.startsWith("[") ? frames : call ? builder(call) : null;
      out.push({
        rel,
        line: lineOf(code, m.index!),
        where: "element.animate()",
        name: call ?? (body ? "keyframes literal" : frames),
        ms: durationMs(options),
        infinite: /\biterations\s*:\s*Infinity\b/.test(options),
        props:
          body === null
            ? null
            : new Set(
                [...body.matchAll(/[{,]\s*(\w+)\s*:/g)]
                  .map((k) => k[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
                  .filter((p) => !WAAPI_META.has(p)),
              ),
      });
    }
  }
  return out;
}

/** Every animation applied in a stylesheet, an inline style or a script. */
function parseUsages(sources: Source[], known: Map<string, Set<string>>): Usage[] {
  const out: Usage[] = [];
  for (const { rel, text } of sources) {
    if (rel.endsWith(".css")) {
      const code = stripComments(text);
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
      const code = stripScriptComments(text);
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
  return [...out, ...parseScriptAnimations(sources)];
}

function violations(sources: Source[]): string[] {
  const keyframes = parseKeyframes(sources);
  const out: string[] = [];
  for (const u of parseUsages(sources, keyframes)) {
    const at = `${u.rel}:${u.line} (${u.where}) → ${u.name}`;
    if (u.props === null) {
      out.push(`${at}: can't read what it animates — pass an array literal or a function returning Keyframe[]`);
      continue;
    }
    const props = u.props ?? keyframes.get(u.name);
    if (!props) {
      out.push(
        u.name.startsWith("var(")
          ? `${at}: an animation named through var() can't be checked — name its @keyframes`
          : `${at}: no @keyframes ${u.name} in src/`,
      );
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

/** The package stylesheets src imports (`import "pkg/….css"`). */
function packageSheets(sources: Source[]): Source[] {
  const specs = new Set<string>();
  for (const { rel, text } of sources) {
    if (rel.endsWith(".css")) continue;
    for (const m of stripScriptComments(text).matchAll(/\bimport\s+["']([^"'.][^"']*\.css)["']/g)) {
      specs.add(m[1]);
    }
  }
  return [...specs].map((spec) => ({
    rel: spec,
    text: readFileSync(join(process.cwd(), "node_modules", spec), "utf8"),
  }));
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
      const uses = usages.filter((u) => u.name === name);
      expect(uses.length, `${name} is no longer used — drop it from the allowlist`).toBeGreaterThan(0);
      const props = uses[0].props ?? keyframes.get(name) ?? [];
      const paints = [...props].some((p) => !COMPOSITOR.has(p));
      expect(paints, `${name} no longer paints — drop it from the allowlist`).toBe(true);
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
    // Nor can a name or a duration hide behind var().
    expect(violations(css("animation: var(--rl-anim);"))[0]).toContain("named through var()");
    expect(violations(css("animation: tint var(--rl-ms);"))[0]).toContain("an unstated duration");
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

  it("reads Web Animations calls, through their keyframe builders", () => {
    const waapi = parseUsages(sources, parseKeyframes(sources)).filter(
      (u) => u.where === "element.animate()",
    );
    const spring = waapi.filter((u) => u.name === "springInKeyframes");
    expect(spring.map((u) => u.rel).sort()).toEqual(["components/SpringSwap.tsx"]);
    for (const u of spring) {
      expect(u.props).toEqual(new Set(["transform", "opacity", "border-radius"]));
      expect(u.ms).toBe(620);
    }
    expect(waapi.find((u) => u.rel === "lib/browserTabDrag.ts")).toMatchObject({
      name: "keyframes literal",
      ms: 160,
      props: new Set(["transform"]),
    });
    // An exemption outlives its reason only until the call it excused is gone.
    for (const rel of Object.keys(NOT_WAAPI)) {
      expect(sources.find((s) => s.rel === rel)?.text, `${rel} no longer calls .animate(`).toContain(".animate(");
    }
  });

  it("the island's flights move by transform and opacity alone; its corners settle inside 300 ms", () => {
    // The 10/10 motion spec: the card's 420 ms spring, the door's 380 ms grow
    // and 260 ms fall back toward the pill. Nothing in them is allowlisted.
    const waapi = parseUsages(sources, parseKeyframes(sources)).filter(
      (u) => u.where === "element.animate()" && /components\/Monochat(Card|Island)\.tsx$/.test(u.rel),
    );
    expect(waapi.length).toBeGreaterThanOrEqual(10);
    for (const u of waapi) {
      const paint = [...(u.props ?? [])].filter((p) => !COMPOSITOR.has(p));
      if (paint.length) expect(u.ms, `${u.rel}:${u.line} repaints ${paint.join(", ")}`).not.toBeNull();
      if (paint.length) expect(u.ms!, `${u.rel}:${u.line}`).toBeLessThanOrEqual(PAINT_MS);
      expect(ALLOWLIST[u.name], `${u.rel}:${u.line} leans on the allowlist`).toBeUndefined();
    }
  });

  it("fails a Web Animations call that repaints, or that it can't read", () => {
    const script = (call: string) => [
      {
        rel: "W.ts",
        text: `const SLOW = 900;
          function grow(): Keyframe[] { return [{ width: "0px" }, { width: "9px", offset: 1 }]; }
          ${call}`,
      },
    ];
    expect(violations(script("el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLOW });"))).toEqual([]);
    expect(violations(script('el.animate([{ backgroundColor: "red" }], 200);'))).toEqual([]);
    expect(violations(script("el.animate(grow(), { duration: SLOW });"))).toEqual([
      "W.ts:3 (element.animate()) → grow: 900 ms animation repaints width",
    ]);
    expect(
      violations(script('el.animate([{ boxShadow: "0 0 4px red" }], { duration: 90, iterations: Infinity });')),
    ).toEqual(["W.ts:3 (element.animate()) → keyframes literal: infinite animation repaints box-shadow"]);
    // Commented out is not applied.
    expect(violations(script("// el.animate(grow(), 900);"))).toEqual([]);
    expect(violations(script("el.animate(frames, 400);"))[0]).toContain("can't read what it animates");
  });

  it("a package stylesheet's endless paint animation stays switched off", () => {
    const sheets = packageSheets(sources);
    const keyframes = parseKeyframes(sheets);
    const endless = parseUsages(sheets, keyframes).filter(
      (u) => u.infinite && [...(keyframes.get(u.name) ?? [])].some((p) => !COMPOSITOR.has(p)),
    );
    // React Flow's marching edge dash: proof the package scan sees anything.
    expect(endless.map((u) => u.name)).toContain("dashdraw");
    for (const { rel, name } of endless) {
      const sw = PACKAGE_SWITCHES[name];
      expect(sw, `${rel} animates ${name} forever — list the switch that starts it`).toBeDefined();
      expect(sw.reason.length).toBeGreaterThan(40);
      const flipped = sources.filter(
        (s) => s.text.includes(`from "${sw.pkg}"`) && sw.on.test(stripScriptComments(s.text)),
      );
      expect(flipped.map((s) => s.rel), `${name}: ${sw.reason}`).toEqual([]);
    }
  });
});

// ── SVG stays still ───────────────────────────────────────────────────────
//
// A transform animation is compositor-only on an HTML element. Inside an
// <svg> it is not: WebKit's legacy SVG engine lays out and repaints a
// transformed <g>, <path> or <line> on the main thread every frame, and the
// repaint takes the layer it sits in — a glass pill, a sidebar row — with it.
// Measured 2026-10-27: six marks spinning an inner <g> held the GPU process at
// 7% and 250 MB; the same six as HTML rings cost 0.1%. The svg root itself is
// banned with its children, for one rule that needs no engine knowledge: a
// spinner is an HTML element (components/Spinner.tsx), never an svg.

const SVG_TAGS = new Set([
  "svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "use", "text", "tspan",
  "image", "symbol", "defs", "clipPath", "mask", "marker", "pattern", "linearGradient", "radialGradient", "stop",
  "foreignObject",
]);

/** The class names any stylesheet rule animates (`animation` or
 *  `animation-name`, other than `none`), each with where it is declared, and
 *  the selectors that animate an SVG element by tag. Innermost blocks only,
 *  so a rule under @media keeps its own selector. */
function animatedSelectors(sources: Source[]): { classes: Map<string, string>; tagged: string[] } {
  const classes = new Map<string, string>();
  const tagged: string[] = [];
  const tag = new RegExp(`(^|[\\s>+~,])(${[...SVG_TAGS].join("|")})(?=$|[\\s>+~,.:#[])`);
  for (const { rel, text } of sources) {
    if (!rel.endsWith(".css")) continue;
    const css = stripComments(text);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[\s;])animation(-name)?\s*:(?!\s*none\b)/.test(m[2])) continue;
      const selector = m[1].trim();
      if (/^(from|to|\d+%)/.test(selector) || selector.startsWith("@")) continue;
      const where = `${rel}:${lineOf(css, m.index! + m[1].search(/\S/))}`;
      for (const cls of selector.matchAll(/\.([\w-]+)/g)) if (!classes.has(cls[1])) classes.set(cls[1], where);
      for (const part of selector.split(",")) if (tag.test(part.trim())) tagged.push(`${where}: \`${part.trim()}\` animates an SVG element`);
    }
  }
  return { classes, tagged };
}

/** The attribute text of the JSX tag opening at `from` (just past its name),
 *  up to its `>` — braces and strings skipped, so an arrow in a handler
 *  doesn't end it early. */
function tagAttrs(code: string, from: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return code.slice(from, i);
  }
  return null;
}

/** Every class a tag's `className` can carry: a string literal, or each
 *  string literal inside an expression (`cond ? "a" : "b"`, a template). */
function classesOf(attrs: string): string[] {
  const m = /\bclassName\s*=\s*/.exec(attrs);
  if (!m) return [];
  const rest = attrs.slice(m.index + m[0].length);
  if (rest[0] === '"' || rest[0] === "'") return rest.slice(1, rest.indexOf(rest[0], 1)).split(/\s+/).filter(Boolean);
  if (rest[0] !== "{") return [];
  const expr = rest.slice(1, closeOf(rest, 0) - 1);
  const out: string[] = [];
  for (const lit of expr.matchAll(/["'`]((?:[^"'`\\]|\\.)*)["'`]/g)) {
    out.push(...lit[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean));
  }
  return out;
}

/** The icon components a file imports from lucide-react: each renders an
 *  <svg>, so a class on one is a class on an svg. */
function lucideNames(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const name of m[1].split(",")) {
      const local = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) out.add(local);
    }
  }
  return out;
}

function svgAnimationViolations(sources: Source[]): string[] {
  const { classes, tagged } = animatedSelectors(sources);
  const out = [...tagged];
  for (const { rel, text } of sources) {
    if (!/\.tsx?$/.test(rel)) continue;
    const code = stripScriptComments(text);
    const icons = lucideNames(code);
    for (const m of code.matchAll(/<([A-Za-z][\w.]*)(?=[\s/>])/g)) {
      const name = m[1];
      if (!SVG_TAGS.has(name) && !icons.has(name)) continue;
      const attrs = tagAttrs(code, m.index! + m[0].length);
      if (attrs === null) continue;
      const at = `${rel}:${lineOf(code, m.index!)} <${name}>`;
      if (/\banimation(Name)?\s*:/.test(attrs)) out.push(`${at}: animated inline — an SVG element repaints every frame it moves; animate an HTML element instead`);
      for (const cls of classesOf(attrs)) {
        const where = classes.get(cls);
        if (where) out.push(`${at}: wears .${cls}, which ${where} animates — an SVG element repaints every frame it moves; spin an HTML element (Spinner) instead`);
      }
    }
  }
  return out;
}

describe("paint guard: SVG stays still", () => {
  it("never animates an <svg>, anything inside one, or an icon component", () => {
    expect(svgAnimationViolations(sources)).toEqual([]);
  });

  it("would have caught the old spinners: a lucide icon wearing a spin class, and the mark's inner <g>", () => {
    const css = {
      rel: "a.css",
      text: `@keyframes turn { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: no-preference) { .row-spin { animation: turn 1.1s linear infinite; } }
        .mark-blades[data-state="thinking"] { animation: turn 1.2s linear infinite; }
        .still { animation: none; }
        .rl-fold svg[data-open] { transform: rotate(180deg); }`,
    };
    const tsx = {
      rel: "a.tsx",
      text: `import { LoaderCircle as Loader, Hammer } from "lucide-react";
        const a = <Loader size={14} className={busy ? "row-spin" : undefined} onClick={() => x > 1} />;
        const b = <svg><g className="mark-blades" data-state={s}><line x1={1} /></g></svg>;
        const c = <span className="row-spin" />;
        const d = <Hammer className="still" />;
        const e = <svg className={\`icon \${tone}\`} />;`,
    };
    expect(svgAnimationViolations([css, tsx])).toEqual([
      expect.stringContaining("a.tsx:2 <Loader>: wears .row-spin, which a.css:2 animates"),
      expect.stringContaining("a.tsx:3 <g>: wears .mark-blades, which a.css:3 animates"),
    ]);
  });

  it("flags a stylesheet that animates an svg by tag, and an inline animation on one", () => {
    const css = { rel: "b.css", text: `.row svg { animation: turn 1s linear infinite; }\n.row path, .ok { animation-name: turn; }` };
    const tsx = { rel: "b.tsx", text: `const a = <circle style={{ animation: "turn 1s linear infinite" }} />;` };
    expect(svgAnimationViolations([css, tsx])).toEqual([
      expect.stringContaining("b.css:1: `.row svg` animates an SVG element"),
      expect.stringContaining("b.css:2: `.row path` animates an SVG element"),
      expect.stringContaining("b.tsx:1 <circle>: animated inline"),
    ]);
  });
});

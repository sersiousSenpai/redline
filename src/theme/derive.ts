// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Terminal.app themes only define background, foreground, and an ANSI-16
// palette. We store the minimum (bg / fg / blue / yellow / green) per theme and
// derive the full Redline token set deterministically here.

export interface ThemeBase {
  bg: string;
  fg: string;
  blue: string;
  yellow: string;
  green: string;
  red?: string;
  // A vibrant, high-visibility hue for text selection / comment highlights,
  // hand-picked per theme to contrast strongly with that theme's background.
  selection: string;
}

type FlowToken = `color-fill-${1 | 2 | 3}` | "color-rule-strong" | "color-focus-rim"
  | `color-ink-${2 | 3 | 4 | 5}` | `color-mode-${"plan" | "redline" | "build" | "danger"}-${"fg" | "bg"}`
  | `color-glass-${1 | 2 | 3}` | "color-glass-rim-hi" | "color-glass-rim-lo" | "color-glass-shadow"
  | "color-ambient-a" | "color-ambient-b";
export interface ThemeTokens extends Record<FlowToken, string> {
  "color-paper": string;
  "color-ink": string;
  "color-ink-muted": string;
  /** Secondary text read only on the page and the hull, never on a raised
   *  surface: the Front Door's recents heads and a page's host. Where the
   *  muted ink has to stay at full ink to read on raised cards (Redline,
   *  Novel, Ocean, Red Sand), this one still steps back from it. */
  "color-ink-quiet": string;
  "color-rule": string;
  /** The hull: the canvas visible in the shell's gutters and edge ring, a step
   *  behind the paper so the panes read as inset plates on it. */
  "color-canvas": string;
  /** Plate hairline — quieter than --color-rule (a rule separates content
   *  regions; this merely finds the plate's edge against the canvas). */
  "color-plate-border": string;
  /** Corner-glow accent for plates on dark themes (the Agent-Seats hero
   *  language, at a whisper); transparent on light themes, which get their
   *  depth from shadow alone. Static CSS mixes this into the plate shadow. */
  "color-plate-glow": string;
  "color-anchor-bg": string;
  "color-anchor-text": string;
  "color-info": string;
  "color-warning": string;
  "color-success": string;
  /** The info and warning accents as TEXT (a reply's byline, a stalled
   *  status): the accent itself where it reads at 4.5:1 on the page and the
   *  raised surfaces, else pulled toward the ink until it does. */
  "color-info-text": string;
  "color-warning-text": string;
  "color-bg-elevated": string;
  "color-on-accent": string;
  /** What is drawn on an info fill (the composer's send button) and on a
   *  warning fill (a comment discussion's "Attach to next submit"). */
  "color-on-info": string;
  "color-on-warning": string;
  "color-code-bg": string;
  "color-code-fg": string;
  /** highlight.js token palette. The code surface stays the theme's own, so on
   *  light themes these flip to dark "linting" colors (keeping code legible
   *  without a contrasting code background); dark themes keep light pastels. */
  "color-hl-comment": string;
  "color-hl-keyword": string;
  "color-hl-string": string;
  "color-hl-number": string;
  "color-hl-title": string;
  "color-hl-variable": string;
  "color-hl-deletion": string;
  /** The wash under a control the pointer is on: 7% of the ink, or less on
   *  a theme whose ink would read under 4.5:1 through it. */
  "color-hover-wash": string;
  "color-commented-bg": string;
  "color-commented-bar": string;
  "color-selection": string;
  "color-overlay": string;
}

type RGB = [number, number, number];

function parseHex(hex: string): RGB {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: RGB): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Mix color `a` toward color `b` by amount `t` (0 = a, 1 = b).
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex([
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  ]);
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Relative luminance (sRGB, perceptual-ish — deliberately NOT gamma-corrected;
// the theme system's light/dark splits were tuned against this scale, so
// changing it would reclassify mid-luminance themes like Silver Aerogel).
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG-style contrast ratio between two colors (1 = identical, 21 = max).
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// The WCAG 2 contrast ratio proper, the one a conformance check computes: the
// channels come out of sRGB gamma before they are weighed. `contrastRatio`
// skips that step — and stays, because the theme shapes here were tuned on it
// — so the two disagree, most of all on very dark and mid-grey inks.
function wcagContrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = parseHex(hex).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Muted/secondary ink that stays legible on every theme. We want `ink` blended
 * `maxT` of the way toward `surface` (the design's preferred muting), but never
 * so far that it washes out: blending toward the surface monotonically lowers
 * contrast, so we take the largest blend ≤ maxT that still clears `minContrast`.
 *
 * On a well-separated theme (e.g. Studio) the full maxT clears the floor, so the
 * look is unchanged. On a low-contrast theme (Gecko, Silver Aerogel, Grass…)
 * the blend is pulled back toward `ink` only as far as readability requires.
 *
 * `onto` names every surface the color is also read on, checked by the WCAG
 * formula proper: the muted ink sits on raised cards and composers as much as
 * on the page, and there Homebrew and Terminal fell under the floor.
 *
 * An accent used as text is the same search the other way round: the ink
 * blended all the way toward the accent (`maxT` 1) is the accent itself, kept
 * exactly where it reads; where it doesn't — Silver Aerogel's blue is 2.1:1 on
 * its grey paper, Blossom's yellow 1.8:1 — it stays only as close to the
 * accent as `onto` allows. It is not read on itself, so `onSurface` is off.
 */
function mutedInk(
  ink: string,
  surface: string,
  maxT: number,
  minContrast: number,
  onto: string[] = [],
  onSurface = true,
): string {
  const legible = (color: string) =>
    (!onSurface || contrastRatio(color, surface) >= minContrast) &&
    onto.every((s) => wcagContrast(color, s) >= minContrast);
  if (legible(mix(ink, surface, maxT))) return mix(ink, surface, maxT);
  // Binary-search the blend amount; contrast is monotonic in t.
  let lo = 0;
  let hi = maxT;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (legible(mix(ink, surface, mid))) lo = mid;
    else hi = mid;
  }
  return mix(ink, surface, lo);
}

/** How much of the ink a hover wash may carry: up to `maxAlpha`, in whole
 *  percents, while the ink itself still reads at `minContrast` through it on
 *  every surface in `onto`. Red Sand's ink is 4.7:1 on its raised surface, so
 *  the usual 7% wash would take a label under the floor there. */
function hoverAlpha(ink: string, onto: string[], maxAlpha: number, minContrast: number): number {
  for (let percent = Math.round(maxAlpha * 100); percent > 0; percent--) {
    const alpha = percent / 100;
    if (onto.every((s) => wcagContrast(ink, mix(s, ink, alpha)) >= minContrast)) return alpha;
  }
  return 0;
}

/** The first of `candidates` that reads at 4.5:1 on `fill`. Where none does —
 *  Red Sand's dark red paper is 4.2:1 on its light blue — the one that reads
 *  best, taken toward black or white (whichever is further from `fill`) only
 *  as far as 4.5:1 needs: still the theme's colour, and a label can sit on
 *  the fill as well as a glyph. */
function onFill(fill: string, candidates: string[]): string {
  const best = candidates.find((c) => wcagContrast(c, fill) >= 4.5) ??
    candidates.reduce((best, c) => (wcagContrast(c, fill) > wcagContrast(best, fill) ? c : best));
  const extreme = wcagContrast("#000000", fill) > wcagContrast("#ffffff", fill) ? "#000000" : "#ffffff";
  return mutedInk(extreme, best, 1, 4.5, [fill], false);
}

export function deriveTokens(base: ThemeBase): ThemeTokens {
  const { bg, fg } = base;
  const isDark = luminance(bg) < 0.5;

  // White on accent-filled buttons. Not every theme's blue is dark enough for
  // it, so what sits on an info fill is checked (`color-on-info`).
  const onAccent = "#ffffff";

  const anchorBg = mix(bg, fg, 0.12);
  const elevated = mix(bg, fg, 0.07);
  // Dark themes deepen toward black so the paper plates lift off the hull;
  // light themes tint faintly toward ink (going darker would read as a
  // different, muddier palette rather than a recess).
  const canvas = isDark ? mix(bg, "#000000", 0.35) : mix(bg, fg, 0.05);

  // highlight.js token palette. Dark themes keep the warm light-on-dark
  // pastels; light themes use a saturated dark "linting" palette so code reads
  // on the theme's own (light) surface rather than needing a dark code island.
  const hl = isDark
    ? {
        comment: "#7f7d72",
        keyword: "#c9a2f5",
        string: "#a6c98a",
        number: "#e3b367",
        title: "#82aaf0",
        variable: "#d59a78",
        deletion: "#e08b86",
      }
    : {
        comment: "#4b515b",
        keyword: "#7b1fa2",
        string: "#0a5023",
        number: "#0550ae",
        title: "#4423a8",
        variable: "#7a3f00",
        deletion: "#9a1015",
      };

  const fills = [0.04, 0.06, 0.09].map(alpha => mix(bg, fg, hoverAlpha(fg, [bg], alpha, 4.5)));
  const surfaces = [bg, canvas, elevated, ...fills];
  // A mode's ink is its accent wherever that reads at 4.5:1, on its own tint
  // and on the surfaces a status word sits on (the sidebar, the bar, the
  // plate); else the accent taken toward black or white only as far as that
  // needs. Never the plain ink: Basic's amber stays amber, a shade darker.
  const mode = (accent: string) => {
    const fill = mix(bg, accent, isDark ? 0.12 : 0.08);
    const onto = [fill, ...surfaces];
    const extreme = wcagContrast("#000000", fill) > wcagContrast("#ffffff", fill) ? "#000000" : "#ffffff";
    const ink = onto.every((s) => wcagContrast(accent, s) >= 4.5) ? accent : mutedInk(extreme, accent, 1, 4.5, onto, false);
    return { bg: fill, fg: ink };
  };
  const plan = mode(base.blue), redline = mode(base.yellow), build = mode(base.green), danger = mode(base.red ?? hl.deletion);
  return {
    "color-fill-1": fills[0], "color-fill-2": fills[1], "color-fill-3": fills[2],
    "color-rule-strong": mix(bg, fg, 0.23), "color-focus-rim": mix(mix(bg, fg, 0.18), base.blue, 0.28),
    "color-ink-2": mutedInk(fg, bg, 0.08, 4.5, surfaces, false),
    "color-ink-3": mutedInk(fg, bg, 0.25, 4.5, surfaces, false),
    "color-ink-4": mutedInk(fg, bg, 0.45, 4.5, surfaces, false),
    "color-ink-5": mutedInk(fg, bg, 0.6, 4.5, surfaces, false),
    "color-mode-plan-fg": plan.fg, "color-mode-plan-bg": plan.bg,
    "color-mode-redline-fg": redline.fg, "color-mode-redline-bg": redline.bg,
    "color-mode-build-fg": build.fg, "color-mode-build-bg": build.bg,
    "color-mode-danger-fg": danger.fg, "color-mode-danger-bg": danger.bg,
    "color-glass-1": rgba(elevated, isDark ? 0.70 : 0.78),
    "color-glass-2": rgba(elevated, isDark ? 0.62 : 0.72),
    "color-glass-3": rgba(elevated, isDark ? 0.56 : 0.66),
    "color-glass-rim-hi": rgba(fg, isDark ? 0.22 : 0.16),
    "color-glass-rim-lo": rgba(fg, isDark ? 0.07 : 0.06),
    "color-glass-shadow": rgba("#000000", isDark ? 0.35 : 0.12),
    "color-ambient-a": rgba(base.blue, isDark ? 0.08 : 0.04),
    "color-ambient-b": rgba(base.selection, isDark ? 0.06 : 0.03),
    "color-paper": bg,
    "color-ink": fg,
    // Secondary text must stay readable on every theme — not a flat 45% fade
    // (that washed out Gecko / Silver Aerogel / Grass, etc.). 4.5:1 is the
    // WCAG AA floor for body text, on the page and on the raised surfaces it
    // also sits on; well-separated themes are unaffected.
    "color-ink-muted": mutedInk(fg, bg, 0.45, 4.5, [bg, elevated]),
    // The same muting, held to 4.5:1 by the WCAG formula proper on the two
    // surfaces it is read on — the paper (an open door, the plate it rests
    // on) and the hull — and not on raised ones, which is what pins the muted
    // ink at full ink on four themes and flattens the door's recents to one
    // level there.
    "color-ink-quiet": mutedInk(fg, bg, 0.45, 4.5, [bg, canvas], false),
    "color-rule": mix(fg, bg, 0.82),
    "color-canvas": canvas,
    "color-plate-border": mix(fg, bg, 0.85),
    "color-plate-glow": isDark ? base.blue : "transparent",
    "color-anchor-bg": anchorBg,
    // Anchor labels sit on `anchorBg`, not `bg`, and are small UI affordances
    // rather than body text — clamp to the 3:1 UI-component floor against that
    // surface (the old flat 0.42 fade dropped to ~1.7–2.2 on many themes).
    "color-anchor-text": mutedInk(fg, anchorBg, 0.42, 3.0),
    "color-info": base.blue,
    "color-warning": base.yellow,
    "color-success": base.green,
    // Text, so held to the body-text floor on the page and on raised cards
    // (a comment's thread sits on one) — the fills and rules keep the hue.
    "color-info-text": mutedInk(fg, base.blue, 1, 4.5, [bg, elevated], false),
    "color-warning-text": mutedInk(fg, base.yellow, 1, 4.5, [bg, elevated], false),
    "color-bg-elevated": elevated,
    "color-on-accent": onAccent,
    // White, unless the theme's blue is too light for it (Aurora's is
    // 2.0:1): then whichever of the theme's own paper and ink reads there,
    // at 4.5:1 so a button's label can use it too.
    "color-on-info": onFill(base.blue, [onAccent, bg, fg]),
    // White is under 3:1 on twelve themes' yellows.
    "color-on-warning": onFill(base.yellow, [onAccent, bg, fg]),
    // Dark themes get a subtly elevated code surface; light themes keep the
    // code surface equal to the page so the code area looks unified with the
    // rest of the UI and the dark syntax palette reads at full contrast
    // instead of fighting a darker, elevated chip.
    "color-code-bg": isDark ? mix(bg, fg, 0.1) : bg,
    "color-code-fg": fg,
    "color-hl-comment": hl.comment,
    "color-hl-keyword": hl.keyword,
    "color-hl-string": hl.string,
    "color-hl-number": hl.number,
    "color-hl-title": hl.title,
    "color-hl-variable": hl.variable,
    "color-hl-deletion": hl.deletion,
    "color-hover-wash": rgba(fg, hoverAlpha(fg, [bg, elevated], 0.07, 4.5)),
    "color-commented-bg": rgba(base.selection, 0.22),
    "color-commented-bar": rgba(base.selection, 0.85),
    // Dark backgrounds need a punchier overlay to read as vibrant.
    "color-selection": rgba(base.selection, isDark ? 0.55 : 0.42),
    "color-overlay": isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(20, 20, 20, 0.35)",
  };
}

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
  // A vibrant, high-visibility hue for text selection / comment highlights,
  // hand-picked per theme to contrast strongly with that theme's background.
  selection: string;
}

export interface ThemeTokens {
  "color-paper": string;
  "color-ink": string;
  "color-ink-muted": string;
  "color-rule": string;
  "color-anchor-bg": string;
  "color-anchor-text": string;
  "color-info": string;
  "color-warning": string;
  "color-success": string;
  "color-bg-elevated": string;
  "color-on-accent": string;
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
function mix(a: string, b: string, t: number): string {
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

// Relative luminance (sRGB, perceptual-ish) for contrast decisions.
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG-style contrast ratio between two colors (1 = identical, 21 = max).
function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
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
 */
function mutedInk(
  ink: string,
  surface: string,
  maxT: number,
  minContrast: number,
): string {
  if (contrastRatio(mix(ink, surface, maxT), surface) >= minContrast) {
    return mix(ink, surface, maxT);
  }
  // Binary-search the blend amount; contrast is monotonic in t.
  let lo = 0;
  let hi = maxT;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(ink, surface, mid), surface) >= minContrast) lo = mid;
    else hi = mid;
  }
  return mix(ink, surface, lo);
}

export function deriveTokens(base: ThemeBase): ThemeTokens {
  const { bg, fg } = base;
  const isDark = luminance(bg) < 0.5;

  // Every theme's accents (info/warning/success) are saturated/dark enough
  // that white reads cleanly on accent-filled buttons across all 10 themes.
  const onAccent = "#ffffff";

  const anchorBg = mix(bg, fg, 0.12);

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

  return {
    "color-paper": bg,
    "color-ink": fg,
    // Secondary text must stay readable on every theme — not a flat 45% fade
    // (that washed out Gecko / Silver Aerogel / Grass, etc.). 4.5:1 is the
    // WCAG AA floor for body text; well-separated themes are unaffected.
    "color-ink-muted": mutedInk(fg, bg, 0.45, 4.5),
    "color-rule": mix(fg, bg, 0.82),
    "color-anchor-bg": anchorBg,
    // Anchor labels sit on `anchorBg`, not `bg`, and are small UI affordances
    // rather than body text — clamp to the 3:1 UI-component floor against that
    // surface (the old flat 0.42 fade dropped to ~1.7–2.2 on many themes).
    "color-anchor-text": mutedInk(fg, anchorBg, 0.42, 3.0),
    "color-info": base.blue,
    "color-warning": base.yellow,
    "color-success": base.green,
    "color-bg-elevated": mix(bg, fg, 0.07),
    "color-on-accent": onAccent,
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
    "color-commented-bg": rgba(base.selection, 0.22),
    "color-commented-bar": rgba(base.selection, 0.85),
    // Dark backgrounds need a punchier overlay to read as vibrant.
    "color-selection": rgba(base.selection, isDark ? 0.55 : 0.42),
    "color-overlay": isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(20, 20, 20, 0.35)",
  };
}

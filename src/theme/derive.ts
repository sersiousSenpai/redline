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

export function deriveTokens(base: ThemeBase): ThemeTokens {
  const { bg, fg } = base;
  const isDark = luminance(bg) < 0.5;

  // Every theme's accents (info/warning/success) are saturated/dark enough
  // that white reads cleanly on accent-filled buttons across all 10 themes.
  const onAccent = "#ffffff";

  return {
    "color-paper": bg,
    "color-ink": fg,
    "color-ink-muted": mix(fg, bg, 0.45),
    "color-rule": mix(fg, bg, 0.82),
    "color-anchor-bg": mix(bg, fg, 0.12),
    "color-anchor-text": mix(fg, bg, 0.42),
    "color-info": base.blue,
    "color-warning": base.yellow,
    "color-success": base.green,
    "color-bg-elevated": mix(bg, fg, 0.07),
    "color-on-accent": onAccent,
    "color-code-bg": mix(bg, fg, 0.1),
    "color-code-fg": fg,
    "color-commented-bg": rgba(base.selection, 0.22),
    "color-commented-bar": rgba(base.selection, 0.85),
    // Dark backgrounds need a punchier overlay to read as vibrant.
    "color-selection": rgba(base.selection, isDark ? 0.55 : 0.42),
    "color-overlay": isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(20, 20, 20, 0.35)",
  };
}

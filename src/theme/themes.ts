// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ThemeBase } from "./derive";

export type ThemeName =
  | "studio"
  | "basic"
  | "pro"
  | "homebrew"
  | "ocean"
  | "novel"
  | "blossom"
  | "manpage"
  | "redsand"
  | "silveraerogel"
  | "solidcolors"
  | "grass";

/** The 16 ANSI palette slots xterm accepts as theme overrides. */
export type AnsiSlot =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export interface ThemeEntry {
  name: ThemeName;
  label: string;
  base: ThemeBase;
  /** Hand-tuned ANSI overrides for the embedded terminal, merged over the
   *  light/dark default palette in TerminalView. Only needed when a theme's
   *  background defeats the defaults (mid-grey, saturated blue, pale paper);
   *  a contrast clamp backstops every slot regardless. */
  ansi?: Partial<Record<AnsiSlot, string>>;
}

// macOS Terminal.app's built-in profiles, as bg / fg / blue / yellow / green.
// The remaining tokens are derived in derive.ts. The "studio" entry must match
// the @theme defaults in styles.css so first paint is correct before JS runs
// (Studio is the runtime default; the rest are user choices).
export const THEMES: ThemeEntry[] = [
  // Studio — Redline's flagship dark mood. OKLCH-tuned accents (blue/yellow/
  // green) sit in the same harmonic family; selection is the warm "redline"
  // red-orange so commented spans and v-badges read with intent. The base
  // sRGB approximations of the OKLCH targets are spelled out inline so the
  // theme survives without an oklch() parser.
  {
    name: "studio",
    label: "Studio",
    base: {
      bg: "#1a1a1f",      // ≈ oklch(0.145 0.005 285)
      fg: "#fafafa",      // ≈ oklch(0.985 0 0)
      blue: "#5b9fe4",    // ≈ oklch(0.7 0.16 230) — info / edit
      yellow: "#d6c060",  // ≈ oklch(0.82 0.16 90)  — warning / feedback
      green: "#5dc585",   // ≈ oklch(0.72 0.18 145) — success / question
      selection: "#e8553d", // ≈ oklch(0.65 0.23 25) — the "redline" accent
    },
  },
  {
    name: "basic",
    label: "Basic",
    base: { bg: "#ffffff", fg: "#000000", blue: "#0433ff", yellow: "#a68a00", green: "#007f00", selection: "#2f6bff" },
  },
  {
    name: "pro",
    label: "Pro",
    base: { bg: "#000000", fg: "#f2f2f2", blue: "#3b6cd2", yellow: "#c7c400", green: "#28cd41", selection: "#4f9bff" },
  },
  {
    // fg eased off Terminal.app's exact #28fe14: that value is tuned for thin
    // terminal glyphs — on Redline's document-sized text it reads neon.
    name: "homebrew",
    label: "Homebrew",
    base: { bg: "#000000", fg: "#2ce51b", blue: "#3b6cd2", yellow: "#a6a300", green: "#2ce51b", selection: "#ff9d28" },
  },
  {
    name: "ocean",
    label: "Ocean",
    base: { bg: "#224fbc", fg: "#ffffff", blue: "#bbdaff", yellow: "#ffe680", green: "#a6e22e", selection: "#ffd400" },
    // Tango's dim grey + mid blue vanish on the saturated blue page; lift the
    // dim/blue slots into pale tints and pin `black` to a deeper navy so
    // background fills stay background.
    ansi: {
      black: "#0c1f4e",
      blue: "#9ec3ff",
      brightBlack: "#d4def5",
      brightBlue: "#bbdaff",
    },
  },
  {
    name: "novel",
    label: "Novel",
    base: { bg: "#dfdbc3", fg: "#3b2322", blue: "#3b5bb5", yellow: "#9c6f1b", green: "#5a7d2a", selection: "#1f6feb" },
    // The theme's own blue reads thin on the parchment page — swap the blue
    // slots to a deep rose that suits Novel's ink and carries more weight.
    ansi: {
      blue: "#8a2f4f",
      brightBlue: "#a13d5d",
    },
  },
  {
    // Renamed from "Man Page" — the internal name stays `manpage` so saved
    // theme preferences keep resolving.
    name: "manpage",
    label: "Gecko",
    base: { bg: "#fef49c", fg: "#000000", blue: "#0000b2", yellow: "#8a6d00", green: "#007f00", selection: "#4f46e5" },
    // Pure blue fights the yellow page; a deep magenta-pink pops against it.
    ansi: {
      blue: "#b00060",
      brightBlue: "#d11b73",
    },
  },
  {
    name: "redsand",
    label: "Red Sand",
    base: { bg: "#7a251e", fg: "#bdbdbd", blue: "#7bafd4", yellow: "#e6c200", green: "#8fbf3f", selection: "#ffb020" },
  },
  {
    name: "silveraerogel",
    label: "Silver Aerogel",
    base: { bg: "#929292", fg: "#000000", blue: "#1f3fff", yellow: "#8a6d00", green: "#0f6b0f", selection: "#1430ff" },
    // Mid-grey page eats both the stock dim grey (#6b6b6b) and the theme's
    // electric blue — drop the dim slots to near-black and deepen the blues.
    ansi: {
      blue: "#0a1fb3",
      brightBlack: "#292929",
      brightBlue: "#1226b3",
      white: "#f0f0f0",
    },
  },
  {
    name: "solidcolors",
    label: "Solid Colors",
    base: { bg: "#000000", fg: "#ffffff", blue: "#3b6cd2", yellow: "#c7c400", green: "#28cd41", selection: "#4f9bff" },
  },
  {
    // Deepened from the Terminal.app bright-green (#13773d) to a dark forest
    // green so the pale-yellow text reads clearly — kept per user preference.
    name: "grass",
    label: "Grass",
    base: { bg: "#08341b", fg: "#fff0a5", blue: "#7bafd4", yellow: "#ffd75f", green: "#c7f08a", selection: "#ff7a18" },
  },
  {
    // Blossom — a cherry-blossom light theme drawn from a real sakura branch:
    // a soft, slightly dusty petal-pink page (lightened from the original heavy
    // bubblegum, with green pulled below red/blue so it stays clearly pink rather
    // than washing out to gray), deep plum ink, with the photo's own hues as
    // accents — lavender-haze blue, golden-stamen yellow, fresh-stem green.
    // The selection hue is a vivid petal pink so commented spans and v-badges bloom.
    name: "blossom",
    label: "Blossom",
    base: { bg: "#ecdcdd", fg: "#381b2b", blue: "#897ad9", yellow: "#d99a2c", green: "#4f9e57", selection: "#ff4f97" },
  },
];

// First-launch default. `readStoredTheme()` only consults this when the user
// has no saved choice yet, so existing installs keep their picked theme.
export const DEFAULT_THEME: ThemeName = "studio";

const BY_NAME = new Map(THEMES.map((t) => [t.name, t]));

export function getTheme(name: string): ThemeEntry {
  return BY_NAME.get(name as ThemeName) ?? THEMES[0];
}

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && BY_NAME.has(value as ThemeName);
}

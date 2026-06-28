// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The app font is independent of the color theme: the FontPicker overrides the
// single `--font-sans` custom property (inline on <html>, via applyFont), and
// styles.css routes the whole app's chrome + document onto that variable. Only
// the terminal and code blocks stay pinned to `--font-mono`.

export type FontName =
  | "san-francisco"
  | "new-york"
  | "helvetica-neue"
  | "avenir-next"
  | "avenir"
  | "georgia"
  | "palatino"
  | "baskerville"
  | "times-new-roman"
  | "optima"
  | "futura"
  | "gill-sans"
  | "american-typewriter"
  | "menlo"
  | "sf-mono"
  | "courier-new"
  | "chalkboard-se"
  | "marker-felt"
  | "noteworthy"
  | "bradley-hand"
  | "snell-roundhand";

export interface FontEntry {
  name: FontName;
  label: string;
  /** A CSS font-family stack: the named Apple face first, then graceful
   *  fallbacks so non-Apple platforms (and the test runner) still resolve to
   *  something sensible. */
  stack: string;
}

// Apple fonts that ship on BOTH macOS and iOS. San Francisco leads as the
// system default; the rest are the well-known bundled families (sans, serif,
// mono, and a few script/handwriting faces) users can pick from.
export const FONTS: FontEntry[] = [
  {
    name: "san-francisco",
    label: "San Francisco",
    stack:
      '-apple-system, system-ui, "SF Pro Text", "SF Pro", BlinkMacSystemFont, sans-serif',
  },
  {
    name: "new-york",
    label: "New York",
    stack: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  },
  {
    name: "helvetica-neue",
    label: "Helvetica Neue",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    name: "avenir-next",
    label: "Avenir Next",
    stack: '"Avenir Next", Avenir, sans-serif',
  },
  { name: "avenir", label: "Avenir", stack: "Avenir, sans-serif" },
  {
    name: "georgia",
    label: "Georgia",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    name: "palatino",
    label: "Palatino",
    stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif',
  },
  {
    name: "baskerville",
    label: "Baskerville",
    stack: "Baskerville, Georgia, serif",
  },
  {
    name: "times-new-roman",
    label: "Times New Roman",
    stack: '"Times New Roman", Times, serif',
  },
  { name: "optima", label: "Optima", stack: 'Optima, "Segoe UI", sans-serif' },
  {
    name: "futura",
    label: "Futura",
    stack: 'Futura, "Trebuchet MS", sans-serif',
  },
  {
    name: "gill-sans",
    label: "Gill Sans",
    stack: '"Gill Sans", "Gill Sans MT", sans-serif',
  },
  {
    name: "american-typewriter",
    label: "American Typewriter",
    stack: '"American Typewriter", "Courier New", serif',
  },
  { name: "menlo", label: "Menlo", stack: 'Menlo, "SF Mono", monospace' },
  {
    name: "sf-mono",
    label: "SF Mono",
    stack: '"SF Mono", ui-monospace, Menlo, monospace',
  },
  {
    name: "courier-new",
    label: "Courier New",
    stack: '"Courier New", Courier, monospace',
  },
  {
    name: "chalkboard-se",
    label: "Chalkboard SE",
    stack: '"Chalkboard SE", "Comic Sans MS", sans-serif',
  },
  {
    name: "marker-felt",
    label: "Marker Felt",
    stack: '"Marker Felt", "Comic Sans MS", cursive',
  },
  { name: "noteworthy", label: "Noteworthy", stack: "Noteworthy, cursive" },
  {
    name: "bradley-hand",
    label: "Bradley Hand",
    stack: '"Bradley Hand", cursive',
  },
  {
    name: "snell-roundhand",
    label: "Snell Roundhand",
    stack: '"Snell Roundhand", cursive',
  },
];

// First-launch default: San Francisco. `readStoredFont()` only consults this
// when the user has no saved choice yet, so existing installs keep their pick.
export const DEFAULT_FONT: FontName = "san-francisco";

const BY_NAME = new Map(FONTS.map((f) => [f.name, f]));

export function getFont(name: string): FontEntry {
  return BY_NAME.get(name as FontName) ?? FONTS[0];
}

export function isFontName(value: unknown): value is FontName {
  return typeof value === "string" && BY_NAME.has(value as FontName);
}

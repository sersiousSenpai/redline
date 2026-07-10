// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The app font is independent of the color theme: the FontPicker overrides the
// single `--font-sans` custom property (inline on <html>, via applyFont), and
// styles.css routes the whole app's chrome + document onto that variable. Only
// the terminal and code blocks stay pinned to `--font-mono`.

export type BuiltinFontName =
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
  | "courier-new";

// A font choice is a built-in name OR a free-text custom family stored as
// `custom:<family>` (see customFontName). The `string & {}` keeps literal
// autocompletion for the built-ins while admitting custom values.
export type FontName = BuiltinFontName | (string & {});

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
];
// The five handwriting/novelty faces (Chalkboard SE, Marker Felt, Noteworthy,
// Bradley Hand, Snell Roundhand) were pruned from the built-ins; a saved pick
// of one falls back to San Francisco via getFont's default. Anyone who really
// wants them can type the family into the free-text custom entry.

// First-launch default: San Francisco. `readStoredFont()` only consults this
// when the user has no saved choice yet, so existing installs keep their pick.
export const DEFAULT_FONT: FontName = "san-francisco";

// A theme's "natural companion" face. Picking such a theme *recommends* this
// font — but only when the user hasn't chosen their own yet (see App's
// onThemeChange). It never overrides an explicit font pick, so the font stays
// fully independent of the color theme. Terminal reads best in monospace.
export const SUGGESTED_FONT_FOR_THEME: Partial<Record<string, FontName>> = {
  terminal: "sf-mono",
};

const BY_NAME = new Map(FONTS.map((f) => [f.name, f]));

// ---- Free-text custom fonts ------------------------------------------------
// A custom pick is stored as `custom:<family>` so it can never collide with a
// built-in name, and so an *unknown bare* name (e.g. a pruned built-in from an
// old install) still falls back to San Francisco rather than being applied as
// a family. The family is sanitized to what a CSS font-family value can carry.

const CUSTOM_PREFIX = "custom:";

/** Strip characters that could break out of a CSS font-family value. */
function sanitizeFamily(family: string): string {
  return family.replace(/["'`;{}()\\]/g, "").trim();
}

/** Build the stored FontName for a free-text family ("" if unusable). */
export function customFontName(family: string): FontName {
  const clean = sanitizeFamily(family);
  return clean ? `${CUSTOM_PREFIX}${clean}` : "";
}

export function isCustomFontName(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOM_PREFIX) &&
    sanitizeFamily(value.slice(CUSTOM_PREFIX.length)).length > 0
  );
}

/** The human-readable family of a custom FontName ("" for built-ins). */
export function customFontFamily(name: string): string {
  return isCustomFontName(name)
    ? sanitizeFamily(name.slice(CUSTOM_PREFIX.length))
    : "";
}

export function getFont(name: string): FontEntry {
  const builtin = BY_NAME.get(name as BuiltinFontName);
  if (builtin) return builtin;
  const family = customFontFamily(name);
  if (family) {
    return {
      name,
      label: family,
      stack: `"${family}", -apple-system, system-ui, sans-serif`,
    };
  }
  return FONTS[0];
}

/** True for a built-in name OR a well-formed custom `custom:<family>` value. */
export function isFontName(value: unknown): value is FontName {
  return (
    (typeof value === "string" && BY_NAME.has(value as BuiltinFontName)) ||
    isCustomFontName(value)
  );
}

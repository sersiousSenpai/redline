// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// Plaintext "linting" is independent of both the color theme and the font: it
// gives the plan document IDE-style token coloring — numbers, strings, brackets,
// URLs/paths and ALL-CAPS keywords tinted like syntax highlighting — so prose
// reads like source in an editor. The LintPicker writes the chosen name onto
// <html data-lint="…"> (via applyLint); a LintDecorations ProseMirror plugin
// tags each token span with `rl-lint--<kind>` classes, and styles.css colors
// those spans per active lint theme. Off = spans are not emitted at all, so the
// default path costs nothing.

export type LintName = "off" | "cyberpunk";

/** The token kinds the tokenizer recognizes. Each becomes a
 *  `rl-lint--<kind>` class that a lint theme colors in styles.css. */
export type LintTokenKind = "num" | "str" | "punct" | "url" | "kw";

export interface LintEntry {
  name: LintName;
  label: string;
  /** One-line description shown under the option in the picker. */
  description: string;
  /** A tiny palette used only to draw the picker's preview swatches — the real
   *  colors live in styles.css keyed on `:root[data-lint]`. Kept in the same
   *  file so the two never drift far apart. `off` has no swatches. */
  swatches?: string[];
}

// The registry. `off` leads as the first-launch default; `cyberpunk` is the
// flagship sci-fi look tuned to sit alongside the Terminal color theme.
export const LINTS: LintEntry[] = [
  {
    name: "off",
    label: "Off",
    description: "Plain prose — no token coloring.",
  },
  {
    name: "cyberpunk",
    label: "Cyberpunk",
    // Neon duotone (cyan / magenta / amber / mint) with a faint glow — the
    // classic "Synthwave / Cyberpunk" editor look. Pairs with the Terminal
    // color theme, but works on any dark page.
    description: "Neon IDE syntax glow — sci-fi. Pairs with the Terminal theme.",
    swatches: ["#00e5ff", "#ff2e97", "#ffd23f", "#5de6a8"],
  },
];

// First-launch default: linting off, so existing installs and new users see
// plain prose until they opt in. `readStoredLint()` only consults this when the
// user has no saved choice yet.
export const DEFAULT_LINT: LintName = "off";

// A color theme's "natural companion" lint. Picking such a theme *recommends*
// this lint — but only when the user hasn't chosen their own yet (see App's
// onThemeChange). It never overrides an explicit lint pick, mirroring the
// font-suggestion mechanism.
export const SUGGESTED_LINT_FOR_THEME: Partial<Record<string, LintName>> = {
  terminal: "cyberpunk",
};

const BY_NAME = new Map(LINTS.map((l) => [l.name, l]));

export function getLint(name: string): LintEntry {
  return BY_NAME.get(name as LintName) ?? LINTS[0];
}

export function isLintName(value: unknown): value is LintName {
  return typeof value === "string" && BY_NAME.has(value as LintName);
}

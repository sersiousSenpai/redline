// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { deriveTokens } from "./derive";
import { DEFAULT_THEME, getTheme } from "./themes";
import type { ThemeName } from "./themes";
import { DEFAULT_FONT, getFont, isFontName } from "./fonts";
import type { FontName } from "./fonts";
import { DEFAULT_LINT, isLintName } from "./lint";
import type { LintName } from "./lint";

const STORAGE_KEY = "redline.theme";
// Resolved CSS variables, cached so the inline bootstrap in index.html can
// replay them synchronously before the JS bundle loads — no flash of white (or
// of the default theme) on launch. Keep this key in sync with index.html.
const VARS_KEY = "redline.themeVars";

// Font preference is independent of the color theme. FONT_KEY stores the chosen
// font *name* (for the picker's initial state); FONT_STACK_KEY caches the
// resolved CSS font-family stack so index.html's pre-paint bootstrap can replay
// it before JS loads — no flash of the previous font. Both keys are in sync
// with index.html.
const FONT_KEY = "redline.font";
const FONT_STACK_KEY = "redline.fontStack";

// Plaintext-linting preference — independent of both color theme and font.
// LINT_KEY stores the chosen lint *name*; the value is replayed pre-paint in
// index.html purely as the `data-lint` attribute (cheap, no vars to cache).
const LINT_KEY = "redline.lint";

// Imperative token application: set each derived CSS custom property as an
// inline style on <html>. Inline styles on the root element beat any Tailwind
// v4 @theme / @layer rule unconditionally, so theme switching is deterministic
// regardless of stylesheet ordering.
export function applyTheme(name: ThemeName): void {
  const { base, name: resolved } = getTheme(name);
  const tokens = deriveTokens(base);
  const root = document.documentElement;
  const cache: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    const cssVar = `--${key}`;
    root.style.setProperty(cssVar, value);
    cache[cssVar] = value;
  }
  root.dataset.theme = resolved;
  // Persist the resolved variables for the next launch's pre-paint bootstrap.
  try {
    localStorage.setItem(VARS_KEY, JSON.stringify(cache));
  } catch {
    /* ignore — non-fatal, just means the next launch may flash once */
  }
}

// Read the persisted theme synchronously (used pre-paint in main.tsx to avoid
// a flash of the default theme on launch).
export function readStoredTheme(): ThemeName {
  try {
    // Any stored name is kept, not just registered ones: a saved *user* theme
    // (~/.redline/themes) isn't registered yet this early, and getTheme()
    // falls back safely until registerUserThemes() runs, then App re-applies.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (typeof raw === "string" && raw.trim() && raw.length <= 64) return raw;
  } catch {
    /* localStorage unavailable (private mode / quota) — fall through */
  }
  return DEFAULT_THEME;
}

export function storeTheme(name: ThemeName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* ignore — theme still applies for this session */
  }
}

// Apply the chosen font by overriding `--font-sans` inline on <html>. Inline
// styles beat Tailwind's @theme default, so this routes the whole app's chrome
// and document onto the picked face (the terminal/code stay on --font-mono).
// applyTheme() only sets its own derived tokens, so it never clobbers this var.
export function applyFont(name: FontName): void {
  const { stack, name: resolved } = getFont(name);
  const root = document.documentElement;
  root.style.setProperty("--font-sans", stack);
  root.dataset.font = resolved;
  try {
    localStorage.setItem(FONT_STACK_KEY, stack);
  } catch {
    /* ignore — non-fatal, just means the next launch may flash once */
  }
}

// Whether the user has ever explicitly chosen a font. Used to gate a theme's
// suggested-companion font so it only applies to an untouched default, never
// overriding a real pick.
export function hasStoredFont(): boolean {
  try {
    return isFontName(localStorage.getItem(FONT_KEY));
  } catch {
    return false;
  }
}

// Read the persisted font synchronously (used pre-paint in main.tsx).
export function readStoredFont(): FontName {
  try {
    const raw = localStorage.getItem(FONT_KEY);
    if (isFontName(raw)) return raw;
  } catch {
    /* localStorage unavailable (private mode / quota) — fall through */
  }
  return DEFAULT_FONT;
}

export function storeFont(name: FontName): void {
  try {
    localStorage.setItem(FONT_KEY, name);
  } catch {
    /* ignore — font still applies for this session */
  }
}

// Apply the chosen plaintext-lint theme by stamping `data-lint` on <html>;
// styles.css colors the `rl-lint--*` token spans off that attribute. Also fire
// the lint-change event so every mounted editor's LintDecorations plugin
// recomputes (turning coloring off vs on changes what it emits). The event name
// is inlined to avoid importing the editor bundle into the theme/bootstrap layer.
export function applyLint(name: LintName): void {
  document.documentElement.dataset.lint = name;
  try {
    window.dispatchEvent(new Event("redline:lintchange"));
  } catch {
    /* non-browser (test) environment — decorations refresh on next edit */
  }
}

// Whether the user has ever explicitly chosen a lint theme. Gates a color
// theme's suggested-companion lint so it only lands on an untouched default.
export function hasStoredLint(): boolean {
  try {
    return isLintName(localStorage.getItem(LINT_KEY));
  } catch {
    return false;
  }
}

// Read the persisted lint theme synchronously (used pre-paint in main.tsx).
export function readStoredLint(): LintName {
  try {
    const raw = localStorage.getItem(LINT_KEY);
    if (isLintName(raw)) return raw;
  } catch {
    /* localStorage unavailable (private mode / quota) — fall through */
  }
  return DEFAULT_LINT;
}

export function storeLint(name: LintName): void {
  try {
    localStorage.setItem(LINT_KEY, name);
  } catch {
    /* ignore — lint still applies for this session */
  }
}

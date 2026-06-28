// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { deriveTokens } from "./derive";
import { DEFAULT_THEME, getTheme, isThemeName } from "./themes";
import type { ThemeName } from "./themes";
import { DEFAULT_FONT, getFont, isFontName } from "./fonts";
import type { FontName } from "./fonts";

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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isThemeName(raw)) return raw;
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

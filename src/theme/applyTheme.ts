// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { deriveTokens } from "./derive";
import { DEFAULT_THEME, getTheme, isThemeName } from "./themes";
import type { ThemeName } from "./themes";

const STORAGE_KEY = "redline.theme";
// Resolved CSS variables, cached so the inline bootstrap in index.html can
// replay them synchronously before the JS bundle loads — no flash of white (or
// of the default theme) on launch. Keep this key in sync with index.html.
const VARS_KEY = "redline.themeVars";

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

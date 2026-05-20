// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { deriveTokens } from "./derive";
import { DEFAULT_THEME, getTheme, isThemeName } from "./themes";
import type { ThemeName } from "./themes";

const STORAGE_KEY = "redline.theme";

// Imperative token application: set each derived CSS custom property as an
// inline style on <html>. Inline styles on the root element beat any Tailwind
// v4 @theme / @layer rule unconditionally, so theme switching is deterministic
// regardless of stylesheet ordering.
export function applyTheme(name: ThemeName): void {
  const { base, name: resolved } = getTheme(name);
  const tokens = deriveTokens(base);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--${key}`, value);
  }
  root.dataset.theme = resolved;
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

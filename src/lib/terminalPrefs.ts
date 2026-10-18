// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/** `family` is empty until the user picks one: the terminal then follows the
 *  app's own mono font (`--font-mono`), as it always has. */
export interface TerminalPrefs { family: string; size: number; lineHeight: number }
export const TERMINAL_PREFS_KEY = "redline.terminalPrefs";
export const TERMINAL_PREFS_EVENT = "rl-terminal-prefs";
export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  family: "", size: 14, lineHeight: 1.2,
};
export function normalizeTerminalPrefs(value: unknown): TerminalPrefs {
  const p = (value && typeof value === "object" ? value : {}) as Partial<TerminalPrefs>;
  const bounded = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  return {
    family: typeof p.family === "string" ? p.family.trim().slice(0, 200) : DEFAULT_TERMINAL_PREFS.family,
    size: bounded(p.size, 14, 10, 28),
    lineHeight: bounded(p.lineHeight, 1.2, 1, 2),
  };
}
export function readTerminalPrefs(): TerminalPrefs {
  try { return normalizeTerminalPrefs(JSON.parse(localStorage.getItem(TERMINAL_PREFS_KEY) ?? "null")); }
  catch { return { ...DEFAULT_TERMINAL_PREFS }; }
}
export function writeTerminalPrefs(value: TerminalPrefs) {
  const prefs = normalizeTerminalPrefs(value);
  try { localStorage.setItem(TERMINAL_PREFS_KEY, JSON.stringify(prefs)); } catch { /* Session-only when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(TERMINAL_PREFS_EVENT, { detail: prefs }));
}
/** The family xterm is given: the user's pick, else the app's mono font. */
export function terminalFamily(prefs: TerminalPrefs): string {
  return prefs.family ||
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
    "ui-monospace, Menlo, monospace";
}

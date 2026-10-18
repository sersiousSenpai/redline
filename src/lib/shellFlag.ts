// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which shell the app paints: `classic` (the surface-first header, footer
//! and plate) or `flow` (session-first: sidebar, conversation stage, plan
//! panel, Tools menu). Read ONCE per page load and cached, so every branch
//! agrees for the whole session and the terminal dock never sees its slot
//! change under it; switching writes the choice and reloads.
//!
//! main.tsx stamps `html[data-rl-shell]` from this before React mounts, so
//! CSS can branch on the shell on the very first frame.

export type Shell = "classic" | "flow";

export const SHELL_KEY = "redline.shell";

let cached: Shell | null = null;

/** The shell this page load paints. */
export function shellFlag(): Shell {
  if (cached) return cached;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SHELL_KEY);
  } catch {
    /* Storage unavailable: the classic shell. */
  }
  cached = stored === "flow" ? "flow" : "classic";
  return cached;
}

export function isFlowShell(): boolean {
  return shellFlag() === "flow";
}

/** Persist a shell and reload into it. A no-op when it is already the one
 *  painted. */
export function switchShell(next: Shell, reload: () => void = () => location.reload()): void {
  if (next === shellFlag()) return;
  try {
    localStorage.setItem(SHELL_KEY, next);
  } catch {
    return; // Nothing would survive the reload.
  }
  reload();
}

/** Tests only: forget the cached read. */
export function resetShellFlagForTests(): void {
  cached = null;
}

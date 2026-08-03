// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Reading a terminal's OSC title as "what is being worked on in here".
//
// Shells and TUIs announce themselves through the window title (OSC 0/2):
// `claude` writes what it is doing, zsh's precmd hooks write the running
// command, vim writes the file. That is the one "what" signal a terminal
// volunteers — and it costs nothing to watch, unlike polling a process table.
// The catch is that the *default* title is almost always the cwd in some dress
// ("~/redline", "dev@mac: ~/redline"), which a bubble row already shows as its
// location — so this module's real job is throwing those away.

/** Titles that name the shell itself. A login shell prefixes a dash. */
const SHELL_NAMES = new Set([
  "zsh",
  "-zsh",
  "bash",
  "-bash",
  "fish",
  "-fish",
  "sh",
  "-sh",
  "login",
  "terminal",
]);

/** Longest work line a row will carry before it's elided. */
const MAX_LEN = 64;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function looksLikePath(s: string): boolean {
  return /^[~/]/.test(s) || /^\.{1,2}\//.test(s);
}

/** Trim to `MAX_LEN`, eliding rather than hard-cutting. */
export function elide(s: string, max = MAX_LEN): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The informative part of a terminal title, or null when it says nothing the
 *  row doesn't already show. `dir` is the terminal's live cwd, so a title that
 *  merely repeats it is recognised as noise. */
export function workFromTitle(
  raw: string | null | undefined,
  dir: string | null,
): string | null {
  const cleaned = (raw ?? "")
    // Control bytes can ride along in a title; they'd render as tofu.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  // "dev@mac: ~/redline" / "dev@mac: npm run dev" — keep only what follows the
  // host prefix, which is the part that ever varies.
  const idx = cleaned.lastIndexOf(": ");
  const body = idx === -1 ? cleaned : cleaned.slice(idx + 2).trim();
  if (!body) return null;

  if (looksLikePath(body)) return null;
  if (SHELL_NAMES.has(body.toLowerCase())) return null;
  if (dir && body === basename(dir)) return null;

  return elide(body);
}

/** What a popover row says a terminal is working on. A plan held for review is
 *  the strongest claim Redline can make — that terminal's `claude` is stopped
 *  at this exact document — so it outranks whatever the title happens to say.
 *  Returns null when neither source knows anything. */
export function workSignal(
  planTitle: string | null | undefined,
  title: string | null | undefined,
  dir: string | null,
): { text: string; held: boolean } | null {
  const plan = (planTitle ?? "").replace(/\s+/g, " ").trim();
  if (plan) return { text: elide(plan), held: true };
  const fromTitle = workFromTitle(title, dir);
  return fromTitle ? { text: fromTitle, held: false } : null;
}

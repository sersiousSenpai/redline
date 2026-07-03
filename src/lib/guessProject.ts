// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { ProjectOption } from "../components/ProjectPicker";

/** Escape a string for safe embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-guess the target repo for a plan drafted by an agent elsewhere, by
 *  matching known project names (review sessions + open folders) that appear in
 *  the plan text. A plan that talks about `qwallah-crm` should launch there, not
 *  in $HOME.
 *
 *  Matching is case-insensitive and boundary-delimited (so `redline` doesn't
 *  match inside `streamlined`). The winner is the *longest* project name that
 *  appears — so `qwallah-crm` beats a bare `qwallah` — with ties broken by the
 *  most mentions. Names shorter than 3 chars are ignored as too noisy.
 *
 *  Returns the matched project's `path`, or `null` when nothing matches — the
 *  caller supplies its own fallback (current folder, last-used repo, or Home). */
export function guessProjectForPlan(
  markdown: string,
  options: ProjectOption[],
): string | null {
  const hay = markdown.toLowerCase();
  let best: { path: string; len: number; count: number } | null = null;
  for (const opt of options) {
    const name = opt.name.toLowerCase().trim();
    if (name.length < 3) continue;
    const re = new RegExp(
      `(?:^|[^a-z0-9])${escapeRe(name)}(?:[^a-z0-9]|$)`,
      "g",
    );
    const count = (hay.match(re) || []).length;
    if (count === 0) continue;
    if (
      !best ||
      name.length > best.len ||
      (name.length === best.len && count > best.count)
    ) {
      best = { path: opt.path, len: name.length, count };
    }
  }
  return best?.path ?? null;
}

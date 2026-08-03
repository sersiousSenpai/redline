// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure helpers behind the terminal tab bar's repo bubbles: which recent repos
// to offer, which already-open terminals belong to each, and how many bubbles
// fit the gap between the tab list and the action cluster. No React, no Tauri —
// the component owns the DOM measuring, this owns the arithmetic.

/** A candidate repo directory (a review session's project, or an open folder
 *  workspace) as the app already knows it. */
export interface RepoSource {
  path: string;
  name: string;
}

/** A dock terminal reduced to what grouping needs. */
export interface TerminalRef {
  id: string;
  /** Live cwd, else spawn cwd, else null (= $HOME — hidden tabs are never
   *  polled, so a never-shown tab only has its spawn cwd). */
  dir: string | null;
  /** "redline 2" — the label the tab strip already computed. */
  label: string;
  held: boolean;
  unseen: boolean;
  /** Pane it is on screen in, else null. */
  pane: "A" | "B" | null;
  /** What this terminal is working on — the held plan's title, else what the
   *  shell/TUI put in the window title. Null when it has volunteered nothing
   *  (see lib/termTitle). */
  work?: string | null;
}

export interface RepoInstance extends TerminalRef {
  /** Path below the repo root; "" when the shell sits at the root. */
  subPath: string;
}

export interface RepoBubble {
  path: string;
  name: string;
  instances: RepoInstance[];
}

/** Trailing-slash-insensitive compare key (mirrors TerminalTabs' normPath). */
export function normPath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

/** The prefix a child path must start with to sit under `root`. Written out
 *  because the naive `root + "/"` yields "//" at the filesystem root. */
function childPrefix(rootKey: string): string {
  return rootKey === "/" ? "/" : `${rootKey}/`;
}

/** MRU first, then the caller's recency order; deduped by normalized path,
 *  `$HOME` and `/` dropped, capped at `limit`.
 *
 *  Dropping home and root matches `isUninterestingDir` in App: a bubble for "~"
 *  is the same thing the bar's existing "+" button already does, and one for
 *  "/" is never what anyone meant. */
export function orderRepos(
  sources: readonly RepoSource[],
  mru: readonly string[],
  home: string | null,
  limit: number,
): RepoSource[] {
  const homeKey = home === null ? null : normPath(home);
  // First occurrence wins, so the caller's recency order survives dedup.
  const byKey = new Map<string, RepoSource>();
  for (const s of sources) {
    if (!s || !s.path) continue;
    const key = normPath(s.path);
    if (key === "/" || key === homeKey) continue;
    if (!byKey.has(key)) byKey.set(key, s);
  }

  const out: RepoSource[] = [];
  const taken = new Set<string>();
  for (const m of mru) {
    const key = normPath(m);
    const s = byKey.get(key);
    // An MRU entry whose repo is no longer offered (session closed, folder
    // shut) simply doesn't surface — it stays in the list for when it returns.
    if (s && !taken.has(key)) {
      taken.add(key);
      out.push(s);
    }
  }
  for (const [key, s] of byKey) {
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(s);
  }
  return out.slice(0, Math.max(0, limit));
}

/** Attach each terminal to the repo it is at or below. Deepest root wins when
 *  repos nest (~/work and ~/work/api), so a terminal lands under exactly one.
 *  Repos with no open terminals still get a bubble — clicking one is how you
 *  open the first. */
export function groupTerminals(
  repos: readonly RepoSource[],
  terminals: readonly TerminalRef[],
  home: string | null,
): RepoBubble[] {
  const bubbles: RepoBubble[] = repos.map((r) => ({
    path: r.path,
    name: r.name,
    instances: [],
  }));
  const keys = repos.map((r) => normPath(r.path));

  for (const t of terminals) {
    // A null dir means the shell is in $HOME; resolve it so the match is a
    // plain path compare. With home dropped from `repos`, such a terminal
    // belongs to no bubble — which is the intent.
    const raw = t.dir ?? home;
    if (!raw) continue;
    const key = normPath(raw);

    let best = -1;
    for (let i = 0; i < keys.length; i++) {
      const root = keys[i];
      if (key !== root && !key.startsWith(childPrefix(root))) continue;
      // Deepest match wins: nested repos would otherwise double-list a shell.
      if (best === -1 || root.length > keys[best].length) best = i;
    }
    if (best === -1) continue;

    const root = keys[best];
    bubbles[best].instances.push({
      ...t,
      subPath: key === root ? "" : key.slice(childPrefix(root).length),
    });
  }
  return bubbles;
}

/** Largest k where the first k bubbles fit `available` px. Returns n when all
 *  fit with no chip; otherwise reserves `overflowWidth` for the "+N" chip
 *  (plus the gap in front of it, once at least one bubble is showing). */
export function fitCount(
  widths: readonly number[],
  available: number,
  overflowWidth: number,
  gap: number,
): number {
  const n = widths.length;
  if (n === 0) return 0;

  let all = 0;
  for (let i = 0; i < n; i++) all += widths[i] + (i > 0 ? gap : 0);
  if (all <= available) return n;

  let used = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const next = used + widths[i] + (i > 0 ? gap : 0);
    if (next + gap + overflowWidth > available) break;
    used = next;
    k = i + 1;
  }
  return k;
}

/** Bump `path` to the front, deduped, capped. */
export function bumpMru(
  mru: readonly string[],
  path: string,
  cap: number,
): string[] {
  const key = normPath(path);
  const out = [path];
  for (const m of mru) {
    if (normPath(m) !== key) out.push(m);
  }
  return out.slice(0, Math.max(0, cap));
}

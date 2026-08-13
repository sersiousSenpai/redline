// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// Pure helpers behind the terminal tile menu — the dropdown that is now the
// dock's single inventory of the fleet: which recent repos to offer, which
// repo each open terminal belongs to, how the OPEN section orders itself, and
// the one filter matcher both sections share. No React, no Tauri — the
// component owns the DOM, this owns the arithmetic. (Successor to the repo
// bubble strip's `repoBubbles.ts`; `orderRepos` and `bumpMru` survive
// verbatim, the strip's width measurement died with the strip.)

/** A candidate repo directory (a review session's project, or an open folder
 *  workspace) as the app already knows it. */
export interface RepoSource {
  path: string;
  name: string;
}

/** A dock terminal reduced to what the menu needs. */
export interface TerminalRef {
  id: string;
  /** Live cwd, else spawn cwd, else null (= $HOME). */
  dir: string | null;
  /** "redline 2" — the label the tile header already computed. */
  label: string;
  held: boolean;
  unseen: boolean;
  /** Tile index it is on screen in, else null. The NUMERIC index is the
   *  source of truth — "focus tile 3" must be sayable, not just "focus this
   *  terminal". */
  tile: number | null;
  /** What this terminal is working on — the held plan's title, else what the
   *  shell/TUI put in the window title. Null when it has volunteered nothing
   *  (see lib/termTitle). */
  work?: string | null;
}

/** A terminal with its repo attribution resolved. Unlike the old bubble
 *  grouping, terminals under NO known repo are KEPT (`repo: null`) — the menu
 *  is the fleet's only inventory now, and a `$HOME` shell must not vanish
 *  from it. */
export interface AttributedTerminal extends TerminalRef {
  repo: RepoSource | null;
  /** Path below the repo root; "" when the shell sits at the root (or has no
   *  repo — the row falls back to `dir` for its location then). */
  subPath: string;
}

/** A repo row in the menu's NEW TERMINAL IN section. */
export interface RepoChoice extends RepoSource {
  /** Open terminals already attributed to this repo. */
  count: number;
}

/** The held/intercept red, shared by the in-pane strip, the menu's "plan
 *  held" chip and the header's overflow pip — one export instead of the three
 *  copies the strip era grew. */
export const HELD_RED = "#e8553d";

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
 *  Dropping home and root matches `isUninterestingDir` in App: a row for "~"
 *  is what the menu's own "New terminal in home" already does, and one for
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

/** Index of the repo `dir` sits at or below, or -1. Deepest root wins when
 *  repos nest (~/work and ~/work/api), so a terminal lands under exactly one.
 *  A null dir resolves to `home` first, so a `$HOME` shell matches a repo
 *  only if home itself is offered (it never is — see orderRepos). */
export function matchRepo(
  repos: readonly RepoSource[],
  dir: string | null,
  home: string | null,
): number {
  const raw = dir ?? home;
  if (!raw) return -1;
  const key = normPath(raw);
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i < repos.length; i++) {
    const root = normPath(repos[i].path);
    if (key !== root && !key.startsWith(childPrefix(root))) continue;
    if (root.length > bestLen) {
      best = i;
      bestLen = root.length;
    }
  }
  return best;
}

/** Attribute each terminal to its repo — KEEPING the ones under no known
 *  repo. This is the behaviour change the menu forces on the old grouping: a
 *  bubble strip could drop a `$HOME` terminal (its own tab still showed it);
 *  the menu is the only inventory, so dropping one would make it unreachable. */
export function attachRepos(
  repos: readonly RepoSource[],
  terminals: readonly TerminalRef[],
  home: string | null,
): AttributedTerminal[] {
  return terminals.map((t) => {
    const best = matchRepo(repos, t.dir, home);
    if (best === -1) return { ...t, repo: null, subPath: "" };
    const root = normPath(repos[best].path);
    const key = normPath(t.dir ?? home ?? "");
    return {
      ...t,
      repo: repos[best],
      subPath: key === root ? "" : key.slice(childPrefix(root).length),
    };
  });
}

/** Each repo with its open-terminal count, for the NEW TERMINAL IN section.
 *  Repos with no terminals still get a row — clicking one is how you open
 *  the first. */
export function repoChoices(
  repos: readonly RepoSource[],
  terminals: readonly TerminalRef[],
  home: string | null,
): RepoChoice[] {
  const counts = repos.map(() => 0);
  for (const t of terminals) {
    const i = matchRepo(repos, t.dir, home);
    if (i !== -1) counts[i]++;
  }
  return repos.map((r, i) => ({ ...r, count: counts[i] }));
}

/** OPEN-section order: tiled terminals in tile order, then untiled ones
 *  most-recently-evicted first (`untiledMru`), then creation order. Eviction
 *  is silent, so the terminal that just left the screen must be the first
 *  reachable row — "put that back" is one click. */
export function orderOpenRows<T extends { id: string; tile: number | null }>(
  rows: readonly T[],
  untiledMru: readonly string[],
): T[] {
  const rank = new Map(untiledMru.map((id, i) => [id, i]));
  const tiled = rows
    .filter((r) => r.tile !== null)
    .sort((a, b) => (a.tile ?? 0) - (b.tile ?? 0));
  // Stable sort: rows sharing a rank (never evicted) keep creation order.
  const untiled = rows
    .filter((r) => r.tile === null)
    .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  return [...tiled, ...untiled];
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

/** The one matcher both menu sections share — what makes the filtered menu a
 *  switcher rather than two stacked lists. Case-insensitive substring over
 *  everything a row shows: label, work line, location, repo name. An empty
 *  query matches everything. */
export function matchesTerminalQuery(
  hay: {
    label?: string | null;
    work?: string | null;
    subPath?: string | null;
    dir?: string | null;
    repoName?: string | null;
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [hay.label, hay.work, hay.subPath, hay.dir, hay.repoName].some(
    (s) => !!s && s.toLowerCase().includes(q),
  );
}

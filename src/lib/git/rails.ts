// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Horizontal-rail layout for the Branches view.
//!
//! Time runs left to right: X is the commit's column in chronological order
//! (oldest loaded commit = 0), so no two commits ever share a column. Each
//! branch is a horizontal rail (a row):
//!
//! - Seeds are claimed in priority order: the default branch
//!   (main/master/trunk/develop) first so it owns the trunk history, then the
//!   checked-out branch (or a detached HEAD), other local branches by most
//!   recent tip, remote-only branches, then tags. Each seed walks its tip's
//!   FIRST-PARENT chain claiming unclaimed commits and stops at the first
//!   claimed one (its fork point). A ref whose tip is already a rail's tip
//!   (a remote branch sitting on its local branch) shares that rail as an
//!   alias; a ref pointing into the middle of a rail claims nothing.
//! - Row order is a separate decision: the checked-out branch first, then the
//!   default branch, then the rest by where they fork (nearest the rail they
//!   leave, newest fork first), with a remote branch placed right under the local
//!   branch that tracks it, and tags last.
//! - The fit range runs from the oldest fork among named branch rails to the
//!   newest commit; `fitViewport` turns it into a zoom with a minimum spacing.
//! - Commits no ref reaches along a first-parent chain (merged-and-deleted
//!   branches, mostly) form anonymous chains. Each one is grouped under the
//!   rail it merged into (or forked from) and interval-packed into shared rows
//!   beneath it, so they reuse rows whenever their spans don't overlap. They
//!   wear the host rail's colour. Chains wholly outside the fit range reuse
//!   those rows where they fit, else drop to overflow rows at the bottom.
//! - Edges run child -> parent. Same-rail first-parent edges are straight;
//!   a fork bends just after its parent and runs along the child's row; a
//!   merge runs along the parent's row and bends just before the merge commit;
//!   when neither row is clear the edge is one smooth curve across the span.
//!   A parent outside the loaded page becomes a stub to the left edge.
//!
//! Hiding remotes or tags hides the commits only those refs reach, and the
//! remaining commits are re-columned so the view does not keep empty gaps.

import type { GitCommit, GitRefs } from "./types";
import { LANE_COLOR_COUNT } from "./graph";

const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk", "develop"] as const;

export type RailKind = "head" | "local" | "remote" | "tag" | "anon";

export interface Rail {
  id: number;
  kind: RailKind;
  /** Branch, remote branch or tag name; "HEAD" for a detached head; null when anonymous. */
  name: string | null;
  /** Other refs whose tip is this rail's tip (e.g. the remote branch a local tracks). */
  aliases: string[];
  /** The checked-out branch (or the detached HEAD). */
  current: boolean;
  isDefault: boolean;
  /** Newest commit on the rail. */
  tip: string;
  /** Claimed commits, newest first. */
  commits: string[];
  row: number;
  color: number;
  minX: number;
  maxX: number;
}

export interface RailNode {
  sha: string;
  x: number;
  row: number;
  rail: number;
  color: number;
  commit: GitCommit;
  merge: boolean;
}

/** How a cross-row edge is drawn:
 *  - `straight`: same row.
 *  - `parent`: bends right after the parent, runs along the child's row.
 *  - `child`: runs along the parent's row, bends right before the child.
 *  - `span`: one curve across the whole span. */
export type EdgeRoute = "straight" | "parent" | "child" | "span";

export interface RailEdge {
  child: string;
  /** null when the parent is outside the loaded commits (a stub). */
  parent: string | null;
  /** 0 = first parent. */
  parentIndex: number;
  kind: "rail" | "fork" | "merge" | "stub";
  route: EdgeRoute;
  /** Parent end (for a stub: x = -1 on the child's row). */
  x1: number;
  row1: number;
  /** Child end. */
  x2: number;
  row2: number;
  color: number;
}

export interface RailRow {
  index: number;
  /** The named rail this row is labelled with, null for a packed anonymous row. */
  rail: number | null;
  /** Every rail (named or anonymous chain) drawn on this row. */
  rails: number[];
  /** Columns of the row's commits, ascending, with their shas. */
  xs: number[];
  shas: string[];
}

export interface RailLayout {
  nodes: Map<string, RailNode>;
  /** Visible shas by column (index = x). */
  columns: string[];
  rails: Rail[];
  rows: RailRow[];
  edges: RailEdge[];
  /** Visible children of each visible commit, newest first. */
  children: Map<string, string[]>;
  /** Commits hidden because only hidden remotes/tags reach them. */
  hidden: number;
  /** The "fit branches" column range: from just before the oldest point where a
   *  named branch rail leaves its parent rail, to the newest commit. */
  fit: { from: number; to: number };
}

export interface RailsOptions {
  /** HEAD's sha (status.head). Used for a detached HEAD. */
  head?: string | null;
  showRemotes?: boolean;
  showTags?: boolean;
}

interface Seed {
  kind: Exclude<RailKind, "anon">;
  name: string;
  sha: string;
  current: boolean;
  isDefault: boolean;
  /** For a remote: the local branch tracking it. */
  trackedBy?: string;
}

const isRemoteHead = (name: string) => name === "HEAD" || name.endsWith("/HEAD");

function seedsFrom(commits: ReadonlyArray<GitCommit>, refs: GitRefs | null, head: string | null): { locals: Seed[]; remotes: Seed[]; tags: Seed[]; detached: Seed | null } {
  const locals: Seed[] = [];
  const remotes: Seed[] = [];
  const tags: Seed[] = [];
  let detached: Seed | null = null;
  if (refs) {
    const upstreamOf = new Map<string, string>();
    for (const b of refs.local) {
      locals.push({ kind: "local", name: b.name, sha: b.sha, current: b.current || b.name === refs.current, isDefault: false });
      if (b.upstream) upstreamOf.set(b.upstream, b.name);
    }
    for (const r of refs.remote) {
      if (isRemoteHead(r.name)) continue;
      remotes.push({ kind: "remote", name: r.name, sha: r.sha, current: false, isDefault: false, trackedBy: upstreamOf.get(r.name) });
    }
    for (const t of refs.tags) tags.push({ kind: "tag", name: t.name, sha: t.sha, current: false, isDefault: false });
    if (refs.current === null && head) detached = { kind: "head", name: "HEAD", sha: head, current: true, isDefault: false };
  } else {
    for (const c of commits) {
      for (const ref of c.refs) {
        if (ref.kind === "head") {
          if (ref.name === "HEAD") detached = { kind: "head", name: "HEAD", sha: c.sha, current: true, isDefault: false };
          else locals.push({ kind: "local", name: ref.name, sha: c.sha, current: true, isDefault: false });
        } else if (ref.kind === "local") locals.push({ kind: "local", name: ref.name, sha: c.sha, current: false, isDefault: false });
        else if (ref.kind === "remote") {
          if (!isRemoteHead(ref.name)) remotes.push({ kind: "remote", name: ref.name, sha: c.sha, current: false, isDefault: false });
        } else tags.push({ kind: "tag", name: ref.name, sha: c.sha, current: false, isDefault: false });
      }
    }
    if (!detached && head && !locals.some((s) => s.current)) detached = { kind: "head", name: "HEAD", sha: head, current: true, isDefault: false };
  }
  return { locals, remotes, tags, detached };
}

function pickDefault(locals: Seed[], remotes: Seed[], showRemotes: boolean): Seed | null {
  for (const name of DEFAULT_BRANCH_NAMES) {
    const local = locals.find((s) => s.name === name);
    if (local) return local;
  }
  if (!showRemotes) return null;
  const remoteName = (seed: Seed) => seed.name.slice(seed.name.indexOf("/") + 1);
  const rank = (seed: Seed) => (seed.name.startsWith("origin/") ? 0 : seed.name.startsWith("upstream/") ? 1 : 2);
  for (const name of DEFAULT_BRANCH_NAMES) {
    const found = remotes.filter((s) => remoteName(s) === name).sort((a, b) => rank(a) - rank(b))[0];
    if (found) return found;
  }
  return null;
}

/** Index of the first element of a sorted array greater than `value`. */
function upperBound(xs: readonly number[], value: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** True when the row has no commit strictly between columns a and b. */
export function rowClear(row: RailRow | undefined, a: number, b: number): boolean {
  if (!row) return true;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const i = upperBound(row.xs, lo);
  return i >= row.xs.length || row.xs[i] >= hi;
}

export function layoutRails(commits: ReadonlyArray<GitCommit>, refs: GitRefs | null, options: RailsOptions = {}): RailLayout {
  const showRemotes = options.showRemotes ?? true;
  const showTags = options.showTags ?? true;
  const head = options.head ?? null;
  const loaded = new Map<string, GitCommit>();
  for (const c of commits) if (!loaded.has(c.sha)) loaded.set(c.sha, c);
  const unique = commits.length === loaded.size ? commits : [...loaded.values()];

  // Loaded children (newest first, because commits arrive newest first).
  const allChildren = new Map<string, string[]>();
  for (const c of unique) {
    for (const p of c.parents) {
      if (!loaded.has(p)) continue;
      const list = allChildren.get(p);
      if (list) list.push(c.sha);
      else allChildren.set(p, [c.sha]);
    }
  }

  const { locals, remotes, tags, detached } = seedsFrom(unique, refs, head);
  const tipDate = (seed: Seed) => loaded.get(seed.sha)?.date ?? -Infinity;
  const byRecency = (a: Seed, b: Seed) => tipDate(b) - tipDate(a) || a.name.localeCompare(b.name);

  // ---- Visibility: hide what only hidden remotes/tags reach.
  let visible: Set<string> | null = null;
  if (!showRemotes || !showTags) {
    const shown = new Set<string>();
    for (const s of locals) shown.add(s.sha);
    if (detached) shown.add(detached.sha);
    if (head) shown.add(head);
    if (showRemotes) for (const s of remotes) shown.add(s.sha);
    if (showTags) for (const s of tags) shown.add(s.sha);
    const hiddenTips = new Set<string>();
    if (!showRemotes) for (const s of remotes) if (!shown.has(s.sha)) hiddenTips.add(s.sha);
    if (!showTags) for (const s of tags) if (!shown.has(s.sha)) hiddenTips.add(s.sha);
    const stack: string[] = [];
    for (const c of unique) {
      if (shown.has(c.sha) && loaded.has(c.sha)) stack.push(c.sha);
      else if (!allChildren.has(c.sha) && !hiddenTips.has(c.sha)) stack.push(c.sha);
    }
    visible = new Set<string>();
    while (stack.length) {
      const sha = stack.pop()!;
      if (visible.has(sha)) continue;
      visible.add(sha);
      for (const p of loaded.get(sha)!.parents) if (loaded.has(p) && !visible.has(p)) stack.push(p);
    }
  }
  const list = visible ? unique.filter((c) => visible!.has(c.sha)) : unique;
  const isVisible = (sha: string) => (visible ? visible.has(sha) : loaded.has(sha));
  const count = list.length;
  const xOf = new Map<string, number>();
  const columns: string[] = new Array(count);
  list.forEach((c, i) => {
    const x = count - 1 - i;
    xOf.set(c.sha, x);
    columns[x] = c.sha;
  });
  const children = new Map<string, string[]>();
  for (const c of list) {
    const kids = (allChildren.get(c.sha) ?? []).filter(isVisible);
    if (kids.length) children.set(c.sha, kids);
  }

  // ---- Seeds in claim order.
  const current = detached ?? locals.find((s) => s.current) ?? null;
  const def = pickDefault(locals, remotes, showRemotes);
  if (def) def.isDefault = true;
  const claimOrder: Seed[] = [];
  const pushSeed = (seed: Seed | null) => {
    if (seed && !claimOrder.includes(seed)) claimOrder.push(seed);
  };
  pushSeed(def);
  pushSeed(current);
  for (const s of [...locals].sort(byRecency)) pushSeed(s);
  if (showRemotes) for (const s of [...remotes].sort(byRecency)) pushSeed(s);
  if (showTags) for (const s of [...tags].sort(byRecency)) pushSeed(s);

  // ---- Claim first-parent chains.
  interface Chain {
    seed: Seed | null;
    commits: string[];
    aliases: string[];
  }
  const chains: Chain[] = [];
  const claimed = new Map<string, number>();
  const tipChain = new Map<string, number>();
  const walk = (tip: string, chain: number) => {
    const out: string[] = [];
    let sha: string | undefined = tip;
    while (sha !== undefined && isVisible(sha) && !claimed.has(sha)) {
      claimed.set(sha, chain);
      out.push(sha);
      sha = loaded.get(sha)!.parents[0];
    }
    return out;
  };
  for (const seed of claimOrder) {
    if (!isVisible(seed.sha)) continue;
    const owner = claimed.get(seed.sha);
    if (owner !== undefined) {
      if (tipChain.get(seed.sha) === owner && seed.kind !== "tag") {
        const chain = chains[owner];
        // The checked-out branch names the rail it shares.
        if (seed.current && chain.seed && !chain.seed.current) {
          chain.aliases.unshift(chain.seed.name);
          chain.seed = seed;
        } else chain.aliases.push(seed.name);
      }
      continue;
    }
    const id = chains.length;
    chains.push({ seed, commits: walk(seed.sha, id), aliases: [] });
    tipChain.set(seed.sha, id);
  }
  const namedCount = chains.length;
  for (const c of list) {
    if (claimed.has(c.sha)) continue;
    const id = chains.length;
    chains.push({ seed: null, commits: walk(c.sha, id), aliases: [] });
  }

  // ---- Anonymous chains: host group + span.
  const groupOf = new Array<number>(chains.length).fill(-1);
  for (let i = 0; i < namedCount; i++) groupOf[i] = i;
  const hostOf = new Array<number>(chains.length).fill(-1);
  // A chain runs newest -> oldest along first parents, so its columns descend.
  const span: Array<[number, number]> = chains.map((chain) => [xOf.get(chain.commits[chain.commits.length - 1])!, xOf.get(chain.commits[0])!]);
  for (let i = namedCount; i < chains.length; i++) {
    const chain = chains[i];
    const tip = chain.commits[0];
    const oldest = chain.commits[chain.commits.length - 1];
    let [lo, hi] = span[i];
    let merge: string | null = null;
    for (const kid of children.get(tip) ?? []) {
      const kidX = xOf.get(kid)!;
      hi = Math.max(hi, kidX);
      if (merge === null || kidX < xOf.get(merge)!) merge = kid;
    }
    const fork = loaded.get(oldest)!.parents[0];
    if (fork !== undefined && isVisible(fork)) lo = Math.min(lo, xOf.get(fork)!);
    else if (fork !== undefined) lo = Math.min(lo, -1);
    span[i] = [lo, hi];
    const host = merge !== null ? claimed.get(merge) : fork !== undefined && isVisible(fork) ? claimed.get(fork) : undefined;
    hostOf[i] = host ?? -1;
  }
  const resolveGroup = (i: number, depth = 0): number => {
    if (groupOf[i] !== -1 || depth > chains.length) return groupOf[i];
    const host = hostOf[i];
    groupOf[i] = host === -1 || host === i ? -2 : resolveGroup(host, depth + 1);
    if (groupOf[i] === -1) groupOf[i] = -2;
    return groupOf[i];
  };
  for (let i = namedCount; i < chains.length; i++) resolveGroup(i);

  // ---- Where each named rail leaves its parent rail.
  const forkOf = (id: number): { x: number; chain: number } | null => {
    const chain = chains[id];
    const parent = loaded.get(chain.commits[chain.commits.length - 1])!.parents[0];
    if (parent === undefined || !isVisible(parent) || !claimed.has(parent)) return null;
    return { x: xOf.get(parent)!, chain: claimed.get(parent)! };
  };
  const depthMemo = new Map<number, number>();
  const depthOf = (id: number, guard = 0): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    const seed = chains[id].seed;
    const fork = forkOf(id);
    const depth = seed?.isDefault ? 0 : !fork || guard > chains.length ? 99 : depthOf(fork.chain, guard + 1) + 1;
    depthMemo.set(id, depth);
    return depth;
  };

  // ---- Row order for named rails: the checked-out branch, the default branch,
  // then the rest by where they fork (right under the rail they leave, newest
  // fork first) so fork lines cross as few rows as possible; tags last.
  const named = chains.slice(0, namedCount).map((chain, id) => ({ chain, id }));
  const rowOrder: number[] = [];
  const placed = new Set<number>();
  const place = (id: number | undefined) => {
    if (id === undefined || placed.has(id)) return;
    placed.add(id);
    rowOrder.push(id);
    const seed = chains[id].seed!;
    // A remote branch sits right under the local branch that tracks it.
    for (const other of named) {
      if (!placed.has(other.id) && other.chain.seed!.kind === "remote" && other.chain.seed!.trackedBy === seed.name) place(other.id);
    }
  };
  place(named.find((n) => n.chain.seed!.current)?.id);
  place(named.find((n) => n.chain.seed!.isDefault)?.id);
  const isTag = (id: number) => chains[id].seed!.kind === "tag";
  const forkX = (id: number) => forkOf(id)?.x ?? -1;
  // Greedy, like a breadth-first walk of the fork tree: next comes the rail
  // whose parent rail sits highest, newest fork first. A rail whose parent is
  // not placed yet waits; when none is ready, the shallowest goes next.
  const pending = named.filter((n) => !placed.has(n.id) && !isTag(n.id)).map((n) => n.id);
  const rank = (id: number) => {
    const fork = forkOf(id);
    const parentRow = fork && placed.has(fork.chain) ? rowOrder.indexOf(fork.chain) : Infinity;
    return [parentRow, depthOf(id), -forkX(id), -tipDate(chains[id].seed!), id];
  };
  const before = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  while (pending.length) {
    const ready = pending.filter((id) => !placed.has(id));
    if (!ready.length) break;
    let best = ready[0];
    let bestRank = rank(best);
    for (const id of ready.slice(1)) {
      const r = rank(id);
      if (before(r, bestRank)) {
        best = id;
        bestRank = r;
      }
    }
    place(best);
    pending.splice(pending.indexOf(best), 1);
  }
  for (const n of [...named].sort((a, b) => tipDate(b.chain.seed!) - tipDate(a.chain.seed!) || a.id - b.id)) place(n.id);

  // ---- Fit range: the oldest fork among named branch rails (tags excluded) to the newest commit.
  const last = Math.max(0, count - 1);
  let fitFrom = last;
  let branchRails = 0;
  for (const { chain, id } of named) {
    if (isTag(id) || chain.seed!.isDefault) continue;
    branchRails++;
    fitFrom = Math.min(fitFrom, forkOf(id)?.x ?? xOf.get(chain.commits[chain.commits.length - 1])!);
  }
  if (branchRails === 0) fitFrom = 0;
  const fit = { from: fitFrom, to: last };
  const inFit = (id: number) => span[id][1] >= fit.from && span[id][0] <= fit.to;

  // ---- Rows: each named rail, then its packed anonymous chains; orphans last.
  const groups = new Map<number, number[]>();
  for (let i = namedCount; i < chains.length; i++) {
    const g = groupOf[i];
    const list2 = groups.get(g);
    if (list2) list2.push(i);
    else groups.set(g, [i]);
  }
  const rowOfChain = new Array<number>(chains.length).fill(0);
  const rowLabel: Array<number | null> = [];
  const rowChains: number[][] = [];
  // Anonymous chains drawn inside the fit range pack into rows right under
  // their host; chains wholly outside it reuse those rows where they fit and
  // otherwise go to overflow rows at the very bottom, so no row between two
  // named rails is blank across the fitted view.
  const rowSpans: Array<Array<[number, number]>> = [];
  const free = (row: number, id: number) => rowSpans[row].every(([lo, hi]) => span[id][0] > hi || span[id][1] < lo);
  const putIn = (row: number, id: number) => {
    rowOfChain[id] = row;
    rowChains[row].push(id);
    rowSpans[row].push(span[id]);
  };
  const newRow = () => {
    rowLabel.push(null);
    rowChains.push([]);
    rowSpans.push([]);
    return rowLabel.length - 1;
  };
  const bySpan = (a: number, b: number) => span[a][0] - span[b][0] || span[a][1] - span[b][1];
  const overflow: number[] = [];
  const pack = (members: number[] | undefined) => {
    if (!members?.length) return;
    const firstRow = rowLabel.length;
    for (const id of members.filter(inFit).sort(bySpan)) {
      let row = -1;
      for (let r = firstRow; r < rowLabel.length && row === -1; r++) if (free(r, id)) row = r;
      putIn(row === -1 ? newRow() : row, id);
    }
    for (const id of members.filter((m) => !inFit(m)).sort(bySpan)) {
      let row = -1;
      for (let r = firstRow; r < rowLabel.length && row === -1; r++) if (free(r, id)) row = r;
      if (row === -1) overflow.push(id);
      else putIn(row, id);
    }
  };
  for (const id of rowOrder) {
    rowOfChain[id] = rowLabel.length;
    rowLabel.push(id);
    rowChains.push([id]);
    rowSpans.push([span[id]]);
    pack(groups.get(id));
  }
  pack(groups.get(-2));
  {
    const firstRow = rowLabel.length;
    for (const id of overflow.sort(bySpan)) {
      let row = -1;
      for (let r = firstRow; r < rowLabel.length && row === -1; r++) if (free(r, id)) row = r;
      putIn(row === -1 ? newRow() : row, id);
    }
  }

  // ---- Rails (ids follow row order) and nodes.
  const railIdOfChain = new Array<number>(chains.length);
  const chainOrder = rowChains.flat();
  chainOrder.forEach((chainId, railId) => {
    railIdOfChain[chainId] = railId;
  });
  // Named rails take palette colours in row order; an anonymous chain wears its
  // host rail's colour (it is that rail's merged history), orphans keep cycling.
  let colorCursor = 0;
  const colorOfChain = new Array<number>(chains.length).fill(0);
  const rails: Rail[] = chainOrder.map((chainId, railId) => {
    const chain = chains[chainId];
    const seed = chain.seed;
    const group = groupOf[chainId];
    colorOfChain[chainId] = seed || group < 0 ? colorCursor++ % LANE_COLOR_COUNT : colorOfChain[group];
    return {
      id: railId,
      kind: seed ? seed.kind : "anon",
      name: seed ? seed.name : null,
      aliases: chain.aliases,
      current: seed?.current ?? false,
      isDefault: seed?.isDefault ?? false,
      tip: chain.commits[0],
      commits: chain.commits,
      row: rowOfChain[chainId],
      color: colorOfChain[chainId],
      minX: xOf.get(chain.commits[chain.commits.length - 1])!,
      maxX: xOf.get(chain.commits[0])!,
    };
  });
  const nodes = new Map<string, RailNode>();
  for (const rail of rails) {
    for (const sha of rail.commits) {
      const commit = loaded.get(sha)!;
      nodes.set(sha, { sha, x: xOf.get(sha)!, row: rail.row, rail: rail.id, color: rail.color, commit, merge: commit.parents.length > 1 });
    }
  }
  const rows: RailRow[] = rowLabel.map((label, index) => {
    const members = rowChains[index].map((c) => railIdOfChain[c]);
    const shas = members.flatMap((r) => rails[r].commits);
    const xs = shas.map((s) => xOf.get(s)!);
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    return {
      index,
      rail: label === null ? null : railIdOfChain[label],
      rails: members,
      xs: order.map((i) => xs[i]),
      shas: order.map((i) => shas[i]),
    };
  });

  // ---- Edges.
  const edges: RailEdge[] = [];
  for (const c of list) {
    const node = nodes.get(c.sha)!;
    c.parents.forEach((p, k) => {
      const parent = nodes.get(p);
      if (!parent) {
        if (!loaded.has(p)) {
          edges.push({ child: c.sha, parent: null, parentIndex: k, kind: "stub", route: k === 0 ? "straight" : "span", x1: -1, row1: k === 0 ? node.row : node.row + 0.5, x2: node.x, row2: node.row, color: node.color });
        }
        return;
      }
      const base = { child: c.sha, parent: p, parentIndex: k, x1: parent.x, row1: parent.row, x2: node.x, row2: node.row };
      if (k === 0 && parent.rail === node.rail) {
        edges.push({ ...base, kind: "rail", route: "straight", color: node.color });
      } else if (k === 0) {
        const route: EdgeRoute = parent.row === node.row ? "straight" : rowClear(rows[node.row], parent.x, node.x) ? "parent" : rowClear(rows[parent.row], parent.x, node.x) ? "child" : "span";
        edges.push({ ...base, kind: "fork", route, color: node.color });
      } else {
        const route: EdgeRoute = parent.row === node.row ? "straight" : rowClear(rows[parent.row], parent.x, node.x) ? "child" : rowClear(rows[node.row], parent.x, node.x) ? "parent" : "span";
        edges.push({ ...base, kind: "merge", route, color: parent.color });
      }
    });
  }

  return { nodes, columns, rails, rows, edges, children, hidden: unique.length - count, fit };
}

/** Ancestors (via every parent) and descendants (via every child) of a commit, within the layout. */
export function lineage(layout: RailLayout, sha: string): { ancestors: Set<string>; descendants: Set<string> } {
  const ancestors = new Set<string>();
  const descendants = new Set<string>();
  if (!layout.nodes.has(sha)) return { ancestors, descendants };
  const up = [...layout.nodes.get(sha)!.commit.parents];
  while (up.length) {
    const s = up.pop()!;
    if (ancestors.has(s) || !layout.nodes.has(s)) continue;
    ancestors.add(s);
    up.push(...layout.nodes.get(s)!.commit.parents);
  }
  const down = [...(layout.children.get(sha) ?? [])];
  while (down.length) {
    const s = down.pop()!;
    if (descendants.has(s)) continue;
    descendants.add(s);
    down.push(...(layout.children.get(s) ?? []));
  }
  return { ancestors, descendants };
}

/** The commit on `row` nearest to column `x` (ties go to the newer one). */
export function nearestOnRow(layout: RailLayout, row: number, x: number): string | null {
  const r = layout.rows[row];
  if (!r || r.xs.length === 0) return null;
  const i = upperBound(r.xs, x);
  const after = i < r.xs.length ? i : -1;
  const before = i - 1;
  if (after === -1) return r.shas[before];
  if (before < 0) return r.shas[after];
  return x - r.xs[before] < r.xs[after] - x ? r.shas[before] : r.shas[after];
}

/** Keyboard movement: left = first parent, right = first child (preferring one
 *  on the same rail), up/down = nearest commit on the adjacent row. */
export function neighbor(layout: RailLayout, sha: string, direction: "left" | "right" | "up" | "down"): string | null {
  const node = layout.nodes.get(sha);
  if (!node) return null;
  if (direction === "left") {
    const p = node.commit.parents[0];
    return p !== undefined && layout.nodes.has(p) ? p : null;
  }
  if (direction === "right") {
    const kids = layout.children.get(sha) ?? [];
    if (kids.length === 0) return null;
    const firstParentKids = kids.filter((k) => layout.nodes.get(k)!.commit.parents[0] === sha);
    const pool = firstParentKids.length ? firstParentKids : kids;
    const same = pool.filter((k) => layout.nodes.get(k)!.rail === node.rail);
    const pick = (same.length ? same : pool).reduce((a, b) => (layout.nodes.get(a)!.x <= layout.nodes.get(b)!.x ? a : b));
    return pick;
  }
  const step = direction === "up" ? -1 : 1;
  for (let row = node.row + step; row >= 0 && row < layout.rows.length; row += step) {
    const hit = nearestOnRow(layout, row, node.x);
    if (hit) return hit;
  }
  return null;
}

export interface FitInput {
  from: number;
  to: number;
  /** Width of the graph area in px (canvas minus the label gutter). */
  width: number;
  /** World x of column 0 (px before the first column). */
  padLeft: number;
  /** Screen px kept left of `from` and right of `to` (tip chips). */
  leadIn: number;
  tail: number;
  /** Px per column at zoom 1. */
  baseColumn: number;
  /** Smallest px per column the fit may use (keeps nodes clickable). */
  minSpacing: number;
  /** Largest zoom the fit may use. */
  maxZoom: number;
}

/** Zoom and horizontal offset that frame columns [from, to]. When that would
 *  squeeze columns below `minSpacing`, keep the minimum and anchor on the
 *  newest commits instead (also when the range is short enough to hit
 *  `maxZoom`). `left` is the world px at the graph's left edge. */
export function fitViewport(input: FitInput): { zoom: number; left: number; squeezed: boolean } {
  const { from, to, width, padLeft, leadIn, tail, baseColumn, minSpacing, maxZoom } = input;
  const span = Math.max(1, to - from);
  const room = Math.max(1, width - leadIn - tail);
  let spacing = room / span;
  let squeezed = false;
  if (spacing < minSpacing) {
    spacing = minSpacing;
    squeezed = true;
  }
  const capped = spacing > baseColumn * maxZoom;
  if (capped) spacing = baseColumn * maxZoom;
  const zoom = spacing / baseColumn;
  // Squeezed, or capped with room to spare: the newest commits pin the right edge.
  const left = squeezed || capped ? padLeft + to * spacing + tail - width : padLeft + from * spacing - leadIn;
  return { zoom, left, squeezed };
}

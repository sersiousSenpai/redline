// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Lane assignment for the history graph.
//!
//! Input is a page of commits in `--date-order` (children before parents). Each
//! lane holds the sha it expects next. Walking the rows:
//!
//! - the commit takes the leftmost lane expecting it, or a free lane when no
//!   lane does (a branch tip);
//! - every other lane expecting it converges into the node and frees up;
//! - its first parent continues in the commit's own lane; each further parent
//!   (a merge, or an octopus) joins the lane already expecting it, or opens a
//!   new one;
//! - a commit with no parents ends its lane.
//!
//! Lanes never shift sideways, so a row is drawn from three edge kinds: a full
//! height `pass`, a `top` half arriving at the node, and a `bottom` half
//! leaving it. A parent that is not in the page simply keeps its lane open to
//! the bottom of the list, ready for the next page.

export interface GraphEdge {
  /** Lane the segment starts in (top of the row for `pass`/`top`, the node for `bottom`). */
  from: number;
  /** Lane the segment ends in. */
  to: number;
  kind: "pass" | "top" | "bottom";
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** Lanes this row needs to draw (highest used lane + 1). */
  width: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest row in the page. */
  width: number;
}

/** Palette size; colours are indices into the view's lane palette. */
export const LANE_COLOR_COUNT = 8;

export function layoutGraph(commits: ReadonlyArray<{ sha: string; parents: readonly string[] }>): GraphLayout {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let widest = 0;
  const rows: GraphRow[] = [];

  const open = (sha: string, avoid: ReadonlyArray<string | null>): number => {
    let index = lanes.findIndex((value, i) => value === null && (avoid[i] ?? null) === null);
    if (index === -1) index = lanes.length;
    lanes[index] = sha;
    colors[index] = nextColor++ % LANE_COLOR_COUNT;
    return index;
  };

  for (const commit of commits) {
    const edges: GraphEdge[] = [];
    const matches: number[] = [];
    lanes.forEach((value, index) => {
      if (value === commit.sha) matches.push(index);
    });
    const lane = matches.length > 0 ? matches[0] : open(commit.sha, []);
    const before = lanes.slice();
    const color = colors[lane];

    for (const index of matches) edges.push({ from: index, to: lane, kind: "top", color: colors[index] });
    for (const index of matches) if (index !== lane) lanes[index] = null;

    const [first, ...rest] = commit.parents;
    if (first === undefined) {
      lanes[lane] = null;
    } else {
      lanes[lane] = first;
      edges.push({ from: lane, to: lane, kind: "bottom", color });
    }
    for (const parent of rest) {
      let target = lanes.indexOf(parent);
      if (target === -1) target = open(parent, before);
      edges.push({ from: lane, to: target, kind: "bottom", color: colors[target] });
    }

    before.forEach((value, index) => {
      if (value !== null && value !== commit.sha && lanes[index] === value) {
        edges.push({ from: index, to: index, kind: "pass", color: colors[index] });
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    let width = lane + 1;
    for (const edge of edges) width = Math.max(width, edge.from + 1, edge.to + 1);
    widest = Math.max(widest, width);
    rows.push({ lane, color, edges, width });
  }
  return { rows, width: widest };
}

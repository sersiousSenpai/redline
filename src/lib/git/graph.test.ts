import { describe, expect, it } from "vitest";
import { layoutGraph, LANE_COLOR_COUNT, type GraphEdge } from "./graph";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });
const sorted = (edges: GraphEdge[]) =>
  edges.map(({ kind, from, to }) => `${kind}:${from}>${to}`).sort();

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, width } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(width).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // tip: no line above, line below
    expect(sorted(rows[0].edges)).toEqual(["bottom:0>0"]);
    expect(sorted(rows[1].edges)).toEqual(["bottom:0>0", "top:0>0"]);
    // root: line above, nothing below (the branch ends)
    expect(sorted(rows[2].edges)).toEqual(["top:0>0"]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
  });

  it("opens a lane for a merged branch and converges it at the fork point", () => {
    //   m        merge of main (b) and feature (f2)
    //   |\
    //   | f2
    //   b |
    //   | f1
    //   |/
    //   a
    const { rows, width } = layoutGraph([
      c("m", "b", "f2"),
      c("f2", "f1"),
      c("b", "a"),
      c("f1", "a"),
      c("a"),
    ]);
    expect(width).toBe(2);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(sorted(rows[0].edges)).toEqual(["bottom:0>0", "bottom:0>1"]);
    expect(sorted(rows[1].edges)).toEqual(["bottom:1>1", "pass:0>0", "top:1>1"]);
    expect(sorted(rows[2].edges)).toEqual(["bottom:0>0", "pass:1>1", "top:0>0"]);
    expect(sorted(rows[3].edges)).toEqual(["bottom:1>1", "pass:0>0", "top:1>1"]);
    // both lanes expected `a`: the second converges into the node
    expect(sorted(rows[4].edges)).toEqual(["top:0>0", "top:1>0"]);
    // the feature lane has its own colour, and its merge edge carries it
    expect(rows[1].color).not.toBe(rows[0].color);
    expect(rows[0].edges.find((e) => e.to === 1)?.color).toBe(rows[1].color);
  });

  it("fans an octopus merge out into one lane per extra parent", () => {
    const { rows, width } = layoutGraph([
      c("o", "p1", "p2", "p3"),
      c("p3", "base"),
      c("p2", "base"),
      c("p1", "base"),
      c("base"),
    ]);
    expect(width).toBe(3);
    expect(sorted(rows[0].edges)).toEqual(["bottom:0>0", "bottom:0>1", "bottom:0>2"]);
    expect(rows.slice(1, 4).map((r) => r.lane)).toEqual([2, 1, 0]);
    expect(sorted(rows[4].edges)).toEqual(["top:0>0", "top:1>0", "top:2>0"]);
    expect(new Set(rows.slice(0, 3).map((r) => r.color)).size).toBe(3);
  });

  it("frees a lane when a branch ends and reuses it for the next tip", () => {
    // Two unrelated histories: x ends (root) before y starts.
    const { rows } = layoutGraph([c("main2", "main1"), c("x", ), c("y", "main1"), c("main1")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 1, 0]);
    expect(sorted(rows[1].edges)).toEqual(["pass:0>0"]); // root tip: no edges of its own
    // y reuses lane 1 as a fresh tip: nothing arrives from above
    expect(sorted(rows[2].edges)).toEqual(["bottom:1>1", "pass:0>0"]);
    expect(sorted(rows[3].edges)).toEqual(["top:0>0", "top:1>0"]);
  });

  it("keeps lanes open for parents that are not in the page", () => {
    const { rows } = layoutGraph([c("m", "a", "z"), c("a", "older")]);
    expect(sorted(rows[0].edges)).toEqual(["bottom:0>0", "bottom:0>1"]);
    // z is beyond this page: its lane passes through and stays open at the bottom
    expect(sorted(rows[1].edges)).toEqual(["bottom:0>0", "pass:1>1", "top:0>0"]);
  });

  it("joins a merge parent to the lane already expecting it", () => {
    // f is reached first from its own tip, then merged by m.
    const { rows } = layoutGraph([c("t", "f"), c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    // the merge edge lands in lane 0, which already expects f; no third lane
    expect(sorted(rows[1].edges)).toEqual(["bottom:1>0", "bottom:1>1", "pass:0>0"]);
    expect(Math.max(...rows.map((r) => r.width))).toBe(2);
  });

  it("does not reuse a lane that converged in the same row for a new merge parent", () => {
    // `a` is expected by lanes 0 and 1; it merges `q` too.
    const { rows } = layoutGraph([c("x", "a"), c("y", "a"), c("a", "r", "q"), c("q"), c("r")]);
    const merge = rows[2];
    expect(merge.lane).toBe(0);
    const extra = merge.edges.find((e) => e.kind === "bottom" && e.to !== 0)!;
    expect(extra.to).toBe(2);
  });

  it("cycles a bounded palette", () => {
    const tips = Array.from({ length: LANE_COLOR_COUNT + 2 }, (_, i) => c(`t${i}`));
    const { rows } = layoutGraph(tips);
    expect(rows.every((r) => r.color >= 0 && r.color < LANE_COLOR_COUNT)).toBe(true);
  });

  it("handles an empty page", () => {
    expect(layoutGraph([])).toEqual({ rows: [], width: 0 });
  });
});

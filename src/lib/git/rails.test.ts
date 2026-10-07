import { describe, expect, it } from "vitest";
import { fitViewport, layoutRails, lineage, nearestOnRow, neighbor, rowClear, type RailLayout } from "./rails";
import type { GitCommit, GitRefs } from "./types";

/** Commits newest first: "sha:parent1,parent2". */
function log(...specs: string[]): GitCommit[] {
  return specs.map((spec, i) => {
    const [sha, parents = ""] = spec.split(":");
    return { sha, parents: parents ? parents.split(",") : [], subject: sha, authorName: "A", authorEmail: "a@x", date: 1_000_000 - i * 60, refs: [] };
  });
}

function refsOf(opts: { current?: string | null; local?: Array<[string, string, string?]>; remote?: Array<[string, string]>; tags?: Array<[string, string]> }): GitRefs {
  const current = opts.current === undefined ? opts.local?.[0]?.[0] ?? null : opts.current;
  return {
    current,
    local: (opts.local ?? []).map(([name, sha, upstream]) => ({ name, sha, upstream: upstream ?? null, ahead: 0, behind: 0, current: name === current, gone: false })),
    remote: (opts.remote ?? []).map(([name, sha]) => ({ remote: name.split("/")[0], name, sha })),
    tags: (opts.tags ?? []).map(([name, sha]) => ({ name, sha })),
    stashes: [],
    remotes: [...new Set((opts.remote ?? []).map(([name]) => name.split("/")[0]))],
  };
}

const railOf = (layout: RailLayout, sha: string) => layout.rails[layout.nodes.get(sha)!.rail];
const rowNames = (layout: RailLayout) => layout.rows.map((r) => (r.rail === null ? null : layout.rails[r.rail].name));

/** Every edge is drawable and no two commits share a column or a (row, x) slot. */
function sane(layout: RailLayout) {
  const slots = new Set<string>();
  for (const node of layout.nodes.values()) {
    const key = `${node.row}:${node.x}`;
    expect(slots.has(key), `two commits at ${key}`).toBe(false);
    slots.add(key);
    expect(layout.columns[node.x]).toBe(node.sha);
  }
  for (const edge of layout.edges) {
    if (edge.parent) expect(edge.x1).toBeLessThan(edge.x2);
    else expect(edge.x1).toBe(-1);
  }
  for (const row of layout.rows) for (let i = 1; i < row.xs.length; i++) expect(row.xs[i]).toBeGreaterThan(row.xs[i - 1]);
}

describe("layoutRails", () => {
  it("lays a linear history on one rail, oldest at column 0", () => {
    const commits = log("c:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "c"]] }));
    sane(layout);
    expect(layout.rails).toHaveLength(1);
    expect(layout.rails[0]).toMatchObject({ name: "main", kind: "local", current: true, isDefault: true, tip: "c", commits: ["c", "b", "a"], row: 0, minX: 0, maxX: 2 });
    expect(layout.columns).toEqual(["a", "b", "c"]);
    expect(layout.edges.map((e) => [e.child, e.parent, e.kind, e.route])).toEqual([
      ["c", "b", "rail", "straight"],
      ["b", "a", "rail", "straight"],
    ]);
  });

  it("forks a branch off its parent and merges it back", () => {
    // main: a - b - m (merge of f2) ; feature: a - f1 - f2 (still a branch)
    const commits = log("m:b,f2", "f2:f1", "b:a", "f1:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m"], ["feature", "f2"]] }));
    sane(layout);
    expect(rowNames(layout)).toEqual(["main", "feature"]);
    expect(railOf(layout, "b").name).toBe("main");
    expect(railOf(layout, "a").name).toBe("main");
    expect(railOf(layout, "f1").commits).toEqual(["f2", "f1"]);
    const fork = layout.edges.find((e) => e.child === "f1")!;
    expect(fork).toMatchObject({ parent: "a", kind: "fork", route: "parent", row1: 0, row2: 1 });
    const merge = layout.edges.find((e) => e.child === "m" && e.parentIndex === 1)!;
    // the feature row is clear between f2 and m, so it runs along it
    expect(merge).toMatchObject({ parent: "f2", kind: "merge", route: "child", row1: 1, row2: 0 });
    expect(layout.nodes.get("m")!.merge).toBe(true);
  });

  it("puts the checked-out branch first but lets the default branch own the trunk", () => {
    // feature branched off main; main has not moved since.
    const commits = log("f2:f1", "f1:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ current: "feature", local: [["main", "b"], ["feature", "f2"]] }));
    sane(layout);
    expect(rowNames(layout)).toEqual(["feature", "main"]);
    expect(railOf(layout, "a").name).toBe("main");
    expect(railOf(layout, "f1")).toMatchObject({ name: "feature", current: true, commits: ["f2", "f1"] });
  });

  it("orders other local branches by most recent tip, then remote-only branches, then tags", () => {
    const commits = log("x2:x1", "y1:a", "x1:a", "r1:a", "t1:a", "b:a", "a");
    const layout = layoutRails(
      commits,
      refsOf({ current: "main", local: [["main", "b"], ["old", "x2"], ["newer", "y1"]], remote: [["origin/wip", "r1"]], tags: [["v1", "t1"]] }),
    );
    sane(layout);
    // x2 is newer than y1 (dates descend down the log)
    expect(rowNames(layout)).toEqual(["main", "old", "newer", "origin/wip", "v1"]);
    expect(railOf(layout, "r1").kind).toBe("remote");
    expect(railOf(layout, "t1").kind).toBe("tag");
  });

  it("uses the remote default branch when there is no local one", () => {
    const commits = log("f1:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ current: "feature", local: [["feature", "f1"]], remote: [["origin/main", "b"]] }));
    expect(rowNames(layout)).toEqual(["feature", "origin/main"]);
    expect(railOf(layout, "a")).toMatchObject({ name: "origin/main", isDefault: true });
  });

  it("shares a rail between a local branch and the remote branch at the same tip", () => {
    const commits = log("c:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "c", "origin/main"]], remote: [["origin/main", "c"], ["origin/old", "b"]] }));
    sane(layout);
    expect(layout.rails).toHaveLength(1);
    expect(layout.rails[0].aliases).toEqual(["origin/main"]);
    // a remote pointing into the middle of a rail claims nothing
    expect(rowNames(layout)).toEqual(["main"]);
  });

  it("places a remote branch right under the local branch that tracks it", () => {
    // origin/feature is ahead of local feature (fetched, not pulled)
    const commits = log("o2:o1", "o1:f1", "m2:m1", "f1:m1", "m1");
    const layout = layoutRails(
      commits,
      refsOf({ current: "main", local: [["main", "m2"], ["topic", "m2"], ["feature", "f1", "origin/feature"]], remote: [["origin/feature", "o2"]] }),
    );
    sane(layout);
    expect(rowNames(layout)).toEqual(["main", "feature", "origin/feature"]);
    expect(layout.rails[0].aliases).toEqual(["topic"]);
    expect(railOf(layout, "o1").commits).toEqual(["o2", "o1"]);
  });

  it("names a shared rail after the checked-out branch", () => {
    const commits = log("b:a", "a");
    const layout = layoutRails(commits, refsOf({ current: "feature", local: [["main", "b"], ["feature", "b"]] }));
    expect(layout.rails).toHaveLength(1);
    expect(layout.rails[0]).toMatchObject({ name: "feature", current: true, aliases: ["main"] });
  });

  it("draws an octopus merge with one edge per extra parent", () => {
    const commits = log("o:m,p,q", "q:m", "p:m", "m");
    const layout = layoutRails(commits, refsOf({ local: [["main", "o"]] }));
    sane(layout);
    const merges = layout.edges.filter((e) => e.child === "o" && e.kind === "merge");
    expect(merges.map((e) => e.parent)).toEqual(["p", "q"]);
    // p and q are anonymous, merged into main: packed beneath it
    expect(railOf(layout, "p").kind).toBe("anon");
    expect(railOf(layout, "p").row).toBeGreaterThan(0);
    expect(railOf(layout, "q").row).toBeGreaterThan(0);
    // their spans overlap (both fork at m and merge at o) so they need two rows
    expect(railOf(layout, "p").row).not.toBe(railOf(layout, "q").row);
  });

  it("packs merged-and-deleted branches into reused rows under the rail they merged into", () => {
    // main: a - m1 (merges x1) - b - m2 (merges y1) ; x1 forks at a, y1 forks at b
    const commits = log("m2:b,y1", "y1:b", "b:m1", "m1:a,x1", "x1:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m2"]] }));
    sane(layout);
    const x = railOf(layout, "x1");
    const y = railOf(layout, "y1");
    expect(x.kind).toBe("anon");
    expect(y.kind).toBe("anon");
    expect(x.row).toBe(1);
    expect(y.row).toBe(1); // spans [a..m1] and [b..m2] do not overlap
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[1].rail).toBeNull();
    expect(layout.rows[1].rails).toEqual([x.id, y.id]);
  });

  it("does not pack anonymous chains whose spans overlap", () => {
    const commits = log("m2:m1,y1", "m1:a,x1", "y1:a", "x1:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m2"]] }));
    sane(layout);
    expect(railOf(layout, "x1").row).not.toBe(railOf(layout, "y1").row);
  });

  it("groups anonymous chains under their host rail, not at the bottom", () => {
    // feature (a named rail) merged an anonymous chain z; main is separate.
    const commits = log("fm:f1,z1", "z1:f1", "f1:a", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ current: "main", local: [["main", "b"], ["feature", "fm"]] }));
    sane(layout);
    expect(rowNames(layout)).toEqual(["main", "feature", null]);
    expect(railOf(layout, "z1").row).toBe(2);
  });

  it("stubs parents that are outside the loaded page", () => {
    // page 1 of a longer history: b's first parent and the merge's second parent are not loaded
    const commits = log("m:c,zz", "c:b", "b:old");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m"]] }));
    sane(layout);
    const stubs = layout.edges.filter((e) => e.kind === "stub");
    expect(stubs.map((e) => [e.child, e.parentIndex, e.x1, e.route])).toEqual([
      ["m", 1, -1, "span"],
      ["b", 0, -1, "straight"],
    ]);
  });

  it("handles roots and disjoint histories", () => {
    const commits = log("b:a", "z", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "b"], ["pages", "z"]] }));
    sane(layout);
    expect(rowNames(layout)).toEqual(["main", "pages"]);
    expect(layout.edges.filter((e) => e.child === "z" || e.child === "a")).toEqual([]);
  });

  it("puts a detached HEAD first", () => {
    const commits = log("h:b", "c:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ current: null, local: [["main", "c"]] }), { head: "h" });
    sane(layout);
    expect(rowNames(layout)).toEqual(["HEAD", "main"]);
    expect(layout.rails[0]).toMatchObject({ kind: "head", current: true, commits: ["h"] });
  });

  it("hides commits only hidden remotes or tags reach", () => {
    const commits = log("r2:r1", "r1:b", "t1:a", "b:a", "a");
    const refs = refsOf({ local: [["main", "b"]], remote: [["origin/topic", "r2"]], tags: [["v1", "t1"]] });
    const all = layoutRails(commits, refs);
    expect(all.nodes.size).toBe(5);
    const noRemotes = layoutRails(commits, refs, { showRemotes: false });
    expect([...noRemotes.nodes.keys()].sort()).toEqual(["a", "b", "t1"]);
    expect(noRemotes.hidden).toBe(2);
    expect(noRemotes.columns).toEqual(["a", "b", "t1"]);
    const neither = layoutRails(commits, refs, { showRemotes: false, showTags: false });
    expect([...neither.nodes.keys()].sort()).toEqual(["a", "b"]);
    expect(rowNames(neither)).toEqual(["main"]);
  });

  it("keeps a hidden remote's commits when a local branch also reaches them", () => {
    const commits = log("r1:b", "b:a", "a");
    const refs = refsOf({ local: [["main", "b"], ["topic", "r1"]], remote: [["origin/topic", "r1"]] });
    const layout = layoutRails(commits, refs, { showRemotes: false });
    expect(layout.nodes.has("r1")).toBe(true);
    expect(railOf(layout, "r1").aliases).toEqual([]);
  });

  it("falls back to commit decorations without refs", () => {
    const commits = log("c:b", "f:a", "b:a", "a");
    commits[0].refs = [{ name: "main", kind: "head" }];
    commits[1].refs = [{ name: "feature", kind: "local" }];
    const layout = layoutRails(commits, null);
    expect(rowNames(layout)).toEqual(["main", "feature"]);
  });

  it("colours rails from the shared lane palette", () => {
    const commits = log("c:b", "f:a", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "c"], ["feature", "f"]] }));
    expect(layout.rails.map((r) => r.color)).toEqual([0, 1]);
    expect(layout.nodes.get("f")!.color).toBe(1);
  });

  it("colours an anonymous chain like the rail it merged into", () => {
    const commits = log("m:b,x1", "f:a", "x1:a", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m"], ["feature", "f"]] }));
    expect(railOf(layout, "x1").color).toBe(railOf(layout, "m").color);
    expect(railOf(layout, "f").color).not.toBe(railOf(layout, "m").color);
  });

  it("orders rails right under the rail they fork from, newest fork first", () => {
    // current = feature (forks main at b); sub1/sub2 fork feature; side1/side2 fork main
    const commits = log("s2:f2", "f2:f1", "x2:b", "s1:f1", "f1:b", "x1:a", "b:a", "a");
    const layout = layoutRails(
      commits,
      refsOf({ current: "feature", local: [["main", "b"], ["feature", "f2"], ["side-old", "x1"], ["side-new", "x2"], ["sub-old", "s1"], ["sub-new", "s2"]] }),
    );
    sane(layout);
    // sub-* leave feature (row 0) so they come before side-* (which leave main);
    // within each, the newer fork point first
    expect(rowNames(layout)).toEqual(["feature", "main", "sub-new", "sub-old", "side-new", "side-old"]);
  });

  it("computes the fit range from the oldest fork among named branch rails", () => {
    // main: a b c d e ; feature forks at b ; tag on a (ignored)
    const commits = log("f1:b", "e:d", "d:c", "c:b", "b:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "e"], ["feature", "f1"]], tags: [["v0", "a"]] }));
    expect(layout.fit).toEqual({ from: layout.nodes.get("b")!.x, to: layout.columns.length - 1 });
    // a lone trunk fits everything
    const linear = layoutRails(log("c:b", "b:a", "a"), refsOf({ local: [["main", "c"]] }));
    expect(linear.fit).toEqual({ from: 0, to: 2 });
  });

  it("moves anonymous chains outside the fit range to overflow rows at the bottom", () => {
    // x1 was merged long before feature forked at c
    const commits = log("f1:c", "c:b", "b:m1", "m1:a,x1", "x1:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "c"], ["feature", "f1"]] }));
    sane(layout);
    expect(layout.fit.from).toBe(layout.nodes.get("c")!.x);
    expect(rowNames(layout)).toEqual(["main", "feature", null]);
    expect(railOf(layout, "x1").row).toBe(2);
  });

  it("reuses an in-range anonymous row for an out-of-range chain that fits", () => {
    // x1 (old) and y1 (inside the range) don't overlap: one shared row under main
    const commits = log("f1:m2", "m2:c,y1", "y1:c", "c:m1", "m1:a,x1", "x1:a", "a");
    const layout = layoutRails(commits, refsOf({ local: [["main", "m2"], ["feature", "f1"]] }));
    sane(layout);
    expect(railOf(layout, "y1").row).toBe(1);
    expect(railOf(layout, "x1").row).toBe(1);
    expect(rowNames(layout)).toEqual(["main", null, "feature"]);
  });

  it("stays sane on a large, branchy history", () => {
    const specs: string[] = [];
    const n = 600;
    for (let i = 0; i < n; i++) {
      const parent = i + 1 < n ? `c${i + 1}` : "";
      const extra = i % 7 === 0 && i + 5 < n ? `,c${i + 5}` : "";
      specs.push(`c${i}:${parent}${parent ? extra : ""}`);
    }
    const layout = layoutRails(log(...specs), refsOf({ local: [["main", "c0"]] }));
    sane(layout);
    expect(layout.nodes.size).toBe(n);
  });
});

describe("rail helpers", () => {
  const commits = log("m:b,f2", "f2:f1", "b:a", "f1:a", "a");
  const layout = layoutRails(commits, refsOf({ local: [["main", "m"], ["feature", "f2"]] }));

  it("finds ancestors through every parent and descendants through every child", () => {
    const { ancestors, descendants } = lineage(layout, "f1");
    expect([...ancestors]).toEqual(["a"]);
    expect([...descendants].sort()).toEqual(["f2", "m"]);
    const merge = lineage(layout, "m");
    expect([...merge.ancestors].sort()).toEqual(["a", "b", "f1", "f2"]);
    expect(merge.descendants.size).toBe(0);
  });

  it("moves along rails and between rows", () => {
    expect(neighbor(layout, "m", "left")).toBe("b");
    expect(neighbor(layout, "a", "right")).toBe("b"); // same rail first
    expect(neighbor(layout, "f1", "right")).toBe("f2");
    expect(neighbor(layout, "f2", "right")).toBe("m"); // only a merge child
    expect(neighbor(layout, "b", "down")).toBe("f2"); // b is column 2; f1=1, f2=3 → tie goes to the newer
    expect(neighbor(layout, "f1", "up")).toBe("b"); // f1 is column 1: a=0 and b=2 tie, newer wins
    expect(neighbor(layout, "f2", "up")).toBe("m");
    expect(neighbor(layout, "a", "up")).toBeNull();
    expect(neighbor(layout, "a", "left")).toBeNull();
  });

  it("finds the nearest commit on a row and checks clear spans", () => {
    expect(nearestOnRow(layout, 0, 2.4)).toBe("b");
    expect(nearestOnRow(layout, 0, 3.4)).toBe("m");
    expect(nearestOnRow(layout, 1, 100)).toBe("f2");
    expect(nearestOnRow(layout, 9, 0)).toBeNull();
    expect(rowClear(layout.rows[1], 3, 4)).toBe(true);
    expect(rowClear(layout.rows[0], 0, 4)).toBe(false);
  });
});

describe("fitViewport", () => {
  const base = { width: 1000, padLeft: 44, leadIn: 18, tail: 170, baseColumn: 26, minSpacing: 8, maxZoom: 1 };

  it("frames the range with the lead-in on the left", () => {
    const { zoom, left, squeezed } = fitViewport({ ...base, from: 10, to: 60 });
    const spacing = (1000 - 18 - 170) / 50;
    expect(squeezed).toBe(false);
    expect(zoom).toBeCloseTo(spacing / 26);
    expect(left).toBeCloseTo(44 + 10 * spacing - 18);
    // the newest column lands `tail` px before the right edge
    expect(44 + 60 * spacing - left).toBeCloseTo(1000 - 170);
  });

  it("keeps the minimum spacing and anchors on the newest commits when the range is too wide", () => {
    const { zoom, left, squeezed } = fitViewport({ ...base, from: 0, to: 400 });
    expect(squeezed).toBe(true);
    expect(zoom * 26).toBeCloseTo(8);
    expect(44 + 400 * 8 - left).toBeCloseTo(1000 - 170);
  });

  it("never zooms past maxZoom for a short range, staying on the newest commits", () => {
    const { zoom, left } = fitViewport({ ...base, from: 50, to: 52 });
    expect(zoom).toBe(1);
    expect(44 + 52 * 26 - left).toBeCloseTo(1000 - 170);
  });
});

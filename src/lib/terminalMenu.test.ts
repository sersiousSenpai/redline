// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  attachRepos,
  bumpMru,
  matchRepo,
  matchesTerminalQuery,
  orderOpenRows,
  orderRepos,
  repoChoices,
  type RepoSource,
  type TerminalRef,
} from "./terminalMenu";

const HOME = "/Users/dev";

const repo = (path: string): RepoSource => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
});

const term = (
  id: string,
  dir: string | null,
  extra: Partial<TerminalRef> = {},
): TerminalRef => ({
  id,
  dir,
  label: `${id} 1`,
  held: false,
  unseen: false,
  tile: null,
  ...extra,
});

describe("orderRepos", () => {
  it("leads with the MRU, then the caller's recency order", () => {
    const sources = [repo("/Users/dev/redline"), repo("/Users/dev/api"), repo("/Users/dev/site")];
    const out = orderRepos(sources, ["/Users/dev/site"], HOME, 12);
    expect(out.map((r) => r.path)).toEqual([
      "/Users/dev/site",
      "/Users/dev/redline",
      "/Users/dev/api",
    ]);
  });

  it("honors the MRU's own order for several bumped repos", () => {
    const sources = [repo("/a/one"), repo("/a/two"), repo("/a/three")];
    const out = orderRepos(sources, ["/a/three", "/a/one"], HOME, 12);
    expect(out.map((r) => r.path)).toEqual(["/a/three", "/a/one", "/a/two"]);
  });

  it("collapses duplicates across a trailing slash", () => {
    const sources = [repo("/Users/dev/redline/"), repo("/Users/dev/redline")];
    const out = orderRepos(sources, [], HOME, 12);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("/Users/dev/redline/");
  });

  it("matches an MRU entry written with a trailing slash", () => {
    const sources = [repo("/a/one"), repo("/a/two")];
    const out = orderRepos(sources, ["/a/two/"], HOME, 12);
    expect(out.map((r) => r.path)).toEqual(["/a/two", "/a/one"]);
  });

  it("drops $HOME and /", () => {
    const sources = [repo("/"), { path: HOME, name: "dev" }, repo("/Users/dev/redline")];
    const out = orderRepos(sources, [], HOME, 12);
    expect(out.map((r) => r.path)).toEqual(["/Users/dev/redline"]);
  });

  it("keeps $HOME when the home path is unknown", () => {
    const out = orderRepos([{ path: HOME, name: "dev" }], [], null, 12);
    expect(out.map((r) => r.path)).toEqual([HOME]);
  });

  it("ignores an MRU entry no longer among the sources", () => {
    const out = orderRepos([repo("/a/one")], ["/a/gone"], HOME, 12);
    expect(out.map((r) => r.path)).toEqual(["/a/one"]);
  });

  it("honors the limit", () => {
    const sources = [repo("/a/one"), repo("/a/two"), repo("/a/three")];
    expect(orderRepos(sources, [], HOME, 2).map((r) => r.path)).toEqual([
      "/a/one",
      "/a/two",
    ]);
    expect(orderRepos(sources, [], HOME, 0)).toEqual([]);
  });
});

describe("matchRepo / attachRepos", () => {
  const repos = [repo("/Users/dev/redline"), repo("/Users/dev/api")];

  it("gives a terminal at the repo root an empty subPath", () => {
    const [t] = attachRepos(repos, [term("t1", "/Users/dev/redline")], HOME);
    expect(t.repo?.name).toBe("redline");
    expect(t.subPath).toBe("");
  });

  it("ignores a trailing slash on the shell's cwd", () => {
    const [t] = attachRepos(repos, [term("t1", "/Users/dev/redline/")], HOME);
    expect(t.subPath).toBe("");
  });

  it("records the relative remainder for a terminal below the root", () => {
    const [t] = attachRepos(
      repos,
      [term("t1", "/Users/dev/redline/src/components")],
      HOME,
    );
    expect(t.subPath).toBe("src/components");
  });

  it("carries the terminal's own signals through", () => {
    const [t] = attachRepos(
      repos,
      [
        term("t1", "/Users/dev/redline", {
          held: true,
          unseen: true,
          tile: 2,
          work: "Tile headers in the terminal dock",
        }),
      ],
      HOME,
    );
    expect(t).toMatchObject({
      label: "t1 1",
      held: true,
      unseen: true,
      tile: 2,
      work: "Tile headers in the terminal dock",
    });
  });

  it("KEEPS a $HOME terminal (null dir) — repo-less, never dropped", () => {
    // The behaviour change the menu forces: the old bubble strip dropped this
    // terminal (its tab still showed it); the menu is the only inventory now.
    const out = attachRepos(repos, [term("t1", null)], HOME);
    expect(out).toHaveLength(1);
    expect(out[0].repo).toBeNull();
    expect(out[0].id).toBe("t1");
  });

  it("KEEPS a terminal outside every repo — repo-less, never dropped", () => {
    const out = attachRepos(repos, [term("t1", "/opt/homebrew")], HOME);
    expect(out).toHaveLength(1);
    expect(out[0].repo).toBeNull();
  });

  it("does not match a sibling whose name merely shares a prefix", () => {
    const out = attachRepos(
      [repo("/Users/dev/red")],
      [term("t1", "/Users/dev/redline")],
      HOME,
    );
    expect(out[0].repo).toBeNull();
  });

  it("assigns a nested repo's terminal to the deepest root only", () => {
    const nested = [repo("/Users/dev/work"), repo("/Users/dev/work/api")];
    expect(matchRepo(nested, "/Users/dev/work/api/src", HOME)).toBe(1);
    const [t] = attachRepos(nested, [term("t1", "/Users/dev/work/api/src")], HOME);
    expect(t.repo?.path).toBe("/Users/dev/work/api");
    expect(t.subPath).toBe("src");
  });

  it("keeps terminals in the order given", () => {
    const out = attachRepos(
      repos,
      [
        term("t1", "/Users/dev/redline"),
        term("t2", "/Users/dev/api"),
        term("t3", "/Users/dev/redline/src"),
      ],
      HOME,
    );
    expect(out.map((t) => [t.id, t.repo?.name ?? null])).toEqual([
      ["t1", "redline"],
      ["t2", "api"],
      ["t3", "redline"],
    ]);
  });
});

describe("repoChoices", () => {
  const repos = [repo("/Users/dev/redline"), repo("/Users/dev/api")];

  it("counts each repo's open terminals; empty repos still get a row", () => {
    const out = repoChoices(
      repos,
      [
        term("t1", "/Users/dev/redline"),
        term("t2", "/Users/dev/redline/src"),
        term("t3", null),
      ],
      HOME,
    );
    expect(out.map((r) => [r.name, r.count])).toEqual([
      ["redline", 2],
      ["api", 0],
    ]);
  });
});

describe("orderOpenRows", () => {
  it("tiled in tile order, then untiled most-recently-evicted first", () => {
    const rows = [
      term("a", null, { tile: 2 }),
      term("b", null, { tile: 0 }),
      term("c", null),
      term("d", null),
      term("e", null),
    ];
    // d was evicted most recently, then c; e never was → creation order last.
    const out = orderOpenRows(rows, ["d", "c"]);
    expect(out.map((r) => r.id)).toEqual(["b", "a", "d", "c", "e"]);
  });

  it("does not mutate its input", () => {
    const rows = [term("a", null, { tile: 1 }), term("b", null, { tile: 0 })];
    const snapshot = rows.map((r) => r.id);
    orderOpenRows(rows, []);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("matchesTerminalQuery", () => {
  const row = {
    label: "redline 2",
    work: "Fix the tile header memoization",
    subPath: "src/components",
    dir: "/Users/dev/redline/src/components",
    repoName: "redline",
  };

  it("matches label, work line, location and repo name, case-insensitively", () => {
    expect(matchesTerminalQuery(row, "redline")).toBe(true);
    expect(matchesTerminalQuery(row, "MEMO")).toBe(true);
    expect(matchesTerminalQuery(row, "components")).toBe(true);
    expect(matchesTerminalQuery(row, "polis")).toBe(false);
  });

  it("an empty or whitespace query matches everything", () => {
    expect(matchesTerminalQuery(row, "")).toBe(true);
    expect(matchesTerminalQuery(row, "   ")).toBe(true);
    expect(matchesTerminalQuery({}, "")).toBe(true);
  });

  it("null fields never match, never throw", () => {
    expect(
      matchesTerminalQuery({ label: "zsh 1", work: null, repoName: null }, "zsh"),
    ).toBe(true);
    expect(matchesTerminalQuery({ work: null }, "x")).toBe(false);
  });
});

describe("bumpMru", () => {
  it("moves an existing path to the front without duplicating it", () => {
    expect(bumpMru(["/a", "/b", "/c"], "/b", 12)).toEqual(["/b", "/a", "/c"]);
  });

  it("dedupes across a trailing slash", () => {
    expect(bumpMru(["/a/", "/b"], "/a", 12)).toEqual(["/a", "/b"]);
  });

  it("prepends a path it has never seen", () => {
    expect(bumpMru(["/a"], "/z", 12)).toEqual(["/z", "/a"]);
  });

  it("caps the list", () => {
    expect(bumpMru(["/a", "/b", "/c"], "/z", 2)).toEqual(["/z", "/a"]);
    expect(bumpMru(["/a"], "/z", 0)).toEqual([]);
  });
});

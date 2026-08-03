// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import {
  bumpMru,
  fitCount,
  groupTerminals,
  orderRepos,
  type RepoSource,
  type TerminalRef,
} from "./repoBubbles";

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
  pane: null,
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

describe("groupTerminals", () => {
  const repos = [repo("/Users/dev/redline"), repo("/Users/dev/api")];

  it("gives a terminal at the repo root an empty subPath", () => {
    const [redline] = groupTerminals(repos, [term("t1", "/Users/dev/redline")], HOME);
    expect(redline.instances.map((i) => [i.id, i.subPath])).toEqual([["t1", ""]]);
  });

  it("ignores a trailing slash on the shell's cwd", () => {
    const [redline] = groupTerminals(repos, [term("t1", "/Users/dev/redline/")], HOME);
    expect(redline.instances[0].subPath).toBe("");
  });

  it("records the relative remainder for a terminal below the root", () => {
    const [redline] = groupTerminals(
      repos,
      [term("t1", "/Users/dev/redline/src/components")],
      HOME,
    );
    expect(redline.instances[0].subPath).toBe("src/components");
  });

  it("carries the terminal's own signals through", () => {
    const [redline] = groupTerminals(
      repos,
      [
        term("t1", "/Users/dev/redline", {
          held: true,
          unseen: true,
          pane: "B",
          work: "Repo bubbles in the tab bar",
        }),
      ],
      HOME,
    );
    expect(redline.instances[0]).toMatchObject({
      label: "t1 1",
      held: true,
      unseen: true,
      pane: "B",
      work: "Repo bubbles in the tab bar",
    });
  });

  it("leaves a $HOME terminal (null dir) out of every repo", () => {
    const out = groupTerminals(repos, [term("t1", null)], HOME);
    expect(out.every((b) => b.instances.length === 0)).toBe(true);
  });

  it("leaves a terminal outside every repo out of every bubble", () => {
    const out = groupTerminals(repos, [term("t1", "/opt/homebrew")], HOME);
    expect(out.every((b) => b.instances.length === 0)).toBe(true);
  });

  it("does not match a sibling whose name merely shares a prefix", () => {
    const out = groupTerminals(
      [repo("/Users/dev/red")],
      [term("t1", "/Users/dev/redline")],
      HOME,
    );
    expect(out[0].instances).toEqual([]);
  });

  it("assigns a nested repo's terminal to the deepest root only", () => {
    const nested = [repo("/Users/dev/work"), repo("/Users/dev/work/api")];
    const out = groupTerminals(nested, [term("t1", "/Users/dev/work/api/src")], HOME);
    expect(out[0].instances).toEqual([]);
    expect(out[1].instances.map((i) => [i.id, i.subPath])).toEqual([["t1", "src"]]);
  });

  it("returns a bubble for a repo with no open terminals", () => {
    const out = groupTerminals(repos, [], HOME);
    expect(out.map((b) => b.name)).toEqual(["redline", "api"]);
    expect(out.map((b) => b.instances.length)).toEqual([0, 0]);
  });

  it("keeps several terminals in one repo, in the order given", () => {
    const out = groupTerminals(
      repos,
      [
        term("t1", "/Users/dev/redline"),
        term("t2", "/Users/dev/api"),
        term("t3", "/Users/dev/redline/src"),
      ],
      HOME,
    );
    expect(out[0].instances.map((i) => i.id)).toEqual(["t1", "t3"]);
    expect(out[1].instances.map((i) => i.id)).toEqual(["t2"]);
  });
});

describe("fitCount", () => {
  it("returns n when everything fits, with no chip reserved", () => {
    // 3 × 60 + 2 × 6 gap = 192.
    expect(fitCount([60, 60, 60], 192, 30, 6)).toBe(3);
  });

  it("reserves the chip's width once something has to be hidden", () => {
    // 191 is one px short of all three; two bubbles (126) + gap + chip = 162.
    expect(fitCount([60, 60, 60], 191, 30, 6)).toBe(2);
    // 161 no longer fits the chip alongside two bubbles.
    expect(fitCount([60, 60, 60], 161, 30, 6)).toBe(1);
  });

  it("accounts for the inter-bubble gap", () => {
    // Without the 6px gaps a 180px strip would hold all three.
    expect(fitCount([60, 60, 60], 180, 30, 6)).toBe(2);
  });

  it("returns 0 when even one bubble plus the chip won't fit", () => {
    expect(fitCount([60, 60], 95, 30, 6)).toBe(0);
    expect(fitCount([60, 60], 0, 30, 6)).toBe(0);
  });

  it("tolerates an empty list and a collapsed strip", () => {
    expect(fitCount([], 200, 30, 6)).toBe(0);
    expect(fitCount([], 0, 30, 6)).toBe(0);
  });

  it("fits a single bubble with no gap or chip in play", () => {
    expect(fitCount([60], 60, 30, 6)).toBe(1);
    expect(fitCount([60], 59, 30, 6)).toBe(0);
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

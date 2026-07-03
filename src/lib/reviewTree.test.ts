// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../types";
import { buildReviewTree } from "./reviewTree";

const f = (path: string, status: DiffFile["status"] = "modified"): DiffFile => ({
  oldPath: path,
  newPath: path,
  status,
  binary: false,
  hunks: [],
});

describe("buildReviewTree", () => {
  it("builds a nested tree with root files last", () => {
    const tree = buildReviewTree([f("src/a.ts"), f("README.md"), f("src/lib/b.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = tree[0];
    expect(src.children.map((n) => n.name)).toEqual(["lib", "a.ts"]);
    expect(src.children[0].children[0].file).toBeDefined();
  });

  it("collapses single-child directory chains", () => {
    const tree = buildReviewTree([f("a/b/c/deep.ts"), f("a/b/c/other.ts")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("a/b/c");
    expect(tree[0].children.map((n) => n.name)).toEqual(["deep.ts", "other.ts"]);
  });

  it("does not collapse through a level that owns a file", () => {
    const tree = buildReviewTree([f("a/file.ts"), f("a/b/deep.ts")]);
    expect(tree[0].name).toBe("a");
    expect(tree[0].children.map((n) => n.name)).toEqual(["b", "file.ts"]);
  });

  it("uses the deleted file's old path (displayPath rule)", () => {
    const gone: DiffFile = {
      oldPath: "src/gone.ts",
      newPath: "/dev/null",
      status: "deleted",
      binary: false,
      hunks: [],
    };
    const tree = buildReviewTree([gone]);
    expect(tree[0].name).toBe("src");
    expect(tree[0].children[0].path).toBe("src/gone.ts");
  });

  it("sorts directories before files, both alphabetically", () => {
    const tree = buildReviewTree([f("z.ts"), f("b/x.ts"), f("a.ts"), f("c/x.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["b", "c", "a.ts", "z.ts"]);
  });
});

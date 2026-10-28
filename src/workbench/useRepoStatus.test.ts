// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { GitWorkingStatus } from "../lib/git/types";
import { treeGitStatus } from "./useRepoStatus";

const status = (over: Partial<GitWorkingStatus>): GitWorkingStatus => ({
  branch: "main",
  head: "abc",
  upstream: null,
  ahead: 0,
  behind: 0,
  inProgress: null,
  staged: [],
  unstaged: [],
  conflicted: [],
  ...over,
});

describe("treeGitStatus", () => {
  it("makes paths absolute under the root and marks every folder above a change", () => {
    const t = treeGitStatus("/repo/", status({ staged: [{ path: "src/jobs/queue.ts", status: "M" }], unstaged: [{ path: "README.md", status: "?" }] }));
    expect(t.files.get("/repo/src/jobs/queue.ts")).toBe("M");
    expect(t.files.get("/repo/README.md")).toBe("?");
    expect([...t.dirs].sort()).toEqual(["/repo/src", "/repo/src/jobs"]);
  });
  it("lets a conflict outrank the other areas, and reads nothing from no status", () => {
    const t = treeGitStatus("/repo", status({ staged: [{ path: "a.ts", status: "M" }], conflicted: [{ path: "a.ts", status: "U" }] }));
    expect(t.files.get("/repo/a.ts")).toBe("U");
    expect(treeGitStatus("/repo", null).files.size).toBe(0);
  });
});

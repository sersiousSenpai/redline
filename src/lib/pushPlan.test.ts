// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { describe, expect, it } from "vitest";

import type { GitStatus } from "../types";
import {
  DEFAULT_PUSH_FORM,
  planPush,
  resolveTarget,
  roughRefError,
  toPushRequest,
  type PushFormState,
} from "./pushPlan";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    headShort: "a1b2c3d",
    headSubject: "init",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 2,
    untracked: 1,
    remotes: ["origin"],
    defaultRemote: "origin",
    defaultBranch: "main",
    inProgress: null,
    ghAvailable: true,
    ghAuthed: true,
    ...overrides,
  };
}

function form(overrides: Partial<PushFormState> = {}): PushFormState {
  return {
    ...DEFAULT_PUSH_FORM,
    targetMode: "new",
    targetName: "fix/review-notes",
    remote: "origin",
    message: "fix: tighten the guard",
    ...overrides,
  };
}

describe("roughRefError", () => {
  it("rejects the obvious and accepts normal branch names", () => {
    expect(roughRefError("fix/review-notes")).toBeNull();
    expect(roughRefError("v1.2-rc")).toBeNull();
    for (const bad of ["", "  ", "-rf", "a b", "a..b", "a@{1}", "x/", "x.lock", "x."]) {
      expect(roughRefError(bad), bad).not.toBeNull();
    }
  });
});

describe("resolveTarget", () => {
  it("uses the current branch for current mode, the typed name otherwise", () => {
    expect(resolveTarget(status(), form({ targetMode: "current" }))).toBe("main");
    expect(resolveTarget(status(), form({ targetName: "  padded  " }))).toBe("padded");
    expect(resolveTarget(null, form({ targetMode: "current" }))).toBe("");
  });
});

describe("planPush", () => {
  it("a clean form yields no errors and the full command preview in order", () => {
    const plan = planPush(status(), form(), ["a.rs", "b.rs"]);
    expect(plan.errors).toEqual([]);
    expect(plan.commands).toEqual([
      "git add -A -- (2 reviewed files)",
      "git commit -F -",
      "git push origin HEAD:refs/heads/fix/review-notes",
    ]);
    expect(plan.isProtected).toBe(false);
  });

  it("waits for status", () => {
    const plan = planPush(null, form(), null);
    expect(plan.errors).toEqual(["waiting for git status…"]);
  });

  it("blocks on in-progress operations, detached HEAD, and clean trees", () => {
    expect(
      planPush(status({ inProgress: "rebase" }), form(), null).errors.join(" "),
    ).toContain("rebase is in progress");
    expect(
      planPush(status({ branch: null }), form(), null).errors.join(" "),
    ).toContain("detached");
    expect(
      planPush(status({ staged: 0, unstaged: 0, untracked: 0 }), form(), null).errors.join(" "),
    ).toContain("nothing to commit");
    // Push-only doesn't need a commit or a message.
    const pushOnly = planPush(
      status({ staged: 0, unstaged: 0, untracked: 0, ahead: 1 }),
      form({ skipCommit: true, message: "" }),
      null,
    );
    expect(pushOnly.errors).toEqual([]);
    expect(pushOnly.commands).toEqual(["git push origin HEAD:refs/heads/fix/review-notes"]);
  });

  it("requires a valid target, remote, and message", () => {
    expect(planPush(status(), form({ targetName: "" }), null).errors).toContain(
      "pick a target branch",
    );
    expect(
      planPush(status(), form({ targetName: "-evil" }), null).errors.join(" "),
    ).toContain("dash");
    expect(
      planPush(status({ remotes: [] }), form(), null).errors.join(" "),
    ).toContain("no git remote");
    expect(
      planPush(status(), form({ remote: "upstream" }), null).errors.join(" "),
    ).toContain("not a configured remote");
    expect(planPush(status(), form({ message: "  " }), null).errors).toContain(
      "write a commit message",
    );
  });

  it("marks protected targets (remote default or main/master)", () => {
    expect(planPush(status(), form({ targetName: "main" }), null).isProtected).toBe(true);
    expect(planPush(status(), form({ targetName: "master" }), null).isProtected).toBe(true);
    expect(
      planPush(status({ defaultBranch: "trunk" }), form({ targetName: "trunk" }), null)
        .isProtected,
    ).toBe(true);
    expect(planPush(status(), form(), null).isProtected).toBe(false);
  });

  it("only offers -u when the target IS the current branch, and warns otherwise", () => {
    // Target == current branch → -u lands in the push command.
    const same = planPush(
      status(),
      form({ targetMode: "current", setUpstream: true, targetName: "" }),
      null,
    );
    expect(same.upstreamAllowed).toBe(true);
    expect(same.commands.join("\n")).toContain("git push -u origin HEAD:refs/heads/main");

    // Different target → -u is dropped from the command and warned about.
    const other = planPush(status(), form({ setUpstream: true }), null);
    expect(other.upstreamAllowed).toBe(false);
    expect(other.commands.join("\n")).not.toContain("-u ");
    expect(other.warnings.join(" ")).toContain("upstream");
  });

  it("warns when staging everything instead of the reviewed files", () => {
    const plan = planPush(status(), form(), null);
    expect(plan.commands[0]).toBe("git add -A");
    expect(plan.warnings.join(" ")).toContain("staging everything");
    expect(planPush(status(), form(), []).errors).toContain("no files selected to commit");
  });

  it("adds the local-branch and PR commands only when asked", () => {
    const plan = planPush(
      status(),
      form({ createLocalBranch: true, prEnabled: true, prTitle: "Fix the guard" }),
      ["a.rs"],
    );
    expect(plan.commands).toContain("git branch fix/review-notes HEAD");
    expect(plan.commands).toContain("gh pr create --head fix/review-notes --base main");
    // Creating a local branch that IS the current branch is a no-op — omitted.
    const current = planPush(
      status(),
      form({ targetMode: "current", createLocalBranch: true }),
      null,
    );
    expect(current.commands.join("\n")).not.toContain("git branch");
  });

  it("gates the PR on gh being installed and authenticated, with a title", () => {
    const noGh = planPush(
      status({ ghAvailable: false }),
      form({ prEnabled: true, prTitle: "t" }),
      null,
    );
    expect(noGh.errors.join(" ")).toContain("`gh` CLI installed");
    const unauthed = planPush(
      status({ ghAuthed: false }),
      form({ prEnabled: true, prTitle: "t" }),
      null,
    );
    expect(unauthed.errors.join(" ")).toContain("gh auth login");
    expect(
      planPush(status(), form({ prEnabled: true, prTitle: " " }), null).errors.join(" "),
    ).toContain("title");
    expect(
      planPush(
        status(),
        form({ prEnabled: true, prTitle: "t", prBase: "fix/review-notes" }),
        null,
      ).errors.join(" "),
    ).toContain("base and the target branch are the same");
  });
});

describe("toPushRequest", () => {
  it("assembles the backend request and drops -u for a non-current target", () => {
    const req = toPushRequest(
      "/repo",
      "rev-1",
      status(),
      form({ setUpstream: true, prEnabled: true, prTitle: "T", prBody: "B" }),
      ["a.rs"],
      false,
    );
    expect(req.target).toBe("fix/review-notes");
    expect(req.setUpstream).toBe(false);
    expect(req.paths).toEqual(["a.rs"]);
    expect(req.pr).toEqual({ title: "T", base: null, body: "B" });
    const current = toPushRequest(
      "/repo",
      "rev-1",
      status(),
      form({ targetMode: "current", setUpstream: true }),
      null,
      true,
    );
    expect(current.target).toBe("main");
    expect(current.setUpstream).toBe(true);
    expect(current.confirmProtected).toBe(true);
    expect(current.pr).toBeNull();
  });
});

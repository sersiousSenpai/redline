// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import type { GitStatus, PushRequest } from "../types";

// Pure core of the push dialog: (git status, form state) → what will run,
// what's blocked, and what deserves a warning. Drives the "what will run"
// preview, the disabled states, and every guard — unit-tested without a repo.
// The backend re-validates everything with git's own validators; the checks
// here exist so the user sees problems before clicking, not after.

export interface PushFormState {
  /** Where the work is published — the checkout is never switched. */
  targetMode: "current" | "existing" | "new";
  /** Branch name for the existing/new modes (ignored for current). */
  targetName: string;
  remote: string;
  message: string;
  setUpstream: boolean;
  createLocalBranch: boolean;
  noVerify: boolean;
  /** Push the current HEAD as-is — no stage, no commit. */
  skipCommit: boolean;
  prEnabled: boolean;
  prTitle: string;
  prBase: string;
  prBody: string;
}

export interface PushPlan {
  /** The resolved target branch ("" while unresolvable). */
  target: string;
  /** Human-readable preview of exactly what will run, in order. */
  commands: string[];
  /** Blocking problems — the push button stays disabled while any exist. */
  errors: string[];
  warnings: string[];
  /** Target is the remote's default branch (or main/master) — the dialog
   *  must raise a distinct second confirm. */
  isProtected: boolean;
  /** `-u` is only offered when the target equals the current branch: `git
   *  push -u <remote> HEAD:refs/heads/x` sets the CURRENT local branch's
   *  upstream to <remote>/x — a side effect the preview must surface. */
  upstreamAllowed: boolean;
}

export const DEFAULT_PUSH_FORM: PushFormState = {
  targetMode: "current",
  targetName: "",
  remote: "",
  message: "",
  setUpstream: false,
  createLocalBranch: false,
  noVerify: false,
  skipCommit: false,
  prEnabled: false,
  prTitle: "",
  prBase: "",
  prBody: "",
};

/** Rough client-side branch-name check — git's `check-ref-format` is the
 *  authority (the backend runs it); this only catches the obvious early. */
export function roughRefError(name: string): string | null {
  const t = name.trim();
  if (!t) return "branch name is empty";
  if (t.startsWith("-")) return "branch names can't start with a dash";
  if (/[\s~^:?*[\\]/.test(t)) return "branch names can't contain spaces or ~ ^ : ? * [ \\";
  if (t.includes("..") || t.includes("@{")) return "branch names can't contain .. or @{";
  if (t.endsWith("/") || t.endsWith(".") || t.endsWith(".lock"))
    return "branch names can't end with / or . or .lock";
  return null;
}

export function resolveTarget(status: GitStatus | null, form: PushFormState): string {
  if (form.targetMode === "current") return status?.branch ?? "";
  return form.targetName.trim();
}

export function planPush(
  status: GitStatus | null,
  form: PushFormState,
  /** Files that will be staged; null = everything (`git add -A`). */
  paths: string[] | null,
): PushPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const commands: string[] = [];

  const target = resolveTarget(status, form);
  const isProtected =
    !!target &&
    (target === status?.defaultBranch || target === "main" || target === "master");
  const upstreamAllowed = !!target && target === (status?.branch ?? null);

  if (!status) {
    return {
      target,
      commands,
      errors: ["waiting for git status…"],
      warnings,
      isProtected,
      upstreamAllowed,
    };
  }

  if (status.inProgress) {
    errors.push(
      `a ${status.inProgress} is in progress in this repository — finish or abort it first`,
    );
  }
  if (status.branch == null && !form.skipCommit) {
    errors.push("HEAD is detached — committing here would strand the commit");
  }
  if (form.targetMode === "current" && status.branch == null) {
    errors.push("no current branch to push (detached HEAD) — pick a target branch");
  }

  if (!target) {
    errors.push("pick a target branch");
  } else {
    const refErr = roughRefError(target);
    if (refErr) errors.push(refErr);
  }

  if (status.remotes.length === 0) {
    errors.push("this repository has no git remote — add one first");
  } else if (!form.remote) {
    errors.push("pick a remote");
  } else if (!status.remotes.includes(form.remote)) {
    errors.push(`\`${form.remote}\` is not a configured remote`);
  }

  if (!form.skipCommit) {
    if (!form.message.trim()) errors.push("write a commit message");
    const dirty = status.staged + status.unstaged + status.untracked;
    if (dirty === 0) errors.push("nothing to commit — the working tree is clean");
    if (paths != null && paths.length === 0) errors.push("no files selected to commit");
  } else if (status.ahead === 0 && status.upstream != null) {
    warnings.push("push-only with nothing ahead of the upstream — this may be a no-op");
  }

  if (form.prEnabled) {
    if (!status.ghAvailable) errors.push("opening a PR needs the `gh` CLI installed");
    else if (!status.ghAuthed) errors.push("`gh` isn't authenticated — run `gh auth login`");
    if (!form.prTitle.trim()) errors.push("give the pull request a title");
    if (target && form.prBase.trim() && form.prBase.trim() === target) {
      errors.push("the PR base and the target branch are the same");
    }
  }

  const wantUpstream = form.setUpstream && upstreamAllowed;
  if (form.setUpstream && !upstreamAllowed && target) {
    warnings.push(
      `-u here would set ${status.branch ?? "the current branch"}'s upstream to ` +
        `${form.remote || "<remote>"}/${target} — it's only applied when pushing the current branch`,
    );
  }

  // The preview — exactly what the backend will run, in order.
  if (!form.skipCommit) {
    commands.push(
      paths == null
        ? "git add -A"
        : `git add -A -- (${paths.length} reviewed file${paths.length === 1 ? "" : "s"})`,
    );
    if (paths == null) {
      warnings.push("staging everything in the working tree, not just the reviewed files");
    }
    commands.push(`git commit -F -${form.noVerify ? " --no-verify" : ""}`);
  }
  if (target && form.remote) {
    commands.push(
      `git push ${wantUpstream ? "-u " : ""}${form.remote} HEAD:refs/heads/${target}`,
    );
  }
  if (form.createLocalBranch && target && target !== status.branch) {
    commands.push(`git branch ${target} HEAD`);
  }
  if (form.prEnabled && target) {
    const base = form.prBase.trim() || status.defaultBranch || "main";
    commands.push(`gh pr create --head ${target} --base ${base}`);
  }

  return { target, commands, errors, warnings, isProtected, upstreamAllowed };
}

/** Assemble the backend request from a validated form. Call only when
 *  `planPush(...).errors` is empty. */
export function toPushRequest(
  repo: string,
  reviewId: string,
  status: GitStatus,
  form: PushFormState,
  paths: string[] | null,
  confirmProtected: boolean,
): PushRequest {
  const target = resolveTarget(status, form);
  return {
    repo,
    reviewId,
    message: form.message,
    paths,
    target,
    remote: form.remote,
    setUpstream: form.setUpstream && target === status.branch,
    createLocalBranch: form.createLocalBranch,
    noVerify: form.noVerify,
    skipCommit: form.skipCommit,
    confirmProtected,
    pr: form.prEnabled
      ? {
          title: form.prTitle.trim(),
          base: form.prBase.trim() || null,
          body: form.prBody,
        }
      : null,
  };
}

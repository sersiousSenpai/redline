// SPDX-License-Identifier: Apache-2.0
// Typed wrappers over the `git_gui_*` commands (docs/git-gui-contract.md).
import { invoke } from "@tauri-apps/api/core";
import type {
  GitArea,
  GitCheckoutKind,
  GitCommit,
  GitCommitDetail,
  GitDiffFile,
  GitOpResult,
  GitRefs,
  GitResetMode,
  GitWorkingStatus,
} from "../../lib/git/types";

export const PAGE_SIZE = 200;

export function gitApi(repo: string) {
  const op = (command: string, args: Record<string, unknown> = {}) =>
    invoke<GitOpResult>(command, { repo, ...args });
  return {
    status: () => invoke<GitWorkingStatus>("git_gui_status", { repo }),
    refs: () => invoke<GitRefs>("git_gui_refs", { repo }),
    fileDiff: (path: string, area: GitArea) => invoke<GitDiffFile | null>("git_gui_file_diff", { repo, path, area }),
    log: (skip: number, limit: number, all: boolean) => invoke<GitCommit[]>("git_gui_log", { repo, skip, limit, all }),
    commitDetail: (sha: string) => invoke<GitCommitDetail>("git_gui_commit_detail", { repo, sha }),
    commitFiles: (sha: string) => invoke<GitDiffFile[]>("git_gui_commit_files", { repo, sha }),
    stashFiles: (index: number) => invoke<GitDiffFile[]>("git_gui_stash_files", { repo, index }),
    lastMessage: () => invoke<string>("git_gui_last_message", { repo }),
    stage: (paths: string[]) => op("git_gui_stage", { paths }),
    unstage: (paths: string[]) => op("git_gui_unstage", { paths }),
    discard: (paths: string[]) => op("git_gui_discard", { paths }),
    applyPatch: (patch: string, target: "index" | "worktree", reverse: boolean) =>
      op("git_gui_apply_patch", { patch, target, reverse }),
    commit: (message: string, amend: boolean) => op("git_gui_commit", { message, amend }),
    fetch: () => op("git_gui_fetch"),
    pull: (rebase: boolean) => op("git_gui_pull", { rebase }),
    push: (remote: string, branch: string, setUpstream: boolean, forceWithLease: boolean) =>
      op("git_gui_push", { remote, branch, setUpstream, forceWithLease }),
    checkout: (target: string, kind: GitCheckoutKind) => op("git_gui_checkout", { target, kind }),
    branchCreate: (name: string, startPoint: string, checkout: boolean) =>
      op("git_gui_branch_create", { name, startPoint, checkout }),
    branchDelete: (name: string, force: boolean) => op("git_gui_branch_delete", { name, force }),
    merge: (target: string, noFf: boolean) => op("git_gui_merge", { target, noFf }),
    rebase: (onto: string) => op("git_gui_rebase", { onto }),
    continueOp: () => op("git_gui_continue"),
    abortOp: () => op("git_gui_abort"),
    cherryPick: (sha: string) => op("git_gui_cherry_pick", { sha }),
    revertCommit: (sha: string) => op("git_gui_revert_commit", { sha }),
    reset: (sha: string, mode: GitResetMode) => op("git_gui_reset", { sha, mode }),
    tagCreate: (name: string, sha: string, message?: string) =>
      op("git_gui_tag_create", { name, sha, message: message || null }),
    tagDelete: (name: string) => op("git_gui_tag_delete", { name }),
    stashSave: (message: string, includeUntracked: boolean) => op("git_gui_stash_save", { message, includeUntracked }),
    stashApply: (index: number, pop: boolean) => op("git_gui_stash_apply", { index, pop }),
    stashDrop: (index: number) => op("git_gui_stash_drop", { index }),
  };
}

export type GitApi = ReturnType<typeof gitApi>;

export const shortSha = (sha: string) => sha.slice(0, 7);

/** "origin/main" -> ["origin", "main"]. */
export function splitUpstream(upstream: string | null, remotes: string[]): [string, string] | null {
  if (!upstream) return null;
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => upstream.startsWith(`${r}/`));
  if (remote) return [remote, upstream.slice(remote.length + 1)];
  const slash = upstream.indexOf("/");
  return slash > 0 ? [upstream.slice(0, slash), upstream.slice(slash + 1)] : null;
}

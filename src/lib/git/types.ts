// SPDX-License-Identifier: Apache-2.0
// Shapes returned by the `git_gui_*` Tauri commands (docs/git-gui-contract.md).
import type { DiffFile, DiffHunk, DiffLine } from "../../types";

export type FileCode = "M" | "A" | "D" | "R" | "C" | "T" | "?" | "U";

export interface GitFileEntry {
  path: string;
  oldPath?: string;
  status: FileCode;
}

export type GitInProgress = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitWorkingStatus {
  /** null = detached HEAD */
  branch: string | null;
  /** full sha, null on an unborn branch */
  head: string | null;
  /** e.g. "origin/main" */
  upstream: string | null;
  ahead: number;
  behind: number;
  inProgress: GitInProgress | null;
  /** index vs HEAD */
  staged: GitFileEntry[];
  /** worktree vs index, untracked as "?" */
  unstaged: GitFileEntry[];
  /** unmerged paths, status "U" */
  conflicted: GitFileEntry[];
}

export type GitRefKind = "head" | "local" | "remote" | "tag";

export interface GitRefDecoration {
  name: string;
  kind: GitRefKind;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** unix seconds, author date */
  date: number;
  refs: GitRefDecoration[];
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  committerName: string;
  committerDate: number;
}

export interface GitLocalBranch {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  gone: boolean;
}

export interface GitRemoteBranch {
  remote: string;
  /** "origin/main" */
  name: string;
  sha: string;
}

export interface GitTag {
  name: string;
  sha: string;
}

export interface GitStash {
  index: number;
  message: string;
  sha: string;
  date: number;
}

export interface GitRefs {
  current: string | null;
  local: GitLocalBranch[];
  remote: GitRemoteBranch[];
  tags: GitTag[];
  stashes: GitStash[];
  remotes: string[];
}

export interface GitOpResult {
  /** stdout+stderr, raw */
  output: string;
  conflicts: string[];
}

export type GitArea = "unstaged" | "staged";
export type GitResetMode = "soft" | "mixed" | "hard";
export type GitCheckoutKind = "branch" | "remote" | "commit";

/** A diff line as the git client receives it. `noNewline` marks a line that is
 *  followed by "\ No newline at end of file" in git's output. */
export interface GitDiffLine extends DiffLine {
  noNewline?: boolean;
}
export interface GitDiffHunk extends Omit<DiffHunk, "lines"> {
  lines: GitDiffLine[];
}
export interface GitDiffFile extends Omit<DiffFile, "hunks"> {
  hunks: GitDiffHunk[];
}

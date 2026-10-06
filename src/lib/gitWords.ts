// SPDX-License-Identifier: Apache-2.0
/** All Guided Git vocabulary lives here, including action labels. */
export const gitWords = {
  commit: {
    word: "Saved version",
    explain: "A named snapshot you can return to later.",
    real: "commit",
  },
  uncommitted: {
    word: "Unsaved changes",
    explain: "Edits made since your last saved version.",
    real: "uncommitted changes",
  },
  diff: {
    word: "What changed",
    explain: "The differences between two versions of a file.",
    real: "diff",
  },
  push: {
    word: "Share with team",
    explain: "Send your saved versions to your team's copy.",
    real: "push",
  },
  remote: {
    word: "Team copy",
    explain: "The shared project, often hosted on GitHub.",
    real: "remote",
  },
  pr: {
    word: "Ask for review",
    explain: "Invite teammates to review your workspace before combining it.",
    real: "pull request (PR)",
  },
  merge: {
    word: "Bring in",
    explain: "Combine saved versions while keeping their history.",
    real: "merge",
  },
  branch: {
    word: "Workspace",
    explain: "A separate line of saved versions for an idea.",
    real: "branch",
  },
  worktree: {
    word: "Workspace",
    explain: "A separate folder where you can try an idea safely.",
    real: "worktree",
  },
  defaultBranch: {
    word: "Main version",
    explain: "The version your team treats as the starting point.",
    real: "default branch",
  },
  fetch: {
    word: "Get updates",
    explain: "Check your team's copy for saved versions you do not have yet.",
    real: "fetch",
  },
  pull: {
    word: "Get updates",
    explain: "Check for and bring in your team's new saved versions.",
    real: "pull",
  },
  conflict: {
    word: "Two edits to the same spot",
    explain: "The changes need a person's help to fit together.",
    real: "conflict",
  },
  revert: {
    word: "Undo",
    explain:
      "Prepare a new change that undoes an earlier change, preserving history.",
    real: "revert",
  },
  log: {
    word: "Timeline",
    explain: "The saved versions of this project, with who made each one.",
    real: "log",
  },
  ahead: {
    word: "Not shared yet",
    explain:
      "Saved versions that exist on this computer but not in your team's copy.",
    real: "ahead",
  },
  behind: {
    word: "New from your team",
    explain: "Saved versions in your team's copy that you have not brought in.",
    real: "behind",
  },
} as const;
export type GitTerm = keyof typeof gitWords;
export const gitActions = {
  save: { label: "Save a version", term: "commit" },
  share: { label: "Share with your team", term: "push" },
  updates: { label: "Get updates", term: "pull" },
  check: { label: "Check for updates", term: "fetch" },
  workspace: { label: "Create a workspace", term: "worktree" },
  timeline: { label: "Timeline", term: "log" },
  connect: { label: "Connect GitHub", term: "remote" },
  recover: { label: "Cancel unfinished combine", term: "merge" },
  notes: { label: "Send my notes to Claude", term: "diff" },
} as const satisfies Record<string, { label: string; term: GitTerm }>;
export type GitAction = keyof typeof gitActions;

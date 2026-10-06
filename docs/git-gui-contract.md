# Repository view (desktop Git client): contract

Replaces the Guided Git pose. The Code Review surface's header toggle becomes
**Review | Repository**. Review is the existing diff review and agent hold
loop, unchanged. Repository is a full Git client for the selected repo.

The audience is developers, so the UI uses real git words, real ref names and raw git output.
There is no narration and no plain-language rewriting.

## Ownership

- Backend agent: everything under `src-tauri/`.
- Frontend agent: everything under `src/` and `scripts/`/`fixtures/` for visual QA.
- This file is the interface. If a shape must change, change it here first and
  say so in the final report.

## Removed

- Guided UI: `src/components/guided/**`, the hooks `useSync`, `useWorkspaces` and `useNarration`,
  `lib/gitStory`, `lib/changeRisks`, `lib/gitWords`, `lib/guidedContext` and the
  ReviewDiscussionPane "Ask about this" seed that used it, the "Show Git in plain
  language" setting, and their tests.
- Backend: `narrate.rs` with its `change_narrator` seat, `workspaces.rs` (worktree
  workspaces, `guided_save`, `guided_share`), and `sync.rs` commands. Their logic folds into
  `git_gui.rs`. Shared test fixtures move to a `#[cfg(test)]` support module.
- Kept: `guided.rs` helpers (`run`, `read`, `repo_lock`, `revision`,
  `ActionResult`; `merge` was removed with its last callers), `git_human.rs`, `history_list`/`history_restore`,
  `review_revert`, `review_restore_undo`. The migration that created the
  `change_narrations`/`commit_narrations`/`git_workspaces` tables stays: the
  schema is the authority and must not regress. Dropping the tables is not part of this work.

## Pose

`useReviewPose` becomes `"review" | "repository"`. A stored `"guided"` or `"expert"` migrates to
`"review"`. The pose is remembered (localStorage plus the existing ui-pref sync) and defaults to `"review"`.
A `review-requested` hold always forces `"review"`.

## Backend commands (`src-tauri/src/git_gui.rs`)

Every command takes `repo: string` and validates it with
`review::checked_repo_dir`. Writes hold `guided::repo_lock` and set
`GIT_TERMINAL_PROMPT=0` (as `push::git_write` already does). After every
successful or partially successful write, emit the Tauri event
`git-gui-changed` with `{ repo }`. Errors are `Err(String)` carrying git's trimmed
stderr, not a humanized rewrite.

```ts
type FileCode = "M" | "A" | "D" | "R" | "C" | "T" | "?" | "U";
interface GitFileEntry { path: string; oldPath?: string; status: FileCode }
interface GitWorkingStatus {
  branch: string | null;          // null = detached HEAD
  head: string | null;            // full sha, null on an unborn branch
  upstream: string | null;        // e.g. "origin/main"
  ahead: number; behind: number;
  inProgress: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  staged: GitFileEntry[];         // index vs HEAD
  unstaged: GitFileEntry[];       // worktree vs index, untracked as "?"
  conflicted: GitFileEntry[];     // unmerged paths, status "U"
}
interface GitRefDecoration { name: string; kind: "head" | "local" | "remote" | "tag" }
interface GitCommit {
  sha: string; parents: string[]; subject: string;
  authorName: string; authorEmail: string; date: number; // unix seconds, author date
  refs: GitRefDecoration[];       // "head" = HEAD -> branch marker
}
interface GitCommitDetail extends GitCommit { body: string; committerName: string; committerDate: number }
interface GitLocalBranch { name: string; sha: string; upstream: string | null; ahead: number; behind: number; current: boolean; gone: boolean }
interface GitRemoteBranch { remote: string; name: string /* "origin/main" */; sha: string }
interface GitTag { name: string; sha: string }
interface GitStash { index: number; message: string; sha: string; date: number }
interface GitRefs { current: string | null; local: GitLocalBranch[]; remote: GitRemoteBranch[]; tags: GitTag[]; stashes: GitStash[]; remotes: string[] }
interface GitOpResult { output: string; conflicts: string[] } // output = stdout+stderr, raw
// DiffFile = the existing src/types.ts DiffFile (review::parse_unified_diff)
// ...plus one optional field on DiffLine: `noNewline?: true` on a line that git
// follows with "\ No newline at end of file" (serde: omit when false). The
// parser must set it instead of silently skipping the marker, or line/hunk
// patches built from the diff lose it and `git apply` rejects them at EOF.
// [frontend amendment; consumers that ignore the field are unaffected]
```

| Command | Args (camelCase) | Returns | Notes |
|---|---|---|---|
| `git_gui_status` | repo | `GitWorkingStatus` | `status --porcelain=v2 -z --branch` |
| `git_gui_file_diff` | repo, path, area: `"unstaged"\|"staged"` | `DiffFile \| null` | untracked: diff against /dev/null; binary flagged |
| `git_gui_log` | repo, skip, limit (≤500), all: bool | `GitCommit[]` | `--date-order`, `--all` excludes `refs/stash` |
| `git_gui_commit_detail` | repo, sha | `GitCommitDetail` | |
| `git_gui_commit_files` | repo, sha | `DiffFile[]` | vs first parent; root commit vs empty tree; `-M` |
| `git_gui_refs` | repo | `GitRefs` | |
| `git_gui_stage` | repo, paths[] | `GitOpResult` | `add -A --` handles deletions |
| `git_gui_unstage` | repo, paths[] | `GitOpResult` | `restore --staged`; unborn HEAD → `rm --cached` |
| `git_gui_discard` | repo, paths[] | `GitOpResult` | tracked → restore worktree; untracked → delete. A recovery copy goes to `.git/redline-undo/` first, as `review_revert` does |
| `git_gui_apply_patch` | repo, patch, target: `"index"\|"worktree"`, reverse | `GitOpResult` | `apply --recount --whitespace=nowarn [--cached] [-R]`; a worktree apply saves a recovery copy |
| `git_gui_commit` | repo, message, amend | `GitOpResult` | `commit -F -`; empty message refused |
| `git_gui_last_message` | repo | `string` | for amend prefill |
| `git_gui_fetch` | repo | `GitOpResult` | `fetch --all --prune` |
| `git_gui_pull` | repo, rebase: bool | `GitOpResult` | conflicts listed, not thrown |
| `git_gui_push` | repo, remote, branch, setUpstream, forceWithLease | `GitOpResult` | |
| `git_gui_checkout` | repo, target, kind: `"branch"\|"remote"\|"commit"` | `GitOpResult` | remote → `switch --track`; commit → `switch --detach` |
| `git_gui_branch_create` | repo, name, startPoint, checkout | `GitOpResult` | name validated by `check-ref-format --branch` |
| `git_gui_branch_delete` | repo, name, force | `GitOpResult` | refuses the current branch |
| `git_gui_merge` | repo, target, noFf | `GitOpResult` | conflicts listed, not thrown |
| `git_gui_rebase` | repo, onto | `GitOpResult` | conflicts listed, not thrown |
| `git_gui_continue` | repo | `GitOpResult` | continues whichever operation is in progress (`GIT_EDITOR=true`) |
| `git_gui_abort` | repo | `GitOpResult` | aborts whichever operation is in progress |
| `git_gui_cherry_pick` | repo, sha | `GitOpResult` | |
| `git_gui_revert_commit` | repo, sha | `GitOpResult` | `revert --no-edit` |
| `git_gui_reset` | repo, sha, mode: `"soft"\|"mixed"\|"hard"` | `GitOpResult` | hard writes a recovery copy first |
| `git_gui_tag_create` | repo, name, sha, message? | `GitOpResult` | annotated when message given |
| `git_gui_tag_delete` | repo, name | `GitOpResult` | local only |
| `git_gui_stash_save` | repo, message, includeUntracked | `GitOpResult` | |
| `git_gui_stash_apply` | repo, index, pop | `GitOpResult` | conflicts listed |
| `git_gui_stash_drop` | repo, index | `GitOpResult` | |
| `git_gui_stash_files` | repo, index | `DiffFile[]` | |

All user-supplied refs/shas/names pass `crate::code::safe_token` or
`check-ref-format`. Paths are passed after `--`. No shell is involved.

Backend behavior notes (as built):

- `git-gui-changed` is emitted after every write command that passed repo
  validation, failed ones included (a failed pull can still have moved refs).
- `GitRefDecoration` kind `head` carries the checked-out branch's name (e.g.
  `main`) and replaces that branch's `local` entry; a detached HEAD is
  `{ name: "HEAD", kind: "head" }`. Remote `*/HEAD` symrefs are omitted.
- `git_gui_status` lists untracked files individually (`-uall`); `inProgress`
  never reports bisect. Ahead/behind are 0 when the upstream is gone.
- `git_gui_file_diff` on a conflicted path in `unstaged` diffs it against HEAD
  (the conflict markers show as added lines); don't offer hunk actions there.
  A staged rename returns one `Renamed` file. Returns null when there is no diff.
- `git_gui_log` with `all: false` on an unborn branch returns `[]`;
  `git_gui_last_message` returns `""` there.
- `git_gui_branch_create`: `startPoint` may be null/empty (HEAD). A remote
  start point sets up tracking. `git_gui_tag_create`: a blank message makes a
  lightweight tag.
- `git_gui_checkout` kind `remote` switches to the existing local branch when
  one already tracks that remote branch, else `switch --track`.
- `git_gui_cherry_pick`/`git_gui_revert_commit` on a merge commit use `-m 1`.
- `git_gui_discard`, worktree `git_gui_apply_patch` and hard `git_gui_reset`
  start `output` with `Recovery copy saved to <folder>` (under
  `.git/redline-undo/<uuid>/files/`, with a `meta.json`). Hard reset also saves
  untracked files the target commit would overwrite.
- `git_gui_continue` may return new `conflicts` (the next rebase step, or
  paths still unresolved) instead of an error.

## Frontend (`src/components/git/`, lazy chunk)

The layout follows the classic desktop git client:

- **Toolbar:** Commit, Pull, Push, Fetch, Branch, Merge, Stash. Pull and Push show behind/ahead badges.
  An in-progress banner offers Continue and Abort.
- **Left sidebar:**
  - WORKSPACE (File status with a change count, History).
  - BRANCHES: local, with the current branch bold and ahead/behind shown.
  - REMOTES: a tree per remote.
  - TAGS and STASHES.
  - Double-clicking a branch checks it out. Each item has a context menu: checkout, merge into current, rebase current onto, new branch from, delete, push; stash apply/pop/drop.
- **File status:** an Unstaged list and a Staged list with checkboxes, plus Stage all and Unstage all.
  - The diff pane renders the selected file's hunks.
    - A hunk has Stage hunk, Unstage hunk or Discard hunk.
    - Line selection (click, then shift-click) gives Stage lines, Unstage lines or Discard lines.
  - The commit box has Amend (which prefills the last message) and a "Push changes immediately" option.
- **History:**
  - A graph column with lanes and merge curves.
  - Description with ref chips: the current branch is emphasized, remotes and tags are styled differently.
  - Date, Author and short Commit columns. The list is virtualized and paged 200 at a time on scroll.
  - Selecting a commit shows the detail and changed files below, plus the diff.
  - The commit context menu has: checkout (detached), new branch here, tag here, cherry-pick, revert, and reset current branch here (soft/mixed/hard). Hard needs confirmation.
- **Confirmation** is required for discard, hard reset, branch delete and force push.
- **Refresh** happens after every op, on the `git-gui-changed` event, on window focus, and every 4 s while visible.
  Status polling never overlaps itself.
- **Errors** show git's raw output in an output drawer. The last op's output can always be reopened.

Pure, unit-tested libraries:

- `src/lib/git/graph.ts`: lane assignment over `GitCommit[]` in date order. It returns
  per-row `{lane, color, edges}` and handles merges, octopus merges and branches that end.
- `src/lib/git/patch.ts`: builds a patch from a selection.
  - Staging (worktree → index): unselected `+` lines are dropped and unselected `-` lines become context.
  - Reverse (unstage, discard): unselected `-` lines are dropped and unselected `+` lines become context, applied with `-R`.
  - Hunk headers keep the original starts; `--recount` fixes the counts.
  - "\ No newline at end of file" lines are preserved.

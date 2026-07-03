// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Git worktree isolation for the Loop Orchestrator — the one genuinely new
//! subsystem (the rest of `looporch.rs` clones `mission.rs`). Each executor
//! agent runs in its own throwaway worktree/branch so parallel makers never
//! touch the same working tree, and every approved subtask merges into a
//! per-run **integration branch** rather than the user's real base. The user's
//! `base_ref` is written exactly once, at run end, behind the land checkpoint —
//! so a mid-run crash leaves their branch pristine.
//!
//! Clones `update.rs`'s git helper: the absolute `/usr/bin/git` (the CLT shim,
//! robust under a Finder launch where PATH has no git), `-C <repo>`, null
//! stdin, captured stdout/stderr, `tokio::process::Command`.
//!
//! ## The integration-branch model
//! - `init_integration` cuts `redline/loop/<run8>/integration` off `base_ref`
//!   and checks it out in a dedicated worktree — merges happen there, never in
//!   the user's main checkout.
//! - `create_worktree` forks each subtask branch off the integration tip, so
//!   already-merged dependency work is visible to later executors.
//! - `merge_into_integration` merges an approved subtask branch into the
//!   integration branch (in the integration worktree). Callers serialize this.
//! - `land_integration` is the single write to `base_ref`, in the user's main
//!   repo, behind the human land checkpoint.

use std::path::{Path, PathBuf};
use std::process::Stdio;

/// Injected git identity for orchestrator-owned commits/merges — avoids a
/// "please tell me who you are" failure on a machine with no global git config.
const GIT_IDENTITY: [&str; 4] = [
    "-c",
    "user.name=Redline",
    "-c",
    "user.email=loop@redline.local",
];

/// Outcome of a merge attempt. A conflict is a first-class, recoverable result
/// (route the subtask back to its executor), not an error.
#[derive(Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged,
    Conflict,
}

/// Owns the on-disk worktree root (`<app_data_dir>/loop-worktrees`) and shells
/// out to git. Stateless beyond `root`; all run/subtask identity is passed in.
pub struct WorktreeManager {
    root: PathBuf,
}

impl WorktreeManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `<root>/<run8>` — a run's private worktree namespace.
    fn run_dir(&self, run8: &str) -> PathBuf {
        self.root.join(run8)
    }

    /// The dedicated integration worktree for a run (checked out on the
    /// integration branch; where subtask merges land).
    pub fn integration_worktree(&self, run8: &str) -> PathBuf {
        self.run_dir(run8).join("integration")
    }

    /// A subtask's worktree path, `<root>/<run8>/<seq>-<slug>`.
    pub fn subtask_worktree(&self, run8: &str, seq: i64, slug: &str) -> PathBuf {
        self.run_dir(run8).join(format!("{seq}-{slug}"))
    }

    // --- Pre-flight checks ------------------------------------------------

    /// True when `repo` is inside a git work tree.
    pub async fn is_git_repo(&self, repo: &Path) -> bool {
        git(repo, &["rev-parse", "--is-inside-work-tree"]).await.is_ok()
    }

    /// True when the working tree is clean (`git status --porcelain` empty).
    /// The land step guards on this directly; kept as a named helper.
    #[allow(dead_code)]
    pub async fn is_clean(&self, repo: &Path) -> Result<bool, String> {
        Ok(git(repo, &["status", "--porcelain"]).await?.is_empty())
    }

    /// The repo's current branch (`HEAD`), e.g. `main` or `master`. Used to
    /// prefill the run's base ref rather than hard-guessing `main`.
    pub async fn current_branch(&self, repo: &Path) -> Result<String, String> {
        git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await
    }

    /// Number of uncommitted changes (`git status --porcelain` lines) — 0 is a
    /// clean tree. Lets the UI warn about dirtiness before a run is attempted.
    pub async fn dirty_count(&self, repo: &Path) -> Result<usize, String> {
        Ok(git(repo, &["status", "--porcelain"])
            .await?
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count())
    }

    /// True when `git_ref` resolves in `repo`.
    pub async fn ref_exists(&self, repo: &Path, git_ref: &str) -> bool {
        git(repo, &["rev-parse", "--verify", "--quiet", git_ref])
            .await
            .is_ok()
    }

    /// Restart recovery for the integration worktree: if it vanished but its
    /// branch still exists, re-attach a worktree to the EXISTING branch (never
    /// re-cut from base — that would discard already-merged work).
    pub async fn adopt_integration(
        &self,
        repo: &Path,
        integration_branch: &str,
        base_ref: &str,
        run8: &str,
    ) -> Result<PathBuf, String> {
        let wt = self.integration_worktree(run8);
        if is_worktree(&wt).await {
            return Ok(wt);
        }
        let _ = git(repo, &["worktree", "prune"]).await;
        ensure_parent(&wt)?;
        if self.ref_exists(repo, integration_branch).await {
            git(repo, &["worktree", "add", &wt.to_string_lossy(), integration_branch]).await?;
            Ok(wt)
        } else {
            // Branch gone too (fresh machine): re-cut from base.
            self.init_integration(repo, integration_branch, base_ref, run8).await
        }
    }

    // --- Integration branch lifecycle -------------------------------------

    /// Cut `<integration_branch>` off `<base_ref>` and check it out in the
    /// dedicated integration worktree. Idempotent-ish: if the worktree already
    /// exists (adopt after restart), this is a no-op success.
    pub async fn init_integration(
        &self,
        repo: &Path,
        integration_branch: &str,
        base_ref: &str,
        run8: &str,
    ) -> Result<PathBuf, String> {
        let wt = self.integration_worktree(run8);
        if is_worktree(&wt).await {
            return Ok(wt);
        }
        ensure_parent(&wt)?;
        // `worktree add -b` creates the branch AND its worktree in one step.
        git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                integration_branch,
                &wt.to_string_lossy(),
                base_ref,
            ],
        )
        .await?;
        Ok(wt)
    }

    /// Fork a subtask branch off the **integration tip** and add its worktree.
    /// Reused on retries: if the worktree is already live, return it as-is.
    pub async fn create_worktree(
        &self,
        repo: &Path,
        integration_branch: &str,
        branch: &str,
        run8: &str,
        seq: i64,
        slug: &str,
    ) -> Result<PathBuf, String> {
        let wt = self.subtask_worktree(run8, seq, slug);
        if is_worktree(&wt).await {
            return Ok(wt);
        }
        ensure_parent(&wt)?;
        git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &wt.to_string_lossy(),
                integration_branch,
            ],
        )
        .await?;
        Ok(wt)
    }

    // --- Executor-worktree operations (orchestrator-owned) ----------------

    /// `git add -A && git commit` with the injected identity. Returns `Ok(false)`
    /// when there was nothing to commit (a no-op attempt), `Ok(true)` on a real
    /// commit.
    pub async fn commit_all(&self, worktree: &Path, message: &str) -> Result<bool, String> {
        git(worktree, &["add", "-A"]).await?;
        // `diff --cached --quiet` exits 1 when there are staged changes.
        let has_staged = git_status(worktree, &["diff", "--cached", "--quiet"])
            .await
            .map(|code| code == 1)?;
        if !has_staged {
            return Ok(false);
        }
        let mut args: Vec<&str> = GIT_IDENTITY.to_vec();
        args.extend_from_slice(&["commit", "-m", message]);
        git(worktree, &args).await?;
        Ok(true)
    }

    /// Files changed in the worktree relative to the integration tip — feeds the
    /// post-exec scope check.
    pub async fn changed_paths(
        &self,
        worktree: &Path,
        integration_branch: &str,
    ) -> Result<Vec<String>, String> {
        let out = git(worktree, &["diff", "--name-only", integration_branch]).await?;
        Ok(out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
    }

    /// `git diff --stat <base>` — the human-readable summary shown at merge/land.
    pub async fn diff_stat(&self, worktree: &Path, base: &str) -> Result<String, String> {
        git(worktree, &["diff", "--stat", base]).await
    }

    /// Full `git diff <base>` — the reviewer runs its own `git diff`, so this is
    /// kept for programmatic use (e.g. attaching a diff to a checkpoint).
    #[allow(dead_code)]
    pub async fn diff(&self, worktree: &Path, base: &str) -> Result<String, String> {
        git(worktree, &["diff", base]).await
    }

    // --- Merge / land -----------------------------------------------------

    /// Merge an approved subtask branch into the integration branch, inside the
    /// dedicated integration worktree (never touches the user's checkout).
    /// Callers MUST serialize this per run (the orchestrator's `merge_locks`).
    /// A conflict aborts cleanly and returns `Conflict`.
    pub async fn merge_into_integration(
        &self,
        run8: &str,
        branch: &str,
    ) -> Result<MergeOutcome, String> {
        let wt = self.integration_worktree(run8);
        let mut args: Vec<&str> = GIT_IDENTITY.to_vec();
        args.extend_from_slice(&["merge", "--no-ff", "--no-edit", branch]);
        match git_merge(&wt, &args).await? {
            MergeOutcome::Merged => Ok(MergeOutcome::Merged),
            MergeOutcome::Conflict => {
                let _ = git(&wt, &["merge", "--abort"]).await;
                Ok(MergeOutcome::Conflict)
            }
        }
    }

    /// The one and only write to the user's real `base_ref`: switch the main
    /// repo to base and merge the integration branch. Hard-refuses on a dirty
    /// tree (worktrees off a dirty base are unsafe, and we won't clobber the
    /// user's uncommitted work). A conflict aborts and leaves the integration
    /// branch intact for manual landing.
    pub async fn land_integration(
        &self,
        repo: &Path,
        base_ref: &str,
        integration_branch: &str,
    ) -> Result<MergeOutcome, String> {
        let dirty = !git(repo, &["status", "--porcelain"]).await?.is_empty();
        if dirty {
            return Err(
                "the target repo has uncommitted changes — commit or stash them, \
                 then land the integration branch manually"
                    .to_string(),
            );
        }
        let current = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        if current != base_ref {
            git(repo, &["switch", base_ref]).await?;
        }
        let mut args: Vec<&str> = GIT_IDENTITY.to_vec();
        args.extend_from_slice(&["merge", "--no-ff", "--no-edit", integration_branch]);
        match git_merge(repo, &args).await? {
            MergeOutcome::Merged => Ok(MergeOutcome::Merged),
            MergeOutcome::Conflict => {
                let _ = git(repo, &["merge", "--abort"]).await;
                Ok(MergeOutcome::Conflict)
            }
        }
    }

    // --- Cleanup / adopt --------------------------------------------------

    /// Remove a subtask worktree and (unless kept for forensics) delete its
    /// branch. Best-effort — a missing worktree is not an error.
    pub async fn cleanup(
        &self,
        repo: &Path,
        worktree: &Path,
        branch: &str,
        keep_branch: bool,
    ) -> Result<(), String> {
        let _ = git(repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()]).await;
        if !keep_branch {
            let _ = git(repo, &["branch", "-D", branch]).await;
        }
        Ok(())
    }

    /// Tear down an entire run's worktrees + integration branch (on run delete).
    /// Failed/denied runs keep the integration branch for inspection.
    pub async fn cleanup_run(
        &self,
        repo: &Path,
        run8: &str,
        integration_branch: &str,
        keep_integration: bool,
    ) -> Result<(), String> {
        let dir = self.run_dir(run8);
        // Remove any live worktrees under this run's dir, then prune the admin
        // records, then delete the directory tree.
        let _ = git(repo, &["worktree", "prune"]).await;
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        let _ = git(repo, &["worktree", "prune"]).await;
        if !keep_integration {
            let _ = git(repo, &["branch", "-D", integration_branch]).await;
        }
        Ok(())
    }

    /// Restart recovery: ensure a subtask's worktree exists, recreating it off
    /// the integration tip if it vanished (e.g. the app data dir was cleaned).
    /// Returns the worktree path.
    pub async fn adopt_worktree(
        &self,
        repo: &Path,
        integration_branch: &str,
        branch: &str,
        run8: &str,
        seq: i64,
        slug: &str,
    ) -> Result<PathBuf, String> {
        let wt = self.subtask_worktree(run8, seq, slug);
        if is_worktree(&wt).await {
            return Ok(wt);
        }
        // The worktree admin record may be stale; prune before re-adding.
        let _ = git(repo, &["worktree", "prune"]).await;
        ensure_parent(&wt)?;
        // If the branch still exists, attach it; otherwise re-fork it.
        let branch_exists = git(repo, &["rev-parse", "--verify", "--quiet", branch])
            .await
            .is_ok();
        if branch_exists {
            git(repo, &["worktree", "add", &wt.to_string_lossy(), branch]).await?;
        } else {
            git(
                repo,
                &[
                    "worktree",
                    "add",
                    "-b",
                    branch,
                    &wt.to_string_lossy(),
                    integration_branch,
                ],
            )
            .await?;
        }
        Ok(wt)
    }
}

// --- git plumbing ----------------------------------------------------------

/// Run `git` in `dir` and return trimmed stdout, or trimmed stderr as the error.
/// `/usr/bin/git` is the CLT shim — present on any machine that compiled this
/// app, unlike a PATH lookup under a Finder launch. Mirrors `update.rs::git`.
/// `pub(crate)` so the read-only git bridge (`code.rs`) reuses this one CLT-git
/// invocation rather than keeping its own copy.
pub(crate) async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Run a `git merge` and classify the result. A merge conflict reports its
/// "CONFLICT …" / "Automatic merge failed" lines on **stdout** (not stderr) and
/// exits non-zero, so the generic `git()` helper — which only surfaces stderr —
/// can't tell a conflict from a real failure. This inspects both streams: a
/// conflict is `Ok(Conflict)`; any other non-zero exit is a genuine `Err`.
async fn git_merge(dir: &Path, args: &[&str]) -> Result<MergeOutcome, String> {
    let output = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(MergeOutcome::Merged);
    }
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
        Ok(MergeOutcome::Conflict)
    } else {
        Err(combined.trim().to_string())
    }
}

/// Run `git` for its exit code (e.g. `diff --quiet`), where a non-zero code is
/// meaningful signal, not failure. Returns the code (128 for spawn/other errors).
async fn git_status(dir: &Path, args: &[&str]) -> Result<i32, String> {
    let status = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(128))
}

/// True when `path` is a live git worktree (its `.git` resolves).
async fn is_worktree(path: &Path) -> bool {
    path.exists() && git(path, &["rev-parse", "--is-inside-work-tree"]).await.is_ok()
}

/// Create a worktree path's parent dir (`<root>/<run8>`) before `git worktree add`.
fn ensure_parent(wt: &Path) -> Result<(), String> {
    if let Some(parent) = wt.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Slugify a subtask title for a branch/worktree segment: lowercase, alnum runs
/// joined by `-`, capped. Empty input yields `task`.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 32 {
            break;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() {
        "task".to_string()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Absolute `/usr/bin/git`, run in `dir`, panicking on failure — a test
    /// harness helper for seeding scratch repos.
    async fn run_git(dir: &Path, args: &[&str]) {
        let out = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn tmpdir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("redline-wt-{tag}-{}", uuid::Uuid::new_v4()))
    }

    /// Init a scratch repo on `main` with one committed file.
    async fn scratch_repo() -> PathBuf {
        let repo = tmpdir("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]).await;
        run_git(&repo, &["config", "user.name", "Test"]).await;
        run_git(&repo, &["config", "user.email", "test@test.local"]).await;
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "-A"]).await;
        run_git(&repo, &["commit", "-m", "init"]).await;
        repo
    }

    async fn write_file(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, contents).unwrap();
    }

    #[tokio::test]
    async fn create_edit_commit_diff_merge_clean_cleanup() {
        let repo = scratch_repo().await;
        let wm = WorktreeManager::new(tmpdir("root"));
        let run8 = "run00001";
        let ib = "redline/loop/run00001/integration";

        wm.init_integration(&repo, ib, "main", run8).await.unwrap();
        let wt = wm
            .create_worktree(&repo, ib, "redline/loop/run00001/1-add-file", run8, 1, "add-file")
            .await
            .unwrap();

        // Executor edits a NEW file (disjoint from README).
        write_file(&wt, "feature.txt", "the feature\n").await;
        let committed = wm.commit_all(&wt, "add-file: attempt 1").await.unwrap();
        assert!(committed, "a real change must commit");

        let changed = wm.changed_paths(&wt, ib).await.unwrap();
        assert_eq!(changed, vec!["feature.txt".to_string()]);

        let stat = wm.diff_stat(&wt, ib).await.unwrap();
        assert!(stat.contains("feature.txt"), "diff-stat names the file: {stat}");

        let outcome = wm
            .merge_into_integration(run8, "redline/loop/run00001/1-add-file")
            .await
            .unwrap();
        assert_eq!(outcome, MergeOutcome::Merged);

        // The integration worktree now has the file.
        let int_wt = wm.integration_worktree(run8);
        assert!(int_wt.join("feature.txt").exists(), "merge landed in integration");

        // A second commit-all with no changes is a no-op.
        let noop = wm.commit_all(&wt, "empty").await.unwrap();
        assert!(!noop);

        wm.cleanup(&repo, &wt, "redline/loop/run00001/1-add-file", false)
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(wm.integration_worktree(run8).parent().unwrap());
    }

    #[tokio::test]
    async fn seeded_conflict_aborts_and_leaves_integration_clean() {
        let repo = scratch_repo().await;
        let wm = WorktreeManager::new(tmpdir("root"));
        let run8 = "run00002";
        let ib = "redline/loop/run00002/integration";
        wm.init_integration(&repo, ib, "main", run8).await.unwrap();

        // Two subtasks that both edit the SAME line of README → guaranteed conflict.
        let wt_a = wm.create_worktree(&repo, ib, "b-a", run8, 1, "a").await.unwrap();
        let wt_b = wm.create_worktree(&repo, ib, "b-b", run8, 2, "b").await.unwrap();
        write_file(&wt_a, "README.md", "hello from A\n").await;
        wm.commit_all(&wt_a, "a").await.unwrap();
        write_file(&wt_b, "README.md", "hello from B\n").await;
        wm.commit_all(&wt_b, "b").await.unwrap();

        // First merges clean; second conflicts.
        assert_eq!(
            wm.merge_into_integration(run8, "b-a").await.unwrap(),
            MergeOutcome::Merged
        );
        assert_eq!(
            wm.merge_into_integration(run8, "b-b").await.unwrap(),
            MergeOutcome::Conflict
        );

        // The integration worktree must be clean after the aborted merge (no
        // dangling MERGE_HEAD / conflict markers).
        let int_wt = wm.integration_worktree(run8);
        let porcelain = git(&int_wt, &["status", "--porcelain"]).await.unwrap();
        assert!(porcelain.is_empty(), "aborted merge left dirt: {porcelain}");
        assert!(
            !int_wt.join(".git").exists() || git(&int_wt, &["rev-parse", "MERGE_HEAD"]).await.is_err(),
            "MERGE_HEAD should be gone after abort"
        );

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(wm.run_dir(run8));
    }

    #[tokio::test]
    async fn land_writes_base_only_at_the_end() {
        let repo = scratch_repo().await;
        let wm = WorktreeManager::new(tmpdir("root"));
        let run8 = "run00003";
        let ib = "redline/loop/run00003/integration";
        wm.init_integration(&repo, ib, "main", run8).await.unwrap();

        let base_before = git(&repo, &["rev-parse", "main"]).await.unwrap();

        let wt = wm.create_worktree(&repo, ib, "b1", run8, 1, "x").await.unwrap();
        write_file(&wt, "x.txt", "x\n").await;
        wm.commit_all(&wt, "x").await.unwrap();
        wm.merge_into_integration(run8, "b1").await.unwrap();

        // Base is untouched until land.
        assert_eq!(git(&repo, &["rev-parse", "main"]).await.unwrap(), base_before);

        let outcome = wm.land_integration(&repo, "main", ib).await.unwrap();
        assert_eq!(outcome, MergeOutcome::Merged);
        // Now base moved and has the file.
        assert_ne!(git(&repo, &["rev-parse", "main"]).await.unwrap(), base_before);
        assert!(repo.join("x.txt").exists(), "landed file present on base");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(wm.run_dir(run8));
    }

    #[tokio::test]
    async fn adopt_recreates_a_missing_worktree() {
        let repo = scratch_repo().await;
        let wm = WorktreeManager::new(tmpdir("root"));
        let run8 = "run00004";
        let ib = "redline/loop/run00004/integration";
        wm.init_integration(&repo, ib, "main", run8).await.unwrap();
        let wt = wm.create_worktree(&repo, ib, "b1", run8, 1, "x").await.unwrap();

        // Simulate the app-data dir being cleaned: nuke the worktree on disk.
        std::fs::remove_dir_all(&wt).unwrap();
        assert!(!is_worktree(&wt).await);

        let re = wm.adopt_worktree(&repo, ib, "b1", run8, 1, "x").await.unwrap();
        assert_eq!(re, wt);
        assert!(is_worktree(&wt).await, "adopt must bring the worktree back");

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(wm.run_dir(run8));
    }

    #[test]
    fn slugify_is_branch_safe() {
        assert_eq!(slugify("Add the Foo endpoint!"), "add-the-foo-endpoint");
        assert_eq!(slugify("   "), "task");
        assert_eq!(slugify("A/B::C"), "a-b-c");
        assert!(slugify("x".repeat(100).as_str()).len() <= 32);
    }
}

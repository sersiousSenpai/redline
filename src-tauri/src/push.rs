// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Push & branch actions for the Code Review surface: the WRITE side of the
//! review pane. After reviewing the agent's changes the user can commit them,
//! push them to a branch of their choosing, and revert rejected hunks —
//! without ever changing which branch is checked out (`git push <remote>
//! HEAD:refs/heads/<target>` decouples where the commit lands locally from
//! where it's published; no `switch`, no `stash`, no ref rewinding).
//!
//! Trust boundary: everything here is a `#[tauri::command]` and nothing else.
//! No `/v1` route reaches this module, so a headless agent steered by a
//! hostile page cannot invoke a write — `code.rs` (the agent-facing bridge)
//! stays read-only and untouched. The only caller is a user click in the app
//! window.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

use crate::review::{self, DiffFile, DiffLineKind, DiffSource, FileStatus, ReviewState};
use crate::state::{now_millis, PushRecord};

/// Local git ops (stage, commit, branch) get a generous but finite window.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
/// Network ops (push, `gh pr create`) may legitimately be slow.
const PUSH_TIMEOUT: Duration = Duration::from_secs(180);

// --- write runner ------------------------------------------------------------

/// One finished git (or gh) invocation, exit code and both streams captured.
pub(crate) struct GitRun {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run `/usr/bin/git -C <dir> <args>` for a WRITE. Mirrors `worktree.rs`'s
/// runner with three deliberate differences: no `--no-optional-locks` (a
/// write needs the index lock the read paths avoid), `GIT_TERMINAL_PROMPT=0`
/// (an HTTPS push with no cached credential must fail, not block forever on a
/// tty that doesn't exist), and a hard timeout with `start_kill` on expiry
/// (the stall discipline from `ai_review.rs`).
async fn git_write(
    dir: &Path,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitRun, String> {
    let mut argv: Vec<String> = vec!["-C".to_string(), dir.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|s| s.to_string()));
    run_bin("/usr/bin/git", dir, &argv, stdin, timeout).await
}

/// Shared spawn/feed/collect for git and gh: null-safe stdio, stdin fed then
/// closed so `-F -` / `--body-file -` see EOF, kill on timeout.
async fn run_bin(
    bin: &str,
    cwd: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<GitRun, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("failed to run {bin}: {e}"))?;
    if let Some(bytes) = stdin {
        let mut pipe = child.stdin.take().ok_or("stdin unavailable")?;
        pipe.write_all(bytes).await.map_err(|e| e.to_string())?;
        drop(pipe);
    }
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => {
            // wait_with_output consumed the child; kill_on_drop already fired.
            return Err(format!(
                "timed out after {}s — killed",
                timeout.as_secs()
            ));
        }
    };
    Ok(GitRun {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Convenience: run and require exit 0, mapping failure to trimmed stderr.
async fn git_ok(dir: &Path, args: &[&str], stdin: Option<&[u8]>, timeout: Duration) -> Result<GitRun, String> {
    let run = git_write(dir, args, stdin, timeout).await?;
    if run.code == 0 {
        Ok(run)
    } else {
        let err = run.stderr.trim();
        Err(if err.is_empty() {
            format!("git {} failed (exit {})", args.first().unwrap_or(&""), run.code)
        } else {
            err.to_string()
        })
    }
}

// --- gh resolution -----------------------------------------------------------

/// Resolve the `gh` binary the way `claude_proc.rs` resolves `claude`, minus
/// the overrides: well-known install locations first, then an interactive
/// login shell. A Finder-launched app has a thin PATH — the same reason
/// `/usr/bin/git` is hardcoded everywhere else. Cached for the process.
pub(crate) fn resolve_gh_bin() -> Option<String> {
    static GH: OnceLock<Option<String>> = OnceLock::new();
    GH.get_or_init(|| {
        let mut probes = vec![
            PathBuf::from("/opt/homebrew/bin/gh"),
            PathBuf::from("/usr/local/bin/gh"),
        ];
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            probes.push(home.join(".local/bin/gh"));
        }
        if let Some(hit) = probes.into_iter().find(|p| p.is_file()) {
            return Some(hit.to_string_lossy().into_owned());
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(&shell)
            .args(["-ilc", "command -v gh"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .rev()
                    .map(str::trim)
                    .find(|line| Path::new(line).is_file())
                    .map(str::to_string)
            })
    })
    .clone()
}

// --- status (the read that backs the strip) ----------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Current branch; `None` = detached HEAD.
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub head_subject: Option<String>,
    /// e.g. "origin/main"; `None` when the branch has no upstream (normal).
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub remotes: Vec<String>,
    pub default_remote: Option<String>,
    /// The remote's default branch (from `refs/remotes/<remote>/HEAD`).
    pub default_branch: Option<String>,
    /// "merge" | "rebase" | "cherry-pick" | "bisect" when one is underway.
    pub in_progress: Option<String>,
    pub gh_available: bool,
    pub gh_authed: bool,
}

/// Working-tree counts from `status --porcelain=v1` output. Pure.
pub(crate) fn parse_porcelain_counts(out: &str) -> (u32, u32, u32) {
    let (mut staged, mut unstaged, mut untracked) = (0u32, 0u32, 0u32);
    for line in out.lines() {
        let mut chars = line.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
            continue;
        };
        if x == '?' {
            untracked += 1;
            continue;
        }
        if x != ' ' {
            staged += 1;
        }
        if y != ' ' && y != '?' {
            unstaged += 1;
        }
    }
    (staged, unstaged, untracked)
}

/// `rev-list --left-right --count @{u}...HEAD` → (behind, ahead). Pure.
pub(crate) fn parse_ahead_behind(out: &str) -> (u32, u32) {
    let mut parts = out.split_whitespace();
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (behind, ahead)
}

/// The full status for one repo dir. Every probe tolerates failure — a repo
/// with no commits, no upstream, or no remotes still yields a usable strip.
pub(crate) async fn status_for(dir: &Path) -> GitStatus {
    let quick = |args: &'static [&'static str]| async move {
        git_write(dir, args, None, LOCAL_TIMEOUT)
            .await
            .ok()
            .filter(|r| r.code == 0)
            .map(|r| r.stdout.trim().to_string())
    };

    let branch = quick(&["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .filter(|b| !b.is_empty() && b != "HEAD");
    let (head_short, head_subject) = match quick(&["log", "-1", "--format=%h%x1f%s"]).await {
        Some(line) => {
            let mut parts = line.splitn(2, '\u{1f}');
            (
                parts.next().map(str::to_string),
                parts.next().map(str::to_string),
            )
        }
        None => (None, None),
    };
    let upstream = quick(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await;
    let (behind, ahead) = match quick(&["rev-list", "--left-right", "--count", "@{u}...HEAD"]).await
    {
        Some(out) => parse_ahead_behind(&out),
        None => (0, 0),
    };
    let (staged, unstaged, untracked) = match git_write(
        dir,
        &["status", "--porcelain=v1"],
        None,
        LOCAL_TIMEOUT,
    )
    .await
    {
        Ok(r) if r.code == 0 => parse_porcelain_counts(&r.stdout),
        _ => (0, 0, 0),
    };
    let remotes: Vec<String> = quick(&["remote"])
        .await
        .map(|out| out.lines().map(str::to_string).collect())
        .unwrap_or_default();
    let default_remote = if remotes.iter().any(|r| r == "origin") {
        Some("origin".to_string())
    } else {
        remotes.first().cloned()
    };
    let default_branch = match &default_remote {
        Some(remote) => remote_default_branch(dir, remote).await,
        None => None,
    };
    let in_progress = in_progress_op(dir).await;
    let gh_bin = resolve_gh_bin();
    let gh_authed = match &gh_bin {
        // `gh auth token` is purely local and fast — `gh auth status` hits
        // the network.
        Some(bin) => run_bin(bin, dir, &["auth".into(), "token".into()], None, LOCAL_TIMEOUT)
            .await
            .map(|r| r.code == 0)
            .unwrap_or(false),
        None => false,
    };

    GitStatus {
        branch,
        head_short,
        head_subject,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        remotes,
        default_remote,
        default_branch,
        in_progress,
        gh_available: gh_bin.is_some(),
        gh_authed,
    }
}

/// `refs/remotes/<remote>/HEAD` → the branch name it points at, if set.
async fn remote_default_branch(dir: &Path, remote: &str) -> Option<String> {
    let refname = format!("refs/remotes/{remote}/HEAD");
    let run = git_write(dir, &["symbolic-ref", "--quiet", &refname], None, LOCAL_TIMEOUT)
        .await
        .ok()
        .filter(|r| r.code == 0)?;
    run.stdout
        .trim()
        .strip_prefix(&format!("refs/remotes/{remote}/"))
        .map(str::to_string)
}

/// Detect an in-flight merge/rebase/cherry-pick/bisect via `.git`-dir probes.
async fn in_progress_op(dir: &Path) -> Option<String> {
    let run = git_write(dir, &["rev-parse", "--git-dir"], None, LOCAL_TIMEOUT)
        .await
        .ok()
        .filter(|r| r.code == 0)?;
    let git_dir = {
        let p = PathBuf::from(run.stdout.trim());
        if p.is_absolute() {
            p
        } else {
            dir.join(p)
        }
    };
    if git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir() {
        Some("rebase".to_string())
    } else if git_dir.join("MERGE_HEAD").is_file() {
        Some("merge".to_string())
    } else if git_dir.join("CHERRY_PICK_HEAD").is_file() {
        Some("cherry-pick".to_string())
    } else if git_dir.join("BISECT_LOG").is_file() {
        Some("bisect".to_string())
    } else {
        None
    }
}

#[tauri::command]
pub async fn push_status(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<GitStatus, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    Ok(status_for(&dir).await)
}

// --- push --------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRequest {
    pub title: String,
    /// PR base branch; `None` falls back to the remote's default branch.
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub repo: String,
    pub review_id: String,
    pub message: String,
    /// Files to stage; `None` = everything (`git add -A`). The dialog defaults
    /// to the review diff's own file list so unrelated junk isn't swept in.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// The push TARGET branch — the checkout is never switched.
    pub target: String,
    pub remote: String,
    #[serde(default)]
    pub set_upstream: bool,
    #[serde(default)]
    pub create_local_branch: bool,
    #[serde(default)]
    pub no_verify: bool,
    /// Push the current HEAD as-is, skipping stage + commit.
    #[serde(default)]
    pub skip_commit: bool,
    /// Required when the target is the remote's default branch or main/master.
    #[serde(default)]
    pub confirm_protected: bool,
    #[serde(default)]
    pub pr: Option<PrRequest>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub committed: Option<String>,
    pub committed_short: Option<String>,
    pub branch: String,
    pub remote: String,
    /// `<remote>/<target>` — where the work is now published.
    pub pushed_ref: String,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub steps: Vec<PushStep>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushLogEvent {
    review_id: String,
    line: String,
}

/// Validate the push target: `code::safe_token` first (flag shape, control
/// chars, length), then git's OWN validator — not a hand-rolled regex. The
/// printed form must equal the input so `--branch` shorthand expansion
/// (`@{-1}` and friends) can never smuggle in a different branch than the one
/// the user read in the dialog.
async fn validate_target(dir: &Path, target: &str) -> Result<String, String> {
    let t = crate::code::safe_token(target)?.to_string();
    let run = git_write(dir, &["check-ref-format", "--branch", &t], None, LOCAL_TIMEOUT).await?;
    if run.code != 0 {
        return Err(format!("`{t}` is not a valid branch name"));
    }
    if run.stdout.trim() != t {
        return Err(format!("`{t}` is a branch shorthand — spell out the branch name"));
    }
    Ok(t)
}

/// Validate the remote by EXACT membership in `git remote` output — never by
/// token shape.
async fn validate_remote(dir: &Path, remote: &str) -> Result<String, String> {
    let run = git_ok(dir, &["remote"], None, LOCAL_TIMEOUT).await?;
    let wanted = remote.trim();
    if run.stdout.lines().any(|r| r == wanted) {
        Ok(wanted.to_string())
    } else {
        Err(format!("`{wanted}` is not a configured remote of this repository"))
    }
}

/// Translate a failed `git push`'s stderr into something actionable. Force is
/// NEVER offered — a non-fast-forward means pull first, full stop.
fn translate_push_error(stderr: &str, remote: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("non-fast-forward") || s.contains("fetch first") || s.contains("[rejected]") {
        return "push rejected: the remote has commits you don't have — pull first".to_string();
    }
    if s.contains("authentication")
        || s.contains("could not read username")
        || s.contains("permission denied")
        || s.contains("403")
    {
        return format!(
            "git couldn't authenticate to `{remote}` — try `gh auth setup-git` or an SSH key"
        );
    }
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        "git push failed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The push core, DB-free so tests can drive it against a temp repo + a bare
/// "remote". Ordered steps; each is appended to `steps` and streamed through
/// `emit` so the dialog shows live progress.
pub(crate) async fn run_push(
    dir: &Path,
    req: &PushRequest,
    emit: &(dyn Fn(String) + Send + Sync),
) -> Result<PushOutcome, String> {
    let mut steps: Vec<PushStep> = Vec::new();
    let step = |steps: &mut Vec<PushStep>, name: &str, ok: bool, detail: String| {
        emit(format!("{} {name}: {detail}", if ok { "✓" } else { "✗" }));
        steps.push(PushStep {
            name: name.to_string(),
            ok,
            detail,
        });
    };

    // 1. Preflight — refuse mid-operation repos; refuse detached HEAD unless
    //    the commit is skipped (pushing a detached HEAD you're inspecting is
    //    legitimate; committing onto one silently loses the commit).
    if let Some(op) = in_progress_op(dir).await {
        return Err(format!(
            "a {op} is in progress in this repository — finish or abort it first"
        ));
    }
    let head_branch = git_write(dir, &["rev-parse", "--abbrev-ref", "HEAD"], None, LOCAL_TIMEOUT)
        .await
        .ok()
        .filter(|r| r.code == 0)
        .map(|r| r.stdout.trim().to_string());
    let detached = head_branch.as_deref() == Some("HEAD");
    if detached && !req.skip_commit {
        return Err(
            "HEAD is detached — committing here would strand the commit. \
             Check out a branch first (or push-only the current HEAD)."
                .to_string(),
        );
    }
    step(&mut steps, "preflight", true, "clean".to_string());

    // 2. Validate refs.
    let target = validate_target(dir, &req.target).await?;
    let remote = validate_remote(dir, &req.remote).await?;
    step(&mut steps, "validate", true, format!("{remote} ← {target}"));

    // 3. Protected branch gate.
    let default_branch = remote_default_branch(dir, &remote).await;
    let protected =
        default_branch.as_deref() == Some(target.as_str()) || matches!(target.as_str(), "main" | "master");
    if protected && !req.confirm_protected {
        return Err(format!(
            "`{target}` is a protected branch — confirm the push explicitly"
        ));
    }

    let committed: Option<String>;
    let committed_short: Option<String>;
    if !req.skip_commit {
        // 4. Stage. Paths are validated (`safe_rel_path`) and passed after
        //    `--`. A rename must have staged BOTH its old and new path — the
        //    dialog sends both from the diff's file list.
        let mut add_args: Vec<String> = vec!["add".into(), "-A".into()];
        if let Some(paths) = &req.paths {
            if paths.is_empty() {
                return Err("no files selected to commit".to_string());
            }
            add_args.push("--".into());
            for p in paths {
                add_args.push(review::safe_rel_path(p)?.to_string());
            }
        }
        let add_ref: Vec<&str> = add_args.iter().map(String::as_str).collect();
        git_ok(dir, &add_ref, None, LOCAL_TIMEOUT).await?;
        step(
            &mut steps,
            "stage",
            true,
            match &req.paths {
                Some(p) => format!("{} file{}", p.len(), if p.len() == 1 { "" } else { "s" }),
                None => "everything".to_string(),
            },
        );

        // 5. Commit — message on stdin (multi-line, no argv quoting games).
        //    Nothing staged is a plain error, not an empty commit.
        let staged_probe = git_write(dir, &["diff", "--cached", "--quiet"], None, LOCAL_TIMEOUT).await?;
        if staged_probe.code == 0 {
            return Err("nothing to commit — the selected files have no changes".to_string());
        }
        if req.message.trim().is_empty() {
            return Err("the commit message is empty".to_string());
        }
        let mut commit_args = vec!["commit", "-F", "-"];
        if req.no_verify {
            commit_args.push("--no-verify");
        }
        git_ok(dir, &commit_args, Some(req.message.as_bytes()), LOCAL_TIMEOUT).await?;
        let sha = git_ok(dir, &["rev-parse", "HEAD"], None, LOCAL_TIMEOUT)
            .await?
            .stdout
            .trim()
            .to_string();
        let short = git_ok(dir, &["rev-parse", "--short", "HEAD"], None, LOCAL_TIMEOUT)
            .await?
            .stdout
            .trim()
            .to_string();
        step(&mut steps, "commit", true, short.clone());
        committed = Some(sha);
        committed_short = Some(short);
    } else {
        let sha = git_write(dir, &["rev-parse", "HEAD"], None, LOCAL_TIMEOUT)
            .await
            .ok()
            .filter(|r| r.code == 0)
            .map(|r| r.stdout.trim().to_string());
        let short = git_write(dir, &["rev-parse", "--short", "HEAD"], None, LOCAL_TIMEOUT)
            .await
            .ok()
            .filter(|r| r.code == 0)
            .map(|r| r.stdout.trim().to_string());
        committed = sha;
        committed_short = short;
        step(&mut steps, "commit", true, "skipped — pushing HEAD as-is".to_string());
    }

    // 6. Push — the explicit refspec is the design's keystone: the commit
    //    lands on the current branch, publication goes wherever the target
    //    points. Built by `format!`, so a `+force` refspec is unrepresentable.
    let refspec = format!("HEAD:refs/heads/{target}");
    let mut push_args: Vec<&str> = vec!["push"];
    if req.set_upstream {
        push_args.push("-u");
    }
    push_args.push(&remote);
    push_args.push(&refspec);
    let pushed = git_write(dir, &push_args, None, PUSH_TIMEOUT).await?;
    if pushed.code != 0 {
        return Err(translate_push_error(&pushed.stderr, &remote));
    }
    step(&mut steps, "push", true, format!("{remote}/{target}"));

    // 7. Optional local branch — additive; never switches the checkout.
    if req.create_local_branch && head_branch.as_deref() != Some(target.as_str()) {
        let br = git_write(dir, &["branch", &target, "HEAD"], None, LOCAL_TIMEOUT).await?;
        if br.code == 0 {
            step(&mut steps, "branch", true, format!("local `{target}` created"));
        } else if br.stderr.contains("already exists") {
            step(&mut steps, "branch", true, format!("local `{target}` already exists"));
        } else {
            step(&mut steps, "branch", false, br.stderr.trim().to_string());
        }
    }

    // 8. Optional PR — a PR failure never fails the push, which already
    //    succeeded.
    let mut pr_url: Option<String> = None;
    let mut pr_number: Option<i64> = None;
    if let Some(pr) = &req.pr {
        match resolve_gh_bin() {
            None => step(
                &mut steps,
                "pr",
                false,
                "skipped — `gh` is not installed".to_string(),
            ),
            Some(gh) => {
                let base = pr
                    .base
                    .clone()
                    .filter(|b| !b.trim().is_empty())
                    .or(default_branch.clone())
                    .unwrap_or_else(|| "main".to_string());
                match crate::code::safe_token(&base) {
                    Err(e) => step(&mut steps, "pr", false, format!("bad base branch: {e}")),
                    Ok(base) => {
                        let args: Vec<String> = [
                            "pr",
                            "create",
                            "--head",
                            &target,
                            "--base",
                            base,
                            "--title",
                            pr.title.trim(),
                            "--body-file",
                            "-",
                        ]
                        .into_iter()
                        .map(str::to_string)
                        .collect();
                        match run_bin(&gh, dir, &args, Some(pr.body.as_bytes()), PUSH_TIMEOUT).await
                        {
                            Ok(run) if run.code == 0 => {
                                pr_url = parse_pr_url(&run.stdout);
                                pr_number = pr_url.as_deref().and_then(parse_pr_number);
                                step(
                                    &mut steps,
                                    "pr",
                                    true,
                                    pr_url.clone().unwrap_or_else(|| "created".to_string()),
                                );
                            }
                            Ok(run) => {
                                let msg = run.stderr.trim();
                                step(
                                    &mut steps,
                                    "pr",
                                    false,
                                    if msg.is_empty() {
                                        "gh pr create failed".to_string()
                                    } else {
                                        msg.to_string()
                                    },
                                );
                            }
                            Err(e) => step(&mut steps, "pr", false, e),
                        }
                    }
                }
            }
        }
    }

    Ok(PushOutcome {
        committed,
        committed_short,
        branch: target.clone(),
        remote: remote.clone(),
        pushed_ref: format!("{remote}/{target}"),
        pr_url,
        pr_number,
        steps,
    })
}

/// The trailing URL `gh pr create` prints on stdout.
pub(crate) fn parse_pr_url(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("https://") || l.starts_with("http://"))
        .map(str::to_string)
}

/// `…/pull/12` → 12.
pub(crate) fn parse_pr_number(url: &str) -> Option<i64> {
    url.trim_end_matches('/')
        .rsplit_once("/pull/")
        .and_then(|(_, n)| n.parse().ok())
}

#[tauri::command]
pub async fn review_push(
    app: tauri::AppHandle,
    state: tauri::State<'_, ReviewState>,
    req: PushRequest,
) -> Result<PushOutcome, String> {
    let dir = review::checked_repo_dir(&state.db, &req.repo).await?;
    let review_id = req.review_id.clone();
    let emit_app = app.clone();
    let emit_id = review_id.clone();
    let emit = move |line: String| {
        let _ = emit_app.emit(
            "review-push-log",
            PushLogEvent {
                review_id: emit_id.clone(),
                line,
            },
        );
    };
    let outcome = run_push(&dir, &req, &emit).await?;

    // 9. Record — the row `review_feedback.rs` later reports to the agent.
    let files = match &req.paths {
        Some(p) => p.len() as i64,
        None => match &outcome.committed {
            Some(sha) => git_write(
                &dir,
                &["show", "--format=", "--name-only", sha],
                None,
                LOCAL_TIMEOUT,
            )
            .await
            .ok()
            .filter(|r| r.code == 0)
            .map(|r| r.stdout.lines().filter(|l| !l.trim().is_empty()).count() as i64)
            .unwrap_or(0),
            None => 0,
        },
    };
    let record = PushRecord {
        id: uuid::Uuid::new_v4().to_string(),
        review_id: review_id.clone(),
        repo_path: dir.to_string_lossy().to_string(),
        remote: outcome.remote.clone(),
        branch: outcome.branch.clone(),
        commit_sha: outcome.committed.clone(),
        pr_url: outcome.pr_url.clone(),
        pr_number: outcome.pr_number,
        files,
        created_at: now_millis(),
    };
    if let Err(e) = state.db.insert_review_push(&record) {
        tracing::warn!(error = %e, "failed to record review push");
    }
    let _ = app.emit("review-push-done", review_id);
    Ok(outcome)
}

/// The most recent push recorded for a review — backs the strip's last-push
/// chip across reloads.
#[tauri::command]
pub fn review_last_push(
    state: tauri::State<'_, ReviewState>,
    review_id: String,
) -> Option<PushRecord> {
    state.db.latest_push_for_review(&review_id)
}

// --- AI commit draft (see ai_commit.rs) is a sibling module ------------------

// --- revert ------------------------------------------------------------------

/// Regenerate a byte-valid unified diff for `hunks` of `file`, in real git
/// format (`a/`/`b/` prefixes, `/dev/null` for creation/deletion sides). The
/// patch is the FORWARD change; reverting applies it with `git apply
/// --reverse`, which locates content by the new-side coordinates — exactly
/// what the worktree holds. Pure.
pub(crate) fn render_reverse_patch(file: &DiffFile, hunks: &[usize]) -> Result<String, String> {
    if file.binary {
        return Err("binary files can't be reverted from the diff".to_string());
    }
    let mut out = String::new();
    let old_side = if file.status == FileStatus::Added || file.old_path == "/dev/null" {
        "/dev/null".to_string()
    } else {
        format!("a/{}", file.old_path)
    };
    let new_side = if file.status == FileStatus::Deleted {
        "/dev/null".to_string()
    } else {
        format!("b/{}", file.new_path)
    };
    out.push_str(&format!(
        "diff --git a/{} b/{}\n",
        if file.old_path == "/dev/null" {
            &file.new_path
        } else {
            &file.old_path
        },
        file.new_path
    ));
    if file.status == FileStatus::Added || file.old_path == "/dev/null" {
        out.push_str("new file mode 100644\n");
    }
    if file.status == FileStatus::Deleted {
        out.push_str("deleted file mode 100644\n");
    }
    out.push_str(&format!("--- {old_side}\n+++ {new_side}\n"));
    for &idx in hunks {
        let h = file
            .hunks
            .get(idx)
            .ok_or_else(|| format!("hunk {idx} is out of range"))?;
        if h.header.is_empty() {
            out.push_str(&format!(
                "@@ -{},{} +{},{} @@\n",
                h.old_start, h.old_lines, h.new_start, h.new_lines
            ));
        } else {
            out.push_str(&format!(
                "@@ -{},{} +{},{} @@ {}\n",
                h.old_start, h.old_lines, h.new_start, h.new_lines, h.header
            ));
        }
        for l in &h.lines {
            let sign = match l.kind {
                DiffLineKind::Add => '+',
                DiffLineKind::Del => '-',
                DiffLineKind::Context => ' ',
            };
            out.push(sign);
            out.push_str(&l.text);
            out.push('\n');
        }
    }
    Ok(out)
}

/// Revert one hunk (or a whole file) of the current review diff back OUT of
/// the working tree. Refuses when the live diff no longer matches the
/// `fingerprint` the pane is showing — never revert against a drifted diff.
/// Arbitrary line selections snap to the enclosing hunk in the frontend;
/// sub-hunk reverse patches are not reliably well-defined.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_revert(
    state: tauri::State<'_, ReviewState>,
    repo: String,
    source: DiffSource,
    base: Option<String>,
    sha: Option<String>,
    file_path: String,
    scope: String,
    hunk_index: Option<usize>,
    fingerprint: String,
) -> Result<(), String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let live = review::fingerprint_for(&dir, source, base.as_deref(), sha.as_deref()).await?;
    if live != fingerprint {
        return Err(
            "the code changed underneath this diff — refresh the review, then revert".to_string(),
        );
    }
    let (_, diff) = review::resolve_for_route(
        &state.db,
        &repo,
        source,
        base.as_deref(),
        sha.as_deref(),
    )
    .await?;
    let file = diff
        .iter()
        .find(|f| review::display_path(f) == file_path)
        .ok_or_else(|| format!("`{file_path}` is not in the current diff"))?;
    if file.binary {
        return Err("binary files can't be reverted from the diff".to_string());
    }
    if file.status == FileStatus::Renamed {
        return Err("renamed files can't be reverted from the diff — undo the rename by hand".to_string());
    }

    // An untracked file's diff came from a `--no-index` pass; reverting it
    // means deleting the file. Canonicalize-prefix-guarded, same as
    // `review.rs::worktree_content`.
    if file.status == FileStatus::Added && !is_tracked(&dir, &file.new_path).await {
        let root = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
        let full = std::fs::canonicalize(root.join(review::safe_rel_path(&file.new_path)?))
            .map_err(|e| e.to_string())?;
        if !full.starts_with(&root) {
            return Err("invalid file path".to_string());
        }
        std::fs::remove_file(&full).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let hunk_indices: Vec<usize> = match scope.as_str() {
        "hunk" => vec![hunk_index.ok_or("hunk scope requires a hunk index")?],
        "file" => (0..file.hunks.len()).collect(),
        other => return Err(format!("unknown revert scope `{other}`")),
    };
    let patch = render_reverse_patch(file, &hunk_indices)?;

    let check = git_write(
        &dir,
        &["apply", "--reverse", "--check"],
        Some(patch.as_bytes()),
        LOCAL_TIMEOUT,
    )
    .await?;
    if check.code != 0 {
        return Err(format!(
            "the revert doesn't apply cleanly — refresh the review and try again ({})",
            check.stderr.trim()
        ));
    }
    // `--index` first (keeps a staged file consistent); fall back to the
    // worktree alone when the index doesn't match the patch.
    let indexed = git_write(
        &dir,
        &["apply", "--reverse", "--index"],
        Some(patch.as_bytes()),
        LOCAL_TIMEOUT,
    )
    .await?;
    if indexed.code != 0 {
        git_ok(
            &dir,
            &["apply", "--reverse"],
            Some(patch.as_bytes()),
            LOCAL_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

async fn is_tracked(dir: &Path, path: &str) -> bool {
    git_write(dir, &["ls-files", "--error-unmatch", "--", path], None, LOCAL_TIMEOUT)
        .await
        .map(|r| r.code == 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::parse_unified_diff;

    // --- pure parsers --------------------------------------------------------

    #[test]
    fn porcelain_counts_classify_staged_unstaged_untracked() {
        let out = "M  staged.rs\nMM both.rs\n M unstaged.rs\n?? new.txt\nA  added.rs\nR  old -> new\n";
        let (staged, unstaged, untracked) = parse_porcelain_counts(out);
        assert_eq!(staged, 4, "M / MM / A / R all have a staged half");
        assert_eq!(unstaged, 2, "MM and ' M'");
        assert_eq!(untracked, 1);
        assert_eq!(parse_porcelain_counts(""), (0, 0, 0));
    }

    #[test]
    fn ahead_behind_parses_left_right_counts() {
        assert_eq!(parse_ahead_behind("2\t5"), (2, 5));
        assert_eq!(parse_ahead_behind("0\t0\n"), (0, 0));
        assert_eq!(parse_ahead_behind("garbage"), (0, 0));
    }

    #[test]
    fn pr_url_and_number_parse_from_gh_stdout() {
        let stdout = "Creating pull request for fix in me/repo\n\nhttps://github.com/me/repo/pull/12\n";
        let url = parse_pr_url(stdout).unwrap();
        assert_eq!(url, "https://github.com/me/repo/pull/12");
        assert_eq!(parse_pr_number(&url), Some(12));
        assert_eq!(parse_pr_url("no url here"), None);
        assert_eq!(parse_pr_number("https://github.com/me/repo"), None);
    }

    #[test]
    fn push_error_translation_never_offers_force() {
        let msg = translate_push_error(
            " ! [rejected]        HEAD -> main (non-fast-forward)\nerror: failed to push",
            "origin",
        );
        assert!(msg.contains("pull first"), "{msg}");
        assert!(!msg.to_lowercase().contains("force"));
        let auth = translate_push_error("fatal: could not read Username for 'https://github.com'", "origin");
        assert!(auth.contains("gh auth setup-git"), "{auth}");
    }

    // --- temp-repo harness (matches review.rs's TempRepo convention) ---------

    async fn run(dir: &Path, args: &[&str]) {
        let ok = tokio::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .await
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?} failed");
    }

    struct TempRepo(PathBuf);
    impl TempRepo {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn temp_repo() -> TempRepo {
        let dir = std::env::temp_dir().join(format!("redline-push-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let td = TempRepo(dir);
        let d = td.path();
        run(d, &["init", "-q", "-b", "main"]).await;
        run(d, &["config", "user.email", "t@t"]).await;
        run(d, &["config", "user.name", "t"]).await;
        tokio::fs::write(d.join("a.txt"), "one\ntwo\nthree\n").await.unwrap();
        run(d, &["add", "a.txt"]).await;
        run(d, &["commit", "-qm", "init"]).await;
        td
    }

    /// A second temp dir as a bare "remote" — the whole push path offline.
    async fn bare_remote(repo: &Path) -> TempRepo {
        let dir = std::env::temp_dir().join(format!("redline-push-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = tokio::process::Command::new("/usr/bin/git")
            .arg("init")
            .arg("-q")
            .arg("--bare")
            .arg(&dir)
            .output()
            .await
            .unwrap()
            .status
            .success();
        assert!(ok);
        run(repo, &["remote", "add", "origin", dir.to_str().unwrap()]).await;
        TempRepo(dir)
    }

    fn req(repo: &Path, target: &str) -> PushRequest {
        PushRequest {
            repo: repo.to_string_lossy().to_string(),
            review_id: "rev-1".to_string(),
            message: "test: pushed from the review pane\n\nWith a body line.".to_string(),
            paths: None,
            target: target.to_string(),
            remote: "origin".to_string(),
            set_upstream: false,
            create_local_branch: false,
            no_verify: false,
            skip_commit: false,
            confirm_protected: false,
            pr: None,
        }
    }

    fn no_emit() -> impl Fn(String) + Send + Sync {
        |_| {}
    }

    // --- status --------------------------------------------------------------

    #[tokio::test]
    async fn status_reads_branch_head_and_dirty_counts() {
        let td = temp_repo().await;
        let d = td.path();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        tokio::fs::write(d.join("new.txt"), "hi\n").await.unwrap();
        let s = status_for(d).await;
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(s.head_short.is_some());
        assert_eq!(s.head_subject.as_deref(), Some("init"));
        assert_eq!(s.upstream, None, "no upstream configured");
        assert_eq!((s.staged, s.unstaged, s.untracked), (0, 1, 1));
        assert_eq!(s.in_progress, None);
        assert!(s.remotes.is_empty());
    }

    #[tokio::test]
    async fn status_flags_detached_head_and_merge_in_progress() {
        let td = temp_repo().await;
        let d = td.path();
        run(d, &["checkout", "-q", "--detach", "HEAD"]).await;
        let s = status_for(d).await;
        assert_eq!(s.branch, None, "detached HEAD reads as no branch");
        // Fake an in-flight merge via its .git marker.
        std::fs::write(d.join(".git/MERGE_HEAD"), "0000\n").unwrap();
        let s = status_for(d).await;
        assert_eq!(s.in_progress.as_deref(), Some("merge"));
    }

    // --- ref validation ------------------------------------------------------

    #[tokio::test]
    async fn target_validation_rejects_flags_traversal_and_shorthand() {
        let td = temp_repo().await;
        let d = td.path();
        for bad in ["--exec=evil", "a..b", "a\nb", "", "a b", "@{-1}", "HEAD"] {
            assert!(
                validate_target(d, bad).await.is_err(),
                "target `{bad}` must be rejected"
            );
        }
        assert_eq!(validate_target(d, "fix/review-notes").await.unwrap(), "fix/review-notes");
    }

    #[tokio::test]
    async fn remote_validation_is_exact_membership() {
        let td = temp_repo().await;
        let _remote = bare_remote(td.path()).await;
        assert_eq!(validate_remote(td.path(), "origin").await.unwrap(), "origin");
        assert!(validate_remote(td.path(), "upstream").await.is_err());
        assert!(validate_remote(td.path(), "orig").await.is_err());
    }

    // --- the whole push path, offline ---------------------------------------

    #[tokio::test]
    async fn push_commits_on_current_branch_and_publishes_to_target() {
        let td = temp_repo().await;
        let d = td.path();
        let remote = bare_remote(d).await;
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();

        let outcome = run_push(d, &req(d, "fix/review-notes"), &no_emit()).await.unwrap();
        assert_eq!(outcome.branch, "fix/review-notes");
        assert_eq!(outcome.pushed_ref, "origin/fix/review-notes");
        let sha = outcome.committed.clone().unwrap();

        // The commit landed on the CURRENT branch (main) — the checkout never
        // switched.
        let head = git_ok(d, &["rev-parse", "HEAD"], None, LOCAL_TIMEOUT).await.unwrap();
        assert_eq!(head.stdout.trim(), sha);
        let branch = git_ok(d, &["rev-parse", "--abbrev-ref", "HEAD"], None, LOCAL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(branch.stdout.trim(), "main");

        // …and the bare remote's target ref carries the same commit.
        let published = git_ok(
            remote.path(),
            &["rev-parse", "refs/heads/fix/review-notes"],
            None,
            LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(published.stdout.trim(), sha);

        // The multi-line stdin message survived verbatim.
        let msg = git_ok(d, &["log", "-1", "--format=%B"], None, LOCAL_TIMEOUT).await.unwrap();
        assert!(msg.stdout.contains("With a body line."));
    }

    #[tokio::test]
    async fn push_scoped_paths_stage_only_those_files() {
        let td = temp_repo().await;
        let d = td.path();
        let _remote = bare_remote(d).await;
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        tokio::fs::write(d.join("junk.txt"), "unrelated\n").await.unwrap();

        let mut r = req(d, "scoped");
        r.paths = Some(vec!["a.txt".to_string()]);
        run_push(d, &r, &no_emit()).await.unwrap();

        // junk.txt stayed out of the commit and is still untracked.
        let shown = git_ok(d, &["show", "--format=", "--name-only", "HEAD"], None, LOCAL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(shown.stdout.trim(), "a.txt");
        let s = status_for(d).await;
        assert_eq!(s.untracked, 1);
    }

    #[tokio::test]
    async fn push_refuses_protected_targets_without_confirm() {
        let td = temp_repo().await;
        let d = td.path();
        let _remote = bare_remote(d).await;
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();

        let err = run_push(d, &req(d, "main"), &no_emit()).await.unwrap_err();
        assert!(err.contains("protected"), "{err}");
        let mut confirmed = req(d, "main");
        confirmed.confirm_protected = true;
        run_push(d, &confirmed, &no_emit()).await.unwrap();
    }

    #[tokio::test]
    async fn push_with_nothing_staged_errors_plainly() {
        let td = temp_repo().await;
        let d = td.path();
        let _remote = bare_remote(d).await;
        let err = run_push(d, &req(d, "clean"), &no_emit()).await.unwrap_err();
        assert!(err.contains("nothing to commit"), "{err}");
    }

    #[tokio::test]
    async fn push_hostile_paths_are_rejected() {
        let td = temp_repo().await;
        let d = td.path();
        let _remote = bare_remote(d).await;
        tokio::fs::write(d.join("a.txt"), "x\n").await.unwrap();
        let mut r = req(d, "evil");
        r.paths = Some(vec!["../outside.txt".to_string()]);
        assert!(run_push(d, &r, &no_emit()).await.is_err());
    }

    #[tokio::test]
    async fn skip_commit_pushes_head_as_is() {
        let td = temp_repo().await;
        let d = td.path();
        let remote = bare_remote(d).await;
        // Dirty tree stays dirty — nothing is staged or committed.
        tokio::fs::write(d.join("a.txt"), "dirty\n").await.unwrap();
        let mut r = req(d, "head-only");
        r.skip_commit = true;
        let outcome = run_push(d, &r, &no_emit()).await.unwrap();
        let head = git_ok(d, &["rev-parse", "HEAD"], None, LOCAL_TIMEOUT).await.unwrap();
        assert_eq!(outcome.committed.as_deref(), Some(head.stdout.trim()));
        let s = status_for(d).await;
        assert_eq!(s.unstaged, 1, "the dirty edit was left alone");
        let published = git_ok(
            remote.path(),
            &["rev-parse", "refs/heads/head-only"],
            None,
            LOCAL_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(published.stdout.trim(), head.stdout.trim());
    }

    #[tokio::test]
    async fn create_local_branch_is_additive_and_never_switches() {
        let td = temp_repo().await;
        let d = td.path();
        let _remote = bare_remote(d).await;
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").await.unwrap();
        let mut r = req(d, "also-local");
        r.create_local_branch = true;
        run_push(d, &r, &no_emit()).await.unwrap();
        let branch = git_ok(d, &["rev-parse", "--abbrev-ref", "HEAD"], None, LOCAL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(branch.stdout.trim(), "main", "checkout untouched");
        let local = git_ok(d, &["rev-parse", "refs/heads/also-local"], None, LOCAL_TIMEOUT).await;
        assert!(local.is_ok(), "local branch exists");
    }

    // --- reverse patch -------------------------------------------------------

    #[tokio::test]
    async fn reverse_patch_round_trips_a_modification() {
        let td = temp_repo().await;
        let d = td.path();
        let before = tokio::fs::read_to_string(d.join("a.txt")).await.unwrap();
        tokio::fs::write(d.join("a.txt"), "one\nTWO\nthree\nfour\n").await.unwrap();

        let diff_out = tokio::process::Command::new("/usr/bin/git")
            .args(["-C", d.to_str().unwrap(), "diff", "-U3", "--no-color", "HEAD"])
            .output()
            .await
            .unwrap();
        let files = parse_unified_diff(&String::from_utf8_lossy(&diff_out.stdout));
        assert_eq!(files.len(), 1);
        let all: Vec<usize> = (0..files[0].hunks.len()).collect();
        let patch = render_reverse_patch(&files[0], &all).unwrap();

        git_ok(d, &["apply", "--reverse"], Some(patch.as_bytes()), LOCAL_TIMEOUT)
            .await
            .unwrap();
        let after = tokio::fs::read_to_string(d.join("a.txt")).await.unwrap();
        assert_eq!(after, before, "revert restored the pre-change content");
    }

    #[tokio::test]
    async fn reverse_patch_single_hunk_leaves_other_hunks_applied() {
        let td = temp_repo().await;
        let d = td.path();
        // A file long enough for two separated hunks.
        let base: String = (1..=40).map(|i| format!("line{i}\n")).collect();
        tokio::fs::write(d.join("b.txt"), &base).await.unwrap();
        run(d, &["add", "b.txt"]).await;
        run(d, &["commit", "-qm", "base"]).await;
        let edited = base.replace("line3\n", "LINE3\n").replace("line35\n", "LINE35\n");
        tokio::fs::write(d.join("b.txt"), &edited).await.unwrap();

        let diff_out = tokio::process::Command::new("/usr/bin/git")
            .args(["-C", d.to_str().unwrap(), "diff", "-U3", "--no-color", "HEAD"])
            .output()
            .await
            .unwrap();
        let files = parse_unified_diff(&String::from_utf8_lossy(&diff_out.stdout));
        let file = files.iter().find(|f| f.new_path == "b.txt").unwrap();
        assert_eq!(file.hunks.len(), 2);

        // Revert only the second hunk; the first edit survives.
        let patch = render_reverse_patch(file, &[1]).unwrap();
        git_ok(d, &["apply", "--reverse"], Some(patch.as_bytes()), LOCAL_TIMEOUT)
            .await
            .unwrap();
        let after = tokio::fs::read_to_string(d.join("b.txt")).await.unwrap();
        assert!(after.contains("LINE3\n"), "first hunk still applied");
        assert!(after.contains("line35\n"), "second hunk reverted");
    }

    #[tokio::test]
    async fn reverse_patch_recreates_a_deleted_file() {
        let td = temp_repo().await;
        let d = td.path();
        run(d, &["rm", "-q", "a.txt"]).await;
        let diff_out = tokio::process::Command::new("/usr/bin/git")
            .args(["-C", d.to_str().unwrap(), "diff", "-U3", "--no-color", "HEAD"])
            .output()
            .await
            .unwrap();
        let files = parse_unified_diff(&String::from_utf8_lossy(&diff_out.stdout));
        assert_eq!(files[0].status, FileStatus::Deleted);
        let all: Vec<usize> = (0..files[0].hunks.len()).collect();
        let patch = render_reverse_patch(&files[0], &all).unwrap();
        git_ok(d, &["apply", "--reverse"], Some(patch.as_bytes()), LOCAL_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(d.join("a.txt")).await.unwrap(),
            "one\ntwo\nthree\n"
        );
    }

    #[test]
    fn reverse_patch_refuses_binary_and_bad_hunk_index() {
        let mut f = parse_unified_diff(
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
        )
        .remove(0);
        assert!(render_reverse_patch(&f, &[5]).is_err());
        f.binary = true;
        assert!(render_reverse_patch(&f, &[0]).is_err());
    }
}

// SPDX-License-Identifier: Apache-2.0
//! Tauri-only Guided writes. Every mutating git argv is built by this closed
//! enum, never accepted from the frontend. No bridge route imports this module.
use crate::push::{git_write, GitRun};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS change_narrations (repo TEXT NOT NULL, fingerprint TEXT NOT NULL, story TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(repo,fingerprint));
CREATE TABLE IF NOT EXISTS commit_narrations (repo TEXT NOT NULL, sha TEXT NOT NULL, story TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(repo,sha));
CREATE TABLE IF NOT EXISTS git_workspaces (id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, title TEXT NOT NULL, base_sha TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active');")
}

#[derive(Debug)]
pub(crate) enum GuidedOp {
    Fetch {
        remote: String,
    },
    Merge {
        target: String,
        fast_forward: bool,
        workspace: bool,
    },
    AbortMerge,
    AbortCherryPick,
    // Recovery of an operation started outside Guided is the sole rebase argv.
    AbortRebase,
    AbortRevert,
    WorktreeAdd {
        path: String,
        branch: String,
        from: String,
    },
    WorktreeRemove {
        path: String,
    },
    WorktreePrune,
    Revert {
        revision: String,
    },
    RestoreFile {
        revision: String,
        path: String,
    },
    UndoFile {
        path: String,
    },
    ReversePatch {
        check: bool,
        index: bool,
    },
    RestoreProject {
        revision: String,
    },
    Stage {
        paths: Vec<String>,
    },
    Commit,
    Share {
        remote: String,
        branch: String,
    },
}
impl GuidedOp {
    pub(crate) fn args(&self) -> Vec<String> {
        let args: Vec<&str> = match self {
            Self::Fetch { remote } => vec!["fetch", "--prune", "--", remote],
            Self::Merge {
                target,
                fast_forward: true,
                ..
            } => vec!["merge", "--ff-only", "--", target],
            Self::Merge {
                target,
                workspace: true,
                ..
            } => vec!["merge", "--no-ff", "--no-edit", "--", target],
            Self::Merge { target, .. } => vec!["merge", "--no-edit", "--", target],
            Self::AbortMerge => vec!["merge", "--abort"],
            Self::AbortCherryPick => vec!["cherry-pick", "--abort"],
            Self::AbortRebase => vec!["rebase", "--abort"],
            Self::AbortRevert => vec!["revert", "--abort"],
            Self::WorktreeAdd { path, branch, from } => {
                vec!["worktree", "add", "-b", branch, "--", path, from]
            }
            Self::WorktreeRemove { path } => vec!["worktree", "remove", "--", path],
            Self::WorktreePrune => vec!["worktree", "prune", "--expire", "now"],
            Self::Revert { revision } => vec!["revert", "--no-commit", "--mainline", "1", revision],
            Self::RestoreFile { revision, path } => {
                vec!["restore", "--source", revision, "--", path]
            }
            Self::UndoFile { path } => {
                return [
                    "restore".into(),
                    "--source".into(),
                    "HEAD".into(),
                    "--staged".into(),
                    "--worktree".into(),
                    "--".into(),
                    format!(":(literal){path}"),
                ]
                .into()
            }
            Self::ReversePatch { check: true, .. } => vec!["apply", "--reverse", "--check"],
            Self::ReversePatch { index: true, .. } => vec!["apply", "--reverse", "--index"],
            Self::ReversePatch { .. } => vec!["apply", "--reverse"],
            Self::RestoreProject { revision } => vec![
                "restore",
                "--source",
                revision,
                "--staged",
                "--worktree",
                "--",
                ".",
            ],
            Self::Stage { paths } => {
                let mut args = vec!["add".into(), "-A".into(), "--".into()];
                args.extend(paths.iter().map(|p| format!(":(literal){p}")));
                return args;
            }
            Self::Commit => vec!["commit", "-F", "-"],
            Self::Share { remote, branch } => {
                return vec![
                    "push".into(),
                    "-u".into(),
                    "--".into(),
                    remote.clone(),
                    format!("HEAD:refs/heads/{branch}"),
                ]
            }
        };
        args.into_iter().map(str::to_string).collect()
    }
    fn meaning(&self) -> &'static str {
        match self {
            Self::Fetch { .. } => "Checked your team copy for new saved versions.",
            Self::Merge { .. } => "Brought saved versions together without rewriting history.",
            Self::AbortMerge | Self::AbortCherryPick | Self::AbortRebase | Self::AbortRevert => {
                "Cancelled the unfinished operation and restored its starting point."
            }
            Self::WorktreeAdd { .. } => "Created a separate folder and workspace for this idea.",
            Self::WorktreeRemove { .. } => {
                "Archived the clean workspace folder; its saved versions remain."
            }
            Self::WorktreePrune => "Removed records of workspace folders that no longer exist.",
            Self::Revert { .. } => "Prepared an undo as unsaved changes for you to review.",
            Self::RestoreFile { .. } => "Restored this file as an unsaved change.",
            Self::ReversePatch { .. } | Self::UndoFile { .. } => {
                "Undid the reviewed change in this file."
            }
            Self::RestoreProject { .. } => {
                "Prepared the old project's contents as unsaved changes, preserving history."
            }
            Self::Stage { .. } => "Included the reviewed files in this version.",
            Self::Commit => "Saved a new version on this computer.",
            Self::Share { .. } => "Shared this workspace with your team.",
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCommand {
    pub command: String,
    pub meaning: String,
    pub ok: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictReport {
    pub files: Vec<String>,
    pub ours_summary: String,
    pub theirs_summary: String,
}
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_id: Option<String>,
    pub commands: Vec<ActionCommand>,
    pub conflict: Option<ConflictReport>,
    pub message: String,
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
pub(crate) async fn run(
    dir: &Path,
    op: GuidedOp,
    stdin: Option<&[u8]>,
    result: &mut ActionResult,
) -> Result<GitRun, String> {
    result.repo = Some(dir.to_string_lossy().into());
    let args = op.args();
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let command = format!(
        "git -C {} {}",
        quote(&dir.to_string_lossy()),
        args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ")
    );
    let outcome = git_write(dir, &argv, stdin, Duration::from_secs(120)).await;
    result.commands.push(ActionCommand {
        command,
        meaning: op.meaning().into(),
        ok: outcome.as_ref().is_ok_and(|r| r.code == 0),
    });
    outcome.map_err(|e| crate::git_human::explain(&e).message)
}
pub(crate) async fn read(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_write(dir, args, None, Duration::from_secs(30)).await?;
    if out.code == 0 {
        Ok(out.stdout)
    } else {
        Err(crate::git_human::explain(&out.stderr).message)
    }
}
pub(crate) async fn require_clean(dir: &Path) -> Result<(), String> {
    if !read(dir, &["status", "--porcelain=v1", "-z"])
        .await?
        .is_empty()
    {
        return Err("Save or undo your current changes first.".into());
    }
    if crate::push::in_progress_op(dir).await.is_some() {
        return Err("Cancel or finish the unfinished operation first.".into());
    }
    Ok(())
}
pub(crate) async fn revision(dir: &Path, value: &str) -> Result<String, String> {
    crate::code::safe_token(value)?;
    let sha = read(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{value}^{{commit}}"),
        ],
    )
    .await?;
    Ok(sha.trim().into())
}
pub(crate) async fn repo_lock(dir: &Path) -> tokio::sync::OwnedMutexGuard<()> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let key = read(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await
    .unwrap_or_else(|_| dir.to_string_lossy().into());
    let lock = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(key)
        .or_default()
        .clone();
    lock.lock_owned().await
}
pub(crate) async fn merge(
    dir: &Path,
    target: String,
    ff: bool,
    workspace: bool,
    result: &mut ActionResult,
) -> Result<(), String> {
    let ours = read(dir, &["log", "-1", "--format=%h %s", "HEAD"])
        .await
        .unwrap_or_default();
    let theirs = read(dir, &["log", "-1", "--format=%h %s", &target])
        .await
        .unwrap_or_default();
    let attempt = run(
        dir,
        GuidedOp::Merge {
            target,
            fast_forward: ff,
            workspace,
        },
        None,
        result,
    )
    .await;
    if attempt.as_ref().is_ok_and(|out| out.code == 0) {
        result.message = "Your versions are together. Your saved history is intact.".into();
        return Ok(());
    }
    let files = read(dir, &["diff", "--name-only", "--diff-filter=U", "-z"]).await?;
    let files: Vec<_> = files
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if !files.is_empty() || crate::push::in_progress_op(dir).await.as_deref() == Some("merge") {
        let abort = run(dir, GuidedOp::AbortMerge, None, result).await?;
        if abort.code != 0 {
            return Err("The combine could not be cancelled automatically. Keep this folder open and ask a teammate to help finish it.".into());
        }
        result.conflict = Some(ConflictReport {
            files,
            ours_summary: format!("Your saved work is unchanged: {}", ours.trim()),
            theirs_summary: format!(
                "The incoming version is {}. Combine this version in a separate workspace.",
                theirs.trim()
            ),
        });
        result.message =
            "Two edits to the same spot. Redline cancelled the combine and kept your work.".into();
        return Ok(());
    }
    match attempt {
        Ok(out) => Err(crate::git_human::explain(&out.stderr).message),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn whole_file_undo_clears_both_layers_but_keeps_other_prepared_edits() {
        use crate::sync::tests::{fixture, git};
        let (_root, local, _) = fixture();
        let refs = git(&local, &["show-ref"]);
        std::fs::write(local.join("shared.txt"), "prepared\n").unwrap();
        std::fs::write(local.join("other.txt"), "keep prepared\n").unwrap();
        git(&local, &["add", "."]);
        std::fs::write(local.join("shared.txt"), "more unsaved\n").unwrap();
        let mut action = ActionResult::default();
        let out = run(
            &local,
            GuidedOp::UndoFile {
                path: "shared.txt".into(),
            },
            None,
            &mut action,
        )
        .await
        .unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(
            std::fs::read_to_string(local.join("shared.txt")).unwrap(),
            "one\n"
        );
        assert_eq!(
            git(&local, &["diff", "--cached", "--name-only"]),
            "other.txt"
        );
        assert_eq!(git(&local, &["show-ref"]), refs);
    }
    #[test]
    fn whitelisted_ops_build_fixed_arg_vectors() {
        let ops = [
            GuidedOp::Fetch {
                remote: "origin".into(),
            },
            GuidedOp::Merge {
                target: "a".into(),
                fast_forward: true,
                workspace: false,
            },
            GuidedOp::Merge {
                target: "a".into(),
                fast_forward: false,
                workspace: true,
            },
            GuidedOp::AbortMerge,
            GuidedOp::AbortCherryPick,
            GuidedOp::AbortRebase,
            GuidedOp::AbortRevert,
            GuidedOp::WorktreeAdd {
                path: "/tmp/a".into(),
                branch: "redline/ws/a".into(),
                from: "a".into(),
            },
            GuidedOp::WorktreeRemove {
                path: "/tmp/a".into(),
            },
            GuidedOp::WorktreePrune,
            GuidedOp::Revert {
                revision: "a".into(),
            },
            GuidedOp::RestoreFile {
                revision: "a".into(),
                path: ":(literal)a".into(),
            },
            GuidedOp::Stage {
                paths: vec!["a".into()],
            },
            GuidedOp::Commit,
            GuidedOp::UndoFile {
                path: "[id]".into(),
            },
            GuidedOp::ReversePatch {
                check: false,
                index: true,
            },
            GuidedOp::RestoreProject {
                revision: "a".into(),
            },
            GuidedOp::Share {
                remote: "origin".into(),
                branch: "redline/ws/a".into(),
            },
        ];
        for op in ops {
            let args = op.args();
            assert!(!args.iter().any(|a| [
                "reset", "stash", "clean", "switch", "checkout", "--force", "-f", "-D"
            ]
            .contains(&a.as_str())));
            if args[0] == "rebase" {
                assert_eq!(args, ["rebase", "--abort"]);
            }
        }
        assert_eq!(
            GuidedOp::Stage {
                paths: vec!["[id]".into()]
            }
            .args(),
            ["add", "-A", "--", ":(literal)[id]"]
        );
    }
}

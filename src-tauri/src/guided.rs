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

/// The narration and workspace features are gone, but their tables stay:
/// the schema is the authority (`db.rs` checks these columns) and must not
/// regress.
pub(crate) fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS change_narrations (repo TEXT NOT NULL, fingerprint TEXT NOT NULL, story TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(repo,fingerprint));
CREATE TABLE IF NOT EXISTS commit_narrations (repo TEXT NOT NULL, sha TEXT NOT NULL, story TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(repo,sha));
CREATE TABLE IF NOT EXISTS git_workspaces (id TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, title TEXT NOT NULL, base_sha TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active');")
}

#[derive(Debug)]
pub(crate) enum GuidedOp {
    UndoFile { path: String },
    ReversePatch { check: bool, index: bool },
}
impl GuidedOp {
    pub(crate) fn args(&self) -> Vec<String> {
        let args: Vec<&str> = match self {
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
        };
        args.into_iter().map(str::to_string).collect()
    }
    fn meaning(&self) -> &'static str {
        match self {
            Self::ReversePatch { .. } | Self::UndoFile { .. } => {
                "Undid the reviewed change in this file."
            }
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
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn whole_file_undo_clears_both_layers_but_keeps_other_prepared_edits() {
        use crate::git_test_support::{fixture, git};
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
            GuidedOp::UndoFile {
                path: "[id]".into(),
            },
            GuidedOp::ReversePatch {
                check: false,
                index: true,
            },
        ];
        for op in ops {
            let args = op.args();
            assert!(!args.iter().any(|a| [
                "reset", "stash", "clean", "switch", "checkout", "--force", "-f", "-D"
            ]
            .contains(&a.as_str())));
        }
        assert_eq!(
            GuidedOp::UndoFile {
                path: "[id]".into()
            }
            .args(),
            [
                "restore",
                "--source",
                "HEAD",
                "--staged",
                "--worktree",
                "--",
                ":(literal)[id]"
            ]
        );
    }
}

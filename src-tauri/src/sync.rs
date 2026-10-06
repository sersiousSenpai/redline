// SPDX-License-Identifier: Apache-2.0
//! Team updates, called on explicit Guided surface open / user action only.
use crate::{
    guided::{self, ActionResult, GuidedOp},
    review::{self, ReviewState},
};
use serde::Serialize;
use std::{collections::BTreeSet, path::Path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingVersion {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub when: i64,
    pub files: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCheck {
    pub incoming: Vec<IncomingVersion>,
    pub incoming_count: u32,
    pub outgoing: u32,
    pub overlaps: Vec<String>,
    pub action: ActionResult,
}
fn paths(text: &str) -> BTreeSet<String> {
    text.split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}
pub(crate) async fn changes(dir: &Path) -> Result<BTreeSet<String>, String> {
    let mut out =
        paths(&guided::read(dir, &["diff", "--no-renames", "--name-only", "-z", "HEAD"]).await?);
    out.extend(paths(
        &guided::read(dir, &["ls-files", "--others", "--exclude-standard", "-z"]).await?,
    ));
    Ok(out)
}
async fn incoming_target(dir: &Path) -> Result<String, String> {
    guided::revision(dir, "@{upstream}")
        .await
        .map_err(|_| "This workspace has no connected team version yet. Share it first.".into())
}
async fn inspect(dir: &Path, action: ActionResult) -> Result<SyncCheck, String> {
    let target = incoming_target(dir).await?;
    let counts = guided::read(
        dir,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{target}"),
        ],
    )
    .await?;
    let mut parts = counts.split_whitespace();
    let outgoing = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let incoming_count = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let base = guided::read(dir, &["merge-base", "HEAD", &target]).await?;
    let incoming_files = paths(
        &guided::read(
            dir,
            &[
                "diff",
                "--no-renames",
                "--name-only",
                "-z",
                base.trim(),
                &target,
            ],
        )
        .await?,
    );
    let unsaved = changes(dir).await?;
    let overlaps = incoming_files
        .iter()
        .filter(|p| {
            unsaved.iter().any(|u| {
                u == *p || u.starts_with(&format!("{p}/")) || p.starts_with(&format!("{u}/"))
            })
        })
        .cloned()
        .collect();
    let log = guided::read(
        dir,
        &[
            "log",
            "-100",
            "--format=%H%x1f%s%x1f%an%x1f%ct",
            &format!("HEAD..{target}"),
        ],
    )
    .await?;
    let mut incoming = Vec::new();
    for line in log.lines() {
        let p: Vec<_> = line.split('\u{1f}').collect();
        if p.len() != 4 {
            continue;
        }
        let files = paths(
            &guided::read(
                dir,
                &[
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--name-only",
                    "-r",
                    "-z",
                    p[0],
                ],
            )
            .await?,
        )
        .into_iter()
        .collect();
        incoming.push(IncomingVersion {
            sha: p[0].into(),
            subject: p[1].into(),
            author: p[2].into(),
            when: p[3].parse().unwrap_or(0),
            files,
        });
    }
    Ok(SyncCheck {
        incoming,
        incoming_count,
        outgoing,
        overlaps,
        action,
    })
}
pub(crate) async fn check_for(dir: &Path) -> Result<SyncCheck, String> {
    let status = crate::push::status_for(dir).await;
    let remote=status.default_remote.ok_or("This project has no connected team copy yet. You can still save versions on this computer.")?;
    let mut action = ActionResult::default();
    let out = guided::run(dir, GuidedOp::Fetch { remote }, None, &mut action).await?;
    if out.code != 0 {
        return Err(crate::git_human::explain(&out.stderr).message);
    }
    action.message = "Checked for your team's updates.".into();
    inspect(dir, action).await
}
pub(crate) async fn bring_in_for(dir: &Path) -> Result<ActionResult, String> {
    let status = crate::push::status_for(dir).await;
    if status.in_progress.is_some() {
        return Err("Cancel or finish the unfinished operation first.".into());
    }
    if status.branch.is_none() {
        return Err("Open a workspace before bringing in updates.".into());
    }
    let check = inspect(dir, ActionResult::default()).await?;
    if !check.overlaps.is_empty() {
        return Err(
            "Save your work first. Your team's updates touch files you are editing.".into(),
        );
    }
    if check.incoming_count == 0 {
        return Ok(ActionResult {
            message: "You already have your team's latest saved versions.".into(),
            ..Default::default()
        });
    }
    let mut action = ActionResult::default();
    guided::merge(
        dir,
        incoming_target(dir).await?,
        check.outgoing == 0,
        false,
        &mut action,
    )
    .await?;
    Ok(action)
}
#[tauri::command]
pub async fn sync_check(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<SyncCheck, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    check_for(&dir).await
}
#[tauri::command]
pub async fn sync_bring_in(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<ActionResult, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    bring_in_for(&dir).await
}
#[tauri::command]
pub async fn sync_cancel(
    state: tauri::State<'_, ReviewState>,
    repo: String,
) -> Result<ActionResult, String> {
    let dir = review::checked_repo_dir(&state.db, &repo).await?;
    let _lock = guided::repo_lock(&dir).await;
    let op = match crate::push::in_progress_op(&dir).await.as_deref() {
        Some("merge") => GuidedOp::AbortMerge,
        Some("cherry-pick") => GuidedOp::AbortCherryPick,
        Some("rebase") => GuidedOp::AbortRebase,
        Some("revert") => GuidedOp::AbortRevert,
        _ => return Err("There is no supported unfinished combine to cancel.".into()),
    };
    let mut result = ActionResult::default();
    let out = guided::run(&dir, op, None, &mut result).await?;
    if out.code != 0 {
        return Err(crate::git_human::explain(&out.stderr).message);
    }
    result.message = "The unfinished operation was cancelled.".into();
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new() -> std::io::Result<Self> {
            let path =
                std::env::temp_dir().join(format!("redline-guided-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path)?;
            Ok(Self(path))
        }
        pub(crate) fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().into()
    }
    pub(crate) fn fixture() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = TempDir::new().unwrap();
        let bare = root.path().join("team.git");
        std::fs::create_dir(&bare).unwrap();
        git(&bare, &["init", "--bare", "-b", "main"]);
        let local = root.path().join("local");
        git(
            root.path(),
            &["clone", bare.to_str().unwrap(), local.to_str().unwrap()],
        );
        git(&local, &["config", "user.name", "You"]);
        git(&local, &["config", "user.email", "you@example.com"]);
        std::fs::write(local.join("shared.txt"), "one\n").unwrap();
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "First"]);
        git(&local, &["push", "-u", "origin", "main"]);
        let teammate = root.path().join("teammate");
        git(
            root.path(),
            &["clone", bare.to_str().unwrap(), teammate.to_str().unwrap()],
        );
        git(&teammate, &["config", "user.name", "Maya"]);
        git(&teammate, &["config", "user.email", "maya@example.com"]);
        (root, local, teammate)
    }
    fn save(dir: &Path, file: &str, text: &str) {
        std::fs::write(dir.join(file), text).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-m", text]);
    }
    #[tokio::test]
    async fn fetch_fast_forward_and_diverged_combine() {
        let (_r, local, team) = fixture();
        save(&team, "team.txt", "hello");
        git(&team, &["push"]);
        let check = check_for(&local).await.unwrap();
        assert_eq!(check.incoming_count, 1);
        assert!(check.overlaps.is_empty());
        assert!(bring_in_for(&local).await.unwrap().conflict.is_none());
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]),
            git(&team, &["rev-parse", "HEAD"])
        );
        save(&local, "ours.txt", "ours");
        save(&team, "theirs.txt", "theirs");
        git(&team, &["push"]);
        check_for(&local).await.unwrap();
        assert!(bring_in_for(&local).await.unwrap().conflict.is_none());
        assert_eq!(
            git(&local, &["rev-list", "--parents", "-1", "HEAD"])
                .split_whitespace()
                .count(),
            3
        );
    }
    #[tokio::test]
    async fn conflicts_abort_and_overlap_refuses() {
        let (_r, local, team) = fixture();
        save(&team, "shared.txt", "team\n");
        git(&team, &["push"]);
        std::fs::write(local.join("shared.txt"), "unsaved\n").unwrap();
        let before = git(&local, &["status", "--porcelain=v1"]);
        assert_eq!(check_for(&local).await.unwrap().overlaps, ["shared.txt"]);
        assert!(bring_in_for(&local).await.unwrap_err().contains("Save"));
        assert_eq!(git(&local, &["status", "--porcelain=v1"]), before);
        git(&local, &["add", "."]);
        git(&local, &["commit", "-m", "ours"]);
        std::fs::write(local.join("keep.txt"), "unsaved unrelated").unwrap();
        let before = git(&local, &["status", "--porcelain=v1"]);
        let head = git(&local, &["rev-parse", "HEAD"]);
        let result = bring_in_for(&local).await.unwrap();
        assert_eq!(result.conflict.unwrap().files, ["shared.txt"]);
        assert_eq!(git(&local, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&local, &["status", "--porcelain=v1"]), before);
        assert_eq!(
            std::fs::read_to_string(local.join("keep.txt")).unwrap(),
            "unsaved unrelated"
        );
        assert!(crate::push::in_progress_op(&local).await.is_none());
    }
}

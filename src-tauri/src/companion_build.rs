// SPDX-License-Identifier: Apache-2.0
//! Build-turn evidence and guarded undo. Never rewinds changes that predate a turn.
use crate::companion::CompanionState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub added: u64,
    pub removed: u64,
    pub was_dirty: bool,
    pub new_file: bool,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub message_id: String,
    pub project_path: String,
    pub head: String,
    pub files: Vec<ChangedFile>,
    pub undone: bool,
}
pub struct Snapshot {
    root: String,
    head: String,
    dirty: BTreeSet<String>,
    files: BTreeMap<String, String>,
    dirty_contents: BTreeMap<String, Vec<u8>>,
}
fn git(root: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let result = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    Ok(result.stdout)
}
fn head(root: &str) -> String {
    git(root, &["rev-parse", "HEAD"])
        .map(|v| String::from_utf8_lossy(&v).trim().to_string())
        .unwrap_or_default()
}
fn fingerprint(root: &str, file: &str) -> String {
    let path = Path::new(root).join(file);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() => format!("link:{:?}", std::fs::read_link(path)),
        Ok(_) => std::fs::read(path)
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .unwrap_or_else(|_| "unreadable".into()),
        Err(_) => "missing".into(),
    }
}
fn dirty(root: &str) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    let bytes = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut rows = bytes.split(|b| *b == 0).filter(|row| !row.is_empty());
    while let Some(row) = rows.next() {
        if row.len() < 4 {
            continue;
        }
        paths.insert(String::from_utf8_lossy(&row[3..]).to_string());
        if row[0] == b'R' || row[0] == b'C' {
            if let Some(original) = rows.next() {
                paths.insert(String::from_utf8_lossy(original).to_string());
            }
        }
    }
    Ok(paths)
}
fn line_delta(before: &[u8], after: &[u8]) -> Result<(u64, u64), String> {
    let directory =
        std::env::temp_dir().join(format!("redline-build-delta-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let result = (|| {
        std::fs::write(directory.join("before"), before).map_err(|e| e.to_string())?;
        std::fs::write(directory.join("after"), after).map_err(|e| e.to_string())?;
        let output = std::process::Command::new("git")
            .args(["diff", "--no-index", "--numstat", "--", "before", "after"])
            .current_dir(&directory)
            .output()
            .map_err(|e| e.to_string())?;
        if !matches!(output.status.code(), Some(0 | 1)) {
            return Err("Could not measure changed file".into());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut parts = text.split('\t');
        Ok((
            parts.next().unwrap_or("0").parse().unwrap_or(0),
            parts.next().unwrap_or("0").parse().unwrap_or(0),
        ))
    })();
    let _ = std::fs::remove_dir_all(directory);
    result
}

impl Snapshot {
    pub fn capture(root: &str) -> Result<Self, String> {
        let root = String::from_utf8_lossy(&git(root, &["rev-parse", "--show-toplevel"])?)
            .trim()
            .to_string();
        let mut files = BTreeMap::new();
        for path in git(
            &root,
            &[
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
        )?
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        {
            let path = String::from_utf8_lossy(path).to_string();
            files.insert(path.clone(), fingerprint(&root, &path));
        }
        let dirty = dirty(&root)?;
        let dirty_contents = dirty
            .iter()
            .filter_map(|path| {
                let full = Path::new(&root).join(path);
                let meta = std::fs::symlink_metadata(&full).ok()?;
                if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
                    return None;
                }
                Some((path.clone(), std::fs::read(full).ok()?))
            })
            .collect();
        Ok(Self {
            head: head(&root),
            dirty,
            root,
            files,
            dirty_contents,
        })
    }
    pub fn finish(&self, message_id: &str) -> Result<Changes, String> {
        let mut candidates = dirty(&self.root)?;
        candidates.extend(self.dirty.iter().cloned());
        let mut stats = BTreeMap::new();
        let args = if self.head.is_empty() {
            vec!["diff", "--numstat", "-z"]
        } else {
            vec!["diff", "--numstat", "-z", &self.head]
        };
        if let Ok(bytes) = git(&self.root, &args) {
            for line in bytes.split(|b| *b == 0) {
                let line = String::from_utf8_lossy(line);
                let parts: Vec<_> = line.splitn(3, '\t').collect();
                if parts.len() == 3 && !parts[2].is_empty() {
                    stats.insert(
                        parts[2].to_string(),
                        (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0)),
                    );
                }
            }
        }
        let files = candidates
            .into_iter()
            .filter_map(|path| {
                let fingerprint = fingerprint(&self.root, &path);
                if self.files.get(&path) == Some(&fingerprint) {
                    return None;
                }
                let new_file = !self.files.contains_key(&path);
                let (mut added, mut removed) = stats.get(&path).copied().unwrap_or_else(|| {
                    let lines = std::fs::read(Path::new(&self.root).join(&path))
                        .ok()
                        .filter(|b| !b.contains(&0))
                        .map(|b| {
                            b.split(|b| *b == b'\n')
                                .count()
                                .saturating_sub(usize::from(b.ends_with(b"\n")))
                                as u64
                        })
                        .unwrap_or(0);
                    (lines, 0)
                });
                if self.dirty.contains(&path) {
                    // Already-dirty files count only this turn's line delta. Binary
                    // and oversized baselines are listed without invented counts.
                    (added, removed) = self
                        .dirty_contents
                        .get(&path)
                        .and_then(|before| {
                            let after = std::fs::read(Path::new(&self.root).join(&path))
                                .unwrap_or_default();
                            line_delta(before, &after).ok()
                        })
                        .unwrap_or((0, 0));
                }
                Some(ChangedFile {
                    was_dirty: self.dirty.contains(&path),
                    path,
                    added,
                    removed,
                    new_file,
                    fingerprint,
                })
            })
            .collect();
        Ok(Changes {
            message_id: message_id.into(),
            project_path: self.root.clone(),
            head: self.head.clone(),
            files,
            undone: false,
        })
    }
}

pub fn undo(changes: &mut Changes) -> Result<(), String> {
    if changes.undone {
        return Err("These changes were already undone".into());
    }
    if head(&changes.project_path) != changes.head {
        return Err("The project has new commits. Review its current diff before undoing.".into());
    }
    let root = std::fs::canonicalize(&changes.project_path).map_err(|e| e.to_string())?;
    let eligible: Vec<_> = changes
        .files
        .iter()
        .filter(|file| !file.was_dirty)
        .collect();
    // Verify every file before mutating any: later edits always win.
    for file in &eligible {
        let path = PathBuf::from(&file.path);
        if path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Invalid change path".into());
        }
        if let Some(parent) = root.join(path).parent() {
            if !std::fs::canonicalize(parent)
                .map_err(|e| e.to_string())?
                .starts_with(&root)
            {
                return Err("Change path leaves the project".into());
            }
        }
        if fingerprint(&changes.project_path, &file.path) != file.fingerprint {
            return Err(format!(
                "{} changed after this turn. Review it before undoing.",
                file.path
            ));
        }
        if !git(
            &changes.project_path,
            &["diff", "--cached", "--name-only", "--", &file.path],
        )?
        .is_empty()
        {
            return Err(format!(
                "{} has staged changes. Unstage it before undoing.",
                file.path
            ));
        }
    }
    for file in eligible {
        if file.new_file {
            let path = root.join(&file.path);
            if path.symlink_metadata().is_ok() {
                std::fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        } else {
            git(
                &changes.project_path,
                &[
                    "restore",
                    "--source",
                    &changes.head,
                    "--worktree",
                    "--",
                    &file.path,
                ],
            )?;
        }
    }
    changes.undone = true;
    Ok(())
}

#[tauri::command]
pub fn companion_changes(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<Vec<Changes>, String> {
    Ok(companion
        .db
        .companion_meta(&companion_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|(_, raw)| serde_json::from_str(&raw).ok())
        .collect())
}
#[tauri::command]
pub async fn companion_undo(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
    message_id: String,
) -> Result<(), String> {
    if companion.is_running(&companion_id) {
        return Err("Wait for the build to finish before undoing".into());
    }
    let raw = companion
        .db
        .companion_meta(&companion_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|(id, _)| id == &message_id)
        .ok_or("Changes not found")?
        .1;
    let mut changes: Changes = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let changes = tokio::task::spawn_blocking(move || {
        undo(&mut changes)?;
        Ok::<_, String>(changes)
    })
    .await
    .map_err(|e| e.to_string())??;
    companion
        .db
        .set_companion_meta(
            &message_id,
            &serde_json::to_string(&changes).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repo() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("redline-build-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]).unwrap();
        std::fs::write(root.join("clean.txt"), "clean\n").unwrap();
        std::fs::write(root.join("dirty.txt"), "base\n").unwrap();
        git(path, &["add", "."]).unwrap();
        git(
            path,
            &[
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "user.name=Test",
                "commit",
                "-qm",
                "baseline",
            ],
        )
        .unwrap();
        root
    }
    #[test]
    fn snapshot_separates_prior_edits_and_undo_preserves_them() {
        let root = repo();
        let path = root.to_str().unwrap();
        std::fs::write(root.join("dirty.txt"), "base\nprior\n").unwrap();
        let snapshot = Snapshot::capture(path).unwrap();
        std::fs::write(root.join("dirty.txt"), "base\nprior\nnew\n").unwrap();
        std::fs::write(root.join("clean.txt"), "changed\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        let mut changes = snapshot.finish("m").unwrap();
        assert_eq!(changes.files.len(), 3);
        let dirty = changes
            .files
            .iter()
            .find(|file| file.path == "dirty.txt")
            .unwrap();
        assert!(dirty.was_dirty);
        assert_eq!((dirty.added, dirty.removed), (1, 0));
        undo(&mut changes).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("clean.txt")).unwrap(),
            "clean\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("dirty.txt")).unwrap(),
            "base\nprior\nnew\n"
        );
        assert!(!root.join("new.txt").exists());
        assert!(changes.undone);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn undo_refuses_a_later_edit_before_changing_any_file() {
        let root = repo();
        let path = root.to_str().unwrap();
        let snapshot = Snapshot::capture(path).unwrap();
        std::fs::write(root.join("clean.txt"), "build\n").unwrap();
        let mut changes = snapshot.finish("m").unwrap();
        std::fs::write(root.join("clean.txt"), "later\n").unwrap();
        assert!(undo(&mut changes).unwrap_err().contains("changed after"));
        assert_eq!(
            std::fs::read_to_string(root.join("clean.txt")).unwrap(),
            "later\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

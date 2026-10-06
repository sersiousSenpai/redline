// SPDX-License-Identifier: Apache-2.0
//! Real-git fixtures shared by the git surfaces' tests: a temp dir that
//! cleans itself up, a strict `git` runner, and a clone of a local bare
//! remote with a second clone standing in for a teammate.
use std::path::{Path, PathBuf};

pub(crate) struct TempDir(PathBuf);
impl TempDir {
    pub(crate) fn new() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("redline-git-{}", uuid::Uuid::new_v4()));
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

/// Run git and require success; returns trimmed stdout.
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

/// `(root, local, teammate)`: `local` has one pushed commit ("First",
/// `shared.txt` = "one\n") tracking `origin/main`; `teammate` is a second
/// clone of the same bare remote.
pub(crate) fn fixture() -> (TempDir, PathBuf, PathBuf) {
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

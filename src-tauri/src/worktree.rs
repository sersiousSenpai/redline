// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Shared async git invocation. Clones `update.rs`'s git helper: the absolute
//! `/usr/bin/git` (the CLT shim, robust under a Finder launch where PATH has
//! no git), `-C <repo>`, null stdin, captured stdout/stderr,
//! `tokio::process::Command`. Used by the code-review surface (`review.rs`)
//! and the browse agent's read-only git bridge (`code.rs`).

use std::path::Path;
use std::process::Stdio;

/// Run `git` in `dir` and return trimmed stdout, or trimmed stderr as the error.
/// `/usr/bin/git` is the CLT shim — present on any machine that compiled this
/// app, unlike a PATH lookup under a Finder launch. Mirrors `update.rs::git`.
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

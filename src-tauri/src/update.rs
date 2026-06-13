// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! "Check for Updates…" for a source-distributed app.
//!
//! Redline ships no prebuilt binaries: every user clones the repo and builds
//! locally via `npm run redline`. That makes "is there an update?" a git
//! question — does the upstream branch have commits this checkout lacks? —
//! and makes the checkout path knowable at compile time: the binary was built
//! inside the user's own clone, so `CARGO_MANIFEST_DIR` (= `<repo>/src-tauri`
//! at build time) points into it. The actual update (`git pull` + rebuild +
//! reinstall) runs in Terminal.app via `scripts/update.sh`, not in-process:
//! the rebuild quits the running Redline midway, and a Finder-launched app's
//! PATH has no node/npm anyway.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const DIALOG_TITLE: &str = "Check for Updates";
/// Manual fallback shown whenever the automated path can't run.
const MANUAL_HINT: &str = "To update manually, run:\n\n    git pull && npm run redline\n\nin your Redline checkout.";
/// A fetch over a flaky connection can hang far longer than a user will wait.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The clone this binary was built from, or `None` if it has since been
/// moved or deleted. `CARGO_MANIFEST_DIR` is `<repo>/src-tauri`.
pub fn repo_root() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    root.is_dir().then(|| root.to_path_buf())
}

/// Run `git` in `repo` and return trimmed stdout, or trimmed stderr as the
/// error. `/usr/bin/git` is the CLT shim — guaranteed present on any machine
/// that compiled this app, unlike PATH lookups under a Finder launch.
async fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = tokio::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(repo)
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

fn info_dialog(app: &AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

/// Menu-item entry point. Returns immediately; the whole check runs on the
/// async runtime so the menu handler never blocks the main thread, and a
/// static guard ignores re-clicks while a check (or its dialog) is still up.
pub fn check_for_updates(app: AppHandle) {
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_check(&app).await;
        IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

async fn run_check(app: &AppHandle) {
    let Some(repo) = repo_root() else {
        info_dialog(
            app,
            format!(
                "Redline can't find the source checkout it was built from \
                 (it may have been moved or deleted).\n\n{MANUAL_HINT}"
            ),
        );
        return;
    };
    if git(&repo, &["rev-parse", "--is-inside-work-tree"]).await.is_err() {
        info_dialog(
            app,
            format!(
                "The folder Redline was built from ({}) is no longer a git \
                 checkout.\n\n{MANUAL_HINT}",
                repo.display()
            ),
        );
        return;
    }
    // Detached HEAD or a branch with no tracking remote: nothing to compare.
    if git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).await.is_err() {
        info_dialog(
            app,
            format!(
                "Your Redline checkout isn't tracking an upstream branch, so \
                 there's nothing to compare against.\n\n{MANUAL_HINT}"
            ),
        );
        return;
    }
    let fetched = tokio::time::timeout(FETCH_TIMEOUT, git(&repo, &["fetch", "--quiet"])).await;
    match fetched {
        Ok(Ok(_)) => {}
        Ok(Err(stderr)) => {
            info_dialog(
                app,
                format!("Couldn't check for updates — are you online?\n\n{stderr}"),
            );
            return;
        }
        Err(_) => {
            info_dialog(
                app,
                "Couldn't check for updates — the network request timed out.".to_string(),
            );
            return;
        }
    }
    let behind: u64 = match git(&repo, &["rev-list", "--count", "HEAD..@{upstream}"]).await {
        Ok(count) => count.parse().unwrap_or(0),
        Err(stderr) => {
            info_dialog(app, format!("Couldn't compare versions:\n\n{stderr}"));
            return;
        }
    };
    if behind == 0 {
        info_dialog(app, "Redline is up to date.".to_string());
        return;
    }
    let noun = if behind == 1 { "update" } else { "updates" };
    let app_for_confirm = app.clone();
    app.dialog()
        .message(format!(
            "{behind} {noun} available.\n\nUpdate Now opens Terminal, pulls the \
             latest code, rebuilds, and relaunches Redline."
        ))
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update Now".to_string(),
            "Later".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                launch_update_terminal(&app_for_confirm, &repo);
            }
        });
}

/// Hand the actual update to Terminal.app: it owns the process (so the script
/// survives `redline.sh` quitting this app to swap the bundle), shows build
/// progress, and its login shell finds node/npm where this app's PATH can't.
fn launch_update_terminal(app: &AppHandle, repo: &Path) {
    let script = repo.join("scripts/update.sh");
    let spawned = script.is_file()
        && std::process::Command::new("/usr/bin/open")
            .args(["-a", "Terminal"])
            .arg(&script)
            .spawn()
            .is_ok();
    if !spawned {
        info_dialog(
            app,
            format!("Couldn't launch the update in Terminal.\n\n{MANUAL_HINT}"),
        );
    }
}

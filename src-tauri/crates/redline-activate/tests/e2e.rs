// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The activation helper, end to end, against disposable application bundles.
//!
//! Every one of these runs the real executable, exchanges real directories on
//! the real filesystem, and launches a real process that reports a real
//! handshake. That is deliberate: the guarantees this helper exists to provide
//! — the bundles are exchanged atomically, a candidate that does not start is
//! *put back*, a handshake from some other Redline does not count — are
//! properties of `renamex_np`, of process lifetime and of file durability.
//! Mocks cannot establish any of them, and a test suite that mocked them would
//! pass on a machine where the feature is broken.
//!
//! The "application" is a shell script, so a test can decide exactly how a
//! candidate misbehaves.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use redline_activation::{Outcome, Stage, Step, Transaction};

const HELPER: &str = env!("CARGO_BIN_EXE_redline-activate");

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rl-activate-e2e-{tag}-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
            + std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A bundle whose executable is `body`, and which identifies itself as
/// `release`.
fn bundle(root: &Path, name: &str, release: &str, body: &str) -> PathBuf {
    let bundle = root.join(name);
    std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
    std::fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
    std::fs::write(bundle.join("Contents/Info.plist"), b"<plist/>").unwrap();
    std::fs::write(
        bundle.join("Contents/Resources/redline-release.json"),
        format!(
            r#"{{"manifestVersion":1,"releaseId":"{release}","createdAt":0,"sourceFingerprint":"x","helperProtocol":1}}"#
        ),
    )
    .unwrap();
    let exe = bundle.join("Contents/MacOS/Redline");
    std::fs::write(&exe, format!("#!/bin/bash\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bundle
}

/// A body that writes a handshake reaching `stage`, then sleeps so the helper
/// sees a live process.
fn reports(release: &str, stage: &str) -> String {
    format!(
        r#"
set -u
[ -z "${{REDLINE_ACTIVATION_TXN:-}}" ] && exit 0
cat > "$REDLINE_ACTIVATION_TXN/handshake.json.tmp" <<JSON
{{"protocol":1,"txnId":"$(basename "$REDLINE_ACTIVATION_TXN")","releaseId":"{release}","pid":$$,"stage":"{stage}","heartbeatAt":0,"detail":"test"}}
JSON
mv "$REDLINE_ACTIVATION_TXN/handshake.json.tmp" "$REDLINE_ACTIVATION_TXN/handshake.json"
sleep 20
"#
    )
}

struct Fixture {
    dir: PathBuf,
    txn_dir: PathBuf,
    installed: PathBuf,
    staged: PathBuf,
}

impl Fixture {
    /// `candidate_body` is what the *new* release does when the helper starts
    /// it. The previous release always exits immediately.
    fn new(tag: &str, candidate_body: &str) -> Self {
        let dir = scratch(tag);
        let apps = dir.join("Applications");
        let staging = apps.join(".staging");
        std::fs::create_dir_all(&staging).unwrap();
        let installed = bundle(&apps, "Redline.app", "rel-old", "exit 0");
        let staged = bundle(&staging, "Redline.app", "rel-new", candidate_body);
        let txn_dir = dir.join("data/activation/txn-1");
        std::fs::create_dir_all(&txn_dir).unwrap();
        let txn = Transaction {
            protocol: redline_activation::PROTOCOL,
            txn_id: "txn-1".into(),
            created_at: 0,
            release_id: "rel-new".into(),
            artifact_sha256: "sha".into(),
            previous_release_id: Some("rel-old".into()),
            installed_path: installed.clone(),
            staged_path: staged.clone(),
            executable_name: "Redline".into(),
            app_pid: std::process::id(),
            data_dir: dir.join("data"),
            pre_snapshot: dir.join("data/pre.db"),
            exit_timeout_secs: 5,
            launch_timeout_secs: 6,
            health_secs: 2,
        };
        txn.write_to(&txn_dir).unwrap();
        Self { dir, txn_dir, installed, staged }
    }

    fn run_helper(&self) -> std::process::Output {
        Command::new(HELPER).arg(&self.txn_dir).output().unwrap()
    }

    fn installed_release(&self) -> Option<String> {
        let text =
            std::fs::read_to_string(self.installed.join("Contents/Resources/redline-release.json"))
                .ok()?;
        let value: serde_json::Value = serde_json::from_str(&text).ok()?;
        Some(value.get("releaseId")?.as_str()?.to_string())
    }

    fn outcome(&self) -> Outcome {
        Outcome::read_from(&self.txn_dir).expect("the helper always writes an outcome")
    }

    fn steps(&self) -> Vec<Step> {
        redline_activation::Journal::open(&self.txn_dir)
            .unwrap()
            .records()
            .into_iter()
            .map(|r| r.step)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // The candidate script sleeps; leave nothing behind holding the dir.
        let _ = Command::new("/usr/bin/pkill")
            .args(["-f", &self.dir.display().to_string()])
            .output();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_candidate_that_starts_and_stays_up_is_accepted() {
    let fixture = Fixture::new("accept", &reports("rel-new", "healthy"));
    let out = fixture.run_helper();
    assert!(
        out.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    // The new release is installed...
    assert_eq!(fixture.installed_release().as_deref(), Some("rel-new"));
    // ...and the previous one survives at the other path, which is what makes
    // a later rollback a rename rather than a restore from somewhere else.
    assert!(fixture.staged.exists());
    let outcome = fixture.outcome();
    assert!(outcome.accepted);
    assert!(!outcome.rolled_back);
    assert_eq!(outcome.failure, "");
    let steps = fixture.steps();
    assert!(steps.contains(&Step::SwapBegin));
    assert!(steps.contains(&Step::SwapDone));
    assert!(steps.contains(&Step::Accepted));
}

#[test]
fn a_candidate_that_exits_during_startup_is_rolled_back() {
    // The failure an automatic update strands people on: it installed, it ran,
    // it died.
    let fixture = Fixture::new("crash", "exit 3");
    let out = fixture.run_helper();
    assert!(!out.status.success());
    assert_eq!(
        fixture.installed_release().as_deref(),
        Some("rel-old"),
        "the previous release must be the installed one again"
    );
    let outcome = fixture.outcome();
    assert!(!outcome.accepted);
    assert!(outcome.rolled_back);
    assert!(
        outcome.failure.contains("exited during startup"),
        "{}",
        outcome.failure
    );
    let steps = fixture.steps();
    assert!(steps.contains(&Step::RollbackSwapDone));
    assert!(steps.contains(&Step::RolledBack));
}

#[test]
fn a_candidate_that_reports_its_own_failure_is_rolled_back_immediately() {
    let fixture = Fixture::new("reported", &reports("rel-new", "failed"));
    let started = Instant::now();
    fixture.run_helper();
    // Rolled back on the report, not after waiting out the launch timeout.
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "a reported failure must not wait for the timeout"
    );
    assert_eq!(fixture.installed_release().as_deref(), Some("rel-old"));
    assert!(fixture.outcome().rolled_back);
}

#[test]
fn a_candidate_that_never_finishes_starting_is_rolled_back() {
    // Reaches the database and stops — the shape of a build that hangs on
    // migration or never opens a window.
    let fixture = Fixture::new("hang", &reports("rel-new", "database"));
    fixture.run_helper();
    assert_eq!(fixture.installed_release().as_deref(), Some("rel-old"));
    let outcome = fixture.outcome();
    assert!(outcome.rolled_back);
    assert!(
        outcome.failure.contains("did not finish starting"),
        "{}",
        outcome.failure
    );
    // It reports how far it got, which is the difference between a useful
    // failure and "it didn't work".
    assert_eq!(outcome.last_stage, Some(Stage::Database));
}

#[test]
fn a_handshake_from_another_redline_does_not_get_a_candidate_accepted() {
    // The user double-clicks their old copy while the helper is waiting. It
    // reports a perfectly healthy startup — for a different release.
    let fixture = Fixture::new("foreign", &reports("rel-old", "healthy"));
    fixture.run_helper();
    assert_eq!(
        fixture.installed_release().as_deref(),
        Some("rel-old"),
        "a foreign handshake must never satisfy this transaction"
    );
    assert!(fixture.outcome().rolled_back);
}

#[test]
fn nothing_is_changed_while_the_old_process_is_still_alive() {
    let fixture = Fixture::new("stillalive", &reports("rel-new", "healthy"));
    // Hold the exit lock the way a still-running Redline would.
    let lock = redline_activation::ExitLock::acquire(&fixture.txn_dir).unwrap();
    let out = fixture.run_helper();
    drop(lock);
    assert!(!out.status.success());
    assert_eq!(
        fixture.installed_release().as_deref(),
        Some("rel-old"),
        "the installed application must be untouched"
    );
    let outcome = fixture.outcome();
    assert!(!outcome.accepted && !outcome.rolled_back);
    assert!(outcome.failure.contains("still running"), "{}", outcome.failure);
    // And nothing was exchanged, so there is no journal entry claiming it was.
    assert!(!fixture.steps().contains(&Step::SwapBegin));
}

#[test]
fn a_missing_prepared_application_is_refused_rather_than_attempted() {
    let fixture = Fixture::new("missing", &reports("rel-new", "healthy"));
    std::fs::remove_dir_all(&fixture.staged).unwrap();
    let out = fixture.run_helper();
    assert!(!out.status.success());
    assert_eq!(fixture.installed_release().as_deref(), Some("rel-old"));
    assert!(fixture.outcome().failure.contains("was not at"));
}

#[test]
fn install_mode_never_leaves_the_machine_without_an_application() {
    // The manual installation path. The old script deleted the installed
    // bundle and then copied; this must have no such window, and the
    // destination must be a complete bundle at every observable moment.
    let dir = scratch("install");
    let apps = dir.join("Applications");
    std::fs::create_dir_all(&apps).unwrap();
    let installed = bundle(&apps, "Redline.app", "rel-old", "exit 0");
    let prepared = bundle(&dir.join("build"), "Redline.app", "rel-new", "exit 0");

    let out = Command::new(HELPER)
        .args(["install"])
        .arg(&prepared)
        .arg(&installed)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text =
        std::fs::read_to_string(installed.join("Contents/Resources/redline-release.json")).unwrap();
    assert!(text.contains("rel-new"));
    assert!(installed.join("Contents/MacOS/Redline").is_file());
    // The staging directory is gone; nothing is left behind to index.
    let leftovers: Vec<_> = std::fs::read_dir(&apps)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".redline-install-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn install_mode_works_on_a_machine_with_nothing_installed_yet() {
    let dir = scratch("firstinstall");
    let apps = dir.join("Applications");
    std::fs::create_dir_all(&apps).unwrap();
    let prepared = bundle(&dir.join("build"), "Redline.app", "rel-new", "exit 0");
    let dest = apps.join("Redline.app");
    let out = Command::new(HELPER)
        .args(["install"])
        .arg(&prepared)
        .arg(&dest)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(dest.join("Contents/MacOS/Redline").is_file());
    let _ = std::fs::remove_dir_all(&dir);
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The activation protocol: how a prepared Redline becomes the installed one.
//!
//! Two processes share this vocabulary. The **application** prepares the
//! transaction, drains its own work, and hands over. The **helper** — a small
//! separate executable running from a copy outside either bundle — survives
//! that exit, performs the exchange, watches the new process start, and puts
//! the old one back if it does not.
//!
//! Nothing here links the application. That is the point: the process being
//! replaced cannot be the one responsible for finishing its own replacement,
//! and the recovery implementation must not be a file the candidate is about
//! to overwrite.
//!
//! Three things carry the state:
//!
//! * [`Transaction`] — written once, never edited. What to do.
//! * [`Journal`] — append-only, fsynced, outside SQLite. What has been done.
//! * [`Handshake`] — written by the new process. Whether it actually works.
//!
//! The journal exists because the database is one of the things an activation
//! can break. Recovery has to work on a machine where Redline cannot open its
//! own storage, so the record of a half-finished exchange is a plain file.

pub mod handshake;
pub mod journal;
pub mod swap;

pub use handshake::{Handshake, Stage};
pub use journal::{Journal, Record, Resolution, Step};
pub use swap::{swap_paths, swap_supported};

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The protocol version the two sides must agree on. The incumbent's helper
/// drives every activation, so a candidate built against a newer protocol
/// cannot be activated by it — it needs a conventional installation, and says
/// so rather than being attempted.
pub const PROTOCOL: u32 = 1;

/// The file names inside a transaction directory.
pub const TRANSACTION_FILE: &str = "transaction.json";
pub const JOURNAL_FILE: &str = "journal.jsonl";
pub const HANDSHAKE_FILE: &str = "handshake.json";
pub const OUTCOME_FILE: &str = "outcome.json";
pub const LOCK_FILE: &str = "app.lock";
pub const HELPER_LOG_FILE: &str = "helper.log";
/// The installation lock, taken in the directory that holds the installed
/// application. Shared by this mode, the manual installation script and the
/// updater — they all replace the same bundle, and two of them doing it at
/// once is how one release silently loses the other's features.
pub const INSTALL_LOCK_FILE: &str = ".redline-install.lock";
/// Written by the helper once it has read the transaction and can finish
/// independently. The application waits for this before it exits: quitting
/// first and hoping would leave nobody to perform the exchange.
pub const HELPER_READY_FILE: &str = "helper-ready";

/// One activation, decided before the application exits and never edited
/// afterwards. Everything the helper needs is here, because after the handoff
/// there is nobody left to ask.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub protocol: u32,
    pub txn_id: String,
    pub created_at: i64,
    /// The release being activated, and the artifact hash that identifies it.
    pub release_id: String,
    pub artifact_sha256: String,
    /// The release currently installed, so a rollback knows what it is
    /// restoring — and so recovery can tell the two apart by reading the
    /// bundle on disk.
    pub previous_release_id: Option<String>,
    /// Where the installed application lives.
    pub installed_path: PathBuf,
    /// The verified copy of the candidate, already on the same filesystem as
    /// `installed_path`. After the exchange this path holds the *previous*
    /// bundle, which is what makes rollback a second exchange rather than a
    /// restore from somewhere else.
    pub staged_path: PathBuf,
    /// `Contents/MacOS/<name>` — recorded rather than guessed, so the helper
    /// never has to parse a plist to launch what it just installed.
    pub executable_name: String,
    /// The process that is about to exit. Confirmed gone by the lock file,
    /// not by this number: pids are reused.
    pub app_pid: u32,
    /// The application data directory, for the helper's failure report.
    pub data_dir: PathBuf,
    /// The consistent database snapshot taken after writes were quiesced.
    /// Restorable only before the new release admits any user writes.
    pub pre_snapshot: PathBuf,
    /// How long to wait for the old process to disappear.
    pub exit_timeout_secs: u64,
    /// How long the new process has to reach [`Stage::Workspace`].
    pub launch_timeout_secs: u64,
    /// How long it then has to stay responsive before the release is accepted.
    pub health_secs: u64,
}

impl Transaction {
    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join(TRANSACTION_FILE)
    }

    pub fn write_to(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = Self::path_in(dir);
        std::fs::write(&path, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        fsync_path(&path);
        fsync_dir(dir);
        Ok(())
    }

    pub fn read_from(dir: &Path) -> Result<Self, String> {
        let path = Self::path_in(dir);
        let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let txn: Self =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        if txn.protocol != PROTOCOL {
            return Err(format!(
                "activation transaction speaks protocol {} and this helper speaks {PROTOCOL}",
                txn.protocol
            ));
        }
        Ok(txn)
    }

    /// The executable inside the installed bundle.
    pub fn installed_executable(&self) -> PathBuf {
        self.installed_path
            .join("Contents/MacOS")
            .join(&self.executable_name)
    }
}

/// What became of an activation. Written by the helper as its last act, so the
/// next launch can tell the user what happened without re-deriving it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub txn_id: String,
    pub release_id: String,
    pub accepted: bool,
    pub rolled_back: bool,
    pub finished_at: i64,
    /// A sentence a person can read. Empty on success.
    pub failure: String,
    /// The stage the new process reached before it stopped making progress.
    pub last_stage: Option<Stage>,
}

impl Outcome {
    pub fn write_to(&self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(OUTCOME_FILE);
        std::fs::write(&path, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        fsync_path(&path);
        fsync_dir(dir);
        Ok(())
    }

    pub fn read_from(dir: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(dir.join(OUTCOME_FILE)).ok()?).ok()
    }
}

/// True once the helper has taken up station.
pub fn helper_ready(dir: &Path) -> bool {
    dir.join(HELPER_READY_FILE).exists()
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Flush a file all the way to the medium. `sync_all` is the portable part;
/// `F_FULLFSYNC` is what actually makes it durable on macOS, where a plain
/// `fsync` may only reach the drive's write cache.
pub fn fsync_path(path: &Path) {
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.sync_all();
        full_fsync(&file);
    }
}

/// Flush a *directory* entry, so a file that exists is a file that will still
/// exist after a power loss. Renaming and creating are directory operations;
/// syncing the file alone does not record them.
pub fn fsync_dir(dir: &Path) {
    if let Ok(file) = std::fs::File::open(dir) {
        let _ = file.sync_all();
        full_fsync(&file);
    }
}

fn full_fsync(file: &std::fs::File) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        // Best effort: on a filesystem that does not implement it this returns
        // ENOTSUP and `sync_all` above is what we are left with.
        unsafe {
            libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file;
    }
}

/// An advisory lock held by the application for as long as it is alive.
///
/// The helper waits for this lock, not for the pid: a pid can be reused
/// between the moment the application exits and the moment the helper looks,
/// and "some other process now has that number" must never read as "the old
/// Redline is still running" — nor, far worse, the other way round.
pub struct ExitLock {
    _file: std::fs::File,
}

impl ExitLock {
    /// Take the lock. Held until the process exits, however it exits.
    pub fn acquire(dir: &Path) -> std::io::Result<Self> {
        use std::os::unix::io::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(LOCK_FILE))?;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { _file: file })
    }
}

/// Exclusive access to the directory that holds the installed application.
///
/// One activation at a time, across every path that installs Redline. Held for
/// the exchange only — seconds — and released by the process exiting, so a
/// crashed installer never leaves it stuck.
pub struct InstallLock {
    _file: std::fs::File,
}

impl InstallLock {
    /// Take the lock, waiting up to `timeout` for whoever holds it.
    pub fn acquire(dir: &Path, timeout: std::time::Duration) -> Result<Self, String> {
        use std::os::unix::io::AsRawFd;
        let path = dir.join(INSTALL_LOCK_FILE);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self { _file: file });
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "another installation is already replacing the application in {}",
                    dir.display()
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

/// True once nothing holds the exit lock — i.e. the application process, and
/// every child that inherited the descriptor, is gone.
pub fn app_has_exited(dir: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))
    else {
        return false;
    };
    let fd = file.as_raw_fd();
    let got = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } == 0;
    if got {
        unsafe { libc::flock(fd, libc::LOCK_UN) };
    }
    got
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rl-activation-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let dir = dir.join(format!("{:?}", std::thread::current().id()).replace(['(', ')'], ""));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn txn(dir: &Path) -> Transaction {
        Transaction {
            protocol: PROTOCOL,
            txn_id: "txn-1".into(),
            created_at: now_secs(),
            release_id: "rel-new".into(),
            artifact_sha256: "abc".into(),
            previous_release_id: Some("rel-old".into()),
            installed_path: dir.join("Redline.app"),
            staged_path: dir.join("staging/Redline.app"),
            executable_name: "Redline".into(),
            app_pid: std::process::id(),
            data_dir: dir.to_path_buf(),
            pre_snapshot: dir.join("pre.db"),
            exit_timeout_secs: 30,
            launch_timeout_secs: 90,
            health_secs: 20,
        }
    }

    #[test]
    fn a_transaction_round_trips() {
        let dir = tmp();
        let t = txn(&dir);
        t.write_to(&dir).unwrap();
        assert_eq!(Transaction::read_from(&dir).unwrap(), t);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_foreign_protocol_is_refused_rather_than_attempted() {
        let dir = tmp();
        let mut t = txn(&dir);
        t.protocol = PROTOCOL + 1;
        t.write_to(&dir).unwrap();
        let err = Transaction::read_from(&dir).unwrap_err();
        assert!(err.contains("protocol"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_one_installation_may_replace_the_application_at_a_time() {
        let dir = tmp();
        let wait = std::time::Duration::from_millis(50);
        let held = InstallLock::acquire(&dir, wait).unwrap();
        let second = InstallLock::acquire(&dir, wait).err();
        let reason = second.expect("a second installer must wait, not proceed");
        assert!(reason.contains("already replacing"), "{reason}");
        drop(held);
        // Released by the holder going away — including by crashing.
        assert!(InstallLock::acquire(&dir, wait).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_exit_lock_reports_a_live_process_and_releases_on_drop() {
        let dir = tmp();
        assert!(app_has_exited(&dir), "nothing holds the lock yet");
        let lock = ExitLock::acquire(&dir).unwrap();
        assert!(!app_has_exited(&dir), "the lock is held");
        // A second acquisition fails while the first is alive.
        assert!(ExitLock::acquire(&dir).is_err());
        drop(lock);
        assert!(app_has_exited(&dir), "dropping the lock means the app is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

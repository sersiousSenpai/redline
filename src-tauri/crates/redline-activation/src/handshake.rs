// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The startup handshake: how a newly installed Redline proves it works.
//!
//! A running pid is not evidence. Neither is a visible window: a build can
//! open one and then fail to open its database, fail to bind its daemon, or
//! render an error boundary. Accepting a release on either signal is how an
//! automatic update strands someone on a broken version.
//!
//! So the new process reports *stages*, and only the last one counts. Each is
//! something the previous release could also do, which is what makes the
//! comparison meaningful:
//!
//! 1. the database opened and any permitted migration finished;
//! 2. the daemon bound its port;
//! 3. the frontend rendered and completed a round trip to the backend;
//! 4. the saved workspace loaded;
//! 5. it stayed responsive for a short interval afterwards.
//!
//! The report is tied to the transaction *and* the release. A handshake from
//! some other Redline — the user double-clicking the old copy, a probe, a
//! second window — can never satisfy a helper waiting on this one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{fsync_dir, fsync_path, now_secs, HANDSHAKE_FILE};

/// How far the new process has got. Ordered: a later stage implies every
/// earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// The process started and read its activation context.
    Started,
    /// The database opened; permitted migrations completed.
    Database,
    /// The production daemon bound its port.
    Daemon,
    /// The frontend rendered and completed an IPC round trip.
    Frontend,
    /// The saved workspace was restored.
    Workspace,
    /// The health interval elapsed with the process still answering.
    Healthy,
    /// Startup failed. `detail` says how.
    Failed,
}

impl Stage {
    /// The stage that must be reached before the health interval starts.
    pub const LAUNCH_TARGET: Stage = Stage::Workspace;

    pub fn is_failure(self) -> bool {
        self == Stage::Failed
    }
}

/// The new process's report, rewritten (atomically) as it progresses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub protocol: u32,
    /// The activation this report belongs to.
    pub txn_id: String,
    /// The release that is reporting. A mismatch means some *other* Redline
    /// wrote this, and it is ignored.
    pub release_id: String,
    pub pid: u32,
    pub stage: Stage,
    /// Refreshed on every write. A report that stops advancing is a process
    /// that stopped answering, which is the thing a pid check cannot see.
    pub heartbeat_at: i64,
    #[serde(default)]
    pub detail: String,
}

impl Handshake {
    pub fn new(txn_id: impl Into<String>, release_id: impl Into<String>, stage: Stage) -> Self {
        Self {
            protocol: crate::PROTOCOL,
            txn_id: txn_id.into(),
            release_id: release_id.into(),
            pid: std::process::id(),
            stage,
            heartbeat_at: now_secs(),
            detail: String::new(),
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }

    pub fn path_in(dir: &Path) -> PathBuf {
        dir.join(HANDSHAKE_FILE)
    }

    /// Write the report so a reader never sees half of one: a full write to a
    /// neighbouring file, then a rename.
    pub fn write_to(&self, dir: &Path) -> std::io::Result<()> {
        let final_path = Self::path_in(dir);
        let temp = dir.join(format!("{HANDSHAKE_FILE}.{}.tmp", self.pid));
        std::fs::write(&temp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        fsync_path(&temp);
        std::fs::rename(&temp, &final_path)?;
        fsync_dir(dir);
        Ok(())
    }

    /// Read a report, but only if it is *this* transaction's and *this*
    /// release's.
    pub fn read_for(dir: &Path, txn_id: &str, release_id: &str) -> Option<Self> {
        let parsed: Self = serde_json::from_slice(&std::fs::read(Self::path_in(dir)).ok()?).ok()?;
        (parsed.protocol == crate::PROTOCOL
            && parsed.txn_id == txn_id
            && parsed.release_id == release_id)
            .then_some(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rl-handshake-{tag}-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn stages_are_ordered_so_a_later_one_implies_the_earlier() {
        assert!(Stage::Database < Stage::Daemon);
        assert!(Stage::Daemon < Stage::Frontend);
        assert!(Stage::Frontend < Stage::Workspace);
        assert!(Stage::Workspace < Stage::Healthy);
        assert!(Stage::Workspace >= Stage::LAUNCH_TARGET);
        assert!(Stage::Frontend < Stage::LAUNCH_TARGET);
    }

    #[test]
    fn a_report_round_trips_and_advances() {
        let dir = tmp("round");
        Handshake::new("txn-1", "rel-1", Stage::Database)
            .write_to(&dir)
            .unwrap();
        assert_eq!(
            Handshake::read_for(&dir, "txn-1", "rel-1").unwrap().stage,
            Stage::Database
        );
        Handshake::new("txn-1", "rel-1", Stage::Healthy)
            .write_to(&dir)
            .unwrap();
        assert_eq!(
            Handshake::read_for(&dir, "txn-1", "rel-1").unwrap().stage,
            Stage::Healthy
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_handshake_from_another_redline_never_counts() {
        let dir = tmp("foreign");
        // The user double-clicks their old copy while the helper is waiting.
        Handshake::new("txn-1", "rel-previous", Stage::Healthy)
            .write_to(&dir)
            .unwrap();
        assert!(Handshake::read_for(&dir, "txn-1", "rel-candidate").is_none());
        // A stale report from a previous activation attempt.
        Handshake::new("txn-0", "rel-candidate", Stage::Healthy)
            .write_to(&dir)
            .unwrap();
        assert!(Handshake::read_for(&dir, "txn-1", "rel-candidate").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_report_carries_its_reason() {
        let dir = tmp("failed");
        Handshake::new("txn-1", "rel-1", Stage::Failed)
            .with_detail("could not open the database")
            .write_to(&dir)
            .unwrap();
        let read = Handshake::read_for(&dir, "txn-1", "rel-1").unwrap();
        assert!(read.stage.is_failure());
        assert_eq!(read.detail, "could not open the database");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reader_never_sees_a_partial_report() {
        // The write is a rename, so the file at the final path is either the
        // previous complete report or the next one.
        let dir = tmp("atomic");
        Handshake::new("txn-1", "rel-1", Stage::Daemon).write_to(&dir).unwrap();
        let before = std::fs::read(Handshake::path_in(&dir)).unwrap();
        assert!(serde_json::from_slice::<Handshake>(&before).is_ok());
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
                .count(),
            0,
            "no temporary file is left behind"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

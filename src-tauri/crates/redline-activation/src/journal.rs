// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The activation journal: what has actually happened, durably, outside the
//! database.
//!
//! An activation can break the database — that is one of the things it is
//! allowed to do. So the record of a half-finished exchange cannot live there.
//! It is an append-only file, one JSON object per line, fsynced with its
//! directory after every record.
//!
//! **An atomic exchange does not make an update atomic.** The swap itself
//! cannot tear, but the process can die in the gap between performing it and
//! recording that it performed it. The journal is therefore intent *and*
//! completion around each operation, and recovery never trusts it alone:
//! [`Resolution::from`] takes the journal's last word together with the
//! release id read out of the bundle that is actually installed, and lets the
//! artifact settle the disagreement.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{fsync_dir, fsync_path, now_secs, JOURNAL_FILE};

/// One step of an activation. Ordered as they occur; the enum is a protocol,
/// so variants are added at the end and never renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// The controller verified the staged copy. Nothing has been exchanged.
    Staged,
    /// The application drained its work and is about to exit. The helper is
    /// running and has been told it may finish independently.
    HandedOff,
    /// The old process is confirmed gone — by its lock, not by its pid.
    OldExited,
    /// About to exchange the bundles. If the journal ends here, the exchange
    /// may or may not have happened; the installed bundle decides.
    SwapBegin,
    /// The exchange returned successfully.
    SwapDone,
    /// The candidate was started, with this transaction's handshake.
    Launched,
    /// The candidate completed the handshake and stayed responsive.
    HandshakeHealthy,
    /// Terminal, success: the release is the installed one.
    Accepted,
    /// The candidate failed to start, or failed to stay up.
    HandshakeFailed,
    /// About to put the previous bundle back.
    RollbackBegin,
    /// The reverse exchange returned successfully.
    RollbackSwapDone,
    /// Terminal, recovered: the previous release is installed and running.
    RolledBack,
    /// Terminal, stuck: recovery itself could not complete. The failure report
    /// is the only thing left, and it says so.
    Failed,
}

impl Step {
    /// Terminal steps end the transaction; recovery has nothing to do.
    pub fn is_terminal(self) -> bool {
        matches!(self, Step::Accepted | Step::RolledBack | Step::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub seq: u64,
    pub at: i64,
    pub step: Step,
    #[serde(default)]
    pub detail: String,
}

/// An append-only journal in one transaction directory.
pub struct Journal {
    dir: PathBuf,
    path: PathBuf,
}

impl Journal {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            path: dir.join(JOURNAL_FILE),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a record and make it durable before returning.
    ///
    /// The durability is the whole point: a record that is still in the page
    /// cache when the machine loses power is a record that did not happen, and
    /// the next boot would then have to guess about an exchange that did.
    pub fn append(&self, step: Step, detail: impl Into<String>) -> std::io::Result<Record> {
        use std::io::Write;
        let seq = self.records().len() as u64 + 1;
        let record = Record {
            seq,
            at: now_secs(),
            step,
            detail: detail.into(),
        };
        let mut line = serde_json::to_vec(&record).unwrap_or_default();
        line.push(b'\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(&line)?;
        file.sync_all()?;
        drop(file);
        fsync_path(&self.path);
        fsync_dir(&self.dir);
        Ok(record)
    }

    /// Every record, in order. A truncated final line — a crash mid-write — is
    /// discarded rather than failing the read: it describes something that, by
    /// definition, was not durably recorded.
    pub fn records(&self) -> Vec<Record> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn last(&self) -> Option<Record> {
        self.records().pop()
    }

    pub fn last_step(&self) -> Option<Step> {
        self.last().map(|r| r.step)
    }
}

/// What a recovering process should do about an unfinished transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// The transaction reached a terminal step. Nothing to do but report it.
    Settled(Step),
    /// The candidate is the bundle that is installed, and it was never
    /// accepted. Put the previous release back.
    RollBack,
    /// The previous release is still installed. Clean up and carry on — the
    /// exchange either never happened or was already reversed.
    Abandon,
    /// Neither release is installed, or the bundle carries no identity at all.
    /// Automatic recovery would be guessing; a person has to look.
    NeedsAttention,
}

impl Resolution {
    /// Decide, from the journal's last word **and the identity of the bundle
    /// that is actually installed**.
    ///
    /// The artifact is the tiebreaker, and it has to be: `SwapBegin` with no
    /// `SwapDone` after it is exactly the crash the journal alone cannot
    /// resolve, and it is also the one where getting it wrong means either
    /// leaving an unverified build installed or reversing an exchange that
    /// never happened.
    pub fn from(
        last: Option<Step>,
        installed_release_id: Option<&str>,
        candidate_release_id: &str,
        previous_release_id: Option<&str>,
    ) -> Self {
        if let Some(step) = last {
            if step.is_terminal() {
                return Resolution::Settled(step);
            }
        }
        match installed_release_id {
            // The candidate is installed but nobody ever accepted it.
            Some(id) if id == candidate_release_id => Resolution::RollBack,
            // The previous release is installed: either the exchange never
            // happened, or a rollback already completed without recording it.
            Some(id) if Some(id) == previous_release_id => Resolution::Abandon,
            // No identity at all — an installation that predates release
            // manifests. It is not the candidate, so it is what the user had.
            None => Resolution::Abandon,
            // A third release is installed. Something else changed the
            // installation underneath this transaction.
            Some(_) => Resolution::NeedsAttention,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rl-journal-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let dir = PathBuf::from(dir.to_string_lossy().replace(['(', ')'], ""));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_append_in_order_and_survive_reopening() {
        let dir = tmp("append");
        let j = Journal::open(&dir).unwrap();
        j.append(Step::Staged, "verified").unwrap();
        j.append(Step::HandedOff, "").unwrap();
        let reopened = Journal::open(&dir).unwrap();
        let records = reopened.records();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].seq, 1);
        assert_eq!(records[1].seq, 2);
        assert_eq!(reopened.last_step(), Some(Step::HandedOff));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_torn_final_line_is_discarded_not_fatal() {
        use std::io::Write;
        let dir = tmp("torn");
        let j = Journal::open(&dir).unwrap();
        j.append(Step::SwapBegin, "").unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).open(j.path()).unwrap();
        f.write_all(b"{\"seq\":2,\"at\":1,\"ste").unwrap();
        drop(f);
        let records = Journal::open(&dir).unwrap().records();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].step, Step::SwapBegin);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_between_the_exchange_and_its_record_is_resolved_by_the_artifact() {
        // The journal says only "about to swap". The bundle on disk says the
        // swap happened. Reversing it is the correct action, and only the
        // artifact could have told us.
        assert_eq!(
            Resolution::from(Some(Step::SwapBegin), Some("rel-new"), "rel-new", Some("rel-old")),
            Resolution::RollBack
        );
        // Same journal, but the swap did not happen.
        assert_eq!(
            Resolution::from(Some(Step::SwapBegin), Some("rel-old"), "rel-new", Some("rel-old")),
            Resolution::Abandon
        );
    }

    #[test]
    fn a_launched_candidate_that_never_became_healthy_is_rolled_back() {
        for step in [Step::SwapDone, Step::Launched, Step::HandshakeFailed, Step::RollbackBegin] {
            assert_eq!(
                Resolution::from(Some(step), Some("rel-new"), "rel-new", Some("rel-old")),
                Resolution::RollBack,
                "{step:?}"
            );
        }
    }

    #[test]
    fn terminal_steps_settle_regardless_of_what_is_installed() {
        for step in [Step::Accepted, Step::RolledBack, Step::Failed] {
            assert_eq!(
                Resolution::from(Some(step), Some("anything"), "rel-new", Some("rel-old")),
                Resolution::Settled(step)
            );
        }
    }

    #[test]
    fn an_empty_journal_with_the_previous_release_installed_is_abandoned() {
        assert_eq!(
            Resolution::from(None, Some("rel-old"), "rel-new", Some("rel-old")),
            Resolution::Abandon
        );
        // An installation from before release manifests existed.
        assert_eq!(
            Resolution::from(None, None, "rel-new", Some("rel-old")),
            Resolution::Abandon
        );
    }

    /// Every boundary, exhaustively. A crash can land between any two
    /// journal records, and each landing has exactly one correct answer —
    /// which is decided by the bundle on disk, not by how far the journal
    /// happened to get.
    #[test]
    fn recovery_is_defined_at_every_journal_boundary() {
        use Step::*;
        const EVERY_STEP: [Step; 13] = [
            Staged, HandedOff, OldExited, SwapBegin, SwapDone, Launched,
            HandshakeHealthy, Accepted, HandshakeFailed, RollbackBegin,
            RollbackSwapDone, RolledBack, Failed,
        ];
        for step in EVERY_STEP {
            let candidate_installed =
                Resolution::from(Some(step), Some("rel-new"), "rel-new", Some("rel-old"));
            let previous_installed =
                Resolution::from(Some(step), Some("rel-old"), "rel-new", Some("rel-old"));
            if step.is_terminal() {
                // Settled means settled, whatever is on disk.
                assert_eq!(candidate_installed, Resolution::Settled(step));
                assert_eq!(previous_installed, Resolution::Settled(step));
            } else {
                // Unfinished: the candidate being installed always means it
                // was never accepted, and the previous being installed always
                // means there is nothing to undo.
                assert_eq!(candidate_installed, Resolution::RollBack, "{step:?}");
                assert_eq!(previous_installed, Resolution::Abandon, "{step:?}");
            }
        }
        // And the boundary before any record at all.
        assert_eq!(
            Resolution::from(None, Some("rel-new"), "rel-new", Some("rel-old")),
            Resolution::RollBack
        );
    }

    /// A first-ever activation has no previous release id to compare against.
    /// The candidate must still be recognised, and anything else must still be
    /// left alone.
    #[test]
    fn a_first_activation_with_no_previous_identity_still_resolves() {
        assert_eq!(
            Resolution::from(Some(Step::SwapDone), Some("rel-new"), "rel-new", None),
            Resolution::RollBack
        );
        assert_eq!(
            Resolution::from(Some(Step::SwapDone), None, "rel-new", None),
            Resolution::Abandon
        );
        assert_eq!(
            Resolution::from(Some(Step::SwapDone), Some("rel-other"), "rel-new", None),
            Resolution::NeedsAttention
        );
    }

    #[test]
    fn a_third_release_installed_underneath_us_needs_a_person() {
        assert_eq!(
            Resolution::from(Some(Step::Launched), Some("rel-someone-else"), "rel-new", Some("rel-old")),
            Resolution::NeedsAttention
        );
    }
}

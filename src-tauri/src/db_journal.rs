// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The context journal's one writer. A surface switch, a mission becoming
//! active or a nav used to append its row by taking the shared
//! `Mutex<Connection>` right where it happened. `surface_set_active` runs on
//! the WebView main thread, so while `memory_status` or a dev-server scan held
//! the writer, a tab swap waited on it there: the 2026-10-29 beach ball, 85%
//! of a 20 s sample parked in `append_journal` -> `lock_conn`.
//!
//! Now an append that doesn't need its row id queues the row and returns: a
//! short lock on the queue, never the database. One thread drains the queue
//! and writes each batch in one transaction. The queue is bounded; when it is
//! full the OLDEST row goes (the journal is a "what happened lately" feed, so
//! the newest rows are the ones worth keeping), and a counter says how many.

use super::*;
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;
use std::sync::{Condvar, Weak};
use std::time::{Duration, Instant};

/// Rows the queue holds before it starts dropping the oldest. Far above any
/// real burst: the writer drains a batch per transaction in well under a
/// millisecond, so this only fills while the writer is held for seconds.
pub(crate) const JOURNAL_QUEUE_CAP: usize = 512;
/// Rows one transaction writes at most.
const JOURNAL_BATCH: usize = 64;
/// How long an idle writer waits before checking its database still exists.
const IDLE_CHECK: Duration = Duration::from_secs(5);

/// One queued journal row, stamped when it was queued (not when written).
#[derive(Clone, Debug)]
pub(crate) struct JournalEntry {
    pub ts: i64,
    pub kind: String,
    pub surface_kind: Option<String>,
    pub surface_id: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
}

#[derive(Default)]
struct Queue {
    rows: VecDeque<JournalEntry>,
    /// A batch taken off `rows` and not yet committed.
    writing: bool,
}

/// The queue between every journal append and its writer thread.
#[derive(Default)]
pub(crate) struct JournalQueue {
    state: Mutex<Queue>,
    /// Signalled when a row is queued.
    wake: Condvar,
    /// Signalled when the queue drains.
    drained: Condvar,
    dropped: AtomicU64,
    /// Set once the writer thread is started.
    started: std::sync::OnceLock<()>,
}

impl JournalQueue {
    fn state(&self) -> MutexGuard<'_, Queue> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queue a row and return. Spawns the writer on first use.
    pub(crate) fn push(self: &Arc<Self>, conn: &Arc<Mutex<Connection>>, entry: JournalEntry) {
        {
            let mut q = self.state();
            if q.rows.len() >= JOURNAL_QUEUE_CAP {
                q.rows.pop_front();
                if self.dropped.fetch_add(1, Ordering::Relaxed) == 0 {
                    tracing::warn!(
                        cap = JOURNAL_QUEUE_CAP,
                        "context journal queue is full; dropping its oldest rows"
                    );
                }
            }
            q.rows.push_back(entry);
        }
        self.wake.notify_one();
        let (queue, conn) = (Arc::clone(self), Arc::downgrade(conn));
        self.started.get_or_init(move || {
            let spawned = std::thread::Builder::new()
                .name("redline-journal".into())
                .spawn(move || queue.run(conn));
            if let Err(e) = spawned {
                tracing::error!(error = %e, "could not start the context journal writer");
            }
        });
    }

    /// Rows dropped because the queue was full, since this database opened.
    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Wait (at most `timeout`) until every queued row is committed. For
    /// tests, and for a reader that must see its own rows; never on the UI
    /// thread. `false` on timeout.
    pub(crate) fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut q = self.state();
        while !q.rows.is_empty() || q.writing {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            q = self.drained.wait_timeout(q, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        true
    }

    /// The writer: take a batch, commit it, repeat. Exits once the database
    /// it writes to is gone.
    fn run(&self, conn: Weak<Mutex<Connection>>) {
        loop {
            let batch: Vec<JournalEntry> = {
                let mut q = self.state();
                while q.rows.is_empty() {
                    let (next, waited) = self
                        .wake
                        .wait_timeout(q, IDLE_CHECK)
                        .unwrap_or_else(|e| e.into_inner());
                    q = next;
                    if waited.timed_out() && q.rows.is_empty() && conn.strong_count() == 0 {
                        return;
                    }
                }
                q.writing = true;
                let n = q.rows.len().min(JOURNAL_BATCH);
                q.rows.drain(..n).collect()
            };
            let Some(conn) = conn.upgrade() else {
                return;
            };
            {
                let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(e) = write_journal_rows(&guard, &batch) {
                    tracing::warn!(error = %e, rows = batch.len(), "context journal batch failed");
                }
            }
            drop(conn);
            let mut q = self.state();
            q.writing = false;
            if q.rows.is_empty() {
                self.drained.notify_all();
            }
        }
    }
}

/// Insert `rows` and prune the working set to the newest
/// `JOURNAL_KEEP_ROWS` / `JOURNAL_KEEP_MS`, in one transaction. Returns the
/// last row's id.
pub(crate) fn write_journal_rows(conn: &Connection, rows: &[JournalEntry]) -> rusqlite::Result<i64> {
    const JOURNAL_KEEP_ROWS: i64 = 2000;
    const JOURNAL_KEEP_MS: i64 = 14 * 24 * 60 * 60 * 1000;
    let Some(newest) = rows.iter().map(|r| r.ts).max() else {
        return Ok(0);
    };
    let tx = conn.unchecked_transaction()?;
    let mut id = 0;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO context_journal (ts, kind, surface_kind, surface_id, label, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for r in rows {
            insert.execute(params![r.ts, r.kind, r.surface_kind, r.surface_id, r.label, r.detail])?;
            id = tx.last_insert_rowid();
        }
    }
    let _ = tx.execute(
        "DELETE FROM context_journal
         WHERE id <= ?1 - ?2 OR ts < ?3 - ?4",
        params![id, JOURNAL_KEEP_ROWS, newest, JOURNAL_KEEP_MS],
    );
    tx.commit()?;
    Ok(id)
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `memory_status`: what the memory pill and the Memory surface show.
//!
//! It was the lock holder in the 2026-10-29 beach ball. Three calls at once
//! (the pill's poll, the surface's show, a capture's re-read), each holding
//! the ONE writer connection through a 4-7 s embedding-backlog count, while a
//! tab swap waited behind them on the main thread. So:
//!
//! - **Single flight.** Callers that arrive while a computation runs wait for
//!   it and share its answer; they never start a second one.
//! - **A short cache.** An answer is reused for `TTL`, and only while nothing
//!   has committed since (SQLite's `data_version` on the status connection
//!   moves on every commit from another connection, memory writes included).
//! - **Its own read-only connection.** Every read runs on a
//!   `PolisStore::open_read_only` connection to the same WAL file, inside one
//!   read transaction: a committed snapshot, never the shared writer and
//!   never the shared reader pool. The one write left is the chain-verify
//!   anchor, two tiny rows taken on the writer only when the chain grew.
//! - **The backlog count is indexed.** `PolisStore::embedding_stats` asked,
//!   per browse event, whether ANY browse-event embedding had its hash — a
//!   correlated subquery the planner could only serve with
//!   `idx_embeddings_target (target_kind=?)`, i.e. a scan of every browse
//!   embedding per event, comparing text hashes (the `binCollFunc` frames).
//!   `pending_embeddings` asks the same question with one `NOT IN` list the
//!   planner builds once (an ephemeral index + bloom filter): 4.2-7.0 s ->
//!   20 ms on the user's 120 MB database.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use polis_store::PolisStore;
use rusqlite::{params, Connection};

use crate::db::Database;
use crate::embed;

/// How long an answer is reused while nothing has committed.
pub const TTL: Duration = Duration::from_secs(5);

/// One cached answer.
struct Cached {
    at: Instant,
    /// The status connection's `PRAGMA data_version` when it was computed.
    data_version: i64,
    value: Result<serde_json::Value, String>,
}

#[derive(Default)]
struct Flight {
    computing: bool,
    last: Option<Cached>,
}

/// The single-flight cache and the status connection.
#[derive(Default)]
pub struct MemoryStatusCache {
    flight: Mutex<Flight>,
    landed: Condvar,
    /// The read-only store on the database file, opened on first use, and
    /// the file it was opened on.
    reader: Mutex<Option<(PathBuf, Arc<PolisStore>)>>,
    /// Computations run, for the single-flight tests.
    #[cfg(test)]
    computes: std::sync::atomic::AtomicUsize,
}

/// The app's one cache (`memory_status` in lib.rs).
pub static CACHE: std::sync::LazyLock<MemoryStatusCache> = std::sync::LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl MemoryStatusCache {
    /// The status, from the cache, from the computation already running, or
    /// from a fresh one.
    pub fn get(&self, db: &Database) -> Result<serde_json::Value, String> {
        let mut flight = lock(&self.flight);
        loop {
            if flight.computing {
                flight = self.landed.wait(flight).unwrap_or_else(|e| e.into_inner());
                if let Some(c) = &flight.last {
                    return c.value.clone();
                }
                continue;
            }
            if let Some(c) = &flight.last {
                if c.at.elapsed() < TTL && self.data_version(db) == Some(c.data_version) {
                    return c.value.clone();
                }
            }
            break;
        }
        flight.computing = true;
        drop(flight);
        // A panic mid-compute must still land the flight, or every later
        // caller would wait forever.
        let computed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.compute(db)));
        let (data_version, value) = match computed {
            Ok(v) => v,
            Err(_) => (None, Err("memory status failed".to_string())),
        };
        let mut flight = lock(&self.flight);
        flight.computing = false;
        flight.last = data_version.map(|data_version| Cached {
            at: Instant::now(),
            data_version,
            value: value.clone(),
        });
        drop(flight);
        self.landed.notify_all();
        value
    }

    /// The read-only store for `path`, opened once. `None` when it can't be
    /// opened (the caller then reads on the database itself).
    fn reader(&self, path: &Path) -> Option<Arc<PolisStore>> {
        let mut slot = lock(&self.reader);
        if let Some((at, store)) = slot.as_ref() {
            if at == path {
                return Some(Arc::clone(store));
            }
        }
        match PolisStore::open_read_only(path) {
            Ok(store) => {
                {
                    let conn = store.shared_connection();
                    let conn = lock(&conn);
                    let _ = conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000;");
                }
                let store = Arc::new(store);
                *slot = Some((path.to_path_buf(), Arc::clone(&store)));
                Some(store)
            }
            Err(e) => {
                tracing::warn!(error = %e, "memory status: no read-only connection; reading on the shared one");
                None
            }
        }
    }

    /// The status connection's commit counter, `None` without one.
    fn data_version(&self, db: &Database) -> Option<i64> {
        let store = self.reader(db.reader_path()?)?;
        let conn = store.shared_connection();
        let conn = lock(&conn);
        conn.query_row("PRAGMA data_version", [], |r| r.get(0)).ok()
    }

    fn compute(&self, db: &Database) -> (Option<i64>, Result<serde_json::Value, String>) {
        #[cfg(test)]
        self.computes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let Some(store) = db.reader_path().and_then(|p| self.reader(p)) else {
            // An in-memory or non-WAL database has no second connection.
            return (None, compute_on(db, db, false));
        };
        let conn = store.shared_connection();
        let data_version = {
            let c = lock(&conn);
            // One snapshot for every read below. The guard is released
            // before the store's methods run: each takes this same lock.
            let _ = c.execute_batch("BEGIN");
            c.query_row("PRAGMA data_version", [], |r| r.get(0)).ok()
        };
        let value = compute_on(db, &store, true);
        let _ = lock(&conn).execute_batch("ROLLBACK");
        (data_version, value)
    }
}

/// The status, its memory reads on `store`. `anchor_on_writer`: `store` is
/// read-only, so the chain-verify anchor it could not advance is written
/// through `db`.
fn compute_on(db: &Database, store: &PolisStore, anchor_on_writer: bool) -> Result<serde_json::Value, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let max_seq = store.max_ledger_seq().map_err(e)?;
    let last_to = store.last_run_seq_to().map_err(e)?;
    let run = store.latest_class_run().map_err(e)?;
    let (last_organized_ts, last_summary) = match run {
        Some(r) if r.status == "done" => (r.finished_at, r.summary),
        _ => (None, None),
    };
    let anchor_before = store.meta(PolisStore::VERIFY_LAST_SEQ).ok().flatten();
    let chain = store.verify_ledger_chain_incremental().map_err(e)?;
    if anchor_on_writer && chain.ok && anchor_before.as_deref() != Some(max_seq.to_string().as_str()) {
        let head = chain.head_hash.as_deref().unwrap_or(crate::ledger::GENESIS_PREV);
        let _ = db.set_meta(PolisStore::VERIFY_LAST_SEQ, &max_seq.to_string());
        let _ = db.set_meta(PolisStore::VERIFY_HEAD_HASH, head);
    }
    let (compacted, reclaimed, last_compaction_ts) = store.compaction_stats().map_err(e)?;
    // The gardener's work queue (B3): structural proposals waiting for a run
    // — a fact the surface reports, never a count "to review".
    let queued_proposals = store.count_pending_class_proposals().map_err(e)?;
    // Corpus composition — the number that was missing. Reported as rows AND
    // bytes per role, because the two tell different stories: 397 machine rows
    // out of 1,213 is a third of the corpus by count and 92.6% of it by weight.
    let composition = store.corpus_composition().map_err(e)?;
    let corpus_roles: Vec<serde_json::Value> = composition
        .iter()
        .map(|(role, rows, bytes)| serde_json::json!({ "role": role, "rows": rows, "bytes": bytes }))
        .collect();
    let corpus_bytes: i64 = composition.iter().map(|(_, _, b)| *b).sum();
    let user_bytes: i64 = composition
        .iter()
        .filter(|(r, _, _)| r == "user")
        .map(|(_, _, b)| *b)
        .sum();
    let (gist_agent, gist_deterministic) = store.gist_source_counts().map_err(e)?;
    let (archived_rows, archived_bytes) = store.archive_stats().map_err(e)?;
    let (prefetch_hits, prefetch_turns) = db.prefetch_hit_rate().map_err(e)?;
    // A HALF-BUILT semantic index degrades recall silently, so it is reported
    // rather than inferred: `pending` is the honest counterpart to `chunks`,
    // and `provider: "absent"` says the arm cannot run at all — which is a fact
    // about this machine, not about the user's history.
    let embeddings = match embed::provider_for(db) {
        Some(p) => {
            let (chunks, pending) = embedding_stats(&store.conn(), &p.model_id()).map_err(e)?;
            serde_json::json!({
                "provider": embed::provider_kind().as_str(),
                "model": p.model_id(),
                "chunks": chunks,
                "pending": pending,
            })
        }
        None => serde_json::json!({
            "provider": embed::ProviderKind::Absent.as_str(),
            "model": null, "chunks": 0, "pending": 0,
        }),
    };
    Ok(serde_json::json!({
        "live": true,
        "itemCount": max_seq,
        "backlog": (max_seq - last_to).max(0),
        "lastOrganizedTs": last_organized_ts,
        "lastOrganizedSummary": last_summary,
        "chainOk": chain.ok,
        "compactedCount": compacted,
        "reclaimedBytes": reclaimed,
        "lastCompactionTs": last_compaction_ts,
        "queuedProposals": queued_proposals,
        "corpusRoles": corpus_roles,
        "corpusBytes": corpus_bytes,
        "corpusUserBytes": user_bytes,
        "keeperGistSource": { "agent": gist_agent, "deterministic": gist_deterministic },
        "archivedCount": archived_rows,
        "archivedBytes": archived_bytes,
        "askPrefetch": { "hits": prefetch_hits, "turns": prefetch_turns },
        "embeddings": embeddings,
    }))
}

/// `(chunks, pending)` for `model`: `PolisStore::embedding_stats`'s answer
/// (pinned equal by `pending_matches_the_store_count`), asked so the planner
/// can index it — the browse half's hash list is built once, not scanned per
/// event.
pub(crate) fn embedding_stats(conn: &Connection, model: &str) -> rusqlite::Result<(i64, i64)> {
    let chunks: i64 =
        conn.query_row("SELECT COUNT(*) FROM embeddings WHERE model = ?1", params![model], |r| r.get(0))?;
    Ok((chunks, pending_embeddings(conn, model)?))
}

/// The statement `pending_embeddings` runs, for its query-plan guard.
pub(crate) const PENDING_SQL: &str = "SELECT
       (SELECT COUNT(*) FROM prompts p
         WHERE COALESCE(p.role,'user') <> 'agent' AND LENGTH(p.fts_text) > 0
           AND NOT EXISTS (SELECT 1 FROM embeddings e
             WHERE e.target_kind='prompt' AND e.target_id=p.id
               AND e.model=?1 AND e.source_hash=p.body_hash))
     + (SELECT COUNT(DISTINCT be.context_hash) FROM browse_events be
         WHERE LENGTH(be.text) > 0
           AND be.context_hash NOT IN (SELECT e.source_hash FROM embeddings e
             WHERE e.target_kind='browse_event' AND e.model=?1))";

/// Lake items with no current embedding under `model`: prompts by id and
/// body hash, browse pages by distinct content hash.
pub(crate) fn pending_embeddings(conn: &Connection, model: &str) -> rusqlite::Result<i64> {
    conn.query_row(PENDING_SQL, params![model], |r| r.get(0))
}

#[cfg(test)]
#[path = "memstatus_tests.rs"]
mod tests;

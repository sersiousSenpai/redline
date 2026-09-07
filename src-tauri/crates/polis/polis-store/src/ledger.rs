// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The chain append — the ONE write that must be serialized across
//! processes. Reads the head, computes `entry_hash = sha256(prev_hash ‖
//! canonical(event))`, inserts with an explicit monotonic `seq`. The body is
//! byte-for-byte Redline's `append_ledger_event_locked` (Session A2 of the
//! Polis extraction); what this module adds is the transaction around it.
//!
//! **Why `BEGIN IMMEDIATE`.** Under one in-process mutex the read-then-insert
//! was atomic by construction. Once `polis mcp` and `polis serve` (or Redline
//! and a `polis` CLI) share one file, two processes can both read the same
//! head and both insert — two events claiming one `prev_hash`, a forked
//! chain. `BEGIN IMMEDIATE` takes the write lock BEFORE the head is read, so
//! the second writer waits and then sees the first's event as its head. A
//! caller that already owns a transaction (`is_autocommit() == false`) keeps
//! it: the append joins that transaction, exactly as it did under the mutex.

use std::time::Duration;

use polis_core::ledger::{LedgerAppend, LedgerEventRow};
use rusqlite::{params, Connection, OptionalExtension};

/// How many times a `BEGIN IMMEDIATE` that finds the file locked is retried
/// (on top of the connection's own `busy_timeout`).
pub const BUSY_ATTEMPTS: u32 = 8;

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if f.code == rusqlite::ErrorCode::DatabaseBusy || f.code == rusqlite::ErrorCode::DatabaseLocked
    )
}

/// A small jittered backoff without a random-number crate: the low bits of
/// the monotonic clock are as good as random for spreading two writers apart.
fn backoff(attempt: u32) -> Duration {
    let nanos = std::time::Instant::now().elapsed().subsec_nanos() as u64
        ^ (std::process::id() as u64).wrapping_mul(2_654_435_761);
    let jitter_ms = nanos % 20;
    Duration::from_millis(5 * u64::from(attempt) + jitter_ms)
}

/// Append one event. Serialized across processes by `BEGIN IMMEDIATE` when the
/// connection is in autocommit; joins the caller's transaction otherwise.
pub fn append_event(conn: &Connection, a: &LedgerAppend) -> rusqlite::Result<LedgerEventRow> {
    if !conn.is_autocommit() {
        return append_in_txn(conn, a);
    }
    let mut attempt = 0u32;
    loop {
        match conn.execute_batch("BEGIN IMMEDIATE") {
            Ok(()) => break,
            Err(e) if is_busy(&e) && attempt < BUSY_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(backoff(attempt));
            }
            Err(e) => return Err(e),
        }
    }
    match append_in_txn(conn, a) {
        Ok(row) => {
            conn.execute_batch("COMMIT")?;
            Ok(row)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// The append core — Redline's `append_ledger_event_locked`, unchanged.
fn append_in_txn(conn: &Connection, a: &LedgerAppend) -> rusqlite::Result<LedgerEventRow> {
        let head: Option<(i64, String)> = conn
            .query_row(
                "SELECT seq, entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (prev_seq, prev_hash) = head.unwrap_or((0, polis_core::ledger::GENESIS_PREV.to_string()));
        let seq = prev_seq + 1;
        let canon = polis_core::ledger::CanonicalEvent {
            seq,
            ts: a.ts,
            kind: a.kind,
            author: a.author,
            prompt_id: a.prompt_id,
            session_id: a.session_id,
            version_number: a.version_number,
            ref_kind: a.ref_kind,
            ref_id: a.ref_id,
            payload_hash: a.payload_hash,
        };
        let entry_hash = polis_core::ledger::compute_entry_hash(&prev_hash, &canon);
        conn.execute(
            "INSERT INTO ledger_events
                (seq, ts, kind, author, prompt_id, session_id, version_number,
                 ref_kind, ref_id, payload_hash, prev_hash, entry_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                seq,
                a.ts,
                a.kind,
                a.author,
                a.prompt_id,
                a.session_id,
                a.version_number,
                a.ref_kind,
                a.ref_id,
                a.payload_hash,
                prev_hash,
                entry_hash,
            ],
        )?;
        Ok(polis_core::ledger::LedgerEventRow {
            seq,
            ts: a.ts,
            kind: a.kind.to_string(),
            author: a.author.to_string(),
            prompt_id: a.prompt_id,
            session_id: a.session_id.map(str::to_string),
            version_number: a.version_number,
            ref_kind: a.ref_kind.map(str::to_string),
            ref_id: a.ref_id.map(str::to_string),
            payload_hash: a.payload_hash.to_string(),
            prev_hash,
            entry_hash,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use polis_core::ledger::GENESIS_PREV;

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::schema::Migration::tables(&c).unwrap();
        c
    }

    fn ev<'a>(kind: &'a str, payload: &'a str) -> LedgerAppend<'a> {
        LedgerAppend {
            kind,
            author: "t",
            ts: 1,
            prompt_id: None,
            session_id: None,
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: payload,
        }
    }

    #[test]
    fn appends_chain_from_genesis_and_commit() {
        let c = fresh();
        let a = append_event(&c, &ev("prompt", "p1")).unwrap();
        let b = append_event(&c, &ev("prompt", "p2")).unwrap();
        assert_eq!((a.seq, a.prev_hash.as_str()), (1, GENESIS_PREV));
        assert_eq!((b.seq, b.prev_hash.as_str()), (2, a.entry_hash.as_str()));
        assert!(c.is_autocommit(), "the append commits its own transaction");
    }

    #[test]
    fn joins_a_callers_transaction_instead_of_nesting() {
        let mut c = fresh();
        let tx = c.transaction().unwrap();
        let a = append_event(&tx, &ev("approval", "x")).unwrap();
        assert_eq!(a.seq, 1);
        tx.rollback().unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM ledger_events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "rolled back with the caller's transaction — it was never its own");
    }

    #[test]
    fn a_second_process_waits_and_then_chains_behind_the_first() {
        // Two connections on one file: the first holds an IMMEDIATE txn; the
        // second's append must block (busy_timeout) rather than fork the chain.
        let dir = std::env::temp_dir().join(format!("polis-append-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let c1 = Connection::open(&path).unwrap();
        c1.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000").unwrap();
        crate::schema::Migration::tables(&c1).unwrap();
        let c2 = Connection::open(&path).unwrap();
        c2.execute_batch("PRAGMA busy_timeout = 2000").unwrap();

        c1.execute_batch("BEGIN IMMEDIATE").unwrap();
        let first = append_in_txn(&c1, &ev("prompt", "first")).unwrap();
        let t = std::thread::spawn(move || append_event(&c2, &ev("prompt", "second")).unwrap());
        std::thread::sleep(Duration::from_millis(150));
        c1.execute_batch("COMMIT").unwrap();
        let second = t.join().unwrap();
        assert_eq!(second.seq, 2);
        assert_eq!(second.prev_hash, first.entry_hash, "the waiter chained behind the holder");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

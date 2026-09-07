// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Cold-body compaction and its reversible archive: gist in, deflated original beside it, hash-verified on restore.
//!
//! Lifted byte-for-byte from Redline's `Database` in Session A3 of the Polis
//! extraction; only `crate::` paths changed.

#[allow(unused_imports)]
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[allow(unused_imports)]
use rusqlite::{params, Connection, OptionalExtension, Row};

#[allow(unused_imports)]
use polis_core::types::*;
#[allow(unused_imports)]
use polis_core::{proposal::Proposal, query::MatchStage};
#[allow(unused_imports)]
use crate::PolisStore;
#[allow(unused_imports)]
use crate::prompts::PROMPT_TEXT;
#[allow(unused_imports)]
use crate::search::{GrepError, GREP_MIN_LITERAL};

/// The codec `prompt_archive.blob` is written with. Stored per row rather than
/// assumed, so a future codec is a new value here and not a migration.
pub const ARCHIVE_ALGO: &str = "deflate";

/// Deflate a released prompt body for the compaction archive.
pub fn deflate_body(body: &str) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(body.as_bytes())?;
    enc.finish()
}

/// Inflate an archived body. Callers must re-verify the result against the
/// row's `body_hash` before trusting it — see `restore_prompt_body`.
pub fn inflate_body(blob: &[u8]) -> std::io::Result<String> {
    use std::io::Read;
    let mut out = String::new();
    flate2::read::DeflateDecoder::new(blob).read_to_string(&mut out)?;
    Ok(out)
}

impl PolisStore {
    /// Compact a cold prompt: swap its stored body for `gist` and emit a
    /// `compaction` ledger event proving the swap. The original `body_hash`
    /// stays untouched (the tamper-evident fact + dedup key), so
    /// `verify_ledger_chain` and `verify_bundle` remain green — they are
    /// body-blind. Idempotent via the `gist IS NULL` guard: a re-compaction of
    /// an already-compacted row is a no-op returning `Ok(None)`. On success
    /// returns the new ledger seq. `reason` distinguishes an automatic gist
    /// (`"cold"`) from an explicit forget (`"forget"`). `actor` is who released
    /// the words — the keeper's seat name for an automatic gist, the local
    /// human for an explicit forget. `gist_source` records which tier wrote the
    /// gist — `"agent"` (the keeper's summarizer) or `"deterministic"` (the
    /// fallback window) — so a summarizer that silently stopped running is
    /// visible on Health instead of hiding behind the reclaim number.
    pub fn compact_prompt_body(
        &self,
        prompt_id: i64,
        gist: &str,
        reason: &str,
        gist_source: &str,
        actor: &str,
    ) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn();
        // Read the original body + hash under the same lock, then swap — all
        // atomic with the ledger append below so the chain can't race.
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT body, body_hash FROM prompts WHERE id = ?1 AND gist IS NULL",
                params![prompt_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((body, body_hash)) = row else {
            return Ok(None); // no such warm prompt (already compacted, or gone)
        };
        let original_bytes = body.len() as i64;
        let ts = polis_core::ledger::now_millis();
        // Archive BEFORE the words are released, and only for a `cold`
        // compaction: cold means "we think you're done with this", which is a
        // guess and must therefore be reversible. `forget` means the user said
        // so — it archives nothing and *deletes* any archive an earlier cold
        // pass left behind, because a forget that leaves a recoverable copy on
        // disk is not a forget. The two branches are the whole contract.
        if reason == "cold" {
            match deflate_body(&body) {
                Ok(blob) => {
                    if let Err(e) = conn.execute(
                        "INSERT INTO prompt_archive
                            (prompt_id, body_hash, algo, original_bytes, blob, archived_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(prompt_id) DO UPDATE SET
                            body_hash = excluded.body_hash, algo = excluded.algo,
                            original_bytes = excluded.original_bytes,
                            blob = excluded.blob, archived_at = excluded.archived_at",
                        params![prompt_id, body_hash, ARCHIVE_ALGO, original_bytes, blob, ts],
                    ) {
                        // Best-effort: an archive failure must not block the
                        // reclaim, but it must not be silent either — an
                        // un-archived compaction is exactly today's behaviour.
                        tracing::warn!(error = %e, prompt = prompt_id, "prompt archive write failed");
                    }
                }
                Err(e) => tracing::warn!(error = %e, prompt = prompt_id, "prompt archive deflate failed"),
            }
        } else {
            let _ = conn.execute("DELETE FROM prompt_archive WHERE prompt_id = ?1", params![prompt_id]);
        }
        conn.execute(
            "UPDATE prompts
                SET gist = ?2, body = '', compacted_at = ?3, original_bytes = ?4,
                    gist_source = ?5
             WHERE id = ?1 AND gist IS NULL",
            params![prompt_id, gist, ts, original_bytes, gist_source],
        )?;
        // The compaction event references the prompt and pins the ORIGINAL body
        // hash + the gist hash + the reason, so "what was forgotten" is provable
        // even if the prompt row is later purged.
        let gist_hash = polis_core::ledger::body_hash(gist);
        let ph = polis_core::ledger::decision_payload_hash(&[
            ("original_body_hash", &body_hash),
            ("gist_hash", &gist_hash),
            ("reason", reason),
        ]);
        let author = actor.to_string();
        let pid_str = prompt_id.to_string();
        let ev = Self::append_ledger_event_locked(
            &conn,
            &polis_core::ledger::LedgerAppend {
                kind: polis_core::ledger::EventKind::Compaction.as_str(),
                author: &author,
                ts,
                prompt_id: Some(prompt_id),
                session_id: None,
                version_number: None,
                ref_kind: Some("prompt"),
                ref_id: Some(pid_str.as_str()),
                payload_hash: &ph,
            },
        )?;
        Ok(Some(ev.seq))
    }

    /// Restore a cold-compacted prompt's original body from the archive.
    ///
    /// Returns `Ok(false)` when there is nothing archived (never compacted, or
    /// compacted before archiving existed, or forgotten on purpose). The
    /// inflated bytes are re-hashed and checked against the archive row's
    /// `body_hash` before they go anywhere near the prompt row: the archive is
    /// derived data that lives OUTSIDE the hash chain, so it gets no trust it
    /// hasn't just earned. A mismatch is an error, never a silent overwrite —
    /// the whole point of the chain is that corrupt bytes can't quietly become
    /// the record.
    pub fn restore_prompt_body(&self, prompt_id: i64) -> rusqlite::Result<bool> {
        let conn = self.conn();
        let row: Option<(String, String, Vec<u8>)> = conn
            .query_row(
                "SELECT body_hash, algo, blob FROM prompt_archive WHERE prompt_id = ?1",
                params![prompt_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((archived_hash, algo, blob)) = row else {
            return Ok(false);
        };
        if algo != ARCHIVE_ALGO {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "prompt {prompt_id}: unknown archive codec `{algo}`"
            )));
        }
        let body = inflate_body(&blob).map_err(|e| {
            rusqlite::Error::InvalidParameterName(format!("prompt {prompt_id}: inflate failed: {e}"))
        })?;
        if polis_core::ledger::body_hash(&body) != archived_hash {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "prompt {prompt_id}: archived body does not match its recorded hash"
            )));
        }
        // The prompt's own `body_hash` is the chain's commitment and is never
        // rewritten by compaction, so restoring is a pure re-inflation: put the
        // words back, clear the compaction marks, drop the archive row.
        let changed = conn.execute(
            "UPDATE prompts
                SET body = ?2, gist = NULL, compacted_at = NULL, original_bytes = NULL
             WHERE id = ?1 AND body_hash = ?3",
            params![prompt_id, body, archived_hash],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        conn.execute("DELETE FROM prompt_archive WHERE prompt_id = ?1", params![prompt_id])?;
        Ok(true)
    }

    /// How many compacted bodies are still recoverable, and the deflated bytes
    /// they occupy — the honest counterpart to `compaction_stats`' reclaim
    /// number, which reads as pure profit until you can see the cost.
    pub fn archive_stats(&self) -> rusqlite::Result<(i64, i64)> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(blob)), 0) FROM prompt_archive",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// Compaction candidates: warm prompts (`gist IS NULL`) at least `size_floor`
    /// bytes. A prompt links into a node by ledger seq
    /// (`class_links.target_id` = the prompt event's seq), so we resolve
    /// seq → `prompt_id` here; the keeper groups the rows by prompt and applies
    /// the role/cold/pinned/size interlocks in pure code.
    ///
    /// Warm prompts worth considering for compaction, as flat
    /// `(id, bytes, role, node_id)` rows — one per accepted class link, or a
    /// single row with `node_id = NULL` for machine text.
    ///
    /// The class-link join is now a LEFT join, because machine text
    /// (`agent`/`system`) is deliberately kept out of the classifier and so can
    /// never acquire a link to go cold *through*. Without this it would be
    /// immortal: excluded from classification by Phase 1.5, and therefore never
    /// selectable — the 6.9 MB would sit on disk forever while the only rows
    /// still reachable by the blade were the user's own. Machine rows qualify on
    /// lake-relative age instead (`machine_cold_before_ts`).
    pub fn list_compaction_candidates(
        &self,
        size_floor: i64,
        machine_cold_before_ts: i64,
    ) -> rusqlite::Result<Vec<(i64, i64, String, Option<String>)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT p.id, LENGTH(CAST(p.body AS BLOB)) AS bytes,
                    COALESCE(p.role, 'user') AS role, l.node_id
             FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id AND le.kind = 'prompt'
             LEFT JOIN class_links l
               ON l.target_kind = 'prompt'
              AND CAST(l.target_id AS INTEGER) = le.seq
              AND l.status = 'accepted'
             WHERE p.gist IS NULL
               AND LENGTH(CAST(p.body AS BLOB)) >= ?1
               AND (l.node_id IS NOT NULL
                    OR (COALESCE(p.role, 'user') <> 'user' AND p.ts <= ?2))",
        )?;
        let rows = stmt.query_map(params![size_floor, machine_cold_before_ts], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        rows.collect()
    }

    /// Aggregate compaction stats for the memory pill/inspector:
    /// `(compacted_count, reclaimed_bytes, newest_compacted_at?)`.
    pub fn compaction_stats(&self) -> rusqlite::Result<(i64, i64, Option<i64>)> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(original_bytes), 0),
                    MAX(compacted_at)
             FROM prompts WHERE gist IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    }
}

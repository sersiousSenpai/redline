// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The semantic index's rows: backlog, storage, stats. Derived and droppable.
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

impl PolisStore {
    /// Drop every vector row. The index is derived, so this is always safe
    /// and always recoverable. The host's `clear_embeddings` wraps this and
    /// also drops the in-memory vector cache.
    pub fn delete_all_embeddings(&self) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute("DELETE FROM embeddings", [])
    }
}

impl PolisStore {
    /// Targets that still need embedding for `model`, oldest first.
    ///
    /// The `source_hash` join is what makes re-runs free: a row whose text has
    /// not changed since it was embedded produces no work, so the incremental
    /// worker converges instead of re-doing the corpus every tick.
    ///
    /// Only `role <> 'agent'` prompts are eligible, for the same reason they
    /// are out of the lexical index and out of the classifier: Redline's own
    /// constructed prefaces are 73% of the corpus by weight and answer nobody's
    /// question. Embedding them would spend 87% of the budget describing our
    /// own instruction text — the plan's "1 before 6, by a factor of 8".
    pub fn embedding_backlog(
        &self,
        model: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(String, i64, String, String)>> {
        let conn = self.conn();
        let mut out = Vec::new();

        // Prompts: the user's own words (or an agent row's `user_text`, which
        // `fts_text` already resolves for us).
        let mut stmt = conn.prepare(
            "SELECT p.id, p.fts_text, p.body_hash
             FROM prompts p
             WHERE COALESCE(p.role, 'user') <> 'agent'
               AND LENGTH(p.fts_text) > 0
               AND NOT EXISTS (
                   SELECT 1 FROM embeddings e
                   WHERE e.target_kind = 'prompt' AND e.target_id = p.id
                     AND e.model = ?1 AND e.source_hash = p.body_hash)
             ORDER BY p.id ASC LIMIT ?2",
        )?;
        for row in stmt.query_map(params![model, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, text, hash) = row?;
            out.push(("prompt".to_string(), id, text, hash));
        }
        drop(stmt);
        if out.len() as i64 >= limit {
            return Ok(out);
        }

        // Browse events, deduped by `context_hash` FIRST: 829 rows hold 665
        // distinct pages, so a fifth of the embedding work would be spent
        // re-embedding text we already have a vector for. `MIN(id)` keeps the
        // earliest view of each page as its representative.
        let mut stmt = conn.prepare(
            "SELECT MIN(be.id), be.text, be.context_hash
             FROM browse_events be
             WHERE LENGTH(be.text) > 0
               AND NOT EXISTS (
                   SELECT 1 FROM embeddings e
                   WHERE e.target_kind = 'browse_event'
                     AND e.model = ?1 AND e.source_hash = be.context_hash)
             GROUP BY be.context_hash
             ORDER BY MIN(be.id) ASC LIMIT ?2",
        )?;
        for row in stmt.query_map(params![model, limit - out.len() as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, text, hash) = row?;
            out.push(("browse_event".to_string(), id, text, hash));
        }
        drop(stmt);
        if out.len() as i64 >= limit {
            return Ok(out);
        }

        // Class nodes: `title + summary` as ONE chunk. This is what gives
        // semantic NODE resolution — a question that shares no words with a
        // class title can still reach it — without ever letting a lake ranking
        // decide what a class IS.
        let mut stmt = conn.prepare(
            "SELECT n.rowid, n.title || COALESCE(' — ' || n.summary, ''),
                    n.title || COALESCE(n.summary, '')
             FROM class_nodes n
             WHERE NOT EXISTS (
                 SELECT 1 FROM embeddings e
                 WHERE e.target_kind = 'class_node' AND e.target_id = n.rowid
                   AND e.model = ?1
                   AND e.source_hash = n.title || COALESCE(n.summary, ''))
             ORDER BY n.rowid ASC LIMIT ?2",
        )?;
        for row in stmt.query_map(params![model, limit - out.len() as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, text, hash) = row?;
            out.push(("class_node".to_string(), id, text, hash));
        }
        Ok(out)
    }

    /// Replace one target's vectors for a model, atomically.
    pub fn store_embeddings(
        &self,
        target_kind: &str,
        target_id: i64,
        model: &str,
        source_hash: &str,
        chunks: &[(polis_core::vec::Chunk, polis_core::vec::QVec)],
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM embeddings
             WHERE target_kind = ?1 AND target_id = ?2 AND model = ?3",
            params![target_kind, target_id, model],
        )?;
        let now = polis_core::ledger::now_millis();
        for (chunk, q) in chunks {
            tx.execute(
                "INSERT INTO embeddings
                    (target_kind, target_id, chunk_ix, char_start, char_len,
                     dim, scale, vec, model, source_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    target_kind,
                    target_id,
                    chunk.ix,
                    chunk.char_start,
                    chunk.char_len,
                    q.bytes.len() as i64,
                    q.scale,
                    polis_core::vec::pack(q),
                    model,
                    source_hash,
                    now,
                ],
            )?;
        }
        tx.commit()
    }

    /// Every vector for a model, as `(target_kind, target_id, chunk_ix, vec)`.
    /// Read whole and cached — see `embed::VectorCache`.
    pub fn all_embeddings(
        &self,
        model: &str,
    ) -> rusqlite::Result<Vec<(i64, String, i64, polis_core::vec::QVec)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, target_kind, target_id, scale, vec
             FROM embeddings WHERE model = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![model], |r| {
            let scale: f64 = r.get(3)?;
            let blob: Vec<u8> = r.get(4)?;
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                polis_core::vec::unpack(&blob, scale as f32),
            ))
        })?;
        rows.collect()
    }

    /// `(chunks, pending, distinct_targets)` for a model — what Health shows,
    /// so a half-built index is VISIBLE rather than silently degrading recall.
    pub fn embedding_stats(&self, model: &str) -> rusqlite::Result<(i64, i64)> {
        let conn = self.conn();
        let chunks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM embeddings WHERE model = ?1",
            params![model],
            |r| r.get(0),
        )?;
        let pending: i64 = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM prompts p
                 WHERE COALESCE(p.role,'user') <> 'agent' AND LENGTH(p.fts_text) > 0
                   AND NOT EXISTS (SELECT 1 FROM embeddings e
                     WHERE e.target_kind='prompt' AND e.target_id=p.id
                       AND e.model=?1 AND e.source_hash=p.body_hash))
             + (SELECT COUNT(*) FROM (SELECT context_hash FROM browse_events be
                 WHERE LENGTH(be.text) > 0
                   AND NOT EXISTS (SELECT 1 FROM embeddings e
                     WHERE e.target_kind='browse_event' AND e.model=?1
                       AND e.source_hash=be.context_hash)
                 GROUP BY be.context_hash))",
            params![model],
            |r| r.get(0),
        )?;
        Ok((chunks, pending))
    }

    /// The vector index's high-water mark — the cache key. One monotonic
    /// number, so invalidation never depends on anyone remembering to clear it
    /// (the `build_stats_cached` idiom).
    pub fn max_embedding_id(&self) -> rusqlite::Result<i64> {
        let conn = self.conn();
        conn.query_row("SELECT COALESCE(MAX(id), 0) FROM embeddings", [], |r| r.get(0))
    }
}

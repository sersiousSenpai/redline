// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Agent-written pattern statements over a node's items — derived, never ground truth.
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
    /// Insert an observation + append its `observation` ledger event,
    /// atomically. Dedup on (node_id, summary) regardless of `dismissed` —
    /// a dismissed pattern never resurfaces under the same wording. Returns
    /// the new row id, `None` when skipped. Empty cite_seqs is rejected here
    /// too (defense in depth behind the strict parser).
    pub fn insert_class_observation(
        &self,
        node_id: &str,
        summary: &str,
        cite_seqs: &[i64],
        actor: &str,
    ) -> rusqlite::Result<Option<i64>> {
        if cite_seqs.is_empty() || summary.trim().is_empty() {
            return Ok(None);
        }
        let conn = self.conn();
        let node_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM class_nodes WHERE id = ?1",
            params![node_id],
            |r| r.get(0),
        )?;
        if node_exists == 0 {
            return Ok(None);
        }
        let dup: i64 = conn.query_row(
            "SELECT COUNT(*) FROM class_observations WHERE node_id = ?1 AND summary = ?2",
            params![node_id, summary],
            |r| r.get(0),
        )?;
        if dup > 0 {
            return Ok(None);
        }
        let cites = serde_json::to_string(cite_seqs).unwrap_or_else(|_| "[]".into());
        let now = polis_core::ledger::now_millis();
        conn.execute(
            "INSERT INTO class_observations
                (node_id, summary, cite_seqs, created_seq, pinned, dismissed, created_at)
             VALUES (?1, ?2, ?3, NULL, 0, 0, ?4)",
            params![node_id, summary, cites, now],
        )?;
        let row_id = conn.last_insert_rowid();
        // Field order is frozen — it is the payload-hash identity.
        let ph = polis_core::ledger::decision_payload_hash(&[
            ("node", node_id),
            ("summary", summary),
            ("cites", &cites),
        ]);
        let author = actor.to_string();
        let ev = Self::append_ledger_event_locked(
            &conn,
            &polis_core::ledger::LedgerAppend {
                kind: polis_core::ledger::EventKind::Observation.as_str(),
                author: &author,
                ts: now,
                prompt_id: None,
                session_id: None,
                version_number: None,
                ref_kind: Some("class_node"),
                ref_id: Some(node_id),
                payload_hash: &ph,
            },
        )?;
        conn.execute(
            "UPDATE class_observations SET created_seq = ?2 WHERE id = ?1",
            params![row_id, ev.seq],
        )?;
        Ok(Some(row_id))
    }

    pub fn list_class_observations(
        &self,
        node_id: &str,
        include_dismissed: bool,
    ) -> rusqlite::Result<Vec<polis_core::types::ClassObservation>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, node_id, summary, cite_seqs, created_seq, pinned, dismissed, created_at
             FROM class_observations
             WHERE node_id = ?1 AND (?2 OR dismissed = 0)
             ORDER BY pinned DESC, created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![node_id, include_dismissed], |r| {
            Ok(polis_core::types::ClassObservation {
                id: r.get(0)?,
                node_id: r.get(1)?,
                summary: r.get(2)?,
                cite_seqs: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                created_seq: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
                dismissed: r.get::<_, i64>(6)? != 0,
                created_at: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    /// Newest (non-dismissed) observation timestamp per node — the keeper's
    /// freshness gate: a node whose newest observation postdates its last
    /// activity has nothing new to mine.
    pub fn newest_observation_per_node(
        &self,
    ) -> rusqlite::Result<std::collections::HashMap<String, i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT node_id, MAX(created_at) FROM class_observations
             WHERE dismissed = 0 GROUP BY node_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    /// Dismiss = "never resurface this pattern". Returns the node id so the
    /// caller can record the `class_curate` event. The row is kept (not
    /// deleted) so the dedup guard keeps holding.
    pub fn set_observation_dismissed(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        let node: Option<String> = conn
            .query_row(
                "SELECT node_id FROM class_observations WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if node.is_some() {
            conn.execute(
                "UPDATE class_observations SET dismissed = 1, pinned = 0 WHERE id = ?1",
                params![id],
            )?;
        }
        Ok(node)
    }

    /// Pin = promote into the node's permanent context (floats first in the
    /// pane and in retrieval). Returns the node id for the curate event.
    pub fn set_observation_pinned(
        &self,
        id: i64,
        pinned: bool,
    ) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        let node: Option<String> = conn
            .query_row(
                "SELECT node_id FROM class_observations WHERE id = ?1 AND dismissed = 0",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if node.is_some() {
            conn.execute(
                "UPDATE class_observations SET pinned = ?2 WHERE id = ?1",
                params![id, pinned as i64],
            )?;
        }
        Ok(node)
    }
}

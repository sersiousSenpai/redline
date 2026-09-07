// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Memory-by-session: the readable parent/child relation across thread id-spaces.
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
    /// Insert a session-tree relation. A child has at most one parent (UNIQUE
    /// on `(child_kind, child_id)` — first write wins); returns the new row id,
    /// or `None` when the child is already linked.
    pub fn insert_session_link(
        &self,
        child_kind: &str,
        child_id: &str,
        parent_kind: &str,
        parent_id: &str,
        created_at: i64,
    ) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn();
        let changed = conn.execute(
            "INSERT INTO session_tree (child_kind, child_id, parent_kind, parent_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(child_kind, child_id) DO NOTHING",
            params![child_kind, child_id, parent_kind, parent_id, created_at],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(conn.last_insert_rowid()))
    }

    /// A child's parent, if linked: `(parent_kind, parent_id)`.
    pub fn session_tree_parent(
        &self,
        child_kind: &str,
        child_id: &str,
    ) -> rusqlite::Result<Option<(String, String)>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT parent_kind, parent_id FROM session_tree
             WHERE child_kind = ?1 AND child_id = ?2",
            params![child_kind, child_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
    }

    /// The plan session this claude session was launched to orchestrate, if
    /// any. A `session → session` link is written exclusively by the
    /// Orchestrate ingest claim (`claim_orchestration_prompt`), so its
    /// presence IS "this session is an orchestrator" — used by `handle_plan`
    /// to refuse an orchestrator that tries to plan instead of execute.
    pub fn orchestrator_parent_session(&self, claude_session_id: &str) -> Option<String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT parent_id FROM session_tree
             WHERE child_kind = 'session' AND child_id = ?1 AND parent_kind = 'session'",
            params![claude_session_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// A parent's children, oldest-first: `(child_kind, child_id, created_at)`.
    pub fn session_tree_children(
        &self,
        parent_kind: &str,
        parent_id: &str,
    ) -> rusqlite::Result<Vec<(String, String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT child_kind, child_id, created_at FROM session_tree
             WHERE parent_kind = ?1 AND parent_id = ?2 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![parent_kind, parent_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect()
    }

    /// Every session-tree relation, ordered by row id — the Map's `lineage`
    /// edges. Read whole (the table is small: one row per attached child
    /// thread), never paged.
    pub fn list_session_tree_rows(
        &self,
    ) -> rusqlite::Result<Vec<(String, String, String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT child_kind, child_id, parent_kind, parent_id
             FROM session_tree ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect()
    }
}

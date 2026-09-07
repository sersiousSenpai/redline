// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The class catalog: nodes, links, proposals, runs, the staging/apply machinery and the map's edge readers.
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

/// Fresh node id for a created/staged node.
pub fn new_node_id() -> String {
    format!("cn-{}", uuid::Uuid::new_v4().simple())
}

impl PolisStore {
    /// Drop one queued proposal, returning its op so the host can note what
    /// was refused. The row delete is the store's; the friction note that
    /// Redline records beside it is the host's (`Database::reject_class_proposal`).
    pub fn delete_class_proposal(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Option<String>> {
        let op: Option<String> = conn
            .query_row(
                "SELECT op FROM class_proposals WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        conn.execute("DELETE FROM class_proposals WHERE id = ?1", params![id])?;
        Ok(op)
    }
}

impl PolisStore {
    pub fn row_to_class_node(r: &rusqlite::Row) -> rusqlite::Result<polis_core::types::ClassNode> {
        Ok(polis_core::types::ClassNode {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            kind: r.get(2)?,
            title: r.get(3)?,
            summary: r.get(4)?,
            project_path: r.get(5)?,
            ip_name: r.get(6)?,
            status: r.get(7)?,
            pinned: r.get::<_, i64>(8)? != 0,
            curated_by: r.get(9)?,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
        })
    }
}

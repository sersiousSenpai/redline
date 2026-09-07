// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Export bookkeeping: which plans were bundled at which head.
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
    /// Record that a session was exported as a portable bundle (backs the
    /// Librarian's F6 signal). Idempotent per `(session_id, scope)` — a
    /// re-export refreshes `head_hash`/`exported_at`.
    pub fn record_plan_export(
        &self,
        session_id: &str,
        scope: &str,
        head_hash: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO plan_exports (session_id, scope, head_hash, exported_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, scope) DO UPDATE SET
                head_hash = excluded.head_hash,
                exported_at = excluded.exported_at",
            params![session_id, scope, head_hash, polis_core::ledger::now_millis()],
        )?;
        Ok(())
    }
}

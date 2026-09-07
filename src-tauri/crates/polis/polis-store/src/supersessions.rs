// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Decision supersession: a newer decision replaces an older one, never deletes it.
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
    /// Validate + record "decision new_seq supersedes decision old_seq":
    /// append the `supersede` ledger event and insert the queryable
    /// `supersessions` index row, atomically under one lock. Never deletes —
    /// the old decision stays in the lake with a status, and a pin on it does
    /// NOT veto (nothing is destroyed; the UI surfaces it instead).
    /// Production goes through `apply_class_proposal` (which calls the locked
    /// core under its own lock); this locking wrapper exists for tests.
    // (was `#[cfg(test)]` on `Database`; a store's cfg(test) does not reach a
    // host's tests, and the wrapper is harmless in production)
    pub fn apply_supersession(
        &self,
        old_seq: i64,
        new_seq: i64,
        rationale: &str,
        actor: &str,
    ) -> rusqlite::Result<polis_core::types::SupersessionOutcome> {
        let conn = self.conn();
        Self::apply_supersession_locked(&conn, old_seq, new_seq, rationale, actor)
    }

    /// The core, callable with an already-held lock (`apply_class_proposal`
    /// holds it across the op match).
    pub fn apply_supersession_locked(
        conn: &rusqlite::Connection,
        old_seq: i64,
        new_seq: i64,
        rationale: &str,
        actor: &str,
    ) -> rusqlite::Result<polis_core::types::SupersessionOutcome> {
        use polis_core::types::SupersessionOutcome as Out;
        let kind_of = |seq: i64| -> rusqlite::Result<Option<String>> {
            conn.query_row(
                "SELECT kind FROM ledger_events WHERE seq = ?1",
                params![seq],
                |r| r.get(0),
            )
            .optional()
        };
        // Only decisions are claims that can be replaced; prompts/revisions
        // are history and are never superseded.
        for seq in [old_seq, new_seq] {
            match kind_of(seq)? {
                None => return Ok(Out::Rejected(format!("no ledger event #{seq}"))),
                Some(k) if !polis_core::types::DECISION_KINDS.contains(&k.as_str()) => {
                    return Ok(Out::Rejected(format!(
                        "#{seq} is a {k} event, not a decision"
                    )));
                }
                Some(_) => {}
            }
        }
        // "Superseded at most once": if old_seq was already superseded, this
        // op redirects to the current head of its chain.
        let mut effective_old = old_seq;
        let mut hops = 0;
        while let Some(next) = conn
            .query_row(
                "SELECT new_seq FROM supersessions WHERE old_seq = ?1",
                params![effective_old],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
        {
            effective_old = next;
            hops += 1;
            if hops > 64 {
                return Ok(Out::Rejected("supersession chain too deep".into()));
            }
        }
        if effective_old == new_seq {
            // Covers the idempotent duplicate: A→B proposed again lands here.
            return Ok(Out::Rejected(format!("#{new_seq} is already the chain head")));
        }
        // Every stored edge strictly increases seq, so requiring old < new
        // makes cycles structurally impossible — this check IS the cycle
        // rejection (the hop guard above is defense in depth).
        if effective_old >= new_seq {
            return Ok(Out::Rejected(format!(
                "superseding decision #{new_seq} must come after #{effective_old}"
            )));
        }
        // Field order is frozen — it is the payload-hash identity.
        let new_str = new_seq.to_string();
        let ph = polis_core::ledger::decision_payload_hash(&[
            ("superseded_by", &new_str),
            ("rationale", rationale),
        ]);
        let author = actor.to_string();
        let old_str = effective_old.to_string();
        let ev = Self::append_ledger_event_locked(
            conn,
            &polis_core::ledger::LedgerAppend {
                kind: polis_core::ledger::EventKind::Supersede.as_str(),
                author: &author,
                ts: polis_core::ledger::now_millis(),
                prompt_id: None,
                session_id: None,
                version_number: None,
                ref_kind: Some("ledger_event"),
                ref_id: Some(old_str.as_str()),
                payload_hash: &ph,
            },
        )?;
        conn.execute(
            "INSERT INTO supersessions (old_seq, new_seq, event_seq, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![effective_old, new_seq, ev.seq, ev.ts],
        )?;
        Ok(Out::Applied {
            effective_old,
            new_seq,
            event_seq: ev.seq,
        })
    }

    /// old_seq → new_seq for the given seqs — backs the per-link
    /// `supersededBy` annotation in the node view. One `IN` query per chunk
    /// rather than one query per seq: a node with a hundred links used to mean
    /// a hundred statement executions here. (As-of queries later fall out of
    /// the same table by filtering `event_seq <= asof`.)
    pub fn supersessions_for_seqs(
        &self,
        seqs: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, i64>> {
        let mut out = std::collections::HashMap::new();
        if seqs.is_empty() {
            return Ok(out);
        }
        let conn = self.conn();
        for chunk in seqs.chunks(400) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut stmt = conn.prepare(&format!(
                "SELECT old_seq, new_seq FROM supersessions WHERE old_seq IN ({marks})"
            ))?;
            let refs: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(refs.as_slice(), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (old_seq, new_seq) = row?;
                out.insert(old_seq, new_seq);
            }
        }
        Ok(out)
    }

    /// Every supersession as `(old_seq, new_seq)`, oldest link first — the
    /// Map's `supersedes` edges resolve these seqs to their class/session
    /// endpoints via `resolve_map_endpoints`.
    pub fn list_supersession_pairs(&self) -> rusqlite::Result<Vec<(i64, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT old_seq, new_seq FROM supersessions ORDER BY old_seq ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// The sanctioned reversal of an approval: append a `supersede` ledger
    /// event referencing the approval by `(ref_kind="ledger_event",
    /// ref_id=approval_seq)` and insert the queryable `supersessions` index
    /// row. NEVER a delete — the chain stays intact and verifiable; the old
    /// approval simply stops being the current claim. `INSERT OR IGNORE`
    /// honors "superseded at most once" when the same approval is rescinded
    /// twice. Returns the supersede event's seq.
    pub fn record_approval_supersession(
        &self,
        approval_seq: i64,
        new_seq: i64,
        rationale: &str,
    ) -> rusqlite::Result<i64> {
        let conn = self.conn();
        let new_str = new_seq.to_string();
        // Field order frozen — it is the payload-hash identity (the
        // `apply_supersession_locked` shape).
        let ph = polis_core::ledger::decision_payload_hash(&[
            ("superseded_by", &new_str),
            ("rationale", rationale),
        ]);
        let author = self.author().to_string();
        let old_str = approval_seq.to_string();
        let ev = Self::append_ledger_event_locked(
            &conn,
            &polis_core::ledger::LedgerAppend {
                kind: polis_core::ledger::EventKind::Supersede.as_str(),
                author: &author,
                ts: polis_core::ledger::now_millis(),
                prompt_id: None,
                session_id: None,
                version_number: None,
                ref_kind: Some("ledger_event"),
                ref_id: Some(old_str.as_str()),
                payload_hash: &ph,
            },
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO supersessions (old_seq, new_seq, event_seq, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![approval_seq, new_seq, ev.seq, ev.ts],
        )?;
        Ok(ev.seq)
    }
}

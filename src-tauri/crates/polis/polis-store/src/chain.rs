// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Reading and verifying the hash chain: event lists, counts, previews, the full and incremental verifies.
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
    /// Append an event to the hash chain — cross-process safe (`ledger.rs`).
    /// Same name and signature the host's `Database` had, so every
    /// `db.append_ledger_event(&a)` site reads through `Deref` unchanged.
    pub fn append_ledger_event(
        &self,
        a: &polis_core::ledger::LedgerAppend,
    ) -> rusqlite::Result<polis_core::ledger::LedgerEventRow> {
        let conn = self.conn();
        Self::append_ledger_event_locked(&conn, a)
    }

    /// The append core, callable with an already-held connection so a caller
    /// that mutates a row and appends its proof event does both under one
    /// lock (and, in autocommit, one `BEGIN IMMEDIATE`).
    pub fn append_ledger_event_locked(
        conn: &rusqlite::Connection,
        a: &polis_core::ledger::LedgerAppend,
    ) -> rusqlite::Result<polis_core::ledger::LedgerEventRow> {
        crate::ledger::append_event(conn, a)
    }
}

impl PolisStore {
    pub const VERIFY_HEAD_HASH: &'static str = "redline.ledgerVerify.headHash";

    /// `app_settings` keys holding the last incremental verification anchor.
    pub const VERIFY_LAST_SEQ: &'static str = "redline.ledgerVerify.lastSeq";

    /// All ledger events tied to a session (`session_id` column match),
    /// oldest-first — the decision-event spine of `GET /v1/context/sessions/:id/
    /// history`. Prompt, revision, and decision events all carry `session_id`.
    pub fn list_session_events(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Vec<polis_core::ledger::LedgerEventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE session_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![session_id], Self::row_to_ledger_event)?;
        rows.collect()
    }

    /// Every ledger event, oldest-first, optionally after `since_seq` — the
    /// ordered spine an export bundle / mirror walks. `limit` caps a huge
    /// history. Ascending (unlike `list_ledger_events`, which is newest-first
    /// for the pane).
    pub fn list_ledger_events_asc(
        &self,
        since_seq: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::ledger::LedgerEventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_seq.max(0), limit.max(0)], Self::row_to_ledger_event)?;
        rows.collect()
    }

    /// Shared row→`LedgerEventRow` mapper (the column order every ledger SELECT
    /// above uses), so the three readers can't drift.
    pub fn row_to_ledger_event(r: &rusqlite::Row) -> rusqlite::Result<polis_core::ledger::LedgerEventRow> {
        Ok(polis_core::ledger::LedgerEventRow {
            seq: r.get(0)?,
            ts: r.get(1)?,
            kind: r.get(2)?,
            author: r.get(3)?,
            prompt_id: r.get(4)?,
            session_id: r.get(5)?,
            version_number: r.get(6)?,
            ref_kind: r.get(7)?,
            ref_id: r.get(8)?,
            payload_hash: r.get(9)?,
            prev_hash: r.get(10)?,
            entry_hash: r.get(11)?,
        })
    }

    /// Enriched ledger events (ascending, after `since_seq`) for the portable
    /// mirror: each event joined to its prompt provenance + full body. Revision
    /// bodies (`revisions.raw_plan_markdown`) are joined by the mirror writer,
    /// not here (a `revision` event has no `prompt_id`).
    pub fn list_mirror_events(
        &self,
        since_seq: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::types::MirrorRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT le.seq, le.ts, le.kind, le.author, le.prompt_id, le.session_id,
                    le.version_number, le.ref_kind, le.ref_id, le.payload_hash,
                    le.prev_hash, le.entry_hash,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path, p.body,
                    p.thread_kind, p.thread_id, p.parent_session_id
             FROM ledger_events le
             LEFT JOIN prompts p ON le.prompt_id = p.id
             WHERE le.seq > ?1 ORDER BY le.seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_seq.max(0), limit.max(0)], |r| {
            Ok(polis_core::types::MirrorRow {
                event: polis_core::ledger::LedgerEventRow {
                    seq: r.get(0)?,
                    ts: r.get(1)?,
                    kind: r.get(2)?,
                    author: r.get(3)?,
                    prompt_id: r.get(4)?,
                    session_id: r.get(5)?,
                    version_number: r.get(6)?,
                    ref_kind: r.get(7)?,
                    ref_id: r.get(8)?,
                    payload_hash: r.get(9)?,
                    prev_hash: r.get(10)?,
                    entry_hash: r.get(11)?,
                },
                surface: r.get(12)?,
                origin: r.get(13)?,
                role: r.get(14)?,
                mission_id: r.get(15)?,
                project_path: r.get(16)?,
                body: r.get(17)?,
                thread_kind: r.get(18)?,
                thread_id: r.get(19)?,
                parent_session_id: r.get(20)?,
            })
        })?;
        rows.collect()
    }

    /// Ledger event counts grouped by kind — `/v1/context/stats`.
    pub fn event_counts_by_kind(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM ledger_events GROUP BY kind ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Ledger event counts grouped by author — the Timeline's actor facet
    /// (`local_author()` vs the agent seat names P0 made distinct).
    pub fn event_counts_by_author(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT author, COUNT(*) FROM ledger_events GROUP BY author ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Most-recent-first ledger events, capped at `limit`.
    pub fn list_ledger_events(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::ledger::LedgerEventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(polis_core::ledger::LedgerEventRow {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                author: r.get(3)?,
                prompt_id: r.get(4)?,
                session_id: r.get(5)?,
                version_number: r.get(6)?,
                ref_kind: r.get(7)?,
                ref_id: r.get(8)?,
                payload_hash: r.get(9)?,
                prev_hash: r.get(10)?,
                entry_hash: r.get(11)?,
            })
        })?;
        rows.collect()
    }

    /// True if a revision event for this (session, version) already exists with
    /// the same payload hash — the idempotency guard for the revision path.
    pub fn revision_event_exists(
        &self,
        session_id: &str,
        version_number: i64,
        payload_hash: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ledger_events
             WHERE kind = 'revision' AND session_id = ?1
               AND version_number = ?2 AND payload_hash = ?3",
            params![session_id, version_number, payload_hash],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// True if an identical decision event already exists — idempotency guard
    /// for the decision path.
    pub fn decision_event_exists(
        &self,
        kind: &str,
        ref_kind: &str,
        ref_id: &str,
        payload_hash: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ledger_events
             WHERE kind = ?1 AND ref_kind = ?2 AND ref_id = ?3 AND payload_hash = ?4",
            params![kind, ref_kind, ref_id, payload_hash],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Verify only what the chain has grown by since the last verification,
    /// anchored on the stored `(lastSeq, headHash)` pair.
    ///
    /// HONEST TRADE, stated plainly: this cannot detect retroactive tampering
    /// of rows it already verified — it re-checks the anchor row's stored
    /// `entry_hash` and then walks forward from there, so an edit to some
    /// ancient row's `ts` would slip past. That is why the FULL
    /// `verify_ledger_chain` stays wired to the 6h `ledger-backup` keeper watch
    /// (inside its `spawn_blocking`): the periodic deep check is what catches
    /// retroactive edits, and this cheap one is what a 60s status poll can
    /// afford. On any anchor mismatch — a missing anchor, a rewound chain, an
    /// anchor row whose hash no longer matches — it falls back to the full walk
    /// and re-anchors.
    pub fn verify_ledger_chain_incremental(&self) -> rusqlite::Result<polis_core::ledger::ChainVerdict> {
        let head_seq = self.max_ledger_seq()?;
        let anchor_seq: Option<i64> = self.meta(Self::VERIFY_LAST_SEQ).ok().flatten()
            .and_then(|s| s.parse().ok());
        let anchor_hash = self.meta(Self::VERIFY_HEAD_HASH).ok().flatten();

        // Re-anchor on the head SEQ (not the row count): the anchor is a row
        // address, and the two only coincide because the chain is append-only.
        let full_and_reanchor = |db: &Self| -> rusqlite::Result<polis_core::ledger::ChainVerdict> {
            let verdict = db.verify_ledger_chain()?;
            if verdict.ok {
                let at = db.max_ledger_seq().unwrap_or(0);
                let _ = db.set_meta(Self::VERIFY_LAST_SEQ, &at.to_string());
                let _ = db.set_meta(
                    Self::VERIFY_HEAD_HASH,
                    verdict
                        .head_hash
                        .as_deref()
                        .unwrap_or(polis_core::ledger::GENESIS_PREV),
                );
            }
            Ok(verdict)
        };

        let (Some(anchor_seq), Some(anchor_hash)) = (anchor_seq, anchor_hash) else {
            return full_and_reanchor(self);
        };
        // A rewound or shrunk chain is not an incremental case.
        if anchor_seq > head_seq {
            return full_and_reanchor(self);
        }
        // The anchor row must still hash to what we recorded.
        let stored: Option<String> = {
            let conn = self.conn();
            conn.query_row(
                "SELECT entry_hash FROM ledger_events WHERE seq = ?1",
                params![anchor_seq],
                |r| r.get(0),
            )
            .optional()?
        };
        let anchor_ok = match (&stored, anchor_seq) {
            // seq 0 = "verified an empty chain"; genesis prev stands in.
            (None, 0) => anchor_hash == polis_core::ledger::GENESIS_PREV,
            (Some(h), _) => *h == anchor_hash,
            _ => false,
        };
        if !anchor_ok {
            return full_and_reanchor(self);
        }
        if head_seq == anchor_seq {
            return Ok(polis_core::ledger::ChainVerdict {
                ok: true,
                checked: head_seq,
                first_bad_seq: None,
                head_hash: Some(anchor_hash),
            });
        }

        // Walk only the suffix.
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE seq > ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![anchor_seq], Self::row_to_ledger_event)?;
        let mut prev = anchor_hash;
        let mut checked = anchor_seq;
        for row in rows {
            let e = row?;
            let bad = polis_core::ledger::ChainVerdict {
                ok: false,
                checked,
                first_bad_seq: Some(e.seq),
                head_hash: None,
            };
            if e.prev_hash != prev {
                return Ok(bad);
            }
            let canon = polis_core::ledger::CanonicalEvent {
                seq: e.seq,
                ts: e.ts,
                kind: &e.kind,
                author: &e.author,
                prompt_id: e.prompt_id,
                session_id: e.session_id.as_deref(),
                version_number: e.version_number,
                ref_kind: e.ref_kind.as_deref(),
                ref_id: e.ref_id.as_deref(),
                payload_hash: &e.payload_hash,
            };
            if polis_core::ledger::compute_entry_hash(&e.prev_hash, &canon) != e.entry_hash {
                return Ok(bad);
            }
            prev = e.entry_hash;
            checked += 1;
        }
        drop(stmt);
        drop(conn);
        let _ = self.set_meta(Self::VERIFY_LAST_SEQ, &head_seq.to_string());
        let _ = self.set_meta(Self::VERIFY_HEAD_HASH, &prev);
        Ok(polis_core::ledger::ChainVerdict {
            ok: true,
            checked,
            first_bad_seq: None,
            head_hash: Some(prev),
        })
    }

    /// Re-walk the whole chain, recomputing each `entry_hash` from stored fields
    /// and checking `prev_hash` linkage. Reports the first seq that fails.
    pub fn verify_ledger_chain(&self) -> rusqlite::Result<polis_core::ledger::ChainVerdict> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(polis_core::ledger::LedgerEventRow {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                author: r.get(3)?,
                prompt_id: r.get(4)?,
                session_id: r.get(5)?,
                version_number: r.get(6)?,
                ref_kind: r.get(7)?,
                ref_id: r.get(8)?,
                payload_hash: r.get(9)?,
                prev_hash: r.get(10)?,
                entry_hash: r.get(11)?,
            })
        })?;

        let mut prev = polis_core::ledger::GENESIS_PREV.to_string();
        let mut checked = 0i64;
        let mut head = None;
        for row in rows {
            let e = row?;
            // Linkage: this row must commit to its actual predecessor.
            if e.prev_hash != prev {
                return Ok(polis_core::ledger::ChainVerdict {
                    ok: false,
                    checked,
                    first_bad_seq: Some(e.seq),
                    head_hash: None,
                });
            }
            let canon = polis_core::ledger::CanonicalEvent {
                seq: e.seq,
                ts: e.ts,
                kind: &e.kind,
                author: &e.author,
                prompt_id: e.prompt_id,
                session_id: e.session_id.as_deref(),
                version_number: e.version_number,
                ref_kind: e.ref_kind.as_deref(),
                ref_id: e.ref_id.as_deref(),
                payload_hash: &e.payload_hash,
            };
            let recomputed = polis_core::ledger::compute_entry_hash(&e.prev_hash, &canon);
            if recomputed != e.entry_hash {
                return Ok(polis_core::ledger::ChainVerdict {
                    ok: false,
                    checked,
                    first_bad_seq: Some(e.seq),
                    head_hash: None,
                });
            }
            prev = e.entry_hash.clone();
            head = Some(e.entry_hash);
            checked += 1;
        }
        Ok(polis_core::ledger::ChainVerdict {
            ok: true,
            checked,
            first_bad_seq: None,
            head_hash: head,
        })
    }

    /// The maximum ledger seq (the delta ceiling for a classifier run). 0 if the
    /// chain is empty.
    pub fn max_ledger_seq(&self) -> rusqlite::Result<i64> {
        let conn = self.conn();
        conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM ledger_events", [], |r| r.get(0))
    }

    /// What kinds of events landed after `since_seq`, and how many of each —
    /// the cheap shape of a ledger delta, `(kind, count)` newest-heaviest
    /// first. A seq PK range scan plus a GROUP BY over a handful of rows; it
    /// exists so a retrieval agent can be told *what* grew instead of just
    /// *that* it grew, and skip a re-walk the delta doesn't touch.
    pub fn ledger_delta_summary(&self, since_seq: i64) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*) FROM ledger_events
             WHERE seq > ?1 GROUP BY kind ORDER BY COUNT(*) DESC, kind ASC",
        )?;
        let rows = stmt.query_map(params![since_seq.max(0)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    /// The newest decision event of a kind on a session — what a surface shot
    /// keys itself to.
    pub fn latest_decision_seq(&self, session_id: &str, kind: &str) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT MAX(seq) FROM ledger_events WHERE session_id = ?1 AND kind = ?2",
            params![session_id, kind],
            |r| r.get::<_, Option<i64>>(0),
        )
    }

    /// The most recent `approval` ledger event for a session — the decision an
    /// un-approve supersedes.
    pub fn latest_approval_seq(&self, session_id: &str) -> Option<i64> {
        let conn = self.conn();
        conn.query_row(
            "SELECT seq FROM ledger_events
             WHERE kind = 'approval' AND session_id = ?1
             ORDER BY seq DESC LIMIT 1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Ledger events of ONE kind since a wall-clock instant, newest first.
    /// `ts`, not `seq`: the away feed's watermark is "when the user last
    /// looked", which is a time, and translating it to a seq would need this
    /// same table read first.
    pub fn list_ledger_events_of_kind_since(
        &self,
        kind: &str,
        since_ts: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::ledger::LedgerEventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, kind, author, prompt_id, session_id, version_number,
                    ref_kind, ref_id, payload_hash, prev_hash, entry_hash
             FROM ledger_events WHERE kind = ?1 AND ts >= ?2
             ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![kind, since_ts, limit.max(1)], Self::row_to_ledger_event)?;
        rows.collect()
    }

    /// `link_preview` for a whole page of link targets in ONE query under ONE
    /// lock, keyed by ledger seq. The per-link version issued a query (and took
    /// the connection mutex) once per link, which is what made a node with a
    /// hundred links a hundred round trips through the shared lock.
    ///
    /// A compacted prompt yields its gist rather than the emptied body — the
    /// `list_ledger_events` idiom, so a released body still reads as something.
    pub fn link_previews_for_seqs(
        &self,
        seqs: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, String>> {
        let mut out = std::collections::HashMap::new();
        if seqs.is_empty() {
            return Ok(out);
        }
        let conn = self.conn();
        // Chunked so a very wide node can't exceed SQLite's bound-parameter cap.
        for chunk in seqs.chunks(400) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut stmt = conn.prepare(&format!(
                "SELECT le.seq, le.kind, COALESCE(NULLIF(p.body, ''), p.gist)
                 FROM ledger_events le LEFT JOIN prompts p ON le.prompt_id = p.id
                 WHERE le.seq IN ({marks})"
            ))?;
            let refs: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(refs.as_slice(), |r| {
                let seq: i64 = r.get(0)?;
                let kind: String = r.get(1)?;
                let body: Option<String> = r.get(2)?;
                let label = match body {
                    Some(b) => b.replace('\n', " ").chars().take(120).collect::<String>(),
                    None => format!("[{kind} event]"),
                };
                Ok((seq, label))
            })?;
            for row in rows {
                let (seq, label) = row?;
                out.insert(seq, label);
            }
        }
        Ok(out)
    }

    /// A short human label for a link target (best-effort). Prompt/decision/
    /// ledger targets carry a numeric ledger seq — resolve it to the prompt body
    /// snippet or the event kind. Other kinds render from the id alone.
    pub fn link_preview(&self, target_kind: &str, target_id: &str) -> Option<String> {
        if !matches!(target_kind, "prompt" | "decision" | "ledger") {
            return None;
        }
        let seq: i64 = target_id.trim().parse().ok()?;
        let conn = self.conn();
        conn.query_row(
            "SELECT le.kind, p.body
             FROM ledger_events le LEFT JOIN prompts p ON le.prompt_id = p.id
             WHERE le.seq = ?1",
            params![seq],
            |r| {
                let kind: String = r.get(0)?;
                let body: Option<String> = r.get(1)?;
                Ok(match body {
                    Some(b) => {
                        let one = b.replace('\n', " ");
                        let snip: String = one.chars().take(120).collect();
                        snip
                    }
                    None => format!("[{kind} event]"),
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }
}

impl PolisStore {
    /// Filtered, cursor-paged Timeline query — the Memory surface's spine.
    /// Newest-first; `f.before_seq` chains pages, so (unlike
    /// `list_ledger_events`' single capped read) the whole history is
    /// reachable. Every filter is a bound parameter (the
    /// `list_context_prompts` discipline). Prompt and browse provenance are
    /// LEFT-JOINed so one query serves every row shape; the accepted class
    /// filing is probed per returned page row (the `supersessions_for_seqs`
    /// pattern) — all derived at read time, never stored.
    pub fn query_ledger_events(
        &self,
        f: &polis_core::types::LedgerFilters,
    ) -> rusqlite::Result<Vec<polis_core::types::TimelineItem>> {
        let conn = self.conn();
        // Two user_notes probes, joined once for the whole page: `n_on` is the
        // note/star ANNOTATING this event (target_kind='ledger_event'); `n_own`
        // is a `note` event's OWN readable row — its standalone row by id, or
        // the row on whatever target it annotates — so the list shows the
        // note's current text, not a payload hash.
        // Clip in SQL, not in Rust. A page is up to 500 rows and a row renders
        // `PREVIEW_CHARS` characters at ROW_H=30, but the average body is
        // 6.3 KB — so this read moved ~730 KB across the connection lock to
        // display ~120 KB of it. One character past the window is fetched so
        // the "…" stays truthful, and `body_chars` reports the real length
        // without carrying the text it stands for.
        let preview_window = polis_core::types::PREVIEW_CHARS + 1;
        let mut sql = format!(
            "SELECT le.seq, le.ts, le.kind, le.author, le.prompt_id, le.session_id,
                    le.version_number, le.ref_kind, le.ref_id, le.payload_hash,
                    le.prev_hash, le.entry_hash,
                    p.surface, p.project_path, p.thread_kind, p.model,
                    substr(COALESCE(NULLIF(p.body, ''), p.gist), 1, {preview_window}),
                    LENGTH(COALESCE(NULLIF(p.body, ''), p.gist)),
                    p.role, p.compacted_at,
                    be.browse_id, be.url, be.title, be.action, be.from_event_id,
                    be.shot_key, be.caption,
                    COALESCE(n_on.starred, 0), n_on.text,
                    COALESCE(n_own.starred, 0), n_own.text
             FROM ledger_events le
             LEFT JOIN prompts p ON p.id = le.prompt_id
             LEFT JOIN browse_events be
               ON le.ref_kind = 'browse_event' AND be.id = CAST(le.ref_id AS INTEGER)
             LEFT JOIN user_notes n_on
               ON n_on.target_kind = 'ledger_event'
              AND n_on.target_id = CAST(le.seq AS TEXT)
             LEFT JOIN user_notes n_own
               ON le.kind = 'note'
              AND ((le.ref_kind = 'none' AND n_own.id = CAST(le.ref_id AS INTEGER))
                OR (le.ref_kind <> 'none' AND n_own.target_kind = le.ref_kind
                    AND n_own.target_id = le.ref_id))
             WHERE 1 = 1",
        );
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(k) = f.kind.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND le.kind = ?");
            binds.push(Box::new(k.to_string()));
        }
        if let Some(a) = f.author.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND le.author = ?");
            binds.push(Box::new(a.to_string()));
        }
        if let Some(s) = f.session_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND le.session_id = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(s) = f.surface.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.surface = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(p) = f.project.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.project_path = ?");
            binds.push(Box::new(p.to_string()));
        }
        if let Some(q) = f.q.as_deref().filter(|s| !s.is_empty()) {
            // The UI's own search box, and the last `LIKE '%…%'` full scan on
            // the surface: it read every prompt body in the lake, joined to the
            // whole chain, on every keystroke past the 250 ms debounce.
            //
            // Now the prompt half rides `prompts_fts` as a FILTER — the index
            // narrows, `ORDER BY le.seq DESC` still decides the order, and the
            // response shape is untouched. That discipline is the design law:
            // a ranked fuzzy index must not become the taxonomy, so it may
            // narrow an ordered query but never reorder one. The AND reading is
            // what a search box means: more words, fewer rows.
            //
            // Note text keeps its LIKE. `user_notes` is tiny (one row per
            // annotated target) and a margin note is words the user chose, so
            // substring behaviour there is what they expect — and an index over
            // it would cost more than it saves.
            let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            let pat = format!("%{escaped}%");
            match polis_core::query::plan_fts_query(q) {
                Some(plan) => {
                    sql.push_str(
                        " AND (p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH ?)
                            OR n_own.text LIKE ? ESCAPE '\\')",
                    );
                    binds.push(Box::new(plan.and_match));
                    binds.push(Box::new(pat));
                }
                None => {
                    sql.push_str(&format!(
                        " AND ({PROMPT_TEXT} LIKE ? ESCAPE '\\'
                            OR n_own.text LIKE ? ESCAPE '\\')"
                    ));
                    binds.push(Box::new(pat.clone()));
                    binds.push(Box::new(pat));
                }
            }
        }
        // Corpus-role facet. Defaults to `user` at the UI, which is what makes
        // the reclassification visible rather than merely done: flipping it
        // reveals the 6.9 MB of Redline's own agent text that was silently
        // sharing the corpus with the user's prompts. A non-prompt event (a
        // decision, a browse view) has no role and is never filtered out by it.
        if let Some(role) = f.role.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND (le.prompt_id IS NULL OR COALESCE(p.role, 'user') = ?)");
            binds.push(Box::new(role.to_string()));
        }
        // Star / note facets — structural clauses, nothing user-typed. An
        // event counts as starred/noted through either probe: annotated, or a
        // `note` event whose own row carries the star/text.
        if f.starred.unwrap_or(false) {
            sql.push_str(" AND (n_on.starred = 1 OR n_own.starred = 1)");
        }
        if f.noted.unwrap_or(false) {
            sql.push_str(" AND (COALESCE(n_on.text, '') <> '' OR COALESCE(n_own.text, '') <> '')");
        }
        // P4 citation focus: exact seqs (the Ask agent's `#seq` chips). An
        // empty list behaves like an absent filter, matching every other axis.
        if let Some(seqs) = f.seqs.as_deref().filter(|s| !s.is_empty()) {
            let marks = vec!["?"; seqs.len()].join(", ");
            sql.push_str(&format!(" AND le.seq IN ({marks})"));
            for s in seqs {
                binds.push(Box::new(*s));
            }
        }
        // P4 citation focus: events filed under one accepted class node. Same
        // two-keyspace discipline as the filing probe below — `class_links.
        // target_id` is the ledger seq for prompt/decision/revision/note
        // targets but the `browse_events` row id for browse targets.
        if let Some(node) = f.class_node.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(
                " AND (EXISTS (SELECT 1 FROM class_links cl
                        WHERE cl.status = 'accepted' AND cl.node_id = ?
                          AND cl.target_kind IN ('prompt', 'decision', 'revision', 'note')
                          AND cl.target_id = CAST(le.seq AS TEXT))
                    OR (le.ref_kind = 'browse_event'
                        AND EXISTS (SELECT 1 FROM class_links cl
                        WHERE cl.status = 'accepted' AND cl.node_id = ?
                          AND cl.target_kind = 'browse_event'
                          AND cl.target_id = le.ref_id)))",
            );
            binds.push(Box::new(node.to_string()));
            binds.push(Box::new(node.to_string()));
        }
        // P5 Map focus: an agent thread's prompts / a browse tab's trail. Both
        // bound; both narrow through the existing LEFT JOINs (which then act
        // as inner joins — a non-prompt/non-browse row can't match).
        if let Some(t) = f.thread_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.thread_id = ?");
            binds.push(Box::new(t.to_string()));
        }
        if let Some(b) = f.browse_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND be.browse_id = ?");
            binds.push(Box::new(b.to_string()));
        }
        if let Some(ts) = f.since_ts {
            sql.push_str(" AND le.ts >= ?");
            binds.push(Box::new(ts));
        }
        if let Some(ts) = f.until_ts {
            sql.push_str(" AND le.ts <= ?");
            binds.push(Box::new(ts));
        }
        if let Some(seq) = f.before_seq {
            sql.push_str(" AND le.seq < ?");
            binds.push(Box::new(seq));
        }
        sql.push_str(" ORDER BY le.seq DESC LIMIT ?");
        binds.push(Box::new(polis_core::types::clamp_ledger_limit(f.limit)));

        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            let event = Self::row_to_ledger_event(r)?;
            let body: Option<String> = r.get(16)?;
            let body_chars: Option<i64> = r.get(17)?;
            let role: Option<String> = r.get(18)?;
            let compacted_at: Option<i64> = r.get(19)?;
            let starred_on: i64 = r.get(27)?;
            let note_on: Option<String> = r.get(28)?;
            let starred_own: i64 = r.get(29)?;
            let note_own: Option<String> = r.get(30)?;
            // A `note` event's list text is its row's current words; those come
            // back whole (the table is tiny) so they still clip here.
            let from_note = body.is_none();
            let preview = body.or(note_own);
            let full_chars = if from_note {
                preview.as_ref().map(|p| p.chars().count() as i64)
            } else {
                body_chars
            };
            Ok(polis_core::types::TimelineItem {
                event,
                surface: r.get(12)?,
                project_path: r.get(13)?,
                thread_kind: r.get(14)?,
                model: r.get(15)?,
                preview: preview.map(|b| {
                    if b.chars().count() > polis_core::types::PREVIEW_CHARS {
                        b.chars().take(polis_core::types::PREVIEW_CHARS).collect::<String>() + "…"
                    } else {
                        b
                    }
                }),
                body_chars: full_chars,
                role,
                compacted: compacted_at.is_some(),
                browse_id: r.get(20)?,
                url: r.get(21)?,
                title: r.get(22)?,
                action: r.get(23)?,
                from_event_id: r.get(24)?,
                shot_key: r.get(25)?,
                caption: r.get(26)?,
                class_node_id: None,
                class_title: None,
                starred: starred_on != 0 || starred_own != 0,
                note: note_on.filter(|t| !t.is_empty()),
            })
        })?;
        let mut items: Vec<polis_core::types::TimelineItem> = rows.collect::<Result<_, _>>()?;

        // Accepted class filing for the WHOLE page in two batched queries.
        // `class_links.target_id` is the ledger `seq` for prompt/decision/
        // revision targets but the `browse_events` row id for browse targets —
        // two keyspaces, probed seq-first, so a numeric browse id can never
        // shadow a seq (or vice versa).
        //
        // This used to be one query per row per keyspace: a 500-row page cost
        // up to 1,000 executions, each an unindexed scan of `class_links`, all
        // under the single connection lock. `MIN(cl.id)` reproduces the old
        // `ORDER BY cl.id LIMIT 1` precedence — the earliest accepted filing
        // wins — and `idx_class_links_target` now serves the lookup direction.
        let seq_keys: Vec<String> = items.iter().map(|it| it.event.seq.to_string()).collect();
        let browse_keys: Vec<String> = items
            .iter()
            .filter(|it| it.event.ref_kind.as_deref() == Some("browse_event"))
            .filter_map(|it| it.event.ref_id.clone())
            .collect();
        let by_seq = Self::filings_for_targets(
            &conn,
            &["prompt", "decision", "revision", "note"],
            &seq_keys,
        )?;
        let by_browse = Self::filings_for_targets(&conn, &["browse_event"], &browse_keys)?;
        for it in &mut items {
            let filing = by_seq.get(&it.event.seq.to_string()).or_else(|| {
                (it.event.ref_kind.as_deref() == Some("browse_event"))
                    .then(|| it.event.ref_id.as_deref().and_then(|rid| by_browse.get(rid)))
                    .flatten()
            });
            if let Some((node_id, title)) = filing {
                it.class_node_id = Some(node_id.clone());
                it.class_title = Some(title.clone());
            }
        }
        // The host's own pictures (`surface_shots`) join here in the host — see
        // `HostResolver::surface_shot_keys` and `polis_memory::retrieval::query_ledger`.
        Ok(items)
    }
}

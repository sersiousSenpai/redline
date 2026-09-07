// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The user's own margin notes and stars over the record.
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
    pub fn row_to_user_note(r: &rusqlite::Row) -> rusqlite::Result<polis_core::types::UserNote> {
        Ok(polis_core::types::UserNote {
            id: r.get(0)?,
            seq: r.get(1)?,
            target_kind: r.get(2)?,
            target_id: r.get(3)?,
            text: r.get(4)?,
            starred: r.get::<_, i64>(5)? != 0,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    }
}

impl PolisStore {
    /// Apply one note act atomically: resolve (or create) the `user_notes`
    /// row, apply the text or star change, and append the `note` ledger event
    /// committing to `{action, text}` — the row + its tamper-evident fact under
    /// one lock (the `insert_class_observation` discipline). Exactly one of
    /// `text`/`starred` per call (one act = one event); a no-op appends
    /// nothing. Never deletes — clearing text keeps the row and its history.
    pub fn write_user_note(
        &self,
        w: &polis_core::types::NoteWrite,
        actor: &str,
    ) -> rusqlite::Result<polis_core::types::NoteOutcome> {
        use polis_core::types::NoteOutcome as Out;
        if w.text.is_some() == w.starred.is_some() {
            return Ok(Out::Rejected(
                "one act per call: set exactly one of `text` / `starred`".into(),
            ));
        }
        let conn = self.conn();

        // Resolve the row: by explicit id, else by target (creating on first
        // touch), else a fresh standalone.
        let select_one = format!("SELECT {} FROM user_notes", PolisStore::USER_NOTE_COLS);
        let mut note: Option<polis_core::types::UserNote> = None;
        let (target_kind, target_id): (String, Option<String>);
        if let Some(id) = w.note_id {
            let found = conn
                .query_row(
                    &format!("{select_one} WHERE id = ?1"),
                    params![id],
                    PolisStore::row_to_user_note,
                )
                .optional()?;
            match found {
                Some(n) => {
                    target_kind = n.target_kind.clone();
                    target_id = n.target_id.clone();
                    note = Some(n);
                }
                None => return Ok(Out::Rejected(format!("no note #{id}"))),
            }
        } else {
            let tk = w.target_kind.as_deref().unwrap_or("none");
            if !matches!(tk, "ledger_event" | "class_node" | "session" | "none") {
                return Ok(Out::Rejected(format!("unknown note target kind `{tk}`")));
            }
            if tk == "none" {
                // A fresh standalone thought — it must start with words.
                if w.text.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Ok(Out::Rejected("a standalone note needs text".into()));
                }
                (target_kind, target_id) = (tk.to_string(), None);
            } else {
                let Some(tid) = w.target_id.as_deref().filter(|s| !s.trim().is_empty()) else {
                    return Ok(Out::Rejected(format!("a `{tk}` note needs a target id")));
                };
                // The annotated thing must exist where we can check it —
                // pointing the record at a phantom target would poison the
                // timeline probes (the supersession discipline).
                let exists = match tk {
                    "ledger_event" => conn
                        .query_row(
                            "SELECT COUNT(*) FROM ledger_events WHERE seq = ?1",
                            params![tid.parse::<i64>().unwrap_or(-1)],
                            |r| r.get::<_, i64>(0),
                        )?
                        > 0,
                    "class_node" => conn
                        .query_row(
                            "SELECT COUNT(*) FROM class_nodes WHERE id = ?1",
                            params![tid],
                            |r| r.get::<_, i64>(0),
                        )?
                        > 0,
                    // Session ids span disjoint id-spaces (plan/browse/voice…);
                    // referenced by id, never FK-checked — the session_tree rule.
                    _ => true,
                };
                if !exists {
                    return Ok(Out::Rejected(format!("no {tk} `{tid}` to annotate")));
                }
                note = conn
                    .query_row(
                        &format!("{select_one} WHERE target_kind = ?1 AND target_id = ?2"),
                        params![tk, tid],
                        PolisStore::row_to_user_note,
                    )
                    .optional()?;
                (target_kind, target_id) = (tk.to_string(), Some(tid.to_string()));
            }
        }

        let now = polis_core::ledger::now_millis();
        let mut row = match note {
            Some(n) => n,
            None => {
                conn.execute(
                    "INSERT INTO user_notes
                        (seq, target_kind, target_id, text, starred, created_at, updated_at)
                     VALUES (NULL, ?1, ?2, '', 0, ?3, ?3)",
                    params![target_kind, target_id, now],
                )?;
                polis_core::types::UserNote {
                    id: conn.last_insert_rowid(),
                    seq: None,
                    target_kind: target_kind.clone(),
                    target_id: target_id.clone(),
                    text: String::new(),
                    starred: false,
                    created_at: now,
                    updated_at: now,
                }
            }
        };

        // Apply the act; a no-op returns without touching the ledger. (A row
        // freshly created above always differs: standalone requires text, and
        // a star-toggle on a new row flips 0→1.)
        let action = if let Some(text) = w.text.as_deref() {
            if row.text == text {
                return Ok(Out::Unchanged(row));
            }
            row.text = text.to_string();
            "note"
        } else {
            let starred = w.starred.unwrap_or(false);
            if row.starred == starred {
                return Ok(Out::Unchanged(row));
            }
            row.starred = starred;
            if starred {
                "star"
            } else {
                "unstar"
            }
        };

        // Field order is frozen — it is the payload-hash identity.
        let ph = polis_core::ledger::decision_payload_hash(&[("action", action), ("text", &row.text)]);
        // A standalone note's event references its own row (each thought is
        // its own history); a targeted note references the annotated thing.
        let row_id_str = row.id.to_string();
        let (ref_kind, ref_id): (&str, &str) = if row.target_kind == "none" {
            ("none", &row_id_str)
        } else {
            (&row.target_kind, row.target_id.as_deref().unwrap_or(""))
        };
        let author = actor.to_string();
        let ev = Self::append_ledger_event_locked(
            &conn,
            &polis_core::ledger::LedgerAppend {
                kind: polis_core::ledger::EventKind::Note.as_str(),
                author: &author,
                ts: now,
                prompt_id: None,
                session_id: (row.target_kind == "session").then_some(ref_id),
                version_number: None,
                ref_kind: Some(ref_kind),
                ref_id: Some(ref_id),
                payload_hash: &ph,
            },
        )?;
        conn.execute(
            "UPDATE user_notes SET seq = ?2, text = ?3, starred = ?4, updated_at = ?5
             WHERE id = ?1",
            params![row.id, ev.seq, row.text, row.starred as i64, ev.ts],
        )?;
        row.seq = Some(ev.seq);
        row.updated_at = ev.ts;
        Ok(Out::Written(row))
    }

    /// The note row annotating one target, if any — the detail rail's read.
    pub fn get_user_note(
        &self,
        target_kind: &str,
        target_id: &str,
    ) -> rusqlite::Result<Option<polis_core::types::UserNote>> {
        let conn = self.conn();
        conn.query_row(
            &format!(
                "SELECT {} FROM user_notes WHERE target_kind = ?1 AND target_id = ?2",
                PolisStore::USER_NOTE_COLS
            ),
            params![target_kind, target_id],
            PolisStore::row_to_user_note,
        )
        .optional()
    }

    /// Every note row (optionally starred-only), most recently touched first —
    /// the notes list, the mirror's row files, and the bundle join.
    pub fn list_user_notes(
        &self,
        starred_only: bool,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::types::UserNote>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM user_notes WHERE (?1 = 0 OR starred = 1)
             ORDER BY updated_at DESC, id DESC LIMIT ?2",
            PolisStore::USER_NOTE_COLS
        ))?;
        let rows = stmt.query_map(
            params![starred_only as i64, limit.max(0)],
            PolisStore::row_to_user_note,
        )?;
        rows.collect()
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Captured page views: the browse trail, pictures and captions.
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
    /// Insert a browsing event into the ledger-owned `browse_events` store.
    /// Dedups a *consecutive* re-capture of the same content in the same tab (the
    /// snapshot fires on navigation AND just before a tab is backgrounded, so one
    /// page can be captured twice) — returns `None` then. The same `context_hash`
    /// recurring later (after visiting other pages, or in another tab) is kept, so
    /// content-identity grouping across the corpus stays intact. Returns the new
    /// row id on insert.
    pub fn insert_browse_event(
        &self,
        r: &polis_core::ledger::BrowseEventRow,
    ) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn();
        let last: Option<String> = conn
            .query_row(
                "SELECT context_hash FROM browse_events
                 WHERE browse_id IS ?1 ORDER BY id DESC LIMIT 1",
                params![r.browse_id],
                |row| row.get(0),
            )
            .optional()?;
        if last.as_deref() == Some(r.context_hash) {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO browse_events (ts, action, browse_id, url, title, text, context_hash, from_event_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![r.ts, r.action, r.browse_id, r.url, r.title, r.text, r.context_hash, r.from_event_id],
        )?;
        Ok(Some(conn.last_insert_rowid()))
    }

    /// `context_hash` (sha256 of the normalized DOM) for a set of browse-event
    /// ids — the exact-identity key the answer pack dedupes on. Already stored
    /// and indexed, which is what makes exact dedup free: 829 browse events
    /// hold only 665 distinct pages.
    pub fn context_hashes_for_browse_ids(
        &self,
        ids: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, String>> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.conn();
        let marks = vec!["?"; ids.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT id, context_hash FROM browse_events WHERE id IN ({marks})"
        ))?;
        let refs: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect()
    }

    /// Fetch a browse event's `(url, title, text, context_hash)` by id — the read
    /// side of the `browse_events` store, for the bundle/mirror joins that will
    /// carry browse-event bodies (exercised by tests today).
    #[allow(dead_code)]
    pub fn get_browse_event(
        &self,
        id: i64,
    ) -> rusqlite::Result<Option<(String, Option<String>, String, String)>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT url, title, text, context_hash FROM browse_events WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
    }

    /// Point every row with this `context_hash` at a shot. Content-addressed,
    /// so one capture serves every tab that saw the same page.
    pub fn set_shot_key_for_hash(&self, context_hash: &str, key: &str) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute(
            "UPDATE browse_events SET shot_key = ?2 WHERE context_hash = ?1",
            params![context_hash, key],
        )
    }

    /// "Forget this picture": clear the pointer everywhere it appears. The
    /// caller deletes the file; this is the half that makes it disappear from
    /// the UI even if the unlink fails.
    pub fn clear_shot_key(&self, key: &str) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute("UPDATE browse_events SET shot_key = NULL WHERE shot_key = ?1", params![key])
    }

    /// Pages that have a PICTURE but essentially no TEXT — the vision tier's
    /// backlog, and the measurement that earns it.
    ///
    /// 100 of 829 live browse rows (12.1%) have `length(text) < 200`, i.e. next
    /// to nothing after the `"{title}\n{url}\n\n"` prefix. The sample is exactly
    /// the predicted class: a docs site that renders client-side, a Wikimedia
    /// infographic that IS an image, a wall of `localhost:3000` React
    /// dashboards. Those rows sit in `browse_events_fts` contributing nothing —
    /// and for every one of them there is already a picture on disk. Not
    /// "vision is cool": **12% of the corpus is dark and the light is already
    /// on**.
    pub fn pages_with_a_picture_but_no_text(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, url, COALESCE(title, ''), shot_key
             FROM browse_events
             WHERE shot_key IS NOT NULL
               AND caption IS NULL
               AND LENGTH(text) < 200
             GROUP BY context_hash
             ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        rows.collect()
    }

    /// Store a vision-tier caption.
    ///
    /// Written to `caption`, NEVER appended into `text` — `context_hash =
    /// body_hash(text)` is the identity the shot key, the dedupe and the chain
    /// all rest on, so folding a caption into `text` would silently re-key the
    /// page and orphan its own picture.
    pub fn set_caption_for_hash(&self, context_hash: &str, caption: &str) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute(
            "UPDATE browse_events SET caption = ?2 WHERE context_hash = ?1",
            params![context_hash, caption],
        )
    }

    /// `(with_pictures, dark_pages)` for Health.
    pub fn shot_stats(&self) -> rusqlite::Result<(i64, i64)> {
        let conn = self.conn();
        conn.query_row(
            "SELECT
                (SELECT COUNT(DISTINCT shot_key) FROM browse_events WHERE shot_key IS NOT NULL),
                (SELECT COUNT(DISTINCT context_hash) FROM browse_events
                  WHERE shot_key IS NOT NULL AND caption IS NULL AND LENGTH(text) < 200)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// The `context_hash` for one browse event — the capture path needs it to
    /// mint a content-addressed key.
    pub fn context_hash_for_browse_id(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT context_hash FROM browse_events WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
    }
}

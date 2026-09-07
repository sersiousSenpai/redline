// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The lake's prompt rows: insert, the launch/thread bindings, bodies, corpus composition and the read-side lists.
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
use crate::search::{GrepError, GREP_MIN_LITERAL};

/// The ONE expression that reads a prompt's text, for use in a query that has
/// `prompts` aliased as `p`. Compaction sets `body = ''` (not NULL), so the
/// obvious `COALESCE(p.body, p.gist)` returns an EMPTY STRING for every
/// compacted row rather than falling through to the gist — a silent
/// content-free read, not an error. Two live queries had it; this const exists
/// so there is one place to be right.
pub const PROMPT_TEXT: &str = "COALESCE(NULLIF(p.body, ''), p.gist)";

impl PolisStore {
    /// Insert a prompt row, deduped on (body_hash, claude_session_id). Returns
    /// the new row id, or `None` if an identical prompt was already stored.
    pub fn insert_prompt(&self, p: &polis_core::ledger::PromptRow) -> rusqlite::Result<Option<i64>> {
        let conn = self.conn();
        let changed = conn.execute(
            "INSERT INTO prompts
                (ts, source, origin, surface, role, user_text, session_id, claude_session_id,
                 mission_id, project_path, body, body_hash,
                 thread_kind, thread_id, parent_session_id, model, model_source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(body_hash, claude_session_id) DO NOTHING",
            params![
                p.ts,
                p.source,
                p.origin,
                p.surface,
                p.role,
                p.user_text,
                p.session_id,
                p.claude_session_id,
                p.mission_id,
                p.project_path,
                p.body,
                p.body_hash,
                p.thread_kind,
                p.thread_id,
                p.parent_session_id,
                p.model,
                p.model_source,
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(conn.last_insert_rowid()))
    }

    /// Whether any prompt captured under this claude session still lacks a
    /// model — the cheap guard that keeps the hook hot path from re-reading a
    /// transcript tail once everything is already stamped.
    pub fn session_needs_model(&self, claude_session_id: &str) -> bool {
        let conn = self.conn();
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM prompts
                WHERE claude_session_id = ?1 AND model IS NULL)",
            params![claude_session_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .unwrap_or(false)
    }

    /// Backfill the model onto every prompt of a claude session that doesn't
    /// have one (`model_source = 'transcript'`). Rows already stamped at
    /// capture (`'seat'`) are never overwritten — capture-time truth outranks
    /// a backfill. Returns how many rows were stamped.
    pub fn backfill_session_model(
        &self,
        claude_session_id: &str,
        model: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute(
            "UPDATE prompts SET model = ?2, model_source = 'transcript'
             WHERE claude_session_id = ?1 AND model IS NULL",
            params![claude_session_id, model],
        )
    }

    /// The same bind for any thread that can launch a plan. A chat graduating
    /// is the second — it owns its launched prompt exactly as a document does,
    /// and hardcoding `'drafter'` here would have left every graduated prompt
    /// with a permanently NULL `claude_session_id`, invisible to the transcript
    /// model backfill.
    pub fn bind_threaded_prompt_session(
        &self,
        body_hash: &str,
        thread_kind: &str,
        thread_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute(
            "UPDATE OR IGNORE prompts SET claude_session_id = ?4
             WHERE body_hash = ?1 AND thread_kind = ?2 AND thread_id = ?3
               AND claude_session_id IS NULL",
            params![body_hash, thread_kind, thread_id, claude_session_id],
        )
    }

    /// The same bind for a launch that had no document — the Front Door's one
    /// sentence and the browser's Send. Those prompts are recorded with no
    /// thread and no claude session (claude hadn't spawned), so without this
    /// they keep a **permanently NULL** `claude_session_id` and the transcript
    /// model backfill never reaches them. `thread_id IS NULL` is what keeps
    /// this off any threaded row; the body hash is what makes it the right one.
    pub fn bind_launch_prompt_session(
        &self,
        body_hash: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.conn();
        conn.execute(
            "UPDATE OR IGNORE prompts SET claude_session_id = ?2
             WHERE body_hash = ?1 AND thread_id IS NULL AND claude_session_id IS NULL",
            params![body_hash, claude_session_id],
        )
    }

    /// Bind a drafter-launched prompt row to the session that eventually ran
    /// it. The launch records with `claude_session_id = NULL` (claude hasn't
    /// spawned yet); the ingest hook's claim is the first moment the id is
    /// known. `OR IGNORE` respects the `(body_hash, claude_session_id)` unique
    /// index — if the hook already captured the same body under that session,
    /// the drafter row simply stays a launch record.
    pub fn bind_drafter_prompt_session(
        &self,
        body_hash: &str,
        draft_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<usize> {
        self.bind_threaded_prompt_session(body_hash, "drafter", draft_id, claude_session_id)
    }

    /// `(prompt_id, model)` for every prompt with a stamped model — the Memory
    /// inspector joins this onto its event rows for the per-row chip + filter.
    pub fn list_prompt_models(&self) -> rusqlite::Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT id, model FROM prompts WHERE model IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Fetch a stored prompt body by id. When the row has been compacted, the
    /// gist stands in for the released body — so every reader (the ledger pane
    /// viewer, the bundle join, the mirror, the context routes) transparently
    /// sees the gist and no caller has to special-case compaction.
    pub fn get_prompt_body(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let conn = self.conn();
        conn.query_row(
            "SELECT COALESCE(gist, body) FROM prompts WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
    }

    /// The corpus's own composition: `(role, rows, bytes)` over the whole lake,
    /// NULL-safe. This is the number that was never on screen — 92.6% of the
    /// searchable bytes were machine text and nothing reported it, so the only
    /// visible symptom was that search "felt wrong". Cheap enough for the
    /// memory-status poll (one grouped scan of a small table).
    pub fn corpus_composition(&self) -> rusqlite::Result<Vec<(String, i64, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT COALESCE(role, 'unclassified') AS r, COUNT(*),
                    COALESCE(SUM(LENGTH(CAST(COALESCE(NULLIF(body, ''), gist, '') AS BLOB))), 0)
             FROM prompts GROUP BY r ORDER BY r",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        rows.collect()
    }

    /// `(agent_written, deterministic_fallback)` gist counts. 47% of surviving
    /// gists were the deterministic fallback — i.e. the summarizer wasn't
    /// running — and nobody was watching, so compaction was quietly degrading to
    /// "keep the first 240 characters" while reporting a 59:1 reclaim.
    pub fn gist_source_counts(&self) -> rusqlite::Result<(i64, i64)> {
        let conn = self.conn();
        conn.query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN gist_source = 'agent' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN gist_source <> 'agent' OR gist_source IS NULL
                                  THEN 1 ELSE 0 END), 0)
             FROM prompts WHERE gist IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// `prompt_id → ledger seq` for a set of prompt ids.
    ///
    /// The semantic index keys on `prompts.id` (a chunk belongs to a row) while
    /// every retrieval surface speaks ledger `seq` (a citation belongs to a
    /// moment). Fusing two ranked lists that key on different id-spaces would
    /// produce a fusion that agrees with itself about nothing, so the bridge is
    /// explicit. `le.kind = 'prompt'` is load-bearing: a compacted row also
    /// carries a `compaction` event with the same `prompt_id`.
    pub fn seqs_for_prompt_ids(
        &self,
        ids: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, i64>> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.conn();
        let marks = vec!["?"; ids.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT prompt_id, MIN(seq) FROM ledger_events
             WHERE kind = 'prompt' AND prompt_id IN ({marks})
             GROUP BY prompt_id"
        ))?;
        let refs: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    /// Full lake items for an exact set of seqs — how a semantic-only hit
    /// (one no lexical term matched) gets a body to show.
    pub fn lake_items_for_seqs(
        &self,
        seqs: &[i64],
    ) -> rusqlite::Result<Vec<polis_core::types::LakeItem>> {
        if seqs.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let marks = vec!["?"; seqs.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT le.seq, le.ts, le.kind, le.ref_kind, le.ref_id, le.session_id,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path,
                    {PROMPT_TEXT},
                    p.thread_kind, p.thread_id, p.parent_session_id, p.model
             FROM ledger_events le
             JOIN prompts p ON p.id = le.prompt_id
             WHERE le.kind = 'prompt' AND le.seq IN ({marks})
             ORDER BY le.seq DESC"
        ))?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            seqs.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), Self::row_to_lake_item)?;
        rows.collect()
    }

    /// Row → `LakeItem` over the canonical projection every lake reader
    /// selects (`le.seq … p.model`), so the readers can't drift.
    pub fn row_to_lake_item(r: &rusqlite::Row) -> rusqlite::Result<polis_core::types::LakeItem> {
        let body: Option<String> = r.get(11)?;
        Ok(polis_core::types::LakeItem {
            seq: r.get(0)?,
            ts: r.get(1)?,
            kind: r.get(2)?,
            ref_kind: r.get(3)?,
            ref_id: r.get(4)?,
            session_id: r.get(5)?,
            surface: r.get(6)?,
            origin: r.get(7)?,
            role: r.get(8)?,
            mission_id: r.get(9)?,
            project_path: r.get(10)?,
            body: body.map(|b| {
                if b.chars().count() > 4000 {
                    b.chars().take(4000).collect::<String>() + "…"
                } else {
                    b
                }
            }),
            thread_kind: r.get(12)?,
            thread_id: r.get(13)?,
            parent_session_id: r.get(14)?,
            model: r.get(15)?,
        })
    }

    /// Fetch the full (uncompacted) bodies for a set of prompt ids — the input
    /// the keeper's summarizer (and its deterministic fallback) gist from. Only
    /// warm rows are returned; an already-compacted id is silently skipped.
    pub fn get_prompt_bodies(&self, ids: &[i64]) -> rusqlite::Result<Vec<(i64, String)>> {
        let conn = self.conn();
        let mut out = Vec::with_capacity(ids.len());
        let mut stmt =
            conn.prepare("SELECT body FROM prompts WHERE id = ?1 AND gist IS NULL")?;
        for &id in ids {
            let body: Option<String> = stmt
                .query_row(params![id], |r| r.get(0))
                .optional()?;
            if let Some(b) = body {
                out.push((id, b));
            }
        }
        Ok(out)
    }

    /// Filtered prompt query backing `GET /v1/context/prompts`. Every optional
    /// filter is ANDed; the free-text `substring` is bound (never string-
    /// interpolated) so an injection-shaped `q` can only ever LIKE-match, not
    /// alter the SQL. Oldest-first, capped at `limit`.
    pub fn list_context_prompts(
        &self,
        f: &polis_core::types::PromptFilters,
    ) -> rusqlite::Result<Vec<polis_core::types::LakeItem>> {
        let conn = self.conn();
        // Build a parameterized WHERE; each clause pushes a bound value so no
        // caller string ever reaches the SQL text.
        // `p.body` alone was a live bug here: compaction writes `body = ''`, so
        // this route — which backs the MCP `query_prompts` tool — returned an
        // empty string for all 224 compacted rows rather than their gists. An
        // external session grounding itself on the user's memory read them as
        // content-free. `PROMPT_TEXT` is the one expression that resolves it.
        let mut sql = format!(
            "SELECT le.seq, le.ts, le.kind, le.ref_kind, le.ref_id, le.session_id,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path,
                    {PROMPT_TEXT},
                    p.thread_kind, p.thread_id, p.parent_session_id, p.model
             FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id
             WHERE 1 = 1"
        );
        let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        match f.role.as_deref().filter(|s| !s.is_empty()) {
            Some(role) => {
                sql.push_str(" AND COALESCE(p.role, 'user') = ?");
                binds.push(Box::new(role.to_string()));
            }
            None if !f.include_agent => {
                sql.push_str(" AND COALESCE(p.role, 'user') <> 'agent'");
            }
            None => {}
        }
        if let Some(s) = f.session_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.session_id = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(m) = f.mission_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.mission_id = ?");
            binds.push(Box::new(m.to_string()));
        }
        if let Some(s) = f.surface.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.surface = ?");
            binds.push(Box::new(s.to_string()));
        }
        if let Some(t) = f.thread_kind.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.thread_kind = ?");
            binds.push(Box::new(t.to_string()));
        }
        if let Some(t) = f.thread_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.thread_id = ?");
            binds.push(Box::new(t.to_string()));
        }
        if let Some(p) = f.parent_session_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.parent_session_id = ?");
            binds.push(Box::new(p.to_string()));
        }
        if let Some(p) = f.project.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.project_path = ?");
            binds.push(Box::new(p.to_string()));
        }
        if let Some(m) = f.model.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND p.model = ?");
            binds.push(Box::new(m.to_string()));
        }
        if let Some(seq) = f.since_seq {
            sql.push_str(" AND le.seq > ?");
            binds.push(Box::new(seq.max(0)));
        }
        if let Some(q) = f.substring.as_deref().filter(|s| !s.is_empty()) {
            // FTS as a FILTER, not a ranker: the clause narrows `prompts`
            // through the index, and the route's `ORDER BY le.seq` and response
            // shape are untouched. (bm25 ranking lives in `search_prompts_fts`,
            // where re-ordering is the point.) Before this, `?q=` was a LIKE
            // cross-scan of every prompt body joined to the whole chain.
            //
            // An unsanitizable query — punctuation only, say — yields no FTS
            // tokens; fall back to the bound LIKE so it still matches something
            // rather than erroring or silently returning nothing.
            // The planner's AND reading is the right one for a FILTER: the
            // job is narrowing, and every extra word the user types should cut
            // the list down rather than widen it. (The OR-with-prefix stage is
            // for RANKED search, where a weak hit still beats no hit.)
            match polis_core::query::plan_fts_query(q) {
                Some(plan) => {
                    sql.push_str(
                        " AND p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH ?)",
                    );
                    binds.push(Box::new(plan.and_match));
                }
                None => {
                    // Escape LIKE metacharacters so the text matches literally.
                    let escaped =
                        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                    sql.push_str(&format!(" AND {PROMPT_TEXT} LIKE ? ESCAPE '\\'"));
                    binds.push(Box::new(format!("%{escaped}%")));
                }
            }
        }
        sql.push_str(" ORDER BY le.seq ASC LIMIT ?");
        binds.push(Box::new(f.limit.max(1)));

        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            let body: Option<String> = r.get(11)?;
            Ok(polis_core::types::LakeItem {
                seq: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                ref_kind: r.get(3)?,
                ref_id: r.get(4)?,
                session_id: r.get(5)?,
                surface: r.get(6)?,
                origin: r.get(7)?,
                role: r.get(8)?,
                mission_id: r.get(9)?,
                project_path: r.get(10)?,
                body: body.map(|b| {
                    if b.chars().count() > 4000 {
                        b.chars().take(4000).collect::<String>() + "…"
                    } else {
                        b
                    }
                }),
                thread_kind: r.get(12)?,
                thread_id: r.get(13)?,
                parent_session_id: r.get(14)?,
                model: r.get(15)?,
            })
        })?;
        rows.collect()
    }

    /// Prompt ids captured under a mission — the mission-scope filter for export
    /// bundles (ledger_events has no `mission_id`; the prompt row carries it).
    pub fn mission_prompt_ids(&self, mission_id: &str) -> rusqlite::Result<Vec<i64>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id FROM prompts WHERE mission_id = ?1")?;
        let rows = stmt.query_map(params![mission_id], |r| r.get::<_, i64>(0))?;
        rows.collect()
    }

    /// Prompt counts grouped by UTC day (`YYYY-MM-DD`), oldest day first —
    /// `/v1/context/stats` day histogram.
    pub fn prompt_counts_by_day(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, COUNT(*)
             FROM prompts GROUP BY day ORDER BY day ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Prompt counts grouped by capture surface — `/v1/context/stats`.
    pub fn prompt_counts_by_surface(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT surface, COUNT(*) FROM prompts GROUP BY surface ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    }

    /// Prompt body-length distribution per capture surface — the cheapest
    /// available proxy for "how hard is the thinking on this surface". Returns
    /// `(surface, count, median_bytes, p90_bytes)`, heaviest surface first.
    pub fn prompt_length_by_surface(&self) -> rusqlite::Result<Vec<(String, i64, i64, i64)>> {
        let conn = self.conn();
        // Percentiles without a window function: rank rows per surface and pick
        // the row at the requested fraction. `prompts` is small enough that the
        // ordering cost is irrelevant, and this stays portable across the
        // bundled SQLite build.
        let mut stmt = conn.prepare(
            "SELECT surface, LENGTH(body) AS len FROM prompts ORDER BY surface, len ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        let mut by_surface: std::collections::HashMap<String, Vec<i64>> =
            std::collections::HashMap::new();
        for row in rows {
            let (surface, len) = row?;
            by_surface.entry(surface).or_default().push(len);
        }
        let pick = |sorted: &[i64], frac: f64| -> i64 {
            if sorted.is_empty() {
                return 0;
            }
            let idx = ((sorted.len() as f64 - 1.0) * frac).round() as usize;
            sorted[idx.min(sorted.len() - 1)]
        };
        let mut out: Vec<(String, i64, i64, i64)> = by_surface
            .into_iter()
            .map(|(surface, lens)| {
                let n = lens.len() as i64;
                (surface, n, pick(&lens, 0.5), pick(&lens, 0.9))
            })
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(out)
    }
}

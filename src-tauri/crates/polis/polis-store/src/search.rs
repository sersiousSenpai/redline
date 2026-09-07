// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The lexical and literal arms: FTS5 over prompts, pages, notes and the catalog, and the trigram grep.
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

/// Shortest literal the grep arm will accept. This is the trigram size, and it
/// is a hard floor rather than a tuning knob: a two-character needle cannot be
/// answered from a trigram index at all, so accepting one would silently turn
/// an indexed lookup into a full scan of the corpus under the connection lock.
pub const GREP_MIN_LITERAL: usize = 3;

/// Characters of context returned around a grep match.
const GREP_EXCERPT_CHARS: usize = 240;

/// Why a grep was refused. Both variants are named rather than degraded into an
/// empty result: "nothing matched" and "we declined to look" are different
/// answers, and a caller can only fix the second if it is told.
#[derive(Debug, Clone)]
pub enum GrepError {
    LiteralTooShort { min: usize, got: usize },
    BadRegex(String),
    Db(String),
}

impl std::fmt::Display for GrepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GrepError::LiteralTooShort { min, got } => write!(
                f,
                "the literal must be at least {min} characters (got {got}) — shorter than a \
                 trigram cannot be answered from the index, and scanning the whole record \
                 instead would be slow rather than helpful"
            ),
            GrepError::BadRegex(e) => write!(f, "invalid regex: {e}"),
            GrepError::Db(e) => write!(f, "{e}"),
        }
    }
}

impl From<rusqlite::Error> for GrepError {
    fn from(e: rusqlite::Error) -> Self {
        GrepError::Db(e.to_string())
    }
}

impl PolisStore {
    pub const USER_NOTE_COLS: &'static str =
        "id, seq, target_kind, target_id, text, starred, created_at, updated_at";

    /// Lexical (BM25) search over browse-event content — the Dojo P3 retrieval
    /// path for the noisy, keyword-heavy browsing stream (plans/prompts keep the
    /// vectorless walk). Ranks by FTS5 `bm25`, best first, and returns a matched
    /// snippet per hit. A query that sanitizes to nothing yields no hits.
    pub fn search_browse_events(&self, query: &str, limit: i64) -> rusqlite::Result<Vec<BrowseHit>> {
        use polis_core::query::MatchStage;
        let Some(plan) = polis_core::query::plan_fts_query(query) else {
            return Ok(Vec::new());
        };
        let conn = self.conn();
        // Same AND-then-OR cascade as the prompt arm. Columns are weighted
        // `title 5 / url 2 / text 1`: a term in a page's title says the page is
        // ABOUT it; the same term buried in 3 KB of DOM text says it appeared.
        //
        // The ledger `seq` join is what makes a browse hit CITABLE. `BrowseHit`
        // used to carry `browse_events.id`, but the Ask citation contract is
        // `#seq` and the Timeline's filter takes seqs — so a page the agent
        // cited could not be opened. Verified 1:1 and complete on live data
        // (829 events, 829 ledger rows).
        for stage in [MatchStage::And, MatchStage::Or] {
            let Some(match_q) = plan.match_for(stage) else { continue };
            if match_q.is_empty() {
                continue;
            }
            let mut stmt = conn.prepare(
                "SELECT be.id, le.seq, be.ts, be.url, be.title,
                        snippet(browse_events_fts, 2, '[', ']', '…', 12),
                        bm25(browse_events_fts, 5.0, 2.0, 1.0),
                        be.shot_key, be.caption
                 FROM browse_events_fts
                 JOIN browse_events be ON be.id = browse_events_fts.rowid
                 LEFT JOIN ledger_events le
                        ON le.ref_kind = 'browse_event' AND le.ref_id = CAST(be.id AS TEXT)
                 WHERE browse_events_fts MATCH ?1
                 ORDER BY bm25(browse_events_fts, 5.0, 2.0, 1.0)
                 LIMIT ?2",
            )?;
            let rows: Vec<BrowseHit> = stmt
                .query_map(params![match_q, limit.max(1)], |r| {
                    Ok(BrowseHit {
                        id: r.get(0)?,
                        seq: r.get(1)?,
                        ts: r.get(2)?,
                        url: r.get(3)?,
                        title: r.get(4)?,
                        snippet: r.get(5)?,
                        score: r.get(6)?,
                        stage: stage.as_str().to_string(),
                        shot_key: r.get(7)?,
                        caption: r.get(8)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
        Ok(Vec::new())
    }

    /// The cascade behind `search_prompts_fts`, with each hit labelled by the
    /// stage that found it.
    ///
    /// `AND` first, then `OR` with prefixes, then `LIKE`. The stages are tried
    /// in order and the FIRST one that returns anything wins — widening is a
    /// fallback, not a supplement, because mixing a precise hit with a
    /// one-term-in-nine hit and ranking them together is how "browser" ends up
    /// beating "browser tab suspension" on a query that named all three.
    ///
    /// `bm25(prompts_fts, 3.0, 1.0)` weights the head column 3× over the tail:
    /// a 6 KB prompt states its ask in its first paragraph, and a match there
    /// means something different from a match 4 KB in.
    pub fn search_prompts_ranked(
        &self,
        q: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(polis_core::types::LakeItem, polis_core::query::MatchStage)>> {
        use polis_core::query::MatchStage;
        let trimmed = q.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        const COLS: &str = "SELECT le.seq, le.ts, le.kind, le.ref_kind, le.ref_id, le.session_id,
                    p.surface, p.origin, p.role, p.mission_id, p.project_path,
                    COALESCE(NULLIF(p.body, ''), p.gist),
                    p.thread_kind, p.thread_id, p.parent_session_id, p.model";
        let plan = polis_core::query::plan_fts_query(trimmed);
        let conn = self.conn();

        if let Some(plan) = &plan {
            for stage in [MatchStage::And, MatchStage::Or] {
                let Some(match_q) = plan.match_for(stage) else { continue };
                if match_q.is_empty() {
                    continue;
                }
                let mut stmt = conn.prepare(&format!(
                    "{COLS}
                     FROM prompts_fts
                     JOIN prompts p ON p.id = prompts_fts.rowid
                     JOIN ledger_events le ON le.prompt_id = p.id
                     WHERE prompts_fts MATCH ?1 AND le.kind = 'prompt'
                     ORDER BY bm25(prompts_fts, 3.0, 1.0) LIMIT ?2"
                ))?;
                let rows: Vec<polis_core::types::LakeItem> = stmt
                    .query_map(params![match_q, limit.max(1)], Self::row_to_lake_item)?
                    .collect::<rusqlite::Result<_>>()?;
                if !rows.is_empty() {
                    return Ok(rows.into_iter().map(|r| (r, stage)).collect());
                }
            }
        }

        // Stage 3: a bound substring scan. Reached when the query produced no
        // usable terms at all (all punctuation, a single CJK character) or when
        // both index stages came back empty.
        //
        // It matches against `p.fts_text`, the SAME generated column the index
        // reads — not against the raw body. Otherwise the fallback quietly
        // undoes the corpus rule: an agent preface is unreachable through the
        // index and then perfectly reachable through the LIKE, so the words
        // Phase 1 removed from the corpus come back the moment a query happens
        // to miss. The row still RETURNS its display text; only the matching
        // changes.
        let escaped = trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut stmt = conn.prepare(&format!(
            "{COLS}
                     FROM prompts p
                     JOIN ledger_events le ON le.prompt_id = p.id
                     WHERE p.fts_text LIKE ?1 ESCAPE '\\'
                       AND le.kind = 'prompt'
                     ORDER BY le.seq DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(
            params![format!("%{escaped}%"), limit.max(1)],
            Self::row_to_lake_item,
        )?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|r| (r, MatchStage::Like))
            .collect())
    }

    /// BM25-ranked search over captured prompt bodies — the answer pack's lake
    /// arm, and the one place ranking (rather than filtering) is the point: a
    /// pack has room for ~20 hits, so which 20 matters more than their order in
    /// the chain.
    ///
    /// A compacted prompt matches (and returns) its gist, so releasing the
    /// words never removes the memory from search — only the released words
    /// stop matching. Falls back to a bound LIKE for a query that yields no
    /// FTS tokens.
    ///
    /// `le.kind = 'prompt'` is load-bearing: a compacted row also carries a
    /// `compaction` event pointing at the same `prompt_id`, so without it the
    /// join returns one hit per event and a compacted prompt would appear
    /// twice, spending the pack's budget on a duplicate.
    /// The plain ranked form. Production reads go through
    /// `search_prompts_ranked`, which also reports the cascade stage; this
    /// stays as the legible API over the same cascade.
    #[allow(dead_code)]
    pub fn search_prompts_fts(
        &self,
        q: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::types::LakeItem>> {
        Ok(self.search_prompts_ranked(q, limit)?.into_iter().map(|(it, _)| it).collect())
    }

    /// Substring/regex search over the record — the arm that reaches what
    /// tokenization cannot: flags (`--allowedTools`), paths
    /// (`src-tauri/src/db.rs`), error strings, attributes
    /// (`#[serde(rename_all)]`).
    ///
    /// The shape is Google Code Search's: the trigram index proposes candidates
    /// for the LIKE, and the optional regex VERIFIES them in Rust over what the
    /// index returned. The regex never touches the database, so a pathological
    /// pattern costs one Rust pass over ≤`limit` rows instead of a scan under
    /// the connection lock.
    ///
    /// `literal` must be at least `GREP_MIN_LITERAL` characters, because that
    /// is the trigram size: a shorter needle cannot be answered from the index
    /// and would silently become a full scan. It is refused BY NAME
    /// (`GrepError::LiteralTooShort`) rather than quietly scanned — a caller
    /// that gets a slow answer learns nothing, a caller that gets a named
    /// refusal learns to lengthen the needle.
    pub fn grep_memory(
        &self,
        literal: &str,
        re: Option<&str>,
        case_sensitive: bool,
        scope: GrepScope,
        limit: i64,
    ) -> Result<Vec<GrepHit>, GrepError> {
        let needle = literal.trim();
        if needle.chars().count() < GREP_MIN_LITERAL {
            return Err(GrepError::LiteralTooShort {
                min: GREP_MIN_LITERAL,
                got: needle.chars().count(),
            });
        }
        // Compiled BEFORE any query: a bad pattern is the caller's mistake and
        // should cost nothing.
        let matcher = re
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(|r| {
                let src = if case_sensitive { r.to_string() } else { format!("(?i){r}") };
                regex_lite::Regex::new(&src)
            })
            .transpose()
            .map_err(|e| GrepError::BadRegex(e.to_string()))?;

        let escaped = needle
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pat = format!("%{escaped}%");
        let limit = limit.clamp(1, 200);
        let conn = self.conn();
        let mut out: Vec<GrepHit> = Vec::new();

        // The trigram index answers a `LIKE '%…%'` on its own column directly —
        // that is the whole reason this tokenizer exists. `case_sensitive` is a
        // post-filter rather than a second index: two trigram indexes over the
        // same text would double the cost to serve a rare option.
        if scope.wants_prompts() {
            let mut stmt = conn.prepare(
                "SELECT le.seq, p.id, p.ts, p.surface, p.fts_text
                 FROM prompts_grep
                 JOIN prompts p ON p.id = prompts_grep.rowid
                 JOIN ledger_events le ON le.prompt_id = p.id AND le.kind = 'prompt'
                 WHERE prompts_grep.fts_text LIKE ?1 ESCAPE '\\'
                 ORDER BY le.seq DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![pat, limit], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?;
            for row in rows {
                let (seq, _id, ts, surface, text) = row?;
                if case_sensitive && !text.contains(needle) {
                    continue;
                }
                if matcher.as_ref().is_some_and(|m| !m.is_match(&text)) {
                    continue;
                }
                out.push(GrepHit {
                    kind: "prompt".to_string(),
                    seq: Some(seq),
                    ts,
                    label: surface.unwrap_or_else(|| "prompt".to_string()),
                    excerpt: polis_core::dedup::excerpt_around(
                        &text,
                        std::slice::from_ref(&needle.to_string()),
                        GREP_EXCERPT_CHARS,
                    ),
                });
            }
        }

        if scope.wants_browse() {
            let mut stmt = conn.prepare(
                "SELECT le.seq, be.id, be.ts, be.url, COALESCE(be.title, '')
                 FROM browse_grep
                 JOIN browse_events be ON be.id = browse_grep.rowid
                 LEFT JOIN ledger_events le
                        ON le.ref_kind = 'browse_event' AND le.ref_id = CAST(be.id AS TEXT)
                 WHERE browse_grep.url LIKE ?1 ESCAPE '\\'
                    OR browse_grep.title LIKE ?1 ESCAPE '\\'
                 ORDER BY be.ts DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![pat, limit], |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?;
            for row in rows {
                let (seq, _id, ts, url, title) = row?;
                let hay = format!("{title} {url}");
                if case_sensitive && !hay.contains(needle) {
                    continue;
                }
                if matcher.as_ref().is_some_and(|m| !m.is_match(&hay)) {
                    continue;
                }
                out.push(GrepHit {
                    kind: "browse".to_string(),
                    seq,
                    ts,
                    label: if title.is_empty() { url.clone() } else { title },
                    excerpt: url,
                });
            }
        }

        out.sort_by(|a, b| b.ts.cmp(&a.ts));
        out.truncate(limit as usize);
        Ok(out)
    }

    /// Substring search over the user's own margin notes — the one
    /// human-authored signal in the lake, which is why the answer pack leads
    /// with these. A plain bound LIKE is right here: `user_notes` is tiny (one
    /// row per annotated target), so an FTS index would cost more than it saves.
    /// Starred notes rank first, then most recently touched.
    pub fn search_user_notes(
        &self,
        q: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::types::UserNote>> {
        let trimmed = q.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let escaped = trimmed
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM user_notes
             WHERE text LIKE ?1 ESCAPE '\\'
             ORDER BY starred DESC, updated_at DESC, id DESC LIMIT ?2",
            Self::USER_NOTE_COLS
        ))?;
        let rows = stmt.query_map(
            params![format!("%{escaped}%"), limit.max(1)],
            Self::row_to_user_note,
        )?;
        rows.collect()
    }

    /// Class nodes whose title or summary matches a question, best guess first —
    /// how the answer pack resolves a question to a node when the caller didn't
    /// name one.
    ///
    /// This was the single highest-leverage bug in the retrieval path. It LIKEd
    /// the **entire raw query** as one `%…%` pattern, so it could only ever
    /// match a node whose title literally contained the user's whole sentence.
    /// Every question-shaped `?q=` therefore resolved NO node — verified live:
    /// `q="what did I decide about the browser tab suspension"` → `node: null`,
    /// `matchedNodes: []` — and the answer pack silently degraded to
    /// lexical-only, which reads exactly like "you never thought about this".
    /// The catalog could not improve its way out either: all 125 nodes have an
    /// empty `summary`, so even a per-token LIKE would have had only titles.
    ///
    /// Now it scores per token through `class_nodes_fts`, with three signals:
    /// `bm25(title 5, summary 1)`, a recency term on `updated_at`, and
    /// accepted-before-proposed as the tie-break. The recency term is the piece
    /// our ranking has been missing everywhere — a class the user touched last
    /// week is a better answer than one they touched in March, and no amount of
    /// term overlap says that.
    ///
    /// **Design law:** this is node RESOLUTION, and it reads only human-curated
    /// text (titles and summaries the user accepted). It never consults a lake
    /// ranking — a vector or bm25 hit on a *prompt* can never create, rename,
    /// reparent or reorder a class. The arms decide what you read; the tree
    /// decides what things are.
    pub fn match_class_nodes(
        &self,
        q: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<polis_core::types::ClassNode>> {
        use polis_core::query::MatchStage;
        let Some(plan) = polis_core::query::plan_fts_query(q) else {
            return Ok(Vec::new());
        };
        let conn = self.conn();
        let now = polis_core::ledger::now_millis();
        for stage in [MatchStage::And, MatchStage::Or] {
            let Some(match_q) = plan.match_for(stage) else { continue };
            if match_q.is_empty() {
                continue;
            }
            let mut stmt = conn.prepare(
                // bm25 is negative-is-better in FTS5, so it is negated into a
                // score that sorts DESC with the recency bonus. The 0.2 weight
                // is deliberately small: recency breaks ties between comparable
                // matches, it does not outrank relevance.
                // NOT aliased: FTS5 rejects a table alias on both sides of
                // `MATCH` and in the auxiliary functions, with a "no such
                // column" that reads like a typo.
                "SELECT n.id, n.parent_id, n.kind, n.title, n.summary, n.project_path,
                        n.ip_name, n.status, n.pinned, n.curated_by, n.created_at, n.updated_at
                 FROM class_nodes_fts
                 JOIN class_nodes n ON n.rowid = class_nodes_fts.rowid
                 WHERE class_nodes_fts MATCH ?1
                 ORDER BY (-bm25(class_nodes_fts, 5.0, 1.0)
                           + 0.2 * MAX(0.0, 1.0 - (?2 - n.updated_at) / 2592000000.0)
                           + CASE WHEN n.status = 'accepted' THEN 0.1 ELSE 0.0 END) DESC,
                          LENGTH(n.title) ASC
                 LIMIT ?3",
            )?;
            let rows: Vec<polis_core::types::ClassNode> = stmt
                .query_map(params![match_q, now, limit.max(1)], Self::row_to_class_node)?
                .collect::<rusqlite::Result<_>>()?;
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
        Ok(Vec::new())
    }
}

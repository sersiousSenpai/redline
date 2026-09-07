// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The portable one-way markdown mirror of the lake. Lifted from Redline's `mirror.rs` in Session A5; the directory and high-water settings live in `polis_meta`.

#[allow(unused_imports)]
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
#[allow(unused_imports)]
use std::path::{Path, PathBuf};

#[allow(unused_imports)]
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use serde_json::Value;

#[allow(unused_imports)]
use polis_core::coldness::{auto_collapse_safe, subtree_stats, BranchStat, LakeEnvelope};
#[allow(unused_imports)]
use polis_core::ledger::{now_millis, EventKind, LedgerEventRow};
#[allow(unused_imports)]
use polis_core::pack::*;
#[allow(unused_imports)]
use polis_core::proposal::{parse_proposals, parse_supersede_verdicts, Proposal, SupersedeVerdict, SUPERSEDE_CONFIDENCE_MIN};
#[allow(unused_imports)]
use polis_core::types::*;
#[allow(unused_imports)]
use polis_store::record::{record_curate, record_reorg, revert_link, DecisionInput};
#[allow(unused_imports)]
use polis_store::PolisStore;

#[allow(unused_imports)]
use crate::agent::{run_classifier, run_keeper_summarizer};
#[allow(unused_imports)]
use crate::organize::AUTO_APPLY_KEY;
use crate::Polis;

/// The setting key holding the user-chosen mirror directory. Absent/empty ⇒ the
/// mirror is OFF (nothing is written until a directory is chosen).
pub const MIRROR_DIR_SETTING: &str = "polis.mirror.dir";

/// The setting key tracking the highest seq already mirrored (incremental sync
/// floor). Reset to 0 whenever the directory changes.
pub const MIRROR_LAST_SEQ_SETTING: &str = "polis.mirror.lastSeq";

/// How many events one sync pass drains at most (keeps a first sync over a long
/// history bounded per call; the caller loops until drained).
pub const MIRROR_BATCH: i64 = 2000;

/// Redline-owned subdirectories under the mirror root. Rebuild clears ONLY
/// these, never the user's own vault files elsewhere in the directory.
pub const MANAGED_DIRS: [&str; 4] = ["sessions", "missions", "unfiled", "notes"];

/// Sanitize an id into a single safe path segment (no separators / control /
/// dot-only), so a hostile session/mission id can't escape the mirror root.
pub fn safe_segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.').trim();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn opt(s: &Option<String>) -> &str {
    s.as_deref().filter(|v| !v.is_empty()).unwrap_or("-")
}

/// Build the note for one enriched event. Pure + deterministic — the event's
/// own `ts`/`seq` are used, never wall-clock. `body` is the resolved body
/// (prompt text or revision markdown) already snapshotted by the caller.
pub fn note_for(row: &MirrorRow, body: Option<&str>) -> MirrorNote {
    let e = &row.event;
    // File under sessions/<id>, else — memory-by-session — under the PARENT
    // session a session-less thread hangs beneath, else missions/<id>, else
    // unfiled/. Deterministic from the row alone, so rebuilds stay stable.
    let rel_path = if let Some(sid) = e.session_id.as_deref().filter(|s| !s.is_empty()) {
        format!("sessions/{}/{:06}-{}.md", safe_segment(sid), e.seq, e.kind)
    } else if let Some(par) = row.parent_session_id.as_deref().filter(|s| !s.is_empty()) {
        format!("sessions/{}/{:06}-{}.md", safe_segment(par), e.seq, e.kind)
    } else if let Some(mid) = row.mission_id.as_deref().filter(|s| !s.is_empty()) {
        format!("missions/{}/{:06}-{}.md", safe_segment(mid), e.seq, e.kind)
    } else {
        format!("unfiled/{:06}-{}.md", e.seq, e.kind)
    };

    let mut c = String::new();
    c.push_str("---\n");
    c.push_str(&format!("entry_hash: {}\n", e.entry_hash));
    c.push_str(&format!("seq: {}\n", e.seq));
    c.push_str(&format!("kind: {}\n", e.kind));
    c.push_str(&format!("author: {}\n", e.author));
    c.push_str(&format!("surface: {}\n", opt(&row.surface)));
    c.push_str(&format!("origin: {}\n", opt(&row.origin)));
    c.push_str(&format!("role: {}\n", opt(&row.role)));
    c.push_str(&format!("session: {}\n", e.session_id.as_deref().unwrap_or("-")));
    c.push_str(&format!("mission: {}\n", opt(&row.mission_id)));
    // Memory-by-session lineage — derived (never hashed), safe to extend.
    c.push_str(&format!(
        "thread: {}\n",
        match (row.thread_kind.as_deref(), row.thread_id.as_deref()) {
            (Some(k), Some(id)) if !k.is_empty() && !id.is_empty() => format!("{k}:{id}"),
            _ => "-".to_string(),
        }
    ));
    c.push_str(&format!("parent: {}\n", opt(&row.parent_session_id)));
    c.push_str(&format!("project: {}\n", opt(&row.project_path)));
    c.push_str(&format!("ts: {}\n", e.ts));
    c.push_str("---\n\n");
    c.push_str(&format!("# {} · seq {}\n\n", e.kind, e.seq));

    match body {
        Some(b) if !b.is_empty() => {
            c.push_str(b);
            if !b.ends_with('\n') {
                c.push('\n');
            }
        }
        _ => {
            // Decision/curation events reference a row rather than owning a body.
            c.push_str(&format!(
                "_A `{}` decision/curation event referencing {} `{}`._\n\npayload_hash: `{}`\n",
                e.kind,
                e.ref_kind.as_deref().unwrap_or("-"),
                e.ref_id.as_deref().unwrap_or("-"),
                e.payload_hash,
            ));
        }
    }
    MirrorNote { rel_path, content: c }
}

/// The live markdown file for one `user_notes` row (Second Brain P3). Unlike
/// event notes — one immutable file per ledger event — a user note row is
/// EDITABLE, so its file mirrors the row's CURRENT state and is rewritten
/// whenever a `note` event passes a sync. Derived purely from the row, so
/// incremental sync and a from-scratch rebuild still produce identical bytes
/// (both read the same rows); the per-act history stays in the event files.
pub fn note_row_file(n: &polis_core::types::UserNote) -> MirrorNote {
    let mut c = String::new();
    c.push_str("---\n");
    c.push_str(&format!("note_id: {}\n", n.id));
    c.push_str(&format!(
        "target: {}\n",
        match n.target_id.as_deref() {
            Some(id) => format!("{} {}", n.target_kind, id),
            None => "standalone".to_string(),
        }
    ));
    c.push_str(&format!("starred: {}\n", n.starred));
    c.push_str(&format!("seq: {}\n", n.seq.map(|s| s.to_string()).unwrap_or("-".into())));
    c.push_str(&format!("created: {}\n", n.created_at));
    c.push_str(&format!("updated: {}\n", n.updated_at));
    c.push_str("---\n\n");
    c.push_str(&format!("# note {}{}\n\n", n.id, if n.starred { " ★" } else { "" }));
    if !n.text.is_empty() {
        c.push_str(&n.text);
        if !n.text.ends_with('\n') {
            c.push('\n');
        }
    }
    MirrorNote {
        rel_path: format!("notes/note-{:06}.md", n.id),
        content: c,
    }
}

/// Collect the notes for every event with `seq > since_seq` (ascending). Reads
/// the DB; joins revision bodies at write time. Deterministic given the ledger.
/// Returns `(notes, max_seq_seen)`.
pub fn collect_notes(polis: &Polis<'_>, since_seq: i64) -> Result<(Vec<MirrorNote>, i64), String> {
    let db = polis.store;
    let mut notes = Vec::new();
    let mut cursor = since_seq;
    let mut max_seq = since_seq;
    let mut saw_user_note = false;
    loop {
        let rows = db
            .list_mirror_events(cursor, MIRROR_BATCH)
            .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            break;
        }
        for row in &rows {
            let e = &row.event;
            let body: Option<String> = if e.kind == "prompt" {
                row.body.clone()
            } else if e.kind == "revision" {
                match (e.session_id.as_deref(), e.version_number) {
                    (Some(sid), Some(ver)) => polis.revision_markdown(sid, ver).ok().flatten(),
                    _ => None,
                }
            } else {
                saw_user_note |= e.kind == "note";
                None
            };
            notes.push(note_for(row, body.as_deref()));
            max_seq = max_seq.max(e.seq);
        }
        cursor = rows.last().map(|r| r.event.seq).unwrap_or(cursor);
        if (rows.len() as i64) < MIRROR_BATCH {
            break;
        }
    }
    // Any `note` act in the drained range means some row changed — regenerate
    // every row file (notes are few; rewriting identical bytes is a no-op).
    // Every row change appends an event, so this can never miss an edit.
    if saw_user_note {
        for n in db.list_user_notes(false, i64::MAX).map_err(|e| e.to_string())? {
            notes.push(note_row_file(&n));
        }
    }
    Ok((notes, max_seq))
}

/// Write a top-level README so anyone opening the directory understands what it
/// is (and that it's regenerable / one-way). Constant content ⇒ deterministic.
pub fn ensure_scaffold(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let readme = root.join("README.md");
    let content = "# Redline memory mirror\n\n\
        This directory is a **one-way, regenerable** plain-markdown mirror of \
        Redline's append-only prompt/decision ledger. Each note is one ledger \
        event (frontmatter carries its `entry_hash`, `seq`, `kind`, `author`, \
        `surface`, session/mission, project).\n\n\
        - Redline **writes** here; it never reads your edits back. Edit freely — \
        your changes won't corrupt the ledger, but they also won't flow back.\n\
        - Everything under `sessions/`, `missions/`, `unfiled/`, and `notes/` \
        is Redline-managed and reproduced exactly by **Rebuild mirror** \
        (`notes/` holds your own margin notes' CURRENT text; their edit \
        history lives in the per-event files).\n\
        - Any Obsidian vault (or any tool) can open this folder directly — it's \
        just markdown.\n";
    // Idempotent: only write if missing or changed, so a rebuild stays stable.
    let need = std::fs::read_to_string(&readme).map(|c| c != content).unwrap_or(true);
    if need {
        std::fs::write(&readme, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Write notes to disk under `root`, creating parent dirs. Idempotent per note
/// (same bytes ⇒ no-op churn is fine). Returns how many were written.
pub fn write_notes(root: &Path, notes: &[MirrorNote]) -> Result<usize, String> {
    for note in notes {
        let path = root.join(&note.rel_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &note.content).map_err(|e| e.to_string())?;
    }
    Ok(notes.len())
}

/// Incremental sync: write notes for events past `since_seq`. Returns the new
/// high-water seq. The append-only ledger means this only ever adds notes, so
/// it converges to exactly what `rebuild` produces.
pub fn sync(root: &Path, polis: &Polis<'_>, since_seq: i64) -> Result<i64, String> {
    ensure_scaffold(root)?;
    let (notes, max_seq) = collect_notes(polis, since_seq)?;
    write_notes(root, &notes)?;
    Ok(max_seq)
}

/// Full rebuild: clear the managed subdirs and re-derive every note from the
/// ledger. The recovery path if a mirror ever drifts (and the determinism
/// anchor — its output must match incremental sync byte-for-byte).
pub fn rebuild(root: &Path, polis: &Polis<'_>) -> Result<i64, String> {
    for dir in MANAGED_DIRS {
        let _ = std::fs::remove_dir_all(root.join(dir));
    }
    sync(root, polis, 0)
}

/// Count `.md` notes currently under the managed subdirs (for status).
pub fn count_notes(root: &Path) -> usize {
    fn walk(dir: &Path, n: &mut usize) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, n);
                } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                    *n += 1;
                }
            }
        }
    }
    let mut n = 0;
    for dir in MANAGED_DIRS {
        walk(&root.join(dir), &mut n);
    }
    n
}

/// The configured mirror directory, or `None` when off.
pub fn mirror_dir(polis: &Polis<'_>) -> Option<PathBuf> {
    polis.get_setting(MIRROR_DIR_SETTING)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

/// Read the incremental high-water seq (0 if unset/unparsable).
pub fn last_seq(polis: &Polis<'_>) -> i64 {
    polis.get_setting(MIRROR_LAST_SEQ_SETTING)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

/// Continuous entry point: if a mirror dir is configured, sync any new events
/// and persist the new high-water seq. Best-effort (logs, never propagates) so
/// it can be called from a timer / after ingest without ever blocking the app.
/// No-op when the mirror is off. Returns the number of events newly mirrored.
pub fn sync_if_enabled(polis: &Polis<'_>) -> i64 {
    let Some(root) = mirror_dir(polis) else {
        return 0;
    };
    let from = last_seq(polis);
    match sync(&root, polis, from) {
        Ok(new_max) => {
            if new_max > from {
                let _ = polis.set_setting(MIRROR_LAST_SEQ_SETTING, &new_max.to_string());
            }
            (new_max - from).max(0)
        }
        Err(e) => {
            tracing::warn!(error = %e, "mirror sync failed");
            0
        }
    }
}

/// Point the mirror at `dir` (empty ⇒ turn it off). Resets the high-water seq
/// and does a full sync so the directory immediately reflects the whole ledger.
pub fn set_dir(polis: &Polis<'_>, dir: &str) -> Result<MirrorStatus, String> {
    let trimmed = dir.trim();
    polis.set_setting(MIRROR_DIR_SETTING, trimmed).map_err(|e| e.to_string())?;
    polis.set_setting(MIRROR_LAST_SEQ_SETTING, "0").map_err(|e| e.to_string())?;
    if !trimmed.is_empty() {
        let max = sync(Path::new(trimmed), polis, 0)?;
        polis.set_setting(MIRROR_LAST_SEQ_SETTING, &max.to_string())
            .map_err(|e| e.to_string())?;
    }
    Ok(status(polis))
}

/// Rebuild the configured mirror from scratch (recovery / determinism anchor).
pub fn rebuild_configured(polis: &Polis<'_>) -> Result<MirrorStatus, String> {
    let root = mirror_dir(polis).ok_or("no mirror directory is configured")?;
    let max = rebuild(&root, polis)?;
    polis.set_setting(MIRROR_LAST_SEQ_SETTING, &max.to_string())
        .map_err(|e| e.to_string())?;
    Ok(status(polis))
}

/// A single mirror note: a relative path under the mirror root + its full
/// content. Pure data — `write_notes` is the only thing that touches disk.
#[derive(Debug, Clone, PartialEq)]
pub struct MirrorNote {
    pub rel_path: String,
    pub content: String,
}

/// Live status of the mirror, for the settings surface.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    /// The chosen directory, or `None` when the mirror is off.
    pub dir: Option<String>,
    pub enabled: bool,
    /// Highest seq mirrored so far.
    pub last_seq: i64,
    /// Total ledger events (so the UI can show "N of M mirrored").
    pub total_events: i64,
    /// Count of `.md` notes currently on disk under the managed subdirs.
    pub note_count: usize,
}

/// Snapshot the mirror status for the settings surface.
pub fn status(polis: &Polis<'_>) -> MirrorStatus {
    let db = polis.store;
    let dir = mirror_dir(polis);
    let note_count = dir.as_deref().map(count_notes).unwrap_or(0);
    MirrorStatus {
        dir: dir.map(|p| p.to_string_lossy().to_string()),
        enabled: polis.get_setting(MIRROR_DIR_SETTING)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        last_seq: last_seq(polis),
        total_events: db.max_ledger_seq().unwrap_or(0),
        note_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_segment_neutralizes_traversal() {
        let seg = safe_segment("../../etc/passwd");
        assert!(!seg.contains('/'), "no path separators survive");
        assert!(!seg.contains(".."), "no traversal survives");
        assert!(seg.ends_with("etc_passwd"));
        assert_eq!(safe_segment("normal-id_1"), "normal-id_1");
        // Dot-only maps each dot to `_` — safe (no traversal), never empty.
        assert_eq!(safe_segment("..."), "___");
    }
}

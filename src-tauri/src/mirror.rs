// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Portable memory **mirror** (Phase 4): a continuous, one-way writer that
//! renders every ledger event as a plain-markdown note in a user-chosen
//! directory, filed per session / mission.
//!
//! Design invariants (each is load-bearing):
//! - **One-way only.** Redline writes; it never reads vault edits back. So a
//!   note diverging from the ledger can only mean the vault was hand-edited —
//!   `ledger_verify` stays the source of truth, and "Rebuild mirror"
//!   re-derives the whole directory from the ledger.
//! - **Fully regenerable.** Bodies are snapshotted into each note at write time
//!   (prompt body / revision markdown joined then), so a note is a complete,
//!   standalone artifact — and a rebuild reproduces byte-identical output.
//! - **Deterministic.** No wall-clock, no randomness in a note: the event's own
//!   `ts` and `seq` are used. Same ledger → byte-identical directory, and an
//!   incremental sync converges to exactly what a from-scratch rebuild produces.
//! - **Zero Obsidian-specific code.** Notes are YAML-frontmatter + CommonMark,
//!   nothing more. An Obsidian vault opened on the directory "just works"
//!   because plain markdown is the whole contract — the 6/29 deleted
//!   Obsidian-integration mistake is structurally impossible to recur here.

use std::path::{Path, PathBuf};

use crate::db::Database;
use crate::ledger::LedgerEventRow;

/// The setting key holding the user-chosen mirror directory. Absent/empty ⇒ the
/// mirror is OFF (nothing is written until a directory is chosen).
pub const MIRROR_DIR_SETTING: &str = "redline.mirrorDir";
/// The setting key tracking the highest seq already mirrored (incremental sync
/// floor). Reset to 0 whenever the directory changes.
pub const MIRROR_LAST_SEQ_SETTING: &str = "redline.mirror.lastSeq";

/// How many events one sync pass drains at most (keeps a first sync over a long
/// history bounded per call; the caller loops until drained).
pub const MIRROR_BATCH: i64 = 2000;

/// Redline-owned subdirectories under the mirror root. Rebuild clears ONLY
/// these, never the user's own vault files elsewhere in the directory.
const MANAGED_DIRS: [&str; 3] = ["sessions", "missions", "unfiled"];

/// A ledger event enriched with its prompt provenance + full body, as read by
/// `Database::list_mirror_events`. `body` is the full prompt body for prompt
/// events; `None` for revision/decision events (the writer fills revision
/// bodies from `revisions.raw_plan_markdown`).
#[derive(Debug, Clone)]
pub struct MirrorRow {
    pub event: LedgerEventRow,
    pub surface: Option<String>,
    pub origin: Option<String>,
    pub role: Option<String>,
    pub mission_id: Option<String>,
    pub project_path: Option<String>,
    pub body: Option<String>,
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

/// Sanitize an id into a single safe path segment (no separators / control /
/// dot-only), so a hostile session/mission id can't escape the mirror root.
fn safe_segment(id: &str) -> String {
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

fn opt(s: &Option<String>) -> &str {
    s.as_deref().filter(|v| !v.is_empty()).unwrap_or("-")
}

/// Build the note for one enriched event. Pure + deterministic — the event's
/// own `ts`/`seq` are used, never wall-clock. `body` is the resolved body
/// (prompt text or revision markdown) already snapshotted by the caller.
pub fn note_for(row: &MirrorRow, body: Option<&str>) -> MirrorNote {
    let e = &row.event;
    // File under sessions/<id>, else missions/<id>, else unfiled/.
    let rel_path = if let Some(sid) = e.session_id.as_deref().filter(|s| !s.is_empty()) {
        format!("sessions/{}/{:06}-{}.md", safe_segment(sid), e.seq, e.kind)
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

/// Collect the notes for every event with `seq > since_seq` (ascending). Reads
/// the DB; joins revision bodies at write time. Deterministic given the ledger.
/// Returns `(notes, max_seq_seen)`.
pub fn collect_notes(db: &Database, since_seq: i64) -> Result<(Vec<MirrorNote>, i64), String> {
    let mut notes = Vec::new();
    let mut cursor = since_seq;
    let mut max_seq = since_seq;
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
                    (Some(sid), Some(ver)) => db.revision_markdown(sid, ver).ok().flatten(),
                    _ => None,
                }
            } else {
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
    Ok((notes, max_seq))
}

/// Write a top-level README so anyone opening the directory understands what it
/// is (and that it's regenerable / one-way). Constant content ⇒ deterministic.
fn ensure_scaffold(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let readme = root.join("README.md");
    let content = "# Redline memory mirror\n\n\
        This directory is a **one-way, regenerable** plain-markdown mirror of \
        Redline's append-only prompt/decision ledger. Each note is one ledger \
        event (frontmatter carries its `entry_hash`, `seq`, `kind`, `author`, \
        `surface`, session/mission, project).\n\n\
        - Redline **writes** here; it never reads your edits back. Edit freely — \
        your changes won't corrupt the ledger, but they also won't flow back.\n\
        - Everything under `sessions/`, `missions/`, and `unfiled/` is \
        Redline-managed and reproduced exactly by **Rebuild mirror**.\n\
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
pub fn sync(root: &Path, db: &Database, since_seq: i64) -> Result<i64, String> {
    ensure_scaffold(root)?;
    let (notes, max_seq) = collect_notes(db, since_seq)?;
    write_notes(root, &notes)?;
    Ok(max_seq)
}

/// Full rebuild: clear the managed subdirs and re-derive every note from the
/// ledger. The recovery path if a mirror ever drifts (and the determinism
/// anchor — its output must match incremental sync byte-for-byte).
pub fn rebuild(root: &Path, db: &Database) -> Result<i64, String> {
    for dir in MANAGED_DIRS {
        let _ = std::fs::remove_dir_all(root.join(dir));
    }
    sync(root, db, 0)
}

/// Count `.md` notes currently under the managed subdirs (for status).
fn count_notes(root: &Path) -> usize {
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
pub fn mirror_dir(db: &Database) -> Option<PathBuf> {
    db.get_setting(MIRROR_DIR_SETTING)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

/// Read the incremental high-water seq (0 if unset/unparsable).
fn last_seq(db: &Database) -> i64 {
    db.get_setting(MIRROR_LAST_SEQ_SETTING)
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

/// Continuous entry point: if a mirror dir is configured, sync any new events
/// and persist the new high-water seq. Best-effort (logs, never propagates) so
/// it can be called from a timer / after ingest without ever blocking the app.
/// No-op when the mirror is off. Returns the number of events newly mirrored.
pub fn sync_if_enabled(db: &Database) -> i64 {
    let Some(root) = mirror_dir(db) else {
        return 0;
    };
    let from = last_seq(db);
    match sync(&root, db, from) {
        Ok(new_max) => {
            if new_max > from {
                let _ = db.set_setting(MIRROR_LAST_SEQ_SETTING, &new_max.to_string());
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
pub fn set_dir(db: &Database, dir: &str) -> Result<MirrorStatus, String> {
    let trimmed = dir.trim();
    db.set_setting(MIRROR_DIR_SETTING, trimmed).map_err(|e| e.to_string())?;
    db.set_setting(MIRROR_LAST_SEQ_SETTING, "0").map_err(|e| e.to_string())?;
    if !trimmed.is_empty() {
        let max = sync(Path::new(trimmed), db, 0)?;
        db.set_setting(MIRROR_LAST_SEQ_SETTING, &max.to_string())
            .map_err(|e| e.to_string())?;
    }
    Ok(status(db))
}

/// Rebuild the configured mirror from scratch (recovery / determinism anchor).
pub fn rebuild_configured(db: &Database) -> Result<MirrorStatus, String> {
    let root = mirror_dir(db).ok_or("no mirror directory is configured")?;
    let max = rebuild(&root, db)?;
    db.set_setting(MIRROR_LAST_SEQ_SETTING, &max.to_string())
        .map_err(|e| e.to_string())?;
    Ok(status(db))
}

/// Snapshot the mirror status for the settings surface.
pub fn status(db: &Database) -> MirrorStatus {
    let dir = mirror_dir(db);
    let note_count = dir.as_deref().map(count_notes).unwrap_or(0);
    MirrorStatus {
        dir: dir.map(|p| p.to_string_lossy().to_string()),
        enabled: db
            .get_setting(MIRROR_DIR_SETTING)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false),
        last_seq: last_seq(db),
        total_events: db.max_ledger_seq().unwrap_or(0),
        note_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn tmpdir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("redline-mirror-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn seed(db: &Database, n: usize) {
        db.upsert_session(&crate::state::ReviewSession {
            session_id: "sess1".into(),
            project_path: "/repo".into(),
            project_name: "repo".into(),
            created_at: 1,
            revisions: vec![],
            status: crate::state::SessionStatus::InReview,
            attach_state: crate::state::AttachState::Idle,
            updated_at: 1,
        })
        .unwrap();
        for i in 0..n {
            crate::ledger::record_prompt(
                db,
                crate::ledger::PromptInput {
                    source: crate::ledger::PromptSource::Hook,
                    origin: crate::ledger::Origin::Redline,
                    surface: "pty_plan".into(),
                    role: None,
                    session_id: Some("sess1".into()),
                    claude_session_id: Some(format!("cs{i}")),
                    mission_id: None,
                    project_path: Some("/repo".into()),
                    body: format!("prompt body {i}"),
                },
            )
            .unwrap();
        }
        db.insert_revision(
            "sess1",
            &crate::state::Revision {
                version_number: 1,
                received_at: 1,
                raw_plan_markdown: "# Plan\n\nthe body".into(),
                sections: vec![],
                comments: vec![],
                thread_start: false,
                restored: false,
            },
        )
        .unwrap();
        crate::ledger::record_revision_event(db, "sess1", 1, "# Plan\n\nthe body").unwrap();
    }

    /// Read every file under a dir into a path→content map (relative paths).
    fn read_tree(root: &Path) -> BTreeMap<String, String> {
        fn walk(root: &Path, dir: &Path, map: &mut BTreeMap<String, String>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(root, &p, map);
                    } else {
                        let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
                        map.insert(rel, std::fs::read_to_string(&p).unwrap());
                    }
                }
            }
        }
        let mut map = BTreeMap::new();
        walk(root, root, &mut map);
        map
    }

    #[test]
    fn note_is_deterministic_and_files_by_session() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, 1);
        let (a, _) = collect_notes(&db, 0).unwrap();
        let (b, _) = collect_notes(&db, 0).unwrap();
        assert_eq!(a, b, "same ledger → identical notes");
        assert!(a[0].rel_path.starts_with("sessions/sess1/"));
        assert!(a[0].content.contains("kind: prompt"));
        assert!(a[0].content.contains("prompt body 0"));
        // The revision note snapshots the markdown body.
        let rev = a.iter().find(|n| n.content.contains("kind: revision")).unwrap();
        assert!(rev.content.contains("the body"));
    }

    #[test]
    fn rebuild_matches_incremental_byte_for_byte() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, 2); // 2 prompts + 1 revision = 3 events

        // Incremental: sync the first slice, add more, sync again.
        let inc = tmpdir("inc");
        let first = sync(&inc, &db, 0).unwrap();
        // Add a fourth event, then incrementally sync only the new tail.
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "browse".into(),
                role: None,
                session_id: None,
                claude_session_id: Some("cs-late".into()),
                mission_id: Some("m1".into()),
                project_path: None,
                body: "a mission prompt".into(),
            },
        )
        .unwrap();
        sync(&inc, &db, first).unwrap();

        // From-scratch rebuild of the same final ledger.
        let reb = tmpdir("reb");
        rebuild(&reb, &db).unwrap();

        assert_eq!(
            read_tree(&inc),
            read_tree(&reb),
            "incremental output must equal a from-scratch rebuild"
        );
        // And the mission prompt landed under missions/.
        assert!(read_tree(&reb).keys().any(|k| k.starts_with("missions/m1/")));

        let _ = std::fs::remove_dir_all(&inc);
        let _ = std::fs::remove_dir_all(&reb);
    }

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

    #[test]
    fn mirror_off_until_a_dir_is_chosen() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, 1);
        assert_eq!(sync_if_enabled(&db), 0, "no dir → no-op");
        let st = status(&db);
        assert!(!st.enabled);
        assert!(st.dir.is_none());
    }

    #[test]
    fn set_dir_populates_then_tracks_incrementally() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, 2);
        let dir = tmpdir("setdir");
        let st = set_dir(&db, &dir.to_string_lossy()).unwrap();
        assert!(st.enabled);
        assert_eq!(st.last_seq, 3, "all 3 events mirrored on set");
        // A new event is picked up by the continuous sync.
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty_plan".into(),
                role: None,
                session_id: Some("sess1".into()),
                claude_session_id: Some("cs-new".into()),
                mission_id: None,
                project_path: Some("/repo".into()),
                body: "a later prompt".into(),
            },
        )
        .unwrap();
        assert_eq!(sync_if_enabled(&db), 1, "one new event mirrored");
        assert_eq!(status(&db).last_seq, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

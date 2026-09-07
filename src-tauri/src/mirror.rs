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

#[cfg(test)]
use std::path::{Path, PathBuf};

use crate::db::Database;

#[allow(unused_imports)]
pub use polis_memory::mirror::{MirrorNote, MirrorStatus, MANAGED_DIRS, MIRROR_BATCH, MIRROR_DIR_SETTING, MIRROR_LAST_SEQ_SETTING, ensure_scaffold, note_for, note_row_file, safe_segment, write_notes};

/// Test-only shim (Session A5): the note collector the sync/rebuild tests
/// inspect; production goes through `sync_if_enabled` / `rebuild_configured`.
#[cfg(test)]
pub fn collect_notes(db: &Database, since_seq: i64) -> Result<(Vec<MirrorNote>, i64), String> {
    polis_memory::mirror::collect_notes(&crate::polis_host::polis_for(db), since_seq)
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::sync`; this reaches it through `polis_for`.
#[cfg(test)]
pub fn sync(root: &Path, db: &Database, since_seq: i64) -> Result<i64, String> {
    polis_memory::mirror::sync(root, &crate::polis_host::polis_for(db), since_seq)
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::rebuild`; this reaches it through `polis_for`.
#[cfg(test)]
pub fn rebuild(root: &Path, db: &Database) -> Result<i64, String> {
    polis_memory::mirror::rebuild(root, &crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::status`; this reaches it through `polis_for`.
pub fn status(db: &Database) -> MirrorStatus {
    polis_memory::mirror::status(&crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::sync_if_enabled`; this reaches it through `polis_for`.
pub fn sync_if_enabled(db: &Database) -> i64 {
    polis_memory::mirror::sync_if_enabled(&crate::polis_host::polis_for(db))
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::set_dir`; this reaches it through `polis_for`.
pub fn set_dir(db: &Database, dir: &str) -> Result<MirrorStatus, String> {
    polis_memory::mirror::set_dir(&crate::polis_host::polis_for(db), dir)
}

/// Signature-preserving shim (Session A5 of the Polis extraction): the body
/// is `polis_memory::mirror::rebuild_configured`; this reaches it through `polis_for`.
pub fn rebuild_configured(db: &Database) -> Result<MirrorStatus, String> {
    polis_memory::mirror::rebuild_configured(&crate::polis_host::polis_for(db))
}

// The mirror's row type is a `polis-core` type (Session A3 of the Polis
// extraction); re-exported so `crate::mirror::MirrorRow` still resolves.
#[allow(unused_imports)]
pub use polis_core::types::MirrorRow;

#[cfg(test)]
mod tests {
    use super::*;

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
            run_state: None,
            backend: None,
            model: None,
        })
        .unwrap();
        for i in 0..n {
            crate::ledger::record_prompt(
                db,
                crate::ledger::PromptInput {
                    source: crate::ledger::PromptSource::Hook,
                    origin: crate::ledger::Origin::Redline,
                    surface: "pty_plan".into(),
                    role: crate::ledger::CorpusRole::User,
                    user_text: None,
                    session_id: Some("sess1".into()),
                    claude_session_id: Some(format!("cs{i}")),
                    mission_id: None,
                    project_path: Some("/repo".into()),
                    body: format!("prompt body {i}"),
                    thread: None,
                    author: None,
                model: None,
                    model_source: None,
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
        crate::ledger::record_revision_event(db, "sess1", 1, "# Plan\n\nthe body", None).unwrap();
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
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some("cs-late".into()),
                mission_id: Some("m1".into()),
                project_path: None,
                body: "a mission prompt".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
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
    fn user_note_rows_mirror_as_live_files_and_stay_deterministic() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, 1);

        // Incremental: sync, then note + star + edit, then sync the tail.
        let inc = tmpdir("note-inc");
        let first = sync(&inc, &db, 0).unwrap();
        let write = |text: Option<&str>, starred: Option<bool>| {
            let out = db
                .write_user_note(
                    &crate::context::NoteWrite {
                        note_id: None,
                        target_kind: Some("ledger_event".into()),
                        target_id: Some("1".into()),
                        text: text.map(str::to_string),
                        starred,
                    },
                    "human",
                )
                .unwrap();
            match out {
                crate::context::NoteOutcome::Written(n) => n,
                other => panic!("expected Written, got {other:?}"),
            }
        };
        let n = write(Some("first thought"), None);
        write(None, Some(true));
        write(Some("sharper thought"), None);
        sync(&inc, &db, first).unwrap();

        // The row file exists once, carries the CURRENT text + star.
        let tree = read_tree(&inc);
        let rel = format!("notes/note-{:06}.md", n.id);
        let content = tree.get(&rel).expect("note row file mirrored");
        assert!(content.contains("sharper thought"));
        assert!(!content.contains("first thought"), "row file is current state, not history");
        assert!(content.contains("starred: true"));
        assert!(content.contains("target: ledger_event 1"));

        // The mutable row does not break the determinism anchor.
        let reb = tmpdir("note-reb");
        rebuild(&reb, &db).unwrap();
        assert_eq!(
            read_tree(&inc),
            read_tree(&reb),
            "incremental with note edits must equal a from-scratch rebuild"
        );

        let _ = std::fs::remove_dir_all(&inc);
        let _ = std::fs::remove_dir_all(&reb);
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
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("sess1".into()),
                claude_session_id: Some("cs-new".into()),
                mission_id: None,
                project_path: Some("/repo".into()),
                body: "a later prompt".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
        assert_eq!(sync_if_enabled(&db), 1, "one new event mirrored");
        assert_eq!(status(&db).last_seq, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

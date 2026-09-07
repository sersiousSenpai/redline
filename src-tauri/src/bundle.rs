// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Verifiable **context export bundle** (Phase 4): a self-contained JSON blob
//! that carries a slice of the ledger — its hash-chained events, the bodies
//! those events reference, and (for class/full scope) the ClassMemory subtree —
//! pinned to the ledger `head_hash` at export time.
//!
//! The bundle is the **memory-handoff unit**: another agent, harness, or user
//! can ingest it, and — crucially — **re-verify it from the bundle alone**.
//! `verify_bundle` recomputes each event's `entry_hash = sha256(prev_hash ‖
//! canonical(event))` exactly as the live ledger does, so tampering with any
//! bundled body/author/ref is detectable without touching Redline. A *full*
//! bundle additionally re-walks the chain genesis→head and confirms the
//! recomputed head equals the pinned `head_hash`.
//!
//! One-way and derivative: a bundle is a *copy* of ledger content, never a
//! source of truth. The ledger (and its `VACUUM INTO` snapshots) remain the
//! crown jewels; this is a portable, independently-checkable extract.

use crate::classmem::{ClassLink, ClassNode};
use crate::db::Database;
use crate::ledger::{now_millis, LedgerEventRow, GENESIS_PREV};

// The bundle format and its verifier live in `polis-core` (Session A1 of the
// Polis extraction, docs/polis-extraction.md): a bundle verifies without
// SQLite. Re-exported so every `crate::bundle::…` call site is unchanged.
// `#[allow(unused_imports)]`: a shim re-exports for PATH STABILITY, not for use
// inside this module — what nothing here touches still has call sites elsewhere
// (or in tests), and the lint cannot see across cfgs.
#[allow(unused_imports)]
pub use polis_core::bundle::{
    verify_bundle, BundleNote, BundlePrompt, BundleRevision, BundleScope, BundleTree,
    BundleVerdict, ContextBundle, BUNDLE_SCHEMA,
};

/// Build a bundle for `scope`. Bodies are joined at build time (prompt →
/// `prompts.body`, revision → `revisions.raw_plan_markdown`); decision events
/// reference a row and carry no body. Pure read; ordering is deterministic.
pub fn build_bundle(db: &Database, scope: &BundleScope) -> Result<ContextBundle, String> {
    // The pinned head — the authoritative ledger head at export time.
    let head_hash = db
        .verify_ledger_chain()
        .map_err(|e| e.to_string())?
        .head_hash
        .unwrap_or_else(|| GENESIS_PREV.to_string());

    // Everything ascending; filter to scope. A long history is bounded by the
    // ledger's own size — an export is an explicit, user-driven action.
    let all = db
        .list_ledger_events_asc(0, i64::MAX)
        .map_err(|e| e.to_string())?;

    // Resolve which events belong to this scope, and (for class) the tree.
    let (mut events, tree): (Vec<LedgerEventRow>, BundleTree) = match scope {
        BundleScope::Full => (all, full_tree(db)?),
        BundleScope::Session(sid) => (
            all.into_iter()
                .filter(|e| e.session_id.as_deref() == Some(sid.as_str()))
                .collect(),
            BundleTree::default(),
        ),
        BundleScope::Mission(mid) => {
            let ids: std::collections::HashSet<i64> =
                db.mission_prompt_ids(mid).map_err(|e| e.to_string())?.into_iter().collect();
            (
                all.into_iter()
                    .filter(|e| e.prompt_id.map(|id| ids.contains(&id)).unwrap_or(false))
                    .collect(),
                BundleTree::default(),
            )
        }
        BundleScope::Class(root) => {
            let (tree, keep) = class_scope(db, root)?;
            (
                all.into_iter().filter(|e| keep.matches(e)).collect(),
                tree,
            )
        }
    };

    events.sort_by_key(|e| e.seq);

    // Join bodies for the events actually in the bundle.
    let mut prompts: Vec<BundlePrompt> = Vec::new();
    let mut seen_prompt = std::collections::HashSet::new();
    let mut revisions: Vec<BundleRevision> = Vec::new();
    let mut seen_rev = std::collections::HashSet::new();
    for e in &events {
        if e.kind == "prompt" {
            if let Some(pid) = e.prompt_id {
                if seen_prompt.insert(pid) {
                    if let Ok(Some(body)) = db.get_prompt_body(pid) {
                        prompts.push(BundlePrompt { id: pid, body });
                    }
                }
            }
        } else if e.kind == "revision" {
            if let (Some(sid), Some(ver)) = (e.session_id.as_deref(), e.version_number) {
                if seen_rev.insert((sid.to_string(), ver)) {
                    if let Ok(Some(md)) = db.revision_markdown(sid, ver) {
                        revisions.push(BundleRevision {
                            session_id: sid.to_string(),
                            version_number: ver,
                            markdown: md,
                        });
                    }
                }
            }
        }
    }
    prompts.sort_by_key(|p| p.id);
    revisions.sort_by(|a, b| a.session_id.cmp(&b.session_id).then(a.version_number.cmp(&b.version_number)));

    // User notes in scope: everything for a full export; for scoped bundles,
    // the notes ON bundled events plus (session scope) the note on the session
    // itself. Standalone thoughts travel only in full bundles — they belong to
    // no narrower slice.
    let event_seqs: std::collections::HashSet<i64> = events.iter().map(|e| e.seq).collect();
    let mut notes: Vec<BundleNote> = db
        .list_user_notes(false, i64::MAX)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|n| match scope {
            BundleScope::Full => true,
            BundleScope::Session(sid) => {
                (n.target_kind == "session" && n.target_id.as_deref() == Some(sid.as_str()))
                    || (n.target_kind == "ledger_event"
                        && n.target_id
                            .as_deref()
                            .and_then(|t| t.parse::<i64>().ok())
                            .map(|s| event_seqs.contains(&s))
                            .unwrap_or(false))
            }
            _ => {
                n.target_kind == "ledger_event"
                    && n.target_id
                        .as_deref()
                        .and_then(|t| t.parse::<i64>().ok())
                        .map(|s| event_seqs.contains(&s))
                        .unwrap_or(false)
            }
        })
        .map(|n| BundleNote {
            id: n.id,
            seq: n.seq,
            target_kind: n.target_kind,
            target_id: n.target_id,
            text: n.text,
            starred: n.starred,
            created_at: n.created_at,
            updated_at: n.updated_at,
        })
        .collect();
    notes.sort_by_key(|n| n.id);

    Ok(ContextBundle {
        schema: BUNDLE_SCHEMA.to_string(),
        scope: scope.label(),
        head_hash,
        verified_at: now_millis(),
        events,
        prompts,
        revisions,
        tree,
        notes,
    })
}

/// The full ClassMemory tree (deterministically ordered).
fn full_tree(db: &Database) -> Result<BundleTree, String> {
    let mut nodes = db.list_class_nodes().map_err(|e| e.to_string())?;
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut links: Vec<ClassLink> = Vec::new();
    for n in &nodes {
        links.extend(db.list_class_links_for_node(&n.id).unwrap_or_default());
    }
    links.sort_by_key(|l| l.id);
    Ok(BundleTree { nodes, links })
}

/// Which events a class-scoped bundle keeps, resolved from the subtree's links.
struct ClassKeep {
    prompt_ids: std::collections::HashSet<i64>,
    session_ids: std::collections::HashSet<String>,
    seqs: std::collections::HashSet<i64>,
}

impl ClassKeep {
    fn matches(&self, e: &LedgerEventRow) -> bool {
        if self.seqs.contains(&e.seq) {
            return true;
        }
        if let Some(pid) = e.prompt_id {
            if self.prompt_ids.contains(&pid) {
                return true;
            }
        }
        if let Some(sid) = e.session_id.as_deref() {
            if self.session_ids.contains(sid) {
                return true;
            }
        }
        false
    }
}

/// Build the class subtree + the event-keep set from its links.
fn class_scope(db: &Database, root: &str) -> Result<(BundleTree, ClassKeep), String> {
    let all = db.list_class_nodes().map_err(|e| e.to_string())?;
    // Ids of root + all descendants (fixpoint over parent_id).
    let mut keep_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    keep_ids.insert(root.to_string());
    loop {
        let before = keep_ids.len();
        for n in &all {
            if let Some(p) = &n.parent_id {
                if keep_ids.contains(p) {
                    keep_ids.insert(n.id.clone());
                }
            }
        }
        if keep_ids.len() == before {
            break;
        }
    }
    let mut nodes: Vec<ClassNode> = all.into_iter().filter(|n| keep_ids.contains(&n.id)).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    let mut links: Vec<ClassLink> = Vec::new();
    let mut keep = ClassKeep {
        prompt_ids: std::collections::HashSet::new(),
        session_ids: std::collections::HashSet::new(),
        seqs: std::collections::HashSet::new(),
    };
    for n in &nodes {
        for l in db.list_class_links_for_node(&n.id).unwrap_or_default() {
            match l.target_kind.as_str() {
                "prompt" => {
                    if let Ok(id) = l.target_id.parse::<i64>() {
                        keep.prompt_ids.insert(id);
                    }
                }
                "session" | "revision" => {
                    keep.session_ids.insert(l.target_id.clone());
                }
                "decision" | "ledger" => {
                    if let Ok(seq) = l.target_id.parse::<i64>() {
                        keep.seqs.insert(seq);
                    }
                }
                _ => {}
            }
            links.push(l);
        }
    }
    links.sort_by_key(|l| l.id);
    Ok((BundleTree { nodes, links }, keep))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seed a small lake: two prompts (one per session) + a revision.
    fn seed(db: &Database) {
        db.upsert_session(&crate::state::ReviewSession {
            session_id: "s1".into(),
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
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty_plan".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("s1".into()),
                claude_session_id: Some("cs1".into()),
                mission_id: None,
                project_path: Some("/repo".into()),
                body: "first prompt".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "browse".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("s2".into()),
                claude_session_id: Some("cs2".into()),
                mission_id: None,
                project_path: None,
                body: "second prompt".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
        db.insert_revision(
            "s1",
            &crate::state::Revision {
                version_number: 1,
                received_at: 1,
                raw_plan_markdown: "# Plan\n\nbody".into(),
                sections: vec![],
                comments: vec![],
                thread_start: false,
                restored: false,
            },
        )
        .unwrap();
        crate::ledger::record_revision_event(db, "s1", 1, "# Plan\n\nbody", None).unwrap();
    }

    #[test]
    fn full_bundle_reverifies_standalone_and_recomputes_head() {
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        let bundle = build_bundle(&db, &BundleScope::Full).unwrap();
        assert_eq!(bundle.events.len(), 3);
        assert_eq!(bundle.prompts.len(), 2);
        assert_eq!(bundle.revisions.len(), 1);
        let v = verify_bundle(&bundle);
        assert!(v.ok, "a fresh full bundle must verify");
        assert!(v.full_chain);
        assert_eq!(v.recomputed_head.as_ref(), Some(&bundle.head_hash));
    }

    #[test]
    fn tampering_with_a_bundled_event_is_detected() {
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        let mut bundle = build_bundle(&db, &BundleScope::Full).unwrap();
        // Forge an author on the second event without fixing its hash.
        bundle.events[1].author = "mallory".into();
        let v = verify_bundle(&bundle);
        assert!(!v.ok);
        assert_eq!(v.first_bad_seq, Some(2));
    }

    #[test]
    fn session_scope_selects_only_that_sessions_events() {
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        let bundle = build_bundle(&db, &BundleScope::Session("s1".into())).unwrap();
        // s1 has a prompt event + a revision event; s2's prompt is excluded.
        assert_eq!(bundle.events.len(), 2);
        assert!(bundle.events.iter().all(|e| e.session_id.as_deref() == Some("s1")));
        assert_eq!(bundle.prompts.len(), 1);
        assert_eq!(bundle.revisions.len(), 1);
        // A scoped bundle still self-certifies per event.
        let v = verify_bundle(&bundle);
        assert!(v.ok);
        assert!(!v.full_chain, "a subset is not a contiguous chain");
    }

    #[test]
    fn export_is_deterministic_byte_for_byte() {
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        let a = build_bundle(&db, &BundleScope::Full).unwrap();
        let b = build_bundle(&db, &BundleScope::Full).unwrap();
        // Ignore the wall-clock `verified_at`; the content ordering is stable.
        let strip = |mut x: ContextBundle| {
            x.verified_at = 0;
            serde_json::to_string(&x).unwrap()
        };
        assert_eq!(strip(a), strip(b), "same ledger → identical bundle content");
    }

    #[test]
    fn compaction_does_not_break_a_bundle_before_or_after() {
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        // A bundle built BEFORE compaction is a self-contained snapshot.
        let pre = build_bundle(&db, &BundleScope::Full).unwrap();
        assert!(verify_bundle(&pre).ok);

        // Compact one of the seeded prompts.
        let pid = db
            .list_ledger_events(10)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "prompt")
            .and_then(|e| e.prompt_id)
            .unwrap();
        db.compact_prompt_body(pid, "gist of first prompt", "cold", "agent", "keeper")
            .unwrap();

        // The already-built bundle still verifies (it carried its own bodies +
        // the chain is body-blind) — even though the compaction added a new
        // ledger event, `pre` is a frozen subset and self-certifies per event.
        assert!(verify_bundle(&pre).ok, "an already-exported bundle is immutable");

        // A freshly built bundle post-compaction also verifies; its prompt body
        // now reads as the gist.
        let post = build_bundle(&db, &BundleScope::Full).unwrap();
        assert!(verify_bundle(&post).ok, "a fresh post-compaction bundle verifies");
        assert!(post.prompts.iter().any(|p| p.body == "gist of first prompt"));
    }

    #[test]
    fn pre_note_bundle_still_verifies_after_notes_land() {
        // §7.2 — the proof `CanonicalEvent` was not disturbed by P3: a bundle
        // exported BEFORE any `note` event must verify unchanged after notes,
        // stars and standalone thoughts are written (the compaction-test
        // discipline, run across the P3 boundary).
        let db = Database::open_in_memory().unwrap();
        seed(&db);
        let pre = build_bundle(&db, &BundleScope::Full).unwrap();
        assert!(verify_bundle(&pre).ok);
        assert!(pre.notes.is_empty());
        // A pre-P3 bundle (no `notes` key at all) still deserializes.
        let mut legacy = serde_json::to_value(&pre).unwrap();
        legacy.as_object_mut().unwrap().remove("notes");
        let parsed: ContextBundle = serde_json::from_value(legacy).unwrap();
        assert!(verify_bundle(&parsed).ok, "a pre-P3 bundle must round-trip");

        // Cross the boundary: a note, a star, and a standalone thought.
        let write = |w: crate::context::NoteWrite| {
            match db.write_user_note(&w, "human").unwrap() {
                crate::context::NoteOutcome::Written(n) => n,
                other => panic!("expected Written, got {other:?}"),
            }
        };
        write(crate::context::NoteWrite {
            target_kind: Some("ledger_event".into()),
            target_id: Some("1".into()),
            text: Some("margin note on the first prompt".into()),
            ..Default::default()
        });
        write(crate::context::NoteWrite {
            target_kind: Some("ledger_event".into()),
            target_id: Some("1".into()),
            starred: Some(true),
            ..Default::default()
        });
        write(crate::context::NoteWrite {
            text: Some("a standalone thought".into()),
            ..Default::default()
        });

        // The live chain verifies across the boundary…
        assert!(db.verify_ledger_chain().unwrap().ok, "chain green across P3");
        // …the frozen pre-P3 bundle is untouched by it…
        assert!(verify_bundle(&pre).ok, "an already-exported bundle is immutable");
        // …and a fresh full bundle carries the notes and verifies.
        let post = build_bundle(&db, &BundleScope::Full).unwrap();
        let v = verify_bundle(&post);
        assert!(v.ok && v.full_chain, "post-note full bundle verifies: {v:?}");
        assert_eq!(post.notes.len(), 2, "the annotated row + the standalone row");
        assert!(post.notes.iter().any(|n| n.text == "a standalone thought"));
        assert!(post
            .notes
            .iter()
            .any(|n| n.starred && n.target_id.as_deref() == Some("1")));

        // Scope discipline: the session bundle carries only the note on its
        // own events; the standalone thought stays out.
        let sess = build_bundle(&db, &BundleScope::Session("s1".into())).unwrap();
        assert_eq!(sess.notes.len(), 1);
        assert_eq!(sess.notes[0].target_id.as_deref(), Some("1"));
    }

    #[test]
    fn empty_lake_yields_a_verifiable_empty_bundle() {
        let db = Database::open_in_memory().unwrap();
        let bundle = build_bundle(&db, &BundleScope::Full).unwrap();
        assert!(bundle.events.is_empty());
        assert_eq!(bundle.head_hash, GENESIS_PREV);
        let v = verify_bundle(&bundle);
        assert!(v.ok, "an empty bundle trivially verifies");
    }
}

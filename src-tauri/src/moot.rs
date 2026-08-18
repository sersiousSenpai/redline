// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Moot — a bounded, on-the-record multi-agent conversation on ONE work
//! item, rendered as a document. `moot_start` convenes N existing seats
//! (validated against `seat::KNOWN_SEATS` — a moot never invents a seat) for
//! at most `MAX_MOOT_ROUNDS` rounds; each round, each participant runs ONE
//! headless read-only pass on its own seat, prompted with the work item
//! (title/body/edges), the moot topic, and the transcript so far. Sequential
//! within a round, bounded everywhere: rounds and participants clamp to the
//! documented consts and every pass has a wall-clock ceiling.
//!
//! Boundaries, deliberately (the `intake.rs` shape):
//! - `work.rs` stays a pure state plane; the execution-shaped act lives HERE
//!   and talks to the work graph only through `db` reads/writes.
//! - Every pass rides the canonical `bridge_args` block on the participant's
//!   own seat — read-only headless (no `Edit`/`Write`, permission mode
//!   `default`), and `read_only_guard` refuses a spawn if a seat's
//!   user-configured extra flags try to smuggle `acceptEdits` in.
//! - ON-DEMAND ONLY: one tauri command, no watcher, no polling, no
//!   auto-convene.
//!
//! ON THE RECORD: every turn appends a `moot_turn` chain event
//! (`ledger::record_moot_turn`) carrying the item, the moot id, the round,
//! the seat and a digest of the turn's text — the transcript document can be
//! edited freely while each turn as spoken stays tamper-evident.
//!
//! RENDERED AS A DOCUMENT, because annotation is intervention: the transcript
//! lands as a Bookshelf/Drafter document with the markdown as the mirror and
//! the TipTap body RESET on every land (`upsert_draft_reset_doc` — a
//! moot-only variant of the intake/Shipwright shape; the Drafter rebuilds
//! the body from the fresh mirror on open, so a human save between rounds
//! can never leave a stale body hiding later rounds). The document is
//! created at moot start and UPDATED after each round — and before each
//! round the moot RE-READS it: if the human edited the body since the moot
//! last wrote it, the delta is folded into the next round's prompts as an
//! explicit human intervention block. That standing invitation to redline
//! the conversation itself is why this is a document and not a chat log.
//!
//! Durable linkage — the intake pattern verbatim: a `held` child message item
//! (`<parent>.N`, kind `message`, `parent-child` + `replies-to` edges,
//! `origin_kind="drafter"` / `origin_id=<draft id>`) names the moot document
//! on the subject item. Held, so a linkage breadcrumb never enters the ready
//! frontier; the PARENT is untouched — convening a conversation about work is
//! not doing the work.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::db::Database;
use crate::ledger;
use crate::state::SessionStore;
use crate::work::{WorkEdge, WorkItem};

/// Hard ceiling on rounds — a moot is a bounded conversation, not a loop. A
/// larger request clamps here (and 0 clamps up to 1); it never errors, so the
/// caller can ask for "as long as allowed" honestly.
pub const MAX_MOOT_ROUNDS: u32 = 3;
/// Hard ceiling on participants — enough voices for real disagreement, few
/// enough that every turn is read. Extra seats past this are dropped (after
/// dedupe), in the order given.
pub const MAX_MOOT_PARTICIPANTS: usize = 4;
/// Wall-clock ceiling on ONE participant pass. A pass that blows it is
/// killed, the transcript keeps everything already spoken, and the moot ends
/// with the abort on the record.
pub const MOOT_PASS_TIMEOUT_SECS: u64 = 300;
/// Ledger actor + edge author for everything the moot records itself (turns
/// are attributed to `moot:<seat>` by `ledger::record_moot_turn`).
pub const MOOT_ACTOR: &str = "moot";

/// What one moot produced, for whoever invoked the command. The transcript
/// document appears in the existing Bookshelf/Drafter list by construction.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MootReport {
    pub moot_id: String,
    /// The Bookshelf document the transcript lives in.
    pub draft_id: String,
    pub draft_title: Option<String>,
    /// The subject work item (unchanged by the moot).
    pub item_id: String,
    /// The `held` child message item that durably names the document.
    pub linked_item_id: String,
    pub rounds_run: u32,
    pub turns: usize,
    pub interventions: usize,
}

/// One entry in the moot record, in speaking order. Interventions are the
/// human's document edits, folded in between rounds — they are part of the
/// transcript, so a human redline is never silently overwritten by the next
/// document render.
#[derive(Debug, Clone)]
enum MootEntry {
    Turn {
        round: u32,
        seat: String,
        text: String,
    },
    Intervention {
        before_round: u32,
        delta: String,
    },
}

/// The whole moot, in memory: the validated convening plus the growing
/// record. Rendering (`render_moot_doc`) and prompting (`turn_prompt`) are
/// both pure functions of this.
#[derive(Debug)]
struct Moot {
    moot_id: String,
    topic: String,
    item: WorkItem,
    edges: Vec<WorkEdge>,
    participants: Vec<String>,
    rounds: u32,
    entries: Vec<MootEntry>,
    /// Set when a pass failed or timed out — rendered into the document so
    /// the abort itself is on the record.
    aborted: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure construction — bounds, rendering, prompts, the intervention fold
// (all unit-tested)
// ---------------------------------------------------------------------------

/// Validate + clamp the convening: every seat must be a KNOWN seat (a moot
/// never invents one — unknown names error cleanly), duplicates collapse
/// (first occurrence wins), the roster truncates at `MAX_MOOT_PARTICIPANTS`,
/// and rounds clamp into `1..=MAX_MOOT_ROUNDS`.
fn clamp_moot_bounds(rounds: u32, seats: &[String]) -> Result<(u32, Vec<String>), String> {
    let mut participants: Vec<String> = Vec::new();
    for s in seats {
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        if !crate::seat::KNOWN_SEATS.contains(&s) {
            return Err(format!(
                "`{s}` is not a known seat — a moot convenes existing seats only \
                 (see the Agent Seats roster)"
            ));
        }
        if !participants.iter().any(|p| p == s) {
            participants.push(s.to_string());
        }
    }
    if participants.is_empty() {
        return Err("a moot needs at least one participant seat".to_string());
    }
    participants.truncate(MAX_MOOT_PARTICIPANTS);
    Ok((rounds.clamp(1, MAX_MOOT_ROUNDS), participants))
}

/// One edge, human-readably: `from -(type)-> to`.
fn edge_line(e: &WorkEdge) -> String {
    format!("{} -({})-> {}", e.from_id, e.edge_type, e.to_id)
}

/// The transcript body only (rounds, turns, interventions), shared by the
/// document render and the prompt. Empty string when nothing has been said.
fn render_entries(entries: &[MootEntry]) -> String {
    let mut out = String::new();
    let mut current_round = 0u32;
    for entry in entries {
        match entry {
            MootEntry::Turn { round, seat, text } => {
                if *round != current_round {
                    current_round = *round;
                    out.push_str(&format!("\n## Round {round}\n"));
                }
                out.push_str(&format!("\n### `{seat}`\n\n{}\n", text.trim()));
            }
            MootEntry::Intervention {
                before_round,
                delta,
            } => {
                out.push_str(&format!(
                    "\n## Human intervention (before round {before_round})\n\n\
                     The human edited this document directly. Their delta:\n\n"
                ));
                for line in delta.lines() {
                    out.push_str("> ");
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    out
}

/// The whole transcript document, as markdown in the house shape: a single
/// `#` title line (it becomes the document's name), the convening header, the
/// standing invitation to edit, then the record.
fn render_moot_doc(m: &Moot) -> String {
    let mut out = format!("# Moot: {}\n\n", m.topic.trim());
    out.push_str(&format!(
        "*A bounded, on-the-record conversation convened on work item \
         `{}` — {}.*\n",
        m.item.id,
        m.item.title.trim()
    ));
    let roster = m
        .participants
        .iter()
        .map(|s| format!("`{s}`"))
        .collect::<Vec<_>>()
        .join(", ");
    out.push_str(&format!(
        "*Participants: {roster} · {} round(s) · every turn is ledgered \
         (`moot_turn`, moot `{}`).*\n\n",
        m.rounds, m.moot_id
    ));
    out.push_str(
        "> You can edit this document at any time — the moot re-reads it \
         before each round and folds your changes into the next round as an \
         explicit human intervention.\n",
    );
    out.push_str(&render_entries(&m.entries));
    if let Some(reason) = m.aborted.as_deref() {
        out.push_str(&format!("\n## Moot aborted\n\n{reason}\n"));
    }
    out
}

/// The prompt for one participant's pass: its seat identity (charter), the
/// moot rules, the work item verbatim (title/body/edges), the topic, the
/// transcript so far — and, when the human intervened before this round, an
/// explicit intervention block front and center. Pure — the whole context is
/// baked in so the core loop never depends on the agent curling anything.
fn turn_prompt(m: &Moot, seat: &str, round: u32) -> String {
    let (charter, _trigger) = crate::seat::charter_for(seat);
    let mut p = format!(
        "You are the `{seat}` seat in a Redline MOOT — a bounded, on-the-record \
         conversation between {} agent seats about ONE work item. Your seat's \
         charter: {charter}\n\n\
         Rules of the moot:\n\
         - This is round {round} of at most {}. Contribute ONE focused turn \
         from your seat's perspective — advance the conversation, disagree \
         where you disagree, and say what you would actually do.\n\
         - READ-ONLY: change nothing, write no code, run no command that \
         mutates anything. The moot's only artifact is the conversation.\n\
         - Every turn is recorded on a tamper-evident ledger; the transcript \
         is a document the human can redline between rounds.\n\
         - Output ONLY your turn's text, as markdown. No heading, no \
         signature — the transcript adds your seat's heading.\n\n",
        m.participants.len(),
        m.rounds
    );
    p.push_str("THE WORK ITEM (verbatim):\n\n");
    p.push_str(&format!(
        "Work item: {} (kind: {}, status: {})\n",
        m.item.id, m.item.kind, m.item.status
    ));
    p.push_str(&format!("Title: {}\n", m.item.title));
    match m
        .item
        .body
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        Some(body) => p.push_str(&format!("Body:\n{body}\n")),
        None => p.push_str("Body: (no body was filed — the title is the whole request)\n"),
    }
    if let Some(project) = m.item.project_path.as_deref() {
        p.push_str(&format!("Project: {project}\n"));
    }
    if m.edges.is_empty() {
        p.push_str("Edges: (none)\n");
    } else {
        p.push_str("Edges:\n");
        for e in &m.edges {
            p.push_str(&format!("  {}\n", edge_line(e)));
        }
    }
    p.push_str(&format!("\nTHE MOOT TOPIC:\n\n{}\n", m.topic.trim()));
    // The human's redline is the highest-signal steer in the moot — surface
    // the latest intervention for THIS round explicitly, over and above its
    // place in the transcript.
    if let Some(delta) = m.entries.iter().rev().find_map(|e| match e {
        MootEntry::Intervention {
            before_round,
            delta,
        } if *before_round == round => Some(delta.as_str()),
        _ => None,
    }) {
        p.push_str(&format!(
            "\nHUMAN INTERVENTION — the human edited the transcript document \
             since the last round. This is direct human steering: address it \
             in your turn.\n\n{delta}\n"
        ));
    }
    let transcript = render_entries(&m.entries);
    if transcript.trim().is_empty() {
        p.push_str("\nTHE TRANSCRIPT SO FAR: (no turns yet — you open the moot)\n");
    } else {
        p.push_str(&format!("\nTHE TRANSCRIPT SO FAR:\n{transcript}"));
    }
    p
}

/// Canonicalize one side of the intervention fold. A human OPEN+SAVE in the
/// Drafter re-serializes the mirror through the FE serializer, which (a)
/// plants a `<!-- rl:blk-… -->` sidecar comment line before every top-level
/// block and (b) reflows blank runs — pure serializer noise that the fold
/// must not mistake for a human act (without this, one no-op save reports
/// the WHOLE document as changed). Strips sidecar lines, trims line-trailing
/// whitespace, collapses blank-line runs, and drops leading/trailing blanks.
fn normalize_for_fold(body: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in body.lines() {
        let line = line.trim_end();
        let t = line.trim_start();
        // The serializer's sidecar shape (`sidecar.ts` / `parser.rs`): an
        // HTML comment carrying `rl:` alone on its line. Identity plumbing,
        // never content.
        if t.starts_with("<!--") && t.ends_with("-->") && t.contains("rl:") {
            continue;
        }
        if line.is_empty() {
            if out.last().is_some_and(|l| !l.is_empty()) {
                out.push("");
            }
        } else {
            out.push(line);
        }
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out.join("\n")
}

/// The pure intervention fold: compare the document body the moot last wrote
/// with what it reads back now — both sides canonicalized first
/// (`normalize_for_fold`), so serializer noise (sidecar comment lines, blank
/// reflow, trailing whitespace) is invisible and the delta is the HUMAN's
/// change. Identical after normalization → `None` (no block, and a
/// whitespace-only save is never mislabeled a reorder). Different → the
/// delta as `+ added` / `- removed` lines (a line-multiset diff — order
/// changes with no line changes report as a reorder). This is the
/// differentiator: annotation is intervention.
fn fold_intervention(last_written: &str, current: &str) -> Option<String> {
    let last_written = normalize_for_fold(last_written);
    let current = normalize_for_fold(current);
    if last_written == current {
        return None;
    }
    // Line-multiset diff: count each line's occurrences on both sides; the
    // surplus on either side is the delta. Pure, deterministic, no crates.
    let mut counts: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for line in last_written.lines() {
        *counts.entry(line).or_insert(0) -= 1;
    }
    for line in current.lines() {
        *counts.entry(line).or_insert(0) += 1;
    }
    let mut added: Vec<&str> = Vec::new();
    for line in current.lines() {
        if let Some(c) = counts.get_mut(line) {
            if *c > 0 {
                *c -= 1;
                added.push(line);
            }
        }
    }
    let mut removed: Vec<&str> = Vec::new();
    for line in last_written.lines() {
        if let Some(c) = counts.get_mut(line) {
            if *c < 0 {
                *c += 1;
                removed.push(line);
            }
        }
    }
    let mut delta = String::new();
    for line in &added {
        delta.push_str(&format!("+ {line}\n"));
    }
    for line in &removed {
        delta.push_str(&format!("- {line}\n"));
    }
    if delta.is_empty() {
        delta.push_str("(content reordered — no lines added or removed)\n");
    }
    Some(delta)
}

/// The full argv for one participant pass: the canonical headless bridge
/// block on the participant's OWN seat, single turn (no resume).
/// `bridge_args` is the ONE place the invariant flag block lives.
fn pass_args(seat: &str, prompt: String) -> Vec<String> {
    crate::claude_proc::bridge_args(seat, prompt, None)
}

/// Refuse to spawn with any write-capable escalation in the FINAL argv. The
/// invariant block always carries `--permission-mode default` and a tool
/// surface with no `Edit`/`Write`, but a seat's user-configured `extra_flags`
/// are appended verbatim AFTER it — and the CLI lets a later flag win. The
/// shared `assert_read_only_argv` (also the `intake.rs` guard) checks every
/// occurrence of the escalation-capable flags (`--permission-mode`,
/// `--dangerously-skip-permissions`, `--tools`/`--allowedTools` naming a
/// write tool), per participant seat, so a seat tweak cannot silently
/// escalate a read-only moot pass into an editing one.
fn read_only_guard(seat: &str, args: &[String]) -> Result<(), String> {
    crate::claude_proc::assert_read_only_argv(args).map_err(|why| {
        format!(
            "a moot pass is read-only — {why}; fix the `{seat}` seat's \
             extra flags to convene it"
        )
    })
}

/// Mint the linkage child's id: `<parent>.N`, one past the highest existing
/// direct-child ordinal (never reusing a freed one). A documented mirror of
/// the minting law of `work.rs` — that function is private to the state
/// plane, and the plane's boundary is worth more than sharing ten lines
/// (the `intake.rs` precedent).
fn mint_linkage_child_id(db: &Database, parent: &str) -> String {
    let next = db
        .work_child_ids(parent)
        .iter()
        .filter_map(|id| id.rsplit('.').next()?.parse::<i64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    format!("{parent}.{next}")
}

// ---------------------------------------------------------------------------
// DB-facing steps — prepare, land, link (all exercised by tests)
// ---------------------------------------------------------------------------

/// Load + gate + build: the item must exist and be `open` or `claimed` — a
/// conversation about live work. A `held` item is parked by its filer and a
/// `closed` one is finished; convening on either would be talking over the
/// human's own state.
fn prepare_moot(
    db: &Database,
    item_id: &str,
    participant_seats: &[String],
    rounds: u32,
    topic: Option<String>,
) -> Result<Moot, String> {
    let (rounds, participants) = clamp_moot_bounds(rounds, participant_seats)?;
    let id = item_id.trim();
    let Some(item) = db.get_work_item(id) else {
        return Err(format!("no work item `{id}`"));
    };
    if item.status != "open" && item.status != "claimed" {
        return Err(format!(
            "work item `{}` is `{}` — a moot convenes only on an open or \
             claimed item",
            item.id, item.status
        ));
    }
    let edges = db.list_work_edges_touching(&item.id).unwrap_or_default();
    let topic = topic
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| item.title.clone());
    Ok(Moot {
        moot_id: uuid::Uuid::new_v4().to_string(),
        topic,
        item,
        edges,
        participants,
        rounds,
        entries: Vec::new(),
        aborted: None,
    })
}

/// Land (create or update) the transcript document: the markdown mirror is
/// the document, and any stored TipTap body is RESET (`doc_json = NULL`) —
/// the Drafter rebuilds the body from the fresh mirror on next open. Returns
/// the markdown written (the caller's baseline for the next intervention
/// check) and the derived title.
fn land_doc(
    db: &Database,
    m: &Moot,
    draft_id: &str,
) -> Result<(String, Option<String>), String> {
    let markdown = render_moot_doc(m);
    let title = crate::draft_title_from_markdown(&markdown);
    // Deliberately NOT the intake/Shipwright `upsert_draft(.., None)` shape:
    // its COALESCE keeps a stored `doc_json` winning forever, and the Drafter
    // PREFERS `doc_json` on open — so after the human's first Drafter save,
    // every later round would land into a mirror nobody renders (the stale
    // TipTap body hides the whole rest of the moot). The moot re-renders the
    // ENTIRE document each round, so the mirror is authoritative here and the
    // reset variant clears the body. The tradeoff, honestly: TipTap-only
    // niceties in the human's save are dropped on the next land — acceptable
    // ONLY because `fold_intervention` already folded the human's mirror
    // delta into this very transcript before it landed. One-off documents
    // keep `upsert_draft`; this reset stays a moot-only shape.
    db.upsert_draft_reset_doc(
        draft_id,
        title.as_deref(),
        m.item.project_path.as_deref(),
        &markdown,
    )
    .map_err(|e| e.to_string())?;
    Ok((markdown, title))
}

/// File the durable linkage — the `intake.rs` pattern verbatim: a `held`
/// child message (`<parent>.N`, kind `message`) carrying
/// `origin_kind="drafter"` / `origin_id=<draft id>`, the `parent-child` +
/// `replies-to` edges, and the `work_file` chain event. Held, so the
/// breadcrumb never enters the ready frontier; the parent stays untouched.
fn file_linkage(
    db: &Database,
    m: &Moot,
    draft_id: &str,
    title: Option<&str>,
) -> Result<String, String> {
    let now = ledger::now_millis();
    let roster = m.participants.join(", ");
    let make_child = |child_id: &str| WorkItem {
        id: child_id.to_string(),
        title: format!("Moot convened: {}", title.unwrap_or(&m.topic)),
        body: Some(format!(
            "A moot ({}) convened seats [{roster}] on this item for up to {} \
             round(s). The transcript is document `{draft_id}` — open it in \
             the Drafter; editing it between rounds steers the conversation.",
            m.moot_id, m.rounds
        )),
        // A linkage breadcrumb is parked context, never claimable work — it
        // files `held` so it can't enter the ready frontier.
        status: "held".to_string(),
        priority: m.item.priority,
        kind: "message".to_string(),
        assignee: None,
        claimed_at: None,
        lease_expires_at: None,
        closed_at: None,
        close_reason: None,
        defer_until: None,
        // The schema's own provenance pattern: a TEXT breadcrumb to the
        // draft, never a foreign key.
        origin_kind: Some("drafter".to_string()),
        origin_id: Some(draft_id.to_string()),
        project_path: m.item.project_path.clone(),
        pinned: false,
        created_at: now,
        updated_at: now,
    };
    // Mint + insert can lose a race to a concurrent filer on the same parent
    // (plain INSERT on the PK): on a UNIQUE-constraint loss, re-read the
    // children and retry ONCE so the linkage still lands. A second loss
    // stays loud.
    let mut child_id = String::new();
    let mut inserted = false;
    let mut last_err = String::new();
    for attempt in 0..2 {
        child_id = mint_linkage_child_id(db, &m.item.id);
        match db.insert_work_item(&make_child(&child_id)) {
            Ok(()) => {
                inserted = true;
                break;
            }
            Err(e) => {
                let unique = matches!(
                    &e,
                    rusqlite::Error::SqliteFailure(f, _)
                        if f.code == rusqlite::ffi::ErrorCode::ConstraintViolation
                );
                last_err = e.to_string();
                if attempt == 0 && unique {
                    tracing::warn!(
                        parent = %m.item.id, lost = %child_id,
                        "moot linkage id lost to a concurrent filer — re-minting once"
                    );
                    continue;
                }
                break;
            }
        }
    }
    if !inserted {
        return Err(format!(
            "the moot landed document `{draft_id}` but failed to file its \
             linkage child under `{}`: {last_err}",
            m.item.id
        ));
    }
    // Edge failures are non-blocking, but never silent.
    if let Err(e) = db.insert_work_edge(&m.item.id, &child_id, "parent-child", Some(MOOT_ACTOR), now)
    {
        tracing::warn!(from = %m.item.id, to = %child_id, error = %e, "moot parent-child edge insert failed");
    }
    if let Err(e) = db.insert_work_edge(&child_id, &m.item.id, "replies-to", Some(MOOT_ACTOR), now) {
        tracing::warn!(from = %child_id, to = %m.item.id, error = %e, "moot replies-to edge insert failed");
    }
    if let Err(e) = ledger::record_work_event(
        db,
        ledger::EventKind::WorkFile,
        &child_id,
        Some(MOOT_ACTOR),
        Some(&format!("moot-doc:{draft_id}")),
        now,
    ) {
        tracing::warn!(item = %child_id, error = %e, "moot linkage chain append failed");
    }
    Ok(child_id)
}

// ---------------------------------------------------------------------------
// Spawn + drive — one headless read-only pass per participant per round
// ---------------------------------------------------------------------------

/// Run ONE participant pass to completion under the wall-clock ceiling and
/// return its final text. The argv is fully built (and guarded) by the
/// caller.
async fn run_pass(seat: &str, args: Vec<String>) -> Result<String, String> {
    let claude_bin = tokio::task::spawn_blocking(crate::claude_proc::resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    let mut cmd = crate::claude_proc::claude_command_for_seat(seat, &claude_bin);
    let mut child = cmd
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "could not find the `claude` CLI (looked for `{claude_bin}`). \
                     Install Claude Code, or launch Redline from a terminal."
                )
            } else {
                format!("failed to spawn the `{seat}` moot pass: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("moot pass stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("moot pass stderr unavailable")?;
    let out = match tokio::time::timeout(
        Duration::from_secs(MOOT_PASS_TIMEOUT_SECS),
        crate::claude_proc::collect_turn(stdout, stderr),
    )
    .await
    {
        Ok(out) => out,
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "the `{seat}` pass exceeded the {MOOT_PASS_TIMEOUT_SECS}s \
                 wall-clock ceiling and was killed"
            ));
        }
    };
    // The stream budget bounded the read; bound the reap too — a child that
    // closed its pipes but refuses to exit must not hang the sequential moot
    // (an unbounded `wait` here would stall every remaining turn).
    if tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .is_err()
    {
        tracing::warn!(seat = %seat, "moot pass closed its pipes but did not exit — killing it");
        let _ = child.kill().await;
    }
    if let Some(msg) = out.errored {
        return Err(msg);
    }
    match out.final_text.filter(|t| !t.trim().is_empty()) {
        Some(text) => Ok(text),
        None => Err(if out.stderr_text.trim().is_empty() {
            format!("the `{seat}` pass produced no turn")
        } else {
            format!(
                "the `{seat}` pass produced no turn: {}",
                out.stderr_text.trim()
            )
        }),
    }
}

/// Convene a moot: N existing seats, one work item, at most `rounds` rounds,
/// the transcript rendered as a living document. ON-DEMAND only — this
/// command is the sole entry point; nothing watches, polls, or auto-convenes
/// it. `topic` defaults to the item's title.
#[tauri::command(async)]
pub async fn moot_start(
    store: tauri::State<'_, SessionStore>,
    item_id: String,
    participant_seats: Vec<String>,
    rounds: u32,
    topic: Option<String>,
) -> Result<MootReport, String> {
    let db = store.database();
    let mut m = prepare_moot(&db, &item_id, &participant_seats, rounds, topic)?;
    let draft_id = uuid::Uuid::new_v4().to_string();

    // The document exists from the first moment of the moot — the human can
    // open (and edit) it while round 1 is still speaking.
    let (mut last_written, mut title) = land_doc(&db, &m, &draft_id)?;
    let linked_item_id = file_linkage(&db, &m, &draft_id, title.as_deref())?;

    let mut rounds_run = 0u32;
    'moot: for round in 1..=m.rounds {
        // Annotation is intervention: re-read the document; a human edit
        // since the last write becomes an explicit steer for this round.
        if let Ok(Some((_, current, _))) = db.get_draft_doc(&draft_id) {
            if let Some(delta) = fold_intervention(&last_written, &current) {
                m.entries.push(MootEntry::Intervention {
                    before_round: round,
                    delta,
                });
            }
        }
        for seat in m.participants.clone() {
            let prompt = turn_prompt(&m, &seat, round);
            let args = pass_args(&seat, prompt);
            if let Err(e) = read_only_guard(&seat, &args) {
                m.aborted = Some(e.clone());
                break 'moot;
            }
            // Keep the headless `-p` out of the lake (the global hook would
            // otherwise capture the baked prompt as a human one).
            ledger::register_agent_prompt(&args[1]);
            match run_pass(&seat, args).await {
                Ok(text) => {
                    // ON THE RECORD: the chain event carries a digest of the
                    // turn as spoken — best-effort, never blocking the moot.
                    if let Err(e) = ledger::record_moot_turn(
                        &db,
                        &m.item.id,
                        &m.moot_id,
                        round,
                        &seat,
                        &ledger::body_hash(&text),
                        ledger::now_millis(),
                    ) {
                        tracing::warn!(seat = %seat, round, error = %e, "moot turn chain append failed");
                    }
                    m.entries.push(MootEntry::Turn {
                        round,
                        seat: seat.clone(),
                        text,
                    });
                }
                Err(e) => {
                    m.aborted = Some(format!("round {round}, seat `{seat}`: {e}"));
                    break 'moot;
                }
            }
        }
        rounds_run = round;
        let (written, t) = land_doc(&db, &m, &draft_id)?;
        last_written = written;
        title = t;
    }

    if let Some(reason) = m.aborted.as_deref() {
        // Land what was spoken (plus the abort, on the record) before failing
        // the command — BEST-EFFORT: a landing failure is logged, never
        // allowed to mask the abort reason the caller must see.
        if let Err(e) = land_doc(&db, &m, &draft_id) {
            tracing::warn!(draft = %draft_id, error = %e, "failed to land the aborted moot transcript");
        }
        return Err(format!(
            "moot aborted: {reason} (transcript so far is document {draft_id})"
        ));
    }

    let _ = db.append_journal(
        "moot",
        Some("drafter"),
        Some(&draft_id),
        title.as_deref(),
        Some(&format!("moot on work item {}", m.item.id)),
    );
    let turns = m
        .entries
        .iter()
        .filter(|e| matches!(e, MootEntry::Turn { .. }))
        .count();
    let interventions = m.entries.len() - turns;
    Ok(MootReport {
        moot_id: m.moot_id,
        draft_id,
        draft_title: title,
        item_id: m.item.id,
        linked_item_id,
        rounds_run,
        turns,
        interventions,
    })
}

// ---------------------------------------------------------------------------
// Tests — bounds, validation, the ledgered turn + chain, the document
// round-trip through the Drafter's own read path, the intervention fold, and
// the read-only argv pin.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, status: &str) -> WorkItem {
        let now = ledger::now_millis();
        WorkItem {
            id: id.to_string(),
            title: "Decide the frobnicator rollout".to_string(),
            body: Some("Two seats disagree on sequencing.\nSettle it.".to_string()),
            status: status.to_string(),
            priority: 2,
            kind: "question".to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at: None,
            close_reason: None,
            defer_until: None,
            origin_kind: Some("intake".to_string()),
            origin_id: Some("share-9".to_string()),
            project_path: Some("/tmp/proj".to_string()),
            pinned: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn moot_of(item: WorkItem, seats: &[&str], rounds: u32) -> Moot {
        Moot {
            moot_id: "moot-test".to_string(),
            topic: item.title.clone(),
            item,
            edges: Vec::new(),
            participants: seats.iter().map(|s| s.to_string()).collect(),
            rounds,
            entries: Vec::new(),
            aborted: None,
        }
    }

    #[test]
    fn bounds_are_clamped_to_the_documented_consts() {
        // The documented ceilings themselves — small and honest.
        assert_eq!(MAX_MOOT_ROUNDS, 3);
        assert_eq!(MAX_MOOT_PARTICIPANTS, 4);
        let many: Vec<String> = ["drafter", "shipwright", "librarian", "browse", "mission", "voice"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Rounds clamp both ways; participants truncate at the cap.
        let (rounds, seats) = clamp_moot_bounds(99, &many).unwrap();
        assert_eq!(rounds, MAX_MOOT_ROUNDS);
        assert_eq!(seats.len(), MAX_MOOT_PARTICIPANTS);
        assert_eq!(seats, ["drafter", "shipwright", "librarian", "browse"]);
        let (rounds, _) = clamp_moot_bounds(0, &many).unwrap();
        assert_eq!(rounds, 1);
        // Duplicates collapse (first occurrence wins) before the cap applies.
        let dupes: Vec<String> = ["drafter", "drafter", " shipwright ", "drafter"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (_, seats) = clamp_moot_bounds(2, &dupes).unwrap();
        assert_eq!(seats, ["drafter", "shipwright"]);
    }

    #[test]
    fn unknown_seats_and_wrong_item_states_are_refused() {
        // An unknown seat errors cleanly — a moot never invents a seat.
        let err = clamp_moot_bounds(2, &["warlock".to_string()]).unwrap_err();
        assert!(err.contains("not a known seat"), "{err}");
        assert!(clamp_moot_bounds(2, &[]).unwrap_err().contains("at least one"));

        // The item gate: open and claimed convene; held/closed/missing refuse.
        let db = Database::open_in_memory().unwrap();
        let seats = vec!["drafter".to_string()];
        for (id, status) in [("rl-h", "held"), ("rl-z", "closed")] {
            db.insert_work_item(&item(id, status)).unwrap();
            let err = prepare_moot(&db, id, &seats, 2, None).unwrap_err();
            assert!(err.contains(status), "{err}");
            assert!(err.contains("open or claimed"), "{err}");
        }
        assert!(prepare_moot(&db, "rl-missing", &seats, 2, None)
            .unwrap_err()
            .contains("no work item"));
        for (id, status) in [("rl-o", "open"), ("rl-c", "claimed")] {
            db.insert_work_item(&item(id, status)).unwrap();
            let m = prepare_moot(&db, &format!(" {id} "), &seats, 2, None).unwrap();
            assert_eq!(m.item.id, id);
            assert_eq!(m.rounds, 2);
            // Topic defaults to the item's title; an explicit one wins.
            assert_eq!(m.topic, "Decide the frobnicator rollout");
        }
        let m = prepare_moot(&db, "rl-o", &seats, 2, Some("Sequencing call".to_string())).unwrap();
        assert_eq!(m.topic, "Sequencing call");
    }

    #[test]
    fn every_turn_lands_a_chain_event_and_the_chain_stays_green() {
        let db = Database::open_in_memory().unwrap();
        db.insert_work_item(&item("rl-moot", "open")).unwrap();
        let digest = ledger::body_hash("I would ship the guard first.");
        let now = ledger::now_millis();
        let seq = ledger::record_moot_turn(&db, "rl-moot", "moot-1", 1, "drafter", &digest, now)
            .unwrap();
        assert!(seq.is_some(), "first record lands");
        // The exact same act dedupes (record_decision idempotency)…
        let again =
            ledger::record_moot_turn(&db, "rl-moot", "moot-1", 1, "drafter", &digest, now).unwrap();
        assert_eq!(again, None);
        // …while the next round's turn records afresh.
        let seq2 = ledger::record_moot_turn(&db, "rl-moot", "moot-1", 2, "drafter", &digest, now)
            .unwrap();
        assert!(seq2.is_some());
        let events = db.list_ledger_events(10).unwrap();
        let turns: Vec<_> = events.iter().filter(|e| e.kind == "moot_turn").collect();
        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|e| e.ref_kind.as_deref() == Some("work_item")
            && e.ref_id.as_deref() == Some("rl-moot")));
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn the_document_round_trips_through_the_drafter_read_path() {
        let db = Database::open_in_memory().unwrap();
        let it = item("rl-doc", "open");
        db.insert_work_item(&it).unwrap();
        let mut m = moot_of(it, &["drafter", "shipwright"], 2);
        let draft_id = "moot-draft-1";

        // Created at moot start: the empty transcript, in the house shape.
        let (first, title) = land_doc(&db, &m, draft_id).unwrap();
        let (doc_json, doc_md, project) = db.get_draft_doc(draft_id).unwrap().unwrap();
        assert_eq!(doc_json, None, "mirror-only — the FE builds the body");
        assert_eq!(doc_md, first);
        assert_eq!(project.as_deref(), Some("/tmp/proj"));
        assert_eq!(title.as_deref(), Some("Moot: Decide the frobnicator rollout"));
        // And through the Bookshelf list (the shelf's read path).
        let row = db
            .list_drafts()
            .unwrap()
            .into_iter()
            .find(|d| d.draft_id == draft_id)
            .expect("the moot document is on the shelf");
        assert!(!row.has_doc);
        assert_eq!(row.title.as_deref(), Some("Moot: Decide the frobnicator rollout"));

        // UPDATED after each round: turns + an intervention render in order,
        // and the read path returns exactly what the render wrote.
        m.entries.push(MootEntry::Turn {
            round: 1,
            seat: "drafter".to_string(),
            text: "Ship the guard first.".to_string(),
        });
        m.entries.push(MootEntry::Intervention {
            before_round: 2,
            delta: "+ Focus on the rollback story\n".to_string(),
        });
        m.entries.push(MootEntry::Turn {
            round: 2,
            seat: "shipwright".to_string(),
            text: "Agreed, with a guard test.".to_string(),
        });
        let (second, _) = land_doc(&db, &m, draft_id).unwrap();
        let (doc_json, doc_md, _) = db.get_draft_doc(draft_id).unwrap().unwrap();
        assert_eq!(doc_json, None);
        assert_eq!(doc_md, second);
        assert!(doc_md.contains("## Round 1"));
        assert!(doc_md.contains("### `drafter`"));
        assert!(doc_md.contains("Ship the guard first."));
        assert!(doc_md.contains("## Human intervention (before round 2)"));
        assert!(doc_md.contains("> + Focus on the rollback story"));
        assert!(doc_md.contains("## Round 2"));
        assert!(doc_md.contains("### `shipwright`"));
    }

    #[test]
    fn a_human_tiptap_save_never_hides_later_rounds() {
        let db = Database::open_in_memory().unwrap();
        let it = item("rl-stale", "open");
        db.insert_work_item(&it).unwrap();
        let mut m = moot_of(it, &["drafter"], 2);
        let draft_id = "moot-stale-1";
        let (first, _) = land_doc(&db, &m, draft_id).unwrap();

        // Simulate the human's Drafter save between rounds: `drafter_set_doc`
        // writes a re-serialized mirror (sidecars and all) PLUS a TipTap
        // `doc_json` — the body the Drafter would prefer on open.
        db.upsert_draft(
            draft_id,
            Some("Moot: Decide the frobnicator rollout"),
            Some("/tmp/proj"),
            &format!("<!-- rl:blk-aaaa1111 -->\n{first}"),
            Some(r#"{"type":"doc","content":[]}"#),
        )
        .unwrap();
        let (json, _, _) = db.get_draft_doc(draft_id).unwrap().unwrap();
        assert!(json.is_some(), "the human save stored a TipTap body");

        // The next round lands — and what the Drafter would render must be
        // the FRESH transcript, not the stale TipTap body.
        m.entries.push(MootEntry::Turn {
            round: 1,
            seat: "drafter".to_string(),
            text: "Guard first, ship second.".to_string(),
        });
        let (second, _) = land_doc(&db, &m, draft_id).unwrap();
        let (json, md, _) = db.get_draft_doc(draft_id).unwrap().unwrap();
        assert_eq!(
            json, None,
            "the stale body is reset — the Drafter rebuilds from the mirror"
        );
        assert_eq!(md, second);
        assert!(md.contains("Guard first, ship second."));
    }

    #[test]
    fn serializer_noise_is_not_an_intervention() {
        let base = "# Moot: X\n\nline one\nline two\n";
        // A no-edit OPEN+SAVE re-serializes with a `<!-- rl:blk-… -->`
        // sidecar per block plus blank reflow — pure serializer noise, so no
        // intervention block at all.
        let resaved = "<!-- rl:blk-aaaa1111 -->\n# Moot: X\n\n\n<!-- rl:blk-bbbb2222 -->\nline one\n<!-- rl:blk-cccc3333 -->\nline two\n\n";
        assert_eq!(fold_intervention(base, resaved), None);
        // With ONE human line added under the same noise, the delta is
        // exactly that line — not the whole re-serialized document.
        let edited = "<!-- rl:blk-aaaa1111 -->\n# Moot: X\n\n<!-- rl:blk-bbbb2222 -->\nline one\n<!-- rl:blk-cccc3333 -->\nline two\nHuman: consider the cache\n";
        let delta = fold_intervention(base, edited).unwrap();
        assert_eq!(delta, "+ Human: consider the cache\n");
        // Whitespace-only churn (trailing spaces, extra blank runs) is
        // neither an intervention nor a "(content reordered…)" label.
        let ws = "# Moot: X\n\n\n\nline one   \nline two\n\n";
        assert_eq!(fold_intervention(base, ws), None);
    }

    #[test]
    fn the_intervention_fold_detects_the_human_delta() {
        let base = "# Moot: X\n\nline one\nline two\n";
        // Unchanged body → no block at all.
        assert_eq!(fold_intervention(base, base), None);
        // An added line shows as `+`, a removed one as `-`.
        let edited = "# Moot: X\n\nline one\nline two\nHuman: consider the cache\n";
        let delta = fold_intervention(base, edited).unwrap();
        assert!(delta.contains("+ Human: consider the cache"), "{delta}");
        assert!(!delta.contains("- "), "{delta}");
        let cut = "# Moot: X\n\nline one\n";
        let delta = fold_intervention(base, cut).unwrap();
        assert!(delta.contains("- line two"), "{delta}");
        // An edit-in-place is a remove + an add of the same line slot.
        let reworded = "# Moot: X\n\nline one\nline 2 reworded\n";
        let delta = fold_intervention(base, reworded).unwrap();
        assert!(delta.contains("+ line 2 reworded"), "{delta}");
        assert!(delta.contains("- line two"), "{delta}");
        // Pure reorder: flagged, not silently dropped.
        let reordered = "line two\n# Moot: X\n\nline one\n";
        let delta = fold_intervention(base, reordered).unwrap();
        assert!(delta.contains("reordered"), "{delta}");
        // And the fold feeds the round prompt as an explicit block.
        let mut m = moot_of(item("rl-p", "open"), &["drafter"], 2);
        m.entries.push(MootEntry::Intervention {
            before_round: 2,
            delta: "+ Human: consider the cache\n".to_string(),
        });
        let p = turn_prompt(&m, "drafter", 2);
        assert!(p.contains("HUMAN INTERVENTION"));
        assert!(p.contains("+ Human: consider the cache"));
        // A round with no intervention gets no block.
        let p1 = turn_prompt(&m, "drafter", 1);
        assert!(!p1.contains("HUMAN INTERVENTION"));
    }

    #[test]
    fn the_turn_prompt_carries_item_topic_and_transcript() {
        let it = item("rl-pr", "open");
        let mut m = moot_of(it, &["drafter", "shipwright"], 3);
        m.edges.push(WorkEdge {
            from_id: "rl-pr".to_string(),
            to_id: "rl-pr.1".to_string(),
            edge_type: "parent-child".to_string(),
            created_by: None,
            created_at: 0,
        });
        m.topic = "Settle the sequencing".to_string();
        let p = turn_prompt(&m, "shipwright", 1);
        // The item verbatim: id/kind/status, title, body, edges, project.
        assert!(p.contains("Work item: rl-pr (kind: question, status: open)"));
        assert!(p.contains("Decide the frobnicator rollout"));
        assert!(p.contains("Two seats disagree on sequencing.\nSettle it."));
        assert!(p.contains("rl-pr -(parent-child)-> rl-pr.1"));
        assert!(p.contains("Project: /tmp/proj"));
        // The topic, the moot rules, the read-only law, the empty transcript.
        assert!(p.contains("Settle the sequencing"));
        assert!(p.contains("round 1 of at most 3"));
        assert!(p.contains("READ-ONLY"));
        assert!(p.contains("you open the moot"));
        // With a turn on the record, the transcript rides along.
        m.entries.push(MootEntry::Turn {
            round: 1,
            seat: "drafter".to_string(),
            text: "Guard first.".to_string(),
        });
        let p2 = turn_prompt(&m, "shipwright", 1);
        assert!(p2.contains("THE TRANSCRIPT SO FAR:"));
        assert!(p2.contains("### `drafter`"));
        assert!(p2.contains("Guard first."));
    }

    #[test]
    fn moot_argv_is_headless_read_only_on_the_participant_seat() {
        let _guard = crate::seat::store_guard();
        crate::seat::set_seat_for_test(
            "shipwright",
            Some(crate::seat::SeatConfig {
                model: Some("sonnet".to_string()),
                ..Default::default()
            }),
        );
        let m = moot_of(item("rl-a", "open"), &["shipwright"], 1);
        let args = pass_args("shipwright", turn_prompt(&m, "shipwright", 1));
        // Headless single turn: `-p <prompt>` + stream-json, no resume.
        assert_eq!(args[0], "-p");
        assert!(args.iter().any(|a| a == "stream-json"));
        assert!(!args.iter().any(|a| a == "--resume"));
        // READ-ONLY, pinned on the built argv: no acceptEdits anywhere, the
        // permission mode is `default`, and the tool surface carries no
        // write/plan tools.
        assert!(args.iter().all(|a| !a.contains("acceptEdits")));
        let pm = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm + 1], "default");
        let tools_idx = args.iter().position(|a| a == "--tools").unwrap();
        let tools = &args[tools_idx + 1];
        assert_eq!(tools, crate::claude_proc::HEADLESS_TOOLS);
        assert!(!tools
            .split(',')
            .any(|t| t == "Edit" || t == "Write" || t == "ExitPlanMode"));
        // The PARTICIPANT seat's flags are the ones consumed — the moot
        // invents no seat of its own.
        let model_idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model_idx + 1], "sonnet");
        assert!(read_only_guard("shipwright", &args).is_ok());

        // acceptEdits smuggled via a seat's extra flags is refused, naming
        // the offending seat.
        crate::seat::set_seat_for_test(
            "shipwright",
            Some(crate::seat::SeatConfig {
                extra_flags: Some(vec![
                    "--permission-mode".to_string(),
                    "acceptEdits".to_string(),
                ]),
                ..Default::default()
            }),
        );
        let args = pass_args("shipwright", turn_prompt(&m, "shipwright", 1));
        let err = read_only_guard("shipwright", &args).unwrap_err();
        assert!(err.contains("read-only"), "{err}");
        assert!(err.contains("shipwright"), "{err}");

        // And the guard is not a literal-`acceptEdits` grep: every
        // write-capable escalation a seat's extra flags could append AFTER
        // the invariant block (where a later flag wins) is refused too.
        let smuggles: Vec<Vec<&str>> = vec![
            vec!["--permission-mode", "bypassPermissions"],
            vec!["--permission-mode=bypassPermissions"],
            vec!["--dangerously-skip-permissions"],
            vec!["--allowedTools", "Edit"],
            vec!["--tools", "Read,Write"],
        ];
        for smuggle in smuggles {
            crate::seat::set_seat_for_test(
                "shipwright",
                Some(crate::seat::SeatConfig {
                    extra_flags: Some(smuggle.iter().map(|s| s.to_string()).collect()),
                    ..Default::default()
                }),
            );
            let args = pass_args("shipwright", turn_prompt(&m, "shipwright", 1));
            let err = read_only_guard("shipwright", &args).unwrap_err();
            assert!(err.contains("read-only"), "{smuggle:?}: {err}");
            assert!(err.contains("shipwright"), "{smuggle:?}: {err}");
        }
        crate::seat::set_seat_for_test("shipwright", None);
    }

    #[test]
    fn the_linkage_child_files_held_with_both_edges_and_walks_ordinals() {
        let db = Database::open_in_memory().unwrap();
        let it = item("rl-ln", "open");
        db.insert_work_item(&it).unwrap();
        let m = moot_of(it, &["drafter", "librarian"], 2);
        let child_id = file_linkage(&db, &m, "draft-abc", Some("Moot: Rollout")).unwrap();

        assert_eq!(child_id, "rl-ln.1");
        let child = db.get_work_item("rl-ln.1").unwrap();
        assert_eq!(child.kind, "message");
        assert_eq!(child.status, "held");
        assert_eq!(child.origin_kind.as_deref(), Some("drafter"));
        assert_eq!(child.origin_id.as_deref(), Some("draft-abc"));
        assert!(child.title.contains("Moot convened"));
        let body = child.body.unwrap();
        assert!(body.contains("draft-abc"));
        assert!(body.contains("drafter, librarian"));
        // Both edges, in their canonical directions.
        let edges = db.list_work_edges_touching("rl-ln.1").unwrap();
        assert!(edges
            .iter()
            .any(|e| e.edge_type == "parent-child" && e.from_id == "rl-ln" && e.to_id == "rl-ln.1"));
        assert!(edges
            .iter()
            .any(|e| e.edge_type == "replies-to" && e.from_id == "rl-ln.1" && e.to_id == "rl-ln"));
        // The parent stays untouched; the breadcrumb never enters the ready
        // frontier.
        assert_eq!(db.get_work_item("rl-ln").unwrap().status, "open");
        let ready = db
            .list_ready_work_items(None, ledger::now_millis(), 50)
            .unwrap();
        let ids: Vec<&str> = ready.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"rl-ln"));
        assert!(!ids.contains(&"rl-ln.1"));
        // The chain event landed, and the chain stays verifiable.
        let events = db.list_ledger_events(10).unwrap();
        assert!(events.iter().any(|e| e.kind == "work_file"
            && e.ref_id.as_deref() == Some("rl-ln.1")));
        assert!(db.verify_ledger_chain().unwrap().ok);
        // A second moot on the same item files the NEXT ordinal.
        let again = file_linkage(&db, &m, "draft-def", None).unwrap();
        assert_eq!(again, "rl-ln.2");
    }

    #[test]
    fn concurrent_linkages_both_land_their_child() {
        // The mint+insert race: two moots filing on the same parent must BOTH
        // land a linkage child (the loser re-mints once), never fail on a
        // UNIQUE-constraint loss.
        use std::sync::Arc;
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.insert_work_item(&item("rl-lr", "open")).unwrap();
        let mut handles = Vec::new();
        for n in 0..2 {
            let db = Arc::clone(&db);
            handles.push(std::thread::spawn(move || {
                let m = moot_of(item("rl-lr", "open"), &["drafter"], 1);
                file_linkage(&db, &m, &format!("draft-{n}"), None).unwrap()
            }));
        }
        let mut ids: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        ids.sort();
        assert_eq!(ids, ["rl-lr.1", "rl-lr.2"]);
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Polis Librarian agent (Phase 3): the on-demand, friction-reduction agent
//! whose flagship duty is stewarding the prompt/context library (the lake + its
//! ClassMemory catalog).
//!
//! It reads a **ground-truth friction digest** (`context::build_digest`, baked
//! into the spawn prompt exactly as `classmem` bakes the lake delta) and returns
//! a **prioritized next-actions checklist** as structured JSON, machine-parsed
//! here the same way `classmem::parse_proposals` parses the classifier. The
//! priority order it applies lives in `skills/librarian/SKILL.md` (fixed by
//! `docs/polis-librarian-spike-3a.md`); this module supplies the prompt and
//! parses the reply. On-demand only — spawned once per Librarian click, never a
//! background daemon.
//!
//! Spawned headless with the same `bridge_args` tool surface as the classifier
//! (curl bridge to the localhost daemon so it can read `/v1/context/overview`,
//! `/v1/memory/*`, `/v1/mission/*` for detail), MCP stripped.
//!
//! # Status: OCCUPIED — the strip exists (Second Brain P6)
//!
//! The original `LibrarianCard.tsx`/`lib/librarian.ts` went when the Librarian
//! dissolved into `keeper.rs` (commit `9827088` added the agent and collapsed
//! the Polis panes in the same breath, so its checklist UI was never built),
//! and this module sat vacant until Memory-as-a-Second-Brain P6 gave it the
//! **Librarian attention strip** on the Memory surface's Health tab
//! (`LibrarianStrip` in `MemorySurface.tsx`, pure layer in
//! `src/lib/librarian.ts`): one Survey click runs `librarian_agent`, the
//! ranked checklist renders in place, and the last run persists locally. The
//! vacancy note argued the *role* was worth keeping because there were ever
//! more surfaces to be incoherent across — that is the role the strip renders.
//! Keeping the module through the vacancy also meant the Shipwright inherited
//! a working spawn/parse template instead of a deleted one — which it did.
//!
//! ## The three roles, once the Shipwright lands
//!
//! - **Keeper** *acts* on memory (auto-applies reversible ops on the idle tick,
//!   escalates destructive ones).
//! - **Shipwright** *advises* on code (`shipwright.rs`, `codehealth.rs`).
//! - **Librarian** *advises* on unreconciled work across every surface.
//!
//! ## Its ground truth: the seam between the agents and you
//!
//! Staged artifacts that were produced and never closed out — Spike-3a's F1/F3/F7
//! extended to every surface that has appeared since:
//!
//! | signal | accessor |
//! |---|---|
//! | the gardener's queue depth (a fact, not friction since B3) | `LakeSignal::queued_proposals` |
//! | in-review sessions with unresolved comments | `in_review_friction()` (F3) |
//! | stale missions / browse + linked threads | `list_missions()` (F7) + `thread_stats` |
//! | pending draft suggestions | `draft_suggestions.status = 'pending'` |
//! | live observations | `class_observations` not retired |
//! | open code-review annotations | `review_annotations` unresolved, by round |
//! | the Shipwright's own open findings | `shipwright_findings.status = 'pending'` |
//!
//! Same contract as the Shipwright: a Rust digest computes every number, the
//! agent ranks with the cite-a-number discipline, and a signal with no backing
//! state is not emitted.
//!
//! ## Hard constraint: advisory only
//!
//! The Librarian must never direct, dispatch or steer another agent. That is the
//! Loop Orchestrator, which was built and **pulled on 2026-07-03 for exactly
//! this reason** (v1 parked on `feature/loop-orchestrator`). Coherence between
//! agents stays **declarative** — the precedent is
//! `claude_proc::mission_context_block`, where browse and linked *inherit* the
//! active mission's goal and orient toward it without anything driving them. The
//! Librarian may state what is unreconciled; it may not hand work out. The
//! reason is written down here so a later session doesn't relax it as an obvious
//! improvement.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::context::FrictionDigest;
use crate::db::Database;
use crate::ledger;

/// One prioritized next-action the Librarian surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChecklistItem {
    /// 1-based rank (most urgent = 1). Reassigned to list position if the model
    /// omits/duplicates it, so the UI always renders a clean 1..N.
    pub priority: i64,
    /// One of the Spike-3a friction categories (`stalled_review`,
    /// `unstructured_backlog`, `bulging_branch`, `aging_session`, `mission`,
    /// `source_trust`; the held-proposal category retired with the holds in
    /// B3) — free-form but expected.
    pub category: String,
    /// Short, number-carrying headline.
    pub title: String,
    /// One sentence: the specific next action.
    #[serde(default)]
    pub detail: String,
    /// Optional UI hint (`organize`, `open_session`, `export_bundle`, `none`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Optional magnitude (events / comments / days).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

/// The Librarian's whole output: a one-line read + the ranked checklist.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LibrarianResult {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/// Build the Librarian's first-turn prompt: the role, the ground-truth digest
/// (baked in), and the strict JSON output contract. Pure / testable.
pub fn build_librarian_prompt(digest_block: &str) -> String {
    let mut p = String::new();
    p.push_str(
        "You are Redline's on-demand Librarian — the friction-reduction agent whose \
         flagship duty is stewarding the prompt/context library (the hash-chained \
         lake and the ClassMemory catalog over it). Load your `librarian` skill for \
         the full contract (the priority order and the JSON output shape).\n\n\
         Below is a friction digest computed as GROUND TRUTH from Redline's own \
         database — treat every number as fact; do not re-derive it. You MAY read \
         the local bridge for detail (already permitted, read-only curl, no \
         approval): `curl -s http://127.0.0.1:7676/v1/context/overview`, \
         `/v1/memory/tree`, `/v1/memory/node/<id>`, `/v1/mission/active` — but the \
         digest is usually enough to rank well.\n\n",
    );
    p.push_str(digest_block);
    p.push_str(
        "\n## Your task\n\nEmit a prioritized next-actions checklist. Rank by the \
         priority order in your `librarian` skill (stalled in-review work first, then the unstructured-backlog \
         stewardship signal scaled by size, then taxonomy drift, then hygiene, then \
         informational), floating a lower category up only when its magnitude is \
         extreme. The gardener's queue (structural proposals waiting for a run) is a \
         FACT in the digest, never a friction item — it adjudicates itself. Emit only items that earn a line; a near-empty lake yields a \
         short, honest checklist. Never fabricate a signal the digest doesn't \
         carry — but note the digest now DOES carry the 'un-exported approved \
         plan' (F6) signal (real Phase-4 state), so surface it when present.\n\n\
         Return ONLY a JSON object (optionally in a ```json fence):\n\n\
         {\"summary\":\"<one-line read>\",\"checklist\":[\n  \
         {\"priority\":1,\"category\":\"stalled_review|unstructured_backlog|bulging_branch|aging_session|un_exported|mission|source_trust\",\"title\":\"<number-carrying headline>\",\"detail\":\"<one-sentence next action>\",\"action\":\"organize|open_session|export_bundle|none\",\"count\":<magnitude or omit>}\n]}\n",
    );
    p
}

/// Convenience: build the prompt straight from a digest.
pub fn build_librarian_prompt_from_digest(d: &FrictionDigest) -> String {
    build_librarian_prompt(&crate::context::render_digest_prompt_block(d))
}

// ---------------------------------------------------------------------------
// Output parsing (structured-JSON checklist)
// ---------------------------------------------------------------------------

/// Parse the Librarian's final message into a `LibrarianResult`. Tolerant like
/// `classmem::parse_proposals`: finds the first balanced `{…}` that parses and
/// carries a `checklist` array, drops malformed items, and normalizes priorities
/// to 1..N in list order. Pure.
pub fn parse_checklist(text: &str) -> LibrarianResult {
    let Some(obj) = extract_checklist_object(text) else {
        return LibrarianResult::default();
    };
    let summary = obj
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut checklist: Vec<ChecklistItem> = Vec::new();
    if let Some(arr) = obj.get("checklist").and_then(Value::as_array) {
        for v in arr {
            if let Some(item) = parse_item(v) {
                checklist.push(item);
            }
        }
    }
    // Normalize priorities to a clean 1..N in the order the model ranked them.
    for (i, item) in checklist.iter_mut().enumerate() {
        item.priority = (i + 1) as i64;
    }
    LibrarianResult { summary, checklist }
}

fn parse_item(v: &Value) -> Option<ChecklistItem> {
    // A title is required — an item with no headline is noise.
    let title = v
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let category = v
        .get("category")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unstructured_backlog")
        .to_string();
    let detail = v
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let action = v
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "none")
        .map(str::to_string);
    // count may arrive as a number or a numeric string.
    let count = match v.get("count") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    let priority = v.get("priority").and_then(Value::as_i64).unwrap_or(0);
    Some(ChecklistItem {
        priority,
        category,
        title,
        detail,
        action,
        count,
    })
}

/// First top-level `{…}` substring that parses as JSON and carries a `checklist`
/// key. Mirrors `classmem`'s extractor (kept local so the modules stay decoupled).
fn extract_checklist_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get("checklist").is_some() {
                        return Some(v);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn matching_brace(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (offset, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset);
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// The checklist producer — advisory lines become durable work items
// ---------------------------------------------------------------------------

/// Producers wave: every parsed `ChecklistItem` files a durable work item
/// instead of living only in the strip's local render. The rank maps onto
/// the P0-style priority column (rank 1 stays urgent 1, rank 2 normal 2,
/// deeper ranks settle at calm 3 — 0 is reserved for a human's own "drop
/// everything"); the category and detail ride the body. Provenance is
/// `origin_kind="librarian_run"` with NO origin id — a survey run has no
/// durable row, and the dedupe deliberately spans runs: the next survey
/// re-deriving the same backlog line skips it while an item with that exact
/// title still stands unclosed. The Librarian seat produced these, so its
/// `items_filed` moves by the count filed. Advisory-only stays true: filing
/// state directs no agent — the frontier is read, never dispatched, by this
/// module.
pub fn file_checklist_items(db: &Database, result: &LibrarianResult) -> usize {
    /// Ledger actor + seat whose `items_filed` accrues.
    const LIBRARIAN_ACTOR: &str = "librarian";
    let mut filed = 0usize;
    for item in &result.checklist {
        let priority = item.priority.clamp(1, 3);
        let mut body = format!("[{}] {}", item.category, item.detail.trim());
        if let Some(count) = item.count {
            body.push_str(&format!("\nMagnitude: {count}"));
        }
        if let Some(action) = item.action.as_deref() {
            body.push_str(&format!("\nSuggested surface action: {action}"));
        }
        match db.file_produced_work_item(
            &item.title,
            Some(&body),
            "task",
            "open",
            priority,
            "librarian_run",
            None, // no durable run id — dedupe spans runs by design
            None,
            None,
            LIBRARIAN_ACTOR,
        ) {
            Ok(Some(_)) => filed += 1,
            Ok(None) => {} // the same backlog line still stands from a prior run
            Err(e) => tracing::warn!(
                title = %item.title, error = %e,
                "failed to file a librarian checklist work item"
            ),
        }
    }
    if filed > 0 {
        if let Err(e) = db.upsert_seat_stat(LIBRARIAN_ACTOR, None, filed as i64) {
            tracing::warn!(error = %e, "failed to bump librarian items_filed");
        }
    }
    filed
}

// ---------------------------------------------------------------------------
// Spawn + drive (mirrors classmem::run_classifier)
// ---------------------------------------------------------------------------

/// The argv a Librarian spawn builds — pure, exposed so the resume-arg
/// construction is testable without spawning anything.
pub fn librarian_argv(prompt: String, prior: Option<&str>) -> Vec<String> {
    crate::claude_proc::bridge_args("librarian", prompt, prior)
}

/// Run the Librarian with its standing thread (P3 continuity): resume the
/// persisted `redline.seatThread.librarian` session so this run knows what
/// yesterday's survey said, persist the new session id on success, and fall
/// back to a fresh session (overwriting the stored id) if the resume fails.
/// Returns the final text + session id.
pub async fn run_librarian(
    db: &Database,
    cwd: &str,
    prompt: String,
) -> Result<(String, Option<String>), String> {
    crate::seat::run_with_thread("librarian", None, |prior| {
        run_librarian_once(db, cwd, prompt.clone(), prior)
    })
    .await
}

/// One Librarian attempt, headless to completion. Same tool surface /
/// MCP-stripped spawn as the classifier; the digest is baked into `prompt` so
/// the core loop never depends on the agent curling. Registers the prompt with
/// the agent-prompt guard first so the headless `-p` doesn't leak into the
/// lake via the global hook.
async fn run_librarian_once(
    db: &Database,
    cwd: &str,
    prompt: String,
    prior: Option<String>,
) -> Result<(String, Option<String>), String> {
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    ledger::register_agent_prompt(&prompt);
    let args = librarian_argv(prompt, prior.as_deref());
    let mut cmd = crate::claude_proc::claude_command_for_seat("librarian", &claude_bin);
    let mut child = cmd
        .current_dir(cwd)
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
                format!("failed to spawn the Librarian: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("Librarian stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Librarian stderr unavailable")?;

    let mut reader = BufReader::new(stdout).lines();
    let mut session: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    let mut meter = crate::meter::TurnMeter::new();
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Second pass over the same value — the ONE accounting rule. A
        // daemon seat has no pane to stream to, but it burns real tokens.
        meter.observe(&v);
        match classify_line(&v) {
            StreamLine::Init(sid) => session = Some(sid),
            StreamLine::Final { text, session_id } => {
                final_text = Some(text);
                if let Some(sid) = session_id {
                    session = Some(sid);
                }
            }
            StreamLine::Failed(msg) => errored = Some(msg),
            _ => {}
        }
    }
    // Booked before any error return: a failed pass spent its input tokens.
    crate::meter::book(db, "librarian", &meter);
    let mut errbuf = String::new();
    {
        let mut elines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = elines.next_line().await {
            if errbuf.len() < 2000 {
                errbuf.push_str(&l);
                errbuf.push('\n');
            }
        }
    }
    let _ = child.wait().await;
    if let Some(msg) = errored {
        return Err(msg);
    }
    match final_text {
        Some(t) => Ok((t, session)),
        None => Err(if errbuf.trim().is_empty() {
            "the Librarian produced no output".to_string()
        } else {
            format!("the Librarian failed: {}", errbuf.trim())
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_a_fenced_checklist_and_normalizes_priorities() {
        let text = r#"Here's my read:
```json
{"summary":"412 events unstructured; one stalled review.",
 "checklist":[
   {"priority":5,"category":"bulging_branch","title":"1 branch bulging at 140 links","detail":"Organize; the consolidation pass splits it.","action":"organize","count":140},
   {"priority":9,"category":"stalled_review","title":"15 comments unresolved 19 days","detail":"Open the redline plan and resolve them.","action":"open_session","count":15},
   {"category":"unstructured_backlog","title":"412 events unstructured","detail":"Run Organize.","action":"organize","count":412}
 ]}
```
That's it."#;
        let r = parse_checklist(text);
        assert_eq!(r.checklist.len(), 3);
        // Priorities normalized to 1..N in the ranked order the model gave.
        assert_eq!(r.checklist[0].priority, 1);
        assert_eq!(r.checklist[1].priority, 2);
        assert_eq!(r.checklist[2].priority, 3);
        assert_eq!(r.checklist[0].category, "bulging_branch");
        assert_eq!(r.checklist[1].count, Some(15));
        // Missing priority defaulted then normalized; action `organize` kept.
        assert_eq!(r.checklist[2].action.as_deref(), Some("organize"));
        assert!(r.summary.contains("412 events"));
    }

    #[test]
    fn drops_titleless_items_and_tolerates_prose_and_bad_json() {
        assert!(parse_checklist("no json here at all").checklist.is_empty());
        let text = r#"{"summary":"ok","checklist":[
          {"category":"mission","detail":"no title so dropped"},
          {"title":"   ","detail":"blank title dropped"},
          {"title":"Real item","category":"aging_session","action":"none","count":"7"}
        ]}"#;
        let r = parse_checklist(text);
        assert_eq!(r.checklist.len(), 1, "only the titled item survives");
        assert_eq!(r.checklist[0].title, "Real item");
        // action "none" is normalized away; numeric-string count is coerced.
        assert_eq!(r.checklist[0].action, None);
        assert_eq!(r.checklist[0].count, Some(7));
    }

    #[test]
    fn empty_checklist_is_a_valid_clean_workspace_answer() {
        let r = parse_checklist(r#"{"summary":"All clear.","checklist":[]}"#);
        assert!(r.checklist.is_empty());
        assert_eq!(r.summary, "All clear.");
    }

    /// P3 continuity: a stored thread rides the argv as a terminal `--resume`;
    /// a fresh run carries none. Pure over the built argv — no spawn.
    #[test]
    fn resume_arg_construction_is_terminal_and_optional() {
        let _guard = crate::seat::store_guard();
        let args = librarian_argv("p".to_string(), Some("sid-9"));
        let i = args.iter().position(|a| a == "--resume").expect("--resume present");
        assert_eq!(args[i + 1], "sid-9");
        assert_eq!(i + 2, args.len(), "the resume tail stays terminal");
        let fresh = librarian_argv("p".to_string(), None);
        assert!(!fresh.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn prompt_bakes_the_digest_and_states_the_contract() {
        let p = build_librarian_prompt("## Friction digest (GROUND TRUTH)\n- backlog: 42\n");
        assert!(p.contains("GROUND TRUTH"));
        assert!(p.contains("backlog: 42"));
        assert!(p.contains("\"checklist\""));
        assert!(p.contains("librarian` skill"));
        // Never invites fabricating the deferred signal.
        assert!(p.contains("un-exported"));
    }

    // --- the checklist producer ---------------------------------------------

    fn checklist(items: &[(i64, &str, &str)]) -> LibrarianResult {
        LibrarianResult {
            summary: "survey".to_string(),
            checklist: items
                .iter()
                .map(|(priority, category, title)| ChecklistItem {
                    priority: *priority,
                    category: category.to_string(),
                    title: title.to_string(),
                    detail: "do the thing".to_string(),
                    action: Some("organize".to_string()),
                    count: Some(7),
                })
                .collect(),
        }
    }

    #[test]
    fn checklist_items_file_with_run_provenance_and_mapped_priority() {
        let db = Database::open_in_memory().unwrap();
        let result = checklist(&[
            (1, "bulging_branch", "1 branch bulging at 140 links"),
            (5, "unstructured_backlog", "412 events unstructured"),
        ]);
        assert_eq!(file_checklist_items(&db, &result), 2);
        let items = db.list_work_items(None, None, 50).unwrap();
        assert_eq!(items.len(), 2);
        let urgent = items
            .iter()
            .find(|i| i.title == "1 branch bulging at 140 links")
            .unwrap();
        assert_eq!(urgent.priority, 1, "rank 1 stays urgent");
        assert_eq!(urgent.origin_kind.as_deref(), Some("librarian_run"));
        assert_eq!(urgent.origin_id, None, "a survey run has no durable id");
        assert_eq!(urgent.kind, "task");
        assert_eq!(urgent.status, "open");
        let body = urgent.body.as_deref().unwrap();
        assert!(body.contains("[bulging_branch]"), "category rides the body");
        assert!(body.contains("Magnitude: 7"));
        let calm = items
            .iter()
            .find(|i| i.title == "412 events unstructured")
            .unwrap();
        assert_eq!(calm.priority, 3, "deep ranks settle at calm 3");
        // The seat's items_filed became real.
        assert_eq!(db.get_seat_stat("librarian").unwrap().items_filed, 2);
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn rederiving_the_same_backlog_dedupes_against_still_open_items() {
        let db = Database::open_in_memory().unwrap();
        let run1 = checklist(&[(1, "bulging_branch", "1 branch bulging at 140 links")]);
        assert_eq!(file_checklist_items(&db, &run1), 1);
        // The next survey re-derives the same line (rank drifted — the title
        // is the stable key): nothing re-files while the item stands open.
        let run2 = checklist(&[
            (2, "bulging_branch", "1 branch bulging at 140 links"),
            (1, "stalled_review", "15 comments unresolved 19 days"),
        ]);
        assert_eq!(file_checklist_items(&db, &run2), 1, "only the new line files");
        assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 2);
        // Close the standing item and the SAME line may honestly recur.
        let id = db
            .find_unclosed_work_item("librarian_run", None, Some("1 branch bulging at 140 links"))
            .unwrap()
            .unwrap()
            .id;
        db.close_work_item(&id, Some("done"), ledger::now_millis())
            .unwrap();
        assert_eq!(file_checklist_items(&db, &run1), 1);
        // items_filed accumulated across the three filings.
        assert_eq!(db.get_seat_stat("librarian").unwrap().items_filed, 3);
    }

    #[test]
    fn an_empty_checklist_files_nothing_and_touches_no_seat() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(file_checklist_items(&db, &LibrarianResult::default()), 0);
        assert!(db.list_work_items(None, None, 50).unwrap().is_empty());
        assert!(db.get_seat_stat("librarian").is_none());
    }
}

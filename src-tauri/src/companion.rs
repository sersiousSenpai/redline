// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **Companion**: one global discussion agent that follows the user across
//! EVERY surface of the app — plan reviews, the Prompt Drafter, the embedded
//! browser, missions, code review. Where a linked discussion (`linked.rs`)
//! spans browser *tabs*, the Companion spans *surfaces*; it is the app-wide
//! spanning conversation.
//!
//! Mirrors linked.rs structurally (keyed registry, fresh process per turn via
//! `bridge_args`, DB-persisted resumable session, `companion-*` events), with
//! two load-bearing differences:
//!
//! 1. **The frontend passes NOTHING about location.** `companion_send` reads
//!    the mirrored `ActiveSurface` cell itself, so every turn is grounded on
//!    where the user actually is.
//! 2. **Passive awareness is the context journal, not a ticking agent.** The
//!    backend journals meaningful activity as it happens (surface switches,
//!    revisions, navs, pins, verdicts, agent turns); each Companion turn is
//!    prefixed with the delta since its last turn ("while you were away") —
//!    identical warmth to a background watcher at zero background token cost.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::browse::{is_context_overflow, is_transient};
use crate::claude_proc::{
    bridge_args_with_flags, classify_line, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::{Database, JournalRow};
use crate::state::{now_millis, Companion, CompanionMessage};
use crate::turn::{self, PartialBuf, QueuedTurn, SendOutcome, SendSlot, TurnStatus, Turns};
use crate::SurfaceInfo;

/// How many completed assistant turns a chat's CLI session may accumulate
/// before it rotates onto a fresh one, carrying a clipped recap.
///
/// `--resume` replays the ENTIRE transcript on every spawn, so per-turn latency
/// climbs with the conversation's length. A brainstorm is the longest-running
/// thread in the app, which makes this the surface that needs the bound most:
/// before it, the only bound was reactive — run until the model's context
/// overflowed, then wipe. Ported wholesale from `memchat.rs`.
const ROTATE_AFTER_ASSISTANT_TURNS: i64 = 12;

/// How many recent exchanges a rotation carries forward, and how much of each.
const RECAP_EXCHANGES: usize = 3;
const RECAP_BODY_CHARS: usize = 400;

/// Everything a queued chat send needs to start later. Deliberately only the
/// two things that are TRUE AT ENQUEUE TIME — what the user typed, and the
/// working directory their window is pointed at. Everything else (the resumable
/// session, the journal watermark, the ledger row, the surface they are on) is
/// a START-time fact and is read inside `start_companion_turn`; see the comment
/// there for why capturing them here would be wrong.
pub struct QueuedCompanionSend {
    text: String,
    cwd: Option<String>,
    /// `"plan" | "drafter"` when this turn is a graduation: its reply IS the
    /// brief to hand onward.
    handoff: Option<String>,
}

/// Registry of running companion turns, keyed by `companion_id`, on the
/// shared `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct CompanionState {
    turns: Arc<Turns<QueuedCompanionSend>>,
    /// The in-flight turn's graduation target per chat, armed after a
    /// successful spawn and taken exactly once at terminal time — the mission
    /// orchestrator's `pending_synthesize` idiom, so an errored or cancelled
    /// handoff can never leave the flag armed for an unrelated later turn.
    pending_handoff: Arc<Mutex<HashMap<String, String>>>,
    db: Arc<Database>,
    claude_bin: Arc<OnceLock<String>>,
}

impl CompanionState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
            pending_handoff: Arc::new(Mutex::new(HashMap::new())),
            db,
            claude_bin: Arc::new(OnceLock::new()),
        }
    }

    async fn claude_bin(&self) -> Result<String, String> {
        let cell = self.claude_bin.clone();
        tokio::task::spawn_blocking(move || cell.get_or_init(resolve_claude_bin).clone())
            .await
            .map_err(|e| format!("failed to resolve the `claude` CLI: {e}"))
    }

    /// Whether a turn is streaming for this chat. Consumed by the consult
    /// dispatch, where a busy target is the self-consult guard.
    pub fn is_running(&self, companion_id: &str) -> bool {
        self.turns.is_running(companion_id)
    }

    /// Kill every running companion turn. Backs app teardown.
    pub fn kill_all(&self) {
        self.turns.kill_all();
    }
}

// --- Event payloads ----------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionDelta {
    companion_id: String,
    text: String,
    /// This delta's position in the turn's stream — `companion_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionDone {
    companion_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionError {
    companion_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionCancelled {
    companion_id: String,
}

/// A queued send left the queue and became the streaming turn — the frontend
/// flips its bubble's "Queued" chip off.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionQueueAdvanced {
    companion_id: String,
    message_id: String,
}

/// What the agent is retrieving right now. Without it the working indicator
/// sits blank through the part of a turn where the most is actually happening
/// — the exact channel `MemoryAsk` already consumes for the Ask surface.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionStatus {
    companion_id: String,
    label: String,
}

/// The completed reply WAS the brief — this chat is graduating into a plan
/// session or a Drafter document. Emitted alongside `companion-done`, and
/// listened for at App level (not in the room): the user may have switched
/// surfaces while the distillation ran, and the handoff must survive that
/// unmount. Mirrors `mission-synthesize-done`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionHandoffDone {
    companion_id: String,
    /// `"plan"` or `"drafter"`.
    target: String,
    markdown: String,
}

// --- Surface + journal rendering ----------------------------------------------

/// One-line "where the user is" descriptor from the mirrored ActiveSurface —
/// the Companion's analog of linked's `TabContext::describe()`.
pub fn describe_surface(s: &SurfaceInfo) -> String {
    let label = s.label.as_deref().unwrap_or("").trim();
    let detail = s.detail.as_deref().unwrap_or("").trim();
    let named = |what: &str| -> String {
        match (label.is_empty(), detail.is_empty()) {
            (false, false) => format!("{what} — {label} ({detail})"),
            (false, true) => format!("{what} — {label}"),
            (true, false) => format!("{what} ({detail})"),
            (true, true) => what.to_string(),
        }
    };
    match s.kind.as_str() {
        "plan" => named("the plan review"),
        "drafter" => named("the Prompt Drafter"),
        "browser" => named("the embedded browser"),
        "review" => named("the code review"),
        "chat" => named("a chat room"),
        "servers" => named("the Localhost grid"),
        "memory" => named("their organized memory"),
        "runs" => named("the run monitor"),
        "terminal" => named("the terminal"),
        _ => "the welcome screen".to_string(),
    }
}

/// Render the journal delta as a compact "While you were away" block:
/// one line per event, consecutive `nav` rows grouped ("browsed N pages,
/// ending at …"), byte-bounded (oldest lines dropped first — the tail is the
/// most relevant context). Empty string when there's nothing new.
pub fn render_journal_delta(rows: &[JournalRow], max_bytes: usize) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < rows.len() {
        let r = &rows[i];
        if r.kind == "nav" {
            // Group a run of navigations into one line.
            let mut j = i;
            while j + 1 < rows.len() && rows[j + 1].kind == "nav" {
                j += 1;
            }
            let last = &rows[j];
            let count = j - i + 1;
            let dest = last
                .label
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .or(last.detail.as_deref())
                .unwrap_or("a page");
            if count == 1 {
                lines.push(format!("- browsed to {dest}"));
            } else {
                lines.push(format!("- browsed {count} pages, ending at {dest}"));
            }
            i = j + 1;
            continue;
        }
        let label = r.label.as_deref().filter(|s| !s.trim().is_empty());
        let detail = r.detail.as_deref().filter(|s| !s.trim().is_empty());
        let surface = r.surface_kind.as_deref().unwrap_or("");
        let line = match r.kind.as_str() {
            "surface_switch" => match label {
                Some(l) => format!("- moved to the {surface} — {l}"),
                None => format!("- moved to the {surface}"),
            },
            "revision" => format!(
                "- a plan revision arrived{}{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
                detail.map(|d| format!(" ({d})")).unwrap_or_default(),
            ),
            "approval" => "- a plan was approved".to_string(),
            "review_start" => format!(
                "- a code review opened{}{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
                detail.map(|d| format!(" ({d})")).unwrap_or_default(),
            ),
            "review_verdict" => format!(
                "- a review verdict landed{}",
                label.map(|l| format!(" ({l})")).unwrap_or_default(),
            ),
            "mission_pin" => format!(
                "- pinned a finding{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
            ),
            "mission_active" => format!(
                "- a mission became active{}",
                label.map(|l| format!(" — {l}")).unwrap_or_default(),
            ),
            "drafter_launch" => "- launched a drafted prompt into a plan session".to_string(),
            "agent_turn" => format!("- the {surface} agent completed a turn"),
            other => format!("- {other}"),
        };
        lines.push(line);
        i += 1;
    }
    // Byte-bound, keeping the tail (most recent activity wins).
    let mut kept: Vec<&String> = Vec::new();
    let mut total = 0usize;
    for line in lines.iter().rev() {
        total += line.len() + 1;
        if total > max_bytes && !kept.is_empty() {
            break;
        }
        kept.push(line);
    }
    let dropped = lines.len() - kept.len();
    let mut out = String::from("WHILE YOU WERE AWAY — what the user did since your last turn:\n");
    if dropped > 0 {
        out.push_str(&format!("- (…{dropped} earlier events elided)\n"));
    }
    for line in kept.iter().rev() {
        out.push_str(line);
        out.push('\n');
    }
    out
}

// --- Prompt builders -----------------------------------------------------------

/// The cross-surface map + consult + staged-write contract. `pub(crate)`
/// because the voice agent embeds this verbatim too (the Companion's scope
/// folded into voice — one contract, two mouths, no drift).
pub(crate) fn routes_block() -> &'static str {
    "YOUR MAP AND GLANCE ROUTES — all local, already permitted (no approval \
     needed; put the URL immediately after `-s`):\n\
     - Every agent and thread across the app (who exists, what's busy, what's \
     consultable):\n  \
     curl -s http://127.0.0.1:7676/v1/global/agents\n\
     - Where the user is right now:\n  \
     curl -s http://127.0.0.1:7676/v1/surface/active\n\
     - Activity since a journal seq (your awareness feed, mid-conversation):\n  \
     curl -s 'http://127.0.0.1:7676/v1/journal/recent?since_seq=<n>'\n\
     - Any surface's discussion thread (browse / linked / mission / drafter / \
     companion / a plan session's comment threads):\n  \
     curl -s 'http://127.0.0.1:7676/v1/context/threads/<kind>/<id>'\n\
     - The session tree around a node (its parent + children with recency):\n  \
     curl -s 'http://127.0.0.1:7676/v1/context/tree/<kind>/<id>'\n\
     - A plan session's full history (revisions, comments, decisions):\n  \
     curl -s http://127.0.0.1:7676/v1/context/sessions/<id>/history\n\
     - The browser: /v1/browser/tabs, /v1/browser/snapshot?tab=<n>, \
     /v1/browser/thread?tab=<n>\n\
     - THE USER'S RECORD — start here for anything about what they decided, \
     researched or built. ONE batched read answers most such questions; it \
     returns the resolved class with its children, links (each with \
     `supersededBy`), observations, plus their notes, matching prompts and \
     matching pages. Read the pack, then ANSWER:\n  \
     curl -s 'http://127.0.0.1:7676/v1/memory/answer-pack?q=<term>&node=<id>'\n\
     Reach for the granular routes only when the pack is genuinely \
     insufficient — literals a word index cannot hold (a flag, a path, an \
     error string; `q` is a substring, 3+ chars), then the tree walk:\n  \
     curl -s 'http://127.0.0.1:7676/v1/memory/grep?q=--allowedTools'\n\
     /v1/memory/tree, /v1/memory/node/<id>, /v1/memory/prompts?node=<id>\n\
     - Filtered prompt history: /v1/context/prompts?thread_kind=&thread_id=&\
     parent_session=&session=&q=\n\n\
     CHECK IN WITH A COLLEAGUE. Every surface has its own agent holding its \
     full context — don't re-derive what a colleague already knows. Delegate a \
     synthesis and fold back only the digest (this is a write route — the two \
     `--variable`/`--expand-header` flags shown import the bearer token \
     straight from your environment; never write `$REDLINE_DAEMON_TOKEN` into \
     the command yourself, and note this needs curl >= 8.3):\n  \
     curl -s http://127.0.0.1:7676/v1/global/consult \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"surface\":\"<browse|plan|mission|linked|drafter>\",\"id\":\"<its id \
     — for browse, the tab number>\",\"question\":\"<what you need synthesized>\"}'\n\
     The response is {\"digest\":\"...\",\"surface\":\"...\",\"label\":\"...\"}. \
     A GLANCE (a fact, a title) you do yourself via the read routes above; a \
     SYNTHESIS you delegate. \"busy\" means retry-or-glance, not failure. Voice \
     sessions have no consult — read /v1/context/threads/voice/<id> instead.\n\n\
     WRITES — ONLY AT THE USER'S DIRECTION. When the user explicitly asks you \
     to capture something, you can create STAGED, REVIEWABLE artifacts — each \
     lands in the UI for their review, never as a silent change. If the target \
     is ambiguous (which plan, which draft), confirm in one line first. Every \
     write carries the same two flags shown, which import the bearer token \
     from your environment.\n\
     - An action item / feedback comment on a plan (fetch the plan first for a \
     blockId — anchor section-level feedback to a heading block):\n  \
     curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan\n  \
     curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/comments \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"blockId\":\"<the blockId>\",\"body\":\"<the item, in the user's \
     words>\",\"agentId\":\"companion\"}'\n\
     - A tracked suggestion in a Prompt Drafter document (read the doc first; \
     ops append | replace_block | insert_after | delete_block anchor on the \
     doc's current block ids and `original` bodies — a 409 means stale: \
     re-read and retry, exactly the drafter skill's contract):\n  \
     curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/doc\n  \
     curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/suggestions \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"op\":\"<op>\",\"block_id\":\"<anchor>\",\"original\":\"<current block \
     markdown, for replace/delete>\",\"markdown\":\"<new content>\",\
     \"agent_id\":\"companion\"}'\n\
     - A code-review annotation (a note on the open review's diff):\n  \
     curl -s 'http://127.0.0.1:7676/v1/reviews/annotations?repo=<repo_path>' \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"file_path\":\"<path>\",\"side\":\"new\",\"quoted\":\"<the exact \
     line(s)>\",\"body\":\"<the note>\",\"source\":\"companion\"}'\n\
     - A memory proposal (stage a filing into the user's organized memory — \
     staging only, they accept or reject it in the inspector):\n  \
     curl -s http://127.0.0.1:7676/v1/memory/proposals \
     --variable %REDLINE_DAEMON_TOKEN= \
     --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" -X POST \
     -H 'Content-Type: application/json' \
     -d '{\"proposals\":[{\"op\":\"file\",\"prompt_id\":<id>,\"node\":\"<class \
     path>\",\"reason\":\"<why>\"}]}'\n\
     NEVER: /v1/browser/* writes (the browser is the user's hands), plan \
     suggestions (/v1/sessions/<id>/suggestions — plan revision belongs to \
     that session's own claude), file edits, producing a plan, or \
     ExitPlanMode.\n"
}

/// The per-turn "where the user is" line, with the surface's id appended —
/// the write routes key on it (session id, draft id), so handing it over
/// saves the agent a curl round-trip through /v1/surface/active.
///
/// SELF-REFERENCE GUARD. A chat room is itself a surface, so the agent's own
/// room is what `ActiveSurface` reports for most of a conversation. Handing it
/// `[surface id: <its own thread>]` would offer its own conversation as a
/// write target — a read it can only act on wrongly. When the active surface IS
/// this chat, say so plainly and emit no id at all.
fn surface_line(surface: &SurfaceInfo, self_id: &str) -> String {
    if surface.kind == "chat" && surface.id.as_deref() == Some(self_id) {
        return "this chat — the room you are in (there is no other surface \
                open, and nothing here to write to)"
            .to_string();
    }
    let mut line = describe_surface(surface);
    if let Some(id) = surface.id.as_deref().filter(|s| !s.trim().is_empty()) {
        line.push_str(&format!(" [surface id: {id}]"));
    }
    line
}

/// Completed assistant turns on a thread — the unit the rotation budget counts
/// in (a queued, unsent or errored row is not a turn the CLI will replay).
fn completed_assistant_turns(thread: &[CompanionMessage]) -> i64 {
    thread
        .iter()
        .filter(|m| m.role == "assistant" && m.status == "complete")
        .count() as i64
}

/// The recap a rotated conversation carries across: the last few exchanges,
/// bodies clipped. Bounded on purpose — the point of rotating is to stop
/// replaying an ever-growing transcript, so carrying the whole thing forward
/// would defeat it. The UI's history is untouched either way; only the CLI
/// session rotates, so the user never sees a seam.
fn build_recap(thread: &[CompanionMessage]) -> String {
    let recent: Vec<&CompanionMessage> = thread
        .iter()
        .filter(|m| m.status == "complete" && !m.body.trim().is_empty())
        .rev()
        .take(RECAP_EXCHANGES * 2)
        .collect();
    if recent.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\nCONVERSATION SO FAR — rotated for speed. This thread continues an \
         earlier conversation; the exchanges below are its tail, clipped. Treat \
         any fact in them as needing re-verification against the record before \
         you rely on it.\n\n",
    );
    for m in recent.into_iter().rev() {
        let who = if m.role == "user" { "They said" } else { "You said" };
        let body: String = m.body.replace('\n', " ").chars().take(RECAP_BODY_CHARS).collect();
        let ellipsis = if m.body.chars().count() > RECAP_BODY_CHARS { "…" } else { "" };
        out.push_str(&format!("- {who}: {body}{ellipsis}\n"));
    }
    out
}

/// Drop the resumable CLI session so the next turn starts cold, and move the
/// rotation mark to where the new session begins. ONE helper for both triggers
/// — the proactive rotation above the turn budget and the reactive reset when a
/// turn dies of context overflow — so the two can never drift in what they
/// clear.
///
/// The mark is a COLUMN on the chat's own row, not an `app_settings` key:
/// chats are not a singleton (memchat's mark can be, because Ask is), and a
/// per-thread mark that dies with its row can never be inherited by a
/// recreated thread — the "count above its own turn count, never rotates
/// again" bug memchat has to clear by hand.
fn reset_companion_session(db: &Database, companion_id: &str, at_turns: i64) {
    if let Err(e) = db.clear_companion_session(companion_id) {
        tracing::warn!(error = %e, "failed to clear the chat CLI session");
    }
    let _ = db.set_companion_rotated_at(companion_id, at_turns);
}

/// Everything a first turn is grounded on besides the invariant contract. One
/// struct rather than five positional `Option<&str>`s: the ordering below is a
/// tested contract (catalog < recap < evidence < question), and five bare
/// options at a call site is how that ordering gets silently permuted.
#[derive(Default)]
pub struct FirstTurnGround<'a> {
    /// The user's accepted class catalog, baked in so the opening move can be
    /// an answer rather than a tree walk.
    pub catalog: Option<&'a str>,
    /// Carried across a CLI-session rotation.
    pub recap: Option<&'a str>,
    /// Server-side answer-pack for this question — the batched read the agent
    /// would otherwise have spent a whole model turn making.
    pub prefetch: Option<&'a str>,
    /// The active mission's `(title, goal)`.
    pub mission: Option<(&'a str, &'a str)>,
}

/// First turn: the spanning-app role, where the user is, the journal delta,
/// the map + consult contract, mission inheritance, the user's record (catalog
/// + prefetched evidence), and their message.
pub fn build_first_turn_prompt(
    surface: &SurfaceInfo,
    self_id: &str,
    journal_delta: &str,
    user_text: &str,
    ground: &FirstTurnGround<'_>,
) -> String {
    // CACHE-STABLE ORDERING — ALL invariant text (role intro, skill
    // reference, routes, the formatting/write contract) forms one stable
    // prefix; every variable section (mission, surface, journal delta, user
    // text) comes after it. Same information, pinned order — two first turns
    // share a byte-identical cacheable prefix. Guarded by
    // `first_turn_invariant_prefix_is_byte_stable`.
    let mut p = String::from(
        "You are the user's COMPANION in Redline: ONE continuous discussion that \
         follows them across every surface of the app — plan reviews, the Prompt \
         Drafter, the embedded browser, research missions, code reviews. You are \
         not bound to any surface and you carry no goal of your own; you are the \
         spanning conversation and the colleague who always knows where they've \
         been. Each turn tells you where they are now; weave continuity across \
         everything you've seen, referring back to earlier surfaces by name.\n\n\
         Follow your `companion` skill if you have it.\n\n",
    );
    p.push_str(routes_block());
    p.push_str(
        "\nPREFETCHED EVIDENCE — a turn may arrive with a `PREFETCHED EVIDENCE` \
         block below, assembled server-side from the user's message before you \
         were spawned. It is the same batched read you would have made, already \
         done. READ IT FIRST, and if it answers the question, ANSWER — do not \
         curl. It states what it searched, what it resolved and on what basis, \
         and whether anything was TRIMMED. Its absence means the message \
         produced no search terms, not that the record is empty.\n\n\
         FORMATTING — your replies render through Redline's markdown pipeline \
         (tables, strict-mode mermaid, fenced code, callouts). Never raw HTML. \
         You observe by default and WRITE only at the user's explicit \
         direction, through the write routes above — everything you write is a \
         staged, reviewable artifact, never a silent change; confirm an \
         ambiguous target in one line first. Never edit files, never produce a \
         plan, never call ExitPlanMode.\n\n",
    );
    // --- variable content below; nothing invariant may follow ---
    p.push_str(&mission_context_block(ground.mission));
    p.push_str(&format!(
        "The user is currently on {}.\n\n",
        surface_line(surface, self_id)
    ));
    if !journal_delta.trim().is_empty() {
        p.push_str(journal_delta.trim());
        p.push_str(
            "\n\nAbsorb that silently — it is ground truth of what happened, not \
             something to recite back unless asked.\n\n",
        );
    }
    // Catalog, then recap, then evidence, then the question — the evidence sits
    // closest to what it answers, and the recap between the catalog and the
    // question exactly as `memchat.rs` pins it.
    if let Some(catalog) = ground.catalog.filter(|c| !c.trim().is_empty()) {
        p.push_str(
            "THEIR CATALOG (a snapshot — advisory; verify with the node route \
             when you need current links):\n\n",
        );
        p.push_str(catalog);
        if !catalog.ends_with('\n') {
            p.push('\n');
        }
        p.push('\n');
    }
    if let Some(recap) = ground.recap.filter(|r| !r.trim().is_empty()) {
        p.push_str(recap);
        if !recap.ends_with('\n') {
            p.push('\n');
        }
        p.push('\n');
    }
    if let Some(prefetch) = ground.prefetch.filter(|b| !b.trim().is_empty()) {
        p.push_str(prefetch);
        if !prefetch.ends_with('\n') {
            p.push('\n');
        }
        p.push('\n');
    }
    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

/// Follow-up: re-ground on the current surface + the journal delta since the
/// last turn. The resumed session already carries the role and the routes.
pub fn build_followup_prompt(
    surface: &SurfaceInfo,
    self_id: &str,
    journal_delta: &str,
    user_text: &str,
) -> String {
    let mut p = format!("The user is now on {}.\n\n", surface_line(surface, self_id));
    if !journal_delta.trim().is_empty() {
        p.push_str(journal_delta.trim());
        p.push_str("\n\n");
    }
    p.push_str("The user says:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

// --- CRUD commands -------------------------------------------------------------

#[tauri::command]
pub fn companion_create(
    companion: tauri::State<'_, CompanionState>,
    title: Option<String>,
) -> Result<Companion, String> {
    let now = now_millis();
    let title = title
        .map(|t| t.trim().chars().take(80).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Companion".to_string());
    let c = Companion {
        companion_id: uuid::Uuid::new_v4().to_string(),
        title,
        status: "active".to_string(),
        created_at: now,
        updated_at: now,
        // A fresh chat inherits the `companion` seat; the chip sets an override.
        model: None,
        effort: None,
        // The title a chat is created with is PROVISIONAL — the first sentence
        // of a half-formed thought, not a name. The auto-titling pass replaces
        // it once the first reply lands; a user rename latches this.
        title_is_user_set: false,
    };
    companion
        .db
        .insert_companion(&c)
        .map_err(|e| format!("failed to create companion: {e}"))?;
    Ok(c)
}

#[tauri::command]
pub fn companion_list(
    companion: tauri::State<'_, CompanionState>,
) -> Result<Vec<Companion>, String> {
    companion
        .db
        .list_companions()
        .map_err(|e| format!("failed to list companions: {e}"))
}

#[tauri::command]
pub fn companion_get_thread(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<Vec<CompanionMessage>, String> {
    companion
        .db
        .load_companion_thread(&companion_id)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Rename a chat. `by_user` is the latch the auto-titling pass respects — a
/// name the user typed is never overwritten by a model's proposal.
#[tauri::command]
pub fn companion_rename(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
    title: String,
    by_user: Option<bool>,
) -> Result<(), String> {
    let title: String = title.trim().chars().take(80).collect();
    if title.is_empty() {
        return Err("a chat needs a name".to_string());
    }
    companion
        .db
        .set_companion_title(&companion_id, &title, by_user.unwrap_or(true))
        .map(|_| ())
        .map_err(|e| format!("failed to rename: {e}"))
}

/// Set (or clear) this chat's per-conversation model/effort override.
///
/// `model` is validated STRICTLY and `effort` permissively, because the CLI
/// treats them differently: a bad `--model` fails the spawn outright, where a
/// bad `--effort` only warns. Refusing a model here turns a dead turn into a
/// dialog that never opens; refusing an effort would only block forward
/// compatibility with a level a new model adds.
#[tauri::command]
pub fn companion_set_model(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    fn clean(v: Option<String>) -> Option<String> {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    let model = clean(model);
    let effort = clean(effort);
    if let Some(m) = model.as_deref() {
        if !crate::seat::MODEL_OPTIONS.contains(&m) {
            return Err(format!(
                "unknown model `{m}` — one of {}",
                crate::seat::MODEL_OPTIONS.join(", ")
            ));
        }
    }
    if let Some(e) = effort.as_deref() {
        if !crate::seat::EFFORT_OPTIONS.contains(&e) {
            tracing::warn!(effort = %e, "chat: unrecognized effort level, passing it through");
        }
    }
    companion
        .db
        .set_companion_seat(&companion_id, model.as_deref(), effort.as_deref())
        .map_err(|e| format!("failed to set the model: {e}"))
}

#[tauri::command]
pub fn companion_delete(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<(), String> {
    // `discard`, not `take`: queued sends target a conversation that is about
    // to stop existing, so the queue goes with the proc.
    if let Some(mut child) = companion.turns.discard(&companion_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    companion.pending_handoff.lock().unwrap().remove(&companion_id);
    // Nothing else to clean up: the rotation mark is a column on the row this
    // deletes, so a recreated chat cannot inherit it.
    companion
        .db
        .delete_companion(&companion_id)
        .map_err(|e| format!("failed to delete companion: {e}"))
}

// --- Chat ------------------------------------------------------------------

/// How many journal bytes a turn preamble may spend. Breadcrumbs, not content.
const JOURNAL_DELTA_MAX_BYTES: usize = 4_000;
const JOURNAL_DELTA_MAX_ROWS: i64 = 300;

/// Send a turn. The frontend passes only the text — the backend grounds the
/// turn on the mirrored ActiveSurface and the journal delta itself, then
/// advances the chat's journal high-water mark. Streaming happens via
/// `companion-*` events; this returns once the child is spawned, or with
/// `queued: true` when the send opted in (`queue`) and landed behind an
/// in-flight turn.
// Eight arguments: two managed cells, the app handle, and the send's own five.
// The same shape (and, elsewhere, the same tolerated warning) as every other
// surface's send.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn companion_send(
    companion: tauri::State<'_, CompanionState>,
    active_surface: tauri::State<'_, crate::ActiveSurface>,
    app: AppHandle,
    companion_id: String,
    text: String,
    cwd: Option<String>,
    // `"plan"` / `"drafter"` when this turn is a graduation: its reply IS the
    // brief. (A plain comment, not a doc comment — Rust forbids those on a
    // function parameter.)
    handoff: Option<String>,
    queue: Option<bool>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let payload = QueuedCompanionSend {
        text: text.clone(),
        cwd,
        handoff,
    };
    // The user row is tagged with where they were WHEN THEY TYPED IT, which is
    // the fact the bubble reports — unlike the prompt's "where they are now",
    // which is a start-time fact and is read again inside the starter.
    let surface = active_surface.get();

    // Atomic reservation; early `?` returns release it via the guard's Drop.
    // Only opted-in sends queue — the busy error stays for everything else.
    let (slot, payload) = if queue.unwrap_or(false) {
        let turn = QueuedTurn {
            message_id: message_id.clone(),
            text: text.clone(),
            queued_at: now_millis(),
        };
        match companion.turns.begin_or_enqueue(&companion_id, turn, payload) {
            SendSlot::Began(slot, payload) => (slot, payload),
            SendSlot::Enqueued => {
                // Persist the queued user row so a remount restores the
                // bubble; the reader's drain flips it to `complete`.
                let user_msg = CompanionMessage {
                    id: message_id.clone(),
                    companion_id,
                    role: "user".to_string(),
                    body: text,
                    status: "queued".to_string(),
                    surface_kind: Some(surface.kind.clone()),
                    surface_id: surface.id.clone(),
                    surface_label: surface.label.clone(),
                    created_at: now_millis(),
                };
                companion
                    .db
                    .insert_companion_message(&user_msg)
                    .map_err(|e| format!("failed to persist message: {e}"))?;
                return Ok(SendOutcome {
                    started: false,
                    queued: true,
                    message_id,
                });
            }
            SendSlot::QueueFull => {
                return Err("the queue is full — wait for the current reply".to_string())
            }
        }
    } else {
        let slot = companion
            .turns
            .begin(&companion_id)
            .map_err(|_| "the chat is still replying".to_string())?;
        (slot, payload)
    };

    let user_msg = CompanionMessage {
        id: message_id.clone(),
        companion_id: companion_id.clone(),
        role: "user".to_string(),
        body: text,
        status: "complete".to_string(),
        surface_kind: Some(surface.kind.clone()),
        surface_id: surface.id.clone(),
        surface_label: surface.label.clone(),
        created_at: now_millis(),
    };
    companion
        .db
        .insert_companion_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    start_companion_turn(app, companion.inner().clone(), companion_id, payload, slot).await?;
    Ok(SendOutcome {
        started: true,
        queued: false,
        message_id,
    })
}

/// Everything a turn needs after its user row is persisted: rotation, the
/// journal delta, retrieval prefetch, prompt framing, ledger capture, spawn,
/// attach, reader. Runs on the direct send path AND on the reader's queue
/// drain. Boxed return: see `turn::BoxStartFuture`.
///
/// WHAT IS READ HERE, AND WHY IT CANNOT BE READ AT ENQUEUE TIME. Three facts
/// used to be gathered before the spawn on the one and only send path, and all
/// three are START-time facts — a queued turn that captured them when the user
/// pressed ⏎ would be wrong by the time it actually ran:
///
///  * the resumable session id — turn N−1 may have minted or ROTATED it, and
///    resuming a session that no longer exists loses the conversation;
///  * the journal watermark — a stale one replays a "while you were away"
///    delta the previous turn already absorbed;
///  * the ledger row — this is the unrecoverable one. A type-ahead send that
///    recorded its prompt at enqueue time would land out of order against the
///    turn it belongs to, and the lake is hash-chained, so a mis-ordered row
///    cannot be quietly repaired afterwards.
fn start_companion_turn(
    app: AppHandle,
    companion: CompanionState,
    companion_id: String,
    payload: QueuedCompanionSend,
    slot: turn::SlotGuard<QueuedCompanionSend>,
) -> turn::BoxStartFuture {
    Box::pin(async move {
        let QueuedCompanionSend { text, cwd, handoff } = payload;
        // Read through the app handle rather than as command arguments: the
        // drain path has no `tauri::State` of its own, and both cells are
        // exactly the kind of "where are they NOW" fact that must not be
        // frozen at enqueue time.
        let surface: SurfaceInfo = app.state::<crate::ActiveSurface>().get();
        let mission = app.state::<crate::ActiveMission>().active_goal();

        let mut prior_session = companion.db.get_companion_session(&companion_id);

        // Rotation: past the turn budget, retire the CLI session and start a
        // cold one carrying a clipped recap. The UI thread is untouched —
        // `companion_get_thread` keeps returning the whole history, so the user
        // never sees a seam.
        let thread = companion
            .db
            .load_companion_thread(&companion_id)
            .unwrap_or_default();
        let turns = completed_assistant_turns(&thread);
        let rotated_at = companion
            .db
            .get_companion_rotated_at(&companion_id)
            .min(turns);
        let mut recap: Option<String> = None;
        if prior_session.is_some() && turns - rotated_at >= ROTATE_AFTER_ASSISTANT_TURNS {
            tracing::info!(turns, rotated_at, "chat: rotating the CLI session for speed");
            reset_companion_session(&companion.db, &companion_id, turns);
            prior_session = None;
            recap = Some(build_recap(&thread));
        }
        let first_turn = prior_session.is_none();

        // The awareness feed: journal rows since this chat's last turn.
        let since = companion.db.get_companion_journal_seq(&companion_id);
        let journal_rows = companion
            .db
            .list_journal_since(since, JOURNAL_DELTA_MAX_ROWS)
            .unwrap_or_default();
        let journal_delta = render_journal_delta(&journal_rows, JOURNAL_DELTA_MAX_BYTES);
        let head = journal_rows.last().map(|r| r.id);

        // SERVER-SIDE PREFETCH, first turn only. "The full context of all my
        // projects" is precisely the answer-pack, and the agent's opening move
        // would otherwise be a curl we can just as well make here — a whole
        // model turn saved on the turn where latency is most visible. A
        // follow-up fragment borrows the previous turn's terms, because a
        // fragment carries its subject implicitly.
        let prefetch = if first_turn {
            let prior_user_text = thread
                .iter()
                .rev()
                .find(|m| m.role == "user" && !m.body.trim().is_empty())
                .map(|m| m.body.clone());
            crate::query::plan_query_with_context(&text, prior_user_text.as_deref()).map(|plan| {
                let pack = crate::context::build_answer_pack(
                    &companion.db,
                    Some(&text),
                    None,
                    crate::context::INLINE_PACK_LIMIT,
                );
                let block = crate::context::render_answer_pack_block(
                    &pack,
                    Some(&plan),
                    crate::context::INLINE_PACK_MAX_BYTES,
                );
                let label = crate::context::prefetch_status_label(
                    pack.node.as_ref().map(|n| n.node.title.as_str()),
                    pack.notes.len()
                        + pack.prompt_hits.len()
                        + pack.browse_hits.len()
                        + pack.grep_hits.len()
                        + pack.node.as_ref().map(|n| n.links.len()).unwrap_or(0),
                );
                (block, label)
            })
        } else {
            // Follow-ups get NO prefetch: the routes block names the
            // answer-pack and grep, so the agent reaches when it needs to.
            None
        };
        // The ticker. Emitted BEFORE the spawn — the hook's `send` reducer sets
        // `phase: "streaming"` synchronously before `invoke` resolves, so the
        // room's clearing effect has already run by now.
        if let Some((_, label)) = &prefetch {
            let _ = app.emit(
                "companion-status",
                CompanionStatus {
                    companion_id: companion_id.clone(),
                    label: label.clone(),
                },
            );
        }
        let prefetch_block = prefetch.and_then(|(b, _)| b);

        let prompt = if first_turn {
            // Bake the catalog in, so the opening move can be an answer rather
            // than a tree walk.
            let catalog = companion
                .db
                .list_class_nodes_with_counts()
                .map(|nodes| {
                    crate::classmem::render_catalog_snapshot(
                        &nodes,
                        companion.db.max_ledger_seq().unwrap_or(0),
                        crate::classmem::CATALOG_SNAPSHOT_MAX_BYTES,
                    )
                })
                .ok();
            build_first_turn_prompt(
                &surface,
                &companion_id,
                &journal_delta,
                &text,
                &FirstTurnGround {
                    catalog: catalog.as_deref(),
                    recap: recap.as_deref(),
                    prefetch: prefetch_block.as_deref(),
                    mission: mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
                },
            )
        } else {
            build_followup_prompt(&surface, &companion_id, &journal_delta, &text)
        };

        // The per-conversation seat override. Resolved HERE so a chat whose
        // model changed mid-conversation takes effect on the very next turn.
        let (model, effort) = companion.db.get_companion_seat(&companion_id);
        let seat_flags =
            crate::seat::flag_args_override("companion", model.as_deref(), effort.as_deref());

        // Polis ledger: a chat is always a session-tree ROOT (it is bound to no
        // object by design); first turns are captured with thread provenance.
        // The model recorded is the EFFECTIVE one — a chat on a non-default
        // model must not be filed under the seat's model.
        if first_turn {
            crate::ledger::record_agent_prompt(
                &companion.db,
                crate::ledger::PromptSource::RustFirstTurn,
                "companion",
                &prompt,
                Some(&text),
                None,
                None,
                None,
                Some(crate::ledger::ThreadRef {
                    thread_kind: "companion",
                    thread_id: companion_id.clone(),
                    parent_session_id: None,
                }),
                crate::seat::model_for_override("companion", model.as_deref(), effort.as_deref()),
            );
        } else {
            crate::ledger::register_agent_prompt(&prompt);
        }

        // The delta is now folded into the conversation; advance the mark.
        if let Some(h) = head {
            let _ = companion.db.set_companion_journal_seq(&companion_id, h);
        }

        let args = bridge_args_with_flags(prompt, prior_session.as_deref(), seat_flags);
        let cwd = cwd
            .filter(|c| !c.trim().is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());

        let claude_bin = companion.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("companion", &claude_bin);
        let mut child = cmd
            .current_dir(&cwd)
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
                         Install Claude Code, or launch Redline from a terminal \
                         so it inherits your shell's PATH."
                    )
                } else {
                    format!("failed to spawn claude: {e}")
                }
            })?;
        let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;

        let buf = slot.buf();
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window.
            let _ = child.start_kill();
            let _ = app.emit("companion-cancelled", CompanionCancelled { companion_id });
            return Ok(());
        }
        // Arm the handoff AFTER the spawn succeeded (a failed spawn must not
        // strand a stale flag); a plain turn clears any leftover just in case.
        {
            let mut pending = companion.pending_handoff.lock().unwrap();
            match handoff.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
                Some(target) => {
                    pending.insert(companion_id.clone(), target.to_string());
                }
                None => {
                    pending.remove(&companion_id);
                }
            }
        }
        tauri::async_runtime::spawn(read_companion(
            app,
            companion,
            buf,
            token,
            companion_id,
            surface,
            stdout,
            stderr,
        ));
        Ok(())
    })
}


/// Snapshot of this companion's turn for a remounting panel: whether a reply
/// is streaming, since when, and the partial text streamed so far (with its
/// delta `seq` watermark).
#[tauri::command]
pub fn companion_turn_status(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> TurnStatus {
    companion.turns.status(&companion_id)
}

/// Cancel the in-flight turn (the reader emits `companion-cancelled`). Queued
/// sends stay queued — Stop cancels the CURRENT turn only, and the cancelled
/// reader's terminal drain still advances them.
#[tauri::command]
pub fn companion_cancel(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
) -> Result<(), String> {
    if let Some(mut child) = companion.turns.take(&companion_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    Ok(())
}

/// Remove a queued send (the bubble's ×). Returns its text so the composer can
/// restore it; `None` when the send already advanced — the caller treats that
/// as "too late", not an error. The persisted queued row goes with it.
#[tauri::command]
pub fn companion_unqueue(
    companion: tauri::State<'_, CompanionState>,
    companion_id: String,
    message_id: String,
) -> Result<Option<String>, String> {
    let Some(turn) = companion.turns.unqueue(&companion_id, &message_id) else {
        return Ok(None);
    };
    if let Err(e) = companion.db.delete_thread_message("companion", &message_id) {
        tracing::warn!(error = %e, "failed to delete the unqueued chat row");
    }
    Ok(Some(turn.text))
}

#[tauri::command]
pub fn companion_kill_all(companion: tauri::State<'_, CompanionState>) {
    companion.kill_all();
}

// --- Reader ---------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn read_companion(
    app: AppHandle,
    companion: CompanionState,
    buf: Arc<Mutex<PartialBuf>>,
    token: u64,
    companion_id: String,
    surface: SurfaceInfo,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let db = companion.db.clone();
    let mut lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut session: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    let mut saw_json = false;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        saw_json = true;
        // Live retrieval status. Read before classification because a tool_use
        // rides an `assistant` line, which `classify_line` (rightly) ignores —
        // it carries no answer text.
        for (name, input) in crate::claude_proc::tool_uses(&v) {
            let _ = app.emit(
                "companion-status",
                CompanionStatus {
                    companion_id: companion_id.clone(),
                    label: crate::claude_proc::retrieval_status_label(&name, &input),
                },
            );
        }
        match classify_line(&v) {
            StreamLine::Init(sid) => session = Some(sid),
            StreamLine::Delta(text) => {
                // Append-before-emit: see `turn::push_delta`.
                let seq = turn::push_delta(&buf, &text);
                let _ = app.emit(
                    "companion-delta",
                    CompanionDelta {
                        companion_id: companion_id.clone(),
                        text,
                        seq,
                    },
                );
            }
            StreamLine::Final { text, session_id } => {
                if session_id.is_some() {
                    session = session_id;
                }
                final_text = Some(text);
            }
            StreamLine::Failed(msg) => errored = Some(msg),
            StreamLine::Ignore => {}
        }
    }
    let mut stderr_text = String::new();
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        stderr_text.push_str(&line);
        stderr_text.push('\n');
    }

    // Reap the proc + pop the queue in ONE critical section, BEFORE emitting
    // the terminal event. Token-matched: a reader outliving a cancel must
    // neither steal a successor turn's proc nor drain its queue.
    let (proc, next) = companion.turns.finish_and_pop(&companion_id, token);
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };
    // Take the handoff flag exactly once, whatever this turn's outcome — an
    // error or a cancel must not leave it armed for an unrelated later turn.
    let handoff = {
        companion
            .pending_handoff
            .lock()
            .unwrap()
            .remove(&companion_id)
    };

    'terminal: {
        if cancelled {
            let _ = app.emit(
                "companion-cancelled",
                CompanionCancelled {
                    companion_id: companion_id.clone(),
                },
            );
            break 'terminal;
        }
        if let Some(err) = errored {
            let why = describe_turn_error(&db, &companion_id, &err);
            finish_error(&app, &db, &companion_id, &surface, &why);
            break 'terminal;
        }
        if let Some(text) = final_text {
            if text.trim().is_empty() {
                finish_error(
                    &app,
                    &db,
                    &companion_id,
                    &surface,
                    "claude produced an empty reply",
                );
                break 'terminal;
            }
            if let Some(sid) = &session {
                if let Err(e) = db.set_companion_session(&companion_id, sid) {
                    tracing::warn!(error = %e, "failed to persist companion session id");
                }
            }
            let msg = CompanionMessage {
                id: uuid::Uuid::new_v4().to_string(),
                companion_id: companion_id.clone(),
                role: "assistant".to_string(),
                body: text.clone(),
                status: "complete".to_string(),
                surface_kind: Some(surface.kind.clone()),
                surface_id: surface.id.clone(),
                surface_label: surface.label.clone(),
                created_at: now_millis(),
            };
            if let Err(e) = db.insert_companion_message(&msg) {
                tracing::warn!(error = %e, "failed to persist assistant message");
            }
            // Deliberately NO agent_turn journal append here — the chat's own
            // turns must not echo back into its next "while you were away"
            // delta.
            let _ = app.emit(
                "companion-done",
                CompanionDone {
                    companion_id: companion_id.clone(),
                    message_id: msg.id,
                    body: text.clone(),
                },
            );
            // Name the chat once, from the opening exchange — detached, so the
            // reply is already on screen and nothing waits on it. Gated on
            // "this is the first reply" by counting completed assistant rows
            // (this one included), which is exactly one only on turn one.
            let thread = db.load_companion_thread(&companion_id).unwrap_or_default();
            if completed_assistant_turns(&thread) == 1 {
                let opener = thread
                    .iter()
                    .find(|m| m.role == "user" && !m.body.trim().is_empty())
                    .map(|m| m.body.clone())
                    .unwrap_or_default();
                tauri::async_runtime::spawn(autotitle(
                    app.clone(),
                    companion.clone(),
                    companion_id.clone(),
                    opener,
                    text.clone(),
                ));
            }
            if let Some(target) = handoff {
                let _ = app.emit(
                    "companion-handoff-done",
                    CompanionHandoffDone {
                        companion_id: companion_id.clone(),
                        target,
                        markdown: text,
                    },
                );
            }
            break 'terminal;
        }

        let why = if !exit_ok && !stderr_text.trim().is_empty() {
            let detail: String = stderr_text.trim().chars().take(500).collect();
            format!("claude exited abnormally: {detail}")
        } else if !saw_json {
            "claude produced no parseable output".to_string()
        } else {
            "claude ended without producing a reply".to_string()
        };
        finish_error(&app, &db, &companion_id, &surface, &why);
    }

    // Drain: `finish_and_pop` already re-reserved the slot for the queue head,
    // so no concurrent send can slip in between the terminal above and the
    // start below.
    if let Some((queued, payload, slot)) = next {
        if let Err(e) = db.set_thread_message_status("companion", &queued.message_id, "complete") {
            tracing::warn!(error = %e, "failed to flip a drained chat row");
        }
        let _ = app.emit(
            "companion-queue-advanced",
            CompanionQueueAdvanced {
                companion_id: companion_id.clone(),
                message_id: queued.message_id.clone(),
            },
        );
        if let Err(e) = start_companion_turn(
            app.clone(),
            companion.clone(),
            companion_id.clone(),
            payload,
            slot,
        )
        .await
        {
            // The slot released via the guard's Drop. Flip the row so the UI
            // offers "wasn't sent — resend"; no chain-drain (predictable
            // failure behavior beats a cascade).
            let _ = db.set_thread_message_status("companion", &queued.message_id, "unsent");
            finish_error(
                &app,
                &db,
                &companion_id,
                &surface,
                &format!("your queued message wasn't sent: {e}"),
            );
        }
    }
}

/// Same recovery policy as browse/draft-chat: explicit context overflow resets
/// the resumable session; transient API errors keep it and ask for a retry.
///
/// The overflow branch is the REACTIVE twin of the proactive rotation in
/// `start_companion_turn` — same helper, so the two can never differ in what
/// they clear. With the turn budget in place this should now be the rare path:
/// a conversation normally rotates long before the window runs out.
fn describe_turn_error(db: &Database, companion_id: &str, error: &str) -> String {
    if is_context_overflow(error) {
        let turns = completed_assistant_turns(
            &db.load_companion_thread(companion_id).unwrap_or_default(),
        );
        reset_companion_session(db, companion_id, turns);
        return "This conversation outgrew the model's context window, so the turn \
                failed. I've reset its context — send your message again and I'll \
                pick up fresh from here (the replies above are kept)."
            .to_string();
    }
    if is_transient(error) {
        return "The model hit a momentary error on that turn. The conversation is \
                fine — send your message again in a moment."
            .to_string();
    }
    error.to_string()
}

fn finish_error(
    app: &AppHandle,
    db: &Database,
    companion_id: &str,
    surface: &SurfaceInfo,
    why: &str,
) {
    let msg = CompanionMessage {
        id: uuid::Uuid::new_v4().to_string(),
        companion_id: companion_id.to_string(),
        role: "assistant".to_string(),
        body: why.to_string(),
        status: "error".to_string(),
        surface_kind: Some(surface.kind.clone()),
        surface_id: surface.id.clone(),
        surface_label: surface.label.clone(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_companion_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error message");
    }
    let _ = app.emit(
        "companion-error",
        CompanionError {
            companion_id: companion_id.to_string(),
            error: why.to_string(),
        },
    );
}

// --- Auto-titling -------------------------------------------------------------

/// How long the titling pass may take before it is abandoned. Generous, because
/// nothing waits on it — and short, because a title arriving ten minutes later
/// is a row changing under the user's hand.
const TITLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// A chat's name, once there is enough conversation to name it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionRetitled {
    companion_id: String,
    title: String,
}

/// The argv for the titling spawn — the cheapest possible one-shot.
///
/// `--tools ""` is the load-bearing flag: with no tool surface at all there is
/// nothing to explore and nothing to approve, so `bypassPermissions` is safe
/// and the pass costs exactly one model turn. Defaults to `haiku` when the
/// seat has no explicit model, for the same reason `ai_commit` does: a fast
/// good-enough name beats a slow perfect one, and the bare CLI default is the
/// big model.
fn title_args(seat_model: Option<String>, seat_flags: Vec<String>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--permission-mode",
        "bypassPermissions",
        "--tools",
        "",
        "--no-session-persistence",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    args.extend(seat_flags);
    if seat_model.is_none() {
        args.push("--model".to_string());
        args.push("haiku".to_string());
    }
    args
}

/// Squeeze a model's reply down to a row in a dropdown: one line, no quotes, no
/// trailing punctuation, bounded. Returns `None` when there is nothing usable —
/// in which case the provisional title simply stands.
fn clean_title(raw: &str) -> Option<String> {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '*')
        .trim_end_matches(['.', '!', '?'])
        .trim();
    let title: String = line.chars().take(60).collect();
    let title = title.trim().to_string();
    (!title.is_empty()).then_some(title)
}

fn title_prompt(user_text: &str, reply: &str) -> String {
    let clip = |s: &str, n: usize| -> String { s.chars().take(n).collect() };
    format!(
        "Name this conversation for a list of chats. Reply with ONLY the name: \
         3-6 words, title case, no quotes, no trailing punctuation, naming the \
         SUBJECT rather than the act of discussing it (\"Anchoring Rework\", \
         not \"A Discussion About Anchoring\").\n\n\
         They opened with:\n{}\n\nThe reply was:\n{}\n",
        clip(user_text.trim(), 1_000),
        clip(reply.trim(), 1_500),
    )
}

/// Name a chat from its opening exchange, once, in the background.
///
/// The first sentence of a half-formed thought is a placeholder, not a name —
/// "so I've been thinking about the anchoring thing" is a bad row in the Chats
/// dropdown forever. This replaces it after the first reply lands.
///
/// FIRE AND FORGET, strictly. It is spawned detached from the reader's terminal
/// path, so it can never block or delay a reply, and every failure path simply
/// leaves the provisional title standing. `set_companion_title(.., false)` is
/// the guard that makes a user rename permanent.
async fn autotitle(
    app: AppHandle,
    companion: CompanionState,
    companion_id: String,
    user_text: String,
    reply: String,
) {
    let Ok(claude_bin) = companion.claude_bin().await else {
        return;
    };
    let prompt = title_prompt(&user_text, &reply);
    let args = title_args(
        crate::seat::model_for("companion"),
        crate::seat::flag_args("companion"),
    );
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let mut cmd = crate::claude_proc::claude_command_for_seat("companion", &claude_bin);
    let Ok(mut child) = cmd
        .current_dir(&cwd)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    else {
        return;
    };
    let (Some(mut stdin), Some(stdout), Some(stderr)) = (
        child.stdin.take(),
        child.stdout.take(),
        child.stderr.take(),
    ) else {
        return;
    };
    let outcome = tokio::time::timeout(TITLE_TIMEOUT, async move {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
        let outcome = crate::claude_proc::collect_turn(stdout, stderr).await;
        let _ = child.wait().await;
        outcome
    })
    .await;
    // On expiry the future (and the child, via kill_on_drop) is dropped.
    let Ok(outcome) = outcome else { return };
    let Some(title) = outcome.final_text.as_deref().and_then(clean_title) else {
        return;
    };
    match companion.db.set_companion_title(&companion_id, &title, false) {
        // `false` means the user had already named it — their name wins, and
        // there is nothing to tell the UI.
        Ok(true) => {
            let _ = app.emit(
                "companion-retitled",
                CompanionRetitled {
                    companion_id,
                    title,
                },
            );
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(error = %e, "failed to store the auto-title"),
    }
}

// --- Consult ----------------------------------------------------------------

impl CompanionState {
    /// "Check in with a colleague" for `/v1/global/consult`: run THIS chat's
    /// agent to completion with a synthesis-framed question and return only its
    /// digest. Mirrors `DraftChatState::consult`.
    ///
    /// This replaces a blanket 422 ("the companion cannot consult itself"),
    /// which was true when there was exactly ONE Companion and wrong the moment
    /// chats became named threads. A brainstorm is where the good thinking
    /// accumulates, so a plan session, a mission or a second chat should all be
    /// able to ask it what was concluded. `/v1/global/agents` now lists chats
    /// alongside the other colleagues, so the map and the dispatch agree.
    ///
    /// THE SELF-CONSULT GUARD IS THE BUSY GUARD, and that is not a coincidence:
    /// the only way a consult can name a chat that is mid-turn is that the chat
    /// IS the caller (it is writing the curl from inside its own turn) or the
    /// user is talking to it concurrently. Both must refuse, so one reservation
    /// covers both — and it cannot be bypassed, where a caller-supplied id
    /// could be.
    pub async fn consult(&self, companion_id: String, question: String) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }
        // Atomic reservation; early `?` returns release it via the guard's Drop.
        let slot = self.turns.begin(&companion_id).map_err(|_| {
            "that chat is busy — if you are asking about your own conversation, \
             you already have it in front of you"
                .to_string()
        })?;
        let exists = self
            .db
            .list_companions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .any(|c| c.companion_id == companion_id);
        if !exists {
            return Err("no such chat".to_string());
        }
        let prior_session = self.db.get_companion_session(&companion_id);

        let check_in = CompanionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            companion_id: companion_id.clone(),
            role: "user".to_string(),
            body: format!("🧭 A colleague is checking in — {}", question.trim()),
            status: "complete".to_string(),
            surface_kind: Some("chat".to_string()),
            surface_id: Some(companion_id.clone()),
            surface_label: None,
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_companion_message(&check_in) {
            tracing::warn!(error = %e, "failed to persist consult check-in");
        }

        let framed = format!(
            "Another of the user's agents is checking in with you about THIS \
             chat. Synthesize what matters here for their question as a tight \
             DIGEST (not a transcript, not a fresh reply to the user, and write \
             nothing anywhere for this turn). Be concise. Their \
             question:\n\n{}",
            question.trim()
        );
        // A consult against a chat that has never run gets the full first-turn
        // contract, minus any retrieval prefetch — a colleague's question is not
        // the user's, and spending a batched read on it would ground the whole
        // conversation on someone else's subject.
        let surface = SurfaceInfo {
            kind: "chat".to_string(),
            id: Some(companion_id.clone()),
            label: None,
            detail: None,
            project_path: None,
            updated_at: 0,
        };
        let prompt = match &prior_session {
            None => build_first_turn_prompt(
                &surface,
                &companion_id,
                "",
                &framed,
                &FirstTurnGround::default(),
            ),
            Some(_) => framed.clone(),
        };
        crate::ledger::register_agent_prompt(&prompt);

        let (model, effort) = self.db.get_companion_seat(&companion_id);
        let args = bridge_args_with_flags(
            prompt,
            prior_session.as_deref(),
            crate::seat::flag_args_override("companion", model.as_deref(), effort.as_deref()),
        );
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("companion", &claude_bin);
        let mut child = cmd
            .current_dir(&cwd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn claude: {e}"))?;
        let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;
        let token = slot.token();
        if let Err(mut child) = slot.attach(child) {
            // Cancelled during the spawn window — the reservation is gone.
            let _ = child.start_kill();
            return Err("the consult was cancelled".to_string());
        }

        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::claude_proc::collect_turn(stdout, stderr),
        )
        .await;
        // Token-matched: a consult draining its stream must not steal a
        // successor turn started after a cancel.
        let proc = self
            .turns
            .take_owned(&companion_id, token)
            .and_then(|p| p.child);
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut child) = proc {
                    let _ = child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("companion"),
                    Some(&companion_id),
                    Some("180s turn ceiling"),
                );
                return Err("the colleague took too long to respond".to_string());
            }
        };
        if let Some(mut child) = proc {
            let _ = child.wait().await;
        }
        if let Some(err) = outcome.errored {
            return Err(err);
        }
        let Some(text) = outcome.final_text.filter(|t| !t.trim().is_empty()) else {
            return Err("the colleague produced no reply".to_string());
        };
        if let Some(sid) = &outcome.session {
            let _ = self.db.set_companion_session(&companion_id, sid);
        }
        let reply = CompanionMessage {
            id: uuid::Uuid::new_v4().to_string(),
            companion_id: companion_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            surface_kind: Some("chat".to_string()),
            surface_id: Some(companion_id.clone()),
            surface_label: None,
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_companion_message(&reply) {
            tracing::warn!(error = %e, "failed to persist consult reply");
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELF_ID: &str = "chat-self";

    fn surface(kind: &str, label: Option<&str>, detail: Option<&str>) -> SurfaceInfo {
        SurfaceInfo {
            kind: kind.to_string(),
            id: Some("x-1".to_string()),
            label: label.map(str::to_string),
            detail: detail.map(str::to_string),
            project_path: None,
            updated_at: 0,
        }
    }

    fn row(id: i64, kind: &str, label: Option<&str>, detail: Option<&str>) -> JournalRow {
        JournalRow {
            id,
            ts: id,
            kind: kind.to_string(),
            surface_kind: Some("browser".to_string()),
            surface_id: None,
            label: label.map(str::to_string),
            detail: detail.map(str::to_string),
        }
    }

    fn msg(id: &str, chat: &str, role: &str, body: &str, at: i64) -> CompanionMessage {
        CompanionMessage {
            id: id.to_string(),
            companion_id: chat.to_string(),
            role: role.to_string(),
            body: body.to_string(),
            status: "complete".to_string(),
            surface_kind: Some("chat".to_string()),
            surface_id: Some(chat.to_string()),
            surface_label: None,
            created_at: at,
        }
    }

    fn chat(id: &str) -> Companion {
        Companion {
            companion_id: id.to_string(),
            title: "Chat".to_string(),
            status: "active".to_string(),
            created_at: 1,
            updated_at: 1,
            model: None,
            effort: None,
            title_is_user_set: false,
        }
    }

    #[test]
    fn describe_surface_names_the_surface_tolerantly() {
        assert_eq!(
            describe_surface(&surface("plan", Some("My plan"), None)),
            "the plan review — My plan"
        );
        assert_eq!(
            describe_surface(&surface("browser", Some("Docs"), Some("https://x"))),
            "the embedded browser — Docs (https://x)"
        );
        assert_eq!(describe_surface(&surface("welcome", None, None)), "the welcome screen");
        // The chat room is a surface of its own now — without this arm the
        // agent's own room reported as the welcome screen.
        assert_eq!(
            describe_surface(&surface("chat", Some("The anchoring thing"), None)),
            "a chat room — The anchoring thing"
        );
    }

    /// The self-reference guard: when the active surface IS the chat the agent
    /// is in, say so and hand over NO write-target id.
    #[test]
    fn surface_line_refuses_to_hand_a_chat_its_own_thread() {
        let mut own = surface("chat", Some("The anchoring thing"), None);
        own.id = Some(SELF_ID.to_string());
        let line = surface_line(&own, SELF_ID);
        assert!(line.contains("this chat"));
        assert!(
            !line.contains("[surface id:"),
            "its own thread must never be offered as a write target: {line}"
        );
        // Another chat is a normal surface, id and all.
        let other = surface("chat", Some("Something else"), None);
        let line = surface_line(&other, SELF_ID);
        assert!(line.contains("a chat room — Something else"));
        assert!(line.contains("[surface id: x-1]"));
    }

    #[test]
    fn journal_delta_groups_navs_and_bounds_bytes() {
        let rows = vec![
            row(1, "surface_switch", Some("My plan"), None),
            row(2, "nav", Some("Page A"), Some("https://a")),
            row(3, "nav", Some("Page B"), Some("https://b")),
            row(4, "nav", Some("Page C"), Some("https://c")),
            row(5, "revision", Some("My plan"), Some("v3")),
        ];
        let d = render_journal_delta(&rows, 4000);
        assert!(d.contains("WHILE YOU WERE AWAY"));
        assert!(d.contains("browsed 3 pages, ending at Page C"));
        assert!(!d.contains("Page A"), "grouped navs collapse to one line");
        assert!(d.contains("a plan revision arrived — My plan (v3)"));

        // Byte bound keeps the TAIL and says what was elided.
        let many: Vec<JournalRow> = (0..100)
            .map(|i| row(i, "surface_switch", Some(&format!("surface {i}")), None))
            .collect();
        let bounded = render_journal_delta(&many, 300);
        assert!(bounded.len() < 600);
        assert!(bounded.contains("surface 99"), "the newest event survives");
        assert!(bounded.contains("elided"));
        // Empty delta renders nothing at all.
        assert_eq!(render_journal_delta(&[], 4000), "");
    }

    /// The batched read must lead the memory routes: a chat's whole value is
    /// "it already knows my record", and a tree walk spends a model turn
    /// learning node ids the pack returns for free.
    #[test]
    fn routes_block_teaches_the_answer_pack_before_the_tree() {
        let b = routes_block();
        let pack = b.find("/v1/memory/answer-pack").expect("answer-pack is taught");
        let tree = b.find("/v1/memory/tree").expect("the tree walk survives");
        assert!(pack < tree, "the answer-pack must be taught FIRST");
        assert!(b.contains("/v1/memory/grep?q="), "literals need grep");
        assert!(b.contains("Read the pack, then ANSWER"));
        // The voice agent embeds this block verbatim, and its own test pins the
        // rest of the contract — these are the routes that must not have been
        // displaced by the insertion.
        assert!(b.contains("/v1/memory/node/<id>"));
        assert!(b.contains("/v1/global/consult"));
    }

    #[test]
    fn first_turn_embeds_role_surface_journal_and_consult_contract() {
        let s = surface("plan", Some("Companion plan"), None);
        let p = build_first_turn_prompt(
            &s,
            SELF_ID,
            "WHILE YOU WERE AWAY — what the user did since your last turn:\n- browsed to X\n",
            "what did I miss?",
            &FirstTurnGround {
                mission: Some(("Research", "Find the best DB")),
                ..Default::default()
            },
        );
        assert!(p.contains("COMPANION"));
        assert!(p.contains("the plan review — Companion plan"));
        // The surface id rides the per-turn line (the write routes key on it).
        assert!(p.contains("[surface id: x-1]"));
        assert!(p.contains("WHILE YOU WERE AWAY"));
        assert!(p.contains("/v1/global/agents"));
        assert!(p.contains("/v1/global/consult"));
        assert!(p.contains("/v1/context/threads/"));
        assert!(p.contains("/v1/context/tree/"));
        assert!(p.contains("/v1/journal/recent"));
        assert!(p.contains("`companion` skill"));
        // Mission inheritance rides the shared block.
        assert!(p.contains("Find the best DB"));
        assert!(p.contains("what did I miss?"));

        // The write contract: user-directed only, staged/reviewable, all four
        // recipes present with the auth header, and the exclusions explicit.
        assert!(p.contains("WRITES — ONLY AT THE USER'S DIRECTION"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/plan"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/sessions/<session_id>/comments"));
        assert!(p.contains("\"agentId\":\"companion\""));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/doc"));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/drafter/<draft_id>/suggestions"));
        assert!(p.contains("curl -s 'http://127.0.0.1:7676/v1/reviews/annotations?repo=<repo_path>'"));
        assert!(p.contains("\"source\":\"companion\""));
        assert!(p.contains("curl -s http://127.0.0.1:7676/v1/memory/proposals"));
        // The auth flags must survive verbatim as curl's own variable import:
        // shell expansion (`$REDLINE_DAEMON_TOKEN`) never reaches the daemon
        // because the agent bash sandbox rejects the command outright.
        assert!(p.contains(
            "--variable %REDLINE_DAEMON_TOKEN= \
             --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""
        ));
        assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
        assert!(p.contains("/v1/sessions/<id>/suggestions"), "plan-suggestion exclusion");
        assert!(p.contains("NEVER: /v1/browser/*"));
        // The old blanket read-only line is gone in favor of the new contract.
        assert!(p.contains("WRITE only at the user's explicit"));
        assert!(p.contains("staged, reviewable artifact"));
    }

    /// The grounding stack, in order: catalog, recap, evidence, question. The
    /// evidence sits closest to what it answers; the recap between the catalog
    /// and the question, exactly as `memchat.rs` pins it.
    #[test]
    fn first_turn_stacks_catalog_recap_evidence_then_the_question() {
        let p = build_first_turn_prompt(
            &surface("chat", None, None),
            SELF_ID,
            "",
            "and the beta?",
            &FirstTurnGround {
                catalog: Some("- Loop Engineering [n-loop] (12 links)\n"),
                recap: Some("\nCONVERSATION SO FAR — rotated for speed.\n\n- They said: hi\n"),
                prefetch: Some("PREFETCHED EVIDENCE\n- searched: beta\n"),
                mission: None,
            },
        );
        let catalog = p.find("THEIR CATALOG").expect("catalog block");
        let recap = p.find("CONVERSATION SO FAR").expect("recap block");
        let evidence = p.find("PREFETCHED EVIDENCE\n- searched").expect("evidence block");
        let question = p.find("The user says:").expect("question");
        assert!(catalog < recap, "catalog above the recap");
        assert!(recap < evidence, "recap above the evidence");
        assert!(evidence < question, "evidence directly above the question");
        assert!(p.contains("- Loop Engineering [n-loop] (12 links)"));

        // A plain first turn carries none of the three blocks.
        let plain = build_first_turn_prompt(
            &surface("chat", None, None),
            SELF_ID,
            "",
            "and the beta?",
            &FirstTurnGround::default(),
        );
        assert!(!plain.contains("THEIR CATALOG"));
        assert!(!plain.contains("CONVERSATION SO FAR"));
        assert!(!plain.contains("- searched: beta"));
    }

    /// Two first turns with different VARIABLE inputs (surface, journal
    /// delta, mission, catalog, evidence, user text) share a byte-identical
    /// prefix spanning the whole invariant block — the cache-stable ordering
    /// contract.
    #[test]
    fn first_turn_invariant_prefix_is_byte_stable() {
        fn common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
            let n = a
                .bytes()
                .zip(b.bytes())
                .take_while(|(x, y)| x == y)
                .count();
            &a[..n]
        }
        let a = build_first_turn_prompt(
            &surface("plan", Some("Plan A"), None),
            SELF_ID,
            "WHILE YOU WERE AWAY — delta one\n",
            "question one",
            &FirstTurnGround::default(),
        );
        let b = build_first_turn_prompt(
            &surface("drafter", None, None),
            SELF_ID,
            "",
            "another question",
            &FirstTurnGround {
                catalog: Some("- A [a] (1 links)\n"),
                prefetch: Some("PREFETCHED EVIDENCE\n"),
                mission: Some(("Research", "Find the best DB")),
                ..Default::default()
            },
        );
        let shared = common_prefix(&a, &b);
        // The shared prefix must reach the END of the invariant block — the
        // formatting/write contract closes it.
        assert!(shared.contains("`companion` skill"));
        assert!(shared.contains("/v1/global/consult"));
        assert!(shared.contains("/v1/memory/answer-pack"));
        assert!(shared.contains("never call ExitPlanMode."));
        // And every variable section sits after it.
        assert!(!shared.contains("The user is currently on"));
        assert!(!shared.contains("WHILE YOU WERE AWAY"));
        assert!(!shared.contains("THEIR CATALOG"));
        assert!(!shared.contains("question one"));
    }

    #[test]
    fn followup_regrounds_on_surface_without_reembedding_the_role() {
        let s = surface("drafter", None, None);
        let p = build_followup_prompt(&s, SELF_ID, "", "and now?");
        assert!(p.contains("the Prompt Drafter"));
        // The surface id rides every turn — follow-up writes need it too.
        assert!(p.contains("[surface id: x-1]"));
        assert!(!p.contains("COMPANION"), "role is not re-embedded");
        assert!(!p.contains("/v1/global/consult"), "routes are not re-embedded");
        assert!(p.ends_with("> and now?\n"));
    }

    // --- Rotation ------------------------------------------------------------

    /// The budget counts COMPLETED assistant turns, so a queued, unsent or
    /// errored row can't spend it.
    #[test]
    fn rotation_fires_at_the_turn_budget() {
        let mut thread = Vec::new();
        for i in 0..(ROTATE_AFTER_ASSISTANT_TURNS - 1) {
            thread.push(msg(&format!("u{i}"), "c1", "user", "q", i * 2));
            thread.push(msg(&format!("a{i}"), "c1", "assistant", "a", i * 2 + 1));
        }
        assert!(
            completed_assistant_turns(&thread) < ROTATE_AFTER_ASSISTANT_TURNS,
            "one short of the budget must not rotate"
        );
        thread.push(msg("u-last", "c1", "user", "q", 100));
        let mut done = msg("a-last", "c1", "assistant", "a", 101);
        thread.push(done.clone());
        assert_eq!(completed_assistant_turns(&thread), ROTATE_AFTER_ASSISTANT_TURNS);
        // A queued row and an errored row are not turns the CLI replays.
        done.id = "a-err".into();
        done.status = "error".into();
        thread.push(done.clone());
        done.id = "u-queued".into();
        done.role = "user".into();
        done.status = "queued".into();
        thread.push(done);
        assert_eq!(
            completed_assistant_turns(&thread),
            ROTATE_AFTER_ASSISTANT_TURNS,
            "only completed assistant rows spend the budget"
        );

        // The reset drops only the CLI session; the thread survives, and the
        // mark records where the new session began so the NEXT rotation is a
        // full budget away rather than firing on every subsequent turn.
        let db = Database::open_in_memory().unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        db.set_companion_session("c1", "sid-1").unwrap();
        db.insert_companion_message(&thread[0]).unwrap();
        reset_companion_session(&db, "c1", ROTATE_AFTER_ASSISTANT_TURNS);
        assert!(db.get_companion_session("c1").is_none(), "CLI session rotated");
        assert_eq!(db.load_companion_thread("c1").unwrap().len(), 1, "history survives");
        assert_eq!(db.get_companion_rotated_at("c1"), ROTATE_AFTER_ASSISTANT_TURNS);
    }

    /// The mark is PER THREAD. memchat's is a single global setting because Ask
    /// is a singleton; chats are not, and a shared mark would let two chats
    /// rotate each other.
    #[test]
    fn two_chats_rotate_independently() {
        let db = Database::open_in_memory().unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        db.insert_companion(&chat("c2")).unwrap();
        db.set_companion_session("c1", "sid-1").unwrap();
        db.set_companion_session("c2", "sid-2").unwrap();

        reset_companion_session(&db, "c1", 12);
        assert!(db.get_companion_session("c1").is_none());
        assert_eq!(db.get_companion_rotated_at("c1"), 12);
        // The other chat is untouched — session AND mark.
        assert_eq!(db.get_companion_session("c2").as_deref(), Some("sid-2"));
        assert_eq!(db.get_companion_rotated_at("c2"), 0);

        // And the mark dies with its row, so a recreated chat can never inherit
        // a count above its own turn count and refuse to rotate forever.
        db.delete_companion("c1").unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        assert_eq!(db.get_companion_rotated_at("c1"), 0);
    }

    /// The recap must carry the tail of the conversation, bounded, and say
    /// plainly that its contents are not evidence.
    #[test]
    fn recap_is_present_and_bounded() {
        let long_body = "x".repeat(RECAP_BODY_CHARS * 3);
        let mut thread = Vec::new();
        for i in 0..10 {
            thread.push(msg(&format!("u{i}"), "c1", "user", &format!("thought {i}"), i * 2));
            thread.push(msg(&format!("a{i}"), "c1", "assistant", &long_body, i * 2 + 1));
        }
        let recap = build_recap(&thread);
        assert!(recap.contains("CONVERSATION SO FAR — rotated for speed"));
        assert!(recap.contains("needing re-verification"));
        // Only the tail, oldest-of-the-tail first.
        assert!(recap.contains("thought 9"), "the newest exchange is carried");
        assert!(!recap.contains("thought 0"), "the head is not");
        assert_eq!(
            recap.matches("They said").count(),
            RECAP_EXCHANGES,
            "exactly the budgeted exchanges"
        );
        assert!(recap.find("thought 7").unwrap() < recap.find("thought 9").unwrap());
        // Bodies are clipped, so a long transcript can't ride along whole.
        assert!(recap.contains('…'));
        assert!(
            recap.len() < RECAP_EXCHANGES * 2 * (RECAP_BODY_CHARS + 200),
            "the recap must stay bounded: {} bytes",
            recap.len()
        );
        // Nothing to recap is empty, not a header with no content.
        assert!(build_recap(&[]).is_empty());
    }

    /// A rotated first turn is a normal first turn PLUS the recap, in the slot
    /// between the catalog and the question.
    #[test]
    fn rotated_first_turn_carries_the_recap_between_catalog_and_question() {
        let thread = vec![
            msg("u1", "c1", "user", "what about the anchoring thing?", 1),
            msg("a1", "c1", "assistant", "You landed on prepared overlays.", 2),
        ];
        let recap = build_recap(&thread);
        let p = build_first_turn_prompt(
            &surface("chat", None, None),
            SELF_ID,
            "",
            "and now?",
            &FirstTurnGround {
                catalog: Some("- A [a] (1 links)\n"),
                recap: Some(&recap),
                ..Default::default()
            },
        );
        assert!(p.contains("You landed on prepared overlays."));
        let catalog = p.find("THEIR CATALOG").unwrap();
        let recap_at = p.find("CONVERSATION SO FAR").unwrap();
        let question = p.find("The user says:").unwrap();
        assert!(catalog < recap_at && recap_at < question);
    }

    // --- Queue ---------------------------------------------------------------

    /// The type-ahead lifecycle end to end at the registry + row level: a send
    /// behind a busy slot queues in order, its persisted row is `queued`, the
    /// drain re-reserves the slot and flips the row to `complete`, and an
    /// unqueue takes the row with it.
    #[test]
    fn companion_queue_round_trip() {
        let db = Database::open_in_memory().unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        let turns: Arc<Turns<QueuedCompanionSend>> = Arc::new(Turns::new());

        // Turn 1 takes the slot.
        let first = turns.begin("c1").expect("free slot");
        let token = first.token();

        // Turn 2 arrives mid-stream and queues, with a persisted `queued` row.
        let queued_turn = QueuedTurn {
            message_id: "m2".to_string(),
            text: "and the beta?".to_string(),
            queued_at: 2,
        };
        let payload = QueuedCompanionSend {
            text: "and the beta?".to_string(),
            cwd: None,
            handoff: None,
        };
        match turns.begin_or_enqueue("c1", queued_turn, payload) {
            SendSlot::Enqueued => {}
            _ => panic!("a busy slot must enqueue, not start"),
        }
        let mut queued_row = msg("m2", "c1", "user", "and the beta?", 2);
        queued_row.status = "queued".to_string();
        db.insert_companion_message(&queued_row).unwrap();
        assert_eq!(turns.status("c1").queued.len(), 1, "the send is visible as queued");

        // A remount sees the bubble.
        let thread = db.load_companion_thread("c1").unwrap();
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].status, "queued");

        // Turn 1 ends: the reap pops the head and re-reserves in one section.
        drop(first);
        let (_, next) = turns.finish_and_pop("c1", token);
        let (drained, payload, _slot) = next.expect("the queue head drains");
        assert_eq!(drained.message_id, "m2");
        assert_eq!(payload.text, "and the beta?");
        assert!(
            db.set_thread_message_status("companion", "m2", "complete").unwrap(),
            "the `companion` kind must be mapped, or the drained row stays a phantom chip"
        );
        assert_eq!(db.load_companion_thread("c1").unwrap()[0].status, "complete");

        // And an unqueue takes the row with it.
        let turns2: Arc<Turns<QueuedCompanionSend>> = Arc::new(Turns::new());
        let held = turns2.begin("c1").expect("free slot");
        turns2.begin_or_enqueue(
            "c1",
            QueuedTurn {
                message_id: "m3".to_string(),
                text: "wait, scratch that".to_string(),
                queued_at: 3,
            },
            QueuedCompanionSend {
                text: "wait, scratch that".to_string(),
                cwd: None,
                handoff: None,
            },
        );
        let mut row3 = msg("m3", "c1", "user", "wait, scratch that", 3);
        row3.status = "queued".to_string();
        db.insert_companion_message(&row3).unwrap();
        let pulled = turns2.unqueue("c1", "m3").expect("still queued");
        assert_eq!(pulled.text, "wait, scratch that");
        assert!(db.delete_thread_message("companion", "m3").unwrap());
        assert_eq!(db.load_companion_thread("c1").unwrap().len(), 1);
        // Too late is `None`, not an error.
        assert!(turns2.unqueue("c1", "m3").is_none());
        drop(held);
    }

    /// The chat's own row carries its seat override, and the effective model
    /// the ledger stamps follows it — not the seat's.
    #[test]
    fn per_chat_model_override_round_trips_and_drives_provenance() {
        let db = Database::open_in_memory().unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        assert_eq!(db.get_companion_seat("c1"), (None, None));

        db.set_companion_seat("c1", Some("opus"), Some("high")).unwrap();
        let (model, effort) = db.get_companion_seat("c1");
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(
            db.list_companions().unwrap()[0].model.as_deref(),
            Some("opus"),
            "the override rides the row the dropdown reads"
        );

        // The flags the spawn appends, and the model the lake records, both
        // follow the override rather than the seat.
        let flags = crate::seat::flag_args_override("companion", model.as_deref(), effort.as_deref());
        assert_eq!(
            flags,
            vec!["--model", "opus", "--effort", "high"],
            "the override builds the same flags a seat would"
        );
        assert_eq!(
            crate::seat::model_for_override("companion", model.as_deref(), effort.as_deref())
                .as_deref(),
            Some("opus"),
        );

        // Clearing it falls back to the seat (unconfigured here → no flags).
        db.set_companion_seat("c1", None, None).unwrap();
        assert_eq!(db.get_companion_seat("c1"), (None, None));
        assert!(crate::seat::flag_args_override("companion", None, None).is_empty());
    }

    /// A user rename outranks the auto-titling pass, permanently.
    #[test]
    fn a_user_rename_beats_the_auto_title() {
        let db = Database::open_in_memory().unwrap();
        db.insert_companion(&chat("c1")).unwrap();
        // The provisional title is replaceable by the titling pass…
        assert!(db.set_companion_title("c1", "Anchoring rework", false).unwrap());
        assert_eq!(db.list_companions().unwrap()[0].title, "Anchoring rework");
        // …until the user names it themselves.
        assert!(db.set_companion_title("c1", "My thing", true).unwrap());
        assert!(
            !db.set_companion_title("c1", "Something a model liked", false).unwrap(),
            "the auto-title must not overwrite a user-set name"
        );
        assert_eq!(db.list_companions().unwrap()[0].title, "My thing");
    }

    /// The consult's self-guard: a chat that is mid-turn refuses. That is the
    /// self-consult case by construction — the only way a consult can name a
    /// busy chat is that the chat IS the caller, writing the curl from inside
    /// its own turn.
    #[test]
    fn a_busy_chat_refuses_to_consult_itself() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.insert_companion(&chat("c1")).unwrap();
        let state = CompanionState::new(db);
        // Its own turn holds the slot.
        let held = state.turns.begin("c1").expect("free slot");
        assert!(state.is_running("c1"));
        let err = tauri::async_runtime::block_on(
            state.consult("c1".to_string(), "what did we conclude?".to_string()),
        )
        .expect_err("a busy chat must refuse");
        assert!(err.contains("busy"), "{err}");
        assert!(err.contains("your own conversation"), "{err}");
        drop(held);
        assert!(!state.is_running("c1"));
    }

    /// A consult with nothing to ask is refused before anything is reserved or
    /// persisted.
    #[test]
    fn a_consult_needs_a_question() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.insert_companion(&chat("c1")).unwrap();
        let state = CompanionState::new(db.clone());
        let err = tauri::async_runtime::block_on(state.consult("c1".to_string(), "   ".to_string()))
            .expect_err("an empty question is refused");
        assert!(err.contains("nothing to ask"));
        assert!(!state.is_running("c1"), "the slot was never reserved");
        assert!(db.load_companion_thread("c1").unwrap().is_empty());
    }

    /// The titling pass is the cheapest spawn in the app: no tool surface at
    /// all, which is what makes `bypassPermissions` safe here.
    #[test]
    fn the_titling_spawn_has_no_tool_surface() {
        let args = title_args(None, Vec::new());
        let tools = args.iter().position(|a| a == "--tools").expect("--tools is pinned");
        assert_eq!(args[tools + 1], "", "an empty tool surface, not a narrowed one");
        assert!(args.contains(&"--no-session-persistence".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        // Unconfigured seat -> a fast model; a configured one wins outright.
        assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "haiku"));
        let configured = title_args(
            Some("opus".to_string()),
            vec!["--model".to_string(), "opus".to_string()],
        );
        assert!(
            !configured.windows(2).any(|w| w[0] == "--model" && w[1] == "haiku"),
            "a configured seat must not get a second --model: {configured:?}"
        );
    }

    #[test]
    fn a_title_is_squeezed_into_a_dropdown_row() {
        assert_eq!(clean_title("Anchoring Rework").as_deref(), Some("Anchoring Rework"));
        // Quotes, emphasis, trailing punctuation and preamble lines all go.
        assert_eq!(
            clean_title("\n  **\"Anchoring Rework.\"**  \n").as_deref(),
            Some("Anchoring Rework")
        );
        // Bounded, so a model that ignores the instruction can't write an essay
        // into the dropdown.
        let long = clean_title(&"word ".repeat(60)).unwrap();
        assert!(long.chars().count() <= 60, "{long}");
        // Nothing usable leaves the provisional title standing.
        assert!(clean_title("   \n  ").is_none());
        assert!(clean_title("").is_none());
    }

    /// The voice thread route the routes block advertises must actually
    /// resolve. `voice_messages` names its body column `text`, so an arm
    /// without the alias would have produced `no such column: body`.
    #[test]
    fn the_advertised_voice_thread_route_resolves() {
        fn vm(id: &str, role: &str, text: &str, at: i64) -> crate::state::VoiceMessage {
            crate::state::VoiceMessage {
                id: id.to_string(),
                session_key: "plan-1".to_string(),
                role: role.to_string(),
                text: text.to_string(),
                created_at: at,
            }
        }
        let db = Database::open_in_memory().unwrap();
        db.insert_voice_message(&vm("v1", "you", "read me the plan", 1))
            .unwrap();
        db.insert_voice_message(&vm("v2", "agent", "Here it is.", 2))
            .unwrap();
        let msgs = db
            .load_thread_generic("voice", "plan-1", 50)
            .unwrap()
            .expect("the voice arm exists");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "you");
        assert_eq!(msgs[0].body, "read me the plan", "`text` reads through as `body`");
        assert_eq!(db.thread_stats("voice", "plan-1").unwrap().0, 2);
        // …and the block that advertises it still does.
        assert!(routes_block().contains("/v1/context/threads/voice/<id>"));
    }
}

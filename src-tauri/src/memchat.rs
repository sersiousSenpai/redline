// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Memory surface's Ask agent (Second Brain P4): a headless `claude`
//! session holding ONE persisted conversation over the user's recorded history
//! — the prompt/decision lake and the ClassMemory catalog organized over it.
//!
//! Mirrors `draft_chat.rs`/`linked.rs` (keyed registry, fresh process per turn
//! via `bridge_args` — which preserves the scoped localhost curl allow and
//! `--strict-mcp-config` — DB-persisted resumable session id, `memchat-*`
//! events), but grounds on the memory routes instead of a document or a tab:
//! the first turn teaches the Role-B retrieval contract (the `classmemory`
//! skill's tree-walk) and the citation contract (`#seq` / `[[Class]]` chips
//! the Timeline can jump to); follow-ups carry a ledger high-water-mark header
//! — the memchat analog of draft_chat's doc hash — so the agent knows whether
//! the record grew since its last turn.

use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::browse::{is_context_overflow, is_transient};
use crate::claude_proc::{bridge_args, classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::state::{now_millis, MemChatMessage};
use crate::turn::{self, PartialBuf, QueuedTurn, SendOutcome, SendSlot, TurnStatus, Turns};

/// The one Ask thread's id. The schema is keyed (multi-thread-ready) but the
/// surface holds a single global conversation, so the id is a constant.
pub const MEMCHAT_ID: &str = "memchat";

/// How many assistant turns a CLI session may accumulate before the thread
/// rotates onto a fresh one.
///
/// `--resume` replays the ENTIRE transcript on every spawn, so per-turn latency
/// climbs with conversation length — without a bound, the whole speedup decays
/// over a conversation's life. The only bound before this was reactive: run
/// until the model's context overflowed, then wipe. Rotating proactively is
/// cheap now that a cold start is a baked catalog plus one batched read.
const ROTATE_AFTER_ASSISTANT_TURNS: i64 = 12;

/// `app_settings` key holding the assistant-turn count at the last rotation,
/// so the budget is measured per CLI session rather than per lifetime thread.
const ROTATION_MARK_KEY: &str = "redline.memchat.rotatedAtTurns";

/// How many recent exchanges a rotation carries forward, and how much of each.
const RECAP_EXCHANGES: usize = 3;
const RECAP_BODY_CHARS: usize = 400;

/// Everything a queued Ask send needs to start later. The record-state
/// header, session resume, and prompt framing are all resolved at START time
/// (`start_memchat_turn`), not enqueue time — a drained turn must resume the
/// session the turn ahead of it just established.
pub struct QueuedMemChatSend {
    text: String,
}

/// Registry of running Ask turns, keyed by thread id, on the shared
/// `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct MemChatState {
    turns: Arc<Turns<QueuedMemChatSend>>,
    db: Arc<Database>,
    claude_bin: Arc<OnceLock<String>>,
}

impl MemChatState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
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

    /// Kill every running Ask turn. Backs app teardown.
    pub fn kill_all(&self) {
        self.turns.kill_all();
    }
}

// --- Prompt builders ---------------------------------------------------------

/// First turn: the Ask role, the inlined retrieval contract, the read routes,
/// and the citation-chip contract — followed by a baked snapshot of the user's
/// catalog and then the question.
///
/// TWO TURNS SAVED, DELIBERATELY. The contract used to point at the
/// `classmemory` skill, which cost a `Skill(…)` load turn to read rules that
/// are already spelled out below; and the agent's first act was always a
/// `/v1/memory/tree` curl, which cost a second turn to learn node ids we can
/// hand it for free. Both are gone: the contract is inlined, the catalog rides
/// in the prompt, and the skill is now only worth loading for questions about
/// the taxonomy's SHAPE.
///
/// CACHE-STABLE ORDERING — the entire block above the catalog is invariant, so
/// every first turn shares a byte-identical cacheable prefix; the snapshot and
/// the question sit BELOW it, in that order, so a growing catalog never
/// invalidates the cached prefix. Guarded by
/// `first_turn_invariant_prefix_is_byte_stable`.
fn build_first_turn_prompt(
    user_text: &str,
    snapshot: &str,
    head_seq: i64,
    recap: Option<&str>,
) -> String {
    let mut p = String::from(
        "You are the ASK agent on Redline's Memory surface — the user's window \
         into their own recorded history. Redline captures every prompt they \
         send, every plan approval and decision, the pages they browse, and \
         their own margin notes, into a hash-chained ledger (the \"lake\"), \
         organized by an emergent class catalog (ClassMemory). You answer \
         questions like \"what did I decide about X\", \"what was I \
         researching about Y\", \"when did I last touch Z\" — grounded ONLY in \
         that record. Retrieve first, then answer. Never present a guess as \
         memory; when the record doesn't answer, say what you looked for and \
         where it came up empty.\n\n\
         RETRIEVAL — your contract is inlined here; load the `classmemory` \
         skill ONLY for questions about the taxonomy's own shape (how classes \
         are proposed, promoted, split or collapsed). Route by the question's \
         verb. \"What did I DECIDE\" → decision events first, and answer with \
         CURRENT decisions — an item carrying `supersededBy` is history, not \
         the answer; follow the chain to its head and mention the superseded \
         one only as background. \"What was I RESEARCHING\" → browse/mission \
         prompts and source trust. The user's own notes come FIRST, quoted \
         verbatim — they are the one human-authored signal in the lake, and a \
         starred item outranks an unstarred sibling. Observations come last, \
         labeled as patterns (\"a pattern in your history suggests…\"), never \
         asserted as fact.\n\n\
         THE RECORD — read it through these local routes (already permitted — \
         no approval needed; put the URL immediately after `-s`).\n\n\
         PREFERRED — one batched read that answers most questions in a single \
         call. It returns the resolved node with its children, links (each \
         with `supersededBy`), observations, plus your notes, matching prompts \
         and matching pages. Add `&node=<id>` when the catalog below already \
         names the node:\n  \
         curl -s 'http://127.0.0.1:7676/v1/memory/answer-pack?q=<term>&node=<id>'\n\
         Read the pack, then ANSWER. Reach for the granular routes below only \
         when the pack is genuinely insufficient:\n\
         - The accepted class tree (scope with ?project=<path> or ?root=<id>):\n  \
         curl -s http://127.0.0.1:7676/v1/memory/tree\n\
         - One node: its children, its links into the lake (each carries the \
         ledger seq), and its observations:\n  \
         curl -s http://127.0.0.1:7676/v1/memory/node/<id>\n\
         - Lexical search over captured prompt bodies:\n  \
         curl -s 'http://127.0.0.1:7676/v1/context/prompts?q=<term>&limit=20'\n\
         - BM25 search over captured page bodies:\n  \
         curl -s 'http://127.0.0.1:7676/v1/context/browse/search?q=<term>'\n\
         - Aggregate stats (per day / surface / kind / class / author):\n  \
         curl -s http://127.0.0.1:7676/v1/context/stats\n\
         - A thread's turns / a session's place in the lineage tree:\n  \
         curl -s http://127.0.0.1:7676/v1/context/threads/<kind>/<id>\n  \
         curl -s http://127.0.0.1:7676/v1/context/tree/<kind>/<id>\n\
         - A plan session's revision history:\n  \
         curl -s http://127.0.0.1:7676/v1/context/sessions/<id>/history\n\n\
         CITE EVERYTHING. Every claim you draw from the record must name its \
         evidence inline:\n\
         - a ledger event by its seq, e.g. `(#1042)` — link rows, prompt rows \
         and observation citations all carry seqs; cite the seqs you actually \
         read, never an estimate. A wrong seq points the user at the wrong \
         moment.\n\
         - a catalog class by its exact title in double brackets, e.g. \
         `[[Loop Engineering]]`.\n\
         The UI turns these into chips under your reply that jump the user's \
         Timeline straight to that evidence. Never start a line with `#` — it \
         renders as a heading; cite inline or in parentheses.\n\n\
         FORMATTING — your replies render through Redline's markdown pipeline \
         (tables, fenced code, mermaid). Never emit raw HTML. Lead with the \
         answer, then the evidence.\n\n",
    );
    // Below the invariant block: the variable content, catalog then question.
    p.push_str(&format!(
        "YOUR CATALOG (snapshot as of seq {head_seq} — advisory; verify with \
         the node route when you need current links):\n\n"
    ));
    p.push_str(snapshot);
    if !snapshot.ends_with('\n') {
        p.push('\n');
    }
    if let Some(recap) = recap.filter(|r| !r.trim().is_empty()) {
        p.push_str(recap);
        if !recap.ends_with('\n') {
            p.push('\n');
        }
    }
    p.push_str("\nThe user asks:\n");
    for line in user_text.lines() {
        p.push_str("> ");
        p.push_str(line);
        p.push('\n');
    }
    p
}

/// The recap a rotated conversation carries across: the last few exchanges,
/// bodies clipped. Bounded on purpose — the point of rotating is to stop
/// replaying an ever-growing transcript, so carrying the whole thing forward
/// would defeat it. The UI's history is untouched either way; only the CLI
/// session rotates.
fn build_recap(thread: &[MemChatMessage]) -> String {
    let recent: Vec<&MemChatMessage> = thread
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
         earlier conversation; the exchanges below are its tail, clipped. \
         Treat any fact in them as needing re-verification against the record \
         before you rely on it.\n\n",
    );
    for m in recent.into_iter().rev() {
        let who = if m.role == "user" { "They asked" } else { "You answered" };
        let body: String = m.body.replace('\n', " ").chars().take(RECAP_BODY_CHARS).collect();
        let ellipsis = if m.body.chars().count() > RECAP_BODY_CHARS { "…" } else { "" };
        out.push_str(&format!("- {who}: {body}{ellipsis}\n"));
    }
    out
}

/// Drop the resumable CLI session so the next turn starts cold, and mark where
/// the turn budget restarts. ONE helper for both triggers — the proactive
/// rotation above the turn budget, and the reactive reset when a turn dies of
/// context overflow — so the two can never drift in what they clear.
fn reset_memchat_session(db: &Database, at_turns: i64) {
    if let Err(e) = db.clear_mem_chat_session(MEMCHAT_ID) {
        tracing::warn!(error = %e, "failed to clear the memchat CLI session");
    }
    let _ = db.set_setting(ROTATION_MARK_KEY, &at_turns.to_string());
}

/// Completed assistant turns on the thread — the unit the rotation budget
/// counts in (a queued or errored row is not a turn the CLI will replay).
fn completed_assistant_turns(thread: &[MemChatMessage]) -> i64 {
    thread
        .iter()
        .filter(|m| m.role == "assistant" && m.status == "complete")
        .count() as i64
}

/// How the lake moved between the agent's last turn and this one. A bare
/// "it grew" bit forced a full re-walk on every follow-up; naming the *shape*
/// of the growth lets the agent decide — and lets it recognize the "+1 prompt"
/// that is its own question landing in the record it reads.
pub struct RecordDelta {
    /// The watermark the agent's last turn was pointed at.
    pub from_seq: i64,
    /// The head as of this turn.
    pub to_seq: i64,
    /// `(kind, count)` over the events in between, heaviest first.
    pub kinds: Vec<(String, i64)>,
}

impl RecordDelta {
    fn grew(&self) -> bool {
        self.to_seq > self.from_seq
    }
}

/// Follow-up turn: a one-line record-state header. When the ledger head moved
/// since the agent's last turn, say *how* — the seq window and the kind
/// histogram — so a delta that can't touch the question costs no re-walk (the
/// draft-chat doc-hash idiom applied to the lake instead of the doc).
fn build_followup_prompt(delta: &RecordDelta, user_text: &str) -> String {
    if !delta.grew() {
        return format!("[The record is unchanged since your last turn.]\n\n{user_text}");
    }
    // Count the rows the histogram actually saw, not the seq arithmetic — the
    // window is the authority on its own size.
    let count: i64 = delta.kinds.iter().map(|(_, n)| n).sum();
    let breakdown = delta
        .kinds
        .iter()
        .map(|(kind, n)| format!("{n} {kind}"))
        .collect::<Vec<_>>()
        .join(", ");
    let shape = if breakdown.is_empty() {
        String::new()
    } else {
        format!(": {breakdown}")
    };
    format!(
        "[The record grew: +{count} events (seqs {}–{}{shape}). Re-query ONLY \
         if the question touches these; your earlier reads stand otherwise. \
         Your own previous question is normally one of the `prompt` events — \
         this thread is part of the record it reads.]\n\n{user_text}",
        delta.from_seq + 1,
        delta.to_seq,
    )
}

// --- Events -------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatDelta {
    thread_id: String,
    text: String,
    /// This delta's position in the turn's stream — `memchat_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

/// What the agent is doing right now, in words. Emitted when a retrieval tool
/// call starts, so the panel shows "searching the lake…" instead of a blank
/// elapsed ticker until the first answer token lands. Rides the existing event
/// channel — no new polling.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatStatus {
    thread_id: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatDone {
    thread_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatError {
    thread_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatCancelled {
    thread_id: String,
}

/// A queued send left the queue and became the streaming turn — the frontend
/// flips its bubble's "Queued" chip off.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemChatQueueAdvanced {
    thread_id: String,
    message_id: String,
}

// --- Commands -----------------------------------------------------------------

/// Send a turn to the Ask agent. First turn teaches the role + retrieval +
/// citation contracts; follow-ups carry the record-state header. Streaming
/// happens via `memchat-*` events — this returns once the child is spawned,
/// or with `queued: true` when the send opted in (`queue`) and landed behind
/// an in-flight turn.
#[tauri::command]
pub async fn memchat_send(
    chat: tauri::State<'_, MemChatState>,
    app: AppHandle,
    text: String,
    queue: Option<bool>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let payload = QueuedMemChatSend { text: text.clone() };

    // Atomic reservation; early `?` returns release it via the guard's Drop.
    // Only opted-in sends queue — the busy error stays for everything else.
    let (slot, payload) = if queue.unwrap_or(false) {
        let turn = QueuedTurn {
            message_id: message_id.clone(),
            text: text.clone(),
            queued_at: now_millis(),
        };
        match chat.turns.begin_or_enqueue(MEMCHAT_ID, turn, payload) {
            SendSlot::Began(slot, payload) => (slot, payload),
            SendSlot::Enqueued => {
                // Persist the queued user row so a remount restores the
                // bubble; the reader's drain flips it to `complete`.
                let user_msg = MemChatMessage {
                    id: message_id.clone(),
                    thread_id: MEMCHAT_ID.to_string(),
                    role: "user".to_string(),
                    body: text,
                    status: "queued".to_string(),
                    created_at: now_millis(),
                };
                chat.db
                    .insert_mem_chat_message(&user_msg)
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
        let slot = chat
            .turns
            .begin(MEMCHAT_ID)
            .map_err(|_| "the memory agent is still replying".to_string())?;
        (slot, payload)
    };

    let user_msg = MemChatMessage {
        id: message_id.clone(),
        thread_id: MEMCHAT_ID.to_string(),
        role: "user".to_string(),
        body: text,
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    chat.db
        .insert_mem_chat_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    start_memchat_turn(app, chat.inner().clone(), payload, slot).await?;
    Ok(SendOutcome {
        started: true,
        queued: false,
        message_id,
    })
}

/// Everything a turn needs after its user row is persisted: prompt framing,
/// ledger capture, spawn, attach, reader. Runs on the direct send path AND on
/// the reader's queue drain — which is why session/watermark reads happen
/// here, at start time. Boxed return: see `turn::BoxStartFuture`.
fn start_memchat_turn(
    app: AppHandle,
    chat: MemChatState,
    payload: QueuedMemChatSend,
    slot: turn::SlotGuard<QueuedMemChatSend>,
) -> turn::BoxStartFuture {
    Box::pin(async move {
        let QueuedMemChatSend { text } = payload;
        let mut prior_session = chat.db.get_mem_chat_session(MEMCHAT_ID);

        // Rotation: past the turn budget, retire the CLI session and start a
        // cold one carrying a clipped recap. `--resume` replays the whole
        // transcript per spawn, so an unbounded conversation gets slower every
        // turn no matter how fast retrieval is.
        let thread = chat.db.load_mem_chat_thread(MEMCHAT_ID).unwrap_or_default();
        let turns = completed_assistant_turns(&thread);
        let rotated_at: i64 = chat
            .db
            .get_setting(ROTATION_MARK_KEY)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
            .min(turns);
        let mut recap: Option<String> = None;
        if prior_session.is_some() && turns - rotated_at >= ROTATE_AFTER_ASSISTANT_TURNS {
            tracing::info!(turns, rotated_at, "memchat: rotating the CLI session for speed");
            reset_memchat_session(&chat.db, turns);
            prior_session = None;
            recap = Some(build_recap(&thread));
        }

        // The record-state watermark — the memchat analog of the draft doc hash.
        let head_seq = chat.db.max_ledger_seq().unwrap_or(0);
        let from_seq = chat
            .db
            .get_mem_chat_last_seq(MEMCHAT_ID)
            .unwrap_or(head_seq)
            .min(head_seq);
        let delta = RecordDelta {
            from_seq,
            to_seq: head_seq,
            kinds: if head_seq > from_seq {
                chat.db.ledger_delta_summary(from_seq).unwrap_or_default()
            } else {
                Vec::new()
            },
        };

        let prompt = match &prior_session {
            // First turn: bake the catalog in, so the agent's opening move can
            // be the answer-pack read instead of a tree walk.
            None => {
                let snapshot = chat
                    .db
                    .list_class_nodes_with_counts()
                    .map(|nodes| {
                        crate::classmem::render_catalog_snapshot(
                            &nodes,
                            head_seq,
                            crate::classmem::CATALOG_SNAPSHOT_MAX_BYTES,
                        )
                    })
                    .unwrap_or_else(|e| {
                        tracing::warn!(error = %e, "memchat: catalog snapshot unavailable");
                        "(catalog unavailable — walk it with the tree route)\n".to_string()
                    });
                build_first_turn_prompt(&text, &snapshot, head_seq, recap.as_deref())
            }
            Some(_) => build_followup_prompt(&delta, &text),
        };

        // Polis ledger: the Ask thread is itself part of the record it reads —
        // first turn with thread provenance, follow-ups claimed out of the global
        // hook capture stream.
        if prior_session.is_none() {
            crate::ledger::record_agent_prompt(
                &chat.db,
                crate::ledger::PromptSource::RustFirstTurn,
                "memchat",
                &prompt,
                None,
                None,
                None,
                Some(crate::ledger::ThreadRef {
                    thread_kind: "memchat",
                    thread_id: MEMCHAT_ID.to_string(),
                    parent_session_id: None,
                }),
                crate::seat::model_for("memory"),
            );
        } else {
            crate::ledger::register_agent_prompt(&crate::ledger::body_hash(&prompt));
        }

        // The agent has been pointed at the record as of now; store the
        // watermark as of AFTER this turn's own prompt was appended. Reading it
        // before the append (the original bug) stored a seq the recording had
        // already moved past, so the very next turn always reported a grown
        // record and re-walked the catalog for nothing.
        let after_seq = chat.db.max_ledger_seq().unwrap_or(head_seq).max(head_seq);
        let _ = chat.db.set_mem_chat_last_seq(MEMCHAT_ID, after_seq);

        let args = bridge_args("memory", prompt, prior_session.as_deref());
        // Memory is global, not per-project — HOME keeps Read/Grep/Glob scoped
        // away from whatever repo happens to be open.
        let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());

        let claude_bin = chat.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("memory", &claude_bin);
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
            let _ = app.emit(
                "memchat-cancelled",
                MemChatCancelled {
                    thread_id: MEMCHAT_ID.to_string(),
                },
            );
            return Ok(());
        }

        tauri::async_runtime::spawn(read_memchat(app, chat, buf, token, stdout, stderr));
        Ok(())
    })
}

/// Snapshot of the Ask thread's turn for a remounting MemoryAsk panel:
/// whether a reply is streaming, since when, and the partial text streamed so
/// far (with its delta `seq` watermark).
#[tauri::command]
pub fn memchat_turn_status(chat: tauri::State<'_, MemChatState>) -> TurnStatus {
    chat.turns.status(MEMCHAT_ID)
}

/// The Ask thread's persisted turns, oldest-first.
#[tauri::command]
pub fn memchat_thread(
    chat: tauri::State<'_, MemChatState>,
) -> Result<Vec<MemChatMessage>, String> {
    chat.db
        .load_mem_chat_thread(MEMCHAT_ID)
        .map_err(|e| format!("failed to load thread: {e}"))
}

/// Cancel the in-flight turn (the reader emits `memchat-cancelled`). Queued
/// sends stay queued — the reader's terminal drain advances them.
#[tauri::command]
pub fn memchat_cancel(chat: tauri::State<'_, MemChatState>) -> Result<(), String> {
    if let Some(mut child) = chat.turns.take(MEMCHAT_ID).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    Ok(())
}

/// Remove a queued send (the bubble's ×). Returns its text so the composer
/// can restore it; `None` when the send already advanced. The persisted
/// queued row goes with it.
#[tauri::command]
pub fn memchat_unqueue(
    chat: tauri::State<'_, MemChatState>,
    message_id: String,
) -> Result<Option<String>, String> {
    let Some(turn) = chat.turns.unqueue(MEMCHAT_ID, &message_id) else {
        return Ok(None);
    };
    if let Err(e) = chat.db.delete_thread_message("memchat", &message_id) {
        tracing::warn!(error = %e, "failed to delete the unqueued memchat row");
    }
    Ok(Some(turn.text))
}

/// "New conversation": kill any in-flight turn, drop any queued sends, the
/// thread rows and the resumable session. The turns already captured in the
/// lake stay there.
#[tauri::command]
pub fn memchat_clear(chat: tauri::State<'_, MemChatState>) -> Result<(), String> {
    if let Some(mut child) = chat.turns.discard(MEMCHAT_ID).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    // The rotation budget counts turns on the thread, so wiping the thread must
    // restart the count — otherwise a fresh conversation would inherit a mark
    // above its own turn count and never rotate.
    let _ = chat.db.set_setting(ROTATION_MARK_KEY, "0");
    chat.db
        .delete_mem_chat(MEMCHAT_ID)
        .map_err(|e| format!("failed to clear the Ask thread: {e}"))
}

#[tauri::command]
pub fn memchat_kill_all(chat: tauri::State<'_, MemChatState>) {
    chat.kill_all();
}

// --- Reader -----------------------------------------------------------------

async fn read_memchat(
    app: AppHandle,
    chat: MemChatState,
    buf: Arc<Mutex<PartialBuf>>,
    token: u64,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    let db = chat.db.clone();
    let stdout_fut = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut session: Option<String> = None;
        let mut final_text: Option<String> = None;
        let mut errored: Option<String> = None;
        let mut saw_json = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            saw_json = true;
            // Live retrieval status. Read before classification because a
            // tool_use rides an `assistant` line, which `classify_line`
            // (rightly) ignores — it carries no answer text.
            for (name, input) in crate::claude_proc::tool_uses(&v) {
                let _ = app.emit(
                    "memchat-status",
                    MemChatStatus {
                        thread_id: MEMCHAT_ID.to_string(),
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
                        "memchat-delta",
                        MemChatDelta {
                            thread_id: MEMCHAT_ID.to_string(),
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
        (session, final_text, errored, saw_json)
    };
    let stderr_fut = async {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    };
    let ((session, final_text, errored, saw_json), stderr_text) =
        tokio::join!(stdout_fut, stderr_fut);

    // Reap the proc + pop the queue in ONE critical section, BEFORE emitting
    // the terminal event. Token-matched: a reader outliving a cancel must
    // neither steal a successor turn's proc nor drain its queue.
    let (proc, next) = chat.turns.finish_and_pop(MEMCHAT_ID, token);
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    'terminal: {
        if cancelled {
            let _ = app.emit(
                "memchat-cancelled",
                MemChatCancelled {
                    thread_id: MEMCHAT_ID.to_string(),
                },
            );
            break 'terminal;
        }
        if let Some(err) = errored {
            let why = describe_turn_error(&db, &err);
            finish_error(&app, &db, &why);
            break 'terminal;
        }
        if let Some(text) = final_text {
            if text.trim().is_empty() {
                finish_error(&app, &db, "claude produced an empty reply");
                break 'terminal;
            }
            if let Some(sid) = &session {
                if let Err(e) = db.set_mem_chat_session(MEMCHAT_ID, sid) {
                    tracing::warn!(error = %e, "failed to persist memchat session id");
                }
            }
            let msg = MemChatMessage {
                id: uuid::Uuid::new_v4().to_string(),
                thread_id: MEMCHAT_ID.to_string(),
                role: "assistant".to_string(),
                body: text.clone(),
                status: "complete".to_string(),
                created_at: now_millis(),
            };
            if let Err(e) = db.insert_mem_chat_message(&msg) {
                tracing::warn!(error = %e, "failed to persist assistant message");
            }
            // Companion journal: the Ask agent completed a turn.
            let _ = db.append_journal("agent_turn", Some("memchat"), Some(MEMCHAT_ID), None, None);
            let _ = app.emit(
                "memchat-done",
                MemChatDone {
                    thread_id: MEMCHAT_ID.to_string(),
                    message_id: msg.id,
                    body: text,
                },
            );
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
        finish_error(&app, &db, &why);
    }

    // Drain: `finish_and_pop` already re-reserved the slot for the queue
    // head, so no concurrent send can slip in between the terminal above and
    // the start below.
    if let Some((queued, payload, slot)) = next {
        if let Err(e) = db.set_thread_message_status("memchat", &queued.message_id, "complete") {
            tracing::warn!(error = %e, "failed to flip a drained memchat row");
        }
        let _ = app.emit(
            "memchat-queue-advanced",
            MemChatQueueAdvanced {
                thread_id: MEMCHAT_ID.to_string(),
                message_id: queued.message_id.clone(),
            },
        );
        if let Err(e) = start_memchat_turn(app.clone(), chat.clone(), payload, slot).await {
            // The slot released via the guard's Drop. Flip the row so the UI
            // offers "wasn't sent — resend"; no chain-drain (predictable
            // failure behavior beats a cascade).
            let _ = db.set_thread_message_status("memchat", &queued.message_id, "unsent");
            finish_error(&app, &db, &format!("your queued message wasn't sent: {e}"));
        }
    }
}

/// Same recovery policy as the browse/draft agents: explicit context overflow
/// resets the resumable session (the next turn re-teaches the contracts);
/// transient API errors keep it and ask for a retry.
///
/// The overflow branch is the REACTIVE twin of the proactive rotation in
/// `start_memchat_turn` — same helper, same effect. With the turn budget in
/// place this should now be the rare path: a conversation normally rotates
/// long before the window runs out.
fn describe_turn_error(db: &Database, error: &str) -> String {
    if is_context_overflow(error) {
        let turns = completed_assistant_turns(&db.load_mem_chat_thread(MEMCHAT_ID).unwrap_or_default());
        reset_memchat_session(db, turns);
        return "This conversation outgrew the model's context window, so the \
                turn failed. I've reset its context — ask again and I'll start \
                fresh over your memory (the replies above are kept)."
            .to_string();
    }
    if is_transient(error) {
        return "The model hit a momentary error on that turn. The conversation \
                is fine — send your question again in a moment."
            .to_string();
    }
    error.to_string()
}

fn finish_error(app: &AppHandle, db: &Database, why: &str) {
    let msg = MemChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        thread_id: MEMCHAT_ID.to_string(),
        role: "assistant".to_string(),
        body: why.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_mem_chat_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error message");
    }
    let _ = app.emit(
        "memchat-error",
        MemChatError {
            thread_id: MEMCHAT_ID.to_string(),
            error: why.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_turn_teaches_role_routes_retrieval_and_citations() {
        let p = build_first_turn_prompt(
            "what did I decide about the loop engine?",
            "- Loop Engineering [n-loop] (12 links)\n",
            4224,
            None,
        );
        // The Ask role over the recorded history — never invented memory.
        assert!(p.contains("ASK agent"));
        assert!(p.contains("Never present a guess as memory"));
        // The retrieval contract is INLINE — the skill load is a turn we no
        // longer pay on an ordinary question.
        assert!(p.contains("your contract is inlined here"));
        assert!(p.contains("skill ONLY for questions about the taxonomy's own shape"));
        assert!(
            !p.contains("follow your `classmemory` skill"),
            "the skill must not be the retrieval instruction any more"
        );
        // The batched read leads the route list.
        assert!(p.contains("/v1/memory/answer-pack?q="));
        assert!(p.contains("Read the pack, then ANSWER"));
        let pack_at = p.find("answer-pack").unwrap();
        let tree_at = p.find("/v1/memory/tree").unwrap();
        assert!(pack_at < tree_at, "the answer-pack must be taught FIRST");
        // The baked catalog and its advisory framing.
        assert!(p.contains("YOUR CATALOG (snapshot as of seq 4224"));
        assert!(p.contains("- Loop Engineering [n-loop] (12 links)"));
        assert!(p.contains("CURRENT decisions"));
        assert!(p.contains("`supersededBy` is history"));
        assert!(p.contains("notes come FIRST, quoted verbatim"));
        assert!(p.contains("labeled as patterns"));
        // Every read route the walk needs.
        assert!(p.contains("/v1/memory/tree"));
        assert!(p.contains("/v1/memory/node/<id>"));
        assert!(p.contains("/v1/context/prompts?q="));
        assert!(p.contains("/v1/context/browse/search?q="));
        assert!(p.contains("/v1/context/stats"));
        assert!(p.contains("/v1/context/threads/<kind>/<id>"));
        assert!(p.contains("/v1/context/tree/<kind>/<id>"));
        assert!(p.contains("/v1/context/sessions/<id>/history"));
        // The citation-chip contract, both keyspaces.
        assert!(p.contains("(#1042)"));
        assert!(p.contains("[[Loop Engineering]]"));
        assert!(p.contains("Never start a line with `#`"));
        // The user's question, quoted.
        assert!(p.contains("> what did I decide about the loop engine?"));
    }

    /// Two first turns with different catalogs AND different questions share a
    /// byte-identical prefix spanning the whole invariant block — the
    /// cache-stable ordering contract. The catalog snapshot is variable
    /// content, so it must sit below that block (and above the question).
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
        let a = build_first_turn_prompt("what did I decide about X?", "- A [a] (1 links)\n", 10, None);
        let b = build_first_turn_prompt("entirely different question", "- B [b] (99 links)\n", 77, None);
        let shared = common_prefix(&a, &b);
        // The shared prefix must reach the END of the invariant block — the
        // formatting contract closes it, right before the catalog.
        assert!(shared.contains("Lead with the answer, then the evidence."));
        assert!(
            shared.len() >= a.find("YOUR CATALOG").unwrap(),
            "the whole invariant block must be byte-identical"
        );
        // …and it must stop there: neither catalog rows nor the question.
        assert!(!shared.contains("(1 links)"), "the catalog is variable");
        assert!(!shared.contains("what did I decide about X?"));
        // Order below the block: catalog, THEN the question.
        assert!(a.find("YOUR CATALOG").unwrap() < a.find("The user asks:").unwrap());
    }

    fn delta(from_seq: i64, to_seq: i64, kinds: &[(&str, i64)]) -> RecordDelta {
        RecordDelta {
            from_seq,
            to_seq,
            kinds: kinds.iter().map(|(k, n)| ((*k).to_string(), *n)).collect(),
        }
    }

    #[test]
    fn followup_names_the_shape_of_a_grown_record() {
        let grew = build_followup_prompt(
            &delta(4212, 4224, &[("browse_event", 8), ("prompt", 3), ("approval", 1)]),
            "and the beta?",
        );
        // The count, the seq window, and the kind histogram — enough to decide
        // whether the delta can touch the question at all.
        assert!(grew.contains("+12 events"));
        assert!(grew.contains("seqs 4213–4224"));
        assert!(grew.contains("8 browse_event, 3 prompt, 1 approval"));
        assert!(grew.contains("Re-query ONLY"));
        assert!(grew.ends_with("and the beta?"));

        let same = build_followup_prompt(&delta(4224, 4224, &[]), "and the beta?");
        assert!(same.contains("unchanged"));
        assert!(!same.contains("The record grew"));
    }

    /// `SELECT kind, COUNT(*) … WHERE seq > ?` over a real chain — the header's
    /// histogram must count only what landed after the watermark.
    #[test]
    fn ledger_delta_summary_counts_only_the_window() {
        let db = Database::open_in_memory().unwrap();
        for _ in 0..3 {
            crate::ledger::record_agent_prompt(
                &db,
                crate::ledger::PromptSource::RustFirstTurn,
                "memchat",
                &format!("q{}", uuid::Uuid::new_v4()),
                None,
                None,
                None,
                None,
                None,
            );
        }
        let head = db.max_ledger_seq().unwrap();
        assert_eq!(head, 3);
        let all = db.ledger_delta_summary(0).unwrap();
        assert_eq!(all, vec![("prompt".to_string(), 3)]);
        // Windowed: only the tail.
        assert_eq!(
            db.ledger_delta_summary(2).unwrap(),
            vec![("prompt".to_string(), 1)]
        );
        // At the head, nothing grew.
        assert!(db.ledger_delta_summary(head).unwrap().is_empty());
    }

    #[test]
    fn mem_chat_thread_rows_and_watermark_round_trip() {
        let db = Database::open_in_memory().unwrap();
        // No thread yet: no session, no watermark, empty thread.
        assert!(db.get_mem_chat_session(MEMCHAT_ID).is_none());
        assert!(db.get_mem_chat_last_seq(MEMCHAT_ID).is_none());
        assert!(db.load_mem_chat_thread(MEMCHAT_ID).unwrap().is_empty());

        let msg = MemChatMessage {
            id: "m1".to_string(),
            thread_id: MEMCHAT_ID.to_string(),
            role: "user".to_string(),
            body: "what did I decide?".to_string(),
            status: "complete".to_string(),
            created_at: 1,
        };
        db.insert_mem_chat_message(&msg).unwrap();
        db.set_mem_chat_session(MEMCHAT_ID, "sid-1").unwrap();
        db.set_mem_chat_last_seq(MEMCHAT_ID, 42).unwrap();
        // The upserts must not clobber each other's column.
        assert_eq!(db.get_mem_chat_session(MEMCHAT_ID).as_deref(), Some("sid-1"));
        assert_eq!(db.get_mem_chat_last_seq(MEMCHAT_ID), Some(42));
        assert_eq!(db.load_mem_chat_thread(MEMCHAT_ID).unwrap().len(), 1);

        // Overflow recovery clears only the session; the watermark survives.
        db.clear_mem_chat_session(MEMCHAT_ID).unwrap();
        assert!(db.get_mem_chat_session(MEMCHAT_ID).is_none());
        assert_eq!(db.get_mem_chat_last_seq(MEMCHAT_ID), Some(42));

        // "New conversation" drops everything.
        db.delete_mem_chat(MEMCHAT_ID).unwrap();
        assert!(db.load_mem_chat_thread(MEMCHAT_ID).unwrap().is_empty());
        assert!(db.get_mem_chat_last_seq(MEMCHAT_ID).is_none());
    }

    fn msg(id: &str, role: &str, body: &str, at: i64) -> MemChatMessage {
        MemChatMessage {
            id: id.to_string(),
            thread_id: MEMCHAT_ID.to_string(),
            role: role.to_string(),
            body: body.to_string(),
            status: "complete".to_string(),
            created_at: at,
        }
    }

    /// The rotation trigger: the budget counts COMPLETED assistant turns since
    /// the last rotation, so a queued or errored row can't spend it.
    #[test]
    fn rotation_fires_at_the_turn_budget() {
        let db = Database::open_in_memory().unwrap();
        let mut thread = Vec::new();
        for i in 0..(ROTATE_AFTER_ASSISTANT_TURNS - 1) {
            thread.push(msg(&format!("u{i}"), "user", "q", i * 2));
            thread.push(msg(&format!("a{i}"), "assistant", "a", i * 2 + 1));
        }
        assert_eq!(completed_assistant_turns(&thread), ROTATE_AFTER_ASSISTANT_TURNS - 1);
        assert!(
            completed_assistant_turns(&thread) < ROTATE_AFTER_ASSISTANT_TURNS,
            "one short of the budget must not rotate"
        );
        // The turn that reaches the budget rotates.
        thread.push(msg("u-last", "user", "q", 100));
        let mut done = msg("a-last", "assistant", "a", 101);
        thread.push(done.clone());
        assert_eq!(completed_assistant_turns(&thread), ROTATE_AFTER_ASSISTANT_TURNS);
        // An errored assistant row is not a turn the CLI replays.
        done.id = "a-err".into();
        done.status = "error".into();
        thread.push(done);
        assert_eq!(
            completed_assistant_turns(&thread),
            ROTATE_AFTER_ASSISTANT_TURNS,
            "an errored row does not spend the budget"
        );

        // The reset drops only the CLI session; the thread and watermark stay.
        db.set_mem_chat_session(MEMCHAT_ID, "sid-1").unwrap();
        db.set_mem_chat_last_seq(MEMCHAT_ID, 4224).unwrap();
        db.insert_mem_chat_message(&thread[0]).unwrap();
        reset_memchat_session(&db, ROTATE_AFTER_ASSISTANT_TURNS);
        assert!(db.get_mem_chat_session(MEMCHAT_ID).is_none(), "CLI session rotated");
        assert_eq!(db.get_mem_chat_last_seq(MEMCHAT_ID), Some(4224), "watermark survives");
        assert_eq!(db.load_mem_chat_thread(MEMCHAT_ID).unwrap().len(), 1, "history survives");
        // …and the budget restarts from here, so the next rotation is another
        // full budget away rather than firing on every subsequent turn.
        assert_eq!(
            db.get_setting(ROTATION_MARK_KEY).as_deref(),
            Some("12"),
            "the mark records where the new session began"
        );
    }

    /// The recap must carry the tail of the conversation, bounded, and say
    /// plainly that its contents are not evidence.
    #[test]
    fn recap_is_present_and_bounded() {
        let long_body = "x".repeat(RECAP_BODY_CHARS * 3);
        let mut thread = Vec::new();
        for i in 0..10 {
            thread.push(msg(&format!("u{i}"), "user", &format!("question {i}"), i * 2));
            thread.push(msg(&format!("a{i}"), "assistant", &long_body, i * 2 + 1));
        }
        let recap = build_recap(&thread);
        assert!(recap.contains("CONVERSATION SO FAR — rotated for speed"));
        assert!(recap.contains("needing re-verification"));
        // Only the tail, oldest-of-the-tail first.
        assert!(recap.contains("question 9"), "the newest exchange is carried");
        assert!(!recap.contains("question 0"), "the head is not");
        let asked = recap.matches("They asked").count();
        assert_eq!(asked, RECAP_EXCHANGES, "exactly the budgeted exchanges");
        assert!(recap.find("question 7").unwrap() < recap.find("question 9").unwrap());
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

    /// A rotated first turn is a normal first turn PLUS the recap, in order:
    /// invariant block, catalog, recap, question.
    #[test]
    fn rotated_first_turn_carries_the_recap_between_catalog_and_question() {
        let thread = vec![
            msg("u1", "user", "what did I decide about the loop?", 1),
            msg("a1", "assistant", "You chose the executor.", 2),
        ];
        let recap = build_recap(&thread);
        let p = build_first_turn_prompt("and the beta?", "- A [a] (1 links)\n", 42, Some(&recap));
        assert!(p.contains("CONVERSATION SO FAR"));
        assert!(p.contains("You chose the executor."));
        let catalog = p.find("YOUR CATALOG").unwrap();
        let recap_at = p.find("CONVERSATION SO FAR").unwrap();
        let question = p.find("The user asks:").unwrap();
        assert!(catalog < recap_at && recap_at < question);
        // An unrotated first turn carries no recap block at all.
        let plain = build_first_turn_prompt("and the beta?", "- A [a] (1 links)\n", 42, None);
        assert!(!plain.contains("CONVERSATION SO FAR"));
    }

    /// Regression: the stored watermark must be the head as of AFTER the turn's
    /// own prompt was appended. Storing the pre-append read (the original bug)
    /// left the watermark one event behind the chain, so the next turn always
    /// saw a "grown" record and re-walked the whole catalog for nothing.
    #[test]
    fn watermark_is_read_after_the_turns_own_prompt_lands() {
        let db = Database::open_in_memory().unwrap();
        // The exact ordering `start_memchat_turn` performs.
        let head_seq = db.max_ledger_seq().unwrap();
        crate::ledger::record_agent_prompt(
            &db,
            crate::ledger::PromptSource::RustFirstTurn,
            "memchat",
            "what did I decide about X?",
            None,
            None,
            None,
            None,
            None,
        );
        let after_seq = db.max_ledger_seq().unwrap().max(head_seq);
        db.set_mem_chat_last_seq(MEMCHAT_ID, after_seq).unwrap();

        // The turn's own prompt moved the chain…
        assert!(after_seq > head_seq, "the prompt must have been recorded");
        // …and the watermark tracks the chain, so the NEXT turn sees no growth.
        assert_eq!(db.get_mem_chat_last_seq(MEMCHAT_ID), Some(after_seq));
        assert_eq!(db.max_ledger_seq().unwrap(), after_seq);
        assert!(db.ledger_delta_summary(after_seq).unwrap().is_empty());
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Prompt Drafter's discussion agent: a headless `claude` session, one per
//! draft, that helps the user CRAFT the prompt they're authoring — and can
//! write into the document itself by posting tracked suggestions through
//! `POST /v1/drafter/:id/suggestions` (rendered by the drafter as accept/reject
//! changes; see `validate_suggestion` for the contract the daemon enforces).
//!
//! Mirrors `browse.rs` (keyed registry, fresh process per turn via
//! `bridge_args`, DB-persisted resumable session id, `draft-chat-*` events),
//! but grounds on the draft's live markdown mirror instead of a DOM snapshot:
//! the first turn embeds the draft; every follow-up carries a doc-hash header,
//! and when the hash moved since the agent's last turn the header says so and
//! tells it to re-read `/v1/drafter/:id/doc` before answering.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use crate::browse::{is_context_overflow, is_transient};
use crate::claude_proc::{
    bridge_args, classify_line, mission_context_block, resolve_claude_bin,
    StreamLine,
};
use crate::db::Database;
use crate::state::{now_millis, DraftChatMessage};
use crate::turn::{self, PartialBuf, SlotGuard, TurnStatus, Turns};

/// Registry of running draft-chat turns, keyed by `draft_id`, on the shared
/// `turn::Turns` contract (atomic slot reservation + probeable partial
/// buffer). Cloned into managed Tauri state.
#[derive(Clone)]
pub struct DraftChatState {
    turns: Arc<Turns<()>>,
    /// The in-flight ✦-instruction's target block per draft (see
    /// [`PendingInstructs`]) — how a remounting PromptDrafter re-arms its
    /// event gate and block pulse.
    pending_instruct: Arc<PendingInstructs>,
    db: Arc<Database>,
    claude_bin: Arc<OnceLock<String>>,
}

impl DraftChatState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            turns: Arc::new(Turns::new()),
            pending_instruct: Arc::new(PendingInstructs::default()),
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

    /// Whether a turn is streaming for this draft's discussion. Consumed by the
    /// Companion's agent map + consult dispatch (Phase E).
    #[allow(dead_code)]
    pub fn is_running(&self, draft_id: &str) -> bool {
        self.turns.is_running(draft_id)
    }

    /// Kill every running draft-chat turn. Backs app teardown.
    pub fn kill_all(&self) {
        self.turns.kill_all();
    }

    /// "Check in with a colleague" for the Companion's `/v1/global/consult`:
    /// run THIS draft's discussion agent to completion with a synthesis-framed
    /// question and return only its digest. Mirrors `BrowseState::consult`.
    pub async fn consult(&self, draft_id: String, question: String) -> Result<String, String> {
        if question.trim().is_empty() {
            return Err("nothing to ask the colleague".to_string());
        }
        // Atomic reservation; early `?` returns release it via the guard's Drop.
        let slot = self
            .turns
            .begin(&draft_id)
            .map_err(|_| "the draft agent is busy — try again in a moment".to_string())?;
        let (title, project_path, markdown, _) = self
            .db
            .get_draft(&draft_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no such draft".to_string())?;
        let prior_session = self.db.get_draft_chat_session(&draft_id);

        let check_in = DraftChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            draft_id: draft_id.clone(),
            role: "user".to_string(),
            body: format!("🧭 Companion checking in — {}", question.trim()),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_draft_chat_message(&check_in) {
            tracing::warn!(error = %e, "failed to persist consult check-in");
        }

        let framed = format!(
            "The user's COMPANION — their global cross-surface discussion — is \
             checking in with you about THIS draft. Synthesize what matters here \
             for their question as a tight DIGEST (not a transcript, not a fresh \
             reply to the user, and post NO suggestions for this). Be concise. \
             Their question:\n\n{}",
            question.trim()
        );
        let prompt = match &prior_session {
            None => build_first_turn_prompt(
                &draft_id,
                title.as_deref(),
                project_path.as_deref(),
                &markdown,
                &framed,
                None,
            ),
            Some(_) => framed.clone(),
        };
        crate::ledger::register_agent_prompt(&prompt);

        let args = bridge_args("drafter", prompt, prior_session.as_deref());
        let cwd = project_path
            .filter(|p| !p.trim().is_empty())
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_else(|| "/".to_string());
        let claude_bin = self.claude_bin().await?;
        let mut cmd = crate::claude_proc::claude_command_for_seat("drafter", &claude_bin);
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
        let proc = self.turns.take(&draft_id).and_then(|p| p.child);
        let outcome = match outcome {
            Ok(o) => o,
            Err(_) => {
                if let Some(mut child) = proc {
                    let _ = child.start_kill();
                }
                let _ = self.db.record_friction(
                    "turn_timeout",
                    Some("drafter"),
                    Some(&draft_id),
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
            let _ = self.db.set_draft_chat_session(&draft_id, sid);
        }
        let reply = DraftChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            draft_id: draft_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = self.db.insert_draft_chat_message(&reply) {
            tracing::warn!(error = %e, "failed to persist consult reply");
        }
        Ok(text)
    }
}

// --- Prompt builders ---------------------------------------------------------

/// The write contract the agent is taught, verbatim in both the first-turn
/// prompt and `skills/drafter/SKILL.md`. Kept as one constant so prompt and
/// docs can't drift.
fn suggestions_contract(draft_id: &str) -> String {
    format!(
        "WRITING INTO THE DOCUMENT — you can draft and edit the prompt directly. \
         Post a suggestion (already permitted — no approval needed). This write \
         route needs the bearer token, which curl imports straight from the \
         environment with the two flags shown — never write \
         `$REDLINE_DAEMON_TOKEN` into the command yourself (requires curl \
         >= 8.3):\n\
         ```\n\
         curl -s http://127.0.0.1:7676/v1/drafter/{draft_id}/suggestions \\\n\
           --variable %REDLINE_DAEMON_TOKEN= \\\n\
           --expand-header \"Authorization: Bearer {{{{REDLINE_DAEMON_TOKEN}}}}\" \\\n\
           -X POST \\\n\
           -H 'Content-Type: application/json' \\\n\
           -d '{{\"op\":\"append\",\"markdown\":\"<new content>\",\"agent_id\":\"draft-agent\",\"body\":\"<one-line why>\"}}'\n\
         ```\n\
         Ops:\n\
         - `append` — add new content at the end. Into an EMPTY draft it applies \
           directly (this is how you draft a prompt from scratch); otherwise it \
           lands as a tracked suggestion.\n\
         - `replace_block` — rewrite one block: pass `block_id` (from the \
           `<!-- rl:blk-… -->` markers in the doc markdown) AND `original` (the \
           block's markdown exactly as you read it — the staleness guard).\n\
         - `insert_after` — new block(s) after `block_id`.\n\
         - `delete_block` — remove `block_id` (pass `original` too).\n\
         Every block-addressed op renders in the document as a tracked change the \
         user accepts or rejects — never assume an edit landed; re-read the doc to \
         see the outcome. A 409 means the block changed under you or carries an \
         open suggestion: re-read the doc and retry against current content.\n\
         ✦ INSTRUCTION TURNS — a turn tagged `✦ IN-DOCUMENT INSTRUCTION` or \
         `✦ SELECTION INSTRUCTION` means the user wrote an instruction inside \
         the document itself. Execute it as suggestions per that turn's \
         contract (consume the instruction paragraph via `replace_block`, \
         `insert_after` for extra blocks) and reply in chat with ONE short \
         line — the content lives in the document, never restated in chat."
    )
}

fn doc_route_block(draft_id: &str) -> String {
    format!(
        "THE DOCUMENT — the draft lives at (already permitted — no approval needed):\n  \
         curl -s http://127.0.0.1:7676/v1/drafter/{draft_id}/doc\n\
         It returns the live markdown (with `<!-- rl:blk-… -->` block-identity \
         markers — ignore them when quoting, use them to address edits). The user \
         edits continuously; re-read whenever you need current text."
    )
}

/// First turn: role + the embedded draft + doc route + write contract + skill.
#[allow(clippy::too_many_arguments)]
fn build_first_turn_prompt(
    draft_id: &str,
    title: Option<&str>,
    project_path: Option<&str>,
    draft_markdown: &str,
    user_text: &str,
    mission: Option<(&str, &str)>,
) -> String {
    // CACHE-STABLE ORDERING — most-stable text first: the globally invariant
    // role + formatting contract, then the per-draft-stable doc route + write
    // contract (fixed for a given draft across all its sessions), then every
    // variable section (title, project, mission, draft body, user text). Same
    // information, pinned order — two first turns on the same draft share a
    // byte-identical cacheable prefix. Guarded by
    // `first_turn_invariant_prefix_is_byte_stable`.
    let mut p = String::new();
    p.push_str(
        "You are the discussion agent for a document in Redline's Prompt Drafter — \
         a Word-style editor where the user is AUTHORING A PROMPT to launch into a \
         fresh Claude Code planning session. You are their prompt-crafting \
         collaborator: sharpen intent, surface missing constraints and context, \
         propose structure, and (when asked, or when a draft is clearly wanted) \
         write into the document yourself via the suggestions endpoint below.\n\n\
         Follow your `drafter` skill if you have it.\n\n\
         FORMATTING — your replies render through Redline's markdown pipeline \
         (tables, fenced code, mermaid). Never emit raw HTML.\n\n",
    );
    p.push_str(&doc_route_block(draft_id));
    p.push_str("\n\n");
    p.push_str(&suggestions_contract(draft_id));
    p.push_str("\n\n");
    // --- variable content below; nothing invariant may follow ---
    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        p.push_str(&format!("Draft: {t}\n"));
    }
    if let Some(proj) = project_path.filter(|s| !s.trim().is_empty()) {
        p.push_str(&format!(
            "The prompt will launch a plan session in: {proj}\n\
             You may Read/Grep/Glob that project to ground your advice in the real code.\n"
        ));
    }
    p.push('\n');
    p.push_str(&mission_context_block(mission));
    let body = draft_markdown.trim();
    if body.is_empty() {
        p.push_str("--- CURRENT DRAFT ---\n(the document is empty)\n--- END DRAFT ---\n\n");
    } else {
        p.push_str(&format!("--- CURRENT DRAFT ---\n{body}\n--- END DRAFT ---\n\n"));
    }
    p.push_str(&format!("The user says:\n\n{user_text}"));
    p
}

/// Follow-up turn: a one-line doc-state header. When the doc hash moved since
/// the agent's last turn, say so and instruct a re-read (the linked-discussion
/// re-grounding idiom applied to the doc instead of the tab).
fn build_followup_prompt(draft_id: &str, doc_changed: bool, user_text: &str) -> String {
    if doc_changed {
        format!(
            "[The draft has CHANGED since your last turn — re-read it before \
             answering: curl -s http://127.0.0.1:7676/v1/drafter/{draft_id}/doc]\n\n{user_text}"
        )
    } else {
        format!("[The draft is unchanged since your last turn.]\n\n{user_text}")
    }
}

/// The ✦ instruction turn: the user wrote an instruction INSIDE the document
/// (Cmd+Enter on the paragraph / the ✦ toolbar button), or selected text and
/// typed one. No new wire op — the contract is a prompt discipline: the agent
/// CONSUMES the instruction paragraph with `replace_block` (rl_del of the
/// instruction + rl_ins of the generated content is exactly what the tracked
/// diff renders; reject restores the instruction verbatim), `insert_after`
/// for any extra blocks, then ONE short chat line.
fn build_instruction_prompt(
    draft_id: &str,
    block_id: &str,
    instruction: &str,
    sel_quote: Option<&str>,
    sel_char_start: Option<i64>,
    sel_char_end: Option<i64>,
) -> String {
    let instruction = instruction.trim();
    let selection = sel_quote.map(str::trim).filter(|q| !q.is_empty());
    let mut p = String::new();
    match selection {
        Some(quote) => {
            let range = match (sel_char_start, sel_char_end) {
                (Some(a), Some(b)) => format!(" (chars {a}\u{2013}{b} of the block)"),
                _ => String::new(),
            };
            p.push_str(&format!(
                "✦ SELECTION INSTRUCTION — inside block `{block_id}` the user \
                 selected this text{range}:\n\n> {quote}\n\nand asked:\n\n> {instruction}\n\n\
                 Rewrite THE SELECTION per the instruction: post ONE `replace_block` \
                 op targeting block `{block_id}` whose `markdown` is that block's \
                 CURRENT markdown with only the selected span rewritten — everything \
                 outside the span stays verbatim, so the tracked diff highlights \
                 exactly your rewrite."
            ));
        }
        None => {
            p.push_str(&format!(
                "✦ IN-DOCUMENT INSTRUCTION — the user wrote an instruction as a \
                 paragraph in the draft, block `{block_id}`:\n\n> {instruction}\n\n\
                 Write what it asks for INTO the document by CONSUMING that \
                 paragraph: post ONE `replace_block` op targeting block \
                 `{block_id}` whose `markdown` is the generated content. The \
                 instruction paragraph must NOT survive — replacing it with the \
                 content is the contract (a rejected suggestion restores the \
                 instruction verbatim). Need more than one block? `replace_block` \
                 the instruction with the FIRST block, then `insert_after` the \
                 rest in reading order."
            ));
        }
    }
    p.push_str(&format!(
        "\n\nFor `original`, use the block's markdown exactly as you read it \
         (re-read http://127.0.0.1:7676/v1/drafter/{draft_id}/doc when unsure — \
         a 409 means the doc moved: re-read and retry). Then reply in chat with \
         ONE short line — what you drafted and any assumption worth flagging. Do \
         not restate the content in chat; it lives in the document."
    ));
    p
}

// --- Suggestion validation ----------------------------------------------------

/// The write ops the suggestions endpoint accepts.
pub const SUGGESTION_OPS: [&str; 4] = ["append", "replace_block", "insert_after", "delete_block"];

/// The mirror text belonging to one block: everything between that block's
/// `<!-- rl:blk-{bare} -->` sidecar and the next sidecar (or the end of the
/// document). `None` when the block isn't in the mirror at all.
///
/// This is what makes the `original` staleness check mean anything. Checking
/// `mirror.contains(original)` asks "does this text appear ANYWHERE in the
/// document" — so an `original` that also appears in some other block passes
/// validation while the targeted block has changed underneath it, and the agent
/// writes over an edit it never saw. Short `original` values ("Ship auth.", a
/// heading, a bullet) collide constantly.
pub fn block_slice<'a>(mirror_markdown: &'a str, bare: &str) -> Option<&'a str> {
    const MARK: &str = "<!-- rl:blk-";
    let marker = format!("{MARK}{bare} -->");
    let start = mirror_markdown.find(&marker)? + marker.len();
    let rest = &mirror_markdown[start..];
    Some(match rest.find(MARK) {
        Some(next) => &rest[..next],
        None => rest,
    })
}

/// Validate a suggestion against the draft's CURRENT markdown mirror. Returns
/// `Err((status, message))` with 400 for a malformed request and 409 for a
/// staleness conflict (unknown block / `original` no longer present **in that
/// block**) — the agent's re-read-and-retry signal.
pub fn validate_suggestion(
    mirror_markdown: &str,
    op: &str,
    block_id: Option<&str>,
    original: Option<&str>,
    markdown: &str,
) -> Result<(), (u16, String)> {
    if !SUGGESTION_OPS.contains(&op) {
        return Err((400, format!("unknown op `{op}`")));
    }
    if op != "delete_block" && markdown.trim().is_empty() {
        return Err((400, "empty markdown".to_string()));
    }
    if op == "append" {
        return Ok(());
    }
    let Some(bid) = block_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err((400, format!("`{op}` requires blockId")));
    };
    // The mirror is serialized with sidecars, so a live block appears as
    // `<!-- rl:blk-XXXX -->`. Accept the id with or without the `blk-` prefix.
    let bare = bid.trim_start_matches("blk-");
    let Some(slice) = block_slice(mirror_markdown, bare) else {
        return Err((
            409,
            format!("block `{bid}` is not in the current draft — re-read the doc and retry"),
        ));
    };
    if let Some(orig) = original.map(str::trim).filter(|s| !s.is_empty()) {
        // Scoped to the targeted block, not the whole mirror: the question is
        // "is THIS block still what you read", and only the block can answer it.
        if !slice.contains(orig) {
            return Err((
                409,
                "the block changed since you read it — re-read the doc and retry".to_string(),
            ));
        }
    }
    Ok(())
}

// --- Events -------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftChatDelta {
    draft_id: String,
    text: String,
    /// This delta's position in the turn's stream — `draft_turn_status`
    /// reports the seq already folded into `partial`, and the frontend drops
    /// any delta at or below that watermark.
    seq: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftChatDone {
    draft_id: String,
    message_id: String,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftChatError {
    draft_id: String,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DraftChatCancelled {
    draft_id: String,
}

// --- Commands -------------------------------------------------------------

/// The spawn tail for `draft_instruct`: resolve
/// the CLI, spawn the turn (resuming `prior_session` when set), attach it to
/// the caller's reservation, and wire the streaming reader. Streaming happens
/// via `draft-chat-*`. An instruct turn passes its target block in
/// `instruct_block`; the marker is set only once the spawn attached (a failed
/// or cancelled spawn must never leave a phantom pulse to restore).
#[allow(clippy::too_many_arguments)]
async fn run_draft_turn(
    chat: &DraftChatState,
    app: AppHandle,
    slot: SlotGuard<()>,
    draft_id: String,
    prompt: String,
    prior_session: Option<String>,
    cwd: Option<String>,
    project_path: Option<String>,
    instruct: Option<InstructMeta>,
) -> Result<(), String> {
    let args = bridge_args("drafter", prompt, prior_session.as_deref());
    let cwd = cwd
        .or(project_path)
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".to_string());

    let claude_bin = chat.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("drafter", &claude_bin);
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
    if let Err(mut child) = slot.attach(child) {
        // Cancelled during the spawn window.
        let _ = child.start_kill();
        let _ = app.emit("draft-chat-cancelled", DraftChatCancelled { draft_id });
        return Ok(());
    }

    // The spawn is live — mark the ✦ instruction so a remounting PromptDrafter's
    // `draft_turn_status` probe can restore both the pulse and Retry. The reader
    // owns the matching take at terminal time.
    let instruct_nonce = instruct.map(|meta| chat.pending_instruct.set(&draft_id, meta));

    tauri::async_runtime::spawn(read_draft_chat(
        app,
        chat.db.clone(),
        chat.turns.clone(),
        chat.pending_instruct.clone(),
        instruct_nonce,
        buf,
        draft_id,
        stdout,
        stderr,
    ));
    Ok(())
}

/// Snapshot of this draft's discussion turn for a remounting PromptDrafter:
/// whether a reply is streaming, since when, and the partial text streamed so
/// far (with its delta `seq` watermark), plus the in-flight ✦-instruction when
/// there is one.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTurnStatus {
    #[serde(flatten)]
    pub status: TurnStatus,
    pub instruct: Option<InstructMeta>,
}

/// The in-flight ✦-instruction, for restoring the block pulse after a remount.
/// It carries the `instruction` as well as the target because the re-arm probe
/// is the only thing that can put `lastInstruct` back — without it Retry is
/// dead for any turn recovered across a remount, which is exactly the turn most
/// likely to need it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructMeta {
    pub block_id: String,
    pub instruction: String,
}

/// The per-draft ✦-instruction markers. Set after a successful spawn in
/// `draft_instruct`, probed by `draft_turn_status`, and taken EXACTLY ONCE at
/// terminal time by the turn's own reader (the `pending_synthesize` take-once
/// discipline). Entries are nonce-stamped: a reader that outlives a cancel
/// (its child killed, EOF still draining) must not clear the marker a
/// successor instruct set on the same draft — the turn registry's ABA rule
/// applied here.
#[derive(Default)]
pub struct PendingInstructs {
    inner: Mutex<HashMap<String, (InstructMeta, u64)>>,
    next_nonce: AtomicU64,
}

impl PendingInstructs {
    fn set(&self, draft_id: &str, meta: InstructMeta) -> u64 {
        let nonce = self.next_nonce.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner
            .lock()
            .unwrap()
            .insert(draft_id.to_string(), (meta, nonce));
        nonce
    }

    /// Remove the draft's marker — only if it is still the one stamped with
    /// this reader's nonce.
    fn take(&self, draft_id: &str, nonce: u64) {
        let mut m = self.inner.lock().unwrap();
        if m.get(draft_id).is_some_and(|(_, n)| *n == nonce) {
            m.remove(draft_id);
        }
    }

    fn peek(&self, draft_id: &str) -> Option<InstructMeta> {
        self.inner
            .lock()
            .unwrap()
            .get(draft_id)
            .map(|(meta, _)| meta.clone())
    }
}

#[tauri::command]
pub fn draft_turn_status(
    chat: tauri::State<'_, DraftChatState>,
    draft_id: String,
) -> DraftTurnStatus {
    DraftTurnStatus {
        status: chat.turns.status(&draft_id),
        instruct: chat.pending_instruct.peek(&draft_id),
    }
}

/// A ✦ instruction turn: the user authored an instruction inside the document
/// (or on a selection) and the doc-side co-author executes it as a tracked
/// suggestion. Same lifecycle as `draft_chat_send` — busy guard, mirror
/// flush, doc-hash header, `draft-chat-*` streaming — but the prompt carries
/// the consume-the-block contract instead of a conversational turn.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn draft_instruct(
    chat: tauri::State<'_, DraftChatState>,
    active_mission: tauri::State<'_, crate::ActiveMission>,
    app: AppHandle,
    draft_id: String,
    block_id: String,
    instruction: String,
    draft_markdown: String,
    project_path: Option<String>,
    cwd: Option<String>,
    sel_quote: Option<String>,
    sel_char_start: Option<i64>,
    sel_char_end: Option<i64>,
) -> Result<(), String> {
    if instruction.trim().is_empty() {
        return Err("empty instruction".to_string());
    }
    if block_id.trim().is_empty() {
        return Err("no target block".to_string());
    }
    // Atomic reservation; early `?` returns release it via the guard's Drop.
    let slot = chat
        .turns
        .begin(&draft_id)
        .map_err(|_| "the draft agent is still replying".to_string())?;

    // Server-side mirror flush — the validation guard and the agent's re-read
    // must both see exactly the doc the instruction was written in.
    let title = crate::draft_title_from_markdown(&draft_markdown);
    chat.db
        .upsert_draft(
            &draft_id,
            title.as_deref(),
            project_path.as_deref(),
            &draft_markdown,
            None,
        )
        .map_err(|e| format!("failed to mirror the draft: {e}"))?;

    let prior_session = chat.db.get_draft_chat_session(&draft_id);
    let doc_hash = crate::ledger::body_hash(&draft_markdown);
    let doc_changed = chat
        .db
        .get_draft_chat_doc_hash(&draft_id)
        .map(|h| h != doc_hash)
        .unwrap_or(true);

    // The thread shows the instruction as the user's line, ✦-prefixed.
    let user_msg = DraftChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        draft_id: draft_id.clone(),
        role: "user".to_string(),
        body: format!("✦ {}", instruction.trim()),
        status: "complete".to_string(),
        created_at: now_millis(),
    };
    chat.db
        .insert_draft_chat_message(&user_msg)
        .map_err(|e| format!("failed to persist message: {e}"))?;

    let mission = active_mission.active_goal();
    let instr_body = build_instruction_prompt(
        &draft_id,
        &block_id,
        &instruction,
        sel_quote.as_deref(),
        sel_char_start,
        sel_char_end,
    );
    let prompt = match &prior_session {
        None => build_first_turn_prompt(
            &draft_id,
            title.as_deref(),
            project_path.as_deref(),
            &draft_markdown,
            &instr_body,
            mission.as_ref().map(|(t, g)| (t.as_str(), g.as_str())),
        ),
        Some(_) => build_followup_prompt(&draft_id, doc_changed, &instr_body),
    };

    if prior_session.is_none() {
        let _ = crate::ledger::record_session_link(
            &chat.db,
            "drafter_chat",
            &draft_id,
            "drafter",
            &draft_id,
        );
        crate::ledger::record_agent_prompt(
            &chat.db,
            crate::ledger::PromptSource::RustFirstTurn,
            "drafter_chat",
            &prompt,
            Some(&instruction),
            project_path.clone(),
            None,
            None,
            Some(crate::ledger::ThreadRef {
                thread_kind: "drafter_chat",
                thread_id: draft_id.clone(),
                parent_session_id: None,
            }),
            crate::seat::model_for("drafter"),
        );
    } else {
        crate::ledger::register_agent_prompt(&prompt);
    }

    let _ = chat.db.set_draft_chat_doc_hash(&draft_id, &doc_hash);

    run_draft_turn(
        &chat,
        app,
        slot,
        draft_id,
        prompt,
        prior_session,
        cwd,
        project_path,
        Some(InstructMeta {
            block_id,
            instruction: instruction.trim().to_string(),
        }),
    )
    .await
}

/// Cancel the in-flight ✦ turn for a draft (the reader emits
/// `draft-chat-cancelled`). This is the ONLY way to stop a turn: without it the
/// target block pulses, the draft's turn slot stays reserved against every other
/// ✦, and the only exits are success, error, or app teardown.
#[tauri::command]
pub fn draft_chat_cancel(
    chat: tauri::State<'_, DraftChatState>,
    draft_id: String,
) -> Result<(), String> {
    if let Some(mut child) = chat.turns.take(&draft_id).and_then(|p| p.child) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub fn draft_chat_kill_all(chat: tauri::State<'_, DraftChatState>) {
    chat.kill_all();
}

// --- Draft comments (the sidecar) -------------------------------------------

/// Add a comment anchored to a draft block (the drafter sidecar).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn draft_comment_add(
    chat: tauri::State<'_, DraftChatState>,
    draft_id: String,
    body: String,
    block_id: Option<String>,
    sel_char_start: Option<i64>,
    sel_char_end: Option<i64>,
    sel_quoted_text: Option<String>,
) -> Result<crate::state::DraftComment, String> {
    if body.trim().is_empty() {
        return Err("empty comment".to_string());
    }
    let c = crate::state::DraftComment {
        id: format!("dc-{}", uuid::Uuid::new_v4()),
        draft_id,
        block_id: block_id.filter(|s| !s.trim().is_empty()),
        sel_char_start,
        sel_char_end,
        sel_quoted_text: sel_quoted_text.filter(|s| !s.trim().is_empty()),
        body: body.trim().to_string(),
        author: None,
        created_at: now_millis(),
        fork_session_id: None,
    };
    chat.db
        .insert_draft_comment(&c)
        .map_err(|e| format!("failed to add comment: {e}"))?;
    Ok(c)
}

/// A draft's comments, oldest-first.
#[tauri::command]
pub fn draft_comment_list(
    chat: tauri::State<'_, DraftChatState>,
    draft_id: String,
) -> Result<Vec<crate::state::DraftComment>, String> {
    chat.db
        .list_draft_comments(&draft_id)
        .map_err(|e| format!("failed to list comments: {e}"))
}

/// Delete a draft comment and its discussion thread.
#[tauri::command]
pub fn draft_comment_delete(
    chat: tauri::State<'_, DraftChatState>,
    fork: tauri::State<'_, crate::fork::ForkState>,
    draft_id: String,
    comment_id: String,
) -> Result<(), String> {
    // Kill any in-flight discussion turn before the rows go.
    crate::fork::draft_thread_discard(fork, draft_id.clone(), comment_id.clone())?;
    chat.db
        .delete_draft_comment(&draft_id, &comment_id)
        .map_err(|e| format!("failed to delete comment: {e}"))
}

// --- Reader -----------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn read_draft_chat(
    app: AppHandle,
    db: Arc<Database>,
    turns: Arc<Turns<()>>,
    pending_instruct: Arc<PendingInstructs>,
    instruct_nonce: Option<u64>,
    buf: Arc<Mutex<PartialBuf>>,
    draft_id: String,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
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
        match classify_line(&v) {
            StreamLine::Init(sid) => session = Some(sid),
            StreamLine::Delta(text) => {
                // Append-before-emit: see `turn::push_delta`.
                let seq = turn::push_delta(&buf, &text);
                let _ = app.emit(
                    "draft-chat-delta",
                    DraftChatDelta {
                        draft_id: draft_id.clone(),
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

    // The ✦ marker dies with its turn, on EVERY terminal path (done / error /
    // cancelled / empty) — taken exactly once, nonce-matched so a reader
    // outliving a cancel can't clear a successor instruct's marker.
    if let Some(nonce) = instruct_nonce {
        pending_instruct.take(&draft_id, nonce);
    }
    // Remove the proc BEFORE emitting the terminal event — the (Phase 3)
    // queue drain fires at terminal time and must pass the busy guard.
    let proc = turns.take(&draft_id);
    let cancelled = proc.is_none() && final_text.is_none();
    let exit_ok = match proc.and_then(|p| p.child) {
        Some(mut child) => child.wait().await.map(|s| s.success()).unwrap_or(false),
        None => false,
    };

    if cancelled {
        let _ = app.emit("draft-chat-cancelled", DraftChatCancelled { draft_id });
        return;
    }
    if let Some(err) = errored {
        let why = describe_turn_error(&db, &draft_id, &err);
        finish_error(&app, &db, &draft_id, &why);
        return;
    }
    if let Some(text) = final_text {
        if text.trim().is_empty() {
            finish_error(&app, &db, &draft_id, "claude produced an empty reply");
            return;
        }
        if let Some(sid) = &session {
            if let Err(e) = db.set_draft_chat_session(&draft_id, sid) {
                tracing::warn!(error = %e, "failed to persist draft chat session id");
            }
        }
        let msg = DraftChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            draft_id: draft_id.clone(),
            role: "assistant".to_string(),
            body: text.clone(),
            status: "complete".to_string(),
            created_at: now_millis(),
        };
        if let Err(e) = db.insert_draft_chat_message(&msg) {
            tracing::warn!(error = %e, "failed to persist assistant message");
        }
        // Companion journal: the draft agent completed a turn.
        let _ = db.append_journal("agent_turn", Some("drafter"), Some(&draft_id), None, None);
        let _ = app.emit(
            "draft-chat-done",
            DraftChatDone {
                draft_id,
                message_id: msg.id,
                body: text,
            },
        );
        return;
    }

    let why = if !exit_ok && !stderr_text.trim().is_empty() {
        let detail: String = stderr_text.trim().chars().take(500).collect();
        format!("claude exited abnormally: {detail}")
    } else if !saw_json {
        "claude produced no parseable output".to_string()
    } else {
        "claude ended without producing a reply".to_string()
    };
    finish_error(&app, &db, &draft_id, &why);
}

/// Same recovery policy as the browse agent: explicit context overflow resets
/// the resumable session (the next turn re-embeds the draft); transient API
/// errors keep it and ask for a retry.
fn describe_turn_error(db: &Database, draft_id: &str, error: &str) -> String {
    if is_context_overflow(error) {
        if let Err(e) = db.clear_draft_chat_session(draft_id) {
            tracing::warn!(error = %e, "failed to clear over-limit draft chat session");
        }
        return "This discussion outgrew the model's context window, so the turn \
                failed. I've reset its context — send your message again and I'll \
                start fresh on this draft (the replies above are kept)."
            .to_string();
    }
    if is_transient(error) {
        return "The model hit a momentary error on that turn. The discussion is \
                fine — send your message again in a moment."
            .to_string();
    }
    error.to_string()
}

fn finish_error(app: &AppHandle, db: &Database, draft_id: &str, why: &str) {
    let msg = DraftChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        draft_id: draft_id.to_string(),
        role: "assistant".to_string(),
        body: why.to_string(),
        status: "error".to_string(),
        created_at: now_millis(),
    };
    if let Err(e) = db.insert_draft_chat_message(&msg) {
        tracing::warn!(error = %e, "failed to persist error message");
    }
    let _ = app.emit(
        "draft-chat-error",
        DraftChatError {
            draft_id: draft_id.to_string(),
            error: why.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_turn_embeds_draft_doc_route_and_write_contract() {
        let p = build_first_turn_prompt(
            "d-1",
            Some("Auth plan prompt"),
            Some("/repo/x"),
            "# Goal\n\nShip auth.",
            "help me tighten this",
            None,
        );
        assert!(p.contains("Prompt Drafter"));
        assert!(p.contains("Draft: Auth plan prompt"));
        assert!(p.contains("/repo/x"));
        assert!(p.contains("/v1/drafter/d-1/doc"));
        assert!(p.contains("/v1/drafter/d-1/suggestions"));
        assert!(p.contains("replace_block"));
        assert!(p.contains("--- CURRENT DRAFT ---"));
        assert!(p.contains("Ship auth."));
        assert!(p.contains("help me tighten this"));
        assert!(p.contains("`drafter` skill"));
        // The suggestions POST authenticates via curl's own variable import
        // (a `format!` string — braces are quadrupled in source).
        assert!(p.contains("--variable %REDLINE_DAEMON_TOKEN="));
        assert!(p.contains("--expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\""));
        assert!(!p.contains("Bearer $REDLINE_DAEMON_TOKEN"));
        // The contract teaches snake_case field names (the endpoint aliases
        // camelCase for stragglers, but what we TEACH must match the struct).
        assert!(p.contains("agent_id"));
        assert!(p.contains("`block_id`"));
        assert!(!p.contains("agentId"));
        assert!(!p.contains("`blockId`"));
    }

    /// Two first turns on the SAME draft with different VARIABLE inputs
    /// (title, project, mission, body, user text) share a byte-identical
    /// prefix spanning the invariant role/formatting block AND the
    /// per-draft-stable doc route + write contract — the cache-stable
    /// ordering contract.
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
            "d-1",
            Some("Title A"),
            Some("/repo/x"),
            "# Body one",
            "question one",
            None,
        );
        let b = build_first_turn_prompt(
            "d-1",
            None,
            None,
            "",
            "another question",
            Some(("Mission", "a goal")),
        );
        let shared = common_prefix(&a, &b);
        // The shared prefix must span role, formatting, doc route and the
        // whole write contract (its ✦ instruction tail closes it).
        assert!(shared.contains("`drafter` skill"));
        assert!(shared.contains("Never emit raw HTML."));
        assert!(shared.contains("/v1/drafter/d-1/doc"));
        assert!(shared.contains("/v1/drafter/d-1/suggestions"));
        assert!(shared.contains("✦ INSTRUCTION TURNS"));
        // And every variable section sits after it.
        assert!(!shared.contains("Draft: Title A"));
        assert!(!shared.contains("--- CURRENT DRAFT ---"));
        assert!(!shared.contains("question one"));
    }

    #[test]
    fn first_turn_marks_an_empty_draft() {
        let p = build_first_turn_prompt("d-1", None, None, "   ", "draft me a prompt for X", None);
        assert!(p.contains("(the document is empty)"));
    }

    #[test]
    fn followup_flags_a_changed_doc_with_the_reread_route() {
        let changed = build_followup_prompt("d-1", true, "and now?");
        assert!(changed.contains("has CHANGED"));
        assert!(changed.contains("/v1/drafter/d-1/doc"));
        assert!(changed.ends_with("and now?"));
        let same = build_followup_prompt("d-1", false, "and now?");
        assert!(same.contains("unchanged"));
        assert!(!same.contains("has CHANGED"));
    }

    #[test]
    fn instruction_prompt_teaches_consume_the_block() {
        let p = build_instruction_prompt("d-1", "blk-abc", "draft a summary of X", None, None, None);
        assert!(p.contains("✦ IN-DOCUMENT INSTRUCTION"));
        assert!(p.contains("`blk-abc`"));
        assert!(p.contains("draft a summary of X"));
        assert!(p.contains("replace_block"));
        assert!(p.contains("must NOT survive"));
        assert!(p.contains("insert_after"));
        assert!(p.contains("ONE short line"));
        assert!(p.contains("/v1/drafter/d-1/doc"));
        assert!(p.contains("409"));
    }

    #[test]
    fn instruction_prompt_selection_variant_scopes_to_the_span() {
        let p = build_instruction_prompt(
            "d-1",
            "blk-abc",
            "make this punchier",
            Some("the slow sentence"),
            Some(10),
            Some(27),
        );
        assert!(p.contains("✦ SELECTION INSTRUCTION"));
        assert!(p.contains("the slow sentence"));
        assert!(p.contains("chars 10\u{2013}27"));
        assert!(p.contains("make this punchier"));
        assert!(p.contains("outside the span stays verbatim"));
        assert!(!p.contains("IN-DOCUMENT INSTRUCTION"));
    }

    #[test]
    fn suggestions_contract_teaches_instruction_turns() {
        let c = suggestions_contract("d-1");
        assert!(c.contains("✦ INSTRUCTION TURNS"));
        assert!(c.contains("consume the instruction paragraph"));
    }

    #[test]
    fn pending_instruct_set_probed_and_taken_once() {
        let p = PendingInstructs::default();
        assert!(p.peek("d1").is_none());
        let nonce = p.set(
            "d1",
            InstructMeta {
                block_id: "blk-a".to_string(),
                instruction: "tighten".to_string(),
            },
        );
        assert_eq!(p.peek("d1").map(|m| m.block_id), Some("blk-a".to_string()));
        // Independent drafts don't see each other's markers.
        assert!(p.peek("d2").is_none());
        // The turn's reader takes it exactly once, at any terminal
        // (done/error/cancelled all funnel through the same take).
        p.take("d1", nonce);
        assert!(p.peek("d1").is_none());
        // A second take (impossible from one reader, but harmless) is a no-op.
        p.take("d1", nonce);
        assert!(p.peek("d1").is_none());
    }

    #[test]
    fn stale_reader_take_must_not_clear_a_successor_instruct() {
        // Cancel instruct A (its reader still draining EOF), start instruct B
        // on the same draft: A's terminal take carries A's nonce and must
        // leave B's marker untouched.
        let p = PendingInstructs::default();
        let meta = |b: &str| InstructMeta {
            block_id: b.to_string(),
            instruction: format!("do {b}"),
        };
        let nonce_a = p.set("d1", meta("blk-a"));
        let nonce_b = p.set("d1", meta("blk-b"));
        p.take("d1", nonce_a); // stale reader
        assert_eq!(
            p.peek("d1").map(|m| m.block_id),
            Some("blk-b".to_string()),
            "a stale reader's take cleared the successor's marker"
        );
        p.take("d1", nonce_b);
        assert!(p.peek("d1").is_none());
    }

    #[test]
    fn pending_instruct_carries_the_instruction_for_retry() {
        // The re-arm probe restores the pulse from `block_id`; Retry needs the
        // instruction itself, or it is dead for every turn recovered across a
        // remount.
        let p = PendingInstructs::default();
        p.set(
            "d1",
            InstructMeta {
                block_id: "blk-a".to_string(),
                instruction: "tighten this paragraph".to_string(),
            },
        );
        assert_eq!(
            p.peek("d1").map(|m| m.instruction),
            Some("tighten this paragraph".to_string())
        );
    }

    #[test]
    fn block_slice_is_bounded_by_the_next_sidecar() {
        let mirror = "<!-- rl:blk-aaa -->\nfirst\n\n<!-- rl:blk-bbb -->\nsecond\n";
        assert_eq!(block_slice(mirror, "aaa"), Some("\nfirst\n\n"));
        assert_eq!(block_slice(mirror, "bbb"), Some("\nsecond\n"));
        assert_eq!(block_slice(mirror, "zzz"), None);
    }

    #[test]
    fn a_stale_original_that_appears_in_another_block_is_still_stale() {
        // The whole point of scoping. `Ship auth.` is live in blk-bbb and gone
        // from blk-aaa; a whole-mirror `contains` would wave this through and
        // let the agent overwrite an edit it never read.
        let mirror = "<!-- rl:blk-aaa -->\nrewritten\n\n<!-- rl:blk-bbb -->\nShip auth.\n";
        assert_eq!(
            validate_suggestion(mirror, "replace_block", Some("aaa"), Some("Ship auth."), "x")
                .unwrap_err()
                .0,
            409
        );
        // ...and it remains valid against the block that actually holds it.
        assert!(
            validate_suggestion(mirror, "replace_block", Some("bbb"), Some("Ship auth."), "x")
                .is_ok()
        );
    }

    #[test]
    fn validate_suggestion_contract() {
        let mirror = "<!-- rl:blk-abc123 -->\n# Goal\n\nShip auth.\n";
        // append needs no block.
        assert!(validate_suggestion(mirror, "append", None, None, "more").is_ok());
        // unknown op → 400.
        assert_eq!(
            validate_suggestion(mirror, "rewrite", None, None, "x").unwrap_err().0,
            400
        );
        // block ops need blockId → 400.
        assert_eq!(
            validate_suggestion(mirror, "replace_block", None, None, "x").unwrap_err().0,
            400
        );
        // unknown block → 409 (re-read and retry).
        assert_eq!(
            validate_suggestion(mirror, "replace_block", Some("blk-zzz"), None, "x")
                .unwrap_err()
                .0,
            409
        );
        // known block, with or without the blk- prefix → ok.
        assert!(validate_suggestion(mirror, "replace_block", Some("blk-abc123"), None, "x").is_ok());
        assert!(validate_suggestion(mirror, "insert_after", Some("abc123"), None, "x").is_ok());
        // stale original → 409.
        assert_eq!(
            validate_suggestion(mirror, "replace_block", Some("abc123"), Some("old text"), "x")
                .unwrap_err()
                .0,
            409
        );
        // fresh original → ok.
        assert!(validate_suggestion(
            mirror,
            "replace_block",
            Some("abc123"),
            Some("Ship auth."),
            "x"
        )
        .is_ok());
        // empty markdown only allowed for delete.
        assert_eq!(
            validate_suggestion(mirror, "append", None, None, "  ").unwrap_err().0,
            400
        );
        assert!(
            validate_suggestion(mirror, "delete_block", Some("abc123"), Some("Ship auth."), "")
                .is_ok()
        );
    }
}

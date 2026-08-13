// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! AI pre-review: a read-only headless `claude` pass over the current review
//! diff whose findings land as DRAFT annotations the reviewer curates before
//! Submit. Process orchestration mirrors `mission.rs` (registry, stall-kill,
//! stream-json reader via `claude_proc::classify_line`); ingestion lives in
//! `review.rs::ingest_annotation`, which recaptures each matched finding's
//! `quoted_text` from the diff itself — so AI findings re-anchor across
//! review rounds exactly like hand-placed ones.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::Database;
use crate::review::{self, IncomingFinding};

/// Kill a run that has produced no output for this long — a wedged reviewer
/// must fail loudly, not hang the drawer forever.
const STALL_CEILING: Duration = Duration::from_secs(180);

/// Diffs rendered past this many bytes fall back to a file-list prompt and
/// tell the reviewer to read the files itself.
pub(crate) const MAX_PROMPT_DIFF_BYTES: usize = 300_000;

/// The findings contract, inlined via `--json-schema`. `quoted` is the anchor:
/// it MUST be a verbatim copy of consecutive diff lines for line placement.
/// `triage` is the SHADOW attention router's slot: the same pass also yields a
/// `{verdict, reason, cited_seq}` triage. Its `verdict` enum is the CLOSED
/// vocabulary `auto` | `attend` — there is deliberately no third tier.
const FINDINGS_SCHEMA: &str = r#"{"type":"object","required":["findings","triage"],"properties":{"findings":{"type":"array","items":{"type":"object","required":["severity","body"],"properties":{"severity":{"type":"string","enum":["important","nit","pre_existing"]},"file":{"type":["string","null"]},"side":{"type":["string","null"],"enum":["old","new",null]},"quoted":{"type":["string","null"]},"line_hint":{"type":["integer","null"]},"body":{"type":"string"},"suggestion":{"type":["string","null"]}}}},"triage":{"type":"object","required":["verdict","reason"],"properties":{"verdict":{"type":"string","enum":["auto","attend"]},"reason":{"type":"string"},"cited_seq":{"type":["integer","null"]}}}}}"#;

#[derive(Deserialize)]
struct RawFinding {
    severity: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    side: Option<String>,
    #[serde(default)]
    quoted: Option<String>,
    #[serde(default)]
    line_hint: Option<i64>,
    body: String,
    #[serde(default)]
    suggestion: Option<String>,
}

/// The model's half of the shadow triage: an advisory verdict, a one-line
/// reason, and (only when a listed decision is genuinely contradicted) the
/// cited ledger seq. Everything here is re-validated in Rust before recording.
#[derive(Deserialize)]
struct RawTriage {
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    cited_seq: Option<i64>,
}

#[derive(Deserialize)]
struct FindingsDoc {
    findings: Vec<RawFinding>,
    #[serde(default)]
    triage: Option<RawTriage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiLogEvent {
    review_id: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDoneEvent {
    review_id: String,
    added: usize,
    important: usize,
    nits: usize,
    pre_existing: usize,
    /// Shadow attention-router fields — informational payload for the FE
    /// banner only; nothing anywhere acts on them.
    verdict: String,
    verdict_reason: String,
    verdict_signals: Vec<String>,
    verdict_bar: usize,
    verdict_cited_seq: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiErrorEvent {
    review_id: String,
    error: String,
    cancelled: bool,
}

pub struct AiReviewState {
    db: Arc<Database>,
    procs: Arc<Mutex<HashMap<String, Child>>>,
    claude_bin: OnceLock<String>,
}

impl AiReviewState {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            procs: Arc::new(Mutex::new(HashMap::new())),
            claude_bin: OnceLock::new(),
        }
    }

    async fn claude_bin(&self) -> Result<String, String> {
        if let Some(b) = self.claude_bin.get() {
            return Ok(b.clone());
        }
        let bin = tokio::task::spawn_blocking(resolve_claude_bin)
            .await
            .map_err(|e| e.to_string())?;
        let _ = self.claude_bin.set(bin.clone());
        Ok(bin)
    }

    /// App-teardown hatch: no orphan `claude` outlives the window.
    pub fn kill_all(&self) {
        let mut procs = self.procs.lock().unwrap();
        for (_, mut child) in procs.drain() {
            let _ = child.start_kill();
        }
    }
}

/// Headless argv: read-only tool surface (no Bash, no web, no Edit/Write) —
/// `bypassPermissions` is safe because no write-capable tool exists. The
/// prompt arrives on
/// stdin (the rendered diff can exceed comfortable argv size).
fn ai_review_args() -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--strict-mcp-config",
        "--permission-mode",
        "bypassPermissions",
        "--tools",
        "Read,Grep,Glob",
        "--no-session-persistence",
        "--json-schema",
        FINDINGS_SCHEMA,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    args.extend(crate::seat::flag_args("ai_review"));
    args
}

/// Render the parsed diff with per-side line numbers — the same coordinates
/// `relocate_quoted` will match `quoted` against. `pub(crate)`: the commit
/// drafter (`ai_commit.rs`) shows its model the same rendering.
pub(crate) fn render_diff(diff: &[crate::review::DiffFile]) -> String {
    let mut out = String::new();
    for f in diff {
        let status = format!("{:?}", f.status).to_lowercase();
        out.push_str(&format!("FILE: {} ({status})\n", review::display_path(f)));
        if f.binary {
            out.push_str("  (binary)\n\n");
            continue;
        }
        for h in &f.hunks {
            out.push_str(&format!(
                "@@ -{},{} +{},{} @@ {}\n",
                h.old_start, h.old_lines, h.new_start, h.new_lines, h.header
            ));
            for l in &h.lines {
                let sign = match l.kind {
                    crate::review::DiffLineKind::Add => '+',
                    crate::review::DiffLineKind::Del => '-',
                    crate::review::DiffLineKind::Context => ' ',
                };
                let old = l.old_line.map(|n| n.to_string()).unwrap_or_default();
                let new = l.new_line.map(|n| n.to_string()).unwrap_or_default();
                out.push_str(&format!("{old:>6} {new:>6} {sign}{}\n", l.text));
            }
        }
        out.push('\n');
    }
    out
}

/// File list + hunk headers only — the over-cap fallback.
pub(crate) fn render_file_list(diff: &[crate::review::DiffFile]) -> String {
    let mut out = String::new();
    for f in diff {
        let status = format!("{:?}", f.status).to_lowercase();
        out.push_str(&format!("FILE: {} ({status})\n", review::display_path(f)));
        for h in &f.hunks {
            out.push_str(&format!(
                "  @@ -{},{} +{},{} @@ {}\n",
                h.old_start, h.old_lines, h.new_start, h.new_lines, h.header
            ));
        }
    }
    out
}

fn build_prompt(
    repo: &str,
    round: i64,
    diff: &[crate::review::DiffFile],
    signals: &[String],
    bar: usize,
    decisions: &[(i64, String)],
) -> String {
    let rendered = render_diff(diff);
    let (diff_block, oversized_note) = if rendered.len() > MAX_PROMPT_DIFF_BYTES {
        (
            render_file_list(diff),
            "\nThe diff is too large to inline — the hunk map above shows what \
             changed; read the files yourself for the content.\n",
        )
    } else {
        (rendered, "")
    };
    let signal_line = if signals.is_empty() {
        "none".to_string()
    } else {
        signals.join(", ")
    };
    let decisions_block = if decisions.is_empty() {
        "  (none retrieved)\n".to_string()
    } else {
        decisions
            .iter()
            .map(|(seq, ctx)| format!("  seq {seq}: {ctx}\n"))
            .collect::<String>()
    };
    format!(
        "You are a code reviewer doing a pre-review pass over another engineer's \
         uncommitted changes in the repository at {repo} (review round {round}). \
         You have read-only access — read any file you need for context.\n\n\
         Review ONLY the changed code below. Report real problems: bugs, broken \
         edge cases, security issues, misleading names or comments, dead code the \
         change introduces. Prefer FEW high-signal findings over many trivial \
         ones. Use severity `important` for must-fix problems, `nit` for minor \
         real issues, and `pre_existing` for problems merely ADJACENT to the \
         change (not introduced by it).\n\n\
         For each finding: `file` is the path exactly as shown after `FILE:`; \
         `side` is \"old\" only when the problem is about deleted lines; `quoted` \
         MUST be a verbatim copy of one or more CONSECUTIVE lines from the diff \
         below (it anchors the finding — copy the text exactly, without the line \
         numbers or +/- signs); `line_hint` is the first line's number on that \
         side. Omit file/quoted only for repo-wide observations. `suggestion` is \
         optional replacement code for the quoted lines.\n\n\
         TRIAGE (a shadow attention router rides this pass — its verdict is \
         recorded for calibration and acted on by NOTHING): also fill `triage`. \
         `verdict` MUST be exactly \"auto\" (a careful human reviewer would find \
         nothing to say here) or \"attend\" (a human should look) — no other \
         value exists. `reason` is one short sentence.\n\
         Checkable risk signals already computed from this diff: {signal_line} \
         (attend bar: {bar} signal(s)).\n\
         The user's own recently recorded decisions that may relate to these \
         files:\n{decisions_block}\
         If and ONLY if the diff contradicts one of the decisions listed above, \
         set `cited_seq` to that seq and begin the reason with \"contradicts \
         decision at seq N: \" plus its gist. NEVER cite a seq that is not \
         listed and never invent one — an unverifiable citation is worse than \
         none. When no listed decision applies, omit `cited_seq` and ground the \
         reason in the fired signals.\n\n\
         Respond with ONLY the JSON the schema requires.\n\n\
         THE DIFF UNDER REVIEW:\n\n{diff_block}{oversized_note}"
    )
}

/// Parse the reviewer's final text into findings (+ optional triage): direct
/// parse, then an outermost-braces slice (schema enforcement can degrade
/// across CLI versions — never let framing noise waste a finished run).
fn parse_findings(text: &str) -> Result<FindingsDoc, String> {
    if let Ok(doc) = serde_json::from_str::<FindingsDoc>(text) {
        return Ok(doc);
    }
    let start = text.find('{');
    let end = text.rfind('}');
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(doc) = serde_json::from_str::<FindingsDoc>(&text[s..=e]) {
                return Ok(doc);
            }
        }
    }
    Err("the AI reviewer's output wasn't parseable findings JSON".to_string())
}

/// Severity → conventional label mapping (the payload's label semantics).
fn severity_label(severity: &str) -> (Option<String>, Option<String>) {
    match severity {
        "important" => (Some("issue".into()), Some("blocking".into())),
        "nit" => (Some("nitpick".into()), Some("non-blocking".into())),
        "pre_existing" => (Some("note".into()), Some("non-blocking".into())),
        _ => (None, None),
    }
}

// ---------------------------------------------------------------------------
// The SHADOW attention router.
//
// The pre-review pass also yields a triage verdict: would a human have needed
// to look at this diff (`attend`) or not (`auto`)? SHADOW MODE is the whole
// design: the verdict is computed, recorded (ledger event + readable sidecar)
// and shown in a banner — and acts on NOTHING. The pane opens exactly as it
// would without it; nothing lands, holds, or is skipped because of it. The
// record is the product: once a few dozen reviews carry verdicts, every `auto`
// where the human then left comments is a counted calibration miss.
// ---------------------------------------------------------------------------

/// The published attend bar: `attend` when at least this many checkable
/// signals fire, `auto` otherwise. Tunable without a rebuild via the
/// `app_settings` key [`ATTEND_BAR_SETTING_KEY`] (a positive integer); the
/// recorded payload carries the bar used, so every record is self-describing.
pub(crate) const ATTEND_SIGNAL_BAR: usize = 1;
/// `app_settings` override key for [`ATTEND_SIGNAL_BAR`].
pub(crate) const ATTEND_BAR_SETTING_KEY: &str = "redline.router.attendBar";
/// Blast-radius signal thresholds: a diff spanning this many files (or total
/// changed lines) is attend-worthy on size alone.
const BLAST_RADIUS_FILES: usize = 12;
const BLAST_RADIUS_LINES: usize = 600;
/// Decision retrieval: how many recent ledger events to scan, and how many
/// matching decision contexts to feed the prompt.
const DECISION_SCAN: i64 = 400;
const DECISION_KEEP: usize = 8;

/// The CLOSED verdict vocabulary: `auto` | `attend`. There is deliberately no
/// third tier — a machine never overrules the human, so "block" exists in no
/// type, no schema, and no record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouterVerdict {
    Auto,
    Attend,
}

impl RouterVerdict {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            RouterVerdict::Auto => "auto",
            RouterVerdict::Attend => "attend",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(RouterVerdict::Auto),
            "attend" => Some(RouterVerdict::Attend),
            _ => None,
        }
    }
}

fn is_test_path(path: &str) -> bool {
    path.contains("/tests/")
        || path.starts_with("tests/")
        || path.contains(".test.")
        || path.contains(".spec.")
        || path.ends_with("_test.rs")
}

fn is_code_path(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("");
    matches!(
        ext,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go" | "swift" | "c" | "cc"
            | "cpp" | "h" | "java" | "kt"
    )
}

/// Compute the CHECKABLE risk signals from the diff itself — each one is a
/// fact anyone can re-derive from the recorded diff, never a model judgment:
///   `auth_surface`   — touches auth/scope surfaces (auth.rs, the extension
///                      ABI scope crate, or the route table symbol);
///   `ledger_chain`   — touches ledger/chain code or its hash fields;
///   `tests_missing`  — non-test code changed and no test file did;
///   `blast_radius`   — files/lines beyond the published thresholds.
/// Two more checkable signals are appended later from the completed pass:
/// `important_findings` (the pass ingested must-fix findings) and
/// `contradicts_decision` (a VALIDATED citation of a recorded decision).
pub(crate) fn compute_signals(diff: &[crate::review::DiffFile]) -> Vec<String> {
    let mut auth = false;
    let mut chain = false;
    let mut any_test = false;
    let mut any_code = false;
    let mut changed_lines = 0usize;
    for f in diff {
        let path = review::display_path(f).to_lowercase();
        if path.ends_with("auth.rs") || path.contains("extension-abi") {
            auth = true;
        }
        if path.ends_with("ledger.rs") {
            chain = true;
        }
        if is_test_path(&path) {
            any_test = true;
        } else if is_code_path(&path) {
            any_code = true;
        }
        for h in &f.hunks {
            for l in &h.lines {
                if l.kind == crate::review::DiffLineKind::Context {
                    continue;
                }
                changed_lines += 1;
                if l.text.contains("ROUTE_TABLE") {
                    auth = true;
                }
                if l.text.contains("entry_hash")
                    || l.text.contains("prev_hash")
                    || l.text.contains("verify_ledger_chain")
                {
                    chain = true;
                }
            }
        }
    }
    let mut signals = Vec::new();
    if auth {
        signals.push("auth_surface".to_string());
    }
    if chain {
        signals.push("ledger_chain".to_string());
    }
    if any_code && !any_test {
        signals.push("tests_missing".to_string());
    }
    if diff.len() > BLAST_RADIUS_FILES || changed_lines > BLAST_RADIUS_LINES {
        signals.push("blast_radius".to_string());
    }
    signals
}

/// The verdict at the published bar — a pure function of the checkable
/// signals, so the recorded payload (signals + bar) fully explains it. A
/// misconfigured bar of 0 clamps to 1: `attend` must stay reachable.
pub(crate) fn compute_verdict(signals: &[String], bar: usize) -> RouterVerdict {
    if signals.len() >= bar.max(1) {
        RouterVerdict::Attend
    } else {
        RouterVerdict::Auto
    }
}

/// The attend bar actually in force: the published const, overridable via the
/// documented `app_settings` key.
fn attend_bar(db: &Database) -> usize {
    db.get_setting(ATTEND_BAR_SETTING_KEY)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(ATTEND_SIGNAL_BAR)
}

/// A citation survives only if the cited seq is a DECISION the model was
/// actually shown — the model is told never to cite an unlisted seq, and this
/// is the enforcement. Mere existence in the ledger is NOT enough: a
/// prompt/moot_turn/router_verdict seq must never validate as a "decision"
/// citation and fire `contradicts_decision`.
fn validate_citation(cited: Option<i64>, exists: impl Fn(i64) -> bool) -> Option<i64> {
    cited.filter(|s| *s > 0 && exists(*s))
}

/// The call site's exists-check: membership in the retrieved decision
/// contexts. The kind requirement (`classmem::DECISION_KINDS` + `supersede`)
/// rides on retrieval — `retrieve_decision_context` only ever yields those
/// kinds — so this closure is kind-checked by construction.
fn citation_in_decisions(decisions: &[(i64, String)], seq: i64) -> bool {
    decisions.iter().any(|(s, _)| *s == seq)
}

/// The recorded reason. A model reason carrying an unverifiable decision
/// claim is dropped entirely — never record a fabricated citation, however
/// it is phrased. Two triggers, both falling back to the checkable signals:
/// the model supplied a citation that failed validation (`cited_raw` present,
/// `cited` gone), or the reason speaks decision/seq language without a
/// validated citation backing it.
fn router_reason(
    model_reason: Option<&str>,
    cited_raw: Option<i64>,
    cited: Option<i64>,
    signals: &[String],
) -> String {
    let fallback = if signals.is_empty() {
        "no risk signals fired".to_string()
    } else {
        format!("signals: {}", signals.join(", "))
    };
    let citation_failed = cited_raw.is_some() && cited.is_none();
    match model_reason.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => {
            let lower = r.to_lowercase();
            let decision_lang = lower.contains("decision") || lower.contains("seq");
            if citation_failed || (decision_lang && cited.is_none()) {
                fallback
            } else {
                r.to_string()
            }
        }
        None => fallback,
    }
}

/// Read-only memory retrieval — the router's differentiator: an `attend` can
/// cite the user's own recorded decisions. From the changed paths' salient
/// terms (path segments ≥ 4 chars), scan recent ledger DECISION events
/// (resolutions / approvals / human review verdicts / supersessions — the
/// machine's own `router_verdict` kind is deliberately NOT a decision kind)
/// and keep those whose readable context mentions a term. Returns `(seq,
/// context gist)` pairs, newest first.
fn retrieve_decision_context(
    db: &Database,
    diff: &[crate::review::DiffFile],
) -> Vec<(i64, String)> {
    let mut terms: Vec<String> = Vec::new();
    for f in diff {
        for part in review::display_path(f).split(['/', '\\']) {
            let stem = part.split('.').next().unwrap_or(part).to_lowercase();
            if stem.len() >= 4 && !terms.contains(&stem) {
                terms.push(stem);
            }
        }
    }
    if terms.is_empty() {
        return Vec::new();
    }
    let Ok(events) = db.list_ledger_events(DECISION_SCAN) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in events {
        let is_decision = crate::classmem::DECISION_KINDS.contains(&e.kind.as_str())
            || e.kind == "supersede";
        if !is_decision {
            continue;
        }
        let Ok(Some(ctx)) = db.decision_event_context(e.seq) else {
            continue;
        };
        let lower = ctx.to_lowercase();
        if terms.iter().any(|t| lower.contains(t.as_str())) {
            out.push((e.seq, ctx));
            if out.len() >= DECISION_KEEP {
                break;
            }
        }
    }
    out
}

#[tauri::command]
pub async fn ai_review_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AiReviewState>,
    review_id: String,
) -> Result<(), String> {
    if state.procs.lock().unwrap().contains_key(&review_id) {
        return Err("an AI review is already running for this review".into());
    }
    let session = state
        .db
        .get_code_review(&review_id)
        .ok_or("unknown review")?;
    let source = review::parse_source_tag(&session.source)?;
    let (_, diff) = review::resolve_for_route(
        &state.db,
        &session.repo_path,
        source,
        session.base_ref.as_deref(),
        session.commit_sha.as_deref(),
    )
    .await?;
    if diff.is_empty() {
        return Err("no changes to review".into());
    }

    // Shadow router inputs, computed up front from checkable facts: the risk
    // signals, the published (tunable) attend bar, and the read-only memory
    // retrieval the model may cite from.
    let signals = compute_signals(&diff);
    let bar = attend_bar(&state.db);
    let decisions = retrieve_decision_context(&state.db, &diff);

    let prompt = build_prompt(&session.repo_path, session.round, &diff, &signals, bar, &decisions);
    let bin = state.claude_bin().await?;
    let mut cmd = crate::claude_proc::claude_command_for_seat("ai_review", &bin);
    let mut child = cmd
        .current_dir(&session.repo_path)
        .args(ai_review_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let mut stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("claude stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("claude stderr unavailable")?;
    state.procs.lock().unwrap().insert(review_id.clone(), child);

    let db = state.db.clone();
    let procs = state.procs.clone();
    let rid = review_id.clone();
    tauri::async_runtime::spawn(async move {
        // Feed the prompt and close stdin so `-p` sees EOF.
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);

        let started = Instant::now();
        let last_activity = Arc::new(AtomicU64::new(0));
        let emit_log = |text: String| {
            let _ = app.emit(
                "review-ai-log",
                AiLogEvent {
                    review_id: rid.clone(),
                    text,
                },
            );
        };

        // Stream reader (deltas → live log) alongside the stall watchdog.
        let activity = last_activity.clone();
        let stdout_fut = async {
            let mut reader = BufReader::new(stdout).lines();
            let mut final_text: Option<String> = None;
            let mut errored: Option<String> = None;
            while let Ok(Some(line)) = reader.next_line().await {
                activity.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                match classify_line(&v) {
                    StreamLine::Delta(text) => emit_log(text),
                    StreamLine::Final { text, .. } => final_text = Some(text),
                    StreamLine::Failed(msg) => errored = Some(msg),
                    StreamLine::Init(_) | StreamLine::Ignore => {}
                }
            }
            (final_text, errored)
        };
        let stderr_fut = async {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = lines.next_line().await {}
        };
        let read_fut = async { tokio::join!(stdout_fut, stderr_fut).0 };
        tokio::pin!(read_fut);
        let mut stalled = false;
        let (final_text, errored) = loop {
            tokio::select! {
                res = &mut read_fut => break res,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {
                    let last = last_activity.load(Ordering::Relaxed);
                    let silent = started.elapsed().saturating_sub(Duration::from_millis(last));
                    if !stalled && silent >= STALL_CEILING {
                        if let Some(mut p) = procs.lock().unwrap().remove(&rid) {
                            let _ = p.start_kill();
                        }
                        stalled = true;
                        // Fire-and-forget: a wedged agent is friction the app
                        // computes and used to throw away.
                        let _ = db.record_friction(
                            "stall_kill",
                            Some("review"),
                            Some(&rid),
                            Some(&format!(
                                "silent for {}s (ceiling {}s)",
                                silent.as_secs(),
                                STALL_CEILING.as_secs()
                            )),
                        );
                    }
                }
            }
        };

        // A missing registry entry means Cancel (or the stall path) killed it.
        let proc = procs.lock().unwrap().remove(&rid);
        let cancelled = proc.is_none() && !stalled;
        if let Some(mut p) = proc {
            let _ = p.wait().await;
        }
        let fail = |error: String, cancelled: bool| {
            let _ = app.emit(
                "review-ai-error",
                AiErrorEvent {
                    review_id: rid.clone(),
                    error,
                    cancelled,
                },
            );
        };
        if stalled {
            fail(
                format!(
                    "the AI reviewer produced no output for {}s — killed as stalled",
                    STALL_CEILING.as_secs()
                ),
                false,
            );
            return;
        }
        if cancelled {
            fail("cancelled".to_string(), true);
            return;
        }
        if let Some(err) = errored {
            fail(err, false);
            return;
        }
        let Some(text) = final_text else {
            fail("the AI reviewer ended without producing findings".to_string(), false);
            return;
        };
        let doc = match parse_findings(&text) {
            Ok(d) => d,
            Err(e) => {
                fail(e, false);
                return;
            }
        };
        let FindingsDoc { findings, triage } = doc;

        // Ingest against the CURRENT session round (it may have advanced).
        let Some(session) = db.get_code_review(&rid) else {
            fail("the review disappeared while the AI reviewed".to_string(), false);
            return;
        };
        let mut added = 0;
        let mut important = 0;
        let mut nits = 0;
        let mut pre_existing = 0;
        for f in findings {
            let (label, blocking) = severity_label(&f.severity);
            match f.severity.as_str() {
                "important" => important += 1,
                "nit" => nits += 1,
                _ => pre_existing += 1,
            }
            let incoming = IncomingFinding {
                file: f.file,
                side: f.side,
                quoted: f.quoted,
                line_hint: f.line_hint,
                body: f.body,
                suggestion: f.suggestion,
                label,
                blocking,
            };
            if review::ingest_annotation(&db, &session, &diff, incoming, "ai", "ai").is_ok() {
                added += 1;
            }
        }
        if added > 0 {
            let _ = app.emit("review-annotations-changed", rid.clone());
            crate::extension_host::publish(
                redline_extension_abi::events::REVIEW_ANNOTATIONS_CHANGED,
                &redline_extension_abi::events::ReviewAnnotationsChanged {
                    review_id: rid.clone(),
                    ts_ms: crate::extension_host::now_ms(),
                },
            );
        }

        // ---- Shadow attention router: compute + record; act on NOTHING. ----
        // Every finding above was ingested before the verdict is even born;
        // its only sinks are the ledger record and the FE banner payload.
        let mut signals = signals;
        if important > 0 {
            signals.push("important_findings".to_string());
        }
        // Kind-checked by construction: a cite must be one of the decisions
        // the model was shown (retrieval already filters to DECISION_KINDS +
        // supersede) — never merely any ledger seq that happens to exist.
        let raw_cited = triage.as_ref().and_then(|t| t.cited_seq);
        let cited = validate_citation(raw_cited, |s| citation_in_decisions(&decisions, s));
        if cited.is_some() {
            signals.push("contradicts_decision".to_string());
        }
        let verdict = compute_verdict(&signals, bar);
        // The recorded verdict is the deterministic one at the published bar —
        // the model's advisory verdict is only trusted as far as vocabulary:
        // a triage whose verdict falls outside the closed `auto`|`attend` set
        // is a confused model, and its reason is discarded with it.
        let model_ok = triage
            .as_ref()
            .and_then(|t| t.verdict.as_deref())
            .and_then(RouterVerdict::parse)
            .is_some();
        let model_reason = triage
            .as_ref()
            .and_then(|t| t.reason.as_deref())
            .filter(|_| model_ok);
        let reason = router_reason(model_reason, raw_cited, cited, &signals);
        if let Err(e) = crate::ledger::record_review_verdict(
            &db,
            &crate::ledger::ReviewVerdictRecord {
                review_session_id: &rid,
                verdict: verdict.as_str(),
                reason: &reason,
                signals: &signals,
                bar,
                cited_seq: cited,
                at: crate::ledger::now_millis(),
            },
        ) {
            tracing::warn!(error = %e, "failed to record shadow router verdict");
        }

        let _ = app.emit(
            "review-ai-done",
            AiDoneEvent {
                review_id: rid.clone(),
                added,
                important,
                nits,
                pre_existing,
                verdict: verdict.as_str().to_string(),
                verdict_reason: reason,
                verdict_signals: signals,
                verdict_bar: bar,
                verdict_cited_seq: cited,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub fn ai_review_cancel(
    state: tauri::State<'_, AiReviewState>,
    review_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.procs.lock().unwrap().remove(&review_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

#[tauri::command]
pub fn ai_review_active(state: tauri::State<'_, AiReviewState>, review_id: String) -> bool {
    state.procs.lock().unwrap().contains_key(&review_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_findings_direct_and_sliced() {
        let direct = r#"{"findings":[{"severity":"nit","body":"b"}]}"#;
        assert_eq!(parse_findings(direct).unwrap().findings.len(), 1);
        let framed = format!("Here you go:\n```json\n{direct}\n```\nDone.");
        let sliced = parse_findings(&framed).unwrap();
        assert_eq!(sliced.findings.len(), 1);
        assert_eq!(sliced.findings[0].severity, "nit");
        assert!(sliced.triage.is_none(), "a triage-less doc still parses");
        assert!(parse_findings("no json here").is_err());

        // A doc carrying triage surfaces it.
        let with_triage = r#"{"findings":[],"triage":{"verdict":"attend","reason":"r","cited_seq":7}}"#;
        let doc = parse_findings(with_triage).unwrap();
        let t = doc.triage.unwrap();
        assert_eq!(t.verdict.as_deref(), Some("attend"));
        assert_eq!(t.cited_seq, Some(7));
    }

    #[test]
    fn severity_maps_to_conventional_labels() {
        assert_eq!(
            severity_label("important"),
            (Some("issue".into()), Some("blocking".into()))
        );
        assert_eq!(
            severity_label("nit"),
            (Some("nitpick".into()), Some("non-blocking".into()))
        );
        assert_eq!(
            severity_label("pre_existing"),
            (Some("note".into()), Some("non-blocking".into()))
        );
        assert_eq!(severity_label("other"), (None, None));
    }

    #[test]
    fn args_are_read_only_and_schema_carrying() {
        let args = ai_review_args();
        let joined = args.join(" ");
        assert!(joined.contains("--permission-mode bypassPermissions"));
        assert!(joined.contains("--tools Read,Grep,Glob"));
        assert!(!joined.contains("Bash"), "no shell surface");
        assert!(!joined.contains("Edit"), "no write surface");
        assert!(joined.contains("--json-schema"));
        assert!(joined.contains("--no-session-persistence"));
        // The schema itself must be valid JSON.
        assert!(serde_json::from_str::<Value>(FINDINGS_SCHEMA).is_ok());
    }

    #[test]
    fn prompt_renders_line_numbers_and_caps_oversized_diffs() {
        use crate::review::{DiffFile, DiffHunk, DiffLine, DiffLineKind, FileStatus};
        let file = DiffFile {
            old_path: "a.rs".into(),
            new_path: "a.rs".into(),
            status: FileStatus::Modified,
            binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                header: String::new(),
                lines: vec![DiffLine {
                    kind: DiffLineKind::Add,
                    old_line: None,
                    new_line: Some(1),
                    text: "let x = 1;".into(),
                }],
            }],
        };
        let p = build_prompt("/repo", 2, &[file.clone()], &[], 1, &[]);
        assert!(p.contains("FILE: a.rs (modified)"));
        assert!(p.contains("     1 +let x = 1;"));
        assert!(p.contains("review round 2"));
        // The triage section publishes the bar and never fabricates context.
        assert!(p.contains("attend bar: 1"));
        assert!(p.contains("(none retrieved)"));

        // Fired signals + retrieved decisions are shown to the model.
        let sig = vec!["auth_surface".to_string()];
        let dec = vec![(42i64, "event #42 kind=resolution | comment: keep scopes".to_string())];
        let p1 = build_prompt("/repo", 2, &[file.clone()], &sig, 2, &dec);
        assert!(p1.contains("auth_surface"));
        assert!(p1.contains("seq 42: event #42"));
        assert!(p1.contains("attend bar: 2"));

        // Oversize → the fallback keeps the hunk map but drops line content.
        let big_line = "x".repeat(MAX_PROMPT_DIFF_BYTES + 1);
        let mut big = file;
        big.hunks[0].lines[0].text = big_line;
        let p2 = build_prompt("/repo", 1, &[big], &[], 1, &[]);
        assert!(p2.contains("too large to inline"));
        assert!(p2.len() < MAX_PROMPT_DIFF_BYTES);
    }

    // ---- Shadow attention-router tests ------------------------------------

    fn mk_file(path: &str, texts: &[&str]) -> crate::review::DiffFile {
        use crate::review::{DiffFile, DiffHunk, DiffLine, DiffLineKind, FileStatus};
        DiffFile {
            old_path: path.into(),
            new_path: path.into(),
            status: FileStatus::Modified,
            binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 0,
                new_start: 1,
                new_lines: texts.len() as u32,
                header: String::new(),
                lines: texts
                    .iter()
                    .enumerate()
                    .map(|(i, t)| DiffLine {
                        kind: DiffLineKind::Add,
                        old_line: None,
                        new_line: Some(i as u32 + 1),
                        text: (*t).to_string(),
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn verdict_vocabulary_is_closed_auto_attend_only() {
        assert_eq!(RouterVerdict::parse("auto"), Some(RouterVerdict::Auto));
        assert_eq!(RouterVerdict::parse("attend"), Some(RouterVerdict::Attend));
        // No block tier — a machine never overrules the human.
        assert_eq!(RouterVerdict::parse("block"), None);
        assert_eq!(RouterVerdict::parse("hold"), None);
        assert_eq!(RouterVerdict::parse("Auto"), None);
        assert_eq!(RouterVerdict::parse(""), None);
        assert_eq!(RouterVerdict::Auto.as_str(), "auto");
        assert_eq!(RouterVerdict::Attend.as_str(), "attend");
        // The schema publishes the same closed set — exactly two values.
        let schema: Value = serde_json::from_str(FINDINGS_SCHEMA).unwrap();
        assert_eq!(
            schema["properties"]["triage"]["properties"]["verdict"]["enum"],
            serde_json::json!(["auto", "attend"])
        );
    }

    #[test]
    fn verdict_computes_at_the_published_bar() {
        let none: Vec<String> = vec![];
        let one = vec!["auth_surface".to_string()];
        let two = vec!["auth_surface".to_string(), "tests_missing".to_string()];
        assert_eq!(compute_verdict(&none, ATTEND_SIGNAL_BAR), RouterVerdict::Auto);
        assert_eq!(compute_verdict(&one, 1), RouterVerdict::Attend);
        assert_eq!(compute_verdict(&one, 2), RouterVerdict::Auto);
        assert_eq!(compute_verdict(&two, 2), RouterVerdict::Attend);
        // A misconfigured bar of 0 clamps to 1 — attend stays reachable,
        // and "everything attends" can't happen with zero signals.
        assert_eq!(compute_verdict(&none, 0), RouterVerdict::Auto);
        assert_eq!(compute_verdict(&one, 0), RouterVerdict::Attend);
    }

    #[test]
    fn signals_are_checkable_facts_of_the_diff() {
        // Auth/scope surfaces: by path…
        let s = compute_signals(&[mk_file("src-tauri/src/auth.rs", &["let x = 1;"])]);
        assert!(s.contains(&"auth_surface".to_string()));
        // …or by the route-table symbol in a changed line.
        let s = compute_signals(&[mk_file("src-tauri/src/lib.rs", &["ROUTE_TABLE.push(r);"])]);
        assert!(s.contains(&"auth_surface".to_string()));
        // Ledger/chain code.
        let s = compute_signals(&[mk_file("src-tauri/src/ledger.rs", &["let y = 2;"])]);
        assert!(s.contains(&"ledger_chain".to_string()));
        // Non-test code with no test file → tests_missing…
        let s = compute_signals(&[mk_file("src/app.ts", &["export const a = 1;"])]);
        assert!(s.contains(&"tests_missing".to_string()));
        // …silenced when a test file rides along.
        let s = compute_signals(&[
            mk_file("src/app.ts", &["export const a = 1;"]),
            mk_file("src/app.test.ts", &["it()"]),
        ]);
        assert!(!s.contains(&"tests_missing".to_string()));
        // Blast radius by file count.
        let many: Vec<_> = (0..13)
            .map(|i| mk_file(&format!("src/f{i}.md"), &["x"]))
            .collect();
        assert!(compute_signals(&many).contains(&"blast_radius".to_string()));
        // A docs-only touch fires nothing.
        assert!(compute_signals(&[mk_file("docs/notes.md", &["hello"])]).is_empty());
    }

    #[test]
    fn fabricated_citations_are_dropped_to_plain_reason() {
        // Validation: a cited seq survives only if it exists.
        assert_eq!(validate_citation(Some(99), |_| false), None);
        assert_eq!(validate_citation(Some(7), |s| s == 7), Some(7));
        assert_eq!(validate_citation(None, |_| true), None);
        assert_eq!(validate_citation(Some(0), |_| true), None);

        // A reason claiming a contradiction without a validated citation is
        // discarded wholesale — downgraded to the checkable signals.
        let signals = vec!["auth_surface".to_string()];
        let r = router_reason(
            Some("contradicts decision at seq 99: never expose scopes"),
            Some(99),
            None,
            &signals,
        );
        assert_eq!(r, "signals: auth_surface");
        assert!(!r.contains("99"));

        // The downgrade is not phrase-bound: ANY decision/seq-flavored wording
        // without a validated cite falls back the same way.
        let reworded = router_reason(
            Some("this contradicts the decision at seq 99 about scopes"),
            None,
            None,
            &signals,
        );
        assert_eq!(reworded, "signals: auth_surface");

        // A failed citation drops the reason even when the wording is
        // innocuous — the model DID cite, and the cite did not validate.
        let failed_cite = router_reason(Some("touches auth"), Some(99), None, &signals);
        assert_eq!(failed_cite, "signals: auth_surface");

        // A validated citation keeps the model's reason.
        let ok = router_reason(
            Some("contradicts decision at seq 7: keep X"),
            Some(7),
            Some(7),
            &signals,
        );
        assert!(ok.contains("seq 7"));

        // Plain reasons pass through; absent ones fall back.
        assert_eq!(router_reason(Some("touches auth"), None, None, &signals), "touches auth");
        assert_eq!(router_reason(None, None, None, &[]), "no risk signals fired");
    }

    #[test]
    fn citations_are_kind_checked_against_retrieved_decisions() {
        // A ledger holding one machine record (router_verdict) and one real
        // decision (approval). Both exist; only the decision may be cited.
        let db = crate::db::Database::open_in_memory().unwrap();
        let append = |kind: &str, ph: &str| {
            db.append_ledger_event(&crate::ledger::LedgerAppend {
                kind,
                author: "t",
                ts: 1,
                prompt_id: None,
                session_id: None,
                version_number: None,
                ref_kind: Some("code_review"),
                ref_id: Some("r1"),
                payload_hash: ph,
            })
            .unwrap()
            .seq
        };
        let rv_seq = append("router_verdict", "h1");
        let ap_seq = append("approval", "h2");

        // Paths whose salient terms match BOTH events' contexts — retrieval
        // still only yields the decision kind.
        let diff = vec![
            mk_file("src/approval.rs", &["let x = 1;"]),
            mk_file("src/router_verdict.rs", &["let y = 2;"]),
        ];
        let decisions = retrieve_decision_context(&db, &diff);
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].0, ap_seq);

        // The call-site closure: a non-decision seq is dropped even though the
        // seq exists in the ledger…
        let cited = validate_citation(Some(rv_seq), |s| citation_in_decisions(&decisions, s));
        assert_eq!(cited, None, "a machine-record seq must never validate");
        // …and its reason downgrades to the plain signals, cited_seq absent.
        let signals = vec!["auth_surface".to_string()];
        let reason = router_reason(
            Some(&format!("contradicts decision at seq {rv_seq}: machine says so")),
            Some(rv_seq),
            cited,
            &signals,
        );
        assert_eq!(reason, "signals: auth_surface");

        // A listed decision seq still validates.
        let ok = validate_citation(Some(ap_seq), |s| citation_in_decisions(&decisions, s));
        assert_eq!(ok, Some(ap_seq));
    }

    #[test]
    fn shadow_guard_verdict_never_steers_review_flow() {
        // Structural SHADOW-MODE guard over this module's non-test source: the
        // verdict's only sinks are the ledger record and the FE event payload.
        let src = include_str!("ai_review.rs");
        let code = &src[..src.find("#[cfg(test)]").expect("test module marker")];

        // 1. No review-mutating API is reachable from this module at all,
        //    except `ingest_annotation` (finding ingestion, which predates the
        //    router and is not verdict-gated — see check 2).
        for banned in [
            "upsert_code_review",
            "delete_code_review",
            "insert_review_annotation",
            "update_review_annotation",
            "delete_review_annotation",
            "clear_review_annotations_by_source",
            "review_annotation_update",
            "review_delete",
            "open_or_continue_review",
            "carry_annotations_forward",
            "review_annotation_add",
            "review_annotation_delete",
            "review_annotation_clear_source",
            "review_mark_viewed",
        ] {
            assert!(
                !code.contains(banned),
                "shadow mode broken: ai_review.rs must never call {banned}"
            );
        }

        // 2. The verdict is born strictly AFTER the last finding is ingested —
        //    it cannot gate ingestion or any earlier review control flow.
        let last_ingest = code.rfind("ingest_annotation").expect("ingestion present");
        let verdict_birth = code.find("let verdict").expect("verdict binding present");
        assert!(
            verdict_birth > last_ingest,
            "the verdict must be computed after all ingestion"
        );

        // 3. No verdict-mentioning line touches ingestion.
        for line in code.lines() {
            if line.to_lowercase().contains("verdict") {
                assert!(
                    !line.contains("ingest_annotation"),
                    "verdict must not steer ingestion: {line}"
                );
            }
        }
    }
}

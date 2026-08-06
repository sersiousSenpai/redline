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
const MAX_PROMPT_DIFF_BYTES: usize = 300_000;

/// The findings contract, inlined via `--json-schema`. `quoted` is the anchor:
/// it MUST be a verbatim copy of consecutive diff lines for line placement.
const FINDINGS_SCHEMA: &str = r#"{"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"object","required":["severity","body"],"properties":{"severity":{"type":"string","enum":["important","nit","pre_existing"]},"file":{"type":["string","null"]},"side":{"type":["string","null"],"enum":["old","new",null]},"quoted":{"type":["string","null"]},"line_hint":{"type":["integer","null"]},"body":{"type":"string"},"suggestion":{"type":["string","null"]}}}}}}"#;

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

#[derive(Deserialize)]
struct FindingsDoc {
    findings: Vec<RawFinding>,
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
fn render_file_list(diff: &[crate::review::DiffFile]) -> String {
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

fn build_prompt(repo: &str, round: i64, diff: &[crate::review::DiffFile]) -> String {
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
         Respond with ONLY the JSON the schema requires.\n\n\
         THE DIFF UNDER REVIEW:\n\n{diff_block}{oversized_note}"
    )
}

/// Parse the reviewer's final text into findings: direct parse, then an
/// outermost-braces slice (schema enforcement can degrade across CLI
/// versions — never let framing noise waste a finished run).
fn parse_findings(text: &str) -> Result<Vec<RawFinding>, String> {
    if let Ok(doc) = serde_json::from_str::<FindingsDoc>(text) {
        return Ok(doc.findings);
    }
    let start = text.find('{');
    let end = text.rfind('}');
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            if let Ok(doc) = serde_json::from_str::<FindingsDoc>(&text[s..=e]) {
                return Ok(doc.findings);
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

    let prompt = build_prompt(&session.repo_path, session.round, &diff);
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
        let findings = match parse_findings(&text) {
            Ok(f) => f,
            Err(e) => {
                fail(e, false);
                return;
            }
        };

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
        let _ = app.emit(
            "review-ai-done",
            AiDoneEvent {
                review_id: rid.clone(),
                added,
                important,
                nits,
                pre_existing,
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
        assert_eq!(parse_findings(direct).unwrap().len(), 1);
        let framed = format!("Here you go:\n```json\n{direct}\n```\nDone.");
        let sliced = parse_findings(&framed).unwrap();
        assert_eq!(sliced.len(), 1);
        assert_eq!(sliced[0].severity, "nit");
        assert!(parse_findings("no json here").is_err());
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
        let p = build_prompt("/repo", 2, &[file.clone()]);
        assert!(p.contains("FILE: a.rs (modified)"));
        assert!(p.contains("     1 +let x = 1;"));
        assert!(p.contains("review round 2"));

        // Oversize → the fallback keeps the hunk map but drops line content.
        let big_line = "x".repeat(MAX_PROMPT_DIFF_BYTES + 1);
        let mut big = file;
        big.hunks[0].lines[0].text = big_line;
        let p2 = build_prompt("/repo", 1, &[big]);
        assert!(p2.contains("too large to inline"));
        assert!(p2.len() < MAX_PROMPT_DIFF_BYTES);
    }
}

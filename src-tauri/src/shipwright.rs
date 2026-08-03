// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **Shipwright**: the on-demand agent that reads `codehealth`'s ground-truth
//! digest of the Redline repo and proposes a small number of improvements to
//! Redline itself.
//!
//! Structurally a clone of `librarian.rs` — `resolve_claude_bin` →
//! `ledger::register_agent_prompt` (the lake-pollution guard, mandatory) →
//! `bridge_args` + `claude_command_for_seat` → drain `stream-json` via
//! `classify_line` → tolerant balanced-brace parse. Three deliberate deltas:
//!
//! 1. **`cwd` is the repo**, not `$HOME`, and the spawn adds `--add-dir` for it
//!    (following `browse.rs`'s code-access pattern) so it can actually read code.
//! 2. **Resumable.** The Librarian is one-shot; the Shipwright carries a
//!    `prior_session`, which is what makes L1 ("expand finding 3") possible and
//!    what lets a `/v1/global/consult` land as a check-in in its own thread.
//! 3. **It has an L1 write path** — `POST /v1/drafter/:id/suggestions`, which
//!    already exists and lands tracked suggestions the user accepts or rejects.
//!    **No repo writes at any point.**
//!
//! The priority order, the 5-finding cap, the cite-a-number rule and the
//! rule-plus-guard-test preference all live in `skills/shipwright/SKILL.md`;
//! this module supplies the prompt and parses the reply.
//!
//! ## L2 seam (documented, not built)
//!
//! L2 = an executor implements a finding on a branch in a throwaway git worktree
//! and Redline opens that diff in the Code Review pane. `worktree.rs` and
//! `review.rs` are the pieces. Nothing here builds it; [`Finding`] keeps the seam
//! open by carrying `proposal`, `guard` and `files` as **separate** fields — a
//! target, an acceptance test, and a shipped-detection key.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::codehealth::CodeDigest;
use crate::ledger;

/// Hard cap on findings per run. The cap exists because reviewing them costs
/// the scarcest resource in this project; a model that returns eight gets five.
pub const MAX_FINDINGS: usize = 5;

/// One proposed improvement to Redline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// 1-based rank. Reassigned to list position if the model omits or
    /// duplicates it, so the UI always renders a clean 1..N.
    pub priority: i64,
    pub category: String,
    pub title: String,
    /// Must quote a digest number — a finding that can't cite one is dropped.
    #[serde(default)]
    pub evidence: String,
    /// The change. Kept separate from `guard` and `files` for the L2 seam.
    #[serde(default)]
    pub proposal: String,
    /// The cheap regression test that would fail if this came back.
    #[serde(default)]
    pub guard: String,
    /// Repo-relative paths. The shipped-detection key — never decoration.
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// The Shipwright's whole output: a one-line read + the ranked findings.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ShipwrightResult {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<Finding>,
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/// Build the Shipwright's first-turn prompt: the role, the ground-truth digest
/// (baked in — the core loop never depends on the agent successfully curling),
/// and the strict JSON output contract. Pure / testable.
pub fn build_shipwright_prompt(digest_block: &str) -> String {
    let mut p = String::new();
    p.push_str(
        "You are Redline's Shipwright — the on-demand agent that proposes \
         improvements to Redline's own codebase. Load your `shipwright` skill for \
         the full contract (the priority order, the rule-plus-guard-test \
         preference, and the JSON output shape).\n\n\
         Below is a code digest computed as GROUND TRUTH from Redline's own \
         database and working tree — treat every number as fact; do not re-derive \
         it. You have Read/Grep/Glob over the repo to inspect what a number points \
         at, and the read-only local bridge (already permitted, no approval): \
         `curl -s http://127.0.0.1:7676/v1/context/overview`, \
         `/v1/context/codehealth`. Read code to UNDERSTAND a digest signal — never \
         to invent one the digest doesn't carry.\n\n",
    );
    p.push_str(digest_block);
    p.push_str(
        "\n## Your task\n\nReturn at most 5 findings, most important first.\n\n\
         Rank by the priority order in your `shipwright` skill: recorded-correction \
         signals (Tier A) outrank static metrics — a 4-round reopen is evidence of \
         real pain, a long file is only a hypothesis. Prefer a **rule plus a guard \
         test** (the `docs/perf-budget.md` + `perf_guard.rs` model) over a refactor: \
         it is the only friction fix in this repo that compounds.\n\n\
         Every `evidence` MUST quote a number from the digest above — a finding \
         that can't cite one does not ship, so delete it rather than dress it up. \
         Never fabricate a signal the digest doesn't carry; in particular the \
         digest carries NO GUI-verification number, so do not claim one. Mark \
         findings in files the digest flagged `provisional` as provisional, and \
         name the rev you measured in your summary. Return genuinely new findings \
         or fewer than five — do NOT re-word a dismissed finding to slip past the \
         dedupe.\n\n\
         Return ONLY a JSON object (optionally in a ```json fence):\n\n\
         {\"summary\":\"<one-line read, naming the rev and dirty counts>\",\"findings\":[\n  \
         {\"priority\":1,\"category\":\"recorded_correction|runtime_failure|unfinished_work|command_hygiene|oversized|untested|dead_wiring|ci_coverage|spawn_duplication\",\"title\":\"<number-carrying headline>\",\"evidence\":\"<the digest number this rests on>\",\"proposal\":\"<the change>\",\"guard\":\"<the regression test that would catch it>\",\"files\":[\"<repo-relative path>\"],\"effort\":\"small|medium|large\"}\n]}\n",
    );
    p
}

/// Convenience: build the prompt straight from a digest.
pub fn build_shipwright_prompt_from_digest(d: &CodeDigest) -> String {
    build_shipwright_prompt(&crate::codehealth::render_code_digest_prompt_block(d))
}

// ---------------------------------------------------------------------------
// Output parsing (structured-JSON findings)
// ---------------------------------------------------------------------------

/// Parse the Shipwright's final message into a `ShipwrightResult`. Tolerant like
/// `librarian::parse_checklist`: finds the first balanced `{…}` that parses and
/// carries a `findings` array, drops malformed items, normalizes priorities to
/// 1..N in list order, and enforces [`MAX_FINDINGS`]. Pure.
pub fn parse_findings(text: &str) -> ShipwrightResult {
    let Some(obj) = extract_findings_object(text) else {
        return ShipwrightResult::default();
    };
    let summary = obj
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut findings: Vec<Finding> = Vec::new();
    if let Some(arr) = obj.get("findings").and_then(Value::as_array) {
        for v in arr {
            if let Some(f) = parse_finding(v) {
                findings.push(f);
            }
        }
    }
    // The cap is enforced here, not asked for politely in the prompt.
    findings.truncate(MAX_FINDINGS);
    for (i, f) in findings.iter_mut().enumerate() {
        f.priority = (i + 1) as i64;
    }
    ShipwrightResult { summary, findings }
}

fn parse_finding(v: &Value) -> Option<Finding> {
    // A title is required — an item with no headline is noise.
    let title = v
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    // …and so is evidence. "Every finding cites a digest number" is the rule
    // that keeps this agent from being a plausible-refactor generator, so it is
    // enforced structurally rather than left to the model's discretion.
    let evidence = v
        .get("evidence")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let category = v
        .get("category")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unfinished_work")
        .to_string();
    let text_of = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    // `files` may arrive as an array or as a single string.
    let files = match v.get("files") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        _ => Vec::new(),
    };
    let effort = v
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let priority = v.get("priority").and_then(Value::as_i64).unwrap_or(0);
    Some(Finding {
        priority,
        category,
        title,
        evidence,
        proposal: text_of("proposal"),
        guard: text_of("guard"),
        files,
        effort,
    })
}

/// First top-level `{…}` substring that parses as JSON and carries a `findings`
/// key. Mirrors `librarian`'s extractor (kept local so the modules stay
/// decoupled — they are allowed to diverge).
fn extract_findings_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get("findings").is_some() {
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

/// Render findings as the markdown body of the Bookshelf document the user
/// trims and launches. Pure — the document is the deliverable, so its shape is
/// worth testing.
pub fn findings_to_markdown(result: &ShipwrightResult, digest: &CodeDigest) -> String {
    let mut md = String::new();
    md.push_str("# Redline — Shipwright findings\n\n");
    if !result.summary.trim().is_empty() {
        md.push_str(result.summary.trim());
        md.push_str("\n\n");
    }
    md.push_str(&format!(
        "> Measured at `{}` on `{}` — {} modified, {} untracked.\n\n",
        if digest.git.short_rev.is_empty() {
            "unknown"
        } else {
            &digest.git.short_rev
        },
        if digest.git.branch.is_empty() {
            "unknown"
        } else {
            &digest.git.branch
        },
        digest.git.dirty_files.len(),
        digest.git.untracked_files.len(),
    ));
    if result.findings.is_empty() {
        md.push_str(
            "No findings this run. Delete the ones you don't want and launch the \
             rest; an empty run is a healthy tree, not a failure.\n",
        );
        return md;
    }
    md.push_str(
        "Trim this down to what you actually want built, then launch it. \
         Everything you leave in becomes the prompt.\n\n",
    );
    for f in &result.findings {
        md.push_str(&format!("## {}. {}\n\n", f.priority, f.title));
        md.push_str(&format!("**Category:** `{}`", f.category));
        if let Some(effort) = &f.effort {
            md.push_str(&format!(" · **Effort:** {effort}"));
        }
        md.push_str("\n\n");
        if !f.evidence.trim().is_empty() {
            md.push_str(&format!("**Evidence:** {}\n\n", f.evidence.trim()));
        }
        if !f.proposal.trim().is_empty() {
            md.push_str(&format!("**Proposal:** {}\n\n", f.proposal.trim()));
        }
        if !f.guard.trim().is_empty() {
            md.push_str(&format!("**Guard:** {}\n\n", f.guard.trim()));
        }
        if !f.files.is_empty() {
            md.push_str(&format!("**Files:** `{}`\n\n", f.files.join("`, `")));
        }
    }
    md
}

// ---------------------------------------------------------------------------
// Spawn + drive
// ---------------------------------------------------------------------------

/// Run the Shipwright headless to completion and return its final text + session
/// id. The digest is baked into `prompt` so the core loop never depends on the
/// agent curling. Registers the prompt with the agent-prompt guard first so the
/// headless `-p` doesn't leak into the lake via the global hook.
///
/// `prior_session` resumes an earlier run — the delta from the Librarian that
/// makes L1 iteration and consult check-ins possible.
pub async fn run_shipwright(
    repo: &str,
    prompt: String,
    prior_session: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    ledger::register_agent_prompt(&ledger::body_hash(&prompt));
    let mut args = crate::claude_proc::bridge_args("shipwright", prompt, prior_session);
    // Read the repo. `cwd` alone isn't enough for a headless spawn to have the
    // tree in scope — `browse.rs` learned this for its code-access grant.
    args.push("--add-dir".to_string());
    args.push(repo.to_string());
    let mut cmd = crate::claude_proc::claude_command_for_seat("shipwright", &claude_bin);
    let mut child = cmd
        .current_dir(repo)
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
                format!("failed to spawn the Shipwright: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("Shipwright stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Shipwright stderr unavailable")?;

    let mut reader = BufReader::new(stdout).lines();
    let mut session: Option<String> = None;
    let mut final_text: Option<String> = None;
    let mut errored: Option<String> = None;
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
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
            "the Shipwright produced no output".to_string()
        } else {
            format!("the Shipwright failed: {}", errbuf.trim())
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_fenced_findings_object_and_normalizes_priorities() {
        let text = r#"Here's what I found:
```json
{"summary":"measured at abc1234 on main, 3 modified / 0 untracked",
 "findings":[
   {"priority":7,"category":"ci_coverage","title":"No test workflow","evidence":"457 Rust + 655 frontend tests, 1 workflow (cla.yml)","proposal":"Add a CI workflow","guard":"the workflow itself","files":[".github/workflows/ci.yml"],"effort":"small"},
   {"category":"command_hygiene","title":"drafter_set_doc is sync","evidence":"246 commands vs 32 (async)","proposal":"mark it (async)","files":"src-tauri/src/lib.rs"}
 ]}
```
That's the lot."#;
        let r = parse_findings(text);
        assert_eq!(r.findings.len(), 2);
        assert_eq!(r.findings[0].priority, 1);
        assert_eq!(r.findings[1].priority, 2);
        assert_eq!(r.findings[0].files, vec![".github/workflows/ci.yml"]);
        // A single string in `files` is coerced to a one-element array — it is
        // the shipped-detection key, so losing it would silently break that.
        assert_eq!(r.findings[1].files, vec!["src-tauri/src/lib.rs"]);
        assert!(r.summary.contains("abc1234"));
    }

    #[test]
    fn a_finding_that_cites_no_number_is_dropped() {
        // The cite-a-number rule is enforced structurally, not asked for.
        let text = r#"{"summary":"ok","findings":[
          {"title":"The DB layer feels large","category":"oversized","proposal":"split it"},
          {"evidence":"x","category":"oversized","proposal":"no title, so dropped"},
          {"title":"  ","evidence":"10713 lines"},
          {"title":"db.rs is 10713 lines","evidence":"10713 lines","category":"oversized"}
        ]}"#;
        let r = parse_findings(text);
        assert_eq!(r.findings.len(), 1, "only the cited, titled finding survives");
        assert_eq!(r.findings[0].title, "db.rs is 10713 lines");
    }

    #[test]
    fn the_five_finding_cap_is_enforced_here_not_requested() {
        let items: Vec<String> = (0..9)
            .map(|i| {
                format!(
                    r#"{{"title":"f{i}","evidence":"{i} lines","category":"oversized"}}"#
                )
            })
            .collect();
        let text = format!(r#"{{"summary":"s","findings":[{}]}}"#, items.join(","));
        let r = parse_findings(&text);
        assert_eq!(r.findings.len(), MAX_FINDINGS);
        assert_eq!(r.findings[4].priority, 5);
    }

    #[test]
    fn tolerates_prose_and_bad_json_and_an_empty_run() {
        assert!(parse_findings("no json here at all").findings.is_empty());
        let r = parse_findings(r#"{"summary":"Healthy tree.","findings":[]}"#);
        assert!(r.findings.is_empty());
        assert_eq!(r.summary, "Healthy tree.");
    }

    #[test]
    fn the_prompt_bakes_the_digest_and_states_every_discipline() {
        let p = build_shipwright_prompt(
            "## Code digest (GROUND TRUTH)\n- oversized: db.rs 10713 lines\n",
        );
        assert!(p.contains("GROUND TRUTH"));
        assert!(p.contains("10713"));
        assert!(p.contains("shipwright` skill"));
        assert!(p.contains("\"findings\""));
        // The four disciplines that make this not-slop.
        assert!(p.contains("at most 5") || p.contains("at most 5 findings"));
        assert!(p.contains("MUST quote a number"));
        assert!(p.contains("guard test"));
        assert!(p.contains("re-word a dismissed finding"));
        // And the deliberate gap it must not fill in.
        assert!(p.contains("NO GUI-verification number"));
    }

    #[test]
    fn markdown_keeps_proposal_guard_and_files_separate_for_the_l2_seam() {
        let digest = crate::codehealth::CodeDigest {
            generated_ts: 0,
            repo_path: "/repo".into(),
            git: crate::codehealth::GitState {
                short_rev: "abc1234".into(),
                branch: "main".into(),
                dirty_files: vec!["a.rs".into()],
                ..Default::default()
            },
            corrections: vec![],
            static_findings: vec![],
            runtime_failures: vec![],
            self_scoring: vec![],
            unfinished: vec![],
            open_findings: vec![],
            dismissed_summaries: vec![],
        };
        let result = ShipwrightResult {
            summary: "one finding".into(),
            findings: vec![Finding {
                priority: 1,
                category: "ci_coverage".into(),
                title: "No test workflow".into(),
                evidence: "1112 tests, 1 workflow".into(),
                proposal: "Add .github/workflows/ci.yml".into(),
                guard: "the workflow run itself".into(),
                files: vec![".github/workflows/ci.yml".into()],
                effort: Some("small".into()),
            }],
        };
        let md = findings_to_markdown(&result, &digest);
        assert!(md.contains("Measured at `abc1234` on `main` — 1 modified"));
        assert!(md.contains("**Evidence:** 1112 tests"));
        assert!(md.contains("**Proposal:**"));
        assert!(md.contains("**Guard:**"));
        assert!(md.contains("**Files:**"));

        // An empty run says so honestly rather than producing a blank document.
        let empty = findings_to_markdown(&ShipwrightResult::default(), &digest);
        assert!(empty.contains("healthy tree"));
    }
}

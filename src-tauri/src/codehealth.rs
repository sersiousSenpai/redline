// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **code digest** the Shipwright reasons over — computed as GROUND TRUTH
//! in Rust, never inferred by the agent.
//!
//! Modelled directly on `context.rs` (`build_digest` +
//! `render_digest_prompt_block`), and for the same reason. From
//! `docs/polis-librarian-spike-3a.md`: *"Every friction is a ground-truth signal
//! the Rust digest computes from existing accessors (never inferred by the
//! agent)."* An agent pointed at 115k LOC and told "find friction" has no ground
//! truth and no stopping point — it will return ten plausible refactors every
//! time, and reviewing them costs the scarcest resource in this project. **The
//! digest is what makes it not-slop.**
//!
//! Best-effort per signal: a probe that fails yields an empty list, never a
//! failed digest. Every collection is capped.
//!
//! ## Four tiers, in priority order
//!
//! - **A — recorded correction.** Reopen rounds, edit pairs, review rounds,
//!   share re-anchoring, rejected suggestions, in-review friction. This is the
//!   labeled corpus of *"the agent got this wrong and I corrected it"* that
//!   already sat in the DB unmined. It outranks everything below it: a 4-round
//!   reopen is evidence of real pain; a long file is only a hypothesis.
//! - **B — static repo health.** Pure functions over file contents, so each
//!   tests against fixture strings in `perf_guard.rs`'s `include_str!` style.
//! - **C — runtime failures + the agent's own track record**, from
//!   `friction_events` and `shipwright_findings`.
//! - **D — unfinished work.** A first-class ranked category, not a footnote,
//!   because "finish what you have" should be a finding with a number behind it.
//!
//! ## The tree it measured
//!
//! Every digest is stamped with a [`GitState`]. The probes deliberately read the
//! **working tree**, not a pinned checkout — pinning would blind the digest to
//! exactly the work in flight — but the dirty delta is never invisible: it is a
//! ranked signal in its own right (Tier D), and the skill marks findings in
//! dirty files *provisional*. The agent must be able to say "measured at
//! `abc1234`, 39 modified, 22 untracked", never quietly mix committed and
//! half-written code.
//!
//! ## The L2 seam (documented, not built — see Phase 5 of the plan)
//!
//! L2 is: the agent implements a finding on a branch in a throwaway git
//! worktree, and Redline opens that diff in the existing Code Review pane. The
//! pieces already exist (`worktree.rs`, `review.rs` with rounds, re-anchoring
//! and blocking feedback). Nothing here builds it — but the finding schema
//! carries `proposal` + `guard` + `files` as **separate fields precisely so an
//! L2 executor has a target, an acceptance test, and a shipped-detection key**.
//! Keep them separate.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::db::{CategoryScore, Database, FrictionCount};
use crate::ledger::now_millis;

/// Caps keep the digest bounded (mirrors `context.rs`'s bounds).
pub const MAX_REOPEN: i64 = 8;
pub const MAX_EDIT_PAIRS: i64 = 8;
pub const MAX_REVIEW_ROUNDS: i64 = 8;
pub const MAX_UNREVIEWED: i64 = 10;
pub const MAX_STALE_BRANCHES: usize = 10;
pub const MAX_STATIC_FINDINGS: usize = 12;
/// Files the static walk will open. A hard ceiling, per perf-budget rule 1:
/// the cost of this command must not scale with "whatever the repo becomes".
pub const MAX_FILES_WALKED: usize = 1200;
/// Runtime-failure window: 30 days of `friction_events`.
pub const FRICTION_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Evidence redaction — the one new egress path in this plan
// ---------------------------------------------------------------------------

/// Cap on one quoted excerpt of the user's own prose.
pub const MAX_QUOTE_CHARS: usize = 240;
/// Cap on how many excerpts any one signal may carry.
pub const MAX_QUOTES_PER_SIGNAL: usize = 3;

/// Redact one piece of user prose before it enters a model prompt.
///
/// Tier A is the one new egress path in this plan: reopen notes and edit pairs
/// are prose *you* wrote that has only ever lived on this disk. So each quote is
/// capped at [`MAX_QUOTE_CHARS`], and paths, URLs and absolute-home prefixes are
/// stripped. **Counts and round numbers pass through whole** — the number is the
/// signal; the prose is only illustrative.
///
/// Pure, so the rule is tested directly rather than inferred from a prompt.
pub fn redact_evidence(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_QUOTE_CHARS + 8));
    for token in raw.split_whitespace() {
        let redacted = redact_token(token);
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&redacted);
    }
    let trimmed = out.trim();
    if trimmed.chars().count() <= MAX_QUOTE_CHARS {
        return trimmed.to_string();
    }
    let mut clipped: String = trimmed.chars().take(MAX_QUOTE_CHARS).collect();
    clipped.push('…');
    clipped
}

/// A single whitespace-delimited token, with anything location-shaped removed.
fn redact_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
    {
        return "[url]".to_string();
    }
    // Absolute paths and `~/...` — both name where this machine keeps things.
    if token.starts_with('/') || token.starts_with("~/") {
        return "[path]".to_string();
    }
    // A relative path with a separator (`src/foo/bar.rs`) is a location too;
    // a bare `file.rs` is a useful noun and stays.
    if token.contains('/') && token.len() > 1 {
        return "[path]".to_string();
    }
    token.to_string()
}

/// Redact a whole signal's worth of quotes, applying both caps.
pub fn redact_quotes<I: IntoIterator<Item = String>>(quotes: I) -> Vec<String> {
    quotes
        .into_iter()
        .filter(|q| !q.trim().is_empty())
        .take(MAX_QUOTES_PER_SIGNAL)
        .map(|q| redact_evidence(&q))
        .filter(|q| !q.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// The tree the digest measured
// ---------------------------------------------------------------------------

/// The exact tree every Tier B finding was measured against.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub rev: String,
    pub short_rev: String,
    pub branch: String,
    /// Repo-relative paths with uncommitted modifications.
    pub dirty_files: Vec<String>,
    pub untracked_files: Vec<String>,
    pub is_dirty: bool,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/git")
        .arg("-C")
        .arg(dir)
        .arg("--no-optional-locks")
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Split `git status --porcelain` into `(modified, untracked)`. Pure, so the
/// parse is tested without a repo.
pub fn parse_status_porcelain(out: &str) -> (Vec<String>, Vec<String>) {
    let mut modified = Vec::new();
    let mut untracked = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let (code, rest) = line.split_at(2);
        let path = rest.trim().trim_matches('"').to_string();
        if path.is_empty() {
            continue;
        }
        if code == "??" {
            untracked.push(path);
        } else {
            // A rename reads `R  old -> new`; the new path is what matters.
            let path = path
                .rsplit(" -> ")
                .next()
                .unwrap_or(&path)
                .trim()
                .to_string();
            modified.push(path);
        }
    }
    (modified, untracked)
}

pub fn resolve_git_state(repo: &Path) -> GitState {
    let rev = git(repo, &["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let short_rev = rev.chars().take(7).collect::<String>();
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let (dirty_files, untracked_files) = git(repo, &["status", "--porcelain"])
        .map(|s| parse_status_porcelain(&s))
        .unwrap_or_default();
    let is_dirty = !dirty_files.is_empty() || !untracked_files.is_empty();
    GitState {
        rev,
        short_rev,
        branch,
        dirty_files,
        untracked_files,
        is_dirty,
    }
}

// ---------------------------------------------------------------------------
// Digest shape
// ---------------------------------------------------------------------------

/// A Tier A signal: a number, plus (redacted) prose that illustrates it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionSignal {
    pub kind: String,
    pub count: i64,
    /// Short, number-carrying headline the agent can cite verbatim.
    pub headline: String,
    /// At most `MAX_QUOTES_PER_SIGNAL` redacted excerpts.
    pub quotes: Vec<String>,
}

/// A Tier B static finding: a hypothesis with a measured number behind it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticFinding {
    pub probe: String,
    pub file: String,
    pub detail: String,
    /// The measured magnitude (lines, count) — what the agent must cite.
    pub value: i64,
    /// True when `file` has uncommitted changes. The skill marks these
    /// **provisional**: the digest measured half-written code.
    pub provisional: bool,
}

/// A Tier D unfinished-work item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnfinishedItem {
    pub kind: String,
    pub label: String,
    pub detail: String,
    pub age_days: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDigest {
    pub generated_ts: i64,
    pub repo_path: String,
    pub git: GitState,
    /// Tier A — recorded correction. Outranks everything below.
    pub corrections: Vec<CorrectionSignal>,
    /// Tier B — static repo health, grouped by probe.
    pub static_findings: Vec<StaticFinding>,
    /// Tier C — runtime failures from `friction_events`.
    pub runtime_failures: Vec<FrictionCount>,
    /// Tier C — the Shipwright's own accept/dismiss/ship rates.
    pub self_scoring: Vec<CategoryScore>,
    /// Tier D — unfinished work.
    pub unfinished: Vec<UnfinishedItem>,
    /// Open findings the user hasn't resolved, so the agent doesn't repeat them.
    pub open_findings: Vec<String>,
    /// Summaries the user dismissed. The agent is told not to re-word these.
    pub dismissed_summaries: Vec<String>,
}

fn days_since(now: i64, then: i64) -> i64 {
    ((now - then).max(0)) / 86_400_000
}

// ---------------------------------------------------------------------------
// Tier B probes — pure functions over file contents
// ---------------------------------------------------------------------------

/// A source file is oversized when it stops being reviewable in one sitting.
pub const OVERSIZED_LINES: i64 = 2000;

pub fn probe_oversized(path: &str, src: &str) -> Option<StaticFinding> {
    let lines = src.lines().count() as i64;
    if lines < OVERSIZED_LINES {
        return None;
    }
    Some(StaticFinding {
        probe: "oversized".to_string(),
        file: path.to_string(),
        detail: format!("{lines} lines — past the point of reviewing in one sitting"),
        value: lines,
        provisional: false,
    })
}

/// Body substrings that make a Tauri command "heavy" under perf-budget rule 4.
const HEAVY_MARKERS: &[&str] = &[
    "read_to_string",
    "File::open",
    "serde_json::from_",
    "base64",
    "fs::read",
    "std::process::Command",
];

/// A **sync** `#[tauri::command]` whose body does real work runs on the WebView
/// main thread and beach-balls the UI — perf-budget rule 4, and the one rule in
/// this repo that already has both a written rule and a guard test behind it.
/// Reports the offending function names.
pub fn probe_command_hygiene(path: &str, src: &str) -> Vec<StaticFinding> {
    let mut out = Vec::new();
    let bytes: Vec<&str> = src.lines().collect();
    for (i, line) in bytes.iter().enumerate() {
        if line.trim() != "#[tauri::command]" {
            continue; // `(async)` variants are exactly what we want
        }
        // The body runs from the signature to the next top-level `}` at the
        // same indent — approximated by the next `\n}` or `\n    }`, which is
        // enough to catch a heavy call without parsing Rust.
        let name = bytes
            .get(i + 1..i + 4)
            .and_then(|w| w.iter().find(|l| l.contains("fn ")))
            .and_then(|l| l.split("fn ").nth(1))
            .and_then(|l| l.split(['(', '<']).next())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let mut body = String::new();
        for line in bytes.iter().skip(i + 1) {
            body.push_str(line);
            body.push('\n');
            if *line == "}" {
                break;
            }
        }
        let hits: Vec<&str> = HEAVY_MARKERS
            .iter()
            .copied()
            .filter(|m| body.contains(m))
            .collect();
        if hits.is_empty() {
            continue;
        }
        out.push(StaticFinding {
            probe: "command_hygiene".to_string(),
            file: path.to_string(),
            detail: format!(
                "`{name}` is a sync #[tauri::command] whose body calls {} — perf-budget rule 4 says it must be (async)",
                hits.join(", ")
            ),
            value: hits.len() as i64,
            provisional: false,
        });
    }
    out
}

/// A module with no `#[cfg(test)]` block at all. Weak on its own — plenty of
/// modules are pure wiring — which is exactly why it ranks below Tier A.
pub fn probe_untested(path: &str, src: &str) -> Option<StaticFinding> {
    if src.contains("#[cfg(test)]") {
        return None;
    }
    let lines = src.lines().count() as i64;
    if lines < 200 {
        return None; // a small module carrying no tests is not a finding
    }
    Some(StaticFinding {
        probe: "untested".to_string(),
        file: path.to_string(),
        detail: format!("{lines} lines with no #[cfg(test)] module"),
        value: lines,
        provisional: false,
    })
}

/// Registered Tauri commands that no frontend code ever calls.
///
/// **This probe must be conservative.** A naive version false-positives
/// wherever `invoke` is called with a variable. So: parse `generate_handler![…]`
/// for the registered names, then emit only names that appear **nowhere** in the
/// frontend sources as an exact string literal. A name reached only through a
/// computed `invoke(cmd)` will therefore be missed — the right trade, because a
/// false "this is dead, delete it" is far more expensive than a miss.
pub fn probe_dead_wiring(handler_src: &str, frontend_sources: &str) -> Vec<String> {
    let Some(start) = handler_src.find("generate_handler![") else {
        return Vec::new();
    };
    let rest = &handler_src[start + "generate_handler![".len()..];
    let Some(end) = rest.find(']') else {
        return Vec::new();
    };
    let mut dead = Vec::new();
    for raw in rest[..end].split(',') {
        let name = raw
            .trim()
            .trim_end_matches(',')
            .rsplit("::")
            .next()
            .unwrap_or("")
            .trim();
        if name.is_empty() || name.starts_with("//") {
            continue;
        }
        // Exact string-literal match, both quote styles.
        let double = format!("\"{name}\"");
        let single = format!("'{name}'");
        let backtick = format!("`{name}`");
        if !frontend_sources.contains(&double)
            && !frontend_sources.contains(&single)
            && !frontend_sources.contains(&backtick)
        {
            dead.push(name.to_string());
        }
    }
    dead
}

/// Workflows that exist but run no tests, so their presence must not read as
/// coverage. `cla.yml` gates contributor agreements; it never runs a suite.
const NON_TEST_WORKFLOWS: &[&str] = &["cla.yml", "cla.yaml"];

/// Whether the repo has any CI at all that runs the test suites. A workflow
/// directory holding only `cla.yml` is *no* coverage — which is exactly the
/// state this repo is in, with 1,100+ tests running on one machine.
pub fn probe_ci_coverage(workflow_names: &[String]) -> Option<StaticFinding> {
    let workflows: Vec<&String> = workflow_names
        .iter()
        .filter(|n| n.ends_with(".yml") || n.ends_with(".yaml"))
        .collect();
    if workflows
        .iter()
        .any(|n| !NON_TEST_WORKFLOWS.contains(&n.as_str()))
    {
        return None;
    }
    Some(StaticFinding {
        probe: "ci_coverage".to_string(),
        file: ".github/workflows/".to_string(),
        detail: format!(
            "no test workflow ({}) — every test in this repo runs on one machine, and nowhere else",
            if workflows.is_empty() {
                "the directory holds none".to_string()
            } else {
                format!(
                    "only {}, which runs no suite",
                    workflows
                        .iter()
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        ),
        value: workflows.len() as i64,
        provisional: false,
    })
}

/// Modules that each re-implement the same headless-`claude` spawn/drain loop.
/// A count, not a judgement: the agent decides whether it's worth extracting.
pub fn probe_spawn_duplication(files: &[(String, String)]) -> Option<StaticFinding> {
    let dupes: Vec<&str> = files
        .iter()
        .filter(|(_, src)| src.contains("bridge_args") && src.contains("classify_line"))
        .map(|(p, _)| p.as_str())
        .collect();
    if dupes.len() < 4 {
        return None;
    }
    Some(StaticFinding {
        probe: "spawn_duplication".to_string(),
        file: dupes.first().copied().unwrap_or("").to_string(),
        detail: format!(
            "{} modules each carry their own bridge_args + classify_line drain loop: {}",
            dupes.len(),
            dupes.join(", ")
        ),
        value: dupes.len() as i64,
        provisional: false,
    })
}

/// `for-each-ref` output → local branches by age, newest commit first. Pure.
pub fn parse_branch_ages(out: &str, now_secs: i64) -> Vec<(String, i64)> {
    let mut rows: Vec<(String, i64)> = Vec::new();
    for line in out.lines() {
        let Some((name, ts)) = line.split_once('\t') else {
            continue;
        };
        let Ok(ts) = ts.trim().parse::<i64>() else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        rows.push((name.to_string(), ((now_secs - ts).max(0)) / 86_400));
    }
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    rows
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/// Read every Rust source in `repo/src-tauri/src`, capped at
/// [`MAX_FILES_WALKED`]. Returns `(repo_relative_path, contents)`.
fn read_rust_sources(repo: &Path) -> Vec<(String, String)> {
    let dir = repo.join("src-tauri").join("src");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten().take(MAX_FILES_WALKED) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let rel = path
            .strip_prefix(repo)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        out.push((rel, src));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Concatenate the frontend sources `dead_wiring` searches, capped the same way.
fn read_frontend_sources(repo: &Path) -> String {
    fn walk(dir: &Path, budget: &mut usize, out: &mut String) {
        if *budget == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if *budget == 0 {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, budget, out);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !matches!(ext, "ts" | "tsx" | "js" | "jsx") {
                continue;
            }
            if let Ok(src) = std::fs::read_to_string(&path) {
                out.push_str(&src);
                out.push('\n');
                *budget -= 1;
            }
        }
    }
    let mut out = String::new();
    let mut budget = MAX_FILES_WALKED;
    walk(&repo.join("src"), &mut budget, &mut out);
    out
}

/// Build the whole digest. Best-effort per signal, hard-capped throughout.
pub fn build_code_digest(db: &Database, repo_path: &str) -> CodeDigest {
    let now = now_millis();
    let repo = Path::new(repo_path);
    // Resolved FIRST: every Tier B finding is stamped with the tree it measured.
    let git_state = resolve_git_state(repo);
    let dirty: std::collections::HashSet<&str> = git_state
        .dirty_files
        .iter()
        .chain(git_state.untracked_files.iter())
        .map(String::as_str)
        .collect();

    // --- Tier A: recorded correction -------------------------------------
    let mut corrections: Vec<CorrectionSignal> = Vec::new();

    let reopens = db
        .reopen_rounds_for_repo(repo_path, MAX_REOPEN)
        .unwrap_or_default();
    if !reopens.is_empty() {
        let worst = reopens.first().map(|r| r.1).unwrap_or(0);
        corrections.push(CorrectionSignal {
            kind: "reopen_rounds".to_string(),
            count: reopens.len() as i64,
            headline: format!(
                "{} comment(s) were reopened; the worst went {worst} round(s)",
                reopens.len()
            ),
            quotes: redact_quotes(
                reopens
                    .iter()
                    .map(|(_, rounds, body, note)| {
                        format!(
                            "[{rounds} rounds] {}",
                            note.as_deref().unwrap_or(body.as_str())
                        )
                    })
                    .collect::<Vec<_>>(),
            ),
        });
    }

    let edits = db
        .edit_pairs_for_repo(repo_path, MAX_EDIT_PAIRS)
        .unwrap_or_default();
    if !edits.is_empty() {
        corrections.push(CorrectionSignal {
            kind: "edit_pairs".to_string(),
            count: edits.len() as i64,
            headline: format!("{} verbatim rewrite(s) of agent prose", edits.len()),
            quotes: redact_quotes(
                edits
                    .iter()
                    .map(|(_, before, after)| format!("was: {before} → now: {after}"))
                    .collect::<Vec<_>>(),
            ),
        });
    }

    let rounds = db
        .review_rounds_for_repo(repo_path, MAX_REVIEW_ROUNDS)
        .unwrap_or_default();
    if !rounds.is_empty() {
        let worst = rounds.first().map(|r| r.1).unwrap_or(0);
        corrections.push(CorrectionSignal {
            kind: "review_rounds".to_string(),
            count: rounds.len() as i64,
            headline: format!(
                "{} code review(s) took more than one round; the worst took {worst}",
                rounds.len()
            ),
            quotes: Vec::new(),
        });
    }

    let (placed, orphans) = db.share_anchoring_for_repo(repo_path).unwrap_or((0, 0));
    if placed + orphans > 0 {
        corrections.push(CorrectionSignal {
            kind: "share_anchoring".to_string(),
            count: orphans,
            headline: format!(
                "returned review comments: {placed} re-anchored, {orphans} orphaned"
            ),
            quotes: Vec::new(),
        });
    }

    let rejected = db
        .rejected_suggestion_summary(repo_path)
        .unwrap_or_default();
    if !rejected.is_empty() {
        let total: i64 = rejected.iter().map(|(_, n)| n).sum();
        corrections.push(CorrectionSignal {
            kind: "rejected_suggestions".to_string(),
            count: total,
            headline: format!(
                "{total} agent write-suggestion(s) rejected ({})",
                rejected
                    .iter()
                    .map(|(op, n)| format!("{op}×{n}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            quotes: Vec::new(),
        });
    }

    // Reuse `context::build_digest`'s in-review friction rather than
    // recomputing it — one accessor, one definition of "stalled". That digest
    // is workspace-wide, so scope it here by project NAME: `in_review_friction`
    // carries `project_name`, not `project_path`, and adding a repo-scoped
    // accessor purely for this would fork the definition of "stalled" into two
    // places. Names can collide across paths; over-counting a sibling repo's
    // stalled review is a far cheaper error than two drifting definitions.
    let repo_name = repo
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let in_review: Vec<_> = crate::context::build_digest(db, crate::context::MAX_IN_REVIEW)
        .in_review
        .into_iter()
        .filter(|s| !repo_name.is_empty() && s.project == repo_name)
        .collect();
    if !in_review.is_empty() {
        let total: i64 = in_review.iter().map(|s| s.unresolved_comments).sum();
        corrections.push(CorrectionSignal {
            kind: "in_review".to_string(),
            count: total,
            headline: format!(
                "{} session(s) still in review with {total} unresolved comment(s)",
                in_review.len()
            ),
            quotes: Vec::new(),
        });
    }

    // --- Tier B: static repo health --------------------------------------
    let sources = read_rust_sources(repo);
    let mut static_findings: Vec<StaticFinding> = Vec::new();
    for (path, src) in &sources {
        if let Some(f) = probe_oversized(path, src) {
            static_findings.push(f);
        }
        static_findings.extend(probe_command_hygiene(path, src));
        if let Some(f) = probe_untested(path, src) {
            static_findings.push(f);
        }
    }
    if let Some(f) = probe_spawn_duplication(&sources) {
        static_findings.push(f);
    }
    let workflows: Vec<String> = std::fs::read_dir(repo.join(".github").join("workflows"))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    if let Some(f) = probe_ci_coverage(&workflows) {
        static_findings.push(f);
    }
    let dead = probe_dead_wiring(
        &sources
            .iter()
            .find(|(p, _)| p.ends_with("lib.rs"))
            .map(|(_, s)| s.clone())
            .unwrap_or_default(),
        &read_frontend_sources(repo),
    );
    if !dead.is_empty() {
        // Name a bounded sample, not all of them — the digest is a prompt.
        const NAMED: usize = 12;
        let shown = dead.iter().take(NAMED).cloned().collect::<Vec<_>>().join(", ");
        static_findings.push(StaticFinding {
            probe: "dead_wiring".to_string(),
            file: "src-tauri/src/lib.rs".to_string(),
            detail: format!(
                "{} registered command(s) that no frontend source names as a string literal: {shown}{}",
                dead.len(),
                if dead.len() > NAMED {
                    format!(" (+{} more)", dead.len() - NAMED)
                } else {
                    String::new()
                }
            ),
            value: dead.len() as i64,
            provisional: false,
        });
    }
    // Stamp anything measured in a file with uncommitted changes.
    for f in &mut static_findings {
        f.provisional = dirty.contains(f.file.as_str());
    }
    static_findings = rank_static_findings(static_findings);

    // --- Tier C: runtime failures + the agent's own track record -----------
    let runtime_failures = db.friction_summary(FRICTION_WINDOW_MS).unwrap_or_default();
    let self_scoring = db.shipwright_scores().unwrap_or_default();

    // --- Tier D: unfinished work ------------------------------------------
    let mut unfinished: Vec<UnfinishedItem> = Vec::new();
    if git_state.is_dirty {
        let by_area = group_by_area(&git_state.dirty_files, &git_state.untracked_files);
        unfinished.push(UnfinishedItem {
            kind: "uncommitted".to_string(),
            label: format!(
                "{} modified, {} untracked",
                git_state.dirty_files.len(),
                git_state.untracked_files.len()
            ),
            detail: by_area,
            age_days: 0,
        });
    }
    let now_secs = now / 1000;
    let branches = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "refs/heads",
        ],
    )
    .map(|out| parse_branch_ages(&out, now_secs))
    .unwrap_or_default();
    for (name, age) in branches.into_iter().take(MAX_STALE_BRANCHES) {
        if name == git_state.branch || age < 14 {
            continue;
        }
        unfinished.push(UnfinishedItem {
            kind: "stale_branch".to_string(),
            label: name,
            detail: "unmerged local branch".to_string(),
            age_days: age,
        });
    }
    for (session_id, project, created) in db
        .approved_unreviewed_for_repo(repo_path, MAX_UNREVIEWED)
        .unwrap_or_default()
    {
        unfinished.push(UnfinishedItem {
            kind: "approved_unreviewed".to_string(),
            label: project,
            detail: format!("plan {session_id} was approved; its code never went through a review"),
            age_days: days_since(now, created),
        });
    }

    // --- Prior outcomes ----------------------------------------------------
    let all = db.list_shipwright_findings(true).unwrap_or_default();
    let open_findings = all
        .iter()
        .filter(|f| !f.dismissed && f.status == "pending")
        .map(|f| format!("[{}] {}", f.category, f.summary))
        .collect();
    let dismissed_summaries = all
        .iter()
        .filter(|f| f.dismissed)
        .map(|f| f.summary.clone())
        .collect();

    CodeDigest {
        generated_ts: now,
        repo_path: repo_path.to_string(),
        git: git_state,
        corrections,
        static_findings,
        runtime_failures,
        self_scoring,
        unfinished,
        open_findings,
        dismissed_summaries,
    }
}

/// Rank and truncate Tier B to [`MAX_STATIC_FINDINGS`], **giving every probe its
/// loudest finding before any probe gets a second one**.
///
/// A plain sort by magnitude is wrong here, and quietly so: `ci_coverage`
/// reports `value = 1` (one workflow, and it runs no tests) while `oversized`
/// reports 10,713. Sorting by value alone drops the single most important
/// finding in this repo off the bottom of the list. Round-robin first, then fill
/// the remaining slots by magnitude. Pure.
pub fn rank_static_findings(mut findings: Vec<StaticFinding>) -> Vec<StaticFinding> {
    findings.sort_by(|a, b| b.value.cmp(&a.value).then(a.file.cmp(&b.file)));
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut first_of_each: Vec<StaticFinding> = Vec::new();
    let mut rest: Vec<StaticFinding> = Vec::new();
    for f in findings {
        if seen.insert(f.probe.clone()) {
            first_of_each.push(f);
        } else {
            rest.push(f);
        }
    }
    first_of_each.extend(rest);
    first_of_each.truncate(MAX_STATIC_FINDINGS);
    first_of_each
}

/// `"src-tauri/src ×12, src/components ×7"` — the uncommitted count by area.
pub fn group_by_area(dirty: &[String], untracked: &[String]) -> String {
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for path in dirty.iter().chain(untracked.iter()) {
        let area = path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_else(|| ".".to_string());
        *counts.entry(area).or_insert(0) += 1;
    }
    let mut rows: Vec<(String, i64)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    rows.into_iter()
        .take(6)
        .map(|(area, n)| format!("{area} ×{n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Prompt rendering (baked into the Shipwright's spawn prompt)
// ---------------------------------------------------------------------------

/// Render the digest as a ground-truth markdown block. Numbers only — the SKILL
/// supplies the priority order and the agent supplies the ranking judgment.
pub fn render_code_digest_prompt_block(d: &CodeDigest) -> String {
    let mut p = String::new();
    p.push_str("## Code digest (GROUND TRUTH — do not re-derive; rank these)\n\n");

    p.push_str(&format!(
        "### The tree this measured\n- repo: {}\n- rev: {} ({})\n- branch: {}\n- **{} modified, {} untracked**\n",
        d.repo_path,
        if d.git.short_rev.is_empty() { "unknown" } else { &d.git.short_rev },
        if d.git.rev.is_empty() { "unknown" } else { &d.git.rev },
        if d.git.branch.is_empty() { "unknown" } else { &d.git.branch },
        d.git.dirty_files.len(),
        d.git.untracked_files.len(),
    ));
    if d.git.is_dirty {
        p.push_str(
            "- The probes read the WORKING TREE, not a pinned checkout. Any finding \
             marked `provisional` sits in a file with uncommitted changes — say so \
             when you cite it.\n",
        );
    }
    p.push('\n');

    p.push_str("### Tier A — recorded correction (HIGHEST PRIORITY)\n");
    p.push_str(
        "These are times the user corrected the agent, in their own words. A \
         4-round reopen is evidence of real pain; a long file is only a hypothesis. \
         Rank these above everything below.\n",
    );
    if d.corrections.is_empty() {
        p.push_str("- (no recorded corrections on this repo)\n");
    } else {
        for c in &d.corrections {
            p.push_str(&format!("- **{}** ({}): {}\n", c.kind, c.count, c.headline));
            for q in &c.quotes {
                p.push_str(&format!("  - > {q}\n"));
            }
        }
    }
    p.push('\n');

    p.push_str("### Tier B — static repo health (hypotheses, not pain)\n");
    if d.static_findings.is_empty() {
        p.push_str("- (nothing flagged)\n");
    } else {
        for f in &d.static_findings {
            p.push_str(&format!(
                "- [{}] {} — {}{}\n",
                f.probe,
                f.file,
                f.detail,
                if f.provisional {
                    "  **(provisional — file has uncommitted changes)**"
                } else {
                    ""
                }
            ));
        }
    }
    p.push('\n');

    p.push_str("### Tier C — runtime failures (last 30 days)\n");
    if d.runtime_failures.is_empty() {
        p.push_str("- (none recorded)\n");
    } else {
        for f in &d.runtime_failures {
            p.push_str(&format!("- {}: {} time(s)\n", f.kind, f.count));
        }
    }
    p.push('\n');

    p.push_str("### Tier C — your own track record\n");
    if d.self_scoring.is_empty() {
        p.push_str("- (this is your first run — no track record yet)\n");
    } else {
        for s in &d.self_scoring {
            p.push_str(&format!(
                "- {}: {} proposed, {} accepted, {} dismissed, {} shipped\n",
                s.category, s.total, s.accepted, s.dismissed, s.shipped
            ));
        }
    }
    p.push('\n');

    p.push_str("### Tier D — unfinished work\n");
    if d.unfinished.is_empty() {
        p.push_str("- (nothing unfinished)\n");
    } else {
        for u in &d.unfinished {
            p.push_str(&format!(
                "- [{}] {} — {}{}\n",
                u.kind,
                u.label,
                u.detail,
                if u.age_days > 0 {
                    format!(" ({}d old)", u.age_days)
                } else {
                    String::new()
                }
            ));
        }
    }
    p.push('\n');

    p.push_str("### GUI verification — a conscious gap, do NOT claim a number\n");
    p.push_str(
        "Nothing in the schema records whether a built feature was ever exercised \
         in the running app. So there is no number here and you must not invent \
         one. (This closes the same way F6 did, with a `verified_at` stamp on \
         approved sessions — named as the follow-on, not built.)\n\n",
    );

    p.push_str("### Findings still open (do not repeat these)\n");
    if d.open_findings.is_empty() {
        p.push_str("- (none)\n");
    } else {
        for f in &d.open_findings {
            p.push_str(&format!("- {f}\n"));
        }
    }
    p.push('\n');

    p.push_str("### Findings the user DISMISSED\n");
    if d.dismissed_summaries.is_empty() {
        p.push_str("- (none)\n");
    } else {
        for s in &d.dismissed_summaries {
            p.push_str(&format!("- {s}\n"));
        }
        p.push_str(
            "\nReturn genuinely new findings, or fewer than five. Do NOT re-word a \
             dismissed finding to slip past the dedupe — the dedupe is keyed on \
             wording, and re-wording one is the known way to defeat it.\n",
        );
    }
    p.push('\n');
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_strips_locations_and_caps_the_quote() {
        // Tier A is the one new egress path: prose the user wrote, on their disk.
        let raw = "the fix belongs in /Users/someone/redline/src/App.tsx not \
                   src-tauri/src/lib.rs — see https://example.com/issue/4 and ~/notes.md";
        let out = redact_evidence(raw);
        assert!(!out.contains("/Users/someone"), "absolute home stripped: {out}");
        assert!(!out.contains("example.com"), "url stripped: {out}");
        assert!(!out.contains("~/notes.md"), "tilde path stripped: {out}");
        assert!(out.contains("[path]") && out.contains("[url]"));
        // A bare filename is a useful noun and survives.
        assert!(redact_evidence("check parser.rs").contains("parser.rs"));

        let long = "word ".repeat(400);
        let clipped = redact_evidence(&long);
        assert!(clipped.chars().count() <= MAX_QUOTE_CHARS + 1, "capped");
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn at_most_three_quotes_survive_per_signal() {
        let quotes = vec![
            "one".to_string(),
            "two".to_string(),
            "three".to_string(),
            "four".to_string(),
        ];
        assert_eq!(redact_quotes(quotes).len(), MAX_QUOTES_PER_SIGNAL);
        // Blank quotes never occupy a slot.
        let sparse = vec!["".to_string(), "  ".to_string(), "real".to_string()];
        assert_eq!(redact_quotes(sparse), vec!["real".to_string()]);
    }

    #[test]
    fn dead_wiring_is_conservative_about_computed_invokes() {
        let handler = r#"
            .invoke_handler(tauri::generate_handler![
                really_dead,
                drafter_set_doc,
                bookshelf::bookshelf_list,
            ])
        "#;
        let frontend = r#"
            invoke("drafter_set_doc", { draftId });
            const cmd = someCondition ? "bookshelf_list" : "other";
            invoke(cmd);
        "#;
        let dead = probe_dead_wiring(handler, frontend);
        assert_eq!(dead, vec!["really_dead".to_string()]);
        // A module-qualified registration is matched on its bare name, and a
        // name reached only through a variable is NOT reported — a false
        // "delete this" costs far more than a miss.
        assert!(!dead.contains(&"bookshelf_list".to_string()));
    }

    #[test]
    fn command_hygiene_flags_sync_commands_that_do_real_work() {
        let src = "#[tauri::command]\n\
                   fn heavy(path: String) -> Result<String, String> {\n\
                   \x20   let s = std::fs::read_to_string(&path).unwrap();\n\
                   \x20   Ok(s)\n\
                   }\n\
                   #[tauri::command(async)]\n\
                   fn also_heavy(path: String) {\n\
                   \x20   let _ = std::fs::read_to_string(&path);\n\
                   }\n\
                   #[tauri::command]\n\
                   fn light(n: u32) -> u32 { n + 1 }\n";
        let found = probe_command_hygiene("x.rs", src);
        assert_eq!(found.len(), 1, "only the sync+heavy one: {found:?}");
        assert!(found[0].detail.contains("heavy"));
        assert!(found[0].detail.contains("read_to_string"));
    }

    #[test]
    fn oversized_and_untested_need_a_real_magnitude() {
        assert!(probe_oversized("s.rs", "line\n").is_none());
        let big = "line\n".repeat(OVERSIZED_LINES as usize + 1);
        let f = probe_oversized("s.rs", &big).unwrap();
        assert!(f.value > OVERSIZED_LINES);
        // A module WITH tests is never flagged, however long.
        let tested = format!("{big}#[cfg(test)]\nmod tests {{}}\n");
        assert!(probe_untested("s.rs", &tested).is_none());
        // A short module without tests is not a finding either.
        assert!(probe_untested("s.rs", "fn a() {}\n").is_none());
        assert!(probe_untested("s.rs", &big).is_some());
    }

    #[test]
    fn a_cla_only_workflow_directory_is_not_ci_coverage() {
        // The real state of this repo: 1,100+ tests, and the only workflow
        // gates contributor agreements.
        let f = probe_ci_coverage(&["cla.yml".to_string()]).unwrap();
        assert!(f.detail.contains("no test workflow"));
        assert!(f.detail.contains("cla.yml"));
        assert!(probe_ci_coverage(&[]).is_some());
        // Any other workflow counts as coverage — the probe doesn't judge it.
        assert!(probe_ci_coverage(&["cla.yml".into(), "test.yml".into()]).is_none());
        // Non-yaml files in the directory are ignored.
        assert!(probe_ci_coverage(&["README.md".to_string()]).is_some());
    }

    #[test]
    fn every_probe_gets_its_loudest_finding_before_any_probe_gets_two() {
        // The bug this guards: `ci_coverage` reports value 1 while `oversized`
        // reports 10,713, so a plain sort by magnitude drops the single most
        // important finding in this repo off the bottom of the list.
        let f = |probe: &str, file: &str, value: i64| StaticFinding {
            probe: probe.to_string(),
            file: file.to_string(),
            detail: String::new(),
            value,
            provisional: false,
        };
        let mut input: Vec<StaticFinding> = (0..MAX_STATIC_FINDINGS + 4)
            .map(|i| f("oversized", &format!("big{i}.rs"), 9000 + i as i64))
            .collect();
        input.push(f("ci_coverage", ".github/workflows/", 1));
        let ranked = rank_static_findings(input);
        assert_eq!(ranked.len(), MAX_STATIC_FINDINGS);
        assert_eq!(ranked[0].probe, "oversized", "loudest probe still leads");
        assert!(
            ranked.iter().any(|r| r.probe == "ci_coverage"),
            "the low-magnitude probe survives truncation"
        );
    }

    #[test]
    fn status_porcelain_splits_modified_from_untracked_and_follows_renames() {
        let out = " M src/App.tsx\n?? src/New.tsx\nR  old.rs -> new.rs\n";
        let (modified, untracked) = parse_status_porcelain(out);
        assert_eq!(modified, vec!["src/App.tsx", "new.rs"]);
        assert_eq!(untracked, vec!["src/New.tsx"]);
    }

    #[test]
    fn branch_ages_sort_oldest_first() {
        let now = 1_000_000_000;
        let out = format!(
            "main\t{}\nfeature/old\t{}\n",
            now - 86_400,
            now - 86_400 * 40
        );
        let ages = parse_branch_ages(&out, now);
        assert_eq!(ages[0].0, "feature/old");
        assert_eq!(ages[0].1, 40);
        assert_eq!(ages[1].1, 1);
    }

    #[test]
    fn area_grouping_is_stable_and_bounded() {
        let dirty = vec![
            "src-tauri/src/db.rs".to_string(),
            "src-tauri/src/lib.rs".to_string(),
            "src/App.tsx".to_string(),
        ];
        let untracked = vec!["src-tauri/src/new.rs".to_string()];
        let s = group_by_area(&dirty, &untracked);
        assert!(s.starts_with("src-tauri/src ×3"), "got {s}");
        assert!(s.contains("src ×1"));
    }

    #[test]
    fn an_empty_db_yields_a_valid_bounded_digest_that_names_its_gaps() {
        let db = Database::open_in_memory().unwrap();
        // A path that is not a repo: every git probe fails, none of them fail
        // the digest.
        let d = build_code_digest(&db, "/nonexistent/repo");
        assert!(d.corrections.is_empty());
        assert!(d.open_findings.is_empty());
        let block = render_code_digest_prompt_block(&d);
        assert!(block.contains("GROUND TRUTH"));
        // The three disciplines the prompt must always carry.
        assert!(block.contains("Tier A"));
        assert!(block.contains("do NOT claim a number"), "GUI gap is named");
        assert!(block.contains("re-word a dismissed finding") || block.contains("(none)"));
    }

    #[test]
    fn the_prompt_block_carries_dismissed_summaries_and_the_dedupe_warning() {
        let db = Database::open_in_memory().unwrap();
        db.insert_shipwright_finding(&crate::db::ShipwrightFinding {
            id: "f1".into(),
            run_id: "r1".into(),
            category: "ci_coverage".into(),
            summary: "No test workflow".into(),
            evidence: None,
            proposal: None,
            guard: None,
            files: None,
            status: "pending".into(),
            dismissed: false,
            draft_id: None,
            created_at: 1,
            resolved_at: None,
        })
        .unwrap();
        db.resolve_shipwright_finding("f1", "dismissed", None).unwrap();
        let d = build_code_digest(&db, "/nonexistent/repo");
        assert_eq!(d.dismissed_summaries, vec!["No test workflow".to_string()]);
        let block = render_code_digest_prompt_block(&d);
        assert!(block.contains("No test workflow"));
        assert!(
            block.contains("re-word a dismissed finding"),
            "the known dedupe escape hatch is named explicitly"
        );
    }
}

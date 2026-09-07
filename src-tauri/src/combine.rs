// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

//! Combine N plan sessions into ONE brief that a fresh plan session
//! synthesises into a single orchestration-ready plan.
//!
//! Why this lives in Rust rather than a TS module: the bulk of the feature is
//! contract prose, and prose in a TS module is boot bytes. `bootJsBytes` sits
//! at 1,047,586 of 1,052,000 — about 4 KB of headroom — and the precedent is
//! exact: the Codex plan contract moved out of a TS module into
//! `codex_plan_contract.txt` behind `include_str!` and took 6.4 KB back off
//! the entry chunk. Composing here also puts the rules under `cargo test`
//! instead of a boot-path string.
//!
//! Two outputs, always produced together so they can never disagree about
//! which sources went in:
//!
//! * `brief` — contract + instruction + the stripped source plans. Typed into
//!   the PTY as one `shq`-quoted argv positional, exactly like a Drafter
//!   document. `pty_write_checked` paces writes in 512-byte chunks because
//!   the macOS tty input queue silently discards past 1024 bytes, and its own
//!   comment records that "a 60 KB document still types in well under a
//!   second" — so a multi-plan brief needs no temp file, no `--add-dir` and
//!   no bridge route, and it works identically on the Codex arm, which has no
//!   localhost and so could never `curl` the plans back.
//! * `record` — the human's typed context verbatim, plus one provenance line
//!   per source committing to its stored markdown BY HASH. This, not the
//!   brief, is what reaches the prompt lake.
//!
//! The record exists because `record_plan_launch` files every launch as
//! `CorpusRole::User` with `author: None`, under the comment "the launched
//! prompt is the human's own writing". True for the Front Door, the Drafter
//! and a chat graduation; false for a brief that is up to 120 KB of
//! concatenated machine-written plans. And because
//! `keeper::select_compaction_candidates` filters `role != "user"`, such a row
//! would be permanently uncompactable, FTS-indexed and embedded as if it had
//! been typed.

use serde::Serialize;

use crate::ledger::body_hash;
use crate::parser::{plan_title_from_markdown, strip_sidecar_lines};

/// Fewer than two plans is not a combination — the sidebar's Combine button
/// and the Front Door's ⏎ both key on this.
pub const MIN_COMBINE: usize = 2;

/// The cap on the assembled brief. Past it the preview REFUSES; it never
/// truncates. Silently dropping half of someone's plan and then producing a
/// confident merge is the worst failure this feature could have.
pub const MAX_COMBINE_BYTES: usize = 120_000;

const CONTRACT: &str = include_str!("combine_contract.txt");

/// The heading the typed context is written under, and the heading that ends
/// it. The typed context is multi-line and unescaped, so `## Sources` is the
/// delimiter that keeps prose from being read as provenance.
const INSTRUCTION_HEADING: &str = "## What the person combining these asked for";
const SOURCES_HEADING: &str = "## Sources";

/// One plan session as the caller found it. `raw_plan_markdown` is the
/// revision EXACTLY as stored — sidecars included — because the provenance
/// hash must be verifiable against `revisions.raw_plan_markdown` as it sits on
/// disk. Stripping happens on the way into the brief, not on the way in here.
#[derive(Debug, Clone)]
pub struct SourceRow {
    pub session_id: String,
    pub project_name: String,
    pub project_path: String,
    pub version_number: u32,
    pub status: String,
    pub run_state: Option<String>,
    pub pending_count: u32,
    pub raw_plan_markdown: String,
}

/// What a pill shows.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CombineSource {
    pub session_id: String,
    pub plan_title: Option<String>,
    pub project_name: String,
    pub project_path: String,
    pub version_number: u32,
    pub status: String,
    pub run_state: Option<String>,
    pub pending_count: u32,
    /// Size of the sidecar-stripped markdown — what this source actually
    /// costs the brief.
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CombinePreview {
    pub sources: Vec<CombineSource>,
    /// The most common project among the sources, tie-broken by the first
    /// selected — what the Front Door seeds its project chip with.
    pub default_project_path: Option<String>,
    /// Real conditions that are worth saying and not worth refusing over.
    pub warnings: Vec<String>,
    /// A sentence naming why this selection cannot be launched at all.
    /// `None` = launchable.
    pub blocked: Option<String>,
    pub total_bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CombineBrief {
    /// Contract + instruction + stripped plans — typed into the PTY.
    pub brief: String,
    /// Instruction verbatim + source hashes — the lake row's body.
    pub record: String,
}

fn title_of(row: &SourceRow) -> Option<String> {
    plan_title_from_markdown(&row.raw_plan_markdown)
}

fn display_title(row: &SourceRow) -> String {
    title_of(row).unwrap_or_else(|| format!("Untitled plan {}", short_id(&row.session_id)))
}

fn short_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

/// `sha256:9c1e…` — enough to commit to the text without turning the record
/// into a wall of hex. The full hash is not needed to verify: it is recomputed
/// from `revisions.raw_plan_markdown` and compared by prefix.
fn short_hash(md: &str) -> String {
    let h = body_hash(md);
    format!("sha256:{}", &h[..16.min(h.len())])
}

/// The body of one source as it enters the brief.
fn stripped(row: &SourceRow) -> String {
    strip_sidecar_lines(&row.raw_plan_markdown)
}

pub fn preview(sources: &[SourceRow]) -> CombinePreview {
    let projected: Vec<CombineSource> = sources
        .iter()
        .map(|r| CombineSource {
            session_id: r.session_id.clone(),
            plan_title: title_of(r),
            project_name: r.project_name.clone(),
            project_path: r.project_path.clone(),
            version_number: r.version_number,
            status: r.status.clone(),
            run_state: r.run_state.clone(),
            pending_count: r.pending_count,
            bytes: stripped(r).len(),
        })
        .collect();

    let total_bytes: usize = projected.iter().map(|s| s.bytes).sum();

    let blocked = if sources.len() < MIN_COMBINE {
        Some(format!(
            "Pick at least {MIN_COMBINE} plans to combine — one plan is already a plan."
        ))
    } else if total_bytes > MAX_COMBINE_BYTES {
        // Names the plans and the byte count. Deliberately not a truncation:
        // a confident merge of half a plan is worse than no merge.
        let names = sources
            .iter()
            .map(display_title)
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!(
            "These {} plans are {} KB of markdown together, over the {} KB \
             a single launch can carry ({names}). Combine fewer of them — \
             nothing is truncated, because half a plan merged confidently is \
             worse than no merge at all.",
            sources.len(),
            total_bytes / 1000,
            MAX_COMBINE_BYTES / 1000,
        ))
    } else {
        None
    };

    CombinePreview {
        default_project_path: default_project(sources),
        warnings: warnings(sources),
        blocked,
        total_bytes,
        sources: projected,
    }
}

/// The most common `project_path` among the sources, tie-broken by the first
/// selected. Sources may span repos, which is exactly why the Front Door's
/// project chip matters here.
fn default_project(sources: &[SourceRow]) -> Option<String> {
    let mut best: Option<(&str, usize, usize)> = None; // (path, count, first index)
    for (i, row) in sources.iter().enumerate() {
        let path = row.project_path.as_str();
        if path.is_empty() {
            continue;
        }
        let count = sources.iter().filter(|r| r.project_path == path).count();
        let take = match best {
            None => true,
            Some((_, bc, bi)) => count > bc || (count == bc && i < bi),
        };
        if take {
            best = Some((path, count, i));
        }
    }
    best.map(|(p, _, _)| p.to_string())
}

/// Four conditions warn; none blocks. Each is real, each has a cheap honest
/// answer, and none is worth refusing a launch over.
fn warnings(sources: &[SourceRow]) -> Vec<String> {
    let mut out = Vec::new();

    // A run that already shipped or was stood down. Combining it re-plans
    // code that exists.
    let terminal: Vec<String> = sources
        .iter()
        .filter(|r| matches!(r.run_state.as_deref(), Some("landed") | Some("abandoned")))
        .map(|r| format!("{} ({})", display_title(r), r.run_state.as_deref().unwrap_or("?")))
        .collect();
    if !terminal.is_empty() {
        out.push(format!(
            "Already run: {}. That work may exist in the code — the combining \
             session is told, and is asked to defer rather than re-plan it.",
            terminal.join(", "),
        ));
    }

    // Resolved feedback is folded into the markdown by the revise round-trip;
    // PENDING comments are live disagreement that exists nowhere in
    // `raw_plan_markdown`, so the combining session cannot see them at all.
    let contested: Vec<String> = sources
        .iter()
        .filter(|r| r.pending_count > 0)
        .map(|r| format!("{} ({} unresolved)", display_title(r), r.pending_count))
        .collect();
    if !contested.is_empty() {
        out.push(format!(
            "Unresolved comments: {}. That feedback is not in the plan text, \
             so the combination cannot see it — resolve first, or knowingly \
             merge a contested plan.",
            contested.join(", "),
        ));
    }

    // The launch has one cwd, so tracks belonging to another repo are
    // unexecutable. `buildPlanLaunchCommand` supports `addDirs`, but
    // `launchPlan` force-switches to claude-code whenever add-dirs are
    // non-empty, silently overriding a Codex pick — so v1 says the split
    // plainly instead of granting anything.
    let mut projects: Vec<&str> = sources
        .iter()
        .map(|r| r.project_name.as_str())
        .filter(|p| !p.is_empty())
        .collect();
    projects.sort_unstable();
    projects.dedup();
    if projects.len() > 1 {
        out.push(format!(
            "These plans span {} projects ({}). The launch runs in ONE of them, \
             so any track belonging to another repo will not be executable from \
             the combined plan.",
            projects.len(),
            projects.join(", "),
        ));
    }

    out
}

/// Compose the brief and its provenance record. Callers pass sources in the
/// user's selection order and get it back in that order.
pub fn compose(sources: &[SourceRow], instruction: &str) -> CombineBrief {
    let instruction = instruction.trim();

    let mut brief = String::with_capacity(CONTRACT.len() + 4096);

    // The MANIFEST leads, and that ordering is an ergonomics decision, not a
    // stylistic one. A combine brief is ~100 KB, and every surface that shows
    // it shows only its opening: claude's TUI collapses the rest behind
    // "(N lines hidden)", and the Front Door's Planning card clamps to
    // `max-height: 9em`. Whatever sits in those first lines is, in practice,
    // the entire thing anyone reads — so it has to answer "what did I just
    // send?" rather than restate the contract's generic preamble.
    //
    // It earns its place for the agent too: it learns the shape and the
    // running order before the rules, and the numbers here are the same ones
    // the sidebar's pick markers wore.
    brief.push_str(&format!(
        "# Combine {} plans → one orchestration-ready plan\n\nSources, in order:\n\n",
        sources.len()
    ));
    for (i, row) in sources.iter().enumerate() {
        brief.push_str(&format!(
            "{}. **{}** — {}, v{}, {}{}\n",
            i + 1,
            display_title(row),
            if row.project_name.is_empty() { "unknown project" } else { &row.project_name },
            row.version_number,
            row.status,
            match row.run_state.as_deref() {
                Some(state) => format!(", run: {state}"),
                None => String::new(),
            },
        ));
    }
    // The typed context sits up here too, for the same reason: it is the one
    // thing in this brief the human wrote, and burying it under the contract
    // put it past the fold on every surface.
    if !instruction.is_empty() {
        brief.push_str("\n");
        brief.push_str(INSTRUCTION_HEADING);
        brief.push_str("\n\n");
        brief.push_str(instruction);
        brief.push('\n');
    }
    brief.push_str("\n---\n\n");
    brief.push_str(CONTRACT);
    for (i, row) in sources.iter().enumerate() {
        brief.push_str("\n\n---\n\n");
        brief.push_str(&format!(
            "## Source {} — {} ({}, v{}, {}, run: {})\n\n",
            i + 1,
            display_title(row),
            if row.project_name.is_empty() { "unknown project" } else { &row.project_name },
            row.version_number,
            row.status,
            row.run_state.as_deref().unwrap_or("none"),
        ));
        // Sidecars stripped: feeding `<!-- rl:blk-… -->` lines to the
        // combining session would both waste its context and tempt it to copy
        // block ids into a new plan, where they would collide with the ids
        // that session's own ingest will inject.
        brief.push_str(stripped(row).trim_end());
        brief.push('\n');
    }

    let mut record = String::new();
    record.push_str(&format!(
        "## Combined {} plans into a new plan session\n",
        sources.len()
    ));
    if !instruction.is_empty() {
        // Verbatim, in full, never summarised into a label: this is the only
        // human-authored text in the entire launch, and it is what a future
        // search over the lake will actually match on.
        record.push('\n');
        record.push_str(instruction);
        record.push('\n');
    }
    record.push('\n');
    record.push_str(SOURCES_HEADING);
    record.push_str("\n\n");
    for row in sources {
        // The TITLE rides beside each hash, not just the id: `delete_session`
        // cascades `revisions`, so a bare hash goes dangling and unreadable.
        // Same provenance-not-FK posture the work graph's schema law takes.
        // The hash is over the STORED markdown, sidecars included.
        record.push_str(&format!(
            "- {} — session {} v{} — {}\n",
            display_title(row),
            short_id(&row.session_id),
            row.version_number,
            short_hash(&row.raw_plan_markdown),
        ));
    }

    CombineBrief { brief, record }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, title: &str, body: &str) -> SourceRow {
        SourceRow {
            session_id: id.to_string(),
            project_name: "redline".to_string(),
            project_path: "/Users/me/redline".to_string(),
            version_number: 1,
            status: "in_review".to_string(),
            run_state: None,
            pending_count: 0,
            raw_plan_markdown: format!("# {title}\n\n{body}\n"),
        }
    }

    /// Everything anyone actually reads is the first few lines: claude's TUI
    /// hides the rest behind "(N lines hidden)" and the Planning card clamps
    /// to 9em. So the manifest has to be in them — naming every source, in
    /// order, before a word of contract prose.
    #[test]
    fn the_brief_opens_with_a_manifest_of_what_is_being_combined() {
        let rows = vec![
            row("aaaaaaaa1111", "Auth rework", "x"),
            row("bbbbbbbb2222", "Billing migration", "y"),
        ];
        let head: String = compose(&rows, "prioritise auth")
            .brief
            .lines()
            .take(12)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(head.starts_with("# Combine 2 plans → one orchestration-ready plan"));
        assert!(head.contains("1. **Auth rework** — redline, v1, in_review"));
        assert!(head.contains("2. **Billing migration** — redline, v1, in_review"));
        // The human's own sentence is above the fold, not under the contract.
        assert!(head.contains("prioritise auth"));
        // And no contract prose has started yet.
        assert!(!head.contains("Do not execute anything"));
    }

    /// The manifest is where a run state becomes visible to the READER; the
    /// per-source header is where it becomes visible to the agent.
    #[test]
    fn the_manifest_marks_an_already_run_source() {
        let mut r = row("a", "Shipped", "x");
        r.run_state = Some("landed".into());
        let out = compose(&[r, row("b", "Other", "y")], "");
        assert!(out.brief.contains("1. **Shipped** — redline, v1, in_review, run: landed"));
    }

    #[test]
    fn compose_preserves_source_order_and_headers() {
        let rows = vec![
            row("aaaaaaaa1111", "Auth rework", "Do the auth."),
            row("bbbbbbbb2222", "Billing migration", "Do the billing."),
        ];
        let out = compose(&rows, "");
        let first = out.brief.find("Auth rework").unwrap();
        let second = out.brief.find("Billing migration").unwrap();
        assert!(first < second, "selection order is the brief's order");
        assert!(out.brief.contains("## Source 1 — Auth rework (redline, v1, in_review, run: none)"));
        assert!(out.brief.contains("## Source 2 — Billing migration"));
        // Both bodies ride along whole.
        assert!(out.brief.contains("Do the auth."));
        assert!(out.brief.contains("Do the billing."));
    }

    #[test]
    fn the_brief_carries_no_block_sidecars() {
        let mut r = row("aaaaaaaa1111", "Auth rework", "Body.");
        r.raw_plan_markdown =
            "<!-- rl:blk-abc123 -->\n# Auth rework\n\n<!-- rl:blk-def456 -->\nBody.\n".to_string();
        let out = compose(&[r], "");
        assert!(
            !out.brief.contains("rl:blk-"),
            "sidecars would collide with the ids the new session's ingest injects"
        );
        assert!(out.brief.contains("# Auth rework"));
        assert!(out.brief.contains("Body."));
    }

    #[test]
    fn the_instruction_heading_is_absent_when_the_instruction_is_empty() {
        let rows = vec![row("a", "One", "x"), row("b", "Two", "y")];
        assert!(!compose(&rows, "   ").brief.contains(INSTRUCTION_HEADING));
        assert!(compose(&rows, "prioritise auth").brief.contains(INSTRUCTION_HEADING));
    }

    /// The record is the ONLY thing that reaches the lake, and the typed
    /// context is the only human-authored text in the whole launch — so it has
    /// to survive byte-for-byte, including text that mimics the record's own
    /// structure. A pasted `## Sources` line must not be able to forge a
    /// provenance entry: the real one is the LAST such heading, and every
    /// entry under it is a `- title — session id vN — sha256:…` line this
    /// module wrote.
    #[test]
    fn the_typed_context_round_trips_byte_for_byte() {
        let typed = "prioritise the auth work — billing can lag a release.\n\
                     \n\
                     ## Sources\n\
                     - Not a real source — session deadbeef v9 — sha256:0000\n\
                     \n\
                     ...and keep telemetry off the middleware.";
        let rows = vec![row("aaaaaaaa1111", "Auth", "x"), row("bbbbbbbb2222", "Billing", "y")];
        let out = compose(&rows, typed);
        assert!(out.record.contains(typed), "verbatim, in full, unsummarised");

        // The provenance block is the one after the LAST `## Sources`.
        let idx = out.record.rfind(SOURCES_HEADING).unwrap();
        let provenance = &out.record[idx..];
        assert!(provenance.contains("- Auth — session aaaaaaaa v1 — sha256:"));
        assert!(provenance.contains("- Billing — session bbbbbbbb v1 — sha256:"));
        assert!(
            !provenance.contains("Not a real source"),
            "prose above the real heading cannot forge an entry"
        );
        assert_eq!(provenance.lines().filter(|l| l.starts_with("- ")).count(), 2);
    }

    #[test]
    fn the_record_hashes_the_stored_markdown_sidecars_included() {
        let mut r = row("aaaaaaaa1111", "Auth", "Body.");
        r.raw_plan_markdown = "<!-- rl:blk-abc123 -->\n# Auth\n\nBody.\n".to_string();
        let out = compose(&[r.clone()], "");
        // Verifiable against `revisions.raw_plan_markdown` as it sits on disk.
        let expected = &body_hash(&r.raw_plan_markdown)[..16];
        assert!(out.record.contains(expected));
        // NOT the stripped form the brief carries.
        let stripped_hash = &body_hash(&strip_sidecar_lines(&r.raw_plan_markdown))[..16];
        assert!(!out.record.contains(stripped_hash));
    }

    #[test]
    fn a_titleless_plan_still_names_itself() {
        let mut r = row("aaaaaaaa1111", "x", "y");
        r.raw_plan_markdown = "Just a body, no heading.\n".to_string();
        let out = compose(&[r], "");
        assert!(out.brief.contains("Untitled plan aaaaaaaa"));
        assert!(out.record.contains("Untitled plan aaaaaaaa"));
    }

    #[test]
    fn oversize_blocks_and_never_truncates() {
        let big = "x".repeat(MAX_COMBINE_BYTES);
        let rows = vec![row("a", "Huge one", &big), row("b", "Huge two", &big)];
        let p = preview(&rows);
        let blocked = p.blocked.expect("over the cap refuses");
        assert!(blocked.contains("Huge one") && blocked.contains("Huge two"), "names the plans");
        assert!(blocked.contains("KB"), "states the size");
        assert_eq!(p.sources.len(), 2, "the pills still render — this is a refusal, not a purge");
        // The composer itself never truncates; refusal is the preview's job.
        let out = compose(&rows, "");
        assert!(out.brief.len() > MAX_COMBINE_BYTES);
    }

    #[test]
    fn under_two_plans_is_not_a_combination() {
        assert!(preview(&[]).blocked.is_some());
        assert!(preview(&[row("a", "One", "x")]).blocked.is_some());
        assert!(preview(&[row("a", "One", "x"), row("b", "Two", "y")]).blocked.is_none());
    }

    #[test]
    fn default_project_is_the_most_common_tie_broken_by_first_selected() {
        let mut a = row("a", "A", "x");
        let mut b = row("b", "B", "y");
        let mut c = row("c", "C", "z");
        a.project_path = "/one".into();
        b.project_path = "/two".into();
        c.project_path = "/two".into();
        assert_eq!(preview(&[a.clone(), b.clone(), c]).default_project_path.as_deref(), Some("/two"));
        // A tie takes the first selected.
        assert_eq!(preview(&[a, b]).default_project_path.as_deref(), Some("/one"));
    }

    #[test]
    fn warnings_are_warnings_never_blocks() {
        let mut landed = row("a", "Shipped", "x");
        landed.run_state = Some("landed".into());
        let mut contested = row("b", "Argued", "y");
        contested.pending_count = 3;
        let mut elsewhere = row("c", "Other repo", "z");
        elsewhere.project_name = "qwallah".into();
        elsewhere.project_path = "/Users/me/qwallah".into();

        let p = preview(&[landed, contested, elsewhere]);
        assert!(p.blocked.is_none(), "none of these refuse a launch");
        let all = p.warnings.join("\n");
        assert!(all.contains("Already run"), "{all}");
        assert!(all.contains("Unresolved comments"), "{all}");
        assert!(all.contains("span 2 projects"), "{all}");
    }

    /// The per-source header is how the combining session learns a plan has
    /// already shipped — the warning is for the human, this is for the agent.
    #[test]
    fn the_run_state_rides_the_per_source_header() {
        let mut r = row("a", "Shipped", "x");
        r.run_state = Some("landed".into());
        let out = compose(&[r], "");
        assert!(out.brief.contains("run: landed"));
    }
}

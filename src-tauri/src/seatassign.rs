// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The Seat Assignment agent — reads how the user actually works and proposes
//! a whole Agent Seats chart (`seat.rs`) in one pass.
//!
//! Every seat starts at Default and stays there, because picking well means
//! knowing what `keeper` vs `classifier` vs `fork_drafter` do, how hard each
//! one's work is, and how much the user leans on it. Redline already records
//! all three. This module bakes that record into a **ground-truth digest**
//! (the `classmem` / `librarian` precedent), spawns one headless agent, and
//! parses a ranked set of picks the user reviews, edits and applies.
//!
//! Two shapes are borrowed deliberately, because neither alone is right:
//!
//! * *prompt + parse* from `librarian.rs` — the established structured-agent
//!   pattern, and the one that keeps the curl bridge so the agent can read the
//!   lake and ClassMemory for detail.
//! * *process lifecycle* from `ai_review.rs` — a stall ceiling and a cancel
//!   registry. The Librarian's bare drain loop has neither, so a wedged run
//!   would spin the modal until the app restarts. One agent writing thirteen
//!   seats needs the guardrail that a single hand-pick doesn't.
//!
//! Reach is deliberately `model` + `effort` + `fallback`. `binaryPath`,
//! `backend` and `extraFlags` stay the user's alone.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;

use crate::claude_proc::{classify_line, resolve_claude_bin, StreamLine};
use crate::db::{Database, SeatActivity};
use crate::ledger;
use crate::seat::{self, SeatConfig};

// ---------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------

/// Kill a run that has produced no output for this long. A **stall** ceiling,
/// not a wall clock — a legitimately slow run is never cut short. Mirrors
/// `ai_review::STALL_CEILING`.
const STALL_CEILING: Duration = Duration::from_secs(180);

/// A model probe that hasn't answered by now is treated as unverifiable.
const PREFLIGHT_CEILING: Duration = Duration::from_secs(20);

/// The activity window the digest reports alongside all-time totals.
pub const ACTIVITY_WINDOW_DAYS: i64 = 30;

/// Caps on the unbounded stats accessors this digest reuses — none of them
/// clamps itself, and `prompt_counts_by_day` returns one row per calendar day
/// of all history.
pub const MAX_DAY_ROWS: usize = 30;
pub const MAX_SURFACE_ROWS: usize = 12;
pub const MAX_KIND_ROWS: usize = 12;
pub const MAX_CLASS_ROWS: usize = 8;

/// Byte budget on the rendered digest block, mirroring `context.rs`'s
/// `MAX_CONTEXT_BYTES` discipline. A backstop: the caps above normally keep the
/// block an order of magnitude under this.
pub const MAX_SEAT_DIGEST_BYTES: usize = 24_000;

/// The model aliases `claude --help` documents. Aliases rather than pinned ids
/// on purpose: an alias resolves to the latest model of that tier, so a seat
/// chart built from them never goes stale.
pub const MODEL_ALIASES: &[&str] = &["fable", "opus", "sonnet", "haiku"];

/// What this seat runs on when the user hasn't configured it.
///
/// Every other seat inherits the CLI default, but this one is a **utility**:
/// ranking a prepared digest against a rubric. On an unconfigured seat that
/// meant the user's default (Opus, full thinking) chewing ~2 minutes of pure
/// latency on a 12KB prompt — measured at 0.1% CPU, i.e. all wait, no work.
/// A fast tier answers in seconds and the chart is no worse. Configuring the
/// `seatassign` seat overrides this, as with any seat.
const DEFAULT_MODEL: &str = "sonnet";
const DEFAULT_EFFORT: &str = "low";

/// The effort vocabulary `claude --help` documents. Verified empirically: an
/// out-of-vocabulary `--effort` does **not** fail the spawn — the CLI warns and
/// falls back to the default effort. So this list is a quality filter, not a
/// safety one, and validating it here is exact and free.
pub const EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

// ---------------------------------------------------------------------------
// The seat roster the agent reasons over
// ---------------------------------------------------------------------------

/// What one seat's work is actually like. The agent cannot infer this from the
/// seat name, and a wrong guess produces a confidently wrong rationale.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatFact {
    pub seat: &'static str,
    pub label: &'static str,
    /// One sentence on the work the seat does.
    pub role: &'static str,
    /// `interactive` / `background` / `latency_sensitive` / `long_context` /
    /// `write_capable`.
    pub traits: &'static [&'static str],
    /// A caveat the agent would otherwise get wrong. Rendered verbatim.
    pub note: Option<&'static str>,
}

/// Every seat in `seat::KNOWN_SEATS`, described. A test asserts the two lists
/// agree exactly, so adding a seat without describing it fails the build.
pub const SEAT_FACTS: &[SeatFact] = &[
    SeatFact {
        seat: "companion",
        label: "Companion",
        role: "One continuous discussion that follows the user across every surface, \
               glancing at other agents' context and consulting them; the widest \
               synthesis job in the app.",
        traits: &["interactive", "long_context", "write_capable"],
        note: None,
    },
    SeatFact {
        seat: "browse",
        label: "Browser page discussions",
        role: "Per-tab agent that answers about the open page and drives the live tab \
               through the curl bridge; the user is watching it type.",
        traits: &["interactive", "latency_sensitive"],
        note: None,
    },
    SeatFact {
        seat: "linked",
        label: "Linked discussion",
        role: "One conversation spanning all browser tabs, folding per-tab digests \
               together; broader than a page discussion, narrower than the Companion.",
        traits: &["interactive", "long_context"],
        note: None,
    },
    SeatFact {
        seat: "mission",
        label: "Missions",
        role: "Research orchestrator holding one goal across tabs and pins, finishing \
               with a synthesized brief; sustained multi-step reasoning.",
        traits: &["interactive", "long_context"],
        note: None,
    },
    SeatFact {
        seat: "voice",
        label: "Voice agent",
        role: "Reads and discusses the plan aloud, including realtime conversation \
               mode; the user is waiting on speech, so latency dominates.",
        traits: &["interactive", "latency_sensitive"],
        note: Some(
            "This seat does NOT cover voice transcript cleanup — that path hardcodes \
             haiku and is deliberately not seat-configurable (a utility, not a seat). \
             Do not justify this seat by transcript work.",
        ),
    },
    SeatFact {
        seat: "drafter",
        label: "Drafter discussion",
        role: "Prompt-crafting collaborator on a Drafter document; re-reads the live \
               draft and writes tracked suggestions into it.",
        traits: &["interactive", "write_capable"],
        note: None,
    },
    SeatFact {
        seat: "memory",
        label: "Memory Ask",
        role: "The Memory surface's Ask agent: answers \"what did I decide / \
               research about X\" by walking the ClassMemory catalog and the \
               lake through the local read routes, citing ledger seqs the \
               Timeline jumps to. Retrieval-heavy multi-step reasoning, and a \
               wrong or uncited answer misrepresents the user's own record.",
        traits: &["interactive", "long_context"],
        note: None,
    },
    SeatFact {
        seat: "keeper",
        label: "Keeper",
        role: "Background compaction: summarizes cold prompt bodies into gists on an \
               idle timer. Nobody is waiting, and a deterministic fallback covers it \
               if the agent is unavailable.",
        traits: &["background"],
        note: Some(
            "Redline does not record keeper runs individually, so its activity always \
             reads zero. Do NOT read that as 'never runs' — judge this seat from its \
             role alone.",
        ),
    },
    SeatFact {
        seat: "classifier",
        label: "ClassMemory classifier",
        role: "Organizes the lake into the emergent class catalog — judgment-heavy \
               taxonomy work (promote / split / merge / collapse) over a large baked \
               corpus, run unattended.",
        traits: &["background", "long_context"],
        note: None,
    },
    SeatFact {
        seat: "librarian",
        label: "Librarian",
        role: "On-demand friction digest: ranks a prepared list of workspace signals \
               into a next-actions checklist. Short, structured, mostly ranking.",
        traits: &["background"],
        note: Some("Has no UI trigger in this build, so its activity is legitimately zero."),
    },
    SeatFact {
        seat: "shipwright",
        label: "Shipwright",
        role: "On-demand code-health agent for Redline's own repo: reads a \
               ground-truth digest, reads the code behind a signal, and returns at \
               most five findings. Reasoning-heavy and rarely run, and its output \
               costs the user attention to review.",
        traits: &["background", "long_context"],
        note: Some(
            "Runs a handful of times a week at most, so cost per run matters far \
             less than the quality of five findings a human then reads.",
        ),
    },
    SeatFact {
        seat: "seatassign",
        label: "Seat Assignment",
        role: "This agent — reads the usage digest and proposes the seat chart.",
        traits: &["background", "long_context"],
        note: Some(
            "You MAY propose a config for your own seat. It is harmless: a change \
             takes effect on the NEXT run, never mid-flight. Say so in the rationale.",
        ),
    },
    SeatFact {
        seat: "ai_review",
        label: "AI code review",
        role: "Reads a whole diff and emits schema-constrained findings; long input, \
               high precision, and a wrong call costs the user real time.",
        traits: &["background", "long_context"],
        note: None,
    },
    SeatFact {
        seat: "ai_commit",
        label: "Commit drafter",
        role: "Drafts a commit message, branch name and PR description from the \
               review diff for the push dialog; the user edits the result, so a \
               fast good-enough draft beats a slow perfect one.",
        traits: &["interactive", "latency_sensitive"],
        note: None,
    },
    SeatFact {
        seat: "orchestrator",
        label: "Plan orchestrator",
        role: "Visible terminal session that executes an approved plan as a \
               multi-agent workflow. Every workflow subagent inherits the session \
               model, so this pick multiplies across the whole fan-out (up to 16 \
               concurrent agents).",
        traits: &["interactive", "long_context"],
        note: Some(
            "Left unset this seat spawns with `--model sonnet` (never the bare CLI \
             default) — a big model here multiplies across every concurrent \
             subagent. Say so in the rationale if you propose raising it.",
        ),
    },
    SeatFact {
        seat: "fork_plan",
        label: "Plan sidecar threads",
        role: "Read-only fork answering one reviewer comment on a plan section. \
               Narrow, scoped, and the reviewer is waiting on it.",
        traits: &["interactive", "latency_sensitive"],
        note: None,
    },
    SeatFact {
        seat: "fork_review",
        label: "Code-review threads",
        role: "Read-only fork answering one question about a diff hunk. Narrow and \
               scoped, like a plan sidecar.",
        traits: &["interactive", "latency_sensitive"],
        note: None,
    },
    SeatFact {
        seat: "fork_drafter",
        label: "Drafter comment threads",
        role: "Read-only fork answering one comment on a Drafter document.",
        traits: &["interactive", "latency_sensitive"],
        note: Some("Inherits the `drafter` seat when left unset, so leaving it Default is often right."),
    },
];

/// Extra guidance written for the **human** reading the settings tooltip, as
/// opposed to `SeatFact::note`, which is written for the agent and often says
/// things like "do not infer X from this number". Kept as a side table so the
/// two audiences can't bleed into each other, and so `SEAT_FACTS` stays the one
/// description of what each seat actually does.
const SEAT_HINTS: &[(&str, &str)] = &[
    (
        "voice",
        "Doesn't cover voice transcript cleanup — that runs on a fixed fast model \
         and isn't configurable.",
    ),
    (
        "keeper",
        "Runs unattended on an idle timer. If the agent is unavailable a plain \
         text-truncation fallback covers it, so nothing breaks.",
    ),
    (
        "librarian",
        "Has no button in this build, so it never runs today — leaving it on \
         Default costs nothing.",
    ),
    (
        "seatassign",
        "This agent. Left on Default it runs on a fast tier; a change here takes \
         effect on its next run.",
    ),
    (
        "orchestrator",
        "The Orchestrate terminal session. Left on Default it launches with \
         sonnet — every workflow subagent inherits this model, so the cost \
         multiplies across the fan-out.",
    ),
    (
        "fork_plan",
        "On Inherit it runs exactly like the plan review it forked from.",
    ),
    (
        "fork_review",
        "On Inherit it runs exactly like the code review it forked from.",
    ),
    (
        "fork_drafter",
        "On Inherit it follows the Drafter discussion seat above — usually the \
         right choice.",
    ),
];

/// One seat described for the settings UI: what it does, how it behaves, and
/// any human-facing caveat. Serialized into `AgentSeatsView` so the tooltip and
/// the agent's own digest can never drift apart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatBlurb {
    pub seat: String,
    pub label: String,
    pub role: String,
    pub traits: Vec<String>,
    pub hint: Option<String>,
}

/// Every seat, described for the GUI.
pub fn seat_blurbs() -> Vec<SeatBlurb> {
    SEAT_FACTS
        .iter()
        .map(|f| SeatBlurb {
            seat: f.seat.to_string(),
            label: f.label.to_string(),
            role: f.role.to_string(),
            traits: f.traits.iter().map(|t| (*t).to_string()).collect(),
            hint: SEAT_HINTS
                .iter()
                .find(|(seat, _)| *seat == f.seat)
                .map(|(_, hint)| (*hint).to_string()),
        })
        .collect()
}

/// Look one seat's facts up by name. `build_seat_digest` walks `SEAT_FACTS`
/// directly, so this only serves the coverage/rendering tests.
#[cfg(test)]
fn seat_fact(seat: &str) -> Option<&'static SeatFact> {
    SEAT_FACTS.iter().find(|f| f.seat == seat)
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/// One proposed seat configuration.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatPick {
    /// Must be in `seat::KNOWN_SEATS` or the pick is dropped.
    pub seat: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    /// Required — a pick with no reasoning is noise the user can't audit.
    #[serde(default)]
    pub rationale: String,
    /// Departs from the user's stated posture.
    #[serde(default)]
    pub deviates: bool,
}

/// The agent's whole output.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatAssignment {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub picks: Vec<SeatPick>,
    /// Set only when the reply carried no usable JSON at all. Without it a
    /// contract-breaking reply is indistinguishable from the button doing
    /// nothing — the user (and the log) get the agent's actual words instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
}

/// One model-id probe result (§2c).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCheck {
    pub model: String,
    pub ok: bool,
    /// The CLI's own complaint when `ok` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// The ground-truth digest
// ---------------------------------------------------------------------------

/// One seat's row in the digest: what it does, what it runs on now, how much
/// the user actually uses it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatRow {
    pub seat: String,
    pub label: String,
    pub role: String,
    pub traits: Vec<String>,
    pub note: Option<String>,
    pub current: SeatConfig,
    pub activity: SeatActivity,
}

/// Everything the agent is handed as fact.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatDigest {
    pub window_days: i64,
    pub seats: Vec<SeatRow>,
    /// `(surface, prompts, median_bytes, p90_bytes)`, heaviest first.
    pub surfaces: Vec<(String, i64, i64, i64)>,
    pub event_kinds: Vec<(String, i64)>,
    pub class_roots: Vec<(String, i64)>,
    pub total_events: i64,
    pub backlog: i64,
    /// Prompt volume across the most recent `MAX_DAY_ROWS` active days.
    pub recent_prompts: i64,
    pub active_days: i64,
    pub busiest_day: Option<(String, i64)>,
    /// Custom (non-alias) model ids the user already runs somewhere — the only
    /// ids the agent may reuse.
    pub custom_models_in_use: Vec<String>,
}

/// Build the digest. Best-effort per signal, exactly as `context::build_digest`
/// is: a table this build doesn't have yields zero, never a failed digest.
pub fn build_seat_digest(db: &Database) -> SeatDigest {
    let now = ledger::now_millis();
    let since = now - ACTIVITY_WINDOW_DAYS * 86_400_000;

    let configured = seat::all_seats();
    let activity = db.seat_activity(since);
    let zero = |seat: &str| SeatActivity {
        seat: seat.to_string(),
        turns_window: 0,
        turns_total: 0,
        last_ts: None,
    };

    let seats: Vec<SeatRow> = SEAT_FACTS
        .iter()
        .map(|f| SeatRow {
            seat: f.seat.to_string(),
            label: f.label.to_string(),
            role: f.role.to_string(),
            traits: f.traits.iter().map(|t| (*t).to_string()).collect(),
            note: f.note.map(str::to_string),
            current: configured.get(f.seat).cloned().unwrap_or_default(),
            activity: activity
                .iter()
                .find(|a| a.seat == f.seat)
                .cloned()
                .unwrap_or_else(|| zero(f.seat)),
        })
        .collect();

    let mut surfaces = db.prompt_length_by_surface().unwrap_or_default();
    surfaces.truncate(MAX_SURFACE_ROWS);

    let mut event_kinds = db.event_counts_by_kind().unwrap_or_default();
    event_kinds.truncate(MAX_KIND_ROWS);

    let mut class_roots = db.class_link_counts_by_root().unwrap_or_default();
    class_roots.truncate(MAX_CLASS_ROWS);

    // Day histogram: read bounded, then summarize. Thirty rows of dates teach
    // the agent nothing that three numbers don't.
    let days = db.prompt_counts_by_day().unwrap_or_default();
    let recent: Vec<(String, i64)> = days
        .iter()
        .rev()
        .take(MAX_DAY_ROWS)
        .cloned()
        .collect::<Vec<_>>();
    let recent_prompts = recent.iter().map(|(_, c)| *c).sum();
    let active_days = recent.len() as i64;
    let busiest_day = recent.iter().max_by_key(|(_, c)| *c).cloned();

    // Non-alias ids already in play are evidence of a deliberate choice, so the
    // agent may reuse them; nothing else off-menu is allowed.
    let mut custom_models_in_use: Vec<String> = configured
        .values()
        .filter_map(|c| c.model.as_deref().map(str::trim).filter(|m| !m.is_empty()))
        .filter(|m| !MODEL_ALIASES.contains(m))
        .map(str::to_string)
        .collect();
    custom_models_in_use.sort();
    custom_models_in_use.dedup();

    let total_events = db.max_ledger_seq().unwrap_or(0);
    let backlog = (total_events - db.last_run_seq_to().unwrap_or(0)).max(0);

    SeatDigest {
        window_days: ACTIVITY_WINDOW_DAYS,
        seats,
        surfaces,
        event_kinds,
        class_roots,
        total_events,
        backlog,
        recent_prompts,
        active_days,
        busiest_day,
        custom_models_in_use,
    }
}

fn ago(now: i64, then: Option<i64>) -> String {
    match then {
        None => "never".to_string(),
        Some(ts) => {
            let days = ((now - ts).max(0)) / 86_400_000;
            if days == 0 {
                "today".to_string()
            } else {
                format!("{days}d ago")
            }
        }
    }
}

fn describe_config(c: &SeatConfig) -> String {
    let mut bits: Vec<String> = Vec::new();
    if let Some(m) = c.model.as_deref().filter(|s| !s.trim().is_empty()) {
        bits.push(format!("model={m}"));
    }
    if let Some(e) = c.effort.as_deref().filter(|s| !s.trim().is_empty()) {
        bits.push(format!("effort={e}"));
    }
    if let Some(f) = c.fallback.as_deref().filter(|s| !s.trim().is_empty()) {
        bits.push(format!("fallback={f}"));
    }
    if bits.is_empty() {
        "Default (inherits the CLI default — no flags)".to_string()
    } else {
        bits.join(" ")
    }
}

/// Render the digest as a ground-truth markdown block, bounded by
/// `MAX_SEAT_DIGEST_BYTES`. Sections are emitted most-load-bearing first and
/// dropped from the tail if the budget runs out, with an explicit marker so the
/// agent knows it isn't seeing everything.
pub fn render_seat_digest_block(d: &SeatDigest) -> String {
    let now = ledger::now_millis();
    let mut sections: Vec<String> = Vec::new();

    // 1. The seat roster — without this the agent has nothing to reason about.
    let mut s = String::from(
        "### The seats (role · traits · current config · observed use)\n\n\
         `turns` counts agent turns this seat produced; `window` is the last \
         30 days. A seat that never runs should usually stay at Default.\n\n",
    );
    for row in &d.seats {
        s.push_str(&format!(
            "- **{}** (`{}`) — {}\n  - traits: {}\n  - current: {}\n  - turns: {} in window, {} all-time, last {}\n",
            row.label,
            row.seat,
            row.role,
            row.traits.join(", "),
            describe_config(&row.current),
            row.activity.turns_window,
            row.activity.turns_total,
            ago(now, row.activity.last_ts),
        ));
        if let Some(note) = &row.note {
            s.push_str(&format!("  - NOTE: {note}\n"));
        }
    }
    s.push('\n');
    sections.push(s);

    // 2. Where the user's thinking actually happens.
    let mut s = String::from(
        "### Prompt workload by surface (volume + how heavy the prompts are)\n\n\
         Body length is a proxy for how hard the thinking is on that surface.\n\n",
    );
    if d.surfaces.is_empty() {
        s.push_str("- (no prompts captured yet — lean on the seat roles instead)\n");
    } else {
        for (surface, count, median, p90) in &d.surfaces {
            s.push_str(&format!(
                "- {surface}: {count} prompt(s), median {median}B, p90 {p90}B\n"
            ));
        }
    }
    s.push('\n');
    sections.push(s);

    // 3. Recent volume + lake size.
    let busiest = d
        .busiest_day
        .as_ref()
        .map(|(day, c)| format!("{day} ({c})"))
        .unwrap_or_else(|| "-".to_string());
    sections.push(format!(
        "### Recent activity\n\n- prompts across the most recent {} active day(s): {}\n\
         - busiest day: {}\n- total ledger events: {} (unstructured backlog: {})\n\n",
        d.active_days, d.recent_prompts, busiest, d.total_events, d.backlog
    ));

    // 4. Available vocabulary.
    let mut s = format!(
        "### The menu you may pick from\n\n- models (aliases only): {}\n- effort: {}\n",
        MODEL_ALIASES.join(", "),
        EFFORT_LEVELS.join(", ")
    );
    if d.custom_models_in_use.is_empty() {
        s.push_str(
            "- no custom model ids configured — propose aliases only, never a pinned id\n\n",
        );
    } else {
        s.push_str(&format!(
            "- custom ids the user already runs (you MAY reuse these exact strings): {}\n\n",
            d.custom_models_in_use.join(", ")
        ));
    }
    sections.push(s);

    // 5. Softer context, first to be dropped under budget.
    let mut s = String::from("### Lake shape\n\n");
    if d.event_kinds.is_empty() {
        s.push_str("- (no ledger events yet)\n");
    } else {
        for (kind, count) in &d.event_kinds {
            s.push_str(&format!("- {kind}: {count}\n"));
        }
    }
    if !d.class_roots.is_empty() {
        s.push_str("\nClass roots by linked items:\n");
        for (title, count) in &d.class_roots {
            s.push_str(&format!("- {title}: {count}\n"));
        }
    }
    s.push('\n');
    sections.push(s);

    let mut out = String::from(
        "## Usage digest (GROUND TRUTH — do not re-derive these numbers)\n\n",
    );
    let mut dropped = false;
    for section in sections {
        if out.len() + section.len() > MAX_SEAT_DIGEST_BYTES {
            dropped = true;
            break;
        }
        out.push_str(&section);
    }
    if dropped {
        out.push_str("\n[…digest truncated to fit the budget; some sections omitted]\n\n");
    }
    out
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/// The three discretion bands. Pure so the frontend caption and the prompt
/// rubric can't drift.
pub fn discretion_band(discretion: i64) -> (&'static str, &'static str) {
    match discretion.clamp(0, 100) {
        0..=20 => (
            "Follows your posture",
            "Honour the stated posture literally. If the evidence contradicts it, say so \
             in `summary` — but still follow the posture. `deviates` must be false on \
             every pick.",
        ),
        21..=60 => (
            "Deviates only with reason",
            "The stated posture is the default. You may deviate on at most a few seats \
             where the evidence is strong; set `deviates: true` on each and justify it \
             in one sentence.",
        ),
        _ => (
            "Uses its own judgment",
            "The stated posture is a hint. Your own read of the evidence governs. Still \
             mark every departure with `deviates: true` and justify it.",
        ),
    }
}

fn posture_line(posture: &str) -> &'static str {
    match posture.trim() {
        "cost" => "COST-CONSCIOUS — prefer the cheapest seat that can do the job well; \
                   reserve premium models for the few seats that genuinely need them.",
        "quality" => "MAX QUALITY — prefer capability over cost; spend freely where it \
                      buys better output, but still leave near-idle seats at Default.",
        _ => "BALANCED — spend where the work is hard or the user leans on it, save where \
              it is mechanical, background, or rarely used.",
    }
}

/// Build the agent's first-turn prompt: the role, the ground-truth digest, the
/// posture + discretion rubric, and the JSON contract. Pure / testable.
pub fn build_seat_prompt(digest_block: &str, posture: &str, discretion: i64) -> String {
    let (band_label, band_rule) = discretion_band(discretion);
    let mut p = String::new();
    p.push_str(
        "You are Redline's Seat Assignment agent. Redline spawns a dozen different \
         headless agents, each at a named \"seat\", and each seat can run a different \
         model and effort level. Your job is to read how this user actually works and \
         propose the whole seat chart in one pass. Load your `seat-assignment` skill \
         for the full contract (the model-tier rubric and the JSON output shape).\n\n\
         The user reviews, edits and applies your picks — nothing you emit is applied \
         automatically. So be opinionated, but make every rationale auditable: cite a \
         number from the digest.\n\n\
         Below is a usage digest computed as GROUND TRUTH from Redline's own database. \
         Treat every number as fact; do not re-derive it. You MAY read the local bridge \
         for detail (already permitted, read-only curl, no approval): \
         `curl -s http://127.0.0.1:7676/v1/context/stats`, `/v1/context/prompts`, \
         `/v1/memory/tree`, `/v1/context/overview` — but the digest is usually enough.\n\n",
    );
    p.push_str(digest_block);
    p.push_str(&format!(
        "## The user's posture\n\n{}\n\n## Your discretion: {} / 100 — \"{}\"\n\n{}\n\n",
        posture_line(posture),
        discretion.clamp(0, 100),
        band_label,
        band_rule
    ));
    p.push_str(
        "## Your task\n\nPropose a seat chart. Rules that matter:\n\n\
         - **Emit a pick only where you would change something.** A seat that is already \
           right, or that barely runs, should not appear at all. A short chart is a good \
           chart.\n\
         - **Propose aliases, not pinned model ids** — an alias tracks the latest model \
           of its tier, a pinned id silently ages. The only exception is a custom id the \
           digest says the user already runs.\n\
         - **Prefer a (model, effort) pair another seat already uses** when two choices \
           are equally defensible. It costs nothing and keeps the chart coherent.\n\
         - **Omit a field to leave it at Default.** Omitting `effort` is normal.\n\
         - Every pick needs a one-sentence `rationale` citing a digest number.\n\n\
         Return ONLY a JSON object (optionally in a ```json fence):\n\n\
         {\"summary\":\"<one-line read of how this user works>\",\"picks\":[\n  \
         {\"seat\":\"<seat name>\",\"model\":\"<alias>\",\"effort\":\"<low|medium|high|xhigh|max, or omit>\",\"fallback\":\"<alias or omit>\",\"rationale\":\"<one sentence citing a number>\",\"deviates\":false}\n]}\n",
    );
    p
}

/// Convenience: build the prompt straight from a digest.
pub fn build_seat_prompt_from_digest(d: &SeatDigest, posture: &str, discretion: i64) -> String {
    build_seat_prompt(&render_seat_digest_block(d), posture, discretion)
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/// Parse the agent's final message into a `SeatAssignment`. Tolerant like
/// `librarian::parse_checklist`: finds the first balanced `{…}` that parses and
/// carries a `picks` array, drops malformed picks, and normalizes the rest.
///
/// `known_models` is the alias set plus any custom ids already configured — an
/// off-menu model is dropped (the seat falls back to Default) rather than
/// written, since a bad model id is the one thing that genuinely breaks a seat.
pub fn parse_assignment(text: &str, known_models: &[String]) -> SeatAssignment {
    let Some(obj) = extract_picks_object(text) else {
        // No JSON object with a `picks` key anywhere in the reply.
        return SeatAssignment {
            raw: Some(truncate_reply(text)),
            ..SeatAssignment::default()
        };
    };
    let summary = obj
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut picks: Vec<SeatPick> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if let Some(arr) = obj.get("picks").and_then(Value::as_array) {
        for v in arr {
            if let Some(pick) = parse_pick(v, known_models) {
                // One pick per seat; a repeat is a model slip, keep the first.
                if seen.contains(&pick.seat) {
                    continue;
                }
                seen.push(pick.seat.clone());
                picks.push(pick);
            }
        }
    }
    // Parsed, but empty on both axes — still a dead end for the user, so hand
    // back what the agent actually said.
    let raw = (summary.is_empty() && picks.is_empty()).then(|| truncate_reply(text));
    SeatAssignment {
        summary,
        picks,
        raw,
    }
}

/// Record the last run's outcome to `~/.redline/seatassign-last.log`.
///
/// This agent's failure modes are all invisible from the GUI — a reply that
/// breaks the JSON contract, a slow model, a spawn that dies — and `tauri dev`
/// stderr is not something a user can be asked to read back. One overwritten
/// file makes every run diagnosable after the fact. Best-effort: a logging
/// failure must never affect the run.
pub fn log_run(body: &str) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = std::path::Path::new(&home).join(".redline");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("seatassign-last.log"), body);
}

/// A bounded, character-safe excerpt of a reply for the failure surface.
fn truncate_reply(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "(the agent returned an empty reply)".to_string();
    }
    let excerpt: String = trimmed.chars().take(600).collect();
    if trimmed.chars().count() > 600 {
        format!("{excerpt}…")
    } else {
        excerpt
    }
}

fn clean(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_pick(v: &Value, known_models: &[String]) -> Option<SeatPick> {
    // An unknown seat can't be written at all (`seat::set_seat` would reject
    // it), so drop it here rather than surface a row that can't apply.
    let seat = clean(v, "seat").filter(|s| seat::KNOWN_SEATS.contains(&s.as_str()))?;
    // A pick with no reasoning is noise the user can't audit.
    let rationale = clean(v, "rationale")?;

    let known = |m: &String| known_models.iter().any(|k| k == m);
    // Off-menu model → drop the field, keep the pick. One bad field degrades to
    // Default rather than discarding a sound rationale.
    let model = clean(v, "model").filter(known);
    let fallback = clean(v, "fallback").filter(known);
    let effort = clean(v, "effort")
        .map(|e| e.to_lowercase())
        .filter(|e| EFFORT_LEVELS.contains(&e.as_str()));

    // An all-Default pick would write nothing — drop it as a no-op.
    if model.is_none() && effort.is_none() && fallback.is_none() {
        return None;
    }

    Some(SeatPick {
        seat,
        model,
        effort,
        fallback,
        rationale,
        deviates: v
            .get("deviates")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// First top-level `{…}` substring that parses as JSON and carries a `picks`
/// key. Mirrors `librarian`'s extractor (kept local so the modules stay
/// decoupled).
fn extract_picks_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = matching_brace(bytes, i) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    if v.get("picks").is_some() {
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

/// Fold a pick into a seat's existing config.
///
/// `model` / `effort` / `fallback` are replaced wholesale — the card shows the
/// resulting state, so applying a row that shows no effort must *clear* any
/// effort already there, not silently keep it. Everything the agent may not
/// touch (`backend`, `binaryPath`, `extraFlags`) is carried through untouched.
pub fn merge_pick(current: &SeatConfig, pick: &SeatPick) -> SeatConfig {
    SeatConfig {
        model: pick.model.clone(),
        effort: pick.effort.clone(),
        fallback: pick.fallback.clone(),
        backend: current.backend.clone(),
        binary_path: current.binary_path.clone(),
        extra_flags: current.extra_flags.clone(),
        // Roster metadata (P3) is the user's, not the pick agent's.
        charter: current.charter.clone(),
        trigger: current.trigger.clone(),
    }
}

/// The model strings a pick may legally carry: the documented aliases plus any
/// custom id the user already runs somewhere.
pub fn known_models(d: &SeatDigest) -> Vec<String> {
    let mut out: Vec<String> = MODEL_ALIASES.iter().map(|m| (*m).to_string()).collect();
    out.extend(d.custom_models_in_use.iter().cloned());
    out
}

// ---------------------------------------------------------------------------
// Spawn + drive (ai_review lifecycle over the librarian arg surface)
// ---------------------------------------------------------------------------

/// Single-run process registry, the one-at-a-time analogue of
/// `ai_review::AiReviewState.procs`. Cancel and the stall watchdog both work by
/// removing the child from here, which is also how the reader distinguishes
/// *cancelled* from *stalled*.
/// The slot is keyed by a per-run id, not just occupancy. Cancel empties the
/// slot immediately while the cancelled task is still draining its pipes, so an
/// unkeyed slot lets that task reclaim — and then wait on — the *next* run's
/// child, which would report the fresh run as cancelled. The id makes every
/// take unambiguous.
#[derive(Default)]
pub struct SeatAssignState {
    proc: Arc<Mutex<Option<(u64, Child)>>>,
    next_id: AtomicU64,
    /// Runs with `id < cancel_after` have been cancelled. Needed because the
    /// slot is empty from the moment a run begins until its child is
    /// registered, and resolving the `claude` binary in between can take
    /// seconds (the fallback shells out to `$SHELL -ilc`). Without this, a
    /// Cancel inside that window silently did nothing and the run completed.
    cancel_after: AtomicU64,
    /// Held for a whole run — including the pre-spawn window — so a second Run
    /// can't start while one is still settling.
    busy: Arc<AtomicBool>,
}

/// Clears `busy` however the run ends: early `?`, cancel, stall, or success.
struct RunGuard(Arc<AtomicBool>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl SeatAssignState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Observability for the tests only — production code learns the same
    /// thing from `begin()` returning `None`, atomically.
    #[cfg(test)]
    fn is_running(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// Claim the single run slot. `None` when one is already in flight.
    fn begin(&self) -> Option<(u64, RunGuard)> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        Some((id, RunGuard(self.busy.clone())))
    }

    /// Park the child in the slot. Returns `false` when the run was cancelled
    /// during the pre-spawn window — the child is killed before it can do any
    /// work, and the caller reports the run as cancelled.
    fn register(&self, id: u64, mut child: Child) -> bool {
        let mut slot = self.proc.lock().unwrap();
        if id < self.cancel_after.load(Ordering::Acquire) {
            let _ = child.start_kill();
            return false;
        }
        *slot = Some((id, child));
        true
    }

    /// Take the child back only if the slot still holds *this* run.
    fn take_if(&self, id: u64) -> Option<Child> {
        let mut slot = self.proc.lock().unwrap();
        match slot.as_ref() {
            Some((held, _)) if *held == id => slot.take().map(|(_, c)| c),
            _ => None,
        }
    }

    /// Kill the in-flight run, if any. Idempotent.
    ///
    /// Also marks every run begun so far as cancelled, so a run still resolving
    /// its binary (before it has a child to kill) is stopped the moment it
    /// tries to register.
    pub fn cancel(&self) {
        self.cancel_after
            .store(self.next_id.load(Ordering::Relaxed), Ordering::Release);
        if let Some((_, mut child)) = self.proc.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// The argv a Seat Assignment spawn builds — pure, exposed so the resume-arg
/// construction is testable without spawning anything. The fast utility
/// default only applies when the user has configured nothing for the seat,
/// and the resume tail stays terminal (the convention `bridge_args` keeps).
pub fn assigner_argv(prompt: String, prior: Option<&str>) -> Vec<String> {
    let mut args = crate::claude_proc::bridge_args("seatassign", prompt, None);
    if seat::flag_args("seatassign").is_empty() {
        args.extend([
            "--model".to_string(),
            DEFAULT_MODEL.to_string(),
            "--effort".to_string(),
            DEFAULT_EFFORT.to_string(),
        ]);
    }
    if let Some(sid) = prior {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    args
}

/// Run the Seat Assignment agent with its standing thread (P3 continuity):
/// resume the persisted `redline.seatThread.seatassign` session so this run
/// remembers the charts it proposed before, persist the new session id on
/// success, and fall back to a fresh session (overwriting the stored id) if
/// the resume fails. A user cancel or a stall never auto-retries.
pub async fn run_seat_assigner(
    state: &SeatAssignState,
    cwd: &str,
    prompt: String,
) -> Result<String, String> {
    let (text, _sid) = crate::seat::run_with_thread("seatassign", None, |prior| {
        run_seat_assigner_once(state, cwd, prompt.clone(), prior)
    })
    .await?;
    Ok(text)
}

/// One Seat Assignment attempt, headless to completion; returns the final
/// text + session id. Registers the prompt with the agent-prompt guard first
/// so the headless `-p` doesn't leak into the lake via the global
/// `UserPromptSubmit` hook.
async fn run_seat_assigner_once(
    state: &SeatAssignState,
    cwd: &str,
    prompt: String,
    prior: Option<String>,
) -> Result<(String, Option<String>), String> {
    // The guard holds the single run slot for the WHOLE run, including the
    // pre-spawn window below, and clears it on every exit path.
    let Some((run_id, _guard)) = state.begin() else {
        return Err("a seat assignment is already running".to_string());
    };
    let claude_bin = tokio::task::spawn_blocking(resolve_claude_bin)
        .await
        .map_err(|e| e.to_string())?;
    ledger::register_agent_prompt(&ledger::body_hash(&prompt));
    let args = assigner_argv(prompt, prior.as_deref());
    let mut cmd = crate::claude_proc::claude_command_for_seat("seatassign", &claude_bin);
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
                format!("failed to spawn the Seat Assignment agent: {e}")
            }
        })?;
    let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("agent stderr unavailable")?;
    if !state.register(run_id, child) {
        // Cancelled while we were resolving the binary / spawning.
        return Err("cancelled".to_string());
    }

    let started = Instant::now();
    let last_activity = Arc::new(AtomicU64::new(0));

    let stdout_fut = {
        let last_activity = last_activity.clone();
        async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut final_text: Option<String> = None;
            let mut errored: Option<String> = None;
            let mut session: Option<String> = None;
            while let Ok(Some(line)) = reader.next_line().await {
                last_activity.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
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
            (final_text, errored, session)
        }
    };
    let stderr_fut = async {
        let mut errbuf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if errbuf.len() < 2000 {
                errbuf.push_str(&l);
                errbuf.push('\n');
            }
        }
        errbuf
    };
    let read_fut = async { tokio::join!(stdout_fut, stderr_fut) };
    tokio::pin!(read_fut);

    let mut stalled = false;
    let ((final_text, errored, session), errbuf) = loop {
        tokio::select! {
            res = &mut read_fut => break res,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                let last = last_activity.load(Ordering::Relaxed);
                let silent = started.elapsed().saturating_sub(Duration::from_millis(last));
                if !stalled && silent >= STALL_CEILING {
                    // Removing the child here is also what tells the reader
                    // below this was a stall, not a user cancel.
                    if let Some(mut c) = state.take_if(run_id) {
                        let _ = c.start_kill();
                    }
                    stalled = true;
                }
            }
        }
    };

    // An empty slot (or one already claimed by a newer run) means Cancel — or
    // the stall path above — took our child.
    let proc = state.take_if(run_id);
    let cancelled = proc.is_none() && !stalled;
    if let Some(mut c) = proc {
        let _ = c.wait().await;
    }

    if cancelled {
        return Err("cancelled".to_string());
    }
    if stalled {
        return Err(format!(
            "the Seat Assignment agent produced no output for {}s and was stopped",
            STALL_CEILING.as_secs()
        ));
    }
    if let Some(msg) = errored {
        return Err(msg);
    }
    match final_text {
        Some(t) => Ok((t, session)),
        None => Err(if errbuf.trim().is_empty() {
            "the Seat Assignment agent produced no output".to_string()
        } else {
            format!("the Seat Assignment agent failed: {}", errbuf.trim())
        }),
    }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/// Models that need no probe: the documented aliases always resolve.
pub fn needs_preflight(model: &str) -> bool {
    let m = model.trim();
    !m.is_empty() && !MODEL_ALIASES.contains(&m)
}

/// Probe one model id by starting a throwaway turn.
///
/// Empirically (verified against the installed CLI): a bad `--model` exits
/// non-zero *before* any inference with a one-line complaint, while a bad
/// `--effort` only warns and falls back to the default. So the model is the
/// only field worth probing — and only when it isn't one of the aliases, which
/// makes the common case zero spawns.
pub async fn preflight_model(model: &str) -> ModelCheck {
    let name = model.trim().to_string();
    if !needs_preflight(&name) {
        return ModelCheck {
            model: name,
            ok: true,
            error: None,
        };
    }
    let claude_bin = match tokio::task::spawn_blocking(resolve_claude_bin).await {
        Ok(b) => b,
        Err(e) => {
            return ModelCheck {
                model: name,
                ok: false,
                error: Some(e.to_string()),
            }
        }
    };
    let mut cmd = crate::claude_proc::claude_command_for_seat("seatassign", &claude_bin);
    let child = cmd
        .args([
            "-p",
            "Reply with the single word: ok",
            "--model",
            &name,
            "--permission-mode",
            "default",
            "--strict-mcp-config",
            "--no-session-persistence",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();

    match tokio::time::timeout(PREFLIGHT_CEILING, child).await {
        Err(_) => ModelCheck {
            model: name,
            ok: false,
            error: Some("the model probe timed out".to_string()),
        },
        Ok(Err(e)) => ModelCheck {
            model: name,
            ok: false,
            error: Some(e.to_string()),
        },
        Ok(Ok(out)) if out.status.success() => ModelCheck {
            model: name,
            ok: true,
            error: None,
        },
        Ok(Ok(out)) => {
            // The CLI puts its model complaint on stdout, not stderr.
            let msg = String::from_utf8_lossy(&out.stdout)
                .lines()
                .chain(String::from_utf8_lossy(&out.stderr).lines())
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("the model was rejected")
                .to_string();
            ModelCheck {
                model: name,
                ok: false,
                error: Some(msg.chars().take(240).collect()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<String> {
        MODEL_ALIASES.iter().map(|m| (*m).to_string()).collect()
    }

    #[test]
    fn every_seat_has_a_gui_blurb_and_hints_never_target_a_stale_seat() {
        let blurbs = seat_blurbs();
        assert_eq!(blurbs.len(), seat::KNOWN_SEATS.len());
        for b in &blurbs {
            assert!(!b.label.trim().is_empty(), "{} has no label", b.seat);
            assert!(
                b.role.len() > 20,
                "{} needs a real sentence for the tooltip",
                b.seat
            );
            assert!(!b.traits.is_empty(), "{} has no traits", b.seat);
        }
        // A hint keyed to a renamed/removed seat would silently never render.
        for (seat, _) in SEAT_HINTS {
            assert!(
                seat::KNOWN_SEATS.contains(seat),
                "SEAT_HINTS targets `{seat}`, which is not a known seat"
            );
        }
        // The human hints must not leak the agent-directed voice of `note`.
        for b in &blurbs {
            if let Some(hint) = &b.hint {
                assert!(
                    !hint.contains("Do NOT") && !hint.contains("You MAY"),
                    "{} hint is written at the agent, not the user: {hint}",
                    b.seat
                );
            }
        }
    }

    #[test]
    fn seat_facts_cover_every_known_seat_exactly() {
        for seat in seat::KNOWN_SEATS {
            assert!(
                seat_fact(seat).is_some(),
                "seat `{seat}` has no SEAT_FACTS row — the agent would reason about it blind"
            );
        }
        assert_eq!(
            SEAT_FACTS.len(),
            seat::KNOWN_SEATS.len(),
            "SEAT_FACTS describes a seat that isn't in KNOWN_SEATS"
        );
    }

    #[test]
    fn parses_a_fenced_chart_and_normalizes_fields() {
        let text = r#"Here's my read:
```json
{"summary":"Browse-heavy, cost-sensitive.",
 "picks":[
   {"seat":"companion","model":"opus","effort":"HIGH","rationale":"240 turns in window.","deviates":true},
   {"seat":"browse","model":"sonnet","fallback":"haiku","rationale":"47 turns; latency wins."},
   {"seat":"keeper","model":"haiku","effort":"low","rationale":"Background, 31 runs."}
 ]}
```
That's it."#;
        let r = parse_assignment(text, &models());
        assert_eq!(r.picks.len(), 3);
        assert!(r.summary.contains("Browse-heavy"));
        // Effort is case-normalized against the documented vocabulary.
        assert_eq!(r.picks[0].effort.as_deref(), Some("high"));
        assert!(r.picks[0].deviates);
        // `deviates` defaults to false when the model omits it.
        assert!(!r.picks[1].deviates);
        assert_eq!(r.picks[1].fallback.as_deref(), Some("haiku"));
        assert_eq!(r.picks[1].effort, None, "an omitted field stays Default");
    }

    #[test]
    fn drops_picks_that_cannot_be_applied_or_audited() {
        let text = r#"{"summary":"ok","picks":[
          {"seat":"not_a_seat","model":"opus","rationale":"unknown seat"},
          {"seat":"voice","model":"opus"},
          {"seat":"mission","model":"opus","rationale":"   "},
          {"seat":"drafter","rationale":"no fields set, so it writes nothing"},
          {"seat":"browse","model":"gpt-9","rationale":"off-menu model, nothing else set"},
          {"seat":"keeper","model":"gpt-9","effort":"low","rationale":"off-menu model, effort survives"},
          {"seat":"linked","model":"sonnet","effort":"turbo","rationale":"bad effort only"}
        ]}"#;
        let r = parse_assignment(text, &models());
        let seats: Vec<&str> = r.picks.iter().map(|p| p.seat.as_str()).collect();
        // Dropped: the unknown seat (unwritable), the two without an auditable
        // rationale, the all-Default pick, and `browse` — whose only field was
        // an off-menu model, so stripping it leaves nothing to apply.
        assert_eq!(seats, vec!["keeper", "linked"]);
        // A bad field degrades to Default without discarding a sound rationale.
        assert_eq!(r.picks[0].model, None, "off-menu model degrades to Default");
        assert_eq!(r.picks[0].effort.as_deref(), Some("low"));
        assert_eq!(r.picks[1].model.as_deref(), Some("sonnet"));
        assert_eq!(r.picks[1].effort, None, "out-of-vocabulary effort dropped");
    }

    #[test]
    fn a_custom_id_already_in_use_is_allowed_but_a_new_one_is_not() {
        let mut allowed = models();
        allowed.push("claude-fable-5".to_string());
        let text = r#"{"picks":[
          {"seat":"browse","model":"claude-fable-5","rationale":"reuses the id you run"},
          {"seat":"voice","model":"claude-invented-7","effort":"low","rationale":"made up"}
        ]}"#;
        let r = parse_assignment(text, &allowed);
        assert_eq!(r.picks.len(), 2);
        assert_eq!(r.picks[0].model.as_deref(), Some("claude-fable-5"));
        assert_eq!(r.picks[1].model, None, "an unseen pinned id is refused");
        assert_eq!(r.picks[1].effort.as_deref(), Some("low"), "the rest survives");
    }

    #[test]
    fn a_reply_with_no_usable_json_hands_back_what_the_agent_said() {
        // Otherwise the UI has literally nothing to render and a broken
        // contract is indistinguishable from a button that does nothing.
        let r = parse_assignment("I'd rather not answer in JSON.", &models());
        assert!(r.picks.is_empty() && r.summary.is_empty());
        assert_eq!(r.raw.as_deref(), Some("I'd rather not answer in JSON."));

        // Parsed but empty on both axes is the same dead end.
        let r = parse_assignment(r#"{"summary":"","picks":[]}"#, &models());
        assert!(r.raw.is_some());

        // A real answer never carries the escape hatch.
        let r = parse_assignment(r#"{"summary":"all good","picks":[]}"#, &models());
        assert_eq!(r.raw, None);

        // Long replies are bounded, and multi-byte text is not sliced mid-char.
        let long = "é".repeat(5_000);
        let r = parse_assignment(&long, &models());
        let raw = r.raw.unwrap();
        assert!(raw.chars().count() <= 601, "excerpt is bounded");
        assert!(raw.ends_with('…'));

        assert!(parse_assignment("", &models()).raw.is_some());
    }

    #[test]
    fn one_pick_per_seat_and_prose_only_replies_are_empty() {
        assert!(parse_assignment("no json at all", &models()).picks.is_empty());
        let text = r#"{"picks":[
          {"seat":"browse","model":"sonnet","rationale":"first"},
          {"seat":"browse","model":"haiku","rationale":"duplicate"}
        ]}"#;
        let r = parse_assignment(text, &models());
        assert_eq!(r.picks.len(), 1);
        assert_eq!(r.picks[0].model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn merge_pick_replaces_reach_fields_and_preserves_everything_else() {
        let current = SeatConfig {
            model: Some("opus".to_string()),
            effort: Some("max".to_string()),
            fallback: Some("sonnet".to_string()),
            backend: Some("claude-code".to_string()),
            binary_path: Some("/opt/claude".to_string()),
            extra_flags: Some(vec!["--verbose-tools".to_string()]),
            charter: Some("owns marketplace CI".to_string()),
            trigger: Some("on demand".to_string()),
        };
        let pick = SeatPick {
            seat: "browse".to_string(),
            model: Some("haiku".to_string()),
            effort: None,
            fallback: None,
            rationale: "cheap and fast".to_string(),
            deviates: false,
        };
        let merged = merge_pick(&current, &pick);
        assert_eq!(merged.model.as_deref(), Some("haiku"));
        // The card shows the RESULTING state, so an omitted field clears the
        // old value rather than silently keeping it.
        assert_eq!(merged.effort, None);
        assert_eq!(merged.fallback, None);
        // The three fields the agent may never touch ride through untouched.
        assert_eq!(merged.backend.as_deref(), Some("claude-code"));
        assert_eq!(merged.binary_path.as_deref(), Some("/opt/claude"));
        assert_eq!(
            merged.extra_flags.as_deref(),
            Some(["--verbose-tools".to_string()].as_slice())
        );
        // Roster metadata (P3) is the user's — picks never touch it.
        assert_eq!(merged.charter.as_deref(), Some("owns marketplace CI"));
        assert_eq!(merged.trigger.as_deref(), Some("on demand"));
    }

    #[test]
    fn discretion_bands_split_at_the_documented_boundaries() {
        assert_eq!(discretion_band(0).0, discretion_band(20).0);
        assert_ne!(discretion_band(20).0, discretion_band(21).0);
        assert_eq!(discretion_band(21).0, discretion_band(60).0);
        assert_ne!(discretion_band(60).0, discretion_band(61).0);
        // Out-of-range values clamp rather than panic.
        assert_eq!(discretion_band(-5).0, discretion_band(0).0);
        assert_eq!(discretion_band(999).0, discretion_band(100).0);
        // The strict band forbids deviation outright.
        assert!(discretion_band(0).1.contains("must be false"));
    }

    #[test]
    fn prompt_bakes_the_digest_posture_and_discretion_rubric() {
        let p = build_seat_prompt("## Usage digest (GROUND TRUTH)\n- browse: 47\n", "cost", 10);
        assert!(p.contains("GROUND TRUTH"));
        assert!(p.contains("browse: 47"));
        assert!(p.contains("COST-CONSCIOUS"));
        assert!(p.contains("10 / 100"));
        assert!(p.contains("must be false"), "the strict band rule is baked in");
        assert!(p.contains("\"picks\""));
        assert!(p.contains("seat-assignment` skill"));
        // The alias rule is load-bearing enough to restate outside the skill.
        assert!(p.contains("aliases, not pinned model ids"));
    }

    #[tokio::test]
    async fn a_cancelled_run_cannot_reclaim_the_next_runs_child() {
        // The race: cancel empties the slot while the cancelled task is still
        // draining, a new run registers, and the old task's cleanup steals the
        // new child — reporting a healthy run as cancelled. The run id is what
        // stops that.
        let state = SeatAssignState::new();
        let spawn_sleeper = || {
            tokio::process::Command::new("sleep")
                .arg("30")
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("sleep should spawn")
        };

        let (run_a, guard_a) = state.begin().expect("slot is free");
        assert!(state.register(run_a, spawn_sleeper()));
        // The user cancels A. Its task has not finished draining yet.
        state.cancel();

        // A's task returns, releasing the slot.
        drop(guard_a);
        assert!(!state.is_running());

        // …and B starts, registering before A's cleanup below runs.
        let (run_b, _guard_b) = state.begin().expect("A released the slot");
        assert!(state.register(run_b, spawn_sleeper()));

        // A's cleanup must find nothing of its own — and must not touch B.
        assert!(
            state.take_if(run_a).is_none(),
            "the cancelled run must not reclaim a child it does not own"
        );
        assert!(
            state.is_running(),
            "B's child must still be registered after A cleans up"
        );
        // B's own cleanup still works, so B is reported as completed, not
        // cancelled.
        assert!(state.take_if(run_b).is_some());
        state.cancel();
    }

    #[tokio::test]
    async fn cancel_before_the_child_is_registered_still_stops_the_run() {
        // The slot is empty from `begin()` until `register()`, and resolving
        // the claude binary in between can shell out to `$SHELL -ilc` — seconds
        // on a heavy rc file. A Cancel in that window used to be a silent
        // no-op: the run completed and rendered a chart the user had cancelled.
        let state = SeatAssignState::new();
        let (run_id, guard) = state.begin().expect("slot is free");

        // The user clicks Cancel while we are still resolving the binary.
        state.cancel();

        // The child finally spawns — registering must refuse it and kill it.
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sleep should spawn");
        assert!(
            !state.register(run_id, child),
            "a run cancelled before registration must not be allowed to proceed"
        );
        assert!(state.take_if(run_id).is_none(), "nothing was parked");

        // A later run is unaffected by the earlier cancel watermark.
        drop(guard);
        let (next_id, _g) = state.begin().expect("slot released");
        let child = tokio::process::Command::new("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sleep should spawn");
        assert!(
            state.register(next_id, child),
            "a fresh run after a cancel must still be able to start"
        );
        state.cancel();
    }

    #[tokio::test]
    async fn a_second_run_is_refused_while_one_is_still_settling() {
        let state = SeatAssignState::new();
        let (_id, guard) = state.begin().expect("slot is free");
        // Still in the pre-spawn window — no child registered yet — and a
        // second Run must already be refused.
        assert!(state.begin().is_none());
        drop(guard);
        assert!(state.begin().is_some(), "the slot frees when the run ends");
    }

    /// P3 continuity: the resume tail stays terminal — AFTER the utility
    /// default flags — and the default flags yield to a configured seat.
    #[test]
    fn assigner_argv_keeps_resume_terminal_and_defaults_conditional() {
        let _guard = seat::store_guard();
        seat::set_seat_for_test("seatassign", None);
        let args = assigner_argv("p".to_string(), Some("sid-5"));
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], DEFAULT_MODEL);
        let r = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[r + 1], "sid-5");
        assert_eq!(r + 2, args.len(), "the resume tail stays terminal");
        assert!(m < r, "seat flags precede the resume tail");

        // A configured seat suppresses the utility default entirely.
        seat::set_seat_for_test(
            "seatassign",
            Some(SeatConfig {
                model: Some("opus".to_string()),
                ..SeatConfig::default()
            }),
        );
        let args = assigner_argv("p".to_string(), None);
        assert!(!args.iter().any(|a| a == DEFAULT_MODEL));
        assert!(args.iter().any(|a| a == "opus"));
        assert!(!args.iter().any(|a| a == "--resume"));
        seat::set_seat_for_test("seatassign", None);
    }

    #[test]
    fn only_non_alias_models_need_a_preflight_spawn() {
        for alias in MODEL_ALIASES {
            assert!(!needs_preflight(alias), "{alias} must not cost a spawn");
        }
        assert!(needs_preflight("claude-fable-5"));
        assert!(!needs_preflight("   "), "blank is a no-op, not a probe");
    }

    // --- Digest rendering ------------------------------------------------

    fn digest_with(seats: Vec<SeatRow>, surfaces: Vec<(String, i64, i64, i64)>) -> SeatDigest {
        SeatDigest {
            window_days: 30,
            seats,
            surfaces,
            event_kinds: Vec::new(),
            class_roots: Vec::new(),
            total_events: 0,
            backlog: 0,
            recent_prompts: 0,
            active_days: 0,
            busiest_day: None,
            custom_models_in_use: Vec::new(),
        }
    }

    fn row(seat: &'static str) -> SeatRow {
        let f = seat_fact(seat).unwrap();
        SeatRow {
            seat: f.seat.to_string(),
            label: f.label.to_string(),
            role: f.role.to_string(),
            traits: f.traits.iter().map(|t| (*t).to_string()).collect(),
            note: f.note.map(str::to_string),
            current: SeatConfig::default(),
            activity: SeatActivity {
                seat: seat.to_string(),
                turns_window: 7,
                turns_total: 9,
                last_ts: None,
            },
        }
    }

    #[test]
    fn rendered_digest_carries_roles_notes_and_the_never_ran_signal() {
        let d = digest_with(vec![row("voice"), row("librarian")], Vec::new());
        let block = render_seat_digest_block(&d);
        assert!(block.contains("GROUND TRUTH"));
        assert!(block.contains("Voice agent"));
        // The non-obvious caveats must survive into the prompt verbatim.
        assert!(block.contains("does NOT cover voice transcript cleanup"));
        assert!(block.contains("last never"), "never-ran is stated explicitly");
        assert!(block.contains("Default (inherits the CLI default"));
        // The menu is the alias set, and with no custom ids it says so.
        assert!(block.contains("never a pinned id"));
    }

    #[test]
    fn rendered_digest_stays_within_budget_on_a_five_year_corpus() {
        // Every seat, plus far more surface/kind/class rows than the caps allow
        // — the shape a long-lived install produces.
        let seats: Vec<SeatRow> = seat::KNOWN_SEATS.iter().map(|s| row(s)).collect();
        let surfaces: Vec<(String, i64, i64, i64)> = (0..500)
            .map(|i| (format!("surface-{i}-{}", "x".repeat(80)), i, i * 3, i * 9))
            .collect();
        let mut d = digest_with(seats, surfaces);
        d.event_kinds = (0..500).map(|i| (format!("kind-{i}"), i)).collect();
        d.class_roots = (0..500).map(|i| (format!("class-{i}"), i)).collect();
        d.custom_models_in_use = vec!["claude-fable-5".to_string()];

        let block = render_seat_digest_block(&d);
        assert!(
            block.len() <= MAX_SEAT_DIGEST_BYTES,
            "digest ran to {} bytes, over the {MAX_SEAT_DIGEST_BYTES} budget",
            block.len()
        );
        // The seat roster is the load-bearing section and must always survive.
        assert!(block.contains("Companion"));
        assert!(block.contains("Seat Assignment"));
    }

    #[test]
    fn digest_truncation_is_announced_rather_than_silent() {
        // Force the budget to bite: one seat row per known seat is small, so
        // pad the surfaces past the cap with very long names.
        let seats: Vec<SeatRow> = seat::KNOWN_SEATS.iter().map(|s| row(s)).collect();
        let surfaces: Vec<(String, i64, i64, i64)> = (0..MAX_SURFACE_ROWS)
            .map(|i| (format!("s{i}-{}", "y".repeat(4_000)), 1, 1, 1))
            .collect();
        let d = digest_with(seats, surfaces);
        let block = render_seat_digest_block(&d);
        assert!(block.len() <= MAX_SEAT_DIGEST_BYTES);
        assert!(
            block.contains("digest truncated"),
            "a dropped section must be announced, never silently omitted"
        );
    }
}

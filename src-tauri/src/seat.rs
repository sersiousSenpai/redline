// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Agent Seats — per-seat backend/model/effort configuration for every
//! headless `claude` the app spawns. Each spawn site is tagged with a stable
//! seat name ("browse", "voice", "keeper", …); the seat's configured flags
//! (`--model` / `--effort` / `--fallback-model` + extra flags) are appended to
//! its arg vector, and a seat-level `binaryPath` can point a seat at a
//! different `claude` build entirely. Config lives in one `app_settings` row
//! as JSON and is mirrored into a process-global store so the ~15 spawn sites
//! (which have no DB handle) can read it synchronously.
//!
//! `backend` defaults to `claude-code`; `codex` selects the Codex app-server
//! adapter. Keeping the choice on the seat allows mixed rosters.
//!
//! Fork-thread categories default to *inherit*: an empty seat config adds no
//! flags, so the thread runs exactly like its parent surface. The one real
//! inheritance edge — Drafter comment threads riding a doc whose discussion
//! agent is the `drafter` seat — falls back to the `drafter` config.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::db::Database;

/// The `app_settings` key holding the whole seat map as JSON.
const SETTING_AGENT_SEATS: &str = "redline.agentSeats";
/// The `app_settings` key holding the global claude binary override.
const SETTING_CLAUDE_BIN: &str = "redline.claudeBin";
/// The `app_settings` key holding the pre-apply seat map — the undo for a
/// Seat Assignment "Apply all" (see `snapshot_seats` / `restore_snapshot`).
const SETTING_SEATS_PREVIOUS: &str = "redline.agentSeats.previous";
/// Key prefix for a seat's persistent claude thread (P3 continuity):
/// `redline.seatThread.<seat>` holds the last successful run's session id, so
/// the standing roles (librarian / shipwright / seatassign) resume the same
/// conversation instead of re-deriving from zero every run.
const SEAT_THREAD_PREFIX: &str = "redline.seatThread.";
/// Environment override for the claude binary — checked before everything.
pub const ENV_CLAUDE_BIN: &str = "REDLINE_CLAUDE_BIN";

/// Every seat the GUI offers and the spawn sites use. A `set_agent_seat` for
/// anything else is rejected so junk keys can't accumulate in the setting.
pub const KNOWN_SEATS: &[&str] = &[
    "companion",
    "browse",
    "linked",
    "mission",
    "voice",
    "drafter",
    "memory",
    "keeper",
    "classifier",
    "librarian",
    "shipwright",
    "seatassign",
    "ai_review",
    "ai_commit",
    "orchestrator",
    "fork_plan",
    "fork_review",
    "fork_drafter",
];

/// `fork_drafter` inherits the `drafter` seat when unconfigured (the sidecar
/// rides the same doc as the drafter discussion agent). The other fork
/// categories inherit their *interactive* parent — i.e. no flags at all.
fn inherits_from(seat: &str) -> Option<&'static str> {
    match seat {
        "fork_drafter" => Some("drafter"),
        _ => None,
    }
}

/// Default `(seat, charter, trigger)` for every known seat — the roster's
/// standing description of each role. The charter says what the role is
/// responsible for; the trigger says when it acts. Both are derived from what
/// the backing module actually does (browse.rs drives a tab, keeper.rs runs on
/// the idle tick, …), never aspirational. A user-set `SeatConfig.charter` /
/// `.trigger` overrides the default; these fill in when unset. A test asserts
/// this table and `KNOWN_SEATS` agree exactly.
pub const DEFAULT_CHARTERS: &[(&str, &str, &str)] = &[
    (
        "companion",
        "Holds one continuous discussion that follows you across every surface, \
         glancing at other agents' context and consulting them on your behalf.",
        "When you talk to the Companion column, on any surface.",
    ),
    (
        "browse",
        "Answers questions about the page open in one browser tab and drives \
         that tab through the local bridge.",
        "When you message a tab's page discussion.",
    ),
    (
        "linked",
        "Carries one conversation spanning all browser tabs, folding per-tab \
         digests into a single thread.",
        "When you message the linked discussion.",
    ),
    (
        "mission",
        "Orchestrates a research mission across tabs and pins toward one goal, \
         ending in a Drafter-ready brief.",
        "When you message an active mission.",
    ),
    (
        "voice",
        "Reads the plan aloud and discusses it in speech, including realtime \
         conversation mode.",
        "When you start the voice agent or push to talk.",
    ),
    (
        "drafter",
        "Collaborates on a Drafter document, re-reading the live draft and \
         writing tracked suggestions you accept or reject in place.",
        "When you message a document's discussion agent.",
    ),
    (
        "memory",
        "Answers what you decided or researched by walking the ClassMemory \
         catalog and the lake, citing ledger entries.",
        "When you ask on the Memory surface's Ask tab.",
    ),
    (
        "keeper",
        "Compacts cold prompt bodies into gists and applies reversible memory \
         ops, escalating destructive ones for review.",
        "On the idle background tick, unattended.",
    ),
    (
        "classifier",
        "Organizes the captured prompt lake into the emergent class catalog by \
         emitting structured proposals for review.",
        "When an Organize pass runs over the lake.",
    ),
    (
        "librarian",
        "Surveys unreconciled work across every surface and returns a \
         prioritized next-actions checklist.",
        "When you run Survey on the Memory surface's Health tab.",
    ),
    (
        "shipwright",
        "Reads the ground-truth code digest of the repo and proposes at most \
         five improvements, each citing a digest number.",
        "When you run it from the Bookshelf; findings land as a new document.",
    ),
    (
        "seatassign",
        "Reads the seat-usage digest and proposes the whole seat chart for your \
         review; nothing applies until you say so.",
        "When you click Run assignment in this dialog.",
    ),
    (
        "ai_review",
        "Pre-reviews a code-review diff and files schema-constrained findings \
         as draft annotations.",
        "When a code review opens with pre-review enabled.",
    ),
    (
        "ai_commit",
        "Drafts a commit message, branch name and PR description from the \
         review diff.",
        "When you open the push dialog on a review.",
    ),
    (
        "orchestrator",
        "Executes an approved plan as a multi-agent workflow in a visible \
         terminal session.",
        "When you launch a plan via Orchestrate.",
    ),
    (
        "fork_plan",
        "Answers one reviewer comment on a plan section as a read-only sidecar \
         thread.",
        "When you open a discussion thread on a plan comment.",
    ),
    (
        "fork_review",
        "Answers one question about a diff hunk as a read-only review thread.",
        "When you open a thread on a review annotation.",
    ),
    (
        "fork_drafter",
        "Answers one comment thread on a Drafter document, read-only.",
        "When you open a comment thread on a document.",
    ),
];

/// The built-in `(charter, trigger)` for a seat, if described.
pub fn default_charter(seat: &str) -> Option<(&'static str, &'static str)> {
    DEFAULT_CHARTERS
        .iter()
        .find(|(s, _, _)| *s == seat)
        .map(|(_, c, t)| (*c, *t))
}

/// The effective `(charter, trigger)` for a seat: the user's own non-blank
/// override wins, else the built-in default. Falls back per field — a custom
/// charter with no custom trigger keeps the default trigger.
pub fn charter_for(seat: &str) -> (String, String) {
    let (def_charter, def_trigger) = default_charter(seat).unwrap_or(("", ""));
    let s = store().read().unwrap();
    let cfg = s.seats.get(seat);
    let pick = |user: Option<&String>, def: &str| {
        user.map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| def.to_string())
    };
    (
        pick(cfg.and_then(|c| c.charter.as_ref()), def_charter),
        pick(cfg.and_then(|c| c.trigger.as_ref()), def_trigger),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeatConfig {
    /// Which harness backs this seat. `None`/empty means `claude-code` (the
    /// only backend today — the field is forward wiring for Phase 5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Passed as `--model`. `None`/empty omits the flag (the CLI default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Passed as `--effort` (low → max). `None`/empty omits the flag; an
    /// invalid combo fails loudly at spawn, which is the intended forward
    /// compatibility with new models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Passed as `--fallback-model`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    /// Absolute path to a different `claude` binary for this seat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    /// Appended verbatim after the built flags — an escape hatch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_flags: Option<Vec<String>>,
    /// Roster charter (P3): what this role is responsible for, in the user's
    /// words. Metadata only — never a CLI flag; `flag_args_from` ignores it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charter: Option<String>,
    /// Roster trigger (P3): when this seat acts (e.g. "on demand", "when a
    /// review opens"). Metadata only — never a CLI flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
}

impl SeatConfig {
    fn is_empty(&self) -> bool {
        fn blank(o: &Option<String>) -> bool {
            o.as_deref().map(str::trim).unwrap_or("").is_empty()
        }
        blank(&self.model)
            && blank(&self.backend)
            && blank(&self.effort)
            && blank(&self.fallback)
            && blank(&self.binary_path)
            && blank(&self.charter)
            && blank(&self.trigger)
            && self.extra_flags.as_deref().unwrap_or(&[]).is_empty()
    }
}

struct Store {
    seats: HashMap<String, SeatConfig>,
    claude_bin: Option<String>,
    /// The app database, registered by `load_from_db` at startup. The spawn
    /// sites that consume this module have no DB handle of their own (the
    /// reason the seat map is mirrored here at all); the thread-continuity
    /// helpers below reach persistence the same way.
    db: Option<Arc<Database>>,
}

fn store() -> &'static RwLock<Store> {
    static STORE: OnceLock<RwLock<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        RwLock::new(Store {
            seats: HashMap::new(),
            claude_bin: None,
            db: None,
        })
    })
}

/// Load the seat map + binary override from the DB into the global store, and
/// register the handle so the thread-continuity helpers can persist through
/// it. Called once at startup (before any agent can spawn); safe to call again.
pub fn load_from_db(db: &Arc<Database>) {
    let seats = db
        .get_setting(SETTING_AGENT_SEATS)
        .and_then(|json| serde_json::from_str::<HashMap<String, SeatConfig>>(&json).ok())
        .unwrap_or_default();
    let claude_bin = db
        .get_setting(SETTING_CLAUDE_BIN)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut s = store().write().unwrap();
    s.seats = seats;
    s.claude_bin = claude_bin;
    s.db = Some(db.clone());
}

/// The registered app database, if startup registration has happened.
fn registered_db() -> Option<Arc<Database>> {
    store().read().unwrap().db.clone()
}

/// The full seat map (configured seats only), for the settings GUI.
pub fn all_seats() -> HashMap<String, SeatConfig> {
    store().read().unwrap().seats.clone()
}

/// Update one seat, persist the whole map, and refresh the store. An
/// all-empty config removes the row (back to inherit/default).
pub fn set_seat(db: &Database, seat: &str, config: SeatConfig) -> Result<(), String> {
    if !KNOWN_SEATS.contains(&seat) {
        return Err(format!("unknown agent seat: {seat}"));
    }
    validate_backend_for_seat(seat, &config)?;
    let mut s = store().write().unwrap();
    if config.is_empty() {
        s.seats.remove(seat);
    } else {
        s.seats.insert(seat.to_string(), config);
    }
    let json = serde_json::to_string(&s.seats).map_err(|e| e.to_string())?;
    db.set_setting(SETTING_AGENT_SEATS, &json)
        .map_err(|e| e.to_string())?;
    // A hand-edit retires the batch undo. Otherwise Revert would sit there
    // indefinitely and, days later, restore a chart from before edits the user
    // has since made by hand — silently destroying them.
    drop(s);
    clear_snapshot(db);
    Ok(())
}

fn validate_backend_for_seat(seat: &str, config: &SeatConfig) -> Result<(), String> {
    match config.backend.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        None | Some("claude-code") => Ok(()),
        Some("codex") if seat == "ai_commit" => Ok(()),
        Some("codex") => Err(format!("Codex execution is not enabled for the {seat} seat yet")),
        Some(value) => Err(format!("unsupported agent backend: {value}")),
    }
}

/// Apply many seats in one shot: validate every name first, then mutate and
/// persist once. All-or-nothing, so a batch from the Seat Assignment agent can
/// never half-land.
pub fn set_seats(db: &Database, updates: &[(String, SeatConfig)]) -> Result<(), String> {
    for (seat, _) in updates {
        if !KNOWN_SEATS.contains(&seat.as_str()) {
            return Err(format!("unknown agent seat: {seat}"));
        }
    }
    for (seat, config) in updates {
        validate_backend_for_seat(seat, config)?;
    }
    let mut s = store().write().unwrap();
    for (seat, config) in updates {
        if config.is_empty() {
            s.seats.remove(seat);
        } else {
            s.seats.insert(seat.clone(), config.clone());
        }
    }
    let json = serde_json::to_string(&s.seats).map_err(|e| e.to_string())?;
    db.set_setting(SETTING_AGENT_SEATS, &json)
        .map_err(|e| e.to_string())
}

/// Stash the whole current map so a batch apply is revertible in one click.
/// Called once per Seat Assignment card, before its first apply.
pub fn snapshot_seats(db: &Database) -> Result<(), String> {
    let json = {
        let s = store().read().unwrap();
        serde_json::to_string(&s.seats).map_err(|e| e.to_string())?
    };
    db.set_setting(SETTING_SEATS_PREVIOUS, &json)
        .map_err(|e| e.to_string())
}

/// Drop the batch undo. Called whenever the snapshot stops describing "the
/// chart immediately before the last applied batch".
fn clear_snapshot(db: &Database) {
    let _ = db.set_setting(SETTING_SEATS_PREVIOUS, "");
}

/// Restore the stashed map wholesale — the undo for "Apply all". Errors when
/// nothing has been stashed, so the GUI can hide the button.
///
/// One-shot: the snapshot is consumed, so Revert disappears afterwards rather
/// than lingering as a button that would re-apply a stale chart over whatever
/// the user has done since.
pub fn restore_snapshot(db: &Database) -> Result<(), String> {
    let json = db
        .get_setting(SETTING_SEATS_PREVIOUS)
        .filter(|j| !j.trim().is_empty())
        .ok_or("there is no previous seat chart to restore")?;
    let restored: HashMap<String, SeatConfig> =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    {
        let mut s = store().write().unwrap();
        s.seats = restored;
        let out = serde_json::to_string(&s.seats).map_err(|e| e.to_string())?;
        db.set_setting(SETTING_AGENT_SEATS, &out)
            .map_err(|e| e.to_string())?;
    }
    clear_snapshot(db);
    Ok(())
}

/// Whether a revertible snapshot exists (drives the Revert button's presence).
pub fn has_snapshot(db: &Database) -> bool {
    db.get_setting(SETTING_SEATS_PREVIOUS)
        .is_some_and(|j| !j.trim().is_empty())
}

/// The global claude binary override (settings surface).
pub fn claude_bin_override() -> Option<String> {
    store().read().unwrap().claude_bin.clone()
}

pub fn set_claude_bin_override(db: &Database, path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    store().write().unwrap().claude_bin = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    db.set_setting(SETTING_CLAUDE_BIN, trimmed)
        .map_err(|e| e.to_string())
}

/// The effective config for a seat: its own row, else its inheritance
/// fallback, else empty (no flags — the CLI default).
fn effective(seat: &str) -> SeatConfig {
    let s = store().read().unwrap();
    if let Some(cfg) = s.seats.get(seat).filter(|c| !c.is_empty()) {
        return cfg.clone();
    }
    if let Some(parent) = inherits_from(seat) {
        if let Some(cfg) = s.seats.get(parent).filter(|c| !c.is_empty()) {
            return cfg.clone();
        }
    }
    SeatConfig::default()
}

/// The flag tail for a seat's spawn — pure over a config (unit-testable).
pub fn flag_args_from(cfg: &SeatConfig) -> Vec<String> {
    let mut args = Vec::new();
    let mut push_flag = |flag: &str, value: &Option<String>| {
        if let Some(v) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            args.push(flag.to_string());
            args.push(v.to_string());
        }
    };
    push_flag("--model", &cfg.model);
    push_flag("--effort", &cfg.effort);
    push_flag("--fallback-model", &cfg.fallback);
    if let Some(extra) = &cfg.extra_flags {
        args.extend(extra.iter().filter(|f| !f.trim().is_empty()).cloned());
    }
    args
}

/// The flag tail for a seat — what every spawn site appends to its argv.
pub fn flag_args(seat: &str) -> Vec<String> {
    flag_args_from(&effective(seat))
}

/// The model a seat's spawn explicitly requests via `--model`, if any — the
/// value `flag_args` would emit, so a prompt stamped with it is ground truth.
/// `None` = the seat has no explicit model and the CLI default applies; the
/// caller must store nothing rather than guess.
pub fn model_for(seat: &str) -> Option<String> {
    effective(seat)
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
}

/// Effective harness for a seat. Unconfigured and inherited-empty seats retain
/// the historical Claude Code behavior.
pub fn backend_for(seat: &str) -> &'static str {
    match effective(seat).backend.as_deref().map(str::trim) {
        Some("codex") => "codex",
        _ => "claude-code",
    }
}

/// The claude binary a seat should spawn, if overridden: the seat's own
/// `binaryPath`, else the global settings override. `None` = use the probed
/// default (the caller's cached `resolve_claude_bin()` result).
pub fn binary_for(seat: &str) -> Option<String> {
    let cfg = effective(seat);
    cfg.binary_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .or_else(claude_bin_override)
}

// ---------------------------------------------------------------------------
// Per-role persistent threads (P3 continuity) + roster stats
// ---------------------------------------------------------------------------

fn seat_thread_key(seat: &str) -> String {
    format!("{SEAT_THREAD_PREFIX}{seat}")
}

/// The persisted claude session id for a seat's standing thread, if any.
pub fn seat_thread(seat: &str) -> Option<String> {
    let db = registered_db()?;
    db.get_setting(&seat_thread_key(seat))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Persist a seat's thread id after a successful run, so the next spawn
/// resumes the same conversation.
pub fn remember_seat_thread(seat: &str, sid: &str) {
    if let Some(db) = registered_db() {
        let _ = db.set_setting(&seat_thread_key(seat), sid.trim());
    }
}

/// Drop a seat's stored thread — the resume failed, so the next attempt
/// starts fresh and re-persists whatever session it gets.
pub fn forget_seat_thread(seat: &str) {
    if let Some(db) = registered_db() {
        let _ = db.set_setting(&seat_thread_key(seat), "");
    }
}

/// Roster stats: stamp `last_run_at` on run completion. Items-filed deltas
/// arrive with the producer wiring in a later wave — this only records that
/// the seat ran.
fn record_seat_run(seat: &str) {
    if let Some(db) = registered_db() {
        let _ = db.upsert_seat_stat(seat, Some(crate::ledger::now_millis()), 0);
    }
}

/// Deliberate stops that must NOT trigger the fresh-session fallback: a user
/// cancel and the stall watchdog are decisions, not resume failures.
fn is_deliberate_stop(err: &str) -> bool {
    err == "cancelled" || err.contains("was stopped")
}

/// Resume-SPECIFIC failures — the stored thread itself is unusable: claude
/// can't find the conversation (deleted/expired transcript) or the thread
/// outgrew the context window (the same explicit signatures browse.rs keys
/// its own resume recovery on). ONLY these justify forgetting the stored
/// thread and retrying fresh. Anything else — a rate limit, a missing
/// binary, a transient API blip — leaves the accumulated continuity intact
/// and surfaces as the error it is.
fn is_resume_failure(err: &str) -> bool {
    err.to_lowercase().contains("no conversation found")
        || crate::browse::is_context_overflow(err)
}

/// One async lock per seat name: two concurrent `run_with_thread` calls on
/// the same seat (e.g. a Shipwright consult racing the Bookshelf run) must
/// serialize — unserialized, the loser could read a stale prior, fail its
/// resume, and forget the thread the winner just stored.
fn seat_run_lock(seat: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(seat.to_string())
        .or_default()
        .clone()
}

/// Drive one standing-role run with thread continuity. `attempt` is the
/// seat's own spawn (called with the prior session id to `--resume`, or
/// `None` for a fresh session) returning `(final_text, session_id)`.
///
/// The contract, in order:
/// 1. Resume the seat's stored thread (or `explicit_prior` when the caller
///    holds a fresher in-memory id, as the Shipwright does).
/// 2. On success, persist the returned session id and stamp
///    `seat_stats.last_run_at`.
/// 3. If the *resumed* attempt fails with a resume-SPECIFIC error (the
///    conversation is gone, or it outgrew the context window — see
///    [`is_resume_failure`]), fall back to ONE fresh attempt and overwrite
///    the stored id — a dead thread must never brick the role. Any OTHER
///    failure (rate limit, missing binary, transient API error) returns the
///    error and KEEPS the stored thread: a momentary blip must not destroy
///    accumulated continuity.
///
/// Runs are serialized per seat (see [`seat_run_lock`]): the stored-thread
/// read happens under the lock, so a concurrent run always sees the previous
/// run's freshly persisted id, never a stale prior.
pub async fn run_with_thread<F, Fut>(
    seat: &str,
    explicit_prior: Option<String>,
    mut attempt: F,
) -> Result<(String, Option<String>), String>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<(String, Option<String>), String>>,
{
    let run_lock = seat_run_lock(seat);
    let _running = run_lock.lock().await;
    let prior = explicit_prior.or_else(|| seat_thread(seat));
    let (text, sid) = match attempt(prior.clone()).await {
        Ok(ok) => ok,
        Err(e) if prior.is_some() && !is_deliberate_stop(&e) && is_resume_failure(&e) => {
            forget_seat_thread(seat);
            attempt(None).await?
        }
        Err(e) => return Err(e),
    };
    if let Some(s) = sid.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        remember_seat_thread(seat, s);
    }
    record_seat_run(seat);
    Ok((text, sid))
}

/// One roster row: the seat's standing description plus everything it has
/// actually done — stats from `seat_stats`, burn totals from `seat_burn`
/// (tokens only; money is never computed here).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatRosterEntry {
    pub seat: String,
    pub charter: String,
    pub trigger: String,
    pub last_run_at: Option<i64>,
    pub items_filed: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub spawns: i64,
}

/// The whole roster rollup, one entry per known seat, in `KNOWN_SEATS` order.
pub fn roster(db: &Database) -> Vec<SeatRosterEntry> {
    let stats: HashMap<String, crate::db::SeatStatRow> = db
        .list_seat_stats()
        .unwrap_or_default()
        .into_iter()
        .map(|r| (r.seat.clone(), r))
        .collect();
    let burn: HashMap<String, crate::db::SeatBurnRow> = db
        .seat_burn_totals_by_seat()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.seat.clone().map(|s| (s, r)))
        .collect();
    KNOWN_SEATS
        .iter()
        .map(|&seat| {
            let (charter, trigger) = charter_for(seat);
            let st = stats.get(seat);
            let b = burn.get(seat);
            SeatRosterEntry {
                seat: seat.to_string(),
                charter,
                trigger,
                last_run_at: st.and_then(|s| s.last_run_at),
                items_filed: st.map(|s| s.items_filed).unwrap_or(0),
                input_tokens: b.map(|b| b.input_tokens).unwrap_or(0),
                output_tokens: b.map(|b| b.output_tokens).unwrap_or(0),
                cache_read_tokens: b.map(|b| b.cache_read_tokens).unwrap_or(0),
                cache_creation_tokens: b.map(|b| b.cache_creation_tokens).unwrap_or(0),
                spawns: b.map(|b| b.spawns).unwrap_or(0),
            }
        })
        .collect()
}

/// The roster for the Agent Seats dialog: seat config metadata + stats + burn
/// in one read.
#[tauri::command]
pub fn get_seat_roster(
    store: tauri::State<'_, crate::state::SessionStore>,
) -> Vec<SeatRosterEntry> {
    roster(&store.database())
}

/// Test-only store write (no DB) — lets other modules' spawn-arg tests
/// configure a seat. Tests share the process-global store, so each test must
/// use a seat no other test writes, and clean up after itself.
#[cfg(test)]
pub(crate) fn set_seat_for_test(seat: &str, config: Option<SeatConfig>) {
    let mut s = store().write().unwrap();
    match config {
        Some(cfg) => s.seats.insert(seat.to_string(), cfg),
        None => s.seats.remove(seat),
    };
}

/// Tests across the whole crate share the process-global seat store, and
/// `snapshot_seats` / `restore_snapshot` read and write the *whole* map — so
/// **any** test that touches it must hold this guard, in this module or any
/// other (`claude_proc`'s spawn-arg tests included), or a parallel test's
/// writes leak in and both flake.
#[cfg(test)]
pub(crate) fn store_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(model: Option<&str>, effort: Option<&str>) -> SeatConfig {
        SeatConfig {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            ..SeatConfig::default()
        }
    }

    #[test]
    fn flag_args_from_builds_model_effort_and_fallback() {
        let mut c = cfg(Some("sonnet"), Some("medium"));
        c.fallback = Some("haiku".to_string());
        assert_eq!(
            flag_args_from(&c),
            vec![
                "--model",
                "sonnet",
                "--effort",
                "medium",
                "--fallback-model",
                "haiku"
            ]
        );
    }

    #[test]
    fn flag_args_from_omits_blank_fields_entirely() {
        assert!(flag_args_from(&SeatConfig::default()).is_empty());
        // Whitespace-only values behave like absent ones ("default" in the GUI
        // omits the flag — nothing may leak an empty --model).
        let c = cfg(Some("   "), None);
        assert!(flag_args_from(&c).is_empty());
    }

    #[test]
    fn flag_args_from_appends_extra_flags_verbatim() {
        let mut c = cfg(Some("opus"), None);
        c.extra_flags = Some(vec!["--verbose-tools".to_string(), "".to_string()]);
        assert_eq!(
            flag_args_from(&c),
            vec!["--model", "opus", "--verbose-tools"]
        );
    }

    #[test]
    fn store_roundtrip_and_inheritance() {
        let _guard = store_guard();
        // Global-store test: use seats no other test writes.
        {
            let mut s = store().write().unwrap();
            s.seats
                .insert("drafter".to_string(), cfg(Some("opus"), Some("high")));
            s.seats.remove("fork_drafter");
            s.seats.remove("fork_plan");
        }
        // fork_drafter inherits drafter when unset…
        assert_eq!(
            flag_args("fork_drafter"),
            vec!["--model", "opus", "--effort", "high"]
        );
        // …but its own config wins once set.
        {
            let mut s = store().write().unwrap();
            s.seats
                .insert("fork_drafter".to_string(), cfg(Some("haiku"), None));
        }
        assert_eq!(flag_args("fork_drafter"), vec!["--model", "haiku"]);
        // fork_plan inherits its interactive parent: no flags.
        assert!(flag_args("fork_plan").is_empty());
        // Cleanup for other tests in this process.
        let mut s = store().write().unwrap();
        s.seats.remove("drafter");
        s.seats.remove("fork_drafter");
    }

    #[test]
    fn set_seats_is_all_or_nothing_and_an_empty_config_clears_the_row() {
        let _guard = store_guard();
        let db = Database::open_in_memory().unwrap();
        {
            let mut s = store().write().unwrap();
            s.seats.clear();
        }
        // One bad name must abort the whole batch — a half-landed chart is
        // worse than a rejected one.
        let err = set_seats(
            &db,
            &[
                ("browse".to_string(), cfg(Some("sonnet"), None)),
                ("not_a_seat".to_string(), cfg(Some("opus"), None)),
            ],
        )
        .unwrap_err();
        assert!(err.contains("not_a_seat"));
        assert!(
            store().read().unwrap().seats.is_empty(),
            "the valid seat in a rejected batch must not have landed"
        );

        set_seats(
            &db,
            &[
                ("browse".to_string(), cfg(Some("sonnet"), None)),
                ("voice".to_string(), cfg(Some("haiku"), Some("low"))),
            ],
        )
        .unwrap();
        assert_eq!(flag_args("browse"), vec!["--model", "sonnet"]);
        // An all-blank config removes the row, back to Default.
        set_seats(&db, &[("browse".to_string(), SeatConfig::default())]).unwrap();
        assert!(flag_args("browse").is_empty());
        assert_eq!(flag_args("voice"), vec!["--model", "haiku", "--effort", "low"]);

        store().write().unwrap().seats.clear();
    }

    #[test]
    fn backend_defaults_to_claude_and_codex_only_config_is_retained() {
        let _guard = store_guard();
        let db = Database::open_in_memory().unwrap();
        store().write().unwrap().seats.clear();
        assert_eq!(backend_for("ai_commit"), "claude-code");
        set_seat(&db, "ai_commit", SeatConfig {
            backend: Some("codex".into()),
            ..SeatConfig::default()
        }).unwrap();
        assert_eq!(backend_for("ai_commit"), "codex");
        assert!(set_seat(&db, "ai_commit", SeatConfig {
            backend: Some("unknown".into()),
            ..SeatConfig::default()
        }).is_err());
        store().write().unwrap().seats.clear();
    }

    #[test]
    fn snapshot_then_restore_undoes_a_whole_batch() {
        let _guard = store_guard();
        let db = Arc::new(Database::open_in_memory().unwrap());
        assert!(!has_snapshot(&db), "nothing stashed yet");
        assert!(
            restore_snapshot(&db).is_err(),
            "restoring with no snapshot must fail loudly, not silently wipe"
        );

        // A pre-existing hand-picked seat, plus one left at Default.
        {
            let mut s = store().write().unwrap();
            s.seats.clear();
            s.seats
                .insert("mission".to_string(), cfg(Some("opus"), Some("high")));
        }
        snapshot_seats(&db).unwrap();
        assert!(has_snapshot(&db));

        // The agent's batch: overwrite the hand-pick and configure a fresh seat.
        set_seats(
            &db,
            &[
                ("mission".to_string(), cfg(Some("haiku"), None)),
                ("keeper".to_string(), cfg(Some("haiku"), Some("low"))),
            ],
        )
        .unwrap();
        assert_eq!(flag_args("mission"), vec!["--model", "haiku"]);
        assert_eq!(flag_args("keeper"), vec!["--model", "haiku", "--effort", "low"]);

        restore_snapshot(&db).unwrap();
        // The hand-pick is back exactly as it was…
        assert_eq!(flag_args("mission"), vec!["--model", "opus", "--effort", "high"]);
        // …and a seat the batch newly configured is returned to Default.
        assert!(
            flag_args("keeper").is_empty(),
            "revert must remove seats the batch added, not just restore old ones"
        );

        // Restore also has to survive a reload from the DB, not just the store.
        load_from_db(&db);
        assert_eq!(flag_args("mission"), vec!["--model", "opus", "--effort", "high"]);
        assert!(flag_args("keeper").is_empty());

        // Revert is one-shot: the snapshot is consumed, so the button goes away
        // instead of lingering as a stale second undo.
        assert!(!has_snapshot(&db));
        assert!(restore_snapshot(&db).is_err());

        store().write().unwrap().seats.clear();
    }

    #[test]
    fn a_hand_edit_retires_the_batch_undo() {
        let _guard = store_guard();
        let db = Database::open_in_memory().unwrap();
        {
            let mut s = store().write().unwrap();
            s.seats.clear();
        }
        snapshot_seats(&db).unwrap();
        set_seats(&db, &[("mission".to_string(), cfg(Some("haiku"), None))]).unwrap();
        assert!(has_snapshot(&db), "the batch is still undoable");

        // The user hand-edits a seat afterwards. Reverting now would restore a
        // chart from before that edit and silently destroy it, so the undo is
        // retired instead.
        set_seat(&db, "browse", cfg(Some("opus"), None)).unwrap();
        assert!(!has_snapshot(&db));
        assert!(restore_snapshot(&db).is_err());
        assert_eq!(flag_args("browse"), vec!["--model", "opus"]);

        store().write().unwrap().seats.clear();
    }

    #[test]
    fn seat_config_json_shape_is_camel_case_and_sparse() {
        let mut c = cfg(Some("sonnet"), None);
        c.binary_path = Some("/opt/claude".to_string());
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"binaryPath\""));
        assert!(!json.contains("effort"), "None fields must not serialize");
        let back: SeatConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
        // Unknown seats map still parses field-by-field (forward compat).
        let parsed: SeatConfig =
            serde_json::from_str(r#"{"model":"x","futureField":1}"#).unwrap();
        assert_eq!(parsed.model.as_deref(), Some("x"));
    }

    /// P3 roster fields: an old persisted config (no charter/trigger) must
    /// keep deserializing, the new fields must round-trip sparsely, and a
    /// roster-only config must persist (not read as "empty" and be dropped).
    #[test]
    fn charter_and_trigger_are_backward_compatible_roster_metadata() {
        // Pre-P3 JSON: both fields absent → None, nothing else disturbed.
        let old: SeatConfig =
            serde_json::from_str(r#"{"model":"sonnet","effort":"high"}"#).unwrap();
        assert_eq!(old.charter, None);
        assert_eq!(old.trigger, None);
        assert_eq!(old.model.as_deref(), Some("sonnet"));

        // New fields round-trip and stay sparse when unset.
        let mut c = cfg(None, None);
        c.charter = Some("keeps the marketplace index honest".to_string());
        c.trigger = Some("on demand".to_string());
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"charter\""));
        assert!(json.contains("\"trigger\""));
        let back: SeatConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
        assert!(!serde_json::to_string(&cfg(Some("opus"), None))
            .unwrap()
            .contains("charter"));

        // A charter-only config is not "empty" — set_seat must keep the row.
        assert!(!c.is_empty());
        // Roster metadata never leaks into spawn args.
        assert!(flag_args_from(&c).is_empty());
    }

    /// P3 roster: the charter table and `KNOWN_SEATS` are one closed
    /// vocabulary — every seat described, nothing stale described.
    #[test]
    fn every_known_seat_has_a_default_charter_and_trigger() {
        assert_eq!(
            DEFAULT_CHARTERS.len(),
            KNOWN_SEATS.len(),
            "adding a seat without a charter (or retiring one without \
             pruning it) must fail the build"
        );
        for &seat in KNOWN_SEATS {
            let (charter, trigger) = default_charter(seat)
                .unwrap_or_else(|| panic!("seat `{seat}` has no default charter"));
            assert!(
                charter.trim().len() > 20,
                "`{seat}` charter must be a real sentence"
            );
            assert!(
                trigger.trim().len() > 10,
                "`{seat}` trigger must say when it acts"
            );
        }
        for (seat, _, _) in DEFAULT_CHARTERS {
            assert!(
                KNOWN_SEATS.contains(seat),
                "DEFAULT_CHARTERS describes `{seat}`, which is not a known seat"
            );
        }
    }

    #[test]
    fn user_charter_and_trigger_overrides_beat_defaults_per_field() {
        let _guard = store_guard();
        {
            let mut s = store().write().unwrap();
            s.seats.remove("ai_review");
        }
        let (def_c, def_t) = charter_for("ai_review");
        assert_eq!(def_c, default_charter("ai_review").unwrap().0);
        assert_eq!(def_t, default_charter("ai_review").unwrap().1);

        {
            let mut s = store().write().unwrap();
            s.seats.insert(
                "ai_review".to_string(),
                SeatConfig {
                    charter: Some("my custom reviewer duty".to_string()),
                    trigger: Some("   ".to_string()),
                    ..SeatConfig::default()
                },
            );
        }
        let (c, t) = charter_for("ai_review");
        assert_eq!(c, "my custom reviewer duty", "a user charter beats the default");
        assert_eq!(t, def_t, "a blank trigger override falls back to the default");

        store().write().unwrap().seats.remove("ai_review");
    }

    /// P3 continuity: the thread id lives in `app_settings`, so it survives a
    /// store reload; forget clears it.
    #[test]
    fn seat_thread_round_trip_and_forget() {
        let _guard = store_guard();
        let db = Arc::new(Database::open_in_memory().unwrap());
        load_from_db(&db);
        assert_eq!(seat_thread("shipwright"), None);
        remember_seat_thread("shipwright", " sid-42 ");
        assert_eq!(seat_thread("shipwright").as_deref(), Some("sid-42"));
        // Survives a reload — it is persisted, not only mirrored.
        load_from_db(&db);
        assert_eq!(seat_thread("shipwright").as_deref(), Some("sid-42"));
        forget_seat_thread("shipwright");
        assert_eq!(seat_thread("shipwright"), None);
    }

    /// The continuity contract end to end: resume the stored thread, persist
    /// the new session id and `last_run_at` on success, fall back to exactly
    /// one fresh attempt when the resume fails, and never retry a cancel.
    #[tokio::test]
    async fn run_with_thread_resumes_persists_and_falls_back_fresh() {
        let _guard = store_guard();
        let db = Arc::new(Database::open_in_memory().unwrap());
        load_from_db(&db);
        let seen = std::cell::RefCell::new(Vec::<Option<String>>::new());

        // First run: nothing stored → fresh spawn; sid + last_run_at persist.
        let (text, _) = run_with_thread("librarian", None, |prior| {
            seen.borrow_mut().push(prior);
            async { Ok(("first".to_string(), Some("sid-1".to_string()))) }
        })
        .await
        .unwrap();
        assert_eq!(text, "first");
        assert_eq!(seen.borrow().as_slice(), &[None]);
        assert_eq!(seat_thread("librarian").as_deref(), Some("sid-1"));
        let stat = db.get_seat_stat("librarian").expect("run recorded");
        assert!(stat.last_run_at.is_some(), "last_run_at stamped on completion");

        // Second run: the resume fails → ONE fresh retry overwrites the id.
        seen.borrow_mut().clear();
        let (text, _) = run_with_thread("librarian", None, |prior| {
            seen.borrow_mut().push(prior.clone());
            async move {
                match prior {
                    Some(_) => Err("No conversation found with session ID sid-1".to_string()),
                    None => Ok(("second".to_string(), Some("sid-2".to_string()))),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "second");
        assert_eq!(
            seen.borrow().as_slice(),
            &[Some("sid-1".to_string()), None],
            "resume first, then exactly one fresh fallback"
        );
        assert_eq!(seat_thread("librarian").as_deref(), Some("sid-2"));

        // A cancel is a decision, not a resume failure: no retry, thread kept.
        seen.borrow_mut().clear();
        let err = run_with_thread("librarian", None, |prior| {
            seen.borrow_mut().push(prior);
            async { Err::<(String, Option<String>), _>("cancelled".to_string()) }
        })
        .await
        .unwrap_err();
        assert_eq!(err, "cancelled");
        assert_eq!(
            seen.borrow().as_slice(),
            &[Some("sid-2".to_string())],
            "a cancel must not auto-retry"
        );
        assert_eq!(seat_thread("librarian").as_deref(), Some("sid-2"));

        // A transient / non-resume error (rate limit, missing binary, API
        // blip) is NOT a resume failure: no fresh retry, and the stored
        // thread SURVIVES — a momentary blip must not destroy continuity.
        seen.borrow_mut().clear();
        let err = run_with_thread("librarian", None, |prior| {
            seen.borrow_mut().push(prior);
            async { Err::<(String, Option<String>), _>("rate limit exceeded".to_string()) }
        })
        .await
        .unwrap_err();
        assert_eq!(err, "rate limit exceeded");
        assert_eq!(
            seen.borrow().as_slice(),
            &[Some("sid-2".to_string())],
            "a transient error must not trigger the fresh fallback"
        );
        assert_eq!(
            seat_thread("librarian").as_deref(),
            Some("sid-2"),
            "the stored thread survives a transient error"
        );

        // Both attempts failing (resume-specific first) surfaces the fresh
        // attempt's error, and the dead thread stays forgotten rather than
        // being retried forever.
        seen.borrow_mut().clear();
        let err = run_with_thread("librarian", None, |prior| {
            seen.borrow_mut().push(prior);
            async {
                Err::<(String, Option<String>), _>(
                    "No conversation found with session ID sid-2".to_string(),
                )
            }
        })
        .await
        .unwrap_err();
        assert_eq!(err, "No conversation found with session ID sid-2");
        assert_eq!(seen.borrow().len(), 2);
        assert_eq!(seat_thread("librarian"), None, "the dead thread is dropped");

        // An explicit prior (the caller's in-memory id) beats the stored one.
        seen.borrow_mut().clear();
        run_with_thread("librarian", Some("sid-mem".to_string()), |prior| {
            seen.borrow_mut().push(prior);
            async { Ok(("third".to_string(), Some("sid-3".to_string()))) }
        })
        .await
        .unwrap();
        assert_eq!(seen.borrow().as_slice(), &[Some("sid-mem".to_string())]);
        assert_eq!(seat_thread("librarian").as_deref(), Some("sid-3"));
    }

    /// The fallback classifier is deliberately narrow: only a dead
    /// conversation or an explicit context-overflow signature counts.
    #[test]
    fn resume_failure_classification_is_narrow() {
        assert!(is_resume_failure("No conversation found with session ID abc"));
        assert!(is_resume_failure("error: no conversation found"));
        assert!(is_resume_failure("prompt is too long: 250000 tokens"));
        assert!(is_resume_failure("maximum context length exceeded"));
        // Transient / environmental errors keep the thread.
        assert!(!is_resume_failure("rate limit exceeded"));
        assert!(!is_resume_failure("No such file or directory (os error 2)"));
        assert!(!is_resume_failure("error_during_execution"));
        assert!(!is_resume_failure("cancelled"));
    }

    /// Two concurrent runs on ONE seat serialize: the second run's attempt
    /// never overlaps the first's, its stored-thread read sees the first
    /// run's freshly persisted id, and the seat's thread survives both.
    #[tokio::test]
    async fn concurrent_same_seat_runs_serialize_and_keep_the_thread() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let _guard = store_guard();
        let db = Arc::new(Database::open_in_memory().unwrap());
        load_from_db(&db);
        remember_seat_thread("shipwright", "sid-0");

        let active = Arc::new(AtomicUsize::new(0));
        let overlapped = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));

        let run = |tag: &'static str, sid: &'static str| {
            let active = active.clone();
            let overlapped = overlapped.clone();
            let seen = seen.clone();
            run_with_thread("shipwright", None, move |prior| {
                let active = active.clone();
                let overlapped = overlapped.clone();
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(prior);
                    if active.fetch_add(1, Ordering::SeqCst) > 0 {
                        overlapped.store(true, Ordering::SeqCst);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok((tag.to_string(), Some(sid.to_string())))
                }
            })
        };
        let (a, b) = tokio::join!(run("a", "sid-A"), run("b", "sid-B"));
        assert_eq!(a.unwrap().0, "a");
        assert_eq!(b.unwrap().0, "b");
        assert!(
            !overlapped.load(Ordering::SeqCst),
            "attempts on one seat must never overlap"
        );
        // join! polls left-first, so run A takes the lock first: it resumes
        // the seeded thread, and run B — reading under the lock AFTER A
        // persisted — resumes A's fresh id, not the stale seed.
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            &[Some("sid-0".to_string()), Some("sid-A".to_string())],
            "the second run must see the first run's persisted thread"
        );
        assert_eq!(
            seat_thread("shipwright").as_deref(),
            Some("sid-B"),
            "the stored thread survives concurrent runs"
        );
    }

    #[test]
    fn roster_merges_charters_stats_and_burn_for_every_seat() {
        let _guard = store_guard();
        let db = Arc::new(Database::open_in_memory().unwrap());
        load_from_db(&db);
        db.upsert_seat_stat("librarian", Some(1234), 0).unwrap();
        db.add_seat_burn("librarian", "2026-08-12", 100, 40, 7, 3, 2).unwrap();

        let r = roster(&db);
        assert_eq!(r.len(), KNOWN_SEATS.len());
        let lib = r.iter().find(|e| e.seat == "librarian").unwrap();
        assert_eq!(lib.last_run_at, Some(1234));
        assert_eq!(lib.input_tokens, 100);
        assert_eq!(lib.output_tokens, 40);
        assert_eq!(lib.cache_read_tokens, 7);
        assert_eq!(lib.spawns, 2);
        assert!(!lib.charter.is_empty() && !lib.trigger.is_empty());
        // A seat that never ran renders zeros, not gaps.
        let voice = r.iter().find(|e| e.seat == "voice").unwrap();
        assert_eq!(voice.items_filed, 0);
        assert_eq!(voice.last_run_at, None);
        assert_eq!(voice.spawns, 0);
        // The rollup serializes camelCase for the FE.
        let json = serde_json::to_string(lib).unwrap();
        assert!(json.contains("\"lastRunAt\""));
        assert!(json.contains("\"itemsFiled\""));
        assert!(json.contains("\"inputTokens\""));
    }
}

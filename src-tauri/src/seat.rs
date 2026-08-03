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
//! The `backend` field exists from day one (defaulting to `claude-code`) so
//! the GUI never churns when a second backend lands (Phase 5); today any
//! other value still spawns Claude Code.
//!
//! Fork-thread categories default to *inherit*: an empty seat config adds no
//! flags, so the thread runs exactly like its parent surface. The one real
//! inheritance edge — Drafter comment threads riding a doc whose discussion
//! agent is the `drafter` seat — falls back to the `drafter` config.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::db::Database;

/// The `app_settings` key holding the whole seat map as JSON.
const SETTING_AGENT_SEATS: &str = "redline.agentSeats";
/// The `app_settings` key holding the global claude binary override.
const SETTING_CLAUDE_BIN: &str = "redline.claudeBin";
/// The `app_settings` key holding the pre-apply seat map — the undo for a
/// Seat Assignment "Apply all" (see `snapshot_seats` / `restore_snapshot`).
const SETTING_SEATS_PREVIOUS: &str = "redline.agentSeats.previous";
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
    "keeper",
    "classifier",
    "librarian",
    "shipwright",
    "seatassign",
    "ai_review",
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
}

impl SeatConfig {
    fn is_empty(&self) -> bool {
        fn blank(o: &Option<String>) -> bool {
            o.as_deref().map(str::trim).unwrap_or("").is_empty()
        }
        blank(&self.model)
            && blank(&self.effort)
            && blank(&self.fallback)
            && blank(&self.binary_path)
            && self.extra_flags.as_deref().unwrap_or(&[]).is_empty()
    }
}

struct Store {
    seats: HashMap<String, SeatConfig>,
    claude_bin: Option<String>,
}

fn store() -> &'static RwLock<Store> {
    static STORE: OnceLock<RwLock<Store>> = OnceLock::new();
    STORE.get_or_init(|| {
        RwLock::new(Store {
            seats: HashMap::new(),
            claude_bin: None,
        })
    })
}

/// Load the seat map + binary override from the DB into the global store.
/// Called once at startup (before any agent can spawn); safe to call again.
pub fn load_from_db(db: &Database) {
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

/// Apply many seats in one shot: validate every name first, then mutate and
/// persist once. All-or-nothing, so a batch from the Seat Assignment agent can
/// never half-land.
pub fn set_seats(db: &Database, updates: &[(String, SeatConfig)]) -> Result<(), String> {
    for (seat, _) in updates {
        if !KNOWN_SEATS.contains(&seat.as_str()) {
            return Err(format!("unknown agent seat: {seat}"));
        }
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
    fn snapshot_then_restore_undoes_a_whole_batch() {
        let _guard = store_guard();
        let db = Database::open_in_memory().unwrap();
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
}

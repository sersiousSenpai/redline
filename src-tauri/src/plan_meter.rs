// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The interactive plan session's arm of the token meter.
//!
//! The flagship surface isn't a headless subprocess at all: `pty.rs` runs
//! `claude` in a real terminal, so there is no `--output-format stream-json`
//! to parse and it would otherwise inherit none of the meter — leaving the one
//! surface the user spends the most time in as the only one with no model
//! badge and no economics.
//!
//! Its numbers therefore come from the **session transcript**, which
//! Experiment (j) confirmed carries the same `assistant` shape as an
//! orchestrated agent's (`message.{id, model, stop_reason, usage}` with final
//! per-message usage, plus a top-level `effort`). That is what makes this a
//! second FEED into `meter::TurnMeter` rather than a second meter.
//!
//! Two things are decided here on purpose:
//!
//! 1. **Burn books under the seat key `plan`, and `plan` is deliberately NOT
//!    in `KNOWN_SEATS`.** `seat_burn` is keyed `(seat, day)` with no
//!    constraint, so a new key costs nothing at the DB layer. Making it a
//!    *configurable* seat would be wrong: the Front Door's backend/model
//!    picker already owns the plan session's model, and two owners for one
//!    setting is a bug factory. It renders in Agent Seats as a
//!    non-configurable burn row — a label and numbers, no model picker.
//! 2. **The readout is tail-cadence, not per-token.** A few seconds' latency
//!    is the honest ceiling for a surface with no stream to parse. Saying so
//!    here is what prevents someone later "fixing" it by parsing the PTY byte
//!    stream, which would be a genuinely bad idea: the PTY carries rendered
//!    terminal output, not protocol.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::Database;
use crate::meter::TurnMeter;
use crate::state::SessionStore;

/// The seat plan-session burn books under. Not a `KNOWN_SEATS` entry — see
/// the module note.
pub const PLAN_SEAT: &str = "plan";

/// How often the tailer walks the known transcripts. Slow on purpose: a
/// transcript is written by a human-paced conversation, and this is a
/// background read, not a stream.
const TAIL_INTERVAL_MS: u64 = 4_000;

/// How many sessions the tailer keeps in view, newest activity first. An old,
/// settled session's transcript has stopped growing, so re-walking the whole
/// history buys nothing.
const TAIL_SESSIONS: i64 = 12;

/// Bytes read per session per pass. A transcript that grew more than this
/// since the last pass tail-seeks (dropping the torn line) rather than
/// blocking the tick — the same rule `runwatch` uses.
const READ_CAP: u64 = 2 * 1024 * 1024;

/// A plan session's meter changed. `pty.rs` has no turn registry to probe, so
/// the event is the only live channel; the persisted `sessions.meter_json` is
/// what a remount and a relaunch read.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanMeterEvent {
    session_id: String,
    meter: TurnMeter,
}

/// Per-session tailer state. The meter is SESSION-scoped, not turn-scoped:
/// a transcript is the whole conversation, and what the plan pane wants is
/// "what has this session cost", not "what did the last turn cost".
#[derive(Default)]
struct Tail {
    cursor: crate::runwatch::Cursor,
    meter: TurnMeter,
    /// Tokens already booked, so a re-read (relaunch, cursor reset) books the
    /// delta and not the total. Same high-water discipline as
    /// `runwatch::flush_seat_burn`, for the same reason.
    booked: Booked,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
struct Booked {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

/// Start the single background tailer. One thread for the app, not one per
/// session: the work is a handful of incremental file reads on a 4-second
/// beat, and a thread per plan session would be pure overhead.
pub fn start(app: &AppHandle, store: SessionStore) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let app = app.clone();
    let flag = stop.clone();
    let spawned = std::thread::Builder::new()
        .name("plan-meter".to_string())
        .spawn(move || tail_loop(app, store, flag));
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "failed to spawn the plan meter tailer");
    }
    stop
}

fn tail_loop(app: AppHandle, store: SessionStore, stop: Arc<AtomicBool>) {
    let db = store.database();
    let mut tails: HashMap<String, Tail> = HashMap::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let sessions = db.plan_transcripts(TAIL_SESSIONS);
        // Forget sessions that fell out of view, so the map can't grow without
        // bound across a long-running app.
        tails.retain(|sid, _| sessions.iter().any(|(s, _)| s == sid));
        for (sid, path) in sessions {
            let tail = tails.entry(sid.clone()).or_default();
            if pass(&db, &sid, Path::new(&path), tail) {
                let _ = app.emit(
                    "plan-meter",
                    PlanMeterEvent {
                        session_id: sid.clone(),
                        meter: tail.meter.clone(),
                    },
                );
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(TAIL_INTERVAL_MS));
    }
}

/// One session's incremental read. Returns whether the meter changed.
///
/// Pure enough to test: everything that touches the world goes through `db`
/// and the path.
fn pass(db: &Database, sid: &str, path: &Path, tail: &mut Tail) -> bool {
    let (lines, _skipped) = crate::runwatch::read_new_lines(path, &mut tail.cursor, READ_CAP);
    if lines.is_empty() {
        return false;
    }
    let mut changed = false;
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        changed |= tail.meter.observe(&v);
    }
    if !changed {
        return false;
    }
    book_delta(db, tail);
    if let Ok(json) = serde_json::to_string(&tail.meter) {
        if let Err(e) = db.set_session_meter(sid, &json) {
            tracing::warn!(error = %e, "failed to persist plan session meter");
        }
    }
    // The plan session's OBSERVED model, which is also what the session row's
    // `model` column has always wanted — the Front Door picker records what was
    // asked for; this records what answered.
    if let Some(model) = tail.meter.model.clone() {
        let _ = db.backfill_session_model(sid, &model);
    }
    true
}

/// Book only the tokens above the high-water mark, so a re-read books nothing.
/// The meter's totals are monotone (per-message max, summed over an
/// ever-growing set of message ids), which is what makes the subtraction sound.
fn book_delta(db: &Database, tail: &mut Tail) {
    let m = &tail.meter;
    let b = tail.booked;
    let delta = Booked {
        input: m.input_tokens.saturating_sub(b.input),
        output: m.output_tokens.saturating_sub(b.output),
        cache_read: m.cache_read_tokens.saturating_sub(b.cache_read),
        cache_creation: m.cache_creation_tokens.saturating_sub(b.cache_creation),
    };
    if delta == Booked::default() {
        return;
    }
    let day = crate::runwatch::local_day(crate::state::now_millis());
    // `spawns` is 0: the plan session is ONE long-lived process the user
    // started, not a turn-per-subprocess seat. Counting a spawn per tail pass
    // would make the roster's spawn column a measure of the tick rate.
    if db
        .add_seat_burn(
            PLAN_SEAT,
            &day,
            delta.input as i64,
            delta.output as i64,
            delta.cache_read as i64,
            delta.cache_creation as i64,
            0,
        )
        .is_err()
    {
        // Leave the mark alone so the delta re-books next pass rather than
        // vanishing.
        return;
    }
    tail.booked = Booked {
        input: m.input_tokens.max(b.input),
        output: m.output_tokens.max(b.output),
        cache_read: m.cache_read_tokens.max(b.cache_read),
        cache_creation: m.cache_creation_tokens.max(b.cache_creation),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rl-planmeter-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The transcript arm folds the same fixture the stdout arm does, and a
    /// second pass over unchanged bytes books nothing — the property that
    /// keeps a 4-second tick from multiplying the day's burn by 15 per minute.
    #[test]
    fn tails_incrementally_and_books_only_the_delta() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_session(&crate::state::ReviewSession {
            session_id: "plan-sid".to_string(),
            project_path: "/tmp/proj".to_string(),
            project_name: "proj".to_string(),
            created_at: 1_000,
            revisions: Vec::new(),
            status: crate::state::SessionStatus::InReview,
            attach_state: crate::state::AttachState::Idle,
            updated_at: 1_000,
            run_state: None,
            backend: None,
            model: None,
        })
        .unwrap();
        let dir = tmpdir();
        let path = dir.join("t.jsonl");
        let fixture = std::fs::read_to_string("tests/golden/runwatch/agent_head.jsonl").unwrap();
        let half: Vec<&str> = fixture.lines().collect();
        let (first, second) = half.split_at(6);
        std::fs::write(&path, format!("{}\n", first.join("\n"))).unwrap();

        let mut tail = Tail::default();
        assert!(pass(&db, "plan-sid", &path, &mut tail), "first read folds");
        let after_first = tail.meter.clone();
        assert!(after_first.output_tokens > 0);
        assert_eq!(after_first.model.as_deref(), Some("claude-sonnet-5"));

        // Nothing new on disk → nothing folded, nothing booked.
        assert!(!pass(&db, "plan-sid", &path, &mut tail));

        // Append the rest: the totals move to the deduped whole-file answer,
        // NOT to first-half + whole-file.
        std::fs::write(&path, fixture).unwrap();
        assert!(pass(&db, "plan-sid", &path, &mut tail));
        assert_eq!(tail.meter.input_tokens, 6);
        assert_eq!(tail.meter.output_tokens, 440);
        assert_eq!(tail.meter.cache_creation_tokens, 38_847);
        assert_eq!(tail.meter.cache_read_tokens, 64_727);

        // Booked exactly once, at the whole-file totals.
        let rows = db.seat_burn_totals_by_seat().unwrap();
        let plan = rows
            .iter()
            .find(|r| r.seat.as_deref() == Some(PLAN_SEAT))
            .expect("the plan seat booked");
        assert_eq!(plan.output_tokens, 440);
        assert_eq!(plan.cache_creation_tokens, 38_847);
        // A plan session is one long-lived process, not a spawn per tick.
        assert_eq!(plan.spawns, 0);

        // The session row carries the meter and the observed model.
        let stored = db.session_meter("plan-sid").expect("persisted");
        let back: TurnMeter = serde_json::from_str(&stored).unwrap();
        assert_eq!(back.output_tokens, 440);
        assert_eq!(back.model.as_deref(), Some("claude-sonnet-5"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// A missing transcript is a normal state (the session hasn't spoken yet),
    /// not an error.
    #[test]
    fn a_missing_transcript_is_quiet() {
        let db = Database::open_in_memory().unwrap();
        let mut tail = Tail::default();
        assert!(!pass(&db, "nope", Path::new("/nonexistent/x.jsonl"), &mut tail));
    }
}

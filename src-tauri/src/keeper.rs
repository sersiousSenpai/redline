// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Memory as plumbing — the background **keeper**.
//!
//! Redline captures everything while it's warm (the hash-chained lake) and an
//! agent organizes it into the ClassMemory catalog. The keeper makes both of
//! those *automatic and invisible*: on a slow tick it waits for the app to go
//! idle, then — when the lake has grown enough — it runs one `organize_once`
//! pass and, behind it, a **compaction pass** that behaves like human memory.
//! As classified data goes cold and the store grows, the keeper compacts the
//! *specifics* of a cold prompt into a gist while the ledger retains the
//! tamper-evident *fact that it happened* (`db::compact_prompt_body`). Size ×
//! coldness × recency drive the pressure; pins are an absolute veto.
//!
//! No buttons, no configs. The whole surface is one quiet status pill; this
//! module is the engine under it. It is deliberately best-effort — every step
//! logs on error and never panics the loop, and it never runs while a terminal
//! is producing output or a prompt just landed, so it stays off the user's hot
//! path. The compaction *intelligence* is the dissolved Librarian's brain,
//! repurposed here to **act** (emit gists) instead of advise.
//!
//! **The watch bus — crons watch, models act.** The keeper's 30s loop is also
//! the app's one background scheduler: a registry of named watches
//! (`WATCHES`), each `{name, predicate, gate, target_role, cadence}`, driven
//! by a due-cadence check on every tick, plus `schedule_once` for event-armed
//! one-shots. A watch only ever *notices* a condition and wakes an existing
//! actor or spawn site — the bus itself spawns no agents and lands no work.
//! The ad hoc timers that used to run as their own threads/tasks are re-homed
//! here (mirror sync, ledger backup, the revise
//! watchdog's scheduling, the review-staleness sweep). New background behavior becomes a bus
//! entry, not a new thread — **the bus is the one scheduling vocabulary going
//! forward**. The memory passes (organize / compaction / observations) remain
//! the loop's own body, running beside the bus under their idle / growth /
//! debounce gates exactly as before.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use tauri::AppHandle;

use crate::db::Database;
use crate::ledger::now_millis;
use crate::state::{AttachState, SessionStatus, SessionStore};

#[allow(unused_imports)]
pub use polis_memory::gardener::{CompactionAction, EMBED_BATCH, GIST_SOURCE_AGENT, GIST_SOURCE_DETERMINISTIC, GROWTH_THRESHOLD, IDLE_WINDOW_MS, KEEPER_ACTOR, MACHINE_COLD_MS, MAX_BATCH, MAX_CORPUS_BYTES, MAX_INTERVAL_MS, MIN_INTERVAL_MS, OBSERVE_COUNTER_KEY, OBSERVE_EVERY_N_ORGANIZES, OBSERVE_MAX_ITEMS_PER_NODE, OBSERVE_MAX_NODES, OBSERVE_MIN_ITEMS, ObservationAction, PromptCand, SIZE_FLOOR_BYTES, build_keeper_prompt, build_observations_prompt, group_candidates, is_idle, parse_compaction_actions, parse_observations, protected_set, select_compaction_candidates, select_observation_nodes};

/// Signature-preserving shim (Session A5): the summarizer turn runs through
/// the facade's agent seam (`polis_memory::agent::run_keeper_summarizer`).
pub async fn run_keeper_summarizer(
    db: &Database,
    cwd: &str,
    prompt: String,
) -> Result<String, String> {
    polis_memory::agent::run_keeper_summarizer(&crate::polis_host::polis_for(db), cwd, prompt).await
}


// The deterministic gist and the tolerant JSON extractor live in `polis-core`
// (Session A1 of the Polis extraction, docs/polis-extraction.md).
#[allow(unused_imports)]
pub use polis_core::gist::deterministic_gist;
#[allow(unused_imports)]
pub(crate) use polis_core::json::extract_object_with_key;

// --- Tunables (code-only; nothing is exposed to the user) ------------------

const TICK: std::time::Duration = std::time::Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Idle gate (pure)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compaction candidate selection (pure)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gist generation — tiered (agent summarizer, deterministic fallback)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The compaction pass
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Observation pass (agent-derived patterns over a node's items)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The watch bus — crons watch, models act
// ---------------------------------------------------------------------------

/// Everything a watch may look at or act through — the same few app handles
/// the old ad hoc timers each closed over individually, gathered once.
pub(crate) struct WatchCtx {
    pub(crate) app: AppHandle,
    pub(crate) db: Arc<Database>,
    pub(crate) store: SessionStore,
    /// The live held-POST map — the staleness sweep's ground truth for
    /// "does this session actually hold a sender right now".
    pub(crate) pending: crate::PendingResponses,
    /// App data dir — the backup watch snapshots into `<data_dir>/backups`.
    pub(crate) data_dir: PathBuf,
}

/// One registry entry: `{name, predicate, gate, target_role, cadence}`. New
/// watches become entries here, never threads.
pub(crate) struct Watch {
    pub(crate) name: &'static str,
    /// Who acts when this watch fires — the actor the wake is *for*. The bus
    /// never spawns an agent itself; it wakes `target_role`'s existing seam.
    pub(crate) target_role: &'static str,
    /// How often the bus evaluates this watch (a due-cadence check per 30s
    /// tick). The check is stamped whether or not the watch fires, so a gated
    /// or false predicate re-evaluates one cadence later, not one tick later.
    pub(crate) cadence: Duration,
    /// Cheap veto checked before the predicate (config / idle gates).
    pub(crate) gate: fn(&WatchCtx, i64) -> bool,
    /// The condition being watched.
    pub(crate) predicate: fn(&WatchCtx, i64) -> bool,
    /// Wake the actor. Must not stall the loop: blocking work goes through
    /// the house `spawn_blocking` pattern; anything long-lived is an EXISTING
    /// spawn site being woken, never a new one.
    pub(crate) act: fn(&WatchCtx, i64),
}

/// Mirror-sync cadence — the 120s rhythm of the retired `std::thread` loop.
const MIRROR_SYNC_EVERY: Duration = Duration::from_secs(120);
/// Ledger-backup cadence — the 6h rhythm of the retired `std::thread` loop.
/// The immediate startup snapshot stays at the setup site.
const BACKUP_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Review-staleness sweep cadence — deliberately conservative. With the
/// seen-twice rule a session reconciles 5–10 minutes after its held POST
/// silently died, never on a single racy observation.
const STALENESS_SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// Due-cadence bookkeeping (pure): `None` = never checked → due now.
pub fn cadence_due(last_run_ms: Option<i64>, cadence_ms: i64, now_ms: i64) -> bool {
    last_run_ms.map_or(true, |l| now_ms - l >= cadence_ms)
}

/// The trivial gate/predicate for pure cadence watches.
fn always(_ctx: &WatchCtx, _now: i64) -> bool {
    true
}

// --- mirror sync (was a 120s std::thread in lib.rs) -------------------------

/// Blocking filesystem work rides `spawn_blocking` so a slow disk never
/// stalls the bus tick. `sync_if_enabled` is a no-op until a dir is set.
fn mirror_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    tokio::task::spawn_blocking(move || {
        crate::mirror::sync_if_enabled(&db);
    });
}

// --- ledger backup (was a 6h std::thread in lib.rs) -------------------------

fn backup_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    let dir = ctx.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let snapshot = crate::snapshot_database(&db, &dir, crate::LEDGER_BACKUP_KEEP);
        // The DEEP chain check, and the reason the memory pill can afford a
        // cheap one. `verify_ledger_chain_incremental` re-walks only what grew
        // since its stored anchor, so it cannot see a retroactive edit to a
        // row it already verified; this full re-hash can, and runs on the same
        // 6h cadence as the backup it validates. Already off the main thread —
        // it rides the backup's `spawn_blocking`.
        //
        // It walks the SNAPSHOT just written — a consistent copy of the live
        // chain at that instant — on that file's own read-only connection, so
        // the shared `Mutex<Connection>` is never held for the walk. It also
        // proves the backup itself carries a sound chain. The live database is
        // walked only if the copy can't be opened.
        let verdict = match snapshot
            .as_deref()
            .map(polis_store::PolisStore::open_read_only)
        {
            Some(Ok(copy)) => copy.verify_ledger_chain(),
            _ => db.verify_ledger_chain(),
        };
        match verdict {
            Ok(v) if v.ok => {
                tracing::info!(checked = v.checked, "ledger chain verified (deep walk)")
            }
            Ok(v) => tracing::error!(
                first_bad_seq = ?v.first_bad_seq,
                checked = v.checked,
                "LEDGER CHAIN VERIFICATION FAILED — the record may have been tampered with"
            ),
            Err(e) => tracing::warn!(error = %e, "deep ledger verify could not run"),
        }
    });
}

// --- review-staleness sweep -------------------------------------------------

/// Suspects from the previous sweep: sessions observed once with a persisted
/// `Held` attach state but no live held POST. In-memory — the seen-twice rule
/// is a race guard, not durable state (the startup held→detached sweep in
/// `SessionStore::new` already covers restarts).
fn staleness_seen() -> &'static StdMutex<HashSet<String>> {
    static G: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Seen-twice reconciliation step (pure): only a session suspect on TWO
/// consecutive sweeps is detached — one observation can race the tiny window
/// between a plan POST's attach-state write and its sender registration.
/// Returns (sessions to detach now, the suspect set to carry forward).
pub fn staleness_step(
    prev_suspects: &HashSet<String>,
    current: &HashSet<String>,
) -> (Vec<String>, HashSet<String>) {
    let mut to_detach: Vec<String> = current.intersection(prev_suspects).cloned().collect();
    to_detach.sort();
    let next: HashSet<String> = current
        .iter()
        .filter(|s| !to_detach.contains(s))
        .cloned()
        .collect();
    (to_detach, next)
}

/// A staleness candidate: still `InReview`, persisted attach state `Held`,
/// but no live held POST — the inconsistency `mark_session_detached` exists
/// to reconcile, found by sweep instead of waiting for a user action to trip
/// over it.
fn staleness_candidates(ctx: &WatchCtx) -> HashSet<String> {
    ctx.store
        .list()
        .into_iter()
        .filter(|s| matches!(s.status, SessionStatus::InReview))
        .filter(|s| s.attach_state == AttachState::Held)
        .filter(|s| !ctx.pending.has(&s.session_id))
        .map(|s| s.session_id)
        .collect()
}

/// Runs when there is a candidate OR a carried suspect (the latter so a
/// resolved suspect is forgotten rather than detached on a much-later blip).
fn staleness_predicate(ctx: &WatchCtx, _now: i64) -> bool {
    !staleness_candidates(ctx).is_empty() || !staleness_seen().lock().unwrap().is_empty()
}

fn staleness_act(ctx: &WatchCtx, _now: i64) {
    let current = staleness_candidates(ctx);
    let to_detach = {
        let mut seen = staleness_seen().lock().unwrap();
        let (to_detach, next) = staleness_step(&seen, &current);
        *seen = next;
        to_detach
    };
    if to_detach.is_empty() {
        return;
    }
    // The detach reconciliation writes sqlite — off the tick via the house
    // `spawn_blocking` pattern (see `mirror_act`).
    let app = ctx.app.clone();
    let store = ctx.store.clone();
    tokio::task::spawn_blocking(move || {
        for sid in to_detach {
            tracing::warn!(
                session_id = %sid,
                "staleness sweep: held attach state with no held POST on two \
                 consecutive sweeps — reconciling to detached"
            );
            crate::mark_session_detached(&app, &store, &sid);
        }
    });
}

/// The registry — the bus's whole schedule, one table.
pub(crate) static WATCHES: &[Watch] = &[
    Watch {
        name: "mirror-sync",
        target_role: "mirror",
        cadence: MIRROR_SYNC_EVERY,
        gate: always,
        predicate: always,
        act: mirror_act,
    },
    Watch {
        name: "ledger-backup",
        target_role: "backup",
        cadence: BACKUP_EVERY,
        gate: always,
        predicate: always,
        act: backup_act,
    },
    Watch {
        name: "review-staleness-sweep",
        target_role: "reviewer",
        cadence: STALENESS_SWEEP_EVERY,
        gate: always,
        predicate: staleness_predicate,
        act: staleness_act,
    },
    Watch {
        name: "shots-retention",
        target_role: "keeper",
        cadence: SHOTS_SWEEP_EVERY,
        gate: always,
        predicate: always,
        act: shots_sweep_act,
    },
];

// --- the picture store's retention (Phase 7) -------------------------------

/// A bus entry, not a new timer — the bus is the one scheduling vocabulary.
const SHOTS_SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);

fn shots_sweep_act(ctx: &WatchCtx, _now: i64) {
    let db = ctx.db.clone();
    let app = ctx.app.clone();
    tokio::task::spawn_blocking(move || {
        let removed = crate::shots::sweep(&app, &db);
        if removed > 0 {
            tracing::info!(removed, "swept unreferenced/aged page shots");
        }
    });
}

// --- semantic index (Phase 6) ----------------------------------------------

/// One bus pass: for each due watch, stamp the check, then gate → predicate
/// → act. `last` maps watch name → last check stamp.
fn run_bus(last: &mut HashMap<&'static str, i64>, ctx: &WatchCtx, now: i64) {
    for w in WATCHES {
        if !cadence_due(last.get(w.name).copied(), w.cadence.as_millis() as i64, now) {
            continue;
        }
        last.insert(w.name, now);
        if !(w.gate)(ctx, now) || !(w.predicate)(ctx, now) {
            continue;
        }
        tracing::debug!(watch = w.name, target_role = w.target_role, "watch fired");
        (w.act)(ctx, now);
    }
}

// --- scheduled one-shots (`schedule_once`) ----------------------------------

pub(crate) type OneShotFut = Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// One event-armed, scheduled task — fired exactly once by the bus at the
/// first tick at-or-after its due time, then gone.
pub(crate) struct OneShot {
    pub(crate) name: String,
    pub(crate) due_ms: i64,
    pub(crate) task: Box<dyn FnOnce() -> OneShotFut + Send>,
}

fn oneshot_queue() -> &'static StdMutex<Vec<OneShot>> {
    static G: OnceLock<StdMutex<Vec<OneShot>>> = OnceLock::new();
    G.get_or_init(|| StdMutex::new(Vec::new()))
}

/// Schedule an event-armed one-shot on the bus. NOT periodic: it fires once,
/// at the first 30s tick at-or-after `delay` elapses (the tick quantizes the
/// delay upward by at most one `TICK`). Re-arming is the caller's move —
/// schedule again from inside the task. Duplicate names are allowed on
/// purpose: supersession is the caller's concern (e.g. the revise watchdog's
/// generation counter).
pub(crate) fn schedule_once<F>(name: impl Into<String>, delay: Duration, task: F)
where
    F: FnOnce() -> OneShotFut + Send + 'static,
{
    oneshot_queue().lock().unwrap().push(OneShot {
        name: name.into(),
        due_ms: now_millis() + delay.as_millis() as i64,
        task: Box::new(task),
    });
}

/// Pure due-partition: removes and returns every entry whose due time has
/// passed — an entry can therefore fire at most once.
pub(crate) fn split_due(queue: &mut Vec<OneShot>, now_ms: i64) -> Vec<OneShot> {
    let mut due = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        if queue[i].due_ms <= now_ms {
            due.push(queue.remove(i));
        } else {
            i += 1;
        }
    }
    due
}

fn take_due_oneshots(now_ms: i64) -> Vec<OneShot> {
    let mut q = oneshot_queue().lock().unwrap();
    split_due(&mut q, now_ms)
}

// ---------------------------------------------------------------------------
// The scheduler loop
// ---------------------------------------------------------------------------

/// Spawn the background keeper — the memory passes AND the watch bus, one
/// loop. Wakes every `TICK`; each wake (1) drives the watch bus (due-cadence
/// watches, then due scheduled one-shots), and (2) runs the
/// idle/growth/debounce-gated memory passes.
/// Async because the classifier/summarizer are async; runs on the Tauri
/// runtime.
pub(crate) fn spawn(ctx: WatchCtx) {
    tauri::async_runtime::spawn(async move {
        let app = ctx.app.clone();
        let db = ctx.db.clone();
        let mut gardener = polis_memory::gardener::GardenerState::default();
        let gardener_cfg = polis_memory::gardener::GardenerConfig::default();
        let events = crate::polis_host::TauriEvents::new(app.clone());
        // Seed every watch's last-check stamp to "now": the re-homed timers
        // all did their startup work at the setup site (immediate backup
        // snapshot, one-shot mirror sync), so each watch first fires one full
        // cadence after launch — exactly the retired threads' rhythm.
        let mut bus_last: HashMap<&'static str, i64> = {
            let t = now_millis();
            WATCHES.iter().map(|w| (w.name, t)).collect()
        };
        loop {
            tokio::time::sleep(TICK).await;
            let now = now_millis();

            // --- the watch bus: due watches, then due one-shots. Runs every
            // tick, BEFORE the memory gates below can `continue` past it. ---
            run_bus(&mut bus_last, &ctx, now);
            for o in take_due_oneshots(now) {
                tracing::debug!(one_shot = %o.name, "scheduled one-shot due — running");
                tauri::async_runtime::spawn((o.task)());
            }

            // --- the memory passes: one gardener step (Session A5 of the
            // Polis extraction). Idle → debounce → growth → organize →
            // compact → (every Nth organize) observe → events: exactly the
            // gates that lived here, now `polis_memory::gardener::step`. ---
            let polis = crate::polis_host::polis_for(&db);
            let outcome = polis_memory::gardener::step(
                &polis,
                &mut gardener,
                &crate::polis_host::PtyIdle,
                &crate::polis_host::WallClock,
                &gardener_cfg,
                &events,
            )
            .await;
            if outcome.gate == polis_memory::gardener::Gate::Ran {
                tracing::debug!(?outcome, "gardener step ran");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- the watch bus ------------------------------------------------------

    #[test]
    fn cadence_due_bookkeeping() {
        // Never checked → due now.
        assert!(cadence_due(None, 120_000, 1_000));
        // Inside the cadence → not due.
        assert!(!cadence_due(Some(1_000), 120_000, 120_999));
        // Exactly at the cadence boundary → due.
        assert!(cadence_due(Some(1_000), 120_000, 121_000));
        assert!(cadence_due(Some(1_000), 120_000, 500_000));
    }

    #[test]
    fn registry_rehomes_the_timers_with_their_cadences() {
        let find = |n: &str| {
            WATCHES
                .iter()
                .find(|w| w.name == n)
                .unwrap_or_else(|| panic!("watch {n} missing from the registry"))
        };
        // The re-homed timers keep their observable rhythms.
        assert_eq!(find("mirror-sync").cadence, Duration::from_secs(120));
        assert_eq!(find("ledger-backup").cadence, Duration::from_secs(6 * 3600));
        // The sweeps and the hub watch are registered, conservatively paced.
        assert_eq!(find("review-staleness-sweep").cadence, Duration::from_secs(300));
        // Names are unique — the last-check map keys on them.
        let mut names: Vec<_> = WATCHES.iter().map(|w| w.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), WATCHES.len(), "duplicate watch names");
    }

    #[test]
    fn staleness_step_needs_two_consecutive_sightings() {
        let one: HashSet<String> = ["s1".to_string()].into_iter().collect();
        // First sighting: no detach, carried as a suspect.
        let (detach, carried) = staleness_step(&HashSet::new(), &one);
        assert!(detach.is_empty());
        assert!(carried.contains("s1"));
        // Second consecutive sighting: detached, and not carried again.
        let (detach, carried) = staleness_step(&carried, &one);
        assert_eq!(detach, vec!["s1".to_string()]);
        assert!(carried.is_empty());
        // A suspect that resolved in between is simply forgotten.
        let (detach, carried) = staleness_step(&one, &HashSet::new());
        assert!(detach.is_empty() && carried.is_empty());
    }

    #[test]
    fn schedule_once_fires_exactly_once() {
        let shot = |name: &str, due: i64| OneShot {
            name: name.to_string(),
            due_ms: due,
            task: Box::new(|| Box::pin(async {}) as OneShotFut),
        };
        let mut q = vec![shot("early", 1_000), shot("late", 5_000)];
        // Before anything is due: nothing fires, nothing is lost.
        assert!(split_due(&mut q, 999).is_empty());
        assert_eq!(q.len(), 2);
        // At the first due time: exactly that one fires and leaves the queue.
        let due = split_due(&mut q, 1_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].name, "early");
        assert_eq!(q.len(), 1);
        // Re-draining at the same instant re-fires nothing — once means once.
        assert!(split_due(&mut q, 1_000).is_empty());
        // The rest fires when its own time comes.
        assert_eq!(split_due(&mut q, 10_000).len(), 1);
        assert!(q.is_empty());
    }
}

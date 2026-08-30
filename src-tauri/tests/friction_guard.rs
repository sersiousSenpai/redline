//! T5.1 — the app's evidence pipeline about itself must stay wired.
//!
//! `friction_events` took 21 rows in four months against a 5,000-row budget,
//! and the gaps were not "nothing went wrong" — they were whole subsystems
//! with no emit at all. The terminal (the busiest surface) recorded nothing.
//! Comment-persistence failures, which silently lose a reviewer's own work on
//! the flagship surface, were a `tracing::error!` and nothing else. A run that
//! went silent for eighteen days produced no signal whatsoever.
//!
//! Every ranking that decides what to fix next — the Librarian's checklist,
//! the Shipwright's digest, `build_digest` — reads that table. A module that
//! quietly stops emitting doesn't look like a regression; it looks like a
//! subsystem with no problems. Hence a source contract, in the shape of
//! `auth.rs`'s route table: these modules emit, and it takes deleting a line
//! from this list to stop them.

static PTY: &str = include_str!("../src/pty.rs");
static STATE: &str = include_str!("../src/state.rs");
static KEEPER: &str = include_str!("../src/keeper.rs");
static LIB: &str = include_str!("../src/lib.rs");
static FORK: &str = include_str!("../src/fork.rs");
static EXTENSION_HOST: &str = include_str!("../src/extension_host.rs");
static WEBVIEW_GUARD: &str = include_str!("../src/webview_guard.rs");
static DB: &str = include_str!("../src/db.rs");
static AUTH: &str = include_str!("../src/auth.rs");

/// `(module, source, the friction kind it owes, why that failure matters)`.
const CONTRACT: &[(&str, &str, &str, &str)] = &[
    (
        "pty.rs",
        PTY,
        "\"pty_exit\"",
        "a shell dying under the user is the busiest surface's loudest failure",
    ),
    (
        "state.rs",
        STATE,
        "\"comment_persist_failed\"",
        "a comment write that misses SQLite loses the reviewer's own work, silently",
    ),
    (
        "keeper.rs",
        KEEPER,
        "\"run_stalled\"",
        "a run going quiet for a day is the signal that produced an 18-day ghost",
    ),
    (
        "lib.rs",
        LIB,
        "\"review_submit_lost\"",
        "a whole review round delivered nowhere while the run chip moved anyway",
    ),
    (
        "fork.rs",
        FORK,
        "\"fork_turn_failed\"",
        "the second-busiest prompt surface ending a turn with no reply",
    ),
    (
        "db.rs",
        DB,
        "\"db_lock_poisoned\"",
        "a recovered poison means a panic happened inside a db closure",
    ),
    (
        "extension_host.rs",
        EXTENSION_HOST,
        "\"extension_host_call_failed\"",
        "a third-party extension failing against the host boundary",
    ),
];

/// Each contracted module still emits its own kind.
#[test]
fn friction_emitting_modules_stay_wired() {
    for (module, src, kind, why) in CONTRACT {
        assert!(
            src.contains(kind),
            "{module} no longer emits {kind} — {why}. Without it, the digests \
             that rank what to fix read the silence as health"
        );
        assert!(
            src.contains("note_friction("),
            "{module} lost its note_friction call entirely"
        );
    }
}

/// The two modules that emit but whose kind is spelled elsewhere still hold a
/// call — enough to notice if instrumentation is stripped wholesale.
#[test]
fn ambient_emitters_keep_their_call() {
    for (module, src) in [("webview_guard.rs", WEBVIEW_GUARD), ("auth.rs", AUTH)] {
        assert!(
            src.contains("note_friction("),
            "{module} lost its friction emit"
        );
    }
}

/// The sink itself: a `note_friction` that swallowed its own write, or a
/// `record_friction` that vanished, would make every assertion above vacuous.
#[test]
fn the_friction_sink_still_writes() {
    assert!(
        DB.contains("pub fn note_friction("),
        "db::note_friction is the single front door every emit above goes through"
    );
    assert!(
        DB.contains("db.record_friction(kind, surface, session_id, detail)"),
        "note_friction must still reach record_friction — a no-op front door \
         would leave every emit site in this contract cosmetic"
    );
}

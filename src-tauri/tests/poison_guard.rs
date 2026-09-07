//! T0.2 — the one `Mutex<Connection>` must survive a panic.
//!
//! `db.rs` holds every table behind a single `Mutex<Connection>`, and the crate
//! builds with `panic = "unwind"` on purpose (see
//! `size_guard::panic_strategy_stays_unwind`). Those two facts together mean a
//! panic inside any db closure poisons that mutex — and with a bare
//! `.unwrap()` at the lock site, every Tauri command and every bridge route
//! panics from then on while the window stays up and looks perfectly alive.
//! There is no recovery short of quitting the app.
//!
//! This file is the source invariant that keeps the lock site singular. The
//! behavioural half — poison a real connection, then keep using it — is
//! `db::tests::poisoned_conn_recovers`, which lives next to the other 150-odd
//! db tests because it has to reach the private `conn` field.

static DB_RS: &str = include_str!("../src/db.rs");

/// Production code takes the connection through `lock_conn()` and nowhere
/// else.
///
/// The discriminator is `self.` — unit tests inside `db.rs` own the `Database`
/// by value and reach the field as `db.conn`, which cannot poison anything a
/// later command will touch.
#[test]
fn db_conn_is_never_locked_with_unwrap() {
    let bare = DB_RS.matches("self.conn.lock().unwrap()").count();
    assert_eq!(
        bare, 0,
        "db.rs has {bare} production site(s) taking the connection with a bare \
         unwrap. One panic there poisons the mutex and every later command \
         panics forever — go through self.lock_conn() instead"
    );

    assert!(
        DB_RS.contains("fn lock_conn(&self) -> MutexGuard<'_, Connection>"),
        "db.rs lost its lock_conn() accessor — the single production lock site"
    );
    assert!(
        DB_RS.contains("unwrap_or_else(|e| e.into_inner())"),
        "lock_conn() must recover the guard with the house pattern \
         (pty::lock_ok, auth.rs, seat.rs), not propagate the poison"
    );
    assert!(
        DB_RS.contains("\"db_lock_poisoned\""),
        "a recovered poison must leave a friction_events row — a silent \
         recovery is a failure the evidence pipeline can never see"
    );

    // The accessor is only worth anything if it is what the file actually
    // uses. A floor, not an exact count, so ordinary new db methods don't trip
    // it. (Was 300 before Session A3 of the Polis extraction moved ~110
    // memory methods onto `PolisStore`; the same invariant now holds there,
    // below.)
    let uses = DB_RS.matches("self.lock_conn()").count();
    assert!(
        uses > 200,
        "only {uses} call sites go through lock_conn() — the sweep regressed"
    );
}

/// The same lock is shared with `polis-store` (Session A2/A3), whose methods
/// take it through `PolisStore::conn()` — an accessor built on the house
/// pattern — and never with a bare unwrap. Same invariant, second crate.
#[test]
fn store_conn_is_never_locked_with_unwrap() {
    const STORE: &[(&str, &str)] = &[
        ("lib.rs", include_str!("../crates/polis/polis-store/src/lib.rs")),
        ("catalog.rs", include_str!("../crates/polis/polis-store/src/catalog.rs")),
        ("chain.rs", include_str!("../crates/polis/polis-store/src/chain.rs")),
        ("compaction.rs", include_str!("../crates/polis/polis-store/src/compaction.rs")),
        ("notes.rs", include_str!("../crates/polis/polis-store/src/notes.rs")),
        ("observations.rs", include_str!("../crates/polis/polis-store/src/observations.rs")),
        ("prompts.rs", include_str!("../crates/polis/polis-store/src/prompts.rs")),
        ("search.rs", include_str!("../crates/polis/polis-store/src/search.rs")),
        ("supersessions.rs", include_str!("../crates/polis/polis-store/src/supersessions.rs")),
        ("browse.rs", include_str!("../crates/polis/polis-store/src/browse.rs")),
        ("embeddings.rs", include_str!("../crates/polis/polis-store/src/embeddings.rs")),
        ("exports.rs", include_str!("../crates/polis/polis-store/src/exports.rs")),
        ("session_tree.rs", include_str!("../crates/polis/polis-store/src/session_tree.rs")),
    ];
    let mut uses = 0;
    for (name, src) in STORE {
        let bare = src.matches("self.conn.lock().unwrap()").count() + src.matches(".lock().unwrap()").count();
        assert_eq!(bare, 0, "polis-store/{name} takes the connection with a bare unwrap");
        uses += src.matches("self.conn()").count();
    }
    assert!(
        STORE[0].1.contains("conn.lock().unwrap_or_else(|e| e.into_inner())"),
        "PolisStore's lock must recover a poisoned guard with the house pattern"
    );
    assert!(uses > 80, "only {uses} store call sites go through PolisStore::conn() — the sweep regressed");
}

/// The behavioural half is easy to delete by accident from another file; pin
/// that it still exists.
#[test]
fn behavioural_poison_recovery_test_still_exists() {
    assert!(
        DB_RS.contains("fn poisoned_conn_recovers()"),
        "db::tests::poisoned_conn_recovers is the only test that proves the \
         recovery actually works — a source invariant alone would pass against \
         an accessor that still panicked"
    );
}

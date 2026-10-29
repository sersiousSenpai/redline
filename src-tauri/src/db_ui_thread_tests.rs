// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The UI-thread guard on `lock_conn`/`read_conn`, and the context journal's
//! queue (`db_journal.rs`) that lets a UI-thread append skip the writer.

use super::*;
use std::time::{Duration, Instant};

/// Play the UI thread for the rest of this test's thread.
fn on_ui() {
    TEST_UI_THREAD.with(|c| c.set(true));
}

fn off_ui() {
    TEST_UI_THREAD.with(|c| c.set(false));
}

fn journal_labels(db: &Database) -> Vec<String> {
    db.list_journal_since(0, 10_000)
        .unwrap()
        .into_iter()
        .filter_map(|r| r.label)
        .collect()
}

/// Hold the writer on another thread for `hold`; returns once it is held.
fn hold_writer(db: &Arc<Database>, hold: Duration) -> std::thread::JoinHandle<()> {
    let (held, is_held) = std::sync::mpsc::channel();
    let db = Arc::clone(db);
    let t = std::thread::spawn(move || {
        let _conn = db.lock_conn();
        held.send(()).unwrap();
        std::thread::sleep(hold);
    });
    is_held.recv().unwrap();
    t
}

#[test]
#[should_panic(expected = "Database::lock_conn on the UI thread")]
fn the_writer_is_never_taken_on_the_ui_thread() {
    let db = Database::open_in_memory().unwrap();
    on_ui();
    drop(db.lock_conn());
}

#[test]
#[should_panic(expected = "Database::read_conn on the UI thread")]
fn a_read_connection_is_never_taken_on_the_ui_thread() {
    let db = Database::open_in_memory().unwrap();
    on_ui();
    drop(db.read_conn());
}

/// Off the UI thread, and before the loop marks one, nothing is guarded.
#[test]
fn the_guard_is_quiet_off_the_ui_thread() {
    let db = Database::open_in_memory().unwrap();
    assert!(!on_ui_thread());
    drop(db.lock_conn());
    drop(db.read_conn());
}

/// The 2026-10-29 beach ball, as a test: the writer is held for a long time
/// (it was `memory_status`), and a UI-thread journal append must not wait.
#[test]
fn a_queued_journal_row_never_waits_for_the_writer() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let holder = hold_writer(&db, Duration::from_millis(400));
    on_ui();
    let t = Instant::now();
    for i in 0..100 {
        db.enqueue_journal("surface_switch", Some("memory"), None, Some(&format!("row {i}")), None);
    }
    let took = t.elapsed();
    off_ui();
    assert!(took < Duration::from_millis(10), "100 queued appends took {took:?} behind a held writer");
    holder.join().unwrap();
    assert!(db.flush_journal(), "the writer drains once the lock is free");
    let labels = journal_labels(&db);
    assert_eq!(labels.len(), 100, "every queued row lands, in one or a few batches");
    assert_eq!(labels.first().map(String::as_str), Some("row 0"), "in the order queued");
    assert_eq!(labels.last().map(String::as_str), Some("row 99"));
    assert_eq!(db.journal_dropped(), 0);
}

/// A writer held long enough to fill the queue costs the OLDEST rows, never
/// the newest, and the drop is counted.
#[test]
fn a_full_journal_queue_drops_its_oldest_rows() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    // Start the writer and let it go idle, so the batch it takes below is
    // the one that then blocks on the held lock.
    db.enqueue_journal("warm", None, None, Some("warm"), None);
    assert!(db.flush_journal());
    let holder = hold_writer(&db, Duration::from_millis(300));
    let n = journal::JOURNAL_QUEUE_CAP + 200;
    for i in 0..n {
        db.enqueue_journal("nav", Some("browser"), None, Some(&format!("row {i}")), None);
    }
    holder.join().unwrap();
    assert!(db.flush_journal());
    let dropped = db.journal_dropped() as usize;
    assert!(dropped > 0, "the queue is bounded");
    let labels = journal_labels(&db);
    assert_eq!(labels.len(), 1 + n - dropped, "written + dropped = queued");
    assert_eq!(labels.last().map(String::as_str), Some(format!("row {}", n - 1).as_str()), "the newest row survives");
    assert!(!labels.contains(&format!("row {}", 100)), "an old row went to make room");
}

/// The synchronous append still returns its row id and prunes as before.
#[test]
fn a_synchronous_append_still_returns_its_id() {
    let db = Database::open_in_memory().unwrap();
    let a = db.append_journal("nav", Some("browser"), None, Some("a"), None).unwrap();
    let b = db.append_journal("nav", Some("browser"), None, Some("b"), None).unwrap();
    assert!(b > a);
    assert_eq!(journal_labels(&db), vec!["a".to_string(), "b".to_string()]);
}

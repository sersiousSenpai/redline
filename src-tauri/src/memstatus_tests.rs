// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `memstatus.rs`: the backlog count's equivalence and plan, the single
//! flight, and the acceptance test for the 2026-10-29 beach ball — status
//! reads on three threads never make the journal writer wait.

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Barrier;

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("redline-memstatus-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A lake with every shape the backlog count distinguishes: user, agent and
/// unclassified prompts; embedded, stale-hash and other-model embeddings;
/// browse pages sharing a content hash, and empty ones.
fn seed(db: &Database, prompts: usize, pages: usize) {
    let conn = db.lock_conn();
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..prompts {
        let role = match i % 5 {
            0 => Some("agent"),
            1 => None,
            _ => Some("user"),
        };
        tx.execute(
            "INSERT INTO prompts (ts, source, surface, role, body, body_hash) VALUES (?1, 'hook', 'plan', ?2, ?3, ?4)",
            params![i as i64, role, format!("prompt body {i}"), format!("ph{i}")],
        )
        .unwrap();
        let id = tx.last_insert_rowid();
        // Two thirds embedded under model `m`, a few of them on a stale hash;
        // every other one under model `n`.
        let hash = if i % 7 == 0 { format!("stale{i}") } else { format!("ph{i}") };
        if i % 3 != 0 {
            embed(&tx, "prompt", id, "m", &hash);
        }
        if i % 2 == 0 {
            embed(&tx, "prompt", id, "n", &format!("ph{i}"));
        }
    }
    for i in 0..pages {
        // Every hash twice; every 11th page empty.
        let hash = format!("bh{}", i / 2);
        let text = if i % 11 == 0 { String::new() } else { format!("page text {i}") };
        tx.execute(
            "INSERT INTO browse_events (ts, action, url, text, context_hash) VALUES (?1, 'navigate', 'https://x.test/', ?2, ?3)",
            params![i as i64, text, hash],
        )
        .unwrap();
        let id = tx.last_insert_rowid();
        if i % 4 == 1 {
            embed(&tx, "browse_event", id, "m", &hash);
        }
    }
    tx.commit().unwrap();
}

fn embed(conn: &Connection, kind: &str, target: i64, model: &str, hash: &str) {
    conn.execute(
        "INSERT INTO embeddings (target_kind, target_id, chunk_ix, char_start, char_len, dim, scale, vec, model, source_hash, created_at)
         VALUES (?1, ?2, 0, 0, 1, 1, 1.0, x'00', ?3, ?4, 0)",
        params![kind, target, model, hash],
    )
    .unwrap();
}

/// The rewrite answers exactly what `PolisStore::embedding_stats` answers.
#[test]
fn pending_matches_the_store_count() {
    let db = Database::open_in_memory().unwrap();
    seed(&db, 300, 200);
    for model in ["m", "n", "absent"] {
        let ours = embedding_stats(&db.lock_conn(), model).unwrap();
        let store = db.embedding_stats(model).unwrap();
        assert_eq!(ours, store, "model {model}");
    }
    assert!(pending_embeddings(&db.lock_conn(), "m").unwrap() > 0, "the fixture has a backlog");
}

/// The browse half is ONE list built once, not a subquery per page; the
/// prompt half reaches `embeddings` by its target index.
#[test]
fn the_backlog_count_builds_its_hash_list_once() {
    let db = Database::open_in_memory().unwrap();
    let plan = db.explain_query_plan(&PENDING_SQL.replace("?1", "'m'")).unwrap();
    assert_eq!(plan.matches("CORRELATED").count(), 1, "only the prompt half correlates: {plan}");
    assert!(plan.contains("LIST SUBQUERY"), "the browse half is a NOT IN list: {plan}");
    assert!(plan.contains("SEARCH e USING INDEX idx_embeddings_target (target_kind=? AND target_id=?)"), "{plan}");
}

/// Callers at once share one computation, and an answer is reused until
/// something commits.
#[test]
fn concurrent_callers_share_one_computation() {
    let dir = scratch("flight");
    let db = Arc::new(Database::open(&dir.join("redline.db")).unwrap());
    seed(&db, 500, 300);
    let cache = Arc::new(MemoryStatusCache::default());
    let gate = Arc::new(Barrier::new(3));
    let answers: Vec<_> = (0..3)
        .map(|_| {
            let (db, cache, gate) = (Arc::clone(&db), Arc::clone(&cache), Arc::clone(&gate));
            std::thread::spawn(move || {
                gate.wait();
                cache.get(&db).unwrap()
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect();
    assert!(answers.windows(2).all(|w| w[0] == w[1]));
    // The first answer may have written the chain anchor (a commit), so the
    // next call may compute once more; after that, nothing commits.
    let _ = cache.get(&db).unwrap();
    let settled = cache.computes.load(Ordering::SeqCst);
    assert!(settled <= 2, "three callers at once ran {settled} computations");
    let again = cache.get(&db).unwrap();
    assert_eq!(cache.computes.load(Ordering::SeqCst), settled, "reused within the TTL");
    assert_eq!(again["itemCount"], answers[0]["itemCount"]);
    // A memory write invalidates it.
    db.set_setting("memstatus.test", "1").unwrap();
    let _ = cache.get(&db).unwrap();
    assert_eq!(cache.computes.load(Ordering::SeqCst), settled + 1, "a commit invalidates the answer");
    let _ = std::fs::remove_dir_all(&dir);
}

/// With the writer held for a long time, the status still answers: none of
/// its reads touch the shared connection.
#[test]
fn status_reads_never_wait_for_the_writer() {
    let dir = scratch("nowriter");
    let db = Arc::new(Database::open(&dir.join("redline.db")).unwrap());
    seed(&db, 200, 100);
    let cache = Arc::new(MemoryStatusCache::default());
    // The first call anchors the chain verify (its one write).
    let _ = cache.get(&db).unwrap();
    let held = db.lock_conn();
    let (done, finished) = std::sync::mpsc::channel();
    {
        let (db, cache) = (Arc::clone(&db), Arc::clone(&cache));
        std::thread::spawn(move || {
            db.journal_dropped(); // keep the clone alive in the thread
            let fresh = MemoryStatusCache::default();
            let _ = done.send((fresh.get(&db).is_ok(), cache.get(&db).is_ok()));
        });
    }
    let answer = finished.recv_timeout(Duration::from_secs(5));
    drop(held);
    assert_eq!(answer.ok(), Some((true, true)), "a status read waited for the held writer");
    let _ = std::fs::remove_dir_all(&dir);
}

/// ACCEPTANCE: `memory_status` on three threads at once, every call a fresh
/// computation (a journal commit lands between each), while a writer appends
/// journal rows. The writer's wait for the lock stays under 10 ms.
#[test]
fn three_status_threads_never_hold_up_the_journal_writer() {
    let dir = scratch("acceptance");
    let db = Arc::new(Database::open(&dir.join("redline.db")).unwrap());
    seed(&db, 3000, 1500);
    let stop = Arc::new(AtomicBool::new(false));
    let computed = Arc::new(AtomicUsize::new(0));
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let (db, stop, computed) = (Arc::clone(&db), Arc::clone(&stop), Arc::clone(&computed));
            std::thread::spawn(move || {
                // A cache of its own per thread: three computations at once,
                // the stampede the single flight now prevents.
                let cache = MemoryStatusCache::default();
                while !stop.load(Ordering::Relaxed) {
                    cache.get(&db).unwrap();
                    computed.fetch_add(1, Ordering::Relaxed);
                }
            })
        })
        .collect();
    let mut worst = Duration::ZERO;
    let mut appends = 0;
    let until = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < until {
        let t = Instant::now();
        let conn = db.lock_conn();
        worst = worst.max(t.elapsed());
        conn.execute(
            "INSERT INTO context_journal (ts, kind, surface_kind) VALUES (?1, 'surface_switch', 'memory')",
            params![appends],
        )
        .unwrap();
        drop(conn);
        appends += 1;
        std::thread::sleep(Duration::from_millis(2));
    }
    stop.store(true, Ordering::Relaxed);
    for r in readers {
        r.join().unwrap();
    }
    let computed = computed.load(Ordering::Relaxed);
    assert!(computed >= 3, "the status threads ran ({computed} computations)");
    assert!(appends > 50, "the writer ran ({appends} appends)");
    assert!(worst < Duration::from_millis(10), "the journal writer waited {worst:?} for the lock");
    eprintln!("acceptance: {appends} appends, {computed} status computations, worst lock wait {worst:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Before/after timing on a COPY of a real database (never the live one):
/// `MEMSTATUS_DB=/path/to/copy.db cargo test --lib memory_status_timing -- --ignored --nocapture`.
#[test]
#[ignore]
fn memory_status_timing_on_a_copy() {
    let Ok(path) = std::env::var("MEMSTATUS_DB") else { return };
    let db = Database::open(Path::new(&path)).unwrap();
    let model: String = db
        .lock_conn()
        .query_row("SELECT model FROM embeddings GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1", [], |r| r.get(0))
        .unwrap_or_default();
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    for round in 0..2 {
        // The old body, call for call, every read on the shared writer.
        let t = Instant::now();
        let _ = db.max_ledger_seq();
        let _ = db.last_run_seq_to();
        let _ = db.latest_class_run();
        let _ = db.verify_ledger_chain_incremental();
        let _ = db.compaction_stats();
        let _ = db.count_pending_class_proposals();
        let _ = db.corpus_composition();
        let _ = db.gist_source_counts();
        let _ = db.archive_stats();
        let _ = db.prefetch_hit_rate();
        let t_old_embed = Instant::now();
        let old = db.embedding_stats(&model).unwrap();
        let old_embed = ms(t_old_embed);
        let old_total = ms(t);
        let t = Instant::now();
        let new = embedding_stats(&db.lock_conn(), &model).unwrap();
        let new_embed = ms(t);
        assert_eq!(old, new);
        let cache = MemoryStatusCache::default();
        let t = Instant::now();
        cache.get(&db).unwrap();
        let cold = ms(t);
        let t = Instant::now();
        cache.get(&db).unwrap();
        let cached = ms(t);
        db.set_setting("memstatus.timing", &round.to_string()).unwrap();
        let t = Instant::now();
        cache.get(&db).unwrap();
        let recompute = ms(t);
        eprintln!(
            "round {round} model {model} (chunks, pending) {new:?}: OLD total {old_total:.1} ms (embedding_stats {old_embed:.1} ms) | \
             NEW embedding_stats {new_embed:.1} ms, status cold {cold:.1} ms, cached {cached:.2} ms, after a commit {recompute:.1} ms"
        );
    }
}

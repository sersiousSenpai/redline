// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Live filesystem watching for the project-folder explorer.
//!
//! The explorer lazy-loads one directory level at a time (see `fsbrowse`). To
//! get VSCode-style real-time updates, each *expanded* directory in the tree is
//! watched **non-recursively**: when an entry inside it is created, removed, or
//! renamed, a debounced `fs-change` event fires and the frontend re-fetches just
//! that level. Watching only what's open (rather than recursively watching the
//! whole root) keeps us off the churn of `node_modules`, `.git`, and build dirs.
//!
//! A single debouncer holds all the watches; a refcount map keeps
//! `watch_dir`/`unwatch_dir` balanced when the same path is mounted more than
//! once (e.g. a root that is also reachable as a child).
//!
//! Adding or removing a watch restarts the FSEvents stream, which is slow, so
//! the commands only count and the stream work happens on one `fs-watch`
//! thread in the order the commands arrived. Making the commands `(async)`
//! instead would let a quick unmount's `unwatch_dir` overtake its mount's
//! `watch_dir` and leak the watch.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Debounce window: long enough to coalesce a save's burst of events into one
/// callback, short enough to feel instant.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Payload for the `fs-change` event: the directory whose listing may have
/// changed. The frontend routes it to the matching mounted tree node.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChange {
    path: String,
}

/// A refcount of watched paths plus the queue to the thread that owns the
/// debouncer. Managed as Tauri state so it outlives individual command calls
/// and the watches persist while the tree is open.
pub struct FsWatcher {
    counts: Arc<Mutex<HashMap<PathBuf, usize>>>,
    stream: mpsc::Sender<StreamOp>,
}

/// One FSEvents stream change for the `fs-watch` thread.
enum StreamOp {
    Watch(PathBuf),
    Unwatch(PathBuf),
}

impl FsWatcher {
    /// Build the debouncer with a callback that emits one `fs-change` per
    /// affected directory. For each changed path we notify both its parent (a
    /// created/deleted entry changes the parent's listing) and the path itself
    /// (a watched dir may report events against its own path); the frontend
    /// ignores any path it isn't currently showing.
    pub fn new(app: AppHandle) -> Self {
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let events = match res {
                Ok(events) => events,
                Err(_) => return,
            };
            let mut dirs: HashSet<PathBuf> = HashSet::new();
            for event in events {
                if let Some(parent) = event.path.parent() {
                    dirs.insert(parent.to_path_buf());
                }
                dirs.insert(event.path);
            }
            for dir in dirs {
                let _ = app.emit(
                    "fs-change",
                    FsChange {
                        path: dir.to_string_lossy().into_owned(),
                    },
                );
            }
        })
        .expect("failed to create filesystem debouncer");

        let counts = Arc::new(Mutex::new(HashMap::new()));
        let (stream, ops) = mpsc::channel();
        let owned = counts.clone();
        std::thread::Builder::new()
            .name("fs-watch".into())
            .spawn(move || run_stream(debouncer, ops, &owned))
            .expect("failed to start the filesystem watch thread");
        Self { counts, stream }
    }
}

/// The `fs-watch` thread: apply each stream change in arrival order.
fn run_stream(
    mut debouncer: Debouncer<RecommendedWatcher>,
    ops: mpsc::Receiver<StreamOp>,
    counts: &Mutex<HashMap<PathBuf, usize>>,
) {
    for op in ops {
        match op {
            StreamOp::Watch(path) => {
                if let Err(e) = debouncer.watcher().watch(&path, RecursiveMode::NonRecursive) {
                    tracing::debug!(path = %path.display(), error = %e, "could not watch directory");
                    // Roll the count back so a later mount can retry the watch.
                    release(&mut counts.lock().unwrap(), &path);
                }
            }
            StreamOp::Unwatch(path) => {
                let _ = debouncer.watcher().unwatch(&path);
            }
        }
    }
}

/// Record a reference to `path`; returns true when this is the first reference
/// and the caller should start a watch. Pulled out so the refcount logic can be
/// unit-tested without touching the filesystem.
fn acquire(counts: &mut HashMap<PathBuf, usize>, path: &PathBuf) -> bool {
    let count = counts.entry(path.clone()).or_insert(0);
    *count += 1;
    *count == 1
}

/// Drop a reference to `path`; returns true when the last reference is gone and
/// the caller should stop watching. Unknown paths and extra releases are no-ops.
fn release(counts: &mut HashMap<PathBuf, usize>, path: &PathBuf) -> bool {
    match counts.get_mut(path) {
        Some(count) => {
            *count -= 1;
            if *count == 0 {
                counts.remove(path);
                true
            } else {
                false
            }
        }
        None => false,
    }
}

/// Start watching a directory for changes (or bump its refcount if already
/// watched). Called by each expanded tree node when it mounts. Best-effort,
/// like the frontend that calls it: a path that can't be watched rolls its
/// count back on the `fs-watch` thread.
#[tauri::command]
pub fn watch_dir(path: String, state: tauri::State<'_, FsWatcher>) {
    let pb = PathBuf::from(path);
    let mut counts = state.counts.lock().unwrap();
    if acquire(&mut counts, &pb) {
        let _ = state.stream.send(StreamOp::Watch(pb));
    }
}

/// Stop watching a directory (or just drop its refcount if other nodes still
/// reference it). Called when a tree node unmounts. Best-effort: a since-deleted
/// path that can't be unwatched is not an error.
#[tauri::command]
pub fn unwatch_dir(path: String, state: tauri::State<'_, FsWatcher>) {
    let pb = PathBuf::from(path);
    let mut counts = state.counts.lock().unwrap();
    if release(&mut counts, &pb) {
        let _ = state.stream.send(StreamOp::Unwatch(pb));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_signals_only_first_reference() {
        let mut counts = HashMap::new();
        let p = PathBuf::from("/tmp/x");
        assert!(acquire(&mut counts, &p), "first acquire should start a watch");
        assert!(!acquire(&mut counts, &p), "second acquire should not");
        assert_eq!(counts.get(&p), Some(&2));
    }

    #[test]
    fn release_signals_only_last_reference_and_clears_entry() {
        let mut counts = HashMap::new();
        let p = PathBuf::from("/tmp/x");
        acquire(&mut counts, &p);
        acquire(&mut counts, &p);
        assert!(!release(&mut counts, &p), "still referenced, keep watching");
        assert!(release(&mut counts, &p), "last release should stop the watch");
        assert!(!counts.contains_key(&p), "entry removed at zero");
    }

    #[test]
    fn release_of_unknown_or_extra_is_noop() {
        let mut counts = HashMap::new();
        let p = PathBuf::from("/tmp/x");
        assert!(!release(&mut counts, &p), "unknown path releases to nothing");
        acquire(&mut counts, &p);
        assert!(release(&mut counts, &p));
        assert!(!release(&mut counts, &p), "extra release stays a no-op");
    }

    #[test]
    fn the_stream_thread_rolls_a_failed_watch_back() {
        let debouncer = new_debouncer(DEBOUNCE, |_: DebounceEventResult| {}).unwrap();
        let counts = Mutex::new(HashMap::new());
        let missing = std::env::temp_dir().join(format!("redline-fswatch-{}", uuid::Uuid::new_v4()));
        assert!(acquire(&mut counts.lock().unwrap(), &missing));
        let (stream, ops) = mpsc::channel();
        stream.send(StreamOp::Watch(missing.clone())).unwrap();
        drop(stream);
        run_stream(debouncer, ops, &counts);
        assert!(counts.lock().unwrap().is_empty(), "a later mount can retry the watch");
    }
}

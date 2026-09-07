// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Cached, single-flight probes of external binaries.
//!
//! Two costs live here, and both used to be paid over and over on the boot
//! path:
//!
//! 1. **Resolution.** When neither an override nor a well-known install
//!    location answers, `claude`/`codex` are located by asking an *interactive
//!    login shell* (`$SHELL -ilc "command -v x"`). That sources the user's rc
//!    files — hundreds of milliseconds on a real machine, and a child process
//!    macOS attributes to Redline for TCC purposes.
//! 2. **Capability.** "Is this codex new enough" is answered by running
//!    `codex --help` and reading the subcommand list. Another child process,
//!    and the honest answer to a question that only changes when the binary on
//!    disk changes.
//!
//! Neither answer changes while the app is running unless the *file* changes,
//! so both are cached — resolution by name, capability by the binary's
//! modification identity (path + mtime + length). A re-install at the same
//! path re-probes; a hundred callers on the same unchanged binary do not.
//!
//! **Single-flight matters as much as the cache.** Boot, the settings panel, a
//! window-focus refresh and a launch attempt can all ask at once; without it
//! the "cache" merely means four concurrent `--help` children instead of four
//! sequential ones. Each key holds a `OnceLock`, and `get_or_init` blocks the
//! losers until the winner's probe returns — so N concurrent callers spawn one
//! child and all get its answer. The map lock is never held across the probe.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

/// What makes a binary "the same binary" for caching purposes. Length is in
/// there with mtime because a package manager that preserves timestamps still
/// changes the size, and the pair is far cheaper than hashing megabytes.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    path: String,
    mtime: Option<SystemTime>,
    len: u64,
}

fn identity(bin: &str) -> Key {
    let meta = std::fs::metadata(bin).ok();
    Key {
        path: bin.to_string(),
        // A bare name (`codex`, resolved off PATH) has no metadata — it keys
        // on the name alone, which is the best identity available and still
        // collapses the repeated probes this exists to stop.
        mtime: meta.as_ref().and_then(|m| m.modified().ok()),
        len: meta.as_ref().map(|m| m.len()).unwrap_or(0),
    }
}

/// The shape a caller declares as a `static OnceLock<Cache<T>>` and hands to
/// `cached` / `forget`. Public so each probe owns its own cache in the module
/// that defines the probe, rather than this module growing a registry of
/// other people's answers.
pub type Cache<T> = Mutex<HashMap<Key, Arc<OnceLock<T>>>>;

/// Probe `bin` with `f`, at most once per (path, mtime, length).
///
/// Concurrent callers on the same key share one execution: the first runs `f`,
/// the rest block inside `get_or_init` and receive its result. `f` runs
/// *outside* the map lock, so a slow probe of one binary never blocks a probe
/// of another.
pub fn cached<T: Clone + Send + Sync + 'static>(
    cache: &'static OnceLock<Cache<T>>,
    bin: &str,
    f: impl FnOnce() -> T,
) -> T {
    let map = cache.get_or_init(|| Mutex::new(HashMap::new()));
    let key = identity(bin);
    let cell = {
        let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(OnceLock::new()))
            .clone()
    };
    cell.get_or_init(f).clone()
}

/// Forget every cached answer for `bin`. Called when the user points Redline
/// at a different binary ("Locate it…"): the new path is a different key
/// anyway, but an explicit re-pick of the *same* path is the user saying "look
/// again", and being told the stale answer would be maddening.
pub fn forget<T: Send + Sync + 'static>(cache: &'static OnceLock<Cache<T>>, bin: &str) {
    let Some(map) = cache.get() else { return };
    let key = identity(bin);
    map.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
}

/// `$SHELL -ilc "command -v <name>"`, cached per name for the life of the
/// process.
///
/// The last resort of both binary resolvers, and by far the most expensive
/// layer: an *interactive login* shell sources the user's full rc chain. The
/// answer depends on those rc files, which do not change under a running app —
/// and a user who edits them and wants a re-probe has a much bigger lever
/// available (relaunch) than we should pay for on every call.
///
/// Returns the resolved absolute path, or `None` when the shell couldn't find
/// it (the caller then falls back to the bare name).
pub fn login_shell_which(name: &str) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    static INFLIGHT: OnceLock<Mutex<HashMap<String, Arc<OnceLock<Option<String>>>>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(name)
        .cloned()
    {
        return hit;
    }
    // Same single-flight shape as `cached`, keyed by name: a boot that probes
    // `claude` and `codex` at once must not serialize, but two probes of
    // `codex` must not spawn two login shells.
    let inflight = INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()));
    let cell = {
        let mut guard = inflight.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(OnceLock::new()))
            .clone()
    };
    let answer = cell.get_or_init(|| run_login_shell_which(name)).clone();
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(name.to_string(), answer.clone());
    answer
}

fn run_login_shell_which(name: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    std::process::Command::new(&shell)
        .args(["-ilc", &format!("command -v {name}")])
        // An interactive rc that reads stdin must hit EOF, not hang.
        .stdin(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            // Last line wins: an rc that prints a banner puts noise first, and
            // only the line that is actually a file is an answer.
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| Path::new(line).is_file())
                .map(str::to_string)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_CACHE: OnceLock<Cache<u32>> = OnceLock::new();

    #[test]
    fn a_repeat_probe_of_the_same_binary_runs_once() {
        let runs = AtomicUsize::new(0);
        let bin = "/bin/sh";
        forget(&TEST_CACHE, bin);
        let probe = || {
            runs.fetch_add(1, Ordering::SeqCst);
            42u32
        };
        assert_eq!(cached(&TEST_CACHE, bin, probe), 42);
        assert_eq!(
            cached(&TEST_CACHE, bin, || {
                runs.fetch_add(1, Ordering::SeqCst);
                99
            }),
            42,
            "the second caller must get the cached answer, not re-probe"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_probes_share_one_execution() {
        static SHARED: OnceLock<Cache<u32>> = OnceLock::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let bin = "/bin/cat";
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let runs = runs.clone();
                scope.spawn(move || {
                    cached(&SHARED, bin, || {
                        runs.fetch_add(1, Ordering::SeqCst);
                        // Long enough that the other seven are certainly
                        // inside `get_or_init` while this one works.
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        7u32
                    })
                });
            }
        });
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "eight concurrent callers must spawn one probe, not eight"
        );
    }

    #[test]
    fn different_binaries_do_not_share_an_answer() {
        static TWO: OnceLock<Cache<u32>> = OnceLock::new();
        assert_eq!(cached(&TWO, "/bin/sh", || 1), 1);
        assert_eq!(cached(&TWO, "/bin/echo", || 2), 2);
    }

    #[test]
    fn forget_makes_the_next_call_probe_again() {
        static F: OnceLock<Cache<u32>> = OnceLock::new();
        let bin = "/bin/echo";
        assert_eq!(cached(&F, bin, || 1), 1);
        forget(&F, bin);
        assert_eq!(cached(&F, bin, || 2), 2);
    }

    #[test]
    fn a_missing_binary_still_keys_and_caches() {
        static M: OnceLock<Cache<u32>> = OnceLock::new();
        let bin = "/definitely/not/a/real/binary";
        assert_eq!(cached(&M, bin, || 3), 3);
        assert_eq!(cached(&M, bin, || 4), 3);
    }

    #[test]
    fn login_shell_which_answers_the_same_thing_twice() {
        // `sh` exists on every machine this builds for; the assertion that
        // matters is that a second call is consistent (and, in practice,
        // free — it never reaches a shell).
        let first = login_shell_which("sh");
        let second = login_shell_which("sh");
        assert_eq!(first, second);
        if let Some(path) = first {
            assert!(Path::new(&path).is_file());
        }
    }

    #[test]
    fn login_shell_which_reports_none_for_a_binary_that_cannot_exist() {
        assert_eq!(
            login_shell_which("redline-definitely-not-a-real-binary"),
            None
        );
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The raw-wire inspector: what the stream ACTUALLY said, for one turn.
//!
//! The meter (`meter.rs`) is a summary. When a turn does something surprising
//! — the wrong model answered, a tool was denied, the reply stopped early —
//! the summary can only say *that* it happened. This says what came over the
//! wire.
//!
//! Three properties keep it inside `docs/perf-budget.md` Rules 2 and 3:
//!
//! 1. **Off by default.** Every reader calls [`capture`] on every line, and
//!    when the inspector is off that is one relaxed atomic load and a return.
//!    Nothing is buffered, so an app that never opens the pane pays nothing.
//! 2. **Bounded when on.** A ring of at most [`RING_LINES`] lines /
//!    [`RING_BYTES`], oldest dropped first, per turn. Turning the inspector
//!    off frees every ring.
//! 3. **Never emitted per line.** The frontend PULLS with `inspect_read`; the
//!    backend pushes nothing. A devtools pane that polls on demand cannot
//!    flood the renderer the way a per-line `app.emit` would.
//!
//! ### The always-available facts come from the CLI, not from our argv
//!
//! The plan for this called for recording the resolved argv, the resumed
//! session id and the effective seat flags at each spawn site. The
//! `system`/`init` line already carries all of it — `cwd`, `model`,
//! `permissionMode`, the effective `tools` list and the session id — and it
//! carries what the CLI actually *resolved*, not what we asked for. Those are
//! not the same thing when a flag is rejected or a fallback fires, and the
//! resolved form is the one worth showing. So `init` is retained even when
//! the ring is off, at no per-site plumbing cost.
//!
//! ### Redaction is mandatory
//!
//! The bridge prompts teach agents to pass the daemon token via curl's
//! `--variable` / `--expand-header`, so a token value should never appear on
//! the wire — but "should never" is not a guarantee worth showing a user's
//! screen-share. [`redact`] removes the live daemon token and any
//! `Authorization:` header text before anything is stored, and
//! `redaction_is_not_optional` pins it.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Lines kept per turn while the inspector is on.
pub const RING_LINES: usize = 500;
/// …and the byte ceiling, whichever binds first.
pub const RING_BYTES: usize = 256 * 1024;
/// One line's own cap. A tool result can be a whole file.
const LINE_CAP: usize = 8 * 1024;
/// How far into a line the `init` probe looks. See [`capture`].
const INIT_SCAN_CHARS: usize = 512;

static ON: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Ring {
    lines: VecDeque<String>,
    bytes: usize,
    /// The turn's `system`/`init` line, retained whether or not the ring is
    /// live — the cheap always-available facts.
    init: Option<String>,
    /// Lines dropped to stay inside the caps, so the pane can say so rather
    /// than quietly showing a prefix.
    dropped: u64,
}

fn rings() -> &'static Mutex<HashMap<String, Ring>> {
    static RINGS: OnceLock<Mutex<HashMap<String, Ring>>> = OnceLock::new();
    RINGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key_of(surface: &str, key: &str) -> String {
    format!("{surface}:{key}")
}

/// Case-insensitive substring search that allocates nothing.
///
/// The obvious `to_lowercase().find(..)` copies the WHOLE line once per
/// iteration, and these lines can be a tool result the size of a file. The
/// needle is pure ASCII, and a UTF-8 continuation byte is always >= 0x80, so
/// an ASCII match can only begin on a char boundary — the returned index is
/// always safe to slice at.
fn find_ci(hay: &str, needle_lower: &[u8], from: usize) -> Option<usize> {
    let h = hay.as_bytes();
    if needle_lower.is_empty() || h.len() < needle_lower.len() {
        return None;
    }
    (from..=h.len() - needle_lower.len()).find(|&i| {
        h[i..i + needle_lower.len()]
            .iter()
            .zip(needle_lower)
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

/// Strip anything that must never render, whatever the pane is showing.
///
/// The daemon token is a 64-hex string that grants write access to the local
/// API; an `Authorization:` header value is the same secret in transit. Both
/// are removed by VALUE, not by pattern-matching a shape, so a token that
/// appears in an unexpected position is caught too.
pub fn redact(line: &str) -> String {
    let mut out = line.replace(crate::auth::daemon_token(), "<redacted-token>");
    // Any `Authorization: …` run, however it was quoted, up to the closing
    // quote or the end of the fragment. The scan resumes AFTER the replacement
    // rather than restarting: the replacement text contains no `authorization:`
    // (no colon follows), so it cannot re-match, but resuming keeps this
    // linear in the line rather than quadratic in the number of headers.
    let mut from = 0usize;
    while let Some(i) = find_ci(&out, b"authorization:", from) {
        let rest = &out[i..];
        let end = rest
            .char_indices()
            .skip("authorization:".len())
            .find(|(_, c)| *c == '"' || *c == '\'' || *c == '\\')
            .map(|(j, _)| j)
            .unwrap_or(rest.len());
        const MARK: &str = "<redacted-authorization>";
        out = format!("{}{MARK}{}", &out[..i], &rest[end..]);
        from = i + MARK.len();
    }
    out
}

/// Fold one raw stream line in. A no-op when the inspector is off, EXCEPT for
/// the `system`/`init` line — which is one bounded string per turn and is what
/// makes the pane useful the moment it opens rather than only for the next
/// turn.
pub fn capture(surface: &str, key: &str, line: &str) {
    let on = ON.load(Ordering::Relaxed);
    // Cheap first, expensive second. When the inspector is off this runs on
    // EVERY line of EVERY turn, so the only work it may do is a bounded scan
    // of the head — an `init` line declares its subtype in the first field or
    // two, and a tool result can be a whole file. A shape that ever hid
    // `subtype` past the head would cost the pane its always-available line,
    // which is a degradation, not a break.
    let head = match line.char_indices().nth(INIT_SCAN_CHARS) {
        Some((i, _)) => &line[..i],
        None => line,
    };
    let is_init = head.contains("\"subtype\":\"init\"") || head.contains("\"subtype\": \"init\"");
    if !on && !is_init {
        return;
    }
    // Cap BEFORE redacting: redaction walks the string, and there is no reason
    // to walk a megabyte of tool result only to throw all but 8 KB away.
    let capped: String = line.chars().take(LINE_CAP).collect();
    let redacted = redact(&capped);
    let mut map = rings().lock().unwrap();
    let ring = map.entry(key_of(surface, key)).or_default();
    if is_init {
        // Every turn re-emits `init`, so this is also the per-turn reset: the
        // pane shows THIS turn's wire, not an accumulation across the thread.
        ring.lines.clear();
        ring.bytes = 0;
        ring.dropped = 0;
        ring.init = Some(redacted.clone());
        if !ON.load(Ordering::Relaxed) {
            return;
        }
    }
    ring.bytes += redacted.len();
    ring.lines.push_back(redacted);
    while ring.lines.len() > RING_LINES || ring.bytes > RING_BYTES {
        match ring.lines.pop_front() {
            Some(old) => {
                ring.bytes = ring.bytes.saturating_sub(old.len());
                ring.dropped += 1;
            }
            None => break,
        }
    }
}

/// What one turn's wire looked like.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectView {
    /// Whether capture is currently on — the pane renders its own state from
    /// the backend's, never from a local guess.
    pub on: bool,
    /// The turn's `system`/`init` line, verbatim (redacted). Present even when
    /// capture is off.
    pub init: Option<String>,
    pub lines: Vec<String>,
    /// Lines evicted by the caps. Non-zero means what you see is a tail.
    pub dropped: u64,
}

/// Turn capture on or off. Turning it OFF frees every ring — the buffer only
/// exists while somebody is looking at it.
#[tauri::command]
pub fn inspect_set(on: bool) -> bool {
    ON.store(on, Ordering::Relaxed);
    if !on {
        let mut map = rings().lock().unwrap();
        for ring in map.values_mut() {
            ring.lines.clear();
            ring.bytes = 0;
            ring.dropped = 0;
            // `init` stays: it is one bounded line and it is what the pane
            // shows before the next turn starts.
        }
    }
    on
}

#[tauri::command]
pub fn inspect_read(surface: String, key: String) -> InspectView {
    let map = rings().lock().unwrap();
    let on = ON.load(Ordering::Relaxed);
    match map.get(&key_of(&surface, &key)) {
        Some(ring) => InspectView {
            on,
            init: ring.init.clone(),
            lines: ring.lines.iter().cloned().collect(),
            dropped: ring.dropped,
        },
        None => InspectView {
            on,
            ..InspectView::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tests share one process-global ring map and the global on/off flag.
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// The one property this module is not allowed to get wrong. A devtools
    /// pane is exactly the thing a user screen-shares.
    /// The inspector is only trustworthy if it sees the WHOLE wire. A reader
    /// that folds the meter but skips `capture` shows a pane that quietly
    /// omits that surface — worse than having no pane, because the omission
    /// looks like "nothing happened".
    #[test]
    fn every_reader_captures_the_wire() {
        const READERS: &[(&str, &str)] = &[
            ("browse.rs", include_str!("browse.rs")),
            ("linked.rs", include_str!("linked.rs")),
            ("mission.rs", include_str!("mission.rs")),
            ("memchat.rs", include_str!("memchat.rs")),
            ("companion.rs", include_str!("companion.rs")),
            ("draft_chat.rs", include_str!("draft_chat.rs")),
            ("fork.rs", include_str!("fork.rs")),
        ];
        for (name, src) in READERS {
            assert!(
                src.contains("crate::inspect::capture("),
                "{name} folds the meter but never captures the raw wire"
            );
        }
    }

    #[test]
    fn redaction_is_not_optional() {
        let _g = guard();
        let token = crate::auth::daemon_token();
        let line = format!(
            "{{\"type\":\"assistant\",\"cmd\":\"curl -H \\\"Authorization: Bearer {token}\\\" http://127.0.0.1:7676/v1/x\"}}"
        );
        let out = redact(&line);
        assert!(!out.contains(token), "the daemon token reached the pane");
        assert!(
            !out.to_lowercase().contains("bearer"),
            "the Authorization header text reached the pane"
        );
        assert!(out.contains("<redacted-authorization>"));

        // …and through the capture path, which is what actually stores it.
        inspect_set(true);
        capture("t", "redact", &line);
        let view = inspect_read("t".into(), "redact".into());
        assert!(view.lines.iter().all(|l| !l.contains(token)));
        inspect_set(false);
    }

    /// The redaction scan used to copy the whole line, lowercased, once per
    /// header found — on lines that can be a whole file. This pins the shape
    /// that replaced it: case-insensitive, multi-occurrence, terminating.
    #[test]
    fn redaction_is_case_insensitive_and_handles_repeats() {
        let line = r#"a AUTHORIZATION: Bearer x" b Authorization: Basic y" c"#;
        let out = redact(line);
        assert_eq!(out.matches("<redacted-authorization>").count(), 2);
        assert!(!out.to_lowercase().contains("bearer"));
        assert!(!out.to_lowercase().contains("basic"));
        assert!(out.contains("a ") && out.contains(" b ") && out.contains(" c"));
    }

    #[test]
    fn find_ci_matches_only_on_char_boundaries() {
        assert_eq!(find_ci("xxAUTHorization:", b"authorization:", 0), Some(2));
        assert_eq!(find_ci("héllo authorization:", b"authorization:", 0), Some(7));
        assert_eq!(find_ci("nothing here", b"authorization:", 0), None);
        // The `from` offset is honoured, which is what makes the loop linear.
        assert_eq!(find_ci("authorization:authorization:", b"authorization:", 1), Some(14));
    }

    #[test]
    fn off_by_default_and_freed_on_close() {
        let _g = guard();
        inspect_set(false);
        capture("t", "off", "{\"type\":\"stream_event\"}");
        assert!(inspect_read("t".into(), "off".into()).lines.is_empty());

        inspect_set(true);
        capture("t", "off", "{\"type\":\"stream_event\"}");
        assert_eq!(inspect_read("t".into(), "off".into()).lines.len(), 1);

        // Closing it frees the buffer rather than leaving it to grow unread.
        inspect_set(false);
        assert!(inspect_read("t".into(), "off".into()).lines.is_empty());
    }

    /// `init` is the always-available half: one bounded line per turn, kept
    /// even when capture is off, so the pane is useful the moment it opens.
    #[test]
    fn init_is_retained_with_capture_off_and_resets_the_ring() {
        let _g = guard();
        inspect_set(true);
        capture("t", "init", "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-opus-5\"}");
        capture("t", "init", "{\"type\":\"stream_event\"}");
        assert_eq!(inspect_read("t".into(), "init".into()).lines.len(), 2);

        // A second turn re-emits init — the pane shows THIS turn's wire.
        capture("t", "init", "{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-haiku-4-5\"}");
        let view = inspect_read("t".into(), "init".into());
        assert_eq!(view.lines.len(), 1, "the ring resets per turn");
        assert!(view.init.as_deref().unwrap().contains("haiku"));

        inspect_set(false);
        let view = inspect_read("t".into(), "init".into());
        assert!(view.lines.is_empty());
        assert!(view.init.is_some(), "init survives — it is one line");
    }

    #[test]
    fn the_ring_is_bounded_and_says_what_it_dropped() {
        let _g = guard();
        inspect_set(true);
        capture("t", "cap", "{\"type\":\"system\",\"subtype\":\"init\"}");
        for i in 0..(RING_LINES + 50) {
            capture("t", "cap", &format!("{{\"n\":{i}}}"));
        }
        let view = inspect_read("t".into(), "cap".into());
        assert_eq!(view.lines.len(), RING_LINES);
        assert!(view.dropped >= 50, "eviction is reported, not silent");
        // The TAIL is kept — the interesting end of a runaway turn.
        assert!(view.lines.last().unwrap().contains(&format!("{}", RING_LINES + 49)));
        inspect_set(false);
    }

    #[test]
    fn one_line_cannot_blow_the_budget_on_its_own() {
        let _g = guard();
        inspect_set(true);
        capture("t", "big", "{\"type\":\"system\",\"subtype\":\"init\"}");
        capture("t", "big", &"x".repeat(LINE_CAP * 4));
        let view = inspect_read("t".into(), "big".into());
        assert!(view.lines.iter().all(|l| l.chars().count() <= LINE_CAP));
        inspect_set(false);
    }
}

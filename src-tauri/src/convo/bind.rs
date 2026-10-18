// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Which transcript a dock terminal's conversation is, decided from the hooks
//! its CLI fires.
//!
//! Every attention hook POST names its terminal (`X-Redline-Terminal`) and
//! carries the session's `session_id` and `transcript_path`, so binding needs
//! no process walk. `SessionStart` says so first and says why (its `source`);
//! `UserPromptSubmit` and `Stop` confirm it, and bind on their own for an
//! install that predates the SessionStart hook or a session that started
//! before this daemon did.
//!
//! Measured in experiment (m), S1 (claude 2.1.302):
//! - all five sources fire; the payload is `session_id`, `transcript_path`,
//!   `source`, `cwd`, plus `model` on startup/compact. The transcript does
//!   not exist yet when `startup` or `fork` fires (it is created with the
//!   first prompt), so a not-yet-created path under the projects dir is
//!   accepted.
//! - `/clear` starts a new session id and a new transcript, which begins
//!   with the `/clear` command itself: a new epoch.
//! - `/compact` keeps both, and writes its `compact_boundary` into the same
//!   file: the epoch continues.
//! - `--resume <id>` fires `resume` with the same id and the same file. A
//!   resume to a *different* conversation inside a running terminal is a new
//!   epoch; resuming the bound one changes nothing.
//! - `--resume <id> --fork-session` fires `fork` with a new id and a new
//!   file: a new epoch.
//!
//! A `claude -p` started from inside a dock agent's Bash tool inherits the
//! terminal's id (experiment (l)). Its hooks carry `CLAUDE_CODE_ENTRYPOINT` =
//! `sdk-cli` (S2) in `X-Redline-Entrypoint`, and are ignored here, so it can
//! never steal the terminal's conversation.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Which CLI a terminal's conversation belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Harness {
    #[default]
    Claude,
    Codex,
}

impl Harness {
    pub fn as_str(self) -> &'static str {
        match self {
            Harness::Claude => "claude",
            Harness::Codex => "codex",
        }
    }
}

/// What a terminal is bound to.
#[derive(Debug, Clone, PartialEq)]
pub struct Binding {
    pub session_id: String,
    /// Where the conversation is read from: Claude's transcript, or the
    /// Codex launcher's app-server socket (empty when no server can be
    /// reached, and the terminal is the only view; `convo::codex`).
    pub transcript: PathBuf,
    pub epoch: u32,
    pub harness: Harness,
}

/// One hook fire, as binding reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fire {
    /// `startup` / `resume` / `clear` / `compact` / `fork` for SessionStart;
    /// `prompt` / `stop` for a confirming hook; `restore` for a pre-bind.
    /// Codex has no SessionStart hook of Redline's: a new thread on the
    /// bound one's own server (the TUI's `/new`) fires as `clear`.
    pub source: String,
    pub session_id: String,
    pub transcript: PathBuf,
    /// Only SessionStart may move a bound terminal to another conversation;
    /// a confirming hook that names a different one is still believed (an
    /// older install has no SessionStart), but as a new epoch.
    pub starts: bool,
    pub harness: Harness,
}

/// What a fire does to the binding.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// Already bound to this conversation.
    Same,
    /// Bound for the first time, or re-confirmed after a compact: same
    /// epoch, `bound` re-sent.
    Bind { epoch: u32 },
    /// A new transcript continues this terminal's conversation (`/clear`,
    /// `/resume` to another one, a fork): a divider, then the new epoch.
    NewEpoch { epoch: u32, reason: &'static str },
    /// A different session took the terminal over (claude was quit and run
    /// again): drop what the stage holds and start from this one.
    Reset { epoch: u32 },
}

/// The binding state machine: pure, so every transition is a table test.
pub fn step(current: Option<&Binding>, fire: &Fire) -> Step {
    let Some(current) = current else { return Step::Bind { epoch: 0 } };
    let next = current.epoch + 1;
    // The other CLI started in this terminal (one exited, the other ran):
    // nothing it says continues what the stage holds.
    if current.harness != fire.harness {
        return Step::Reset { epoch: next };
    }
    if current.session_id == fire.session_id {
        return if fire.source == "compact" || current.transcript != fire.transcript {
            Step::Bind { epoch: current.epoch }
        } else {
            Step::Same
        };
    }
    match fire.source.as_str() {
        "clear" => Step::NewEpoch { epoch: next, reason: "clear" },
        "fork" => Step::NewEpoch { epoch: next, reason: "fork" },
        // A fresh `claude` in a terminal that ran another one before.
        "startup" => Step::Reset { epoch: next },
        // `resume` (and `compact` under a new id, which the CLI hasn't been
        // seen to do), or a confirming hook that names another conversation.
        _ => Step::NewEpoch { epoch: next, reason: "resume" },
    }
}

/// The binding a fire leaves behind.
pub fn apply(fire: &Fire, step: &Step) -> Option<Binding> {
    let epoch = match step {
        Step::Same => return None,
        Step::Bind { epoch } | Step::NewEpoch { epoch, .. } | Step::Reset { epoch } => *epoch,
    };
    Some(Binding { session_id: fire.session_id.clone(), transcript: fire.transcript.clone(), epoch, harness: fire.harness })
}

/// Read a hook payload as a binding fire, or `None` when it can't bind: a
/// nested `sdk-cli` session, an event that names no session, or a transcript
/// path outside Claude Code's projects directory (the route is
/// unauthenticated, so nothing elsewhere is ever opened).
pub fn fire_from_hook(payload: &Value, entrypoint: Option<&str>, projects: &Path) -> Option<Fire> {
    if entrypoint == Some("sdk-cli") {
        return None;
    }
    let field = |key: &str| payload.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let (source, starts) = match field("hook_event_name")? {
        "SessionStart" => (field("source").unwrap_or("startup").to_string(), true),
        "UserPromptSubmit" => ("prompt".to_string(), false),
        "Stop" => ("stop".to_string(), false),
        _ => return None,
    };
    let session_id = field("session_id").filter(|id| crate::claude_proc::is_plain_session_id(id))?;
    let transcript = crate::term_attention::transcript_target(field("transcript_path")?, projects)?;
    Some(Fire { source, session_id: session_id.to_string(), transcript, starts, harness: Harness::Claude })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fire(source: &str, sid: &str, path: &str) -> Fire {
        Fire { source: source.into(), session_id: sid.into(), transcript: PathBuf::from(path), starts: true, harness: Harness::Claude }
    }

    fn bound(sid: &str, path: &str, epoch: u32) -> Binding {
        Binding { session_id: sid.into(), transcript: PathBuf::from(path), epoch, harness: Harness::Claude }
    }

    /// Every row is a measured or plausible transition (module note).
    #[test]
    fn the_bind_state_machine() {
        let a = bound("a", "/p/a.jsonl", 2);
        // First fire of any kind binds at epoch 0.
        for source in ["startup", "resume", "clear", "compact", "fork", "prompt", "stop", "restore"] {
            assert_eq!(step(None, &fire(source, "a", "/p/a.jsonl")), Step::Bind { epoch: 0 }, "{source}");
        }
        // The same conversation again: nothing, unless compact re-sends.
        assert_eq!(step(Some(&a), &fire("resume", "a", "/p/a.jsonl")), Step::Same);
        assert_eq!(step(Some(&a), &fire("prompt", "a", "/p/a.jsonl")), Step::Same);
        assert_eq!(step(Some(&a), &fire("startup", "a", "/p/a.jsonl")), Step::Same, "a restarted resume of the same id");
        assert_eq!(step(Some(&a), &fire("compact", "a", "/p/a.jsonl")), Step::Bind { epoch: 2 }, "compact keeps the epoch");
        assert_eq!(step(Some(&a), &fire("stop", "a", "/q/a.jsonl")), Step::Bind { epoch: 2 }, "a moved file rebinds in place");
        // Another conversation in the same terminal.
        assert_eq!(step(Some(&a), &fire("clear", "b", "/p/b.jsonl")), Step::NewEpoch { epoch: 3, reason: "clear" });
        assert_eq!(step(Some(&a), &fire("resume", "b", "/p/b.jsonl")), Step::NewEpoch { epoch: 3, reason: "resume" });
        assert_eq!(step(Some(&a), &fire("fork", "b", "/p/b.jsonl")), Step::NewEpoch { epoch: 3, reason: "fork" });
        assert_eq!(step(Some(&a), &fire("prompt", "b", "/p/b.jsonl")), Step::NewEpoch { epoch: 3, reason: "resume" });
        assert_eq!(step(Some(&a), &fire("startup", "b", "/p/b.jsonl")), Step::Reset { epoch: 3 });
        // What each step leaves bound.
        let f = fire("clear", "b", "/p/b.jsonl");
        assert_eq!(apply(&f, &Step::NewEpoch { epoch: 3, reason: "clear" }), Some(bound("b", "/p/b.jsonl", 3)));
        assert_eq!(apply(&f, &Step::Same), None);
    }

    /// Codex fires (`convo::codex`): a new thread on the same socket is the
    /// TUI's `/new`; the same thread on a new socket is a restore in place;
    /// and the other CLI taking the terminal over starts the stage again.
    #[test]
    fn codex_transitions() {
        let codex = |source: &str, sid: &str, socket: &str| Fire { harness: Harness::Codex, starts: false, ..fire(source, sid, socket) };
        let t = Binding { harness: Harness::Codex, ..bound("t", "/tmp/rlcx.a/server.sock", 1) };
        assert_eq!(step(Some(&t), &codex("prompt", "t", "/tmp/rlcx.a/server.sock")), Step::Same);
        assert_eq!(step(Some(&t), &codex("stop", "t", "/tmp/rlcx.b/server.sock")), Step::Bind { epoch: 1 }, "restored in this terminal");
        assert_eq!(step(Some(&t), &codex("clear", "u", "/tmp/rlcx.a/server.sock")), Step::NewEpoch { epoch: 2, reason: "clear" }, "/new");
        assert_eq!(step(Some(&t), &codex("prompt", "u", "/tmp/rlcx.b/server.sock")), Step::NewEpoch { epoch: 2, reason: "resume" });
        assert_eq!(step(Some(&bound("c", "/p/c.jsonl", 0)), &codex("prompt", "t", "")), Step::Reset { epoch: 1 }, "claude, then codex");
        assert_eq!(step(Some(&t), &fire("startup", "c", "/p/c.jsonl")), Step::Reset { epoch: 2 }, "codex, then claude");
        assert_eq!(apply(&codex("prompt", "t", ""), &Step::Bind { epoch: 0 }).unwrap().harness, Harness::Codex);
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rl-bind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("projects/-p")).unwrap();
        dir
    }

    #[test]
    fn a_hook_binds_only_a_top_level_session_under_the_projects_dir() {
        let root = scratch();
        let projects = root.join("projects");
        let path = projects.join("-p/s1.jsonl");
        let payload = |event: &str, path: &Path| {
            serde_json::json!({"hook_event_name": event, "source": "startup", "session_id": "s1", "transcript_path": path})
        };
        // SessionStart fires before the transcript exists (S1): accepted.
        let start = fire_from_hook(&payload("SessionStart", &path), Some("cli"), &projects).unwrap();
        assert_eq!((start.source.as_str(), start.starts), ("startup", true));
        assert!(start.transcript.ends_with("-p/s1.jsonl"));
        // An install without the entrypoint header still binds.
        assert!(fire_from_hook(&payload("UserPromptSubmit", &path), None, &projects).is_some_and(|f| f.source == "prompt" && !f.starts));
        assert_eq!(fire_from_hook(&payload("Stop", &path), None, &projects).unwrap().source, "stop");
        // A nested `claude -p` never binds.
        assert_eq!(fire_from_hook(&payload("SessionStart", &path), Some("sdk-cli"), &projects), None);
        // Nor does anything outside the projects dir, or an event that doesn't bind.
        assert_eq!(fire_from_hook(&payload("SessionStart", &root.join("s1.jsonl")), None, &projects), None);
        assert_eq!(fire_from_hook(&payload("Notification", &path), None, &projects), None);
        let mut bad = payload("SessionStart", &path);
        bad["session_id"] = "../x".into();
        assert_eq!(fire_from_hook(&bad, None, &projects), None);
        std::fs::remove_dir_all(root).unwrap();
    }
}

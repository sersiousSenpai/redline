// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A WARM `claude` per open chat room.
//!
//! A cold chat turn spawns `claude -p --resume`, which boots the CLI and
//! replays the whole transcript before the first token. A warm child is the
//! voice agent's transport (`voice.rs`): one persistent
//! `--input-format stream-json` process that takes each turn as a line on
//! stdin and answers with a `result` line, staying alive for the next.
//!
//! Only the transport is new. A turn LEASES the warm child out of this pool,
//! attaches it to the turn's existing slot (so Stop still kills it), reads it
//! with the same reader, and puts it back when the turn closed cleanly. Any
//! other ending discards it, and every failure to get one falls back to the
//! cold path, so a turn is never worse than before.
//!
//! The CLI keeps one session id across a warm child's turns and across
//! `--resume` (verified on 2.1.289), so a pooled child is valid for a turn
//! exactly when it continues the session the database says the chat is on.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

/// A warm child nobody has used for this long is reaped.
pub const IDLE_REAP: Duration = Duration::from_secs(10 * 60);
/// The pool slot a pre-warm uses before its chat exists (the Front Door's
/// Chat destination is picked before the first ⏎ creates the thread). A
/// chat's first turn adopts it.
pub const NEXT_CHAT: &str = "__next__";
const STDERR_TAIL_LINES: usize = 20;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub type StderrTail = Arc<Mutex<VecDeque<String>>>;

/// What a warm child was spawned with. A turn that needs anything else (a
/// different model, effort or working directory) gets a fresh child.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WarmKey {
    pub binary: String,
    pub cwd: String,
    pub flags: Vec<String>,
}

/// Everything of a warm child except the process itself, which a turn hands
/// to its slot.
pub struct WarmIo {
    pub stdin: ChildStdin,
    pub lines: Lines<BufReader<ChildStdout>>,
    pub stderr_tail: StderrTail,
    pub key: WarmKey,
    /// The CLI session this child continues. `None` for a fresh child that
    /// has not served a turn.
    pub session: Option<String>,
}

pub struct WarmChild {
    pub child: Child,
    pub io: WarmIo,
}

struct Entry {
    warm: WarmChild,
    last_used: Instant,
}

/// Warm children keyed by chat id. Cloned into `CompanionState`.
#[derive(Clone, Default)]
pub struct WarmPool {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    reaper: Arc<AtomicBool>,
}

impl WarmPool {
    fn valid(entry: &mut Entry, key: &WarmKey, session: Option<&str>, now: Instant) -> bool {
        entry.warm.io.key == *key
            && entry.warm.io.session.as_deref() == session
            && now.duration_since(entry.last_used) < IDLE_REAP
            && matches!(entry.warm.child.try_wait(), Ok(None))
    }

    /// Take this chat's warm child for a turn, if it can serve one: same
    /// spawn key, continuing `session`, alive and not idle-expired. A chat on
    /// a fresh session may adopt the pre-warmed `NEXT_CHAT` child. Anything
    /// unusable that is found is dropped, which kills it.
    pub fn lease(&self, id: &str, key: &WarmKey, session: Option<&str>) -> Option<WarmChild> {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut entry) = entries.remove(id) {
            if Self::valid(&mut entry, key, session, now) {
                return Some(entry.warm);
            }
        }
        if session.is_none() && id != NEXT_CHAT {
            if let Some(mut entry) = entries.remove(NEXT_CHAT) {
                if Self::valid(&mut entry, key, None, now) {
                    return Some(entry.warm);
                }
            }
        }
        None
    }

    /// Whether a usable warm child is already waiting (pre-warm idempotency).
    pub fn has(&self, id: &str, key: &WarmKey, session: Option<&str>) -> bool {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get_mut(id) else { return false };
        if Self::valid(entry, key, session, now) {
            return true;
        }
        entries.remove(id);
        false
    }

    /// Park a warm child for this chat's next turn, replacing (and so
    /// killing) any other.
    pub fn put(&self, id: &str, warm: WarmChild) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.insert(id.to_string(), Entry { warm, last_used: Instant::now() });
    }

    /// Discard this chat's warm child: the room closed, the chat was deleted,
    /// or something else (a consult, a rotation) moved its session on.
    pub fn drop_chat(&self, id: &str) {
        let removed = self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        drop(removed);
    }

    pub fn clear(&self) {
        let drained: Vec<Entry> = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, e)| e)
            .collect();
        drop(drained);
    }

    /// Drop every child idle past `IDLE_REAP` (or already dead). Returns how
    /// many went.
    pub fn reap_idle(&self, now: Instant) -> usize {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let before = entries.len();
        entries.retain(|_, e| {
            now.duration_since(e.last_used) < IDLE_REAP && matches!(e.warm.child.try_wait(), Ok(None))
        });
        before - entries.len()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Start the once-a-minute idle reaper, the first time a child is pooled.
    pub fn ensure_reaper(&self) {
        if self.reaper.swap(true, Ordering::SeqCst) {
            return;
        }
        let pool = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let reaped = pool.reap_idle(Instant::now());
                if reaped > 0 {
                    tracing::debug!(reaped, "chat: reaped idle warm sessions");
                }
            }
        });
    }
}

/// The argv for a warm child: the canonical bridge block, stream-json in, the
/// seat's flags, the room's system prompt, and the session it continues.
pub fn warm_args(system_prompt: &str, resume: Option<&str>, seat_flags: Vec<String>) -> Vec<String> {
    let mut args = vec!["-p".to_string(), "--input-format".to_string(), "stream-json".to_string()];
    args.extend(crate::claude_proc::BRIDGE_INVARIANT_ARGS.iter().map(|s| s.to_string()));
    args.extend(seat_flags);
    args.push("--append-system-prompt".to_string());
    args.push(system_prompt.to_string());
    if let Some(sid) = resume {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    args
}

async fn drain_stderr(stderr: ChildStderr, tail: StderrTail) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let mut buf = tail.lock().unwrap_or_else(|e| e.into_inner());
        if buf.len() == STDERR_TAIL_LINES {
            buf.pop_front();
        }
        buf.push_back(line.chars().take(1_000).collect());
    }
}

pub fn stderr_text(tail: &StderrTail) -> String {
    tail.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect::<Vec<_>>().join("\n")
}

/// Spawn a warm child. It boots (and runs its SessionStart hooks) right away;
/// the CLI's `init` line arrives with the first turn, not before.
pub async fn spawn(key: WarmKey, args: Vec<String>, resume: Option<String>) -> Result<WarmChild, String> {
    let mut child = crate::claude_proc::claude_command_for_seat("companion", &key.binary)
        .current_dir(&key.cwd)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("warm chat spawn failed: {e}"))?;
    let stdin = child.stdin.take().ok_or("warm chat stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("warm chat stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("warm chat stderr unavailable")?;
    let stderr_tail: StderrTail = Arc::new(Mutex::new(VecDeque::new()));
    tokio::spawn(drain_stderr(stderr, stderr_tail.clone()));
    Ok(WarmChild {
        child,
        io: WarmIo { stdin, lines: BufReader::new(stdout).lines(), stderr_tail, key, session: resume },
    })
}

/// One stream-json user turn, newline-terminated. `serde_json` escapes it.
pub fn user_turn_line(text: &str) -> String {
    let v = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    format!("{v}\n")
}

pub async fn send_turn(io: &mut WarmIo, text: &str) -> Result<(), String> {
    let line = user_turn_line(text);
    tokio::time::timeout(WRITE_TIMEOUT, async {
        io.stdin.write_all(line.as_bytes()).await?;
        io.stdin.flush().await
    })
    .await
    .map_err(|_| "warm chat write timed out".to_string())?
    .map_err(|e| format!("warm chat write failed: {e}"))
}

/// A warm child with this turn already written to it, or `None`, in which
/// case the caller takes the cold path. Leases a pooled child when one can
/// serve the turn, otherwise spawns one, which then stays warm for the
/// turns after.
pub async fn open_turn(
    pool: &WarmPool,
    id: &str,
    key: WarmKey,
    args: Vec<String>,
    session: Option<&str>,
    text: &str,
) -> Option<WarmChild> {
    let mut warm = match pool.lease(id, &key, session) {
        Some(warm) => warm,
        None => match spawn(key, args, session.map(str::to_string)).await {
            Ok(warm) => warm,
            Err(e) => {
                tracing::warn!(error = %e, "chat: no warm session, falling back to a cold turn");
                return None;
            }
        },
    };
    if let Err(e) = send_turn(&mut warm.io, text).await {
        tracing::warn!(error = %e, "chat: warm session refused the turn, falling back to a cold turn");
        return None;
    }
    Some(warm)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(binary: &str) -> WarmKey {
        WarmKey { binary: binary.to_string(), cwd: std::env::temp_dir().display().to_string(), flags: vec![] }
    }

    /// A stand-in CLI: one `result` line per stdin line, alive until stdin
    /// closes. Enough to exercise the pool without a model.
    fn fake_cli() -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("rl-fake-claude-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            "#!/bin/sh\nwhile read line; do echo '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ok\",\"session_id\":\"s-1\"}'; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    #[tokio::test]
    async fn a_failed_warm_spawn_falls_back_to_cold() {
        let pool = WarmPool::default();
        let k = key("/nonexistent/redline-test/claude");
        let args = warm_args("system", None, vec![]);
        assert!(open_turn(&pool, "chat", k, args, None, "hello").await.is_none(), "the caller must take the cold path");
        assert_eq!(pool.len(), 0);
    }

    #[tokio::test]
    async fn a_warm_child_serves_turns_and_is_reused_only_for_its_session() {
        let pool = WarmPool::default();
        let bin = fake_cli();
        let k = key(&bin);
        let mut warm = open_turn(&pool, "chat", k.clone(), vec![], None, "turn one").await.expect("warm");
        let line = warm.io.lines.next_line().await.unwrap().unwrap();
        assert!(line.contains("\"result\""));
        // The reader records the session the turn reported, then parks it.
        warm.io.session = Some("s-1".into());
        pool.put("chat", warm);

        // A second turn on the same session leases the same live child.
        let mut again = pool.lease("chat", &k, Some("s-1")).expect("reused");
        send_turn(&mut again.io, "turn two").await.unwrap();
        assert!(again.io.lines.next_line().await.unwrap().unwrap().contains("\"result\""));
        pool.put("chat", again);

        // A different session (a consult or rotation moved it) or a different
        // model never reuses it, and the stale child is dropped.
        assert!(pool.lease("chat", &k, Some("s-2")).is_none());
        assert_eq!(pool.len(), 0);
        let _ = std::fs::remove_file(bin);
    }

    #[tokio::test]
    async fn a_prewarmed_child_is_adopted_by_a_new_chat_only() {
        let pool = WarmPool::default();
        let bin = fake_cli();
        let k = key(&bin);
        pool.put(NEXT_CHAT, spawn(k.clone(), vec![], None).await.unwrap());
        // A chat that already has a session cannot adopt a fresh child.
        assert!(pool.lease("old-chat", &k, Some("s-9")).is_none());
        assert_eq!(pool.len(), 1);
        // A different spawn key cannot either.
        let other = WarmKey { flags: vec!["--model".into(), "opus".into()], ..k.clone() };
        assert!(pool.lease("new-chat", &other, None).is_none());
        // It went stale for that key and was dropped; re-park and adopt.
        pool.put(NEXT_CHAT, spawn(k.clone(), vec![], None).await.unwrap());
        assert!(pool.lease("new-chat", &k, None).is_some());
        assert_eq!(pool.len(), 0);
        let _ = std::fs::remove_file(bin);
    }

    #[tokio::test]
    async fn idle_and_dead_children_are_reaped() {
        let pool = WarmPool::default();
        let bin = fake_cli();
        pool.put("a", spawn(key(&bin), vec![], None).await.unwrap());
        assert_eq!(pool.reap_idle(Instant::now()), 0);
        assert_eq!(pool.reap_idle(Instant::now() + IDLE_REAP + Duration::from_secs(1)), 1);
        assert_eq!(pool.len(), 0);
        let _ = std::fs::remove_file(bin);
    }

    #[test]
    fn warm_args_carry_the_system_prompt_and_the_session() {
        let args = warm_args("PERSONA", Some("s-1"), vec!["--model".into(), "sonnet".into()]);
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert_eq!(args[at("--input-format") + 1], "stream-json");
        assert_eq!(args[at("--append-system-prompt") + 1], "PERSONA");
        assert_eq!(args[at("--resume") + 1], "s-1");
        assert!(args.iter().any(|a| a == crate::claude_proc::HEADLESS_TOOLS));
        assert!(!warm_args("P", None, vec![]).iter().any(|a| a == "--resume"));
    }
}

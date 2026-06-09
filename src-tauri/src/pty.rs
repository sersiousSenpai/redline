// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Embedded terminals backed by real PTYs (via `portable-pty`).
//!
//! A keyed registry of PTYs — one per terminal tab, addressed by a string `id`
//! the frontend generates. Output bytes stream to the frontend over a
//! per-terminal [`tauri::ipc::Channel`] (raw bytes, one subscriber per tab — no
//! N-tab event fan-out, no base64); `pty-exit` (`{ id }`) fires when a shell
//! ends. This gives co-presence — the user runs `claude` here, beside the
//! review surface, instead of in a separate terminal window.
//!
//! Perf shape (Phase 3, the VS-Code playbook adapted to Tauri): the WebView main
//! thread renders, it never buffers unboundedly. The reader thread accumulates
//! bytes in a [`Coalescer`]; a flusher thread drains them once per ~frame so a
//! stdout burst becomes a few large messages instead of thousands of tiny ones.
//! Flow control (ACK-based, [`Flow`]) pauses reading when the renderer falls
//! behind so an infinite firehose (`yes`) can't outrun xterm or grow memory
//! without bound — the kernel PTY buffer fills and the child blocks instead.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager};

/// Drain the reader's accumulated bytes at most once per this window, so a burst
/// of many small PTY reads coalesces into one large frontend message. ~one frame
/// at 120 Hz — imperceptible latency for an interactive prompt, but it collapses
/// a `yes` firehose from thousands of messages/sec to ~120.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// Stop reading the PTY once this many bytes have been sent to the frontend but
/// not yet ACKed (written to xterm). Backpressure: the kernel PTY buffer fills,
/// the child process blocks on write, and the UI thread is never flooded.
const FLOW_HIGH_WATER: usize = 256 * 1024;

/// Safety valve: never let a wedged/throttled frontend permanently starve the
/// child. If no ACK arrives within this window, read one more chunk anyway — a
/// slow trickle (~one read per interval), not a flood.
const FLOW_STALL_VALVE: Duration = Duration::from_millis(200);

/// Accumulates PTY reads so a burst of many small reads flushes as one buffer
/// instead of one IPC message per read. The whole point of the batching pump;
/// kept as a tiny pure type so the coalescing property is unit-testable.
#[derive(Default)]
struct Coalescer {
    buf: Vec<u8>,
}

impl Coalescer {
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }
    /// Take everything accumulated so far, leaving the buffer empty.
    fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
    fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// The reader→flusher hand-off buffer for one terminal. The reader thread
/// `push`es; the flusher thread waits on `cond`, then drains.
struct Pump {
    buf: Mutex<Coalescer>,
    cond: Condvar,
    /// Set by the reader on EOF (or by kill) so the flusher exits after a final
    /// drain rather than blocking on `cond` forever.
    closed: AtomicBool,
}

impl Pump {
    fn new() -> Arc<Self> {
        Arc::new(Pump {
            buf: Mutex::new(Coalescer::default()),
            cond: Condvar::new(),
            closed: AtomicBool::new(false),
        })
    }
    fn push(&self, bytes: &[u8]) {
        self.buf.lock().unwrap().push(bytes);
        self.cond.notify_one();
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cond.notify_one();
    }
}

struct FlowInner {
    /// Bytes sent to the frontend but not yet ACKed (written into xterm).
    unacked: usize,
    /// Set on kill/EOF so a reader parked in the flow gate can always exit.
    closed: bool,
}

/// ACK-based flow control between the reader thread (producer) and the frontend
/// (consumer). The reader parks here while it's run too far ahead of the
/// renderer; the frontend's `pty_ack` calls drain it.
struct Flow {
    inner: Mutex<FlowInner>,
    cond: Condvar,
}

impl Flow {
    fn new() -> Arc<Self> {
        Arc::new(Flow {
            inner: Mutex::new(FlowInner {
                unacked: 0,
                closed: false,
            }),
            cond: Condvar::new(),
        })
    }
    /// Account bytes just sent to the frontend.
    fn on_sent(&self, n: usize) {
        self.inner.lock().unwrap().unacked += n;
    }
    /// Frontend reports `n` bytes written into xterm — release that much credit.
    fn ack(&self, n: usize) {
        let mut g = self.inner.lock().unwrap();
        g.unacked = g.unacked.saturating_sub(n);
        self.cond.notify_all();
    }
    /// Unblock any parked reader (terminal killed / shell exited).
    fn close(&self) {
        self.inner.lock().unwrap().closed = true;
        self.cond.notify_all();
    }
    /// Block while the renderer is more than `FLOW_HIGH_WATER` behind. Returns on
    /// ACK progress, on close, or after `FLOW_STALL_VALVE` (safety valve).
    fn wait_until_drained(&self) {
        let mut g = self.inner.lock().unwrap();
        while g.unacked > FLOW_HIGH_WATER && !g.closed {
            let (ng, res) = self.cond.wait_timeout(g, FLOW_STALL_VALVE).unwrap();
            g = ng;
            if res.timed_out() {
                break;
            }
        }
    }
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Flow-control credit shared with this tab's reader thread — looked up by
    /// `pty_ack` and signalled on kill.
    flow: Arc<Flow>,
    /// Child shell pid — used to read its live working directory so a new
    /// terminal can open wherever this one has `cd`'d to.
    pid: Option<u32>,
}

/// Registry of live PTYs keyed by the frontend-assigned terminal id. The outer
/// mutex guards only the map structure (insert/remove/lookup, microsecond
/// criticals). Each session has its own inner mutex for write/resize I/O — so
/// a stalled child shell on one tab can't block sibling tabs.
#[derive(Clone, Default)]
pub struct PtyState(Arc<Mutex<HashMap<String, Arc<Mutex<PtySession>>>>>);

impl PtyState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<Response>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if guard.contains_key(&id) {
        // Already running for this id — treat spawn as idempotent so a
        // component remount doesn't fork a second shell.
        return Ok(());
    }

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l");
    // An explicit cwd wins; otherwise fall back to $HOME so a terminal never
    // inherits wherever the app process happened to be launched from.
    let start_dir = cwd
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .filter(|d| !d.is_empty());
    if let Some(dir) = start_dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {shell}: {e}"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let pid = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let flow = Flow::new();
    let pump = Pump::new();

    guard.insert(
        id.clone(),
        Arc::new(Mutex::new(PtySession {
            master: pair.master,
            writer,
            killer,
            flow: flow.clone(),
            pid,
        })),
    );
    drop(guard);

    // Reader pump: raw PTY bytes → coalescer. Gated by flow control so a
    // firehose can't outrun the renderer (the child blocks on a full PTY buffer
    // instead of flooding the UI thread or growing memory unbounded).
    let pump_for_reader = pump.clone();
    let flow_for_reader = flow.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            flow_for_reader.wait_until_drained();
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => pump_for_reader.push(&buf[..n]),
                Err(_) => break,
            }
        }
        pump_for_reader.close();
    });

    // Flusher pump: drains the coalescer once per `COALESCE_WINDOW` and pushes
    // one raw-byte message per drain to this tab's Channel. One subscriber per
    // terminal → no id filtering, no base64, no per-char JS decode.
    let app_for_flusher = app.clone();
    let id_for_flusher = id.clone();
    std::thread::spawn(move || {
        loop {
            // Park until there's data (or the reader closed) — an idle terminal
            // uses no CPU.
            {
                let mut b = pump.buf.lock().unwrap();
                while b.is_empty() && !pump.closed.load(Ordering::Acquire) {
                    b = pump.cond.wait(b).unwrap();
                }
                if b.is_empty() {
                    break; // closed and fully drained
                }
            }
            // Let the rest of a burst land before draining, so it ships as one
            // large message rather than many small ones.
            std::thread::sleep(COALESCE_WINDOW);
            let chunk = pump.buf.lock().unwrap().take();
            if chunk.is_empty() {
                if pump.closed.load(Ordering::Acquire) {
                    break;
                }
                continue;
            }
            let len = chunk.len();
            if on_output.send(Response::new(chunk)).is_err() {
                break; // frontend channel gone (tab unmounted)
            }
            flow.on_sent(len);
        }
        let _ = app_for_flusher.emit(
            "pty-exit",
            PtyExit {
                id: id_for_flusher,
            },
        );
    });

    // Reaper: drop this id from the registry once its shell exits so a later
    // spawn with the same id can restart it.
    let id_for_reaper = id;
    std::thread::spawn(move || {
        let _ = child.wait();
        if let Some(state) = app.try_state::<PtyState>() {
            state.0.lock().unwrap().remove(&id_for_reaper);
        }
    });

    Ok(())
}

/// Pull a session out of the registry without holding the outer lock across
/// any I/O — the entire point of the per-session split.
fn session_of(state: &PtyState, id: &str) -> Option<Arc<Mutex<PtySession>>> {
    state.0.lock().unwrap().get(id).cloned()
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    pty_write_bytes(&state, &id, data.as_bytes())
}

/// Internal write helper — same as the `pty_write` Tauri command but callable
/// directly from Rust (e.g. from `submit_review` to inject the menu-skip
/// keystroke after releasing the held POST). Returns `Ok(())` even when the
/// PTY id isn't registered, because a missing terminal is a soft failure for
/// best-effort auto-continue: we don't want to fail the whole submit just
/// because the user closed the tab.
pub fn pty_write_bytes(state: &PtyState, id: &str, bytes: &[u8]) -> Result<(), String> {
    let Some(session) = session_of(state, id) else {
        return Ok(());
    };
    let mut s = session.lock().unwrap();
    s.writer
        .write_all(bytes)
        .map_err(|e| format!("pty write failed: {e}"))?;
    s.writer.flush().ok();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = session_of(&state, &id).ok_or("no terminal running")?;
    let s = session.lock().unwrap();
    s.master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

/// Frontend ACK: `n` bytes have been written into xterm, so release that much
/// flow-control credit — lets the reader thread resume if it was parked at the
/// high-water mark. Trivial (lock + decrement), so it stays a sync command for
/// lowest latency. A missing id is a soft no-op (tab already closed).
#[tauri::command]
pub fn pty_ack(state: tauri::State<'_, PtyState>, id: String, n: usize) {
    if let Some(session) = session_of(&state, &id) {
        let flow = session.lock().unwrap().flow.clone();
        flow.ack(n);
    }
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    // Remove from the registry (outer lock only), then kill the underlying
    // child outside any lock.
    let session = { state.0.lock().unwrap().remove(&id) };
    if let Some(session) = session {
        let mut s = session.lock().unwrap();
        s.flow.close(); // unpark the reader if it's gated on flow control
        let _ = s.killer.kill();
    }
    Ok(())
}

/// The live working directory of a terminal's shell — so "open a terminal
/// here" can follow wherever the user `cd`'d. macOS/Linux: ask `lsof` for the
/// shell pid's `cwd` fd. Returns `None` if it can't be determined.
#[tauri::command]
pub fn pty_cwd(state: tauri::State<'_, PtyState>, id: String) -> Option<String> {
    let session = session_of(&state, &id)?;
    let pid = session.lock().unwrap().pid?;
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
        .filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_write_bytes_is_silent_noop_for_missing_id() {
        // The post-submit auto-continue inject calls this with a best-effort
        // terminal id; a missing PTY (closed tab) must not surface as an
        // error or panic — `submit_review` should still succeed.
        let state = PtyState::new();
        assert!(pty_write_bytes(&state, "no-such-tab", b"3\r").is_ok());
    }

    #[test]
    fn coalescer_merges_many_reads_into_one_buffer() {
        // The batching property: a burst of small PTY reads must coalesce into a
        // single drained buffer (one frontend message), not one per read.
        let mut c = Coalescer::default();
        assert!(c.is_empty());
        c.push(b"foo");
        c.push(b"bar");
        c.push(b"baz");
        assert!(!c.is_empty());
        assert_eq!(c.take(), b"foobarbaz");
        // Draining empties it; a second drain yields nothing (flusher won't ship
        // an empty message).
        assert!(c.is_empty());
        assert_eq!(c.take(), Vec::<u8>::new());
    }

    #[test]
    fn flow_ack_releases_credit_and_saturates_at_zero() {
        // Sent credit accrues; ACKs release it; over-ACK can't underflow (an
        // out-of-order or duplicate ack must not wrap to a huge unacked count).
        let flow = Flow::new();
        flow.on_sent(1000);
        flow.ack(400);
        assert_eq!(flow.inner.lock().unwrap().unacked, 600);
        flow.ack(10_000);
        assert_eq!(flow.inner.lock().unwrap().unacked, 0);
    }

    #[test]
    fn flow_gate_does_not_block_below_high_water() {
        // Under the high-water mark the reader must never park — interactive
        // output can't wait on an ACK that only comes after it's displayed.
        let flow = Flow::new();
        flow.on_sent(FLOW_HIGH_WATER / 2);
        flow.wait_until_drained(); // returns promptly (no deadlock)
    }
}

#[tauri::command]
pub fn pty_kill_all(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    // Drain the map (outer lock only), then kill each child outside the lock
    // so one stuck killer can't block the others.
    let drained: Vec<Arc<Mutex<PtySession>>> = {
        let mut guard = state.0.lock().unwrap();
        guard.drain().map(|(_, v)| v).collect()
    };
    for session in drained {
        let mut s = session.lock().unwrap();
        s.flow.close();
        let _ = s.killer.kill();
    }
    Ok(())
}

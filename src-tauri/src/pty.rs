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
//! Flow control (ACK-based, [`Pump`]) pauses reading when the renderer falls
//! behind so an infinite firehose (`yes`) can't outrun xterm or grow memory
//! without bound — the kernel PTY buffer fills and the child blocks instead.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

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

/// An unloaded webview can leave a channel whose sends succeed but whose ACKs
/// never arrive. Suspend delivery after this grace period and keep draining
/// into the bounded replay ring. A slow live renderer resumes on its next ACK;
/// an unloaded renderer never grows an unbounded IPC queue or blocks its shell.
const FLOW_STALL_TIMEOUT: Duration = Duration::from_secs(5);

/// Retain only the newest raw output for a fresh xterm instance to replay.
const REPLAY_CAPACITY: usize = 256 * 1024;

/// Lock a mutex, recovering from poisoning. A panic on any thread that held a
/// PTY lock poisons that mutex; propagating the poison (the old `.unwrap()`)
/// panicked whoever locked it next — on the Tauri main thread that's process
/// teardown, which kills every shell at once. The data these mutexes guard
/// (registry maps, byte buffers, counters) stays coherent mid-operation, so
/// recovering the guard is always safe.
fn lock_ok<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

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

/// Every byte enters replay exactly once, at read time. The pending buffer,
/// channel and ACK credit share this lock so attach can discard pending bytes
/// already covered by replay and send that replay before any later live bytes.
struct OutputInner {
    pending: Coalescer,
    replay: VecDeque<u8>,
    channel: Option<Channel<Response>>,
    attachment_id: Option<String>,
    /// Includes queued bytes as well as sent bytes, bounding the coalescer even
    /// if the flusher is delayed. Replay is charged before sending it too.
    unacked: usize,
    last_ack: Instant,
    suspended: bool,
    /// Absolute stream offsets let a late ACK resume only output not delivered
    /// during suspension, without duplicating the screen's existing history.
    total_read: u64,
    last_sent: u64,
    closed: bool,
}

impl OutputInner {
    fn detach(&mut self) {
        self.channel = None;
        self.attachment_id = None;
        self.pending.take();
        self.unacked = 0;
        self.suspended = false;
    }

    fn flush_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let chunk = self.pending.take();
        if self.send(chunk).is_ok() {
            self.last_sent = self.total_read;
        }
    }

    fn resume(&mut self) {
        self.suspended = false;
        let missing = self.total_read.saturating_sub(self.last_sent);
        let retained = self.replay.len() as u64;
        let mut bytes = Vec::new();
        if missing > retained {
            // The renderer was stalled longer than the ring could retain. A
            // fresh terminal state plus the retained tail avoids appending an
            // arbitrary suffix to a half-written escape sequence on screen.
            bytes.extend_from_slice(b"\x1bc");
        }
        bytes.extend(
            self.replay
                .iter()
                .skip(retained.saturating_sub(missing) as usize),
        );
        if bytes.is_empty() {
            return;
        }
        self.unacked += bytes.len();
        if self.send(bytes).is_ok() {
            self.last_sent = self.total_read;
        }
    }

    fn send(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        if let Some(channel) = &self.channel {
            if let Err(error) = channel.send(Response::new(bytes)) {
                self.detach();
                return Err(format!("terminal output channel unavailable: {error}"));
            }
        }
        Ok(())
    }
}

/// Reader → replay/coalescer → replaceable frontend channel. Losing a channel
/// detaches its subscriber; only actual PTY EOF stops this pump.
struct Pump {
    inner: Mutex<OutputInner>,
    cond: Condvar,
    alive: Arc<AtomicBool>,
}

impl Pump {
    fn new(alive: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(OutputInner {
                pending: Coalescer::default(),
                replay: VecDeque::with_capacity(REPLAY_CAPACITY),
                channel: None,
                attachment_id: None,
                unacked: 0,
                last_ack: Instant::now(),
                suspended: false,
                total_read: 0,
                last_sent: 0,
                closed: false,
            }),
            cond: Condvar::new(),
            alive,
        })
    }

    fn push(&self, bytes: &[u8]) {
        let mut output = lock_ok(&self.inner);
        output.total_read = output.total_read.saturating_add(bytes.len() as u64);
        if bytes.len() >= REPLAY_CAPACITY {
            output.replay.clear();
            output
                .replay
                .extend(&bytes[bytes.len() - REPLAY_CAPACITY..]);
        } else {
            let excess = (output.replay.len() + bytes.len()).saturating_sub(REPLAY_CAPACITY);
            output.replay.drain(..excess);
            output.replay.extend(bytes);
        }
        if output.channel.is_some() && !output.suspended {
            // The caller gates reads before reaching this point, so pending +
            // sent credit cannot exceed the high-water mark plus one read.
            if output.unacked == 0 {
                output.last_ack = Instant::now();
            }
            output.pending.push(bytes);
            output.unacked += bytes.len();
            self.cond.notify_one();
        }
    }

    fn attach(
        &self,
        channel: Channel<Response>,
        attachment_id: Option<String>,
    ) -> Result<(), String> {
        let mut output = lock_ok(&self.inner);
        if output.closed || !self.alive.load(Ordering::Acquire) {
            return Err("terminal is not running".into());
        }
        output.channel = Some(channel);
        output.attachment_id = attachment_id;
        output.pending.take();
        let replay = output.replay.iter().copied().collect::<Vec<_>>();
        output.unacked = replay.len();
        output.suspended = false;
        output.last_sent = output.total_read;
        output.last_ack = Instant::now();
        // Wire contract: EVERY subscriber gets exactly one first replay frame,
        // including an empty frame for a fresh shell. TerminalView suppresses
        // automatic replies to historical terminal queries only while parsing
        // this frame. Sending it under the output lock keeps live bytes behind
        // that boundary, independent of IPC command-response delivery order.
        let result = output.send(replay);
        self.cond.notify_all();
        result
    }

    fn detach(&self, attachment_id: &str) {
        let mut output = lock_ok(&self.inner);
        if output.attachment_id.as_deref() == Some(attachment_id) {
            output.detach();
            self.cond.notify_all();
        }
    }

    fn ack(&self, n: usize, attachment_id: Option<&str>) {
        let mut output = lock_ok(&self.inner);
        if output.channel.is_some() && output.attachment_id.as_deref() == attachment_id {
            if n > 0 && output.unacked > 0 {
                output.last_ack = Instant::now();
            }
            output.unacked = output.unacked.saturating_sub(n);
            if n > 0 && output.suspended && output.unacked <= FLOW_HIGH_WATER {
                output.resume();
            }
            self.cond.notify_all();
        }
    }

    /// Return false on teardown. If ACKs stop, suspend delivery while the
    /// reader maintains the bounded ring; a late ACK resumes the same view.
    fn wait_until_drained(&self) -> bool {
        let mut output = lock_ok(&self.inner);
        while output.unacked > FLOW_HIGH_WATER && !output.closed && !output.suspended {
            let remaining = FLOW_STALL_TIMEOUT.saturating_sub(output.last_ack.elapsed());
            if remaining.is_zero() {
                output.flush_pending();
                output.suspended = output.channel.is_some();
                break;
            }
            let (next, _) = self
                .cond
                .wait_timeout(output, remaining)
                .unwrap_or_else(|error| error.into_inner());
            output = next;
        }
        !output.closed
    }

    /// Park an idle flusher. It survives detach and wakes on reattach/live
    /// output; only an actual close with all pending bytes drained ends it.
    fn wait_for_output(&self) -> bool {
        let mut output = lock_ok(&self.inner);
        while output.pending.is_empty() && !output.closed {
            output = self
                .cond
                .wait(output)
                .unwrap_or_else(|error| error.into_inner());
        }
        !output.pending.is_empty()
    }

    fn flush(&self) {
        let mut output = lock_ok(&self.inner);
        if !output.pending.is_empty() {
            output.flush_pending();
            self.cond.notify_all();
        }
    }

    fn close(&self) {
        self.alive.store(false, Ordering::Release);
        lock_ok(&self.inner).closed = true;
        self.cond.notify_all();
    }
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Output, bounded replay, and subscriber-specific flow control.
    output: Arc<Pump>,
    /// Startup cwd survives reload independently of the shell's current cwd.
    cwd: Option<String>,
    alive: Arc<AtomicBool>,
    /// Child shell pid — used to read its live working directory so a new
    /// terminal can open wherever this one has `cd`'d to.
    pid: Option<u32>,
    /// Unique per-spawn token. A terminal id can be respawned (React dev
    /// remounts spawn→kill→spawn under one id); the reaper compares this so a
    /// dead predecessor can never evict its successor from the registry —
    /// dropping the successor's entry would close its PTY master and EOF a
    /// perfectly healthy shell.
    generation: u64,
    /// Set by the kill paths before killing. The flusher consults it so an
    /// intentional teardown (remount cleanup, tab close, app exit) doesn't
    /// emit `pty-exit` — that event means "your shell died", and printing
    /// "[process exited]" into a successor terminal is pure noise.
    expected_exit: Arc<AtomicBool>,
}

/// Monotonic spawn-generation counter (see `PtySession::generation`).
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Unix-ms of the most recent output from ANY live terminal — the "is a shell
/// actively producing output" signal the background memory keeper consults to
/// stay off the user's hot path. Bumped on every PTY read; 0 = no output yet.
static LAST_PTY_OUTPUT_MS: AtomicI64 = AtomicI64::new(0);

/// The most recent PTY-output timestamp (unix ms), or 0 if a terminal has never
/// produced output this run. Read by `keeper::is_idle`.
pub fn last_pty_output_ms() -> i64 {
    LAST_PTY_OUTPUT_MS.load(Ordering::Relaxed)
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

    /// The terminals that are live right now.
    ///
    /// Read when Redline is about to restart into a new version. A terminal is
    /// a process with a shell in it: its scrollback, its child, its working
    /// directory and whatever was half-typed do not survive the application
    /// exiting, and the restart summary says so rather than implying they do.
    pub fn live_ids(&self) -> Vec<String> {
        self.entries()
            .into_iter()
            .filter(|entry| entry.alive)
            .map(|entry| entry.id)
            .collect()
    }

    fn entries(&self) -> Vec<PtyInfo> {
        // Snapshot first: never wait on session I/O while holding the registry.
        let sessions: Vec<_> = lock_ok(&self.0)
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect();
        let mut entries: Vec<_> = sessions
            .into_iter()
            .map(|(id, session)| {
                let session = lock_ok(&session);
                PtyInfo {
                    id,
                    cwd: session.cwd.clone(),
                    pid: session.pid,
                    alive: session.alive.load(Ordering::Acquire),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

// Spawn/kill/resize/cwd run `#[tauri::command(async)]` (off the main IPC
// thread): spawn forks a process, cwd shells out to `lsof` every poll tick,
// and none of them need main-thread ordering. `pty_write`/`pty_ack` stay sync
// on purpose — main-thread invocation order is what guarantees keystroke byte
// order. The JS side (`enqueuePtyOp`) already fences spawn/kill/resize per id.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<Response>,
    attachment_id: Option<String>,
) -> Result<(), String> {
    let mut guard = lock_ok(&state.0);
    while let Some(session) = guard.get(&id).cloned() {
        // Spawn is idempotent AND rebinds the subscriber. A shell appearing
        // between is_live and spawn must not leave the new view unattached.
        drop(guard);
        let output = lock_ok(&session).output.clone();
        if output.alive.load(Ordering::Acquire) {
            return output.attach(on_output, attachment_id);
        }
        // EOF can precede the reaper removing this entry. Allow a fresh spawn
        // in that window without ever removing a concurrent successor.
        guard = lock_ok(&state.0);
        if guard
            .get(&id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            guard.remove(&id);
        }
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
    if let Some(dir) = &start_dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    // Redline-spawned terminals are trusted children: a claude session (or
    // any tool) running in a dock terminal authenticates to the daemon's
    // protected /v1 routes with this per-boot token. Truly external
    // terminals never see it — that asymmetry IS the auth model.
    cmd.env(crate::auth::ENV_DAEMON_TOKEN, crate::auth::daemon_token());

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        // The terminal is the app's busiest surface and emitted NOTHING into
        // the evidence pipeline — a shell that won't start was invisible to
        // every digest that ranks what to fix.
        crate::db::note_friction(
            "pty_spawn_failed",
            Some("terminal"),
            None,
            Some(&format!("{shell}: {e}")),
        );
        format!("failed to spawn {shell}: {e}")
    })?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let pid = child.process_id();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let alive = Arc::new(AtomicBool::new(true));
    let pump = Pump::new(alive.clone());
    if let Err(error) = pump.attach(on_output, attachment_id) {
        // The initial (possibly empty) replay frame can fail if the mounting
        // webview disappeared during spawn. No registry/reaper owns this child
        // yet, so reap it here instead of leaking an unreachable shell.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let expected_exit = Arc::new(AtomicBool::new(false));
    let expected_exit_for_reaper = expected_exit.clone();

    guard.insert(
        id.clone(),
        Arc::new(Mutex::new(PtySession {
            master: pair.master,
            writer,
            killer,
            output: pump.clone(),
            cwd: start_dir,
            alive: alive.clone(),
            pid,
            generation,
            expected_exit: expected_exit.clone(),
        })),
    );
    drop(guard);

    // Reader pump: raw PTY bytes → coalescer. Gated by flow control so a
    // firehose can't outrun the renderer (the child blocks on a full PTY buffer
    // instead of flooding the UI thread or growing memory unbounded).
    let pump_for_reader = pump.clone();
    std::thread::spawn(move || read_output(reader, pump_for_reader));

    // Flusher pump: drains the coalescer once per `COALESCE_WINDOW` and pushes
    // one raw-byte message per drain to this tab's Channel. One subscriber per
    // terminal → no id filtering, no base64, no per-char JS decode.
    let app_for_flusher = app.clone();
    let id_for_flusher = id.clone();
    std::thread::spawn(move || {
        while pump.wait_for_output() {
            // Coalesce one frame of output. flush and attach use the same
            // lock: nothing drained before attach can arrive after replay.
            std::thread::sleep(COALESCE_WINDOW);
            pump.flush();
        }
        // An intentional kill (remount cleanup, tab close, app exit) already
        // has a successor or no UI — only an *unexpected* shell death should
        // surface as "[process exited]".
        let successor_exists = app_for_flusher
            .try_state::<PtyState>()
            .and_then(|state| session_of(&state, &id_for_flusher))
            .is_some_and(|session| lock_ok(&session).generation != generation);
        if !expected_exit.load(Ordering::SeqCst) && !successor_exists {
            let _ = app_for_flusher.emit("pty-exit", PtyExit { id: id_for_flusher });
        }
    });

    // Reaper: drop this id from the registry once its shell exits so a later
    // spawn with the same id can restart it. Generation-guarded: by the time
    // a killed shell's wait() returns, the same id may already be re-registered
    // to a successor session (React dev remount) — removing blindly would drop
    // the successor's PtySession, closing its master and EOF-killing its shell.
    let id_for_reaper = id;
    std::thread::spawn(move || {
        let status = child.wait();
        alive.store(false, Ordering::Release);
        // An intentional kill (remount cleanup, tab close, app exit) is not
        // friction; a shell that died on its own is.
        if !expected_exit_for_reaper.load(Ordering::SeqCst) {
            let detail = match &status {
                Ok(st) if st.success() => "shell exited unexpectedly (status 0)".to_string(),
                Ok(st) => format!("shell exited unexpectedly with {st:?}"),
                Err(e) => format!("wait() failed: {e}"),
            };
            crate::db::note_friction("pty_exit", Some("terminal"), None, Some(&detail));
        }
        if let Some(state) = app.try_state::<PtyState>() {
            // Never lock a session while holding the registry lock (that
            // inverts the lock order used everywhere else). Snapshot the
            // entry's Arc, drop the registry lock, check the generation, then
            // re-take the registry lock and only remove if the SAME Arc is
            // still installed — the id may have been re-registered in the gap.
            let candidate = lock_ok(&state.0).get(&id_for_reaper).cloned();
            let Some(candidate) = candidate else { return };
            if lock_ok(&candidate).generation != generation {
                return;
            }
            let mut map = lock_ok(&state.0);
            if map
                .get(&id_for_reaper)
                .is_some_and(|cur| Arc::ptr_eq(cur, &candidate))
            {
                map.remove(&id_for_reaper);
            }
        }
    });

    Ok(())
}

fn read_output(mut reader: Box<dyn Read + Send>, output: Arc<Pump>) {
    let mut buf = [0u8; 8192];
    while output.wait_until_drained() {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                LAST_PTY_OUTPUT_MS.store(crate::ledger::now_millis(), Ordering::Relaxed);
                output.push(&buf[..n]);
            }
            Err(_) => break,
        }
    }
    output.close();
}

/// Pull a session out of the registry without holding the outer lock across
/// any I/O — the entire point of the per-session split.
fn session_of(state: &PtyState, id: &str) -> Option<Arc<Mutex<PtySession>>> {
    lock_ok(&state.0).get(id).cloned()
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
    write_chunk(&session, bytes)
}

/// The tty input queue is **1024 bytes** on macOS (`TTYHOG` in the kernel's
/// tty layer). A single write to the PTY master larger than what the shell has
/// drained is not blocked and not short-counted — the kernel **discards the
/// excess and reports success**. So a long typed command arrives at zsh cut
/// off mid-word, sitting unexecuted in the line editor, with no error anywhere
/// in Redline, in the shell, or in the return value.
///
/// Measured: a 6,476-byte plan launch reached the shell truncated at byte
/// 1023. This was never Codex-specific — it is the ceiling on ANY programmatic
/// injection, and a Drafter document longer than a paragraph has always been
/// riding it. Chunking below the queue size and yielding between chunks lets
/// the shell drain; `write_all` on each chunk still catches a real I/O error.
const PTY_CHUNK: usize = 512;
/// Long enough for zsh's line editor to drain a chunk, short enough that a
/// 60 KB document still types in well under a second.
///
/// Both halves measured at this exact pacing, 2026-09-02, after a report of a
/// corrupted 113 KB launch sent someone looking here:
///
/// * a raw-mode tty with a fast reader takes 100 KB with **zero loss** in
///   1.10 s — the queue is not the ceiling once writes are paced;
/// * zsh's line editor takes 22 KB with **zero loss** in 0.88 s.
///
/// So the pacing does what it claims and a long typed command arrives whole.
/// Recorded because the second measurement is easy to get WRONG: zsh redraws
/// the entire command line on every chunk, emitting far more than it consumes,
/// so a test that does not drain the master fd continuously will back-pressure
/// zsh into blocking on its own output and read that as "the line editor
/// cannot keep up". It can.
const PTY_CHUNK_PAUSE: Duration = Duration::from_millis(4);

/// The verified twin of `pty_write`: an unregistered id is an ERROR, not a
/// silent no-op. Every *programmatic* injection (the Orchestrate handoff,
/// plan launches, restore) goes through this — a write into a terminal that
/// does not exist must be distinguishable from one that landed. The soft
/// `pty_write`/`pty_write_bytes` contract stays untouched for the best-effort
/// auto-continue inject and user keystrokes.
///
/// `(async)` because it PACES: see `PTY_CHUNK`. A sync command runs on the main
/// thread, where the pauses would freeze the UI for the length of the write.
#[tauri::command(async)]
pub async fn pty_write_checked(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = session_of(&state, &id).ok_or_else(|| format!("terminal {id} is not running"))?;
    // The lock is taken PER CHUNK inside the sink and never held across the
    // await — a guard is not `Send`, and holding one for the length of a paced
    // write would block the reader's own use of the session.
    paced(data.as_bytes(), |chunk| write_chunk(&session, chunk)).await
}

/// Feed `bytes` to `sink` in `PTY_CHUNK`-sized pieces, pausing between them.
///
/// The sink is a closure rather than a writer so the pacing law can be tested
/// against a recorder (chunk boundaries) and against a real PTY (bytes arrive
/// whole) without either test reimplementing the loop it is supposed to pin.
async fn paced<F>(bytes: &[u8], mut sink: F) -> Result<(), String>
where
    F: FnMut(&[u8]) -> Result<(), String>,
{
    for (i, chunk) in bytes.chunks(PTY_CHUNK).enumerate() {
        if i > 0 {
            tokio::time::sleep(PTY_CHUNK_PAUSE).await;
        }
        sink(chunk)?;
    }
    Ok(())
}

/// One unpaced write into a session. Split out so the paced command and the
/// synchronous callers share the same error mapping.
fn write_chunk(session: &Arc<Mutex<PtySession>>, bytes: &[u8]) -> Result<(), String> {
    let mut s = lock_ok(session);
    s.writer
        .write_all(bytes)
        .map_err(|e| format!("pty write failed: {e}"))?;
    s.writer.flush().ok();
    Ok(())
}

/// Internal helper behind `pty_write_checked`, callable from Rust and tests.
///
/// Synchronous, so it writes in one go — correct for the short injections Rust
/// makes itself (a menu-skip keystroke). Anything that can exceed
/// `PTY_CHUNK` must go through the paced command instead.
pub fn pty_write_bytes_checked(state: &PtyState, id: &str, bytes: &[u8]) -> Result<(), String> {
    debug_assert!(
        bytes.len() <= PTY_CHUNK,
        "unpaced write of {} bytes will be truncated by the tty input queue",
        bytes.len()
    );
    let Some(session) = session_of(state, id) else {
        return Err(format!("terminal {id} is not running"));
    };
    write_chunk(&session, bytes)
}

/// A backend-owned terminal, including its original launch directory. A dead
/// entry can appear during the short EOF→reaper window; callers must use alive.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PtyInfo {
    id: String,
    cwd: Option<String>,
    pid: Option<u32>,
    alive: bool,
}

#[tauri::command(async)]
pub fn pty_list(state: tauri::State<'_, PtyState>) -> Vec<PtyInfo> {
    state.entries()
}

fn attach_session(
    state: &PtyState,
    id: &str,
    on_output: Channel<Response>,
    attachment_id: String,
) -> Result<(), String> {
    let session = session_of(state, id).ok_or_else(|| format!("terminal {id} is not running"))?;
    let output = lock_ok(&session).output.clone();
    output.attach(on_output, Some(attachment_id))
}

/// Rebind an existing shell without forking it. Replay and live writes use one
/// ordering lock, so the new xterm receives each retained byte exactly once.
#[tauri::command(async)]
pub fn pty_attach(
    state: tauri::State<'_, PtyState>,
    id: String,
    on_output: Channel<Response>,
    attachment_id: String,
) -> Result<(), String> {
    attach_session(&state, &id, on_output, attachment_id)
}

/// Unmount releases only this subscriber; an earlier mount's cleanup cannot
/// detach the successor. The shell and bounded replay continue until close.
#[tauri::command(async)]
pub fn pty_detach(state: tauri::State<'_, PtyState>, id: String, attachment_id: String) {
    if let Some(session) = session_of(&state, &id) {
        let output = lock_ok(&session).output.clone();
        output.detach(&attachment_id);
    }
}

/// Registry membership — the handoff's spawn probe.
#[tauri::command]
pub fn pty_is_live(state: tauri::State<'_, PtyState>, id: String) -> bool {
    session_of(&state, &id).is_some_and(|session| lock_ok(&session).alive.load(Ordering::Acquire))
}

#[tauri::command(async)]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = session_of(&state, &id).ok_or("no terminal running")?;
    let s = lock_ok(&session);
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
pub fn pty_ack(
    state: tauri::State<'_, PtyState>,
    id: String,
    n: usize,
    attachment_id: Option<String>,
) {
    if let Some(session) = session_of(&state, &id) {
        let output = lock_ok(&session).output.clone();
        output.ack(n, attachment_id.as_deref());
    }
}

#[tauri::command(async)]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    // Remove from the registry (outer lock only), then kill the underlying
    // child outside any lock.
    let session = { lock_ok(&state.0).remove(&id) };
    if let Some(session) = session {
        let mut s = lock_ok(&session);
        s.expected_exit.store(true, Ordering::SeqCst); // suppress pty-exit
        s.output.close(); // unpark the reader if it's gated on flow control
        let _ = s.killer.kill();
    }
    Ok(())
}

/// `(client_pid, terminal_id)` for the process that opened the held connection
/// from `peer_port`. `client_pid` is the long-lived `claude`/node process that
/// made the hook POST and blocks on it — returned **even when the terminal
/// can't be resolved** (external terminal, or the tab has no live shell), so a
/// liveness probe still works there. `terminal_id` is `Some` only when the
/// pid's ancestry lands on one of our spawned shells — used to pin the "plan
/// intercepted" strip to the exact tab whose `claude` is blocked.
pub fn client_pid_and_terminal_for_port(
    state: &PtyState,
    peer_port: u16,
) -> (Option<u32>, Option<String>) {
    let shells = shell_pid_to_terminal(state);
    let Ok(output) = std::process::Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{peer_port}"),
            "-sTCP:ESTABLISHED",
            "-Fpn",
        ])
        .output()
    else {
        return (None, None);
    };
    let client_pid = parse_lsof_client_pid(&String::from_utf8_lossy(&output.stdout), peer_port);
    let terminal = client_pid
        .filter(|_| !shells.is_empty())
        .and_then(|p| walk_to_terminal(p, &shells, ppid_of));
    (client_pid, terminal)
}

/// Snapshot of live shell pids → their terminal tab ids.
fn shell_pid_to_terminal(state: &PtyState) -> HashMap<u32, String> {
    // Snapshot the Arcs under the registry lock, then read each session's pid
    // with the registry lock DROPPED — inner-while-outer locking here inverted
    // the order every other path uses and could deadlock the whole dock.
    let sessions: Vec<(String, Arc<Mutex<PtySession>>)> = lock_ok(&state.0)
        .iter()
        .map(|(id, s)| (id.clone(), s.clone()))
        .collect();
    sessions
        .into_iter()
        .filter_map(|(id, s)| lock_ok(&s).pid.map(|pid| (pid, id)))
        .collect()
}

/// Pick the pid that owns the *client* end of the connection out of `lsof
/// -Fpn` output. Both endpoints match `-iTCP:<port>` (Redline holds
/// `:7676-><port>`, the client holds `:<port>->:7676`), so key on the line
/// whose local endpoint is the peer port — `:<port>->` only ever appears on
/// the client's side.
fn parse_lsof_client_pid(output: &str, peer_port: u16) -> Option<u32> {
    let needle = format!(":{peer_port}->");
    let mut current_pid: Option<u32> = None;
    for line in output.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current_pid = pid.trim().parse().ok();
        } else if let Some(name) = line.strip_prefix('n') {
            if name.contains(&needle) {
                return current_pid.filter(|&p| p != std::process::id());
            }
        }
    }
    None
}

/// Climb the parent chain from `start_pid` until a registered shell pid is
/// hit. Bounded: the real chain is short (claude → shell), and a pid that
/// escapes to launchd (pid ≤ 1) was never ours.
fn walk_to_terminal(
    start_pid: u32,
    shells: &HashMap<u32, String>,
    mut parent_of: impl FnMut(u32) -> Option<u32>,
) -> Option<String> {
    let mut pid = start_pid;
    for _ in 0..16 {
        if let Some(tid) = shells.get(&pid) {
            return Some(tid.clone());
        }
        pid = parent_of(pid)?;
        if pid <= 1 {
            return None;
        }
    }
    None
}

fn ppid_of(pid: u32) -> Option<u32> {
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// The live working directory of a terminal's shell — so "open a terminal
/// here" can follow wherever the user `cd`'d. macOS/Linux: ask `lsof` for the
/// shell pid's `cwd` fd. Returns `None` if it can't be determined.
#[tauri::command(async)]
pub fn pty_cwd(state: tauri::State<'_, PtyState>, id: String) -> Option<String> {
    let session = session_of(&state, &id)?;
    let pid = lock_ok(&session).pid?;
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
        .filter(|p| !p.is_empty())
}

/// Batched twin of `pty_cwd`: the live cwds of every requested terminal in ONE
/// `lsof` fork. The frontend polls every *visible* tile each tick, and the tile
/// menu refreshes the whole fleet on open — per-id `pty_cwd` calls made that one
/// subprocess per terminal per tick (the exact regression the old two-pane cap
/// existed to contain). Ids with no live session, no pid, or no `lsof` answer
/// are simply absent from the map — absence is the "keep your last-known label"
/// signal, never an error.
#[tauri::command(async)]
pub fn pty_cwds(state: tauri::State<'_, PtyState>, ids: Vec<String>) -> HashMap<String, String> {
    let mut pid_to_id: HashMap<u32, String> = HashMap::new();
    for id in ids {
        if let Some(session) = session_of(&state, &id) {
            if let Some(pid) = lock_ok(&session).pid {
                pid_to_id.insert(pid, id);
            }
        }
    }
    if pid_to_id.is_empty() {
        return HashMap::new();
    }
    let pid_list = pid_to_id
        .keys()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    // Don't gate on exit status: lsof exits non-zero when ANY listed pid is
    // already gone, while still printing the groups for the live ones.
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid_list, "-d", "cwd", "-Fpn"])
        .output()
    else {
        return HashMap::new();
    };
    parse_lsof_cwds(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .filter_map(|(pid, path)| pid_to_id.get(&pid).map(|id| (id.clone(), path)))
        .collect()
}

/// Demultiplex `lsof -Fpn` output into pid → cwd. Groups arrive as `p<pid>` /
/// `fcwd` / `n<path>` lines; the `p` field scopes every following `n` until the
/// next `p`. `f` lines (and anything else) are skipped, an `n` before any `p`
/// is dropped rather than misattributed.
fn parse_lsof_cwds(output: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let mut current_pid: Option<u32> = None;
    for line in output.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current_pid = pid.trim().parse().ok();
        } else if let Some(path) = line.strip_prefix('n') {
            if let Some(pid) = current_pid {
                if !path.is_empty() {
                    out.insert(pid, path.to_string());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_output() -> Arc<Pump> {
        Pump::new(Arc::new(AtomicBool::new(true)))
    }

    fn recording_channel() -> (Channel<Response>, Arc<Mutex<Vec<u8>>>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let recorded = bytes.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Raw(chunk) = body else {
                panic!("PTY channels must carry raw bytes");
            };
            lock_ok(&recorded).extend(chunk);
            Ok(())
        });
        (channel, bytes)
    }

    #[test]
    fn every_attachment_starts_with_one_replay_frame_even_when_empty() {
        let output = new_output();
        let frames = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let recorded = frames.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Raw(bytes) = body else {
                panic!("raw bytes")
            };
            lock_ok(&recorded).push(bytes);
            Ok(())
        });
        output
            .attach(channel.clone(), Some("first".into()))
            .unwrap();
        assert_eq!(*lock_ok(&frames), vec![Vec::<u8>::new()]);
        output.push(b"live");
        output.flush();
        output.attach(channel, Some("second".into())).unwrap();
        output.push(b"next");
        output.flush();
        assert_eq!(
            *lock_ok(&frames),
            vec![vec![], b"live".to_vec(), b"live".to_vec(), b"next".to_vec()]
        );
    }

    #[test]
    fn detached_output_retains_only_the_bounded_tail_without_pending_bytes() {
        let output = new_output();
        let bytes: Vec<u8> = (0..REPLAY_CAPACITY * 3).map(|i| (i % 251) as u8).collect();
        for chunk in bytes.chunks(8192) {
            assert!(output.wait_until_drained());
            output.push(chunk);
        }
        {
            let inner = lock_ok(&output.inner);
            assert_eq!(inner.replay.len(), REPLAY_CAPACITY);
            assert!(inner.pending.is_empty());
            assert_eq!(inner.unacked, 0);
        }
        let (channel, replayed) = recording_channel();
        output.attach(channel, Some("new-page".into())).unwrap();
        assert_eq!(*lock_ok(&replayed), bytes[bytes.len() - REPLAY_CAPACITY..]);
        assert_eq!(lock_ok(&output.inner).unacked, REPLAY_CAPACITY);
    }

    #[test]
    fn reattach_replays_unflushed_output_once_before_live_bytes() {
        let output = new_output();
        let (first, old_bytes) = recording_channel();
        output.attach(first, Some("old".into())).unwrap();
        output.push(b"before-");
        let (second, new_bytes) = recording_channel();
        output.attach(second, Some("new".into())).unwrap();
        output.flush();
        output.push(b"after");
        output.flush();
        assert!(lock_ok(&old_bytes).is_empty());
        assert_eq!(*lock_ok(&new_bytes), b"before-after");
    }

    #[test]
    fn stale_ack_and_detach_cannot_affect_the_new_attachment() {
        let output = new_output();
        output
            .attach(Channel::new(|_| Ok(())), Some("old".into()))
            .unwrap();
        output.push(b"history");
        output
            .attach(Channel::new(|_| Ok(())), Some("new".into()))
            .unwrap();
        output.ack(1000, Some("old"));
        output.detach("old");
        assert_eq!(lock_ok(&output.inner).unacked, 7);
        assert!(lock_ok(&output.inner).channel.is_some());
        output.ack(7, Some("new"));
        assert_eq!(lock_ok(&output.inner).unacked, 0);
        output.detach("new");
        assert!(lock_ok(&output.inner).channel.is_none());
        assert!(output.alive.load(Ordering::Acquire));
    }

    #[test]
    fn failed_channel_detaches_without_stopping_the_pump() {
        let output = new_output();
        output
            .attach(
                Channel::new(|body| match body {
                    tauri::ipc::InvokeResponseBody::Raw(bytes) if bytes.is_empty() => Ok(()),
                    _ => Err(std::io::Error::other("gone").into()),
                }),
                None,
            )
            .unwrap();
        output.push(b"before-");
        output.flush();
        assert!(lock_ok(&output.inner).channel.is_none());
        assert!(!lock_ok(&output.inner).closed);
        assert!(output.alive.load(Ordering::Acquire));
        output.push(b"after");
        let (channel, replayed) = recording_channel();
        output.attach(channel, Some("reloaded".into())).unwrap();
        assert_eq!(*lock_ok(&replayed), b"before-after");
    }

    #[test]
    fn missing_ack_suspends_delivery_and_late_ack_resumes_only_missing_bytes() {
        let output = new_output();
        let (channel, received) = recording_channel();
        output.attach(channel, Some("lost-page".into())).unwrap();
        for _ in 0..=FLOW_HIGH_WATER / 8192 {
            output.push(&[0; 8192]);
        }
        assert_eq!(
            lock_ok(&output.inner).pending.buf.len(),
            FLOW_HIGH_WATER + 8192
        );
        lock_ok(&output.inner).last_ack = Instant::now() - FLOW_STALL_TIMEOUT;
        assert!(output.wait_until_drained());
        {
            let inner = lock_ok(&output.inner);
            assert!(inner.channel.is_some());
            assert!(inner.suspended);
            assert!(inner.pending.is_empty());
            assert_eq!(inner.unacked, FLOW_HIGH_WATER + 8192);
            assert_eq!(inner.replay.len(), REPLAY_CAPACITY);
        }
        let sent_before = lock_ok(&received).len();
        output.push(b"late bytes");
        output.flush();
        assert_eq!(lock_ok(&received).len(), sent_before);
        output.ack(FLOW_HIGH_WATER + 8192, Some("lost-page"));
        assert!(!lock_ok(&output.inner).suspended);
        assert_eq!(&lock_ok(&received)[sent_before..], b"late bytes");
        output.push(b" live");
        output.flush();
        assert_eq!(&lock_ok(&received)[sent_before..], b"late bytes live");
    }

    #[test]
    fn resume_after_ring_overflow_resets_and_replays_only_retained_tail() {
        let output = new_output();
        let (channel, received) = recording_channel();
        output.attach(channel, Some("slow".into())).unwrap();
        output.push(b"old screen");
        output.flush();
        lock_ok(&output.inner).suspended = true;
        output.push(&vec![b'x'; REPLAY_CAPACITY * 3]);
        output.ack(10, Some("slow"));
        let received = lock_ok(&received);
        assert_eq!(&received[..12], b"old screen\x1bc");
        assert_eq!(received.len(), 12 + REPLAY_CAPACITY);
        assert!(received[12..].iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn first_output_after_idle_gets_a_fresh_ack_grace_period() {
        let output = new_output();
        output.attach(Channel::new(|_| Ok(())), None).unwrap();
        lock_ok(&output.inner).last_ack = Instant::now() - FLOW_STALL_TIMEOUT;
        output.push(b"first burst after an idle prompt");
        assert!(lock_ok(&output.inner).last_ack.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn closed_output_rejects_attach_and_releases_read_and_flush_waiters() {
        let output = new_output();
        output.close();
        assert!(!output.wait_until_drained());
        assert!(!output.wait_for_output());
        assert!(output.attach(Channel::new(|_| Ok(())), None).is_err());
        assert!(!output.alive.load(Ordering::Acquire));
    }

    #[test]
    fn concurrent_flush_and_reattach_preserve_byte_order() {
        let output = new_output();
        output
            .attach(Channel::new(|_| Ok(())), Some("old".into()))
            .unwrap();
        output.push(b"prefix-");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker_output = output.clone();
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            worker_barrier.wait();
            worker_output.flush();
            worker_output.push(b"concurrent-");
            worker_output.flush();
        });
        let (channel, replayed) = recording_channel();
        barrier.wait();
        output.attach(channel, Some("new".into())).unwrap();
        worker.join().unwrap();
        output.push(b"last");
        output.flush();
        assert_eq!(*lock_ok(&replayed), b"prefix-concurrent-last");
    }

    /// A real shell/PTY, without starting Tauri or the application. Drop kills
    /// and reaps it even if an assertion fails, so the test cannot orphan it.
    struct TestPty {
        state: PtyState,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        output: Arc<Pump>,
    }

    impl TestPty {
        fn new() -> Self {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", "stty raw -echo; printf ready; exec cat"]);
            command.cwd("/tmp");
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let reader = pair.master.try_clone_reader().unwrap();
            let writer = pair.master.take_writer().unwrap();
            let output = new_output();
            let state = PtyState::new();
            lock_ok(&state.0).insert(
                "real-pty".into(),
                Arc::new(Mutex::new(PtySession {
                    master: pair.master,
                    writer,
                    killer: child.clone_killer(),
                    cwd: Some("/tmp".into()),
                    pid: child.process_id(),
                    generation: 1,
                    alive: output.alive.clone(),
                    output: output.clone(),
                    expected_exit: Arc::new(AtomicBool::new(false)),
                })),
            );
            let reader_output = output.clone();
            std::thread::spawn(move || read_output(reader, reader_output));
            let flusher_output = output.clone();
            std::thread::spawn(move || {
                while flusher_output.wait_for_output() {
                    flusher_output.flush();
                }
            });
            Self {
                state,
                child,
                output,
            }
        }
    }

    impl Drop for TestPty {
        fn drop(&mut self) {
            self.output.close();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn real_pty_rebind_keeps_pid_replays_history_and_lists_dead_entries() {
        let mut terminal = TestPty::new();
        let (sender, received) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Raw(bytes) = body else {
                panic!("raw bytes")
            };
            sender.send(bytes).unwrap();
            Ok(())
        });
        attach_session(&terminal.state, "real-pty", channel, "first".into()).unwrap();
        let mut initial = Vec::new();
        while initial.len() < 5 {
            initial.extend(received.recv_timeout(Duration::from_secs(3)).unwrap());
        }
        assert_eq!(initial, b"ready");
        let before = terminal.state.entries();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].cwd.as_deref(), Some("/tmp"));
        assert_eq!(before[0].pid, terminal.child.process_id());
        assert!(before[0].alive);
        terminal.output.detach("first");
        let (new_channel, replayed) = recording_channel();
        attach_session(&terminal.state, "real-pty", new_channel, "second".into()).unwrap();
        assert_eq!(*lock_ok(&replayed), b"ready");
        assert_eq!(terminal.state.entries()[0].pid, before[0].pid);
        pty_write_bytes_checked(&terminal.state, "real-pty", b"after").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while lock_ok(&replayed).len() < 10 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(*lock_ok(&replayed), b"readyafter");
        terminal.child.kill().unwrap();
        terminal.child.wait().unwrap();
        terminal.output.close();
        assert!(!terminal.state.entries()[0].alive);
        assert!(terminal.state.live_ids().is_empty());
        assert!(attach_session(
            &terminal.state,
            "real-pty",
            Channel::new(|_| Ok(())),
            "dead".into()
        )
        .is_err());
        assert!(attach_session(
            &terminal.state,
            "missing",
            Channel::new(|_| Ok(())),
            "none".into()
        )
        .is_err());
    }

    #[test]
    fn pty_write_bytes_is_silent_noop_for_missing_id() {
        // The post-submit auto-continue inject calls this with a best-effort
        // terminal id; a missing PTY (closed tab) must not surface as an
        // error or panic — `submit_review` should still succeed.
        let state = PtyState::new();
        assert!(pty_write_bytes(&state, "no-such-tab", b"3\r").is_ok());
    }

    #[test]
    fn pty_write_bytes_checked_errors_for_missing_id() {
        // The verified twin: a programmatic injection into a terminal that
        // does not exist must fail loudly — this indistinguishability is what
        // let the Orchestrate handoff evaporate silently.
        let state = PtyState::new();
        let err = pty_write_bytes_checked(&state, "no-such-tab", b"claude\r")
            .expect_err("missing id must be an error");
        assert!(err.contains("no-such-tab"), "got: {err}");
        assert!(err.contains("not running"), "got: {err}");
    }

    /// The macOS tty input queue (`TTYHOG`). A write larger than what the
    /// shell has drained is not blocked and not short-counted — the kernel
    /// discards the excess and reports success.
    const TTY_INPUT_QUEUE: usize = 1024;

    #[test]
    fn the_chunk_fits_inside_the_tty_input_queue() {
        assert!(
            PTY_CHUNK < TTY_INPUT_QUEUE,
            "a chunk at or above the queue size is the bug, not the fix",
        );
    }

    #[tokio::test]
    async fn a_paced_write_is_split_and_loses_nothing() {
        // The measured failure: a 6,476-byte plan launch reached zsh cut off
        // at byte 1023, sitting unexecuted, with no error anywhere.
        let payload: Vec<u8> = (0..6_476u32).map(|i| (i % 251) as u8).collect();
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        paced(&payload, |c| {
            chunks.push(c.to_vec());
            Ok(())
        })
        .await
        .unwrap();

        assert!(
            chunks.len() > 1,
            "a 6 KB write must not go out in one piece"
        );
        assert!(chunks.iter().all(|c| c.len() <= PTY_CHUNK));
        assert_eq!(
            chunks.concat(),
            payload,
            "pacing must not drop, duplicate or reorder a byte",
        );
    }

    #[tokio::test]
    async fn a_short_write_is_still_one_write() {
        // Every keystroke-sized injection goes through here too; splitting a
        // 2-byte menu answer would be pure latency.
        let mut n = 0;
        paced(b"3\r", |_| {
            n += 1;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn a_sink_error_stops_the_write_rather_than_racing_on() {
        let mut seen = 0;
        let err = paced(&vec![b'x'; PTY_CHUNK * 3], |_| {
            seen += 1;
            Err("pty write failed: broken pipe".to_string())
        })
        .await
        .expect_err("a failed chunk must surface");
        assert_eq!(seen, 1, "no further chunks after a failure");
        assert!(err.contains("broken pipe"));
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
        let output = new_output();
        output.attach(Channel::new(|_| Ok(())), None).unwrap();
        output.push(&[0; 1000]);
        output.ack(400, None);
        assert_eq!(lock_ok(&output.inner).unacked, 600);
        output.ack(10_000, None);
        assert_eq!(lock_ok(&output.inner).unacked, 0);
    }

    #[test]
    fn lsof_parse_picks_the_client_end_not_the_server_end() {
        // -iTCP:<port> matches BOTH endpoints of the loopback connection; the
        // strip must bind to the terminal hosting the *client* (claude), so
        // the parser must skip Redline's own server-side line.
        let lsof =
            "p100\nn127.0.0.1:7676->127.0.0.1:54321\np200\nn127.0.0.1:54321->127.0.0.1:7676\n";
        assert_eq!(parse_lsof_client_pid(lsof, 54321), Some(200));
        // No client line at all (connection already gone) → None, never a
        // misattributed pid.
        let server_only = "p100\nn127.0.0.1:7676->127.0.0.1:54321\n";
        assert_eq!(parse_lsof_client_pid(server_only, 54321), None);
    }

    #[test]
    fn ancestry_walk_finds_the_owning_shell_and_rejects_foreign_chains() {
        // claude(300) → zsh(200, a registered tab) — must resolve to that tab.
        let shells: HashMap<u32, String> = [(200u32, "tab-a".to_string())].into();
        let parents: HashMap<u32, u32> = [(300u32, 200u32), (200, 50), (400, 1)].into();
        let walk = |p: u32| parents.get(&p).copied();
        assert_eq!(
            walk_to_terminal(300, &shells, walk),
            Some("tab-a".to_string())
        );
        // A process from an external terminal climbs to launchd without ever
        // touching a registered shell → None (the strip must NOT show).
        assert_eq!(walk_to_terminal(400, &shells, walk), None);
        // Unknown pid with no parent info → None, no infinite loop.
        assert_eq!(walk_to_terminal(999, &shells, walk), None);
    }

    #[test]
    fn lock_ok_recovers_a_poisoned_mutex() {
        // A panic on a thread holding a PTY lock poisons the mutex; every
        // later locker used to propagate that panic — on the Tauri main
        // thread that meant process teardown and every shell dying at once.
        // lock_ok must hand back the guard with the data intact instead.
        let m = Arc::new(Mutex::new(7u32));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(m.lock().is_err(), "precondition: mutex must be poisoned");
        assert_eq!(*lock_ok(&m), 7);
        *lock_ok(&m) += 1;
        assert_eq!(*lock_ok(&m), 8);
    }

    #[test]
    fn lsof_cwds_demultiplexes_on_the_p_field() {
        // One `lsof -a -p a,b,c -d cwd -Fpn` answers for the whole fleet; the
        // parser must scope each `n<path>` to the `p<pid>` group it follows.
        let lsof = "p100\nfcwd\nn/Users/dev/redline\np200\nfcwd\nn/Users/dev/api\n";
        let map = parse_lsof_cwds(lsof);
        assert_eq!(map.len(), 2);
        assert_eq!(
            map.get(&100).map(String::as_str),
            Some("/Users/dev/redline")
        );
        assert_eq!(map.get(&200).map(String::as_str), Some("/Users/dev/api"));
    }

    #[test]
    fn lsof_cwds_tolerates_missing_groups_and_garbage() {
        // A pid that died between the registry snapshot and the fork simply has
        // no group; stray lines and an `n` with no preceding `p` must be
        // dropped, never misattributed or panicked on.
        let map = parse_lsof_cwds("n/orphan/path\np300\nfcwd\nn/Users/dev/polis\nu501\n");
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(&300).map(String::as_str), Some("/Users/dev/polis"));
        // Empty output (every pid gone) → empty map, not an error.
        assert!(parse_lsof_cwds("").is_empty());
        // Unparseable pid poisons its group, not the whole parse.
        let map = parse_lsof_cwds("pXYZ\nn/never/attributed\np400\nn/real\n");
        assert_eq!(map.len(), 1);
        assert_eq!(map.get(&400).map(String::as_str), Some("/real"));
    }

    #[test]
    fn flow_gate_does_not_block_below_high_water() {
        // Under the high-water mark the reader must never park — interactive
        // output can't wait on an ACK that only comes after it's displayed.
        let output = new_output();
        output.attach(Channel::new(|_| Ok(())), None).unwrap();
        output.push(&vec![0; FLOW_HIGH_WATER / 2]);
        assert!(output.wait_until_drained()); // returns promptly (no deadlock)
    }
}

#[tauri::command(async)]
pub fn pty_kill_all(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    // Drain the map (outer lock only), then kill each child outside the lock
    // so one stuck killer can't block the others.
    let drained: Vec<Arc<Mutex<PtySession>>> = {
        let mut guard = lock_ok(&state.0);
        guard.drain().map(|(_, v)| v).collect()
    };
    for session in drained {
        let mut s = lock_ok(&session);
        s.expected_exit.store(true, Ordering::SeqCst); // suppress pty-exit
        s.output.close();
        let _ = s.killer.kill();
    }
    Ok(())
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The app's side of `redline-ptyd`, the helper that owns the terminals so
//! they outlive Redline (crates/redline-ptyd; plan: PTY helper).
//!
//! One connection carries every terminal. A **reader thread** demultiplexes
//! the helper's frames: replays and live output to each terminal's
//! [`Channel`], `Mode` / `Activity` / `Exit` to an event sink, replies to the
//! request waiting on them. A **writer thread** drains one ordered queue, so
//! `pty_write` stays synchronous for keystroke order but only enqueues, and
//! the main thread never blocks on the socket.
//!
//! The cache here is what the in-process registry answered from: which
//! terminals are live, their pids, startup cwds, metadata and paste mode. The
//! helper pushes every change (`Spawned`, `Mode`, `Exit`), so nothing polls.
//!
//! An attach is routed by its attachment id, not by arrival: a view that
//! attaches twice in a row gets the second `Replay` on the second channel
//! and nothing of the first, because the channel only changes when the
//! `Replay` naming it arrives (socket order puts every earlier byte before it).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use redline_pty_proto::{self as proto, Frame, Msg, Row};
use redline_ptyd::{peer, sock};
use tauri::ipc::{Channel, Response};

/// The caps this app needs from a helper to use it for new terminals. A
/// helper without one is still listed, attached and killed (the frozen core);
/// it just gets no new terminals (P3: it retires).
pub const REQUIRED_CAPS: &[&str] = &["tail", "meta"];

/// A helper answers `Hello` in microseconds; one that doesn't within this is
/// stuck, and a boot never waits longer than this per socket for it.
const HELLO_TIMEOUT: Duration = Duration::from_millis(200);
/// The biggest `Input` frame's payload: a longer write is several frames,
/// so a paste is never refused for the 1 MiB frame cap.
const INPUT_CHUNK: usize = 512 * 1024;
/// How long a request waits for its reply. Generous: the helper answers in
/// microseconds unless it is stuck, and a stuck helper is the fallback case.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where a helper lives and what it must be.
#[derive(Debug, Clone)]
pub struct HelperConfig {
    /// The app data dir (0700); the socket goes in it.
    pub dir: PathBuf,
    /// `ptyd-<h>.sock`.
    pub sock: String,
    /// The sibling `redline-ptyd` executable.
    pub exe: PathBuf,
    /// The directory the helper accepts peers from: the app's own.
    pub peer_dir: PathBuf,
}

impl HelperConfig {
    /// The helper for this executable: `ptyd-<first 8 hex of sha256(exe)>`,
    /// so the release app, the dev app and every worktree's dev app each get
    /// their own and a walk lane never adopts the user's terminals.
    pub fn for_exe(exe: &Path, data_dir: &Path) -> Option<Self> {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(exe.as_os_str().as_encoded_bytes());
        let h: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
        Some(Self {
            dir: data_dir.to_path_buf(),
            sock: format!("ptyd-{h}.sock"),
            exe: sock::sibling(exe)?,
            peer_dir: exe.parent()?.to_path_buf(),
        })
    }

    /// The running app's helper.
    pub fn for_app(data_dir: &Path) -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        Self::for_exe(&exe, data_dir)
    }

    /// The socket a retiring helper of `instance` moves to.
    pub fn retired_sock(&self, instance: u64) -> String {
        let stem = self.sock.trim_end_matches(".sock");
        format!("{stem}-{instance:016x}.sock")
    }

    /// The sockets retiring helpers of this app serve (`ptyd-<h>-*.sock`),
    /// by name: each still holds terminals an older build started.
    pub fn retired_socks(&self) -> Vec<String> {
        let stem = format!("{}-", self.sock.trim_end_matches(".sock"));
        let Ok(dir) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut names: Vec<String> = dir
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with(&stem) && n.ends_with(".sock"))
            .collect();
        names.sort();
        names
    }

    /// This config pointed at another socket in the same directory.
    pub fn at_sock(&self, sock: &str) -> Self {
        Self { sock: sock.to_string(), ..self.clone() }
    }

    fn spawn_args(&self) -> Vec<String> {
        vec![
            "--dir".into(),
            self.dir.display().to_string(),
            "--sock".into(),
            self.sock.clone(),
            "--peer-dir".into(),
            self.peer_dir.display().to_string(),
        ]
    }
}

/// What the helper told us about itself.
#[derive(Debug, Clone)]
pub struct Welcome {
    pub core: u16,
    pub caps: Vec<String>,
    pub build: String,
    pub instance: u64,
    pub token: String,
    pub pid: u32,
}

impl Welcome {
    /// The frame set and caps are this build's.
    pub fn speaks_ours(&self) -> bool {
        self.core == proto::CORE && REQUIRED_CAPS.iter().all(|c| self.caps.iter().any(|h| h == c))
    }
}

/// What the client reports to the app.
pub enum Event {
    /// A terminal's shell exited. `expected` after a kill.
    Exit { id: String, status: i32, expected: bool },
    /// The program switched bracketed paste.
    Mode { id: String },
    /// Output flowed (unix ms), at most once a second per terminal.
    Activity(i64),
    /// The helper went away: these terminals died with it.
    Gone { ids: Vec<String> },
}

pub type Sink = Arc<dyn Fn(Event) + Send + Sync>;

/// One terminal as the cache knows it.
#[derive(Clone)]
pub struct TermInfo {
    pub id: String,
    pub handle: u32,
    pub pid: Option<u32>,
    pub alive: bool,
    /// A tombstone's wait status.
    pub exit: Option<i32>,
    pub cwd: Option<String>,
    pub started_at: u64,
    pub last_output: u64,
    pub persist: bool,
    pub meta: Vec<u8>,
    pub paste: bool,
}

struct Term {
    info: TermInfo,
    channel: Option<Channel<Response>>,
    attachment: Option<String>,
    /// Attaches sent but not yet answered by their `Replay`, oldest first.
    attaching: Vec<(String, Channel<Response>)>,
}

impl Term {
    fn from_row(row: &Row) -> Self {
        Self {
            info: TermInfo {
                id: row.id.clone(),
                handle: row.handle,
                pid: (row.pid > 0).then_some(row.pid),
                alive: row.alive,
                exit: row.exit,
                cwd: row.cwd.clone(),
                started_at: row.started_at,
                last_output: row.last_output,
                persist: row.persist,
                meta: row.meta.clone(),
                paste: row.paste,
            },
            channel: None,
            attachment: None,
            attaching: Vec::new(),
        }
    }
}

struct SpawnCtx {
    id: String,
    cwd: Option<String>,
    persist: bool,
    meta: Vec<u8>,
    attachment: String,
    channel: Channel<Response>,
}

struct Pending {
    tx: Sender<Result<Frame, String>>,
    spawn: Option<SpawnCtx>,
}

enum Out {
    Bytes(Vec<u8>),
    Flush(Sender<()>),
}

#[derive(Default)]
struct Shared {
    /// Live terminals by id.
    terms: Mutex<HashMap<String, Term>>,
    /// Tombstones by id: shells that exited while nobody watched.
    tombs: Mutex<HashMap<String, TermInfo>>,
    pending: Mutex<HashMap<u32, Pending>>,
    seq: AtomicU32,
    connected: AtomicBool,
    /// The first `List` has filled the cache.
    ready: Mutex<bool>,
    ready_cv: std::sync::Condvar,
}

pub struct Client {
    shared: Arc<Shared>,
    out: Mutex<Option<Sender<Out>>>,
    pub welcome: Welcome,
    /// Who answered: by identity (`peer::check_helper`), with the path its
    /// executable has now.
    pub peer: peer::HelperPeer,
    /// Runs from this app's own sibling executable. False after an update
    /// moved or deleted the bundle it was started from: an older build,
    /// adopted for its terminals and retired for new ones.
    pub same_binary: bool,
}

/// The empty attachment id stands for "none" on the wire.
fn att_wire(attachment: Option<&str>) -> String {
    attachment.unwrap_or_default().to_string()
}

impl Client {
    /// Connect to a helper that is already running. `token` is offered for
    /// the lease (a fresh helper keeps it; a running one answers with its
    /// own). The helper is known by identity, never by path: this user, an
    /// executable named `redline-ptyd`, this app's team when signed, and the
    /// proof that it read the per-user secret beside its socket. The cache is
    /// not filled yet: call [`Client::refresh`] (the boot does it off the
    /// setup thread).
    pub fn connect(cfg: &HelperConfig, token: &str, sink: Sink) -> Result<Arc<Self>, String> {
        let stream = sock::connect(&cfg.dir, &cfg.sock).map_err(|e| format!("connect {}: {e}", cfg.sock))?;
        let who = peer::check_helper(stream.as_raw_fd()).map_err(|e| format!("peer check: {e}"))?;
        let secret = sock::secret(&cfg.dir).map_err(|e| format!("peer check: the helper secret: {e}"))?;
        let same_binary = who.runs_from(&cfg.exe);
        Self::handshake(stream, token, &secret, who, same_binary, sink)
    }

    /// Usable for new terminals by this app: our frame set and caps, and our
    /// own binary.
    pub fn current(&self) -> bool {
        self.same_binary && self.welcome.speaks_ours()
    }

    /// Connect, starting the helper first when none is listening.
    pub fn connect_or_spawn(cfg: &HelperConfig, token: &str, sink: Sink) -> Result<Arc<Self>, String> {
        match Self::connect(cfg, token, sink.clone()) {
            Ok(c) => {
                c.refresh()?;
                return Ok(c);
            }
            Err(e) if e.starts_with("peer check") => return Err(e),
            Err(_) => {}
        }
        if !cfg.exe.exists() {
            return Err(format!("no terminal helper at {}", cfg.exe.display()));
        }
        sock::private_dir(&cfg.dir).map_err(|e| format!("{}: {e}", cfg.dir.display()))?;
        match sock::spawn_helper(&cfg.exe, &cfg.spawn_args()) {
            Ok(()) => {}
            // Another app instance started one a moment ago.
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {}
            Err(e) => return Err(format!("start {}: {e}", cfg.exe.display())),
        }
        let client = Self::connect(cfg, token, sink)?;
        client.refresh()?;
        Ok(client)
    }

    fn handshake(
        mut stream: UnixStream,
        token: &str,
        secret: &[u8; proto::SECRET_LEN],
        who: peer::HelperPeer,
        same_binary: bool,
        sink: Sink,
    ) -> Result<Arc<Self>, String> {
        sock::cloexec(stream.as_raw_fd()).map_err(|e| e.to_string())?;
        let nonce = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
        let hello = Frame::bare(Msg::Hello {
            core: proto::CORE,
            caps: Vec::new(),
            build: format!("redline-{}", env!("CARGO_PKG_VERSION")),
            token: Some(token.to_string()),
            nonce,
        });
        stream.write_all(&proto::to_bytes(&hello).map_err(|e| e.to_string())?).map_err(|e| format!("hello: {e}"))?;
        stream.set_read_timeout(Some(HELLO_TIMEOUT)).map_err(|e| e.to_string())?;
        let mut dec = proto::Decoder::new();
        let mut buf = [0u8; 4096];
        let welcome = loop {
            match dec.next_frame().map_err(|e| e.to_string())? {
                Some(Frame { msg: Msg::Welcome { core, caps, build, instance, token, pid, proof }, .. }) => {
                    if proof != proto::proof(secret, nonce) {
                        return Err("peer check: the helper could not prove it read this user's secret".into());
                    }
                    break Welcome { core, caps, build, instance, token, pid };
                }
                Some(other) => return Err(format!("expected Welcome, got {:?}", proto::type_of(&other.msg))),
                None => {}
            }
            let n = stream.read(&mut buf).map_err(|e| format!("welcome: {e}"))?;
            if n == 0 {
                return Err("the helper closed the connection".into());
            }
            dec.feed(&buf[..n]);
        };
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;

        let shared = Arc::new(Shared::default());
        shared.connected.store(true, Ordering::Release);
        let (tx, rx) = mpsc::channel::<Out>();
        let writer = stream.try_clone().map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("ptyd-writer".into())
            .spawn(move || write_loop(writer, rx))
            .map_err(|e| e.to_string())?;
        let reader_shared = shared.clone();
        let reader_out = tx.clone();
        std::thread::Builder::new()
            .name("ptyd-reader".into())
            .spawn(move || read_loop(stream, dec, reader_shared, reader_out, sink))
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self { shared, out: Mutex::new(Some(tx)), welcome, peer: who, same_binary }))
    }

    /// Wait (at most `timeout`) for the first `List` to have filled the
    /// cache: what `pty_list` must not answer before on a boot.
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let guard = lock(&self.shared.ready);
        let (guard, _) = self
            .shared
            .ready_cv
            .wait_timeout_while(guard, timeout, |ready| !*ready && self.shared.connected.load(Ordering::Acquire))
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }

    pub fn connected(&self) -> bool {
        self.shared.connected.load(Ordering::Acquire)
    }

    fn enqueue(&self, frame: &Frame) -> Result<(), String> {
        let bytes = proto::to_bytes(frame).map_err(|e| e.to_string())?;
        let out = lock(&self.out);
        let tx = out.as_ref().ok_or("the terminal helper is gone")?;
        tx.send(Out::Bytes(bytes)).map_err(|_| "the terminal helper is gone".to_string())
    }

    /// Wait until everything enqueued so far is on the socket.
    pub fn flush(&self, timeout: Duration) {
        let (tx, rx) = mpsc::channel();
        if lock(&self.out).as_ref().is_some_and(|out| out.send(Out::Flush(tx)).is_ok()) {
            let _ = rx.recv_timeout(timeout);
        }
    }

    fn request(&self, build: impl FnOnce(u32) -> Frame, spawn: Option<SpawnCtx>, timeout: Duration) -> Result<Frame, String> {
        let seq = self.shared.seq.fetch_add(1, Ordering::Relaxed).wrapping_add(1).max(1);
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.pending).insert(seq, Pending { tx, spawn });
        if let Err(e) = self.enqueue(&build(seq)) {
            lock(&self.shared.pending).remove(&seq);
            return Err(e);
        }
        let result = rx.recv_timeout(timeout);
        lock(&self.shared.pending).remove(&seq);
        match result {
            Ok(r) => r,
            Err(_) => Err("the terminal helper did not answer".into()),
        }
    }

    /// Re-read the helper's list into the cache: what an adopting app sees.
    pub fn refresh(&self) -> Result<(), String> {
        let reply = self.request(|seq| Frame::bare(Msg::List { seq }), None, REPLY_TIMEOUT)?;
        let Msg::ListReply { rows, .. } = reply.msg else { return Err("unexpected reply to List".into()) };
        let mut terms = lock(&self.shared.terms);
        let mut tombs = lock(&self.shared.tombs);
        tombs.clear();
        for row in &rows {
            if row.alive {
                let term = terms.entry(row.id.clone()).or_insert_with(|| Term::from_row(row));
                if term.info.handle != row.handle {
                    *term = Term::from_row(row);
                } else {
                    term.info.meta = row.meta.clone();
                    term.info.persist = row.persist;
                    term.info.paste = row.paste;
                    term.info.last_output = row.last_output;
                }
            } else {
                tombs.insert(row.id.clone(), Term::from_row(row).info);
            }
        }
        terms.retain(|id, t| rows.iter().any(|r| r.alive && &r.id == id && r.handle == t.info.handle));
        drop(terms);
        drop(tombs);
        *lock(&self.shared.ready) = true;
        self.shared.ready_cv.notify_all();
        Ok(())
    }

    pub fn info(&self, id: &str) -> Option<TermInfo> {
        lock(&self.shared.terms).get(id).map(|t| t.info.clone())
    }

    pub fn is_live(&self, id: &str) -> bool {
        lock(&self.shared.terms).get(id).is_some_and(|t| t.info.alive)
    }

    pub fn terms(&self) -> Vec<TermInfo> {
        lock(&self.shared.terms).values().map(|t| t.info.clone()).collect()
    }

    pub fn tombs(&self) -> Vec<TermInfo> {
        lock(&self.shared.tombs).values().cloned().collect()
    }

    fn handle_of(&self, id: &str) -> Option<u32> {
        lock(&self.shared.terms).get(id).filter(|t| t.info.alive).map(|t| t.info.handle)
    }

    /// Start a shell (or attach to the live one with this id). The first
    /// frame on `channel` is its replay, as in-process.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        id: &str,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        argv: Vec<String>,
        env: Vec<String>,
        persist: bool,
        meta: Vec<u8>,
        attachment: Option<&str>,
        channel: Channel<Response>,
    ) -> Result<(), String> {
        let attachment = att_wire(attachment);
        let ctx = SpawnCtx { id: id.to_string(), cwd: cwd.clone(), persist, meta: meta.clone(), attachment: attachment.clone(), channel };
        let id = id.to_string();
        let reply = self.request(
            move |seq| Frame::bare(Msg::Spawn { seq, id, cwd, cols, rows, argv, env, persist, meta, attachment }),
            Some(ctx),
            Duration::from_secs(10),
        )?;
        match reply.msg {
            Msg::Spawned { .. } => Ok(()),
            Msg::Error { message, .. } => Err(message),
            _ => Err("unexpected reply to Spawn".into()),
        }
    }

    pub fn attach(&self, id: &str, attachment: Option<&str>, channel: Channel<Response>) -> Result<(), String> {
        let attachment = att_wire(attachment);
        let handle = {
            let mut terms = lock(&self.shared.terms);
            let term = terms.get_mut(id).filter(|t| t.info.alive).ok_or_else(|| format!("terminal {id} is not running"))?;
            term.attaching.push((attachment.clone(), channel));
            term.info.handle
        };
        self.enqueue(&Frame::new(handle, Msg::Attach { attachment }))
    }

    pub fn detach(&self, id: &str, attachment: &str) {
        let handle = {
            let mut terms = lock(&self.shared.terms);
            let Some(term) = terms.get_mut(id) else { return };
            term.attaching.retain(|(a, _)| a != attachment);
            if term.attachment.as_deref() == Some(attachment) {
                term.channel = None;
                term.attachment = None;
            }
            term.info.handle
        };
        let _ = self.enqueue(&Frame::new(handle, Msg::Detach { attachment: attachment.to_string() }));
    }

    pub fn ack(&self, id: &str, n: usize, attachment: Option<&str>) {
        if let Some(handle) = self.handle_of(id) {
            let n = u32::try_from(n).unwrap_or(u32::MAX);
            let _ = self.enqueue(&Frame::new(handle, Msg::Ack { attachment: att_wire(attachment), n }));
        }
    }

    /// An unpaced, unchecked write: keystrokes.
    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let handle = self.handle_of(id).ok_or_else(|| format!("terminal {id} is not running"))?;
        for chunk in bytes.chunks(INPUT_CHUNK).chain(bytes.is_empty().then_some(&[][..])) {
            self.enqueue(&Frame::new(handle, Msg::Input { seq: 0, flags: 0, gap_ms: 0, bytes: chunk.to_vec() }))?;
        }
        Ok(())
    }

    /// The `Input` frames one write becomes: at most `INPUT_CHUNK` each (a
    /// multiple of the 512-byte pacing chunk), the `gap` on the first, and on
    /// every later one of a paced write the 4 ms pause its chunks would have
    /// had inside one frame, so splitting never changes the pacing.
    fn inputs(bytes: &[u8], paced: bool, gap: Duration) -> Vec<(u8, u16, Vec<u8>)> {
        let flags = if paced { proto::INPUT_PACED } else { 0 };
        let first_gap = u16::try_from(gap.as_millis()).unwrap_or(u16::MAX);
        let pause = if paced { 4 } else { 0 };
        let mut out: Vec<(u8, u16, Vec<u8>)> =
            bytes.chunks(INPUT_CHUNK).enumerate().map(|(i, c)| (flags, if i == 0 { first_gap } else { pause }, c.to_vec())).collect();
        if out.is_empty() {
            out.push((flags, first_gap, Vec::new()));
        }
        out
    }

    /// A paced write after a quiet `gap`, answered once it is all written.
    /// Blocks for the length of the write: callers are off the main thread.
    pub fn write_checked(&self, id: &str, bytes: &[u8], paced: bool, gap: Duration) -> Result<(), String> {
        let handle = self.handle_of(id).ok_or_else(|| format!("terminal {id} is not running"))?;
        // 512 B every 4 ms is ~128 KB/s; a long launch must not time out.
        let timeout = REPLY_TIMEOUT + Duration::from_millis((bytes.len() / 64) as u64);
        let mut frames = Self::inputs(bytes, paced, gap);
        let (flags, gap_ms, last) = frames.pop().expect("at least one frame");
        for (flags, gap_ms, chunk) in frames {
            self.enqueue(&Frame::new(handle, Msg::Input { seq: 0, flags, gap_ms, bytes: chunk }))?;
        }
        // The helper writes one terminal's input in order, so the last
        // frame's answer is the whole write's.
        let flags = flags | proto::INPUT_CHECKED;
        let reply = self.request(move |seq| Frame::new(handle, Msg::Input { seq, flags, gap_ms, bytes: last }), None, timeout)?;
        match reply.msg {
            Msg::InputDone { ok: true, .. } => Ok(()),
            Msg::InputDone { error, .. } => Err(error),
            _ => Err("unexpected reply to Input".into()),
        }
    }

    /// A paced write that is not waited for (a paste whose Return follows).
    pub fn write_paced(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let handle = self.handle_of(id).ok_or_else(|| format!("terminal {id} is not running"))?;
        for (flags, gap_ms, chunk) in Self::inputs(bytes, true, Duration::ZERO) {
            self.enqueue(&Frame::new(handle, Msg::Input { seq: 0, flags, gap_ms, bytes: chunk }))?;
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let handle = self.handle_of(id).ok_or("no terminal running")?;
        self.enqueue(&Frame::new(handle, Msg::Resize { cols, rows }))
    }

    /// Kill one terminal (SIGHUP, as in-process); its exit is expected. It
    /// leaves the cache at once, as it left the registry.
    pub fn kill(&self, id: &str) {
        let term = lock(&self.shared.terms).remove(id);
        if let Some(term) = term {
            let _ = self.enqueue(&Frame::new(term.info.handle, Msg::Kill { signal: libc::SIGHUP }));
        }
    }

    /// The quit path: every terminal, or only those not marked persist.
    pub fn kill_where(&self, all: bool) {
        {
            let mut terms = lock(&self.shared.terms);
            terms.retain(|_, t| !all && t.info.persist);
        }
        let _ = self.enqueue(&Frame::bare(Msg::KillWhere { all }));
    }

    pub fn set_meta(&self, id: &str, persist: bool, meta: Vec<u8>) -> Result<(), String> {
        if meta.len() > proto::MAX_META {
            return Err(format!("terminal metadata is over {} bytes", proto::MAX_META));
        }
        let handle = {
            let mut terms = lock(&self.shared.terms);
            let term = terms.get_mut(id).filter(|t| t.info.alive).ok_or_else(|| format!("terminal {id} is not running"))?;
            term.info.persist = persist;
            term.info.meta = meta.clone();
            term.info.handle
        };
        self.enqueue(&Frame::new(handle, Msg::SetMeta { persist, meta }))
    }

    /// Forget a tombstone.
    pub fn reap(&self, id: &str) {
        let tomb = lock(&self.shared.tombs).remove(id);
        if let Some(t) = tomb {
            let _ = self.enqueue(&Frame::new(t.handle, Msg::Reap));
        }
    }

    /// The foreground process group of every live terminal, by id.
    pub fn foregrounds(&self) -> HashMap<String, Option<u32>> {
        let Ok(reply) = self.request(|seq| Frame::bare(Msg::Fg { seq }), None, REPLY_TIMEOUT) else { return HashMap::new() };
        let Msg::FgReply { rows, .. } = reply.msg else { return HashMap::new() };
        let terms = lock(&self.shared.terms);
        let by_handle: HashMap<u32, &str> = terms.values().map(|t| (t.info.handle, t.info.id.as_str())).collect();
        rows.into_iter()
            .filter_map(|(h, pgid)| by_handle.get(&h).map(|id| (id.to_string(), pgid.and_then(|p| u32::try_from(p).ok()))))
            .collect()
    }

    /// The newest `max` bytes of a terminal's ring (live or tombstone).
    pub fn tail(&self, id: &str, max: usize) -> Vec<u8> {
        let handle = self.handle_of(id).or_else(|| lock(&self.shared.tombs).get(id).map(|t| t.handle));
        let Some(handle) = handle else { return Vec::new() };
        let max = u32::try_from(max).unwrap_or(u32::MAX);
        match self.request(|seq| Frame::new(handle, Msg::Tail { seq, max }), None, REPLY_TIMEOUT) {
            Ok(Frame { msg: Msg::TailReply { bytes, .. }, .. }) => bytes,
            _ => Vec::new(),
        }
    }

    /// Hand this helper's primary socket over (P3): it keeps its terminals,
    /// serves them on `sock`, and exits after the last.
    pub fn retire(&self, sock: &str) -> Result<(), String> {
        self.enqueue(&Frame::bare(Msg::Retire { sock: sock.to_string() }))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // Closing the writer's queue ends the writer, which shuts the socket
        // down; the reader then sees EOF.
        lock(&self.out).take();
    }
}

fn write_loop(mut stream: UnixStream, rx: Receiver<Out>) {
    for item in rx {
        match item {
            Out::Bytes(bytes) => {
                if stream.write_all(&bytes).is_err() {
                    break;
                }
            }
            Out::Flush(done) => {
                let _ = stream.flush();
                let _ = done.send(());
            }
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn read_loop(mut stream: UnixStream, mut dec: proto::Decoder, shared: Arc<Shared>, out: Sender<Out>, sink: Sink) {
    let mut buf = vec![0u8; 256 * 1024];
    'outer: loop {
        loop {
            match dec.next_frame() {
                Ok(Some(frame)) => dispatch(frame, &shared, &out, &sink),
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "terminal helper protocol error");
                    break 'outer;
                }
            }
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => dec.feed(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    // The helper is gone. Every terminal it held died with it.
    shared.connected.store(false, Ordering::Release);
    let ids: Vec<String> = {
        let mut terms = lock(&shared.terms);
        let ids = terms.values().filter(|t| t.info.alive).map(|t| t.info.id.clone()).collect();
        terms.clear();
        ids
    };
    for (_, p) in lock(&shared.pending).drain() {
        let _ = p.tx.send(Err("the terminal helper is gone".into()));
    }
    sink(Event::Gone { ids });
}

fn send_or_drop(term: &mut Term, bytes: Vec<u8>, out: &Sender<Out>) {
    let Some(channel) = &term.channel else { return };
    if channel.send(Response::new(bytes)).is_err() {
        // The view is gone (an unloaded webview): detach it, as in-process.
        let attachment = term.attachment.take().unwrap_or_default();
        term.channel = None;
        if let Ok(bytes) = proto::to_bytes(&Frame::new(term.info.handle, Msg::Detach { attachment })) {
            let _ = out.send(Out::Bytes(bytes));
        }
    }
}

fn dispatch(frame: Frame, shared: &Shared, out: &Sender<Out>, sink: &Sink) {
    let handle = frame.pty;
    let reply_seq = match &frame.msg {
        Msg::Spawned { seq, .. }
        | Msg::ListReply { seq, .. }
        | Msg::InputDone { seq, .. }
        | Msg::FgReply { seq, .. }
        | Msg::TailReply { seq, .. }
        | Msg::Error { seq, .. } => Some(*seq),
        _ => None,
    };
    if let Msg::Spawned { pid, existed, .. } = &frame.msg {
        // Install the terminal before the reply wakes its caller: the
        // `Replay` that follows on the socket must find it.
        let ctx = reply_seq.and_then(|s| lock(&shared.pending).get_mut(&s).and_then(|p| p.spawn.take()));
        if let Some(ctx) = ctx {
            let mut terms = lock(&shared.terms);
            let fresh = !*existed || terms.get(&ctx.id).is_none_or(|t| t.info.handle != handle);
            if fresh {
                terms.insert(
                    ctx.id.clone(),
                    Term {
                        info: TermInfo {
                            id: ctx.id.clone(),
                            handle,
                            pid: Some(*pid),
                            alive: true,
                            exit: None,
                            cwd: ctx.cwd,
                            started_at: crate::ledger::now_millis().max(0) as u64,
                            last_output: 0,
                            persist: ctx.persist,
                            meta: ctx.meta,
                            paste: false,
                        },
                        channel: None,
                        attachment: None,
                        attaching: Vec::new(),
                    },
                );
            }
            if let Some(term) = terms.get_mut(&ctx.id) {
                term.attaching.push((ctx.attachment, ctx.channel));
            }
            lock(&shared.tombs).remove(&ctx.id);
        }
    }
    if let Some(seq) = reply_seq.filter(|s| *s != 0) {
        if let Some(p) = lock(&shared.pending).remove(&seq) {
            let _ = p.tx.send(Ok(frame));
        }
        return;
    }
    match frame.msg {
        Msg::Replay { attachment, bytes } => {
            let mut terms = lock(&shared.terms);
            let Some(term) = terms.values_mut().find(|t| t.info.handle == handle) else { return };
            let Some(at) = term.attaching.iter().position(|(a, _)| *a == attachment) else { return };
            // This attach supersedes every one sent before it.
            let mut drained: Vec<_> = term.attaching.drain(..=at).collect();
            let (_, channel) = drained.pop().expect("position found");
            term.channel = Some(channel);
            term.attachment = (!attachment.is_empty()).then_some(attachment);
            send_or_drop(term, bytes, out);
        }
        Msg::Output { bytes } => {
            let mut terms = lock(&shared.terms);
            if let Some(term) = terms.values_mut().find(|t| t.info.handle == handle) {
                send_or_drop(term, bytes, out);
            }
        }
        Msg::Mode { paste } => {
            let id = {
                let mut terms = lock(&shared.terms);
                let Some(term) = terms.values_mut().find(|t| t.info.handle == handle) else { return };
                let changed = term.info.paste != paste;
                term.info.paste = paste;
                changed.then(|| term.info.id.clone())
            };
            if let Some(id) = id {
                sink(Event::Mode { id });
            }
        }
        Msg::Activity { last_output } => {
            if let Some(term) = lock(&shared.terms).values_mut().find(|t| t.info.handle == handle) {
                term.info.last_output = last_output;
            }
            sink(Event::Activity(i64::try_from(last_output).unwrap_or(i64::MAX)));
        }
        Msg::Exit { status, expected } => {
            let gone = {
                let mut terms = lock(&shared.terms);
                let id = terms.values().find(|t| t.info.handle == handle).map(|t| t.info.id.clone());
                id.and_then(|id| terms.remove(&id)).map(|t| t.info)
            };
            if !expected {
                // Seen live: the view says "[process exited]" itself, so the
                // helper's tombstone has nothing left to tell anyone.
                if let Ok(bytes) = proto::to_bytes(&Frame::new(handle, Msg::Reap)) {
                    let _ = out.send(Out::Bytes(bytes));
                }
            }
            if let Some(info) = gone {
                sink(Event::Exit { id: info.id, status, expected });
            }
        }
        Msg::Error { message, .. } => {
            // An attach to a terminal that ended in between: its view waits
            // for nothing.
            tracing::debug!(%message, handle, "terminal helper error");
            if let Some(term) = lock(&shared.terms).values_mut().find(|t| t.info.handle == handle) {
                term.attaching.clear();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_over_the_frame_cap_is_split_and_keeps_its_pacing() {
        let bytes = vec![b'x'; INPUT_CHUNK * 2 + 10];
        let frames = Client::inputs(&bytes, true, Duration::from_millis(30));
        assert_eq!(frames.len(), 3);
        assert_eq!(frames.iter().map(|f| f.2.len()).sum::<usize>(), bytes.len());
        assert_eq!(frames[0].1, 30, "the gap belongs to the first byte");
        assert!(frames[1..].iter().all(|f| f.1 == 4), "the pause a paced chunk would have had");
        assert_eq!(INPUT_CHUNK % 512, 0, "frame boundaries fall on pacing boundaries");
        assert!(frames.iter().all(|f| proto::to_bytes(&Frame::new(1, Msg::Input { seq: 1, flags: f.0, gap_ms: f.1, bytes: f.2.clone() })).is_ok()));
        let unpaced = Client::inputs(&bytes, false, Duration::ZERO);
        assert!(unpaced.iter().all(|f| f.1 == 0 && f.0 == 0));
        assert_eq!(Client::inputs(b"", true, Duration::ZERO).len(), 1, "an empty write is still answered");
    }
}

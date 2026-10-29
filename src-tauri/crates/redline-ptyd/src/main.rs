// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `redline-ptyd`: the process that owns Redline's terminals.
//!
//! Usage: `redline-ptyd --dir <data dir> --sock <name> [--peer-dir <dir>]
//! [--sweep-secs N] [--foreground]`
//!
//! It holds the PTY masters, the shells' pids and a 256 KB replay ring per
//! terminal, and serves them over an owner-only Unix socket. Redline attaches
//! as a client: when Redline quits or crashes the shells keep running here,
//! filling their rings, and the relaunched app reattaches with the same
//! replay a webview reload gets.
//!
//! **Single-threaded, on purpose.** One `poll(2)` over the listener, the
//! clients, every master and a SIGCHLD self-pipe. That makes `fork` safe here
//! (the shell spawn is the classic `openpty` → `fork` → `setsid` →
//! `TIOCSCTTY` → `dup2` → signal reset → `chdir` → `execve`), and it makes
//! idle free: the timeout is infinite unless output is inside its 8 ms
//! coalescing window, a paced write is between chunks, a stalled reader's
//! deadline is armed, or the empty-helper sweep is counting down. Fourteen
//! parked shells cost no wakeups.
//!
//! **What it never does.** No network listener, no launchd agent, no forking
//! anything but shells (port badges and `lsof` stay in the app), no reading
//! of files the app didn't name. It exits on its own when it has had no
//! terminal, no tombstone and no client for the sweep period (10 minutes).

use std::ffi::CString;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use redline_pty_proto::{self as proto, Frame, Msg, Row};
use redline_ptyd::input::{InputQueue, Job, Next};
use redline_ptyd::outlet::{Attachment, Gate, Outlet};
use redline_ptyd::tombs::{sweep_deadline, Tombs, Weighed};
use redline_ptyd::{build_id, peer, sock, ModeScan, CAPS};

/// The default empty-helper sweep.
const SWEEP: Duration = Duration::from_secs(600);
/// A client that stops reading is dropped past this much queued output
/// (ACK credit bounds a well-behaved one far below it).
const CLIENT_OUT_CAP: usize = 32 * 1024 * 1024;
/// One read of a master.
const READ_CHUNK: usize = 64 * 1024;
/// `Activity` goes out at most this often per terminal while output flows.
const ACTIVITY_EVERY: Duration = Duration::from_secs(1);

struct Args {
    dir: PathBuf,
    sock: String,
    peer_dir: PathBuf,
    sweep: Duration,
    foreground: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let (mut dir, mut sock_name, mut peer_dir, mut sweep, mut foreground) = (None, None, None, SWEEP, false);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().map(PathBuf::from),
            "--sock" => sock_name = it.next(),
            "--peer-dir" => peer_dir = it.next().map(PathBuf::from),
            "--sweep-secs" => {
                let n: u64 = it.next().and_then(|v| v.parse().ok()).ok_or("--sweep-secs takes a number")?;
                sweep = Duration::from_secs(n);
            }
            "--foreground" => foreground = true,
            "--version" => {
                println!("{}", build_id());
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let dir = dir.ok_or("--dir is required")?;
    let sock_name = sock_name.ok_or("--sock is required")?;
    if sock_name.contains('/') {
        return Err("--sock is a name, not a path".into());
    }
    let peer_dir = match peer_dir {
        Some(d) => d,
        None => std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(Path::to_path_buf))
            .ok_or("can't find my own directory")?,
    };
    Ok(Args { dir, sock: sock_name, peer_dir, sweep, foreground })
}

static SIGCHLD_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_sigchld(_: libc::c_int) {
    let fd = SIGCHLD_PIPE.load(Ordering::Relaxed);
    if fd >= 0 {
        let b = 1u8;
        // SAFETY: write(2) is async-signal-safe; a full pipe already wakes us.
        unsafe { libc::write(fd, (&b as *const u8).cast(), 1) };
    }
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("redline-ptyd: {e}");
            std::process::exit(2);
        }
    };
    // A write to a client that went away is an EPIPE to handle, not a death.
    // SAFETY: setting a disposition before anything else runs.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    if let Err(e) = sock::private_dir(&args.dir) {
        eprintln!("redline-ptyd: {}: {e}", args.dir.display());
        std::process::exit(1);
    }
    let listener = match sock::bind(&args.dir, &args.sock) {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => std::process::exit(sock::EXIT_IN_USE),
        Err(e) => {
            eprintln!("redline-ptyd: bind {}: {e}", args.dir.join(&args.sock).display());
            std::process::exit(1);
        }
    };
    if !args.foreground {
        // The socket is listening; the intermediate exits so launchd adopts
        // the helper and the app that spawned it reaps nothing later.
        // SAFETY: single-threaded here; the child carries on.
        match unsafe { libc::fork() } {
            -1 => std::process::exit(1),
            0 => {}
            _ => unsafe { libc::_exit(0) },
        }
    }
    let _ = std::env::set_current_dir("/");
    let mut helper = match Helper::new(args, listener) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("redline-ptyd: {e}");
            std::process::exit(1);
        }
    };
    helper.run();
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_u64() -> u64 {
    let mut b = [0u8; 8];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok() {
        return u64::from_le_bytes(b);
    }
    now_ms() ^ (u64::from(std::process::id()) << 32)
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on an fd this process owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn inode(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

struct Client {
    id: u64,
    stream: UnixStream,
    dec: proto::Decoder,
    out: Vec<u8>,
    out_at: usize,
    hello: bool,
    gone: bool,
}

impl Client {
    fn queued(&self) -> usize {
        self.out.len() - self.out_at
    }

    fn flush(&mut self) {
        while self.out_at < self.out.len() {
            match self.stream.write(&self.out[self.out_at..]) {
                Ok(0) => {
                    self.gone = true;
                    return;
                }
                Ok(n) => self.out_at += n,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.gone = true;
                    return;
                }
            }
        }
        if self.out_at == self.out.len() {
            self.out.clear();
            self.out_at = 0;
        } else if self.out_at > 1 << 20 {
            self.out.drain(..self.out_at);
            self.out_at = 0;
        }
    }
}

struct Term {
    handle: u32,
    id: String,
    pid: i32,
    master: OwnedFd,
    cwd: Option<String>,
    started_at: u64,
    last_output: u64,
    activity_sent: Option<Instant>,
    outlet: Outlet,
    modes: ModeScan,
    paste: bool,
    persist: bool,
    meta: Vec<u8>,
    input: InputQueue,
    input_next: Next,
    expected: bool,
    eof: bool,
    status: Option<i32>,
}

impl Term {
    fn row(&self) -> Row {
        Row {
            handle: self.handle,
            id: self.id.clone(),
            pid: self.pid as u32,
            alive: self.status.is_none(),
            exit: self.status,
            started_at: self.started_at,
            last_output: self.last_output,
            cwd: self.cwd.clone(),
            persist: self.persist,
            paste: self.paste,
            meta: self.meta.clone(),
        }
    }
}

struct Tomb {
    row: Row,
    ring: Vec<u8>,
}

impl Weighed for Tomb {
    fn weight(&self) -> usize {
        self.ring.len() + self.row.meta.len() + 128
    }
}

struct Helper {
    args: Args,
    listener: UnixListener,
    listen_path: PathBuf,
    listen_ino: Option<(u64, u64)>,
    clients: Vec<Client>,
    terms: Vec<Term>,
    tombs: Tombs<Tomb>,
    next_handle: u32,
    next_client: u64,
    token: Option<String>,
    instance: u64,
    sig_r: OwnedFd,
    idle_since: Instant,
    was_empty: bool,
    retiring: bool,
}

enum Slot {
    Listener,
    Signal,
    Client(usize),
    Term(usize),
}

impl Helper {
    fn new(args: Args, listener: UnixListener) -> io::Result<Self> {
        listener.set_nonblocking(true)?;
        let mut fds = [0; 2];
        // SAFETY: a two-int out array.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        for fd in fds {
            sock::cloexec(fd)?;
            set_nonblocking(fd)?;
        }
        // SAFETY: both fds were just created and are owned here.
        let sig_r = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        SIGCHLD_PIPE.store(fds[1], Ordering::Relaxed);
        // SAFETY: installing a handler that only writes one byte.
        unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_sigchld as extern "C" fn(libc::c_int) as usize;
            sa.sa_flags = libc::SA_RESTART | libc::SA_NOCLDSTOP;
            libc::sigemptyset(&mut sa.sa_mask);
            libc::sigaction(libc::SIGCHLD, &sa, std::ptr::null_mut());
        }
        let listen_path = args.dir.join(&args.sock);
        let listen_ino = inode(&listen_path);
        Ok(Self {
            args,
            listener,
            listen_path,
            listen_ino,
            clients: Vec::new(),
            terms: Vec::new(),
            tombs: Tombs::default(),
            next_handle: 1,
            next_client: 1,
            token: None,
            instance: random_u64(),
            sig_r,
            idle_since: Instant::now(),
            was_empty: true,
            retiring: false,
        })
    }

    fn run(&mut self) -> ! {
        loop {
            let now = Instant::now();
            self.tombs.expire(now);
            let empty = self.terms.is_empty() && self.clients.is_empty() && self.tombs.is_empty();
            if empty && !self.was_empty {
                self.idle_since = now;
            }
            self.was_empty = empty;
            let sweep = sweep_deadline(self.terms.len(), self.clients.len(), self.tombs.len(), self.idle_since, self.args.sweep);
            if sweep.is_some_and(|at| now >= at) {
                self.exit();
            }
            // A retiring helper goes with its last terminal; its tombstones
            // are not worth keeping a second helper alive for.
            if self.retiring && self.terms.is_empty() {
                self.exit();
            }

            let mut fds: Vec<libc::pollfd> = Vec::with_capacity(2 + self.clients.len() + self.terms.len());
            let mut slots: Vec<Slot> = Vec::with_capacity(fds.capacity());
            let mut deadline: Option<Instant> = sweep;
            let mut soonest = |at: Option<Instant>| {
                if let Some(at) = at {
                    deadline = Some(deadline.map_or(at, |d| d.min(at)));
                }
            };
            soonest(self.tombs.next_expiry());
            fds.push(libc::pollfd { fd: self.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            slots.push(Slot::Listener);
            fds.push(libc::pollfd { fd: self.sig_r.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            slots.push(Slot::Signal);
            for (i, c) in self.clients.iter().enumerate() {
                let mut events = libc::POLLIN;
                if c.queued() > 0 {
                    events |= libc::POLLOUT;
                }
                fds.push(libc::pollfd { fd: c.stream.as_raw_fd(), events, revents: 0 });
                slots.push(Slot::Client(i));
            }
            let mut suspended_flushes = Vec::new();
            for (i, t) in self.terms.iter_mut().enumerate() {
                let readable = match t.outlet.gate(now) {
                    Gate::Open(flushed) => {
                        if let Some((att, bytes)) = flushed {
                            suspended_flushes.push((att.client, t.handle, bytes));
                        }
                        true
                    }
                    Gate::Parked(at) => {
                        soonest(Some(at));
                        false
                    }
                };
                soonest(t.outlet.deadline());
                let mut events = 0;
                if readable && !t.eof {
                    events |= libc::POLLIN;
                }
                match t.input_next {
                    Next::At(at) => soonest(Some(at)),
                    Next::Writable if !t.eof => events |= libc::POLLOUT,
                    _ => {}
                }
                // A parked or finished master is left out entirely: poll
                // reports POLLHUP whatever was asked for, and a hung-up
                // master nobody may read would spin the loop.
                if events != 0 {
                    fds.push(libc::pollfd { fd: t.master.as_raw_fd(), events, revents: 0 });
                    slots.push(Slot::Term(i));
                }
            }
            for (client, handle, bytes) in suspended_flushes {
                self.send(client, Frame::new(handle, Msg::Output { bytes }));
            }

            let timeout = match deadline {
                None => -1,
                Some(at) => {
                    let wait = at.saturating_duration_since(Instant::now());
                    // Round up: waking a hair early just loops back to sleep.
                    (wait.as_micros().div_ceil(1000)).min(i32::MAX as u128) as i32
                }
            };
            // SAFETY: `fds` is a valid array of `fds.len()` pollfds.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() != io::ErrorKind::Interrupted {
                    eprintln!("redline-ptyd: poll: {e}");
                    self.exit();
                }
            }
            let now = Instant::now();
            for (pfd, slot) in fds.iter().zip(&slots) {
                if pfd.revents == 0 {
                    continue;
                }
                match *slot {
                    Slot::Listener => self.accept(),
                    Slot::Signal => self.reap(),
                    Slot::Client(i) => {
                        if pfd.revents & libc::POLLOUT != 0 {
                            self.clients[i].flush();
                        }
                        if pfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                            self.read_client(i, now);
                        }
                    }
                    Slot::Term(i) => {
                        if pfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                            self.read_term(i, now);
                        }
                        if pfd.revents & libc::POLLOUT != 0 {
                            self.terms[i].input_next = Next::At(now);
                        }
                    }
                }
            }
            self.timers(now);
            self.finish_exited(now);
            self.drop_gone_clients();
            for c in &mut self.clients {
                if c.queued() > 0 {
                    c.flush();
                }
            }
        }
    }

    /// Unlink our socket (only if it is still ours) and leave. Live shells,
    /// if any, get SIGHUP as their masters close with the process.
    fn exit(&mut self) -> ! {
        if self.listen_ino.is_some() && inode(&self.listen_path) == self.listen_ino {
            let _ = std::fs::remove_file(&self.listen_path);
        }
        std::process::exit(0);
    }

    // --- clients ---------------------------------------------------------------

    fn accept(&mut self) {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    let fd = stream.as_raw_fd();
                    if let Err(why) = peer::check_app(fd, &self.args.peer_dir) {
                        // Refused before any frame is read or written.
                        eprintln!("redline-ptyd: refused a peer: {why}");
                        continue;
                    }
                    if sock::cloexec(fd).is_err() || stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let id = self.next_client;
                    self.next_client += 1;
                    self.clients.push(Client { id, stream, dec: proto::Decoder::new(), out: Vec::new(), out_at: 0, hello: false, gone: false });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return,
            }
        }
    }

    fn read_client(&mut self, i: usize, now: Instant) {
        let mut buf = [0u8; 64 * 1024];
        let mut eof = false;
        loop {
            let c = &mut self.clients[i];
            match c.stream.read(&mut buf) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => c.dec.feed(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    eof = true;
                    break;
                }
            }
        }
        // Frames that arrived before an EOF still count: an app that writes
        // its last Input and exits must have it typed.
        loop {
            let (id, frame) = {
                let c = &mut self.clients[i];
                match c.dec.next_frame() {
                    Ok(Some(f)) => (c.id, f),
                    Ok(None) => break,
                    Err(e) => {
                        eprintln!("redline-ptyd: protocol error from client {}: {e}", c.id);
                        c.gone = true;
                        break;
                    }
                }
            };
            if !self.clients[i].hello && !matches!(frame.msg, Msg::Hello { .. }) {
                self.clients[i].gone = true;
                break;
            }
            self.handle(id, frame, now);
            if self.clients[i].gone {
                break;
            }
        }
        if eof {
            self.clients[i].gone = true;
        }
    }

    fn drop_gone_clients(&mut self) {
        let gone: Vec<u64> = self.clients.iter().filter(|c| c.gone || c.queued() > CLIENT_OUT_CAP).map(|c| c.id).collect();
        if gone.is_empty() {
            return;
        }
        self.clients.retain(|c| !gone.contains(&c.id));
        // A client going away detaches what it watched. Nothing is killed:
        // an app that crashed did not choose to quit.
        for t in &mut self.terms {
            for id in &gone {
                t.outlet.detach_client(*id);
            }
        }
    }

    fn send(&mut self, client: u64, frame: Frame) {
        let Some(c) = self.clients.iter_mut().find(|c| c.id == client && !c.gone) else { return };
        if let Err(e) = proto::encode(&frame, &mut c.out) {
            eprintln!("redline-ptyd: dropped a frame: {e}");
        }
    }

    fn broadcast(&mut self, frame: Frame) {
        let mut encoded = Vec::new();
        if proto::encode(&frame, &mut encoded).is_err() {
            return;
        }
        for c in self.clients.iter_mut().filter(|c| c.hello && !c.gone) {
            c.out.extend_from_slice(&encoded);
        }
    }

    fn term_index(&self, handle: u32) -> Option<usize> {
        self.terms.iter().position(|t| t.handle == handle && t.status.is_none())
    }

    fn handle(&mut self, client: u64, frame: Frame, now: Instant) {
        let handle = frame.pty;
        match frame.msg {
            Msg::Hello { token, .. } => {
                if self.token.is_none() {
                    self.token = token.filter(|t| !t.is_empty());
                }
                if let Some(c) = self.clients.iter_mut().find(|c| c.id == client) {
                    c.hello = true;
                }
                let welcome = Msg::Welcome {
                    core: proto::CORE,
                    caps: CAPS.iter().map(|c| c.to_string()).collect(),
                    build: build_id(),
                    instance: self.instance,
                    token: self.token.clone().unwrap_or_default(),
                    pid: std::process::id(),
                };
                self.send(client, Frame::bare(welcome));
            }
            Msg::Spawn { seq, id, cwd, cols, rows, argv, env, persist, meta, attachment } => {
                if let Some(i) = self.terms.iter().position(|t| t.id == id && t.status.is_none()) {
                    let (h, pid) = (self.terms[i].handle, self.terms[i].pid);
                    self.send(client, Frame::new(h, Msg::Spawned { seq, pid: pid as u32, existed: true }));
                    self.attach(client, i, attachment, now);
                    return;
                }
                match spawn_child(&argv, &env, cwd.as_deref(), cols.max(1), rows.max(1)) {
                    Ok((master, pid)) => {
                        let handle = self.next_handle;
                        self.next_handle = self.next_handle.wrapping_add(1).max(1);
                        self.terms.push(Term {
                            handle,
                            id,
                            pid,
                            master,
                            cwd,
                            started_at: now_ms(),
                            last_output: 0,
                            activity_sent: None,
                            outlet: Outlet::new(now),
                            modes: ModeScan::default(),
                            paste: false,
                            persist,
                            meta,
                            input: InputQueue::default(),
                            input_next: Next::Idle,
                            expected: false,
                            eof: false,
                            status: None,
                        });
                        self.send(client, Frame::new(handle, Msg::Spawned { seq, pid: pid as u32, existed: false }));
                        let i = self.terms.len() - 1;
                        self.attach(client, i, attachment, now);
                    }
                    Err(e) => {
                        let program = argv.first().cloned().unwrap_or_default();
                        self.send(client, Frame::bare(Msg::Error { seq, message: format!("failed to spawn {program}: {e}") }));
                    }
                }
            }
            Msg::Attach { attachment } => match self.term_index(handle) {
                Some(i) => self.attach(client, i, attachment, now),
                None => self.send(client, Frame::new(handle, Msg::Error { seq: 0, message: "terminal is not running".into() })),
            },
            Msg::Detach { attachment } => {
                if let Some(i) = self.term_index(handle) {
                    self.terms[i].outlet.detach(&Attachment { client, id: attachment });
                }
            }
            Msg::Input { seq, flags, gap_ms, bytes } => match self.term_index(handle) {
                Some(i) => {
                    let mut job = Job::new(seq, bytes, flags & proto::INPUT_PACED != 0, flags & proto::INPUT_CHECKED != 0, Duration::from_millis(gap_ms.into()));
                    job.owner = client;
                    self.terms[i].input.push(job);
                    self.pump_input(i, now);
                }
                None if flags & proto::INPUT_CHECKED != 0 => {
                    self.send(client, Frame::new(handle, Msg::InputDone { seq, ok: false, error: "terminal is not running".into() }));
                }
                None => {}
            },
            Msg::Resize { cols, rows } => {
                if let Some(i) = self.term_index(handle) {
                    let ws = libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 };
                    // SAFETY: TIOCSWINSZ on a master this process owns.
                    unsafe { libc::ioctl(self.terms[i].master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
                }
            }
            Msg::Ack { attachment, n } => {
                if let Some(i) = self.term_index(handle) {
                    let att = Attachment { client, id: attachment };
                    if let Some(bytes) = self.terms[i].outlet.ack(&att, n as usize, now) {
                        self.send(client, Frame::new(handle, Msg::Output { bytes }));
                    }
                }
            }
            Msg::Kill { signal } => {
                if let Some(i) = self.term_index(handle) {
                    let t = &mut self.terms[i];
                    t.expected = true;
                    // SAFETY: signalling our own child.
                    unsafe { libc::kill(t.pid, signal) };
                }
            }
            Msg::KillWhere { all } => {
                for t in self.terms.iter_mut().filter(|t| t.status.is_none() && (all || !t.persist)) {
                    t.expected = true;
                    // SAFETY: as above. SIGHUP, as the in-process killer sends.
                    unsafe { libc::kill(t.pid, libc::SIGHUP) };
                }
            }
            Msg::SetMeta { persist, meta } => {
                if let Some(i) = self.term_index(handle) {
                    self.terms[i].persist = persist;
                    self.terms[i].meta = meta;
                }
            }
            Msg::List { seq } => {
                let mut rows: Vec<Row> = self.terms.iter().filter(|t| t.status.is_none()).map(Term::row).collect();
                rows.extend(self.tombs.iter().map(|t| t.row.clone()));
                self.send(client, Frame::bare(Msg::ListReply { seq, rows }));
            }
            Msg::Fg { seq } => {
                let rows = self
                    .terms
                    .iter()
                    .filter(|t| t.status.is_none())
                    .map(|t| {
                        // SAFETY: tcgetpgrp on a master this process owns.
                        let pgid = unsafe { libc::tcgetpgrp(t.master.as_raw_fd()) };
                        (t.handle, (pgid > 0).then_some(pgid))
                    })
                    .collect();
                self.send(client, Frame::bare(Msg::FgReply { seq, rows }));
            }
            Msg::Reap => {
                self.tombs.remove_where(|t| t.row.handle == handle);
            }
            Msg::Tail { seq, max } => {
                let bytes = match self.term_index(handle) {
                    Some(i) => self.terms[i].outlet.tail(max as usize),
                    None => self
                        .tombs
                        .iter()
                        .find(|t| t.row.handle == handle)
                        .map(|t| t.ring[t.ring.len().saturating_sub(max as usize)..].to_vec())
                        .unwrap_or_default(),
                };
                self.send(client, Frame::new(handle, Msg::TailReply { seq, bytes }));
            }
            Msg::Retire { sock: name } => self.retire(client, &name),
            // Helper → app frames from an app are a protocol error.
            _ => {
                if let Some(c) = self.clients.iter_mut().find(|c| c.id == client) {
                    c.gone = true;
                }
            }
        }
    }

    fn attach(&mut self, client: u64, i: usize, attachment: String, now: Instant) {
        let t = &mut self.terms[i];
        let replay = t.outlet.attach(Attachment { client, id: attachment.clone() }, now);
        let (handle, paste) = (t.handle, t.paste);
        self.send(client, Frame::new(handle, Msg::Replay { attachment, bytes: replay }));
        // The composer's paste-mode state, for a client that just met this
        // terminal (a relaunched app).
        self.send(client, Frame::new(handle, Msg::Mode { paste }));
    }

    /// Hand the primary socket to a newer helper: serve on `name` from now
    /// on, and exit after the last terminal ends.
    fn retire(&mut self, client: u64, name: &str) {
        if name.contains('/') || name == self.args.sock {
            self.send(client, Frame::bare(Msg::Error { seq: 0, message: "retire needs another socket name".into() }));
            return;
        }
        match sock::bind(&self.args.dir, name) {
            Ok(l) => {
                let _ = l.set_nonblocking(true);
                let _ = std::env::set_current_dir("/");
                if self.listen_ino.is_some() && inode(&self.listen_path) == self.listen_ino {
                    let _ = std::fs::remove_file(&self.listen_path);
                }
                self.listener = l;
                self.listen_path = self.args.dir.join(name);
                self.listen_ino = inode(&self.listen_path);
                self.args.sock = name.to_string();
                self.retiring = true;
            }
            Err(e) => self.send(client, Frame::bare(Msg::Error { seq: 0, message: format!("retire: {e}") })),
        }
    }

    // --- terminals -------------------------------------------------------------

    fn read_term(&mut self, i: usize, now: Instant) {
        let mut buf = vec![0u8; READ_CHUNK];
        let t = &mut self.terms[i];
        // SAFETY: reading into a buffer of its own length from an owned fd.
        let n = unsafe { libc::read(t.master.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 {
            self.output(i, &buf[..n as usize], now);
        } else if n == 0 {
            t.eof = true;
        } else {
            let e = io::Error::last_os_error();
            match e.kind() {
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => {}
                // EIO: every slave fd is closed.
                _ => t.eof = true,
            }
        }
    }

    fn output(&mut self, i: usize, bytes: &[u8], now: Instant) {
        let ms = now_ms();
        let t = &mut self.terms[i];
        t.last_output = ms;
        let handle = t.handle;
        let mode = t.modes.feed(bytes).filter(|on| *on != t.paste);
        if let Some(on) = mode {
            t.paste = on;
        }
        t.outlet.push(bytes, now);
        let activity = t.activity_sent.is_none_or(|at| now.duration_since(at) >= ACTIVITY_EVERY);
        if activity {
            t.activity_sent = Some(now);
        }
        if let Some(paste) = mode {
            self.broadcast(Frame::new(handle, Msg::Mode { paste }));
        }
        if activity {
            self.broadcast(Frame::new(handle, Msg::Activity { last_output: ms }));
        }
    }

    fn flush_term(&mut self, i: usize) {
        let t = &mut self.terms[i];
        let Some(att) = t.outlet.attachment().cloned() else {
            t.outlet.take_flush();
            return;
        };
        if let Some(bytes) = t.outlet.take_flush() {
            let handle = t.handle;
            self.send(att.client, Frame::new(handle, Msg::Output { bytes }));
        }
    }

    fn pump_input(&mut self, i: usize, now: Instant) {
        let t = &mut self.terms[i];
        let fd = t.master.as_raw_fd();
        let mut write = |b: &[u8]| -> io::Result<usize> {
            // SAFETY: writing a borrowed slice to an owned fd.
            let n = unsafe { libc::write(fd, b.as_ptr().cast(), b.len()) };
            if n < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        };
        let (done, next) = t.input.pump(now, &mut write);
        t.input_next = next;
        let handle = t.handle;
        for d in done {
            self.send(d.owner, Frame::new(handle, Msg::InputDone { seq: d.seq, ok: d.ok, error: d.error }));
        }
    }

    fn timers(&mut self, now: Instant) {
        for i in 0..self.terms.len() {
            if self.terms[i].outlet.flush_due(now) {
                self.flush_term(i);
            }
            if matches!(self.terms[i].input_next, Next::At(at) if now >= at) {
                self.pump_input(i, now);
            }
        }
    }

    fn reap(&mut self) {
        let mut drain = [0u8; 64];
        // SAFETY: draining our own non-blocking pipe.
        while unsafe { libc::read(self.sig_r.as_raw_fd(), drain.as_mut_ptr().cast(), drain.len()) } > 0 {}
        loop {
            let mut status = 0;
            // SAFETY: reaping our own children.
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if pid <= 0 {
                break;
            }
            if let Some(t) = self.terms.iter_mut().find(|t| t.pid == pid && t.status.is_none()) {
                t.status = Some(status);
            }
        }
    }

    /// A shell that was reaped: take what it last printed, deliver it, say
    /// so, keep a tombstone if nobody asked for the exit, close the master.
    fn finish_exited(&mut self, now: Instant) {
        let mut i = 0;
        while i < self.terms.len() {
            if self.terms[i].status.is_none() {
                i += 1;
                continue;
            }
            // Whatever the shell wrote before it went is still in the master.
            let mut budget: usize = 4 * 1024 * 1024;
            let mut buf = vec![0u8; READ_CHUNK];
            while budget > 0 && !self.terms[i].eof {
                let fd = self.terms[i].master.as_raw_fd();
                // SAFETY: as in `read_term`.
                let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                if n <= 0 {
                    break;
                }
                budget = budget.saturating_sub(n as usize);
                self.output(i, &buf[..n as usize], now);
            }
            self.flush_term(i);
            let t = self.terms.remove(i);
            let failed = {
                let mut q = t.input;
                q.fail_all("terminal exited")
            };
            for d in failed {
                self.send(d.owner, Frame::new(t.handle, Msg::InputDone { seq: d.seq, ok: false, error: d.error }));
            }
            let status = t.status.unwrap_or(0);
            self.broadcast(Frame::new(t.handle, Msg::Exit { status, expected: t.expected }));
            if !t.expected {
                let row = Row {
                    handle: t.handle,
                    id: t.id.clone(),
                    pid: t.pid as u32,
                    alive: false,
                    exit: Some(status),
                    started_at: t.started_at,
                    last_output: t.last_output,
                    cwd: t.cwd.clone(),
                    persist: t.persist,
                    paste: false,
                    meta: t.meta.clone(),
                };
                self.tombs.insert(now, Tomb { row, ring: t.outlet.ring() });
            }
            // `t.master` drops here: anything still holding the slave gets
            // SIGHUP, as when the in-process registry dropped a session.
        }
    }
}

// --- the spawn ------------------------------------------------------------------

/// `argv[0]` as the child's `execvp` would find it, on the PATH the child
/// is given (not the helper's, which is empty).
fn resolve(program: &str, env: &[String]) -> io::Result<CString> {
    let found = if program.contains('/') {
        Some(PathBuf::from(program))
    } else {
        let path = env.iter().find_map(|e| e.strip_prefix("PATH=")).unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin");
        path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(program)).find(|p| {
            let c = CString::new(p.as_os_str().as_encoded_bytes()).ok();
            // SAFETY: a NUL-terminated path.
            c.is_some_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
        })
    };
    let found = found.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{program}: not found on PATH")))?;
    CString::new(found.as_os_str().as_encoded_bytes()).map_err(io::Error::other)
}

fn cstrings(list: &[String]) -> io::Result<Vec<CString>> {
    list.iter().map(|s| CString::new(s.as_bytes()).map_err(io::Error::other)).collect()
}

/// Open a PTY and run `argv` on it as a session leader with the slave as its
/// controlling terminal: the steps `portable-pty`'s unix spawn takes, done
/// with `fork` because this process has one thread. Everything the child
/// needs is allocated before the fork; after it, only async-signal-safe calls.
/// An exec failure comes back through a close-on-exec pipe, so a bad program
/// is an error here rather than a shell that exits at once.
fn spawn_child(argv: &[String], env: &[String], cwd: Option<&str>, cols: u16, rows: u16) -> io::Result<(OwnedFd, i32)> {
    let program = argv.first().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?;
    let path = resolve(program, env)?;
    let c_argv = cstrings(argv)?;
    let c_env = cstrings(env)?;
    let c_cwd = cwd.filter(|d| !d.is_empty()).map(|d| CString::new(d).map_err(io::Error::other)).transpose()?;
    let mut argv_p: Vec<*const libc::c_char> = c_argv.iter().map(|c| c.as_ptr()).collect();
    argv_p.push(std::ptr::null());
    let mut env_p: Vec<*const libc::c_char> = c_env.iter().map(|c| c.as_ptr()).collect();
    env_p.push(std::ptr::null());

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: out-parameters and a valid winsize.
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned two fds we now own.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    sock::cloexec(master.as_raw_fd())?;
    sock::cloexec(slave.as_raw_fd())?;
    let mut pipe = [0; 2];
    // SAFETY: a two-int out array.
    if unsafe { libc::pipe(pipe.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: just created, owned here.
    let (err_r, err_w) = unsafe { (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])) };
    sock::cloexec(err_r.as_raw_fd())?;
    sock::cloexec(err_w.as_raw_fd())?;
    // SAFETY: no arguments.
    let max_fd = unsafe { libc::getdtablesize() }.clamp(256, 65536);

    // SAFETY: the process is single-threaded; the child below uses only
    // async-signal-safe calls on memory prepared before the fork.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        unsafe {
            let fail = |w: libc::c_int| -> ! {
                let errno = *libc::__error();
                libc::write(w, (&errno as *const libc::c_int).cast(), std::mem::size_of::<libc::c_int>());
                libc::_exit(127);
            };
            let w = err_w.as_raw_fd();
            let s = slave.as_raw_fd();
            if libc::setsid() < 0 {
                fail(w);
            }
            if libc::ioctl(s, libc::TIOCSCTTY as _, 0) < 0 {
                fail(w);
            }
            for fd in 0..3 {
                if libc::dup2(s, fd) < 0 {
                    fail(w);
                }
            }
            // Nothing else crosses: every fd here is close-on-exec already,
            // and this is the belt to those braces.
            for fd in 3..max_fd {
                if fd != w {
                    libc::close(fd);
                }
            }
            for sig in 1..32 {
                libc::signal(sig, libc::SIG_DFL);
            }
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            if let Some(dir) = &c_cwd {
                if libc::chdir(dir.as_ptr()) < 0 {
                    fail(w);
                }
            }
            libc::execve(path.as_ptr(), argv_p.as_ptr(), env_p.as_ptr());
            fail(w);
        }
    }
    drop(slave);
    drop(err_w);
    let mut errno = [0u8; 4];
    let mut got = 0;
    let mut r = std::fs::File::from(err_r);
    while got < 4 {
        match r.read(&mut errno[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    if got == 4 {
        let mut status = 0;
        // SAFETY: reaping the child that failed to exec.
        unsafe { libc::waitpid(pid, &mut status, 0) };
        return Err(io::Error::from_raw_os_error(i32::from_ne_bytes(errno)));
    }
    set_nonblocking(master.as_raw_fd())?;
    Ok((master, pid))
}

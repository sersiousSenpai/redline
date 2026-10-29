// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The terminal helper, end to end: the real executable, real PTYs, real
//! shells, over its real socket.
//!
//! What the helper exists to guarantee (a shell survives its viewer, a
//! reattach replays the newest 256 KB exactly once, backpressure parks the
//! reader, a paced write arrives whole, a spawned shell is a clean session
//! leader with exactly the environment it was sent) are properties of
//! `poll`, the tty layer and process lifetime. Mocks cannot establish any of
//! them, so none are used.
//!
//! Each test starts its own helper in a scratch directory with `--peer-dir`
//! set to this test binary's directory (the sibling rule, as the test binary
//! is the "app" here), and kills it on drop, so no helper and no socket file
//! outlives a test, passing or failing.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use redline_pty_proto::{self as proto, Frame, Msg, Row};
use redline_ptyd::sock;

const HELPER: &str = env!("CARGO_BIN_EXE_redline-ptyd");
const RING: usize = 256 * 1024;

fn scratch(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    let dir = std::env::temp_dir().join(format!("rl-ptyd-{tag}-{}-{nanos}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn my_dir() -> PathBuf {
    std::env::current_exe().unwrap().parent().unwrap().to_path_buf()
}

struct Helper {
    child: Option<Child>,
    dir: PathBuf,
    sock: String,
}

impl Helper {
    fn start(tag: &str, extra: &[&str]) -> Self {
        Self::start_in(scratch(tag), extra)
    }

    fn start_in(dir: PathBuf, extra: &[&str]) -> Self {
        let sock = "ptyd-test.sock".to_string();
        let peer = my_dir();
        let mut args: Vec<String> = vec!["--foreground".into(), "--dir".into(), dir.display().to_string(), "--sock".into(), sock.clone()];
        if !extra.contains(&"--peer-dir") {
            args.extend(["--peer-dir".into(), peer.display().to_string()]);
        }
        args.extend(extra.iter().map(|s| s.to_string()));
        let child = Command::new(HELPER).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let h = Self { child: Some(child), dir, sock };
        let deadline = Instant::now() + Duration::from_secs(5);
        while sock::connect(&h.dir, &h.sock).is_err() {
            assert!(Instant::now() < deadline, "the helper never listened");
            std::thread::sleep(Duration::from_millis(10));
        }
        h
    }

    fn pid(&self) -> i32 {
        self.child.as_ref().unwrap().id() as i32
    }

    fn connect(&self) -> Conn {
        let s = sock::connect(&self.dir, &self.sock).unwrap();
        let mut c = Conn::new(s);
        c.hello(None);
        c
    }

    fn kill9(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.kill9();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Conn {
    s: UnixStream,
    dec: proto::Decoder,
    seq: u32,
    /// Frames read while waiting for something else.
    backlog: std::collections::VecDeque<Frame>,
}

impl Conn {
    fn new(s: UnixStream) -> Self {
        Self { s, dec: proto::Decoder::new(), seq: 0, backlog: Default::default() }
    }

    fn send(&mut self, frame: Frame) {
        self.s.write_all(&proto::to_bytes(&frame).unwrap()).unwrap();
    }

    fn next_seq(&mut self) -> u32 {
        self.seq += 1;
        self.seq
    }

    /// The next frame, or None at the deadline or EOF.
    fn recv(&mut self, timeout: Duration) -> Option<Frame> {
        if let Some(f) = self.backlog.pop_front() {
            return Some(f);
        }
        let deadline = Instant::now() + timeout;
        let mut buf = [0u8; 65536];
        loop {
            if let Some(f) = self.dec.next_frame().unwrap() {
                return Some(f);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            // macOS refuses SO_RCVTIMEO on a socket whose peer is gone.
            if self.s.set_read_timeout(Some(left)).is_err() {
                return None;
            }
            match self.s.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => self.dec.feed(&buf[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => return None,
                Err(e) => panic!("read: {e}"),
            }
        }
    }

    /// Wait for the first frame `pick` accepts; the rest are kept.
    fn wait_for<T>(&mut self, timeout: Duration, mut pick: impl FnMut(&Frame) -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + timeout;
        let mut skipped = Vec::new();
        let found = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let Some(f) = self.recv(left) else { break None };
            if let Some(v) = pick(&f) {
                break Some(v);
            }
            skipped.push(f);
        };
        for f in skipped.into_iter().rev() {
            self.backlog.push_front(f);
        }
        found
    }

    fn hello(&mut self, token: Option<&str>) -> (String, u32, u64) {
        self.send(Frame::bare(Msg::Hello { core: proto::CORE, caps: vec![], build: "e2e".into(), token: token.map(String::from) }));
        match self.recv(Duration::from_secs(5)).expect("welcome").msg {
            Msg::Welcome { token, pid, instance, core, .. } => {
                assert_eq!(core, proto::CORE);
                (token, pid, instance)
            }
            other => panic!("expected Welcome, got {other:?}"),
        }
    }

    fn spawn(&mut self, id: &str, argv: &[&str], env: &[String], cwd: Option<&str>, attachment: &str) -> (u32, u32) {
        let seq = self.next_seq();
        self.send(Frame::bare(Msg::Spawn {
            seq,
            id: id.into(),
            cwd: cwd.map(String::from),
            cols: 80,
            rows: 24,
            argv: argv.iter().map(|s| s.to_string()).collect(),
            env: env.to_vec(),
            persist: true,
            meta: b"{\"owner\":\"e2e\"}".to_vec(),
            attachment: attachment.into(),
        }));
        self.wait_for(Duration::from_secs(5), |f| match &f.msg {
            Msg::Spawned { seq: s, pid, .. } if *s == seq => Some((f.pty, *pid)),
            Msg::Error { seq: s, message } if *s == seq => panic!("spawn failed: {message}"),
            _ => None,
        })
        .expect("spawn reply")
    }

    /// Read output for `handle` until `done` holds, ACKing as a renderer
    /// does when `ack` is set. Returns (replay frames seen, bytes in order).
    fn collect(&mut self, handle: u32, attachment: &str, ack: bool, timeout: Duration, done: impl Fn(&[u8]) -> bool) -> (usize, Vec<u8>) {
        let deadline = Instant::now() + timeout;
        let mut bytes = Vec::new();
        let mut replays = 0;
        while !done(&bytes) {
            let left = deadline.saturating_duration_since(Instant::now());
            let Some(f) = self.recv(left) else { break };
            if f.pty != handle {
                continue;
            }
            let n = match f.msg {
                Msg::Replay { bytes: b, .. } => {
                    replays += 1;
                    bytes.extend_from_slice(&b);
                    b.len()
                }
                Msg::Output { bytes: b } => {
                    bytes.extend_from_slice(&b);
                    b.len()
                }
                _ => 0,
            };
            if ack && n > 0 {
                self.send(Frame::new(handle, Msg::Ack { attachment: attachment.into(), n: n as u32 }));
            }
        }
        (replays, bytes)
    }

    fn list(&mut self) -> Vec<Row> {
        let seq = self.next_seq();
        self.send(Frame::bare(Msg::List { seq }));
        self.wait_for(Duration::from_secs(5), |f| match &f.msg {
            Msg::ListReply { seq: s, rows } if *s == seq => Some(rows.clone()),
            _ => None,
        })
        .expect("list reply")
    }

    fn input(&mut self, handle: u32, bytes: &[u8], paced: bool) -> bool {
        let seq = self.next_seq();
        let flags = proto::INPUT_CHECKED | if paced { proto::INPUT_PACED } else { 0 };
        self.send(Frame::new(handle, Msg::Input { seq, flags, gap_ms: 0, bytes: bytes.to_vec() }));
        seq > 0
    }
}

fn base_env() -> Vec<String> {
    vec!["PATH=/usr/bin:/bin:/usr/sbin:/sbin".into(), "TERM=xterm-256color".into(), "HOME=/tmp".into(), "LANG=C".into()]
}

/// `count` lines of `%07d\n`: 8 bytes each, every line different.
fn pattern(from: usize, count: usize) -> Vec<u8> {
    (from..from + count).flat_map(|i| format!("{i:07}\n").into_bytes()).collect()
}

fn awk(from: usize, count: usize) -> String {
    format!("awk 'BEGIN{{for(i={from};i<{};i++) printf \"%07d\\n\", i}}'", from + count)
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

// 1 and 2 ---------------------------------------------------------------------

#[test]
fn a_shell_survives_its_viewer_and_a_reattach_replays_the_newest_ring_once() {
    let h = Helper::start("survive", &[]);
    let mut c = h.connect();
    // Raw mode: no `\n` → `\r\n`, so the stream is the pattern byte for byte.
    let script = format!("stty raw -echo; printf START; {}; printf MID; read go; {}; printf END; exec cat", awk(0, 38_400), awk(38_400, 51_200));
    let (handle, pid) = c.spawn("t1", &["/bin/sh", "-c", &script], &base_env(), Some("/tmp"), "a1");
    let first = [b"START".as_slice(), &pattern(0, 38_400), b"MID"].concat();
    assert!(first.len() > 300 * 1024);
    let (replays, got) = c.collect(handle, "a1", true, Duration::from_secs(20), |b| b.len() >= first.len());
    assert_eq!(replays, 1, "exactly one replay frame per attach");
    assert_eq!(got, first, "the first 300 KB arrive whole while attached");

    // The viewer goes away (Redline quit). The shell carries on: the second
    // burst is written with nobody attached and drains into the ring.
    drop(c);
    let mut writer = h.connect();
    writer.send(Frame::new(handle, Msg::Input { seq: 0, flags: 0, gap_ms: 0, bytes: b"\n".to_vec() }));
    drop(writer);
    // Done when the ring's tail is END.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut c = h.connect();
    loop {
        let rows = c.list();
        assert!(rows.iter().find(|r| r.handle == handle).unwrap().alive);
        let seq = c.next_seq();
        c.send(Frame::new(handle, Msg::Tail { seq, max: 3 }));
        let tail = c.wait_for(Duration::from_secs(2), |f| match &f.msg {
            Msg::TailReply { bytes, .. } => Some(bytes.clone()),
            _ => None,
        });
        if tail.as_deref() == Some(b"END".as_slice()) {
            break;
        }
        assert!(Instant::now() < deadline, "the second burst never finished");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(alive(pid), "the shell outlived its viewer");
    let whole = [first.as_slice(), &pattern(38_400, 51_200), b"END"].concat();
    c.send(Frame::new(handle, Msg::Attach { attachment: "a2".into() }));
    let (replays, replay) = c.collect(handle, "a2", true, Duration::from_secs(5), |b| b.len() >= RING);
    assert_eq!(replays, 1);
    assert_eq!(replay.len(), RING, "the ring holds exactly 256 KB");
    assert_eq!(replay, whole[whole.len() - RING..], "the newest 256 KB, exactly once");
    // Live bytes follow the replay.
    c.input(handle, b"live", false);
    let (_, live) = c.collect(handle, "a2", true, Duration::from_secs(5), |b| b.ends_with(b"live"));
    assert_eq!(live, b"live");
}

// 3 -----------------------------------------------------------------------------

#[test]
fn a_second_attach_replaces_the_first_and_the_old_ones_detach_is_ignored() {
    let h = Helper::start("replace", &[]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("t", &["/bin/sh", "-c", "stty raw -echo; printf ready; exec cat"], &base_env(), None, "old");
    c.collect(handle, "old", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    // A second client (a relaunched app) attaches; the first's stale
    // Ack/Detach must not touch the new view.
    let mut c2 = h.connect();
    c2.send(Frame::new(handle, Msg::Attach { attachment: "new".into() }));
    let (replays, replay) = c2.collect(handle, "new", false, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    assert_eq!((replays, replay.as_slice()), (1, b"ready".as_slice()));
    c.send(Frame::new(handle, Msg::Ack { attachment: "old".into(), n: 1_000_000 }));
    c.send(Frame::new(handle, Msg::Detach { attachment: "old".into() }));
    c2.send(Frame::new(handle, Msg::Detach { attachment: "old".into() }));
    c2.input(handle, b"ping", false);
    let (_, live) = c2.collect(handle, "new", true, Duration::from_secs(5), |b| b.ends_with(b"ping"));
    assert_eq!(live, b"ping", "still attached after the stale detach");
    let (_, old) = c.collect(handle, "old", false, Duration::from_millis(300), |_| false);
    assert!(old.is_empty(), "the replaced view gets nothing more");
}

// 4 -----------------------------------------------------------------------------

#[test]
fn a_resize_is_what_the_program_sees() {
    let h = Helper::start("resize", &[]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("t", &["/bin/sh", "-c", "stty -echo; printf ready; while read l; do stty size; done"], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    c.send(Frame::new(handle, Msg::Resize { cols: 101, rows: 33 }));
    c.input(handle, b"\n", false);
    let (_, got) = c.collect(handle, "a", true, Duration::from_secs(5), |b| String::from_utf8_lossy(b).contains("33 101"));
    assert!(String::from_utf8_lossy(&got).contains("33 101"), "{got:?}");
}

// 5 -----------------------------------------------------------------------------

fn rss_kb(pid: i32) -> u64 {
    let out = Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

#[test]
fn a_firehose_without_acks_parks_the_reader_and_memory_stays_bounded() {
    let h = Helper::start("yes", &[]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("t", &["/usr/bin/yes"], &base_env(), None, "a");
    // No ACKs: delivery stops at the high-water mark plus one read.
    let (_, got) = c.collect(handle, "a", false, Duration::from_secs(2), |_| false);
    assert!(got.len() >= RING, "it delivered up to the mark: {}", got.len());
    assert!(got.len() <= RING + 3 * 64 * 1024, "and parked there: {}", got.len());
    let parked = got.len();
    let (_, more) = c.collect(handle, "a", false, Duration::from_secs(1), |_| false);
    assert!(more.is_empty(), "nothing more arrives while parked inside the stall window");
    // After the 5 s stall the view is suspended and the shell drains into
    // the ring: the helper stays small however long `yes` runs.
    std::thread::sleep(Duration::from_secs(5));
    let rss = rss_kb(h.pid());
    assert!(rss < 64 * 1024, "helper RSS {rss} KB under a firehose");
    // A late ACK resumes with a reset and the retained tail.
    c.send(Frame::new(handle, Msg::Ack { attachment: "a".into(), n: parked as u32 }));
    let (_, resumed) = c.collect(handle, "a", false, Duration::from_secs(3), |b| {
        b.windows(2).position(|w| w == b"\x1bc").is_some_and(|at| b.len() - at - 2 >= RING)
    });
    let at = resumed.windows(2).position(|w| w == b"\x1bc").expect("fell behind the ring: a reset");
    assert_eq!(resumed.len() - at - 2, RING, "then exactly the retained tail");
    // Detached, it drains freely: Activity keeps arriving.
    c.send(Frame::new(handle, Msg::Detach { attachment: "a".into() }));
    let flowing = c.wait_for(Duration::from_secs(3), |f| matches!(f.msg, Msg::Activity { .. }).then_some(()));
    assert!(flowing.is_some(), "detached output still flows");
    let rss = rss_kb(h.pid());
    assert!(rss < 64 * 1024, "helper RSS {rss} KB detached");
}

// 6 -----------------------------------------------------------------------------

#[test]
fn paced_writes_arrive_whole_in_raw_mode_and_through_zshs_line_editor() {
    let h = Helper::start("paced", &[]);
    let dir = h.dir.clone();
    let mut c = h.connect();
    let out = dir.join("raw.bin");
    let script = format!("stty raw -echo; printf ready; head -c 102400 > '{}'; printf DONE; exec cat", out.display());
    let (handle, _) = c.spawn("raw", &["/bin/sh", "-c", &script], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    let payload: Vec<u8> = (0..102_400u32).map(|i| b'a' + (i % 26) as u8).collect();
    c.input(handle, &payload, true);
    let done = c.wait_for(Duration::from_secs(10), |f| match f.msg {
        Msg::InputDone { ok, .. } => Some(ok),
        _ => None,
    });
    assert_eq!(done, Some(true));
    c.collect(handle, "a", true, Duration::from_secs(10), |b| b.ends_with(b"DONE"));
    assert_eq!(std::fs::read(&out).unwrap(), payload, "100 KB into a raw-mode reader, byte-equal");

    // zsh's line editor redraws the whole line per chunk, emitting more than
    // it consumes: the master must be drained continuously (we ACK as we go).
    if !Path::new("/bin/zsh").exists() {
        return;
    }
    let file = dir.join("zle.txt");
    let (handle, _) = c.spawn("zle", &["/bin/zsh", "-f"], &base_env(), Some(dir.to_str().unwrap()), "z");
    c.collect(handle, "z", true, Duration::from_secs(3), |b| !b.is_empty());
    let word: String = (0..22_000u32).map(|i| (b'a' + (i % 26) as u8) as char).collect();
    // The marker is computed, so the line's own echo can't match it.
    let line = format!("printf %s {word} > '{}'; echo $((40+2))ZDONE\r", file.display());
    c.input(handle, line.as_bytes(), true);
    let (_, got) = c.collect(handle, "z", true, Duration::from_secs(20), |b| String::from_utf8_lossy(b).contains("42ZDONE"));
    assert!(String::from_utf8_lossy(&got).contains("42ZDONE"), "the command ran");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), word, "22 KB through the line editor, whole");
}

// 7 -----------------------------------------------------------------------------

#[test]
fn a_spawned_shell_is_a_clean_session_leader_with_exactly_the_env_sent() {
    let h = Helper::start("parity", &[]);
    let mut c = h.connect();
    let mut env = base_env();
    env.push("REDLINE_TERMINAL_ID=t-parity".into());
    env.push("ODD=a b\tc".into());
    let script = "stty -echo -onlcr; \
        test -t 0 && echo TTY=yes; \
        echo CWD=$(pwd -P); \
        /usr/bin/env | /usr/bin/sort | sed 's/^/ENV:/'; \
        /usr/bin/perl -e 'print \"IGNORED=\", join(\",\", sort grep { ($SIG{$_} // \"\") eq \"IGNORE\" } keys %SIG), \"\\n\"'; \
        exec /bin/ps -o pid=,pgid=,tpgid=,sigmask=,stat= -p $$";
    let (handle, pid) = c.spawn("p", &["/bin/sh", "-c", script], &env, Some("/private/tmp"), "a");
    let (_, got) = c.collect(handle, "a", true, Duration::from_secs(10), |b| b.ends_with(b"\n") && String::from_utf8_lossy(b).lines().last().is_some_and(|l| l.contains('+')));
    let text = String::from_utf8_lossy(&got).replace('\r', "");
    assert!(text.contains("TTY=yes"), "a controlling tty: {text}");
    assert!(text.contains("CWD=/private/tmp"), "the requested cwd: {text}");
    let mut seen: Vec<String> = text.lines().filter_map(|l| l.strip_prefix("ENV:")).map(String::from).collect();
    // `sh` itself adds its own bookkeeping (PWD, SHLVL, `_`, OLDPWD).
    seen.retain(|l| !["PWD=", "SHLVL=", "_=", "OLDPWD="].iter().any(|p| l.starts_with(p)));
    let mut want = env.clone();
    want.sort();
    assert_eq!(seen, want, "exactly the environment sent");
    let ps = text.lines().last().unwrap().split_whitespace().map(String::from).collect::<Vec<_>>();
    assert_eq!(ps[0], pid.to_string());
    assert_eq!(ps[1], ps[0], "its own process group");
    assert_eq!(ps[2], ps[0], "the foreground group of its tty");
    assert_eq!(ps[3], "0", "an empty signal mask");
    assert!(ps[4].contains('s') && ps[4].contains('+'), "a session leader in the foreground: {}", ps[4]);
    // The helper itself ignores SIGPIPE; a shell must not inherit that. (Perl
    // ignores SIGFPE itself at startup, PERL_FPU_INIT, so FPE is perl's.)
    let ignored = text.lines().find_map(|l| l.strip_prefix("IGNORED=")).expect("perl ran");
    let ignored: Vec<&str> = ignored.split(',').filter(|s| !s.is_empty() && *s != "FPE").collect();
    assert!(ignored.is_empty(), "default dispositions, nothing ignored: {ignored:?}");

    // What the helper hands a program it execs directly. macOS `ls` opens
    // two descriptors of its own to list `/dev/fd` (3 and 4: `/bin/ls
    // /dev/fd </dev/null` from a clean login shell prints 0-4); anything
    // past that would be the helper's.
    let (handle, _) = c.spawn("fds", &["/bin/ls", "/dev/fd"], &env, None, "b");
    let (_, got) = c.collect(handle, "b", true, Duration::from_secs(5), |_| false);
    let fds: Vec<String> = String::from_utf8_lossy(&got).split_whitespace().map(String::from).collect();
    assert_eq!(fds, ["0", "1", "2", "3", "4"], "no inherited fds beyond 0-2");
}

#[test]
fn a_listener_open_in_the_app_is_held_by_neither_the_helper_nor_its_shells() {
    // The app's :7676, stand-in: a listener whose close-on-exec flag is
    // cleared, as an inherited fd would be without CLOEXEC_DEFAULT.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let fd = listener.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
    }
    let dir = scratch("cloexec");
    let peer = my_dir();
    let args = ["--dir".to_string(), dir.display().to_string(), "--sock".into(), "p.sock".into(), "--peer-dir".into(), peer.display().to_string(), "--sweep-secs".into(), "30".into()];
    sock::spawn_helper(Path::new(HELPER), &args).unwrap();
    let mut c = Conn::new(sock::connect(&dir, "p.sock").unwrap());
    let (_, helper_pid, _) = c.hello(None);
    let (handle, shell) = c.spawn("t", &["/bin/sh", "-c", "printf ready; exec sleep 30"], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    let holders = Command::new("lsof").args(["-nP", "-t", &format!("-iTCP:{port}")]).output().unwrap();
    let holders: Vec<u32> = String::from_utf8_lossy(&holders.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
    assert!(holders.contains(&std::process::id()), "the test holds it: {holders:?}");
    assert!(!holders.contains(&helper_pid), "the helper does not");
    assert!(!holders.contains(&shell), "nor its shell");
    // The helper left our session and was adopted: it isn't our child.
    let ppid = Command::new("ps").args(["-o", "ppid=,sess=", "-p", &helper_pid.to_string()]).output().unwrap();
    let ppid = String::from_utf8_lossy(&ppid.stdout).split_whitespace().map(String::from).collect::<Vec<_>>();
    assert_eq!(ppid[0], "1", "launchd adopted the helper");
    c.send(Frame::bare(Msg::KillWhere { all: true }));
    drop(c);
    unsafe { libc::kill(helper_pid as i32, libc::SIGKILL) };
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(helper_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
    drop(listener);
}

// 8 -----------------------------------------------------------------------------

#[test]
fn a_kill_is_an_expected_exit_and_a_shell_that_dies_alone_leaves_a_tombstone() {
    let h = Helper::start("exit", &[]);
    let mut c = h.connect();
    let (killed, _) = c.spawn("k", &["/bin/sh", "-c", "printf ready; exec sleep 30"], &base_env(), None, "a");
    c.collect(killed, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    c.send(Frame::new(killed, Msg::Kill { signal: libc::SIGHUP }));
    let exit = c.wait_for(Duration::from_secs(5), |f| match f.msg {
        Msg::Exit { expected, .. } if f.pty == killed => Some(expected),
        _ => None,
    });
    assert_eq!(exit, Some(true));
    let (alone, _) = c.spawn("alone", &["/bin/sh", "-c", "printf 'last words'; exit 3"], &base_env(), None, "b");
    let exit = c.wait_for(Duration::from_secs(5), |f| match f.msg {
        Msg::Exit { expected, status } if f.pty == alone => Some((expected, status)),
        _ => None,
    });
    let (expected, status) = exit.expect("exit");
    assert!(!expected);
    assert!(libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 3);
    let rows = c.list();
    assert!(rows.iter().all(|r| r.handle != killed), "an expected exit leaves nothing");
    let tomb = rows.iter().find(|r| r.handle == alone).expect("a tombstone");
    assert!(!tomb.alive && tomb.exit == Some(status) && tomb.id == "alone");
    assert_eq!(tomb.meta, b"{\"owner\":\"e2e\"}");
    let seq = c.next_seq();
    c.send(Frame::new(alone, Msg::Tail { seq, max: 1000 }));
    let tail = c.wait_for(Duration::from_secs(2), |f| match &f.msg {
        Msg::TailReply { bytes, .. } => Some(bytes.clone()),
        _ => None,
    });
    assert_eq!(tail.as_deref(), Some(b"last words".as_slice()), "its last screen");
    c.send(Frame::new(alone, Msg::Reap));
    assert!(c.list().iter().all(|r| r.handle != alone), "Reap forgets it");
}

// 9 -----------------------------------------------------------------------------

#[test]
fn killing_the_helper_hangs_up_every_shell() {
    let mut h = Helper::start("crash", &[]);
    let mut c = h.connect();
    let mut pids = Vec::new();
    for i in 0..3 {
        let (handle, pid) = c.spawn(&format!("t{i}"), &["/bin/sh", "-c", "printf ready; exec sleep 300"], &base_env(), None, "a");
        c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
        pids.push(pid);
    }
    h.kill9();
    // The client sees EOF.
    assert!(c.recv(Duration::from_secs(2)).is_none());
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|p| alive(*p)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(pids.iter().all(|p| !alive(*p)), "every shell got SIGHUP and exited");
}

// 10 ----------------------------------------------------------------------------

#[test]
fn an_empty_helper_with_no_client_exits_and_unlinks_its_socket() {
    let mut h = Helper::start("sweep", &["--sweep-secs", "1"]);
    let path = h.dir.join(&h.sock);
    // A client resets the clock; leaving starts it.
    drop(h.connect());
    let child = h.child.as_mut().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "the helper never swept");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success());
    assert!(!path.exists(), "the socket is gone with it");
}

#[test]
fn a_helper_with_a_terminal_does_not_sweep() {
    let mut h = Helper::start("nosweep", &["--sweep-secs", "1"]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("t", &["/bin/sh", "-c", "printf ready; exec sleep 30"], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    drop(c);
    std::thread::sleep(Duration::from_secs(2));
    assert!(h.child.as_mut().unwrap().try_wait().unwrap().is_none(), "a live shell keeps it");
}

// 11 ----------------------------------------------------------------------------

#[test]
fn a_peer_outside_the_peer_dir_is_refused_before_any_frame() {
    let h = Helper::start("peer", &["--peer-dir", "/usr/bin"]);
    let mut s = sock::connect(&h.dir, &h.sock).unwrap();
    let _ = s.write_all(&proto::to_bytes(&Frame::bare(Msg::Hello { core: 1, caps: vec![], build: String::new(), token: None })).unwrap());
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).unwrap_or(0);
    assert_eq!(n, 0, "closed without a Welcome");
}

// The token lease, the handshake and the sun_path branch ------------------------

#[test]
fn the_first_token_is_leased_for_the_helpers_life() {
    let h = Helper::start("token", &[]);
    let mut first = Conn::new(sock::connect(&h.dir, &h.sock).unwrap());
    let (token, _, instance) = first.hello(Some("tok-1"));
    assert_eq!(token, "tok-1");
    let mut second = Conn::new(sock::connect(&h.dir, &h.sock).unwrap());
    let (token, _, again) = second.hello(Some("tok-2"));
    assert_eq!(token, "tok-1", "a relaunched app adopts the lease, it doesn't replace it");
    assert_eq!(again, instance, "the same helper instance");
}

#[test]
fn a_frame_before_hello_or_garbage_drops_the_connection() {
    let h = Helper::start("proto", &[]);
    let mut c = Conn::new(sock::connect(&h.dir, &h.sock).unwrap());
    c.send(Frame::bare(Msg::List { seq: 1 }));
    assert!(c.recv(Duration::from_secs(2)).is_none(), "List before Hello");
    let mut s = sock::connect(&h.dir, &h.sock).unwrap();
    s.write_all(&[0xff, 0xff, 0xff, 0xff, 1]).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(s.read(&mut buf).unwrap_or(0), 0, "an oversized frame");
    // The helper is fine.
    let mut ok = h.connect();
    assert!(ok.list().is_empty());
}

#[test]
fn a_socket_path_longer_than_sun_path_still_serves() {
    let base = scratch("long");
    let deep = base.join("d".repeat(60)).join("e".repeat(60));
    std::fs::create_dir_all(&deep).unwrap();
    assert!(!sock::fits(&deep.join("ptyd-test.sock")));
    let h = Helper::start_in(deep.clone(), &[]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("t", &["/bin/sh", "-c", "printf long; exec sleep 30"], &base_env(), None, "a");
    let (_, got) = c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"long"));
    assert_eq!(got, b"long");
    assert!(deep.join("ptyd-test.sock").exists());
    drop(c);
    drop(h);
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn retire_hands_the_primary_socket_over_and_exits_after_the_last_terminal() {
    let mut h = Helper::start("retire", &[]);
    let mut c = h.connect();
    let (handle, _) = c.spawn("old", &["/bin/sh", "-c", "printf ready; read x; exit 0"], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    c.send(Frame::bare(Msg::Retire { sock: "ptyd-test-old.sock".into() }));
    let deadline = Instant::now() + Duration::from_secs(3);
    while h.dir.join(&h.sock).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!h.dir.join(&h.sock).exists(), "the primary name is free for a newer helper");
    let mut again = Conn::new(sock::connect(&h.dir, "ptyd-test-old.sock").unwrap());
    again.hello(None);
    assert!(again.list().iter().any(|r| r.id == "old" && r.alive), "the old terminal is still reachable");
    // Its last terminal ends (on its own, so a tombstone, which a retiring
    // helper doesn't stay for): it goes.
    again.input(handle, b"\n", false);
    let child = h.child.as_mut().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "a retiring helper exits after its last terminal");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!h.dir.join("ptyd-test-old.sock").exists());
}

#[test]
fn a_running_helper_survives_its_bundle_being_exchanged_under_it() {
    // `redline-activate install` exchanges the whole bundle directory
    // atomically. A running helper keeps its old vnode: it must keep serving,
    // and its shells keep running.
    let root = scratch("exchange");
    let installed = root.join("Redline.app/Contents/MacOS");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::copy(HELPER, installed.join("redline-ptyd")).unwrap();
    let dir = root.join("data");
    let args = ["--dir".to_string(), dir.display().to_string(), "--sock".into(), "x.sock".into(), "--peer-dir".into(), my_dir().display().to_string()];
    sock::spawn_helper(&installed.join("redline-ptyd"), &args).unwrap();
    let mut c = Conn::new(sock::connect(&dir, "x.sock").unwrap());
    let (_, helper_pid, instance) = c.hello(None);
    let (handle, shell) = c.spawn("t", &["/bin/sh", "-c", "printf ready; exec cat"], &base_env(), None, "a");
    c.collect(handle, "a", true, Duration::from_secs(5), |b| b.ends_with(b"ready"));
    drop(c);
    // The exchange: the old bundle moves aside and a new one takes its name.
    std::fs::rename(root.join("Redline.app"), root.join("Redline-old.app")).unwrap();
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("redline-ptyd"), b"#!/bin/sh\nexit 1\n").unwrap();
    std::fs::remove_dir_all(root.join("Redline-old.app")).unwrap();
    let mut c = Conn::new(sock::connect(&dir, "x.sock").unwrap());
    let (_, pid_after, instance_after) = c.hello(None);
    assert_eq!((pid_after, instance_after), (helper_pid, instance), "the same helper, still serving");
    assert!(c.list().iter().any(|r| r.id == "t" && r.alive && r.pid == shell));
    c.input(handle, b"after", false);
    c.send(Frame::new(handle, Msg::Attach { attachment: "b".into() }));
    let (_, got) = c.collect(handle, "b", true, Duration::from_secs(5), |b| b.ends_with(b"after"));
    assert!(got.ends_with(b"after"));
    c.send(Frame::bare(Msg::KillWhere { all: true }));
    drop(c);
    unsafe { libc::kill(helper_pid as i32, libc::SIGKILL) };
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(helper_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&root);
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! A throwaway driver for the helper's measurements (PTY helper plan, P0 §4):
//! echo latency and firehose throughput through the helper against a PTY
//! read in-process, and a parked fleet for the idle measurement.
//!
//! cargo run --example probe -p redline-ptyd -- echo
//! cargo run --example probe -p redline-ptyd -- firehose
//! cargo run --example probe -p redline-ptyd -- park <dir> <shells>   # prints the helper pid, leaves it running
//! cargo run --example probe -p redline-ptyd -- stop <dir>            # kills its shells and the helper
//!
//! `park` starts the helper the way the app does (`sock::spawn_helper`: a new
//! session, close-on-exec by default, adopted by launchd), opens `<shells>`
//! login shells through it, waits for their prompts, and disconnects, as a
//! quit does. Sample it with `scripts/perf-idle.sh --helper-only --helper PID`.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use redline_pty_proto::{self as proto, Frame, Msg};
use redline_ptyd::sock;

const SOCK: &str = "ptyd-probe.sock";

fn helper_exe() -> PathBuf {
    // target/debug/examples/probe → target/debug/redline-ptyd
    let me = std::env::current_exe().unwrap();
    me.parent().unwrap().parent().unwrap().join("redline-ptyd")
}

struct Conn {
    s: UnixStream,
    dec: proto::Decoder,
}

impl Conn {
    fn open(dir: &Path) -> Self {
        let s = sock::connect(dir, SOCK).expect("connect");
        let mut c = Self { s, dec: proto::Decoder::new() };
        c.send(Frame::bare(Msg::Hello { core: proto::CORE, caps: vec![], build: "probe".into(), token: Some("probe-token".into()), nonce: 1 }));
        match c.recv().msg {
            Msg::Welcome { .. } => c,
            m => panic!("{m:?}"),
        }
    }
    fn send(&mut self, f: Frame) {
        self.s.write_all(&proto::to_bytes(&f).unwrap()).unwrap();
    }
    fn recv(&mut self) -> Frame {
        let mut buf = [0u8; 65536];
        loop {
            if let Some(f) = self.dec.next_frame().unwrap() {
                return f;
            }
            let n = self.s.read(&mut buf).unwrap();
            assert!(n > 0, "helper closed");
            self.dec.feed(&buf[..n]);
        }
    }
    fn spawn(&mut self, id: &str, argv: &[String], env: Vec<String>) -> u32 {
        self.send(Frame::bare(Msg::Spawn { seq: 1, id: id.into(), cwd: std::env::var("HOME").ok(), cols: 120, rows: 40, argv: argv.to_vec(), env, persist: true, meta: vec![], attachment: "p".into() }));
        loop {
            let f = self.recv();
            if let Msg::Spawned { .. } = f.msg {
                return f.pty;
            }
        }
    }
}

fn start(dir: &Path) -> u32 {
    sock::private_dir(dir).unwrap();
    let args = ["--dir".to_string(), dir.display().to_string(), "--sock".into(), SOCK.into(), "--peer-dir".into(), std::env::current_exe().unwrap().parent().unwrap().display().to_string()];
    sock::spawn_helper(&helper_exe(), &args).expect("spawn helper");
    let mut c = Conn::open(dir);
    c.send(Frame::bare(Msg::List { seq: 1 }));
    let _ = c.recv();
    drop(c);
    let s = sock::connect(dir, SOCK).unwrap();
    let pid = redline_ptyd::peer::peer_pid(std::os::fd::AsRawFd::as_raw_fd(&s)).unwrap();
    pid as u32
}

fn env() -> Vec<String> {
    std::env::vars().map(|(k, v)| format!("{k}={v}")).filter(|kv| !kv.starts_with("CLAUDE")).collect()
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

/// One byte in, the same byte out, through `cat` on a raw tty.
fn echo() {
    let dir = std::env::temp_dir().join(format!("rl-probe-echo-{}", std::process::id()));
    let pid = start(&dir);
    let mut c = Conn::open(&dir);
    let h = c.spawn("echo", &["/bin/sh".into(), "-c".into(), "stty raw -echo; printf R; exec cat".into()], env());
    loop {
        let f = c.recv();
        if let Msg::Output { bytes } | Msg::Replay { bytes, .. } = f.msg {
            if bytes.ends_with(b"R") {
                break;
            }
        }
    }
    let mut helper = Vec::new();
    for i in 0..1000u32 {
        let b = [b'a' + (i % 26) as u8];
        let t = Instant::now();
        c.send(Frame::new(h, Msg::Input { seq: 0, flags: 0, gap_ms: 0, bytes: b.to_vec() }));
        loop {
            if let Msg::Output { bytes } = c.recv().msg {
                c.send(Frame::new(h, Msg::Ack { attachment: "p".into(), n: bytes.len() as u32 }));
                if bytes.ends_with(&b) {
                    break;
                }
            }
        }
        helper.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    // In-process, as `pty.rs` does it: a reader thread feeding a pending
    // buffer, and a flusher that sleeps the 8 ms coalescing window after the
    // first pending byte and then delivers.
    let mut direct = Vec::new();
    let (master, child) = direct_cat();
    let mut writer = master.try_clone().unwrap();
    let delivered = inproc_pump(master, |_| {});
    let mut got = Vec::new();
    while !got.ends_with(b"R") {
        got.extend(delivered.recv().unwrap());
    }
    for i in 0..1000u32 {
        let b = [b'a' + (i % 26) as u8];
        let t = Instant::now();
        writer.write_all(&b).unwrap();
        while !delivered.recv().unwrap().ends_with(&b) {}
        direct.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    unsafe { libc::kill(child, libc::SIGKILL) };
    c.send(Frame::bare(Msg::KillWhere { all: true }));
    drop(c);
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let _ = std::fs::remove_dir_all(&dir);
    let (h50, h99) = (pct(&mut helper.clone(), 0.5), pct(&mut helper, 0.99));
    let (d50, d99) = (pct(&mut direct.clone(), 0.5), pct(&mut direct, 0.99));
    println!("echo: helper p50 {h50:.3} ms p99 {h99:.3} ms; in-process pump p50 {d50:.3} ms p99 {d99:.3} ms; added: p50 {:.3} ms p99 {:.3} ms", h50 - d50, h99 - d99);
}

fn direct_cat() -> (std::fs::File, i32) {
    let mut m = 0;
    let mut s = 0;
    unsafe {
        assert_eq!(libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()), 0);
        let pid = libc::fork();
        if pid == 0 {
            libc::setsid();
            libc::ioctl(s, libc::TIOCSCTTY as _, 0);
            libc::dup2(s, 0);
            libc::dup2(s, 1);
            libc::dup2(s, 2);
            let sh = c"/bin/sh";
            let a1 = c"-c";
            let a2 = c"stty raw -echo; printf R; exec cat";
            let argv = [sh.as_ptr(), a1.as_ptr(), a2.as_ptr(), std::ptr::null()];
            libc::execv(sh.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
        libc::close(s);
        (std::os::fd::FromRawFd::from_raw_fd(m), pid)
    }
}

/// `yes` for three seconds, ACKing as a renderer does.
fn firehose() {
    let dir = std::env::temp_dir().join(format!("rl-probe-yes-{}", std::process::id()));
    let pid = start(&dir);
    let mut c = Conn::open(&dir);
    let h = c.spawn("yes", &["/usr/bin/yes".into()], env());
    let t = Instant::now();
    let mut n = 0usize;
    while t.elapsed() < Duration::from_secs(3) {
        if let Msg::Output { bytes } | Msg::Replay { bytes, .. } = c.recv().msg {
            n += bytes.len();
            c.send(Frame::new(h, Msg::Ack { attachment: "p".into(), n: bytes.len() as u32 }));
        }
    }
    let helper = n as f64 / t.elapsed().as_secs_f64() / 1e6;
    c.send(Frame::bare(Msg::KillWhere { all: true }));
    drop(c);
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let _ = std::fs::remove_dir_all(&dir);

    let (master, child) = direct_yes();
    let delivered = inproc_pump(master, |_| {});
    let t = Instant::now();
    let mut n = 0usize;
    while t.elapsed() < Duration::from_secs(3) {
        n += delivered.recv().unwrap().len();
    }
    let direct = n as f64 / t.elapsed().as_secs_f64() / 1e6;
    unsafe { libc::kill(child, libc::SIGKILL) };
    println!("firehose: helper {helper:.1} MB/s; in-process pump {direct:.1} MB/s (helper at {:.0}%)", 100.0 * helper / direct);
}

/// `pty.rs`'s pump in miniature: 8 KB reads gated at the 256 KB high-water
/// mark, an 8 ms coalescing flusher, and a consumer that ACKs on receipt.
fn inproc_pump(mut master: std::fs::File, _unused: impl Fn(&[u8])) -> std::sync::mpsc::Receiver<Vec<u8>> {
    use std::sync::{Arc, Condvar, Mutex};
    struct S {
        pending: Vec<u8>,
        unacked: usize,
    }
    let shared = Arc::new((Mutex::new(S { pending: Vec::new(), unacked: 0 }), Condvar::new()));
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let r = shared.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            {
                let (m, cv) = &*r;
                let mut g = m.lock().unwrap();
                while g.unacked > 256 * 1024 {
                    g = cv.wait(g).unwrap();
                }
            }
            let n = match master.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let (m, cv) = &*r;
            let mut g = m.lock().unwrap();
            g.pending.extend_from_slice(&buf[..n]);
            g.unacked += n;
            cv.notify_all();
        }
    });
    let f = shared;
    std::thread::spawn(move || loop {
        {
            let (m, cv) = &*f;
            let mut g = m.lock().unwrap();
            while g.pending.is_empty() {
                g = cv.wait(g).unwrap();
            }
        }
        std::thread::sleep(Duration::from_millis(8));
        let (m, cv) = &*f;
        let chunk = {
            let mut g = m.lock().unwrap();
            std::mem::take(&mut g.pending)
        };
        let len = chunk.len();
        if tx.send(chunk).is_err() {
            return;
        }
        // The renderer's ACK, immediate.
        let mut g = m.lock().unwrap();
        g.unacked = g.unacked.saturating_sub(len);
        cv.notify_all();
    });
    rx
}

fn direct_yes() -> (std::fs::File, i32) {
    let mut m = 0;
    let mut s = 0;
    unsafe {
        assert_eq!(libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()), 0);
        let pid = libc::fork();
        if pid == 0 {
            libc::setsid();
            libc::ioctl(s, libc::TIOCSCTTY as _, 0);
            libc::dup2(s, 1);
            let yes = c"/usr/bin/yes";
            let argv = [yes.as_ptr(), std::ptr::null()];
            libc::execv(yes.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
        libc::close(s);
        (std::os::fd::FromRawFd::from_raw_fd(m), pid)
    }
}

fn park(dir: &Path, shells: usize) {
    let pid = start(dir);
    let mut c = Conn::open(dir);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    for i in 0..shells {
        c.spawn(&format!("parked-{i}"), &[shell.clone(), "-l".into()], env());
    }
    // Let every prompt draw, ACKing like a renderer, then go away as a quit does.
    let until = Instant::now() + Duration::from_secs(4);
    c.s.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    let mut buf = [0u8; 65536];
    while Instant::now() < until {
        match c.s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => c.dec.feed(&buf[..n]),
            Err(_) => continue,
        }
        while let Some(f) = c.dec.next_frame().unwrap() {
            if let Msg::Output { bytes } | Msg::Replay { bytes, .. } = f.msg {
                c.send(Frame::new(f.pty, Msg::Ack { attachment: "p".into(), n: bytes.len() as u32 }));
            }
        }
    }
    drop(c);
    println!("{pid}");
}

fn stop(dir: &Path) {
    if let Ok(s) = sock::connect(dir, SOCK) {
        let pid = redline_ptyd::peer::peer_pid(std::os::fd::AsRawFd::as_raw_fd(&s)).unwrap_or(0);
        drop(s);
        let mut c = Conn::open(dir);
        c.send(Frame::bare(Msg::KillWhere { all: true }));
        std::thread::sleep(Duration::from_millis(500));
        drop(c);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("echo") => echo(),
        Some("firehose") => firehose(),
        Some("park") => park(Path::new(&args[1]), args[2].parse().unwrap()),
        Some("stop") => stop(Path::new(&args[1])),
        _ => eprintln!("usage: probe echo | firehose | park <dir> <shells> | stop <dir>"),
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The facade over the helper backend: the in-process module's real-PTY tests
//! (`pty_local.rs`), run again with the terminal in `redline-ptyd`, plus what
//! only the helper can do (adoption after a "relaunch", the token lease, the
//! helper dying under its terminals).
//!
//! These run the real helper binary (`target/debug/redline-ptyd`, built by
//! the same `cargo test` as a workspace default member) in a scratch
//! directory, and kill it when the test ends, passing or failing.

use super::*;
use std::path::PathBuf;
use tauri::ipc::InvokeResponseBody;

fn helper_exe() -> Option<PathBuf> {
    // target/debug/deps/redline_lib-<hash> → target/debug/redline-ptyd
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("redline-ptyd");
    path.exists().then_some(path)
}

/// A helper-backed registry in a scratch directory. Drop kills the helper
/// (and so every shell) and removes the directory, socket included.
struct Rig {
    state: PtyState,
    events: Arc<Mutex<Vec<String>>>,
    dir: PathBuf,
}

impl Rig {
    fn new(tag: &str) -> Option<Self> {
        let Some(exe) = helper_exe() else {
            eprintln!("skipped: no target/debug/redline-ptyd (cargo test builds it as a default member)");
            return None;
        };
        let dir = std::env::temp_dir().join(format!("rl-ptyfacade-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = HelperConfig {
            dir: dir.clone(),
            sock: "ptyd-test.sock".into(),
            exe,
            peer_dir: std::env::current_exe().unwrap().parent().unwrap().to_path_buf(),
        };
        Some(Self::with_cfg(cfg, dir))
    }

    fn with_cfg(cfg: HelperConfig, dir: PathBuf) -> Self {
        let state = PtyState::with_helper(cfg);
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        *lock(&state.helpers.sink) = Some(Arc::new(move |e| {
            let label = match e {
                ptyd::Event::Exit { id, expected, .. } => format!("exit {id} {expected}"),
                ptyd::Event::Mode { id } => format!("mode {id}"),
                ptyd::Event::Activity(_) => "activity".into(),
                ptyd::Event::Gone { ids } => format!("gone {}", ids.join(",")),
            };
            lock(&seen).push(label);
        }));
        Self { state, events, dir }
    }

    fn client(&self) -> Arc<Client> {
        self.state.helpers.ensure().expect("the helper starts")
    }

    fn spawn(&self, id: &str, script: &str, channel: Channel<Response>) {
        self.client()
            .spawn(id, Some("/tmp".into()), 80, 24, vec!["/bin/sh".into(), "-c".into(), script.into()], vec!["PATH=/usr/bin:/bin".into(), "TERM=xterm-256color".into()], true, br#"{"owner":"s1","title":"cat"}"#.to_vec(), Some("first"), channel)
            .expect("spawn");
    }

    fn helper_pid(&self) -> u32 {
        self.client().welcome.pid
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(c) = lock(&self.state.helpers.active).clone() {
            c.kill_where(true);
            c.flush(Duration::from_millis(200));
            // SAFETY: signalling the helper this rig started.
            unsafe { libc::kill(c.welcome.pid as i32, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn recording_channel() -> (Channel<Response>, Arc<Mutex<Vec<Vec<u8>>>>) {
    let frames = Arc::new(Mutex::new(Vec::new()));
    let recorded = frames.clone();
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Raw(bytes) = body else { panic!("PTY channels must carry raw bytes") };
        lock(&recorded).push(bytes);
        Ok(())
    });
    (channel, frames)
}

fn joined(frames: &Arc<Mutex<Vec<Vec<u8>>>>) -> Vec<u8> {
    lock(frames).concat()
}

fn wait_for(frames: &Arc<Mutex<Vec<Vec<u8>>>>, done: impl Fn(&[u8]) -> bool) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done(&joined(frames)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    joined(frames)
}

const CAT: &str = "stty raw -echo; printf ready; exec cat";

#[test]
fn a_helper_terminal_rebinds_keeps_its_pid_replays_history_and_ends_on_kill() {
    let Some(rig) = Rig::new("rebind") else { return };
    let (channel, frames) = recording_channel();
    rig.spawn("t", CAT, channel);
    assert_eq!(wait_for(&frames, |b| b.ends_with(b"ready")), b"ready");
    assert_eq!(lock(&frames)[0], b"", "the first frame is the (empty) replay");
    let before = rig.state.entries();
    assert_eq!(before.len(), 1);
    assert!(before[0].alive && before[0].kept);
    assert_eq!(before[0].cwd.as_deref(), Some("/tmp"));
    assert_eq!(before[0].meta, Some(serde_json::json!({"owner": "s1", "title": "cat"})));
    let client = rig.client();
    client.detach("t", "first");
    let (again, replayed) = recording_channel();
    client.attach("t", Some("second"), again).unwrap();
    assert_eq!(wait_for(&replayed, |b| b == b"ready"), b"ready", "one replay of the history");
    assert_eq!(rig.state.entries()[0].pid, before[0].pid, "the same shell");
    pty_write_bytes_checked(&rig.state, "t", b"after").unwrap();
    assert_eq!(wait_for(&replayed, |b| b.ends_with(b"after")), b"readyafter");
    assert!(joined(&frames).len() == 5, "the detached view got nothing more");
    assert!(rig.state.is_live("t"));
    let (third, _) = recording_channel();
    client.kill("t");
    assert!(!rig.state.is_live("t"), "a kill leaves the registry at once");
    assert!(client.attach("t", Some("dead"), third).is_err());
    assert!(pty_write_bytes_checked(&rig.state, "t", b"x").is_err());
    // The shell is gone, and an intentional kill is no `pty-exit`.
    let pid = before[0].pid.unwrap() as i32;
    let deadline = Instant::now() + Duration::from_secs(3);
    // SAFETY: signal 0 only probes.
    while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the shell ended");
    assert!(!lock(&rig.events).iter().any(|e| e.starts_with("exit t")), "{:?}", lock(&rig.events));
}

#[test]
fn a_send_through_the_helper_is_one_paste_then_return_and_stop_is_guarded() {
    let Some(rig) = Rig::new("send") else { return };
    let (channel, frames) = recording_channel();
    rig.spawn("t", CAT, channel);
    wait_for(&frames, |b| b.ends_with(b"ready"));
    let long = "x".repeat(1500);
    submit_text(&rig.state, "t", &format!("line one\r\n{long}\x1b[201~")).unwrap();
    let got = wait_for(&frames, |b| b.ends_with(b"\r"));
    let want = [b"ready\x1b[200~line one\n".as_slice(), long.as_bytes(), b"[201~\x1b[201~\r"].concat();
    assert_eq!(got, want, "paced, whole, and ended by its own marker");
    assert!(submit_text(&rig.state, "t", " \x07\n").is_err(), "nothing to send");

    assert!(!input_state(&rig.state, "t").unwrap().paste_mode);
    pty_write_bytes_checked(&rig.state, "t", b"\x1b[?2004h").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !input_state(&rig.state, "t").unwrap().paste_mode && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(input_state(&rig.state, "t").unwrap().paste_mode, "the program's switch, read off its output in the helper");
    assert!(lock(&rig.events).iter().any(|e| e == "mode t"));

    let before = wait_for(&frames, |b| b.ends_with(b"\x1b[?2004h")).len();
    assert!(interrupt(&rig.state, "t").unwrap());
    assert!(!interrupt(&rig.state, "t").unwrap(), "a second Esc this soon would open the rewind menu");
    let got = wait_for(&frames, |b| b.len() > before);
    assert_eq!(&got[before..], b"\x1b");
}

#[test]
fn the_foreground_of_a_helper_terminal_is_read_from_its_tty() {
    let Some(rig) = Rig::new("fg") else { return };
    let (channel, frames) = recording_channel();
    rig.spawn("t", CAT, channel);
    wait_for(&frames, |b| b.ends_with(b"ready"));
    let snapshot = foreground_snapshot(&rig.state);
    assert_eq!(snapshot.len(), 1);
    let (id, shell, front) = &snapshot[0];
    assert_eq!(id, "t");
    assert_eq!(front, shell, "cat replaced the shell, so it leads the foreground");
    let rows = pty_local::procs_for(&snapshot);
    assert_eq!(rows[0].fg_comm.as_deref(), Some("cat"));
    let state = input_state(&rig.state, "t").unwrap();
    assert!(!state.cli_foreground, "the shell's own pid holds the foreground");
    assert!(!state.dirty);
}

#[test]
fn a_relaunched_app_adopts_the_running_helper_its_terminals_and_its_token() {
    let Some(rig) = Rig::new("adopt") else { return };
    let (channel, frames) = recording_channel();
    rig.spawn("kept", CAT, channel);
    wait_for(&frames, |b| b.ends_with(b"ready"));
    pty_write_bytes(&rig.state, "kept", b"while-open").unwrap();
    wait_for(&frames, |b| b.ends_with(b"while-open"));
    let lease = rig.client().welcome.token.clone();
    assert_eq!(lease, crate::auth::daemon_token(), "the first app's token is the lease");

    // The "relaunch": a second registry on the same socket, as a new process
    // finds it at boot. Adopting never spawns; it connects.
    let cfg = rig.state.helpers.cfg.clone().unwrap();
    let relaunched = Rig::with_cfg(cfg, rig.dir.join("unused"));
    let token = relaunched.state.adopt_running("a-fresh-candidate");
    assert_eq!(token.as_deref(), Some(lease.as_str()), "the running helper's lease, not the candidate");
    assert!(relaunched.state.is_live("kept"));
    let rows = relaunched.state.entries();
    assert_eq!(rows[0].meta, Some(serde_json::json!({"owner": "s1", "title": "cat"})), "its place, from meta");
    let (channel, replayed) = recording_channel();
    let client = lock(&relaunched.state.helpers.active).clone().unwrap();
    client.attach("kept", Some("relaunch"), channel).unwrap();
    assert_eq!(wait_for(&replayed, |b| b.ends_with(b"while-open")), b"readywhile-open", "the replay a reload gets");
    // The adopted helper is the same process: no second one started.
    assert_eq!(client.welcome.pid, rig.helper_pid());
    // Its terminal metadata can be rewritten (a wall closed with "Keep running").
    pty_set_meta_inner(&relaunched.state, "kept", serde_json::json!({"owner": "home"}), Some(false));
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        client.refresh().unwrap();
        let row = relaunched.state.entries().into_iter().find(|r| r.id == "kept").unwrap();
        if row.meta == Some(serde_json::json!({"owner": "home"})) {
            assert!(!row.persist);
            break;
        }
        assert!(Instant::now() < deadline, "the helper stored the new meta");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The relaunched rig must not kill the helper the first rig owns.
    lock(&relaunched.state.helpers.active).take();
}

/// `pty_set_meta`'s body, without the tauri::State wrapper.
fn pty_set_meta_inner(state: &PtyState, id: &str, meta: serde_json::Value, persist: Option<bool>) {
    let client = state.helpers.client_for(id).unwrap();
    client.set_meta(id, persist.unwrap_or(true), serde_json::to_vec(&meta).unwrap()).unwrap();
}

#[test]
fn a_shell_that_exits_on_its_own_is_unexpected_and_the_helper_dying_ends_every_terminal() {
    let Some(rig) = Rig::new("crash") else { return };
    let (channel, frames) = recording_channel();
    rig.spawn("alone", "printf bye; exit 0", channel);
    wait_for(&frames, |b| b.ends_with(b"bye"));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !lock(&rig.events).iter().any(|e| e == "exit alone false") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(lock(&rig.events).iter().any(|e| e == "exit alone false"), "{:?}", lock(&rig.events));
    assert!(!rig.state.is_live("alone"));
    // Seen live, so no tombstone is left behind.
    let deadline = Instant::now() + Duration::from_secs(2);
    while rig.client().refresh().is_ok() && !rig.client().tombs().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(rig.client().tombs().is_empty());

    let (channel, frames) = recording_channel();
    rig.spawn("victim", CAT, channel);
    wait_for(&frames, |b| b.ends_with(b"ready"));
    let pid = rig.helper_pid();
    // SAFETY: the helper this rig started.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while !lock(&rig.events).iter().any(|e| e == "gone victim") && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(lock(&rig.events).iter().any(|e| e == "gone victim"), "{:?}", lock(&rig.events));
    assert!(!rig.state.is_live("victim"));
    // The next terminal starts a fresh helper.
    let (channel, frames) = recording_channel();
    rig.spawn("next", CAT, channel);
    assert_eq!(wait_for(&frames, |b| b.ends_with(b"ready")), b"ready");
    assert_ne!(rig.helper_pid(), pid);
}

#[test]
fn a_missing_terminal_is_an_error_for_checked_writes_and_soft_for_keystrokes() {
    let Some(rig) = Rig::new("missing") else { return };
    let _ = rig.client();
    assert!(pty_write_bytes(&rig.state, "nope", b"3\r").is_ok());
    let err = pty_write_bytes_checked(&rig.state, "nope", b"claude\r").unwrap_err();
    assert!(err.contains("nope") && err.contains("not running"), "{err}");
    assert!(submit_text(&rig.state, "nope", "hi").is_err());
    assert!(input_state(&rig.state, "nope").is_none());
}

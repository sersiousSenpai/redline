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
        let mut all: Vec<Arc<Client>> = lock(&self.state.helpers.active).iter().cloned().collect();
        all.extend(lock(&self.state.helpers.retiring).iter().cloned());
        for c in all {
            c.kill_where(true);
            c.flush(Duration::from_millis(200));
            // SAFETY: signalling the helper this rig started.
            unsafe { libc::kill(c.welcome.pid as i32, libc::SIGKILL) };
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// An adoption reads each helper's list off the setup thread: wait for it.
fn settle(state: &PtyState) {
    for c in state.helpers.clients() {
        assert!(c.wait_ready(Duration::from_secs(3)), "the adopted helper's list arrived");
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
    assert_eq!(token.first().map(String::as_str), Some(lease.as_str()), "the running helper's lease, not the candidate");
    settle(&relaunched.state);
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
    set_meta(&relaunched.state, "kept", Some(serde_json::json!({"owner": "home"})), Some(false)).unwrap();
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

#[test]
fn meta_written_before_the_shell_exists_waits_for_its_spawn() {
    let Some(rig) = Rig::new("pending") else { return };
    set_meta(&rig.state, "soon", Some(serde_json::json!({"owner": "plan:abc", "sessionId": "abc"})), None).unwrap();
    set_meta(&rig.state, "soon", None, Some(false)).unwrap();
    let (persist, meta) = lock(&rig.state.helpers.pending_meta).get("soon").cloned().unwrap();
    assert_eq!(persist, Some(false));
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&meta.unwrap()).unwrap(), serde_json::json!({"owner": "plan:abc", "sessionId": "abc"}));
    assert!(set_meta(&rig.state, "big", Some(serde_json::json!({"x": "y".repeat(3000)})), None).is_err(), "over 2 KB");
}

#[test]
fn a_quit_keeps_what_persists_and_stop_all_ends_everything() {
    let Some(rig) = Rig::new("quit") else { return };
    let (a, fa) = recording_channel();
    rig.spawn("keep", CAT, a);
    let (b, fb) = recording_channel();
    rig.spawn("end", CAT, b);
    wait_for(&fa, |x| x.ends_with(b"ready"));
    wait_for(&fb, |x| x.ends_with(b"ready"));
    // The close dialog's "Also after Redline quits" left unchecked.
    set_meta(&rig.state, "end", None, Some(false)).unwrap();
    rig.state.on_quit(false);
    // Another app's view of the helper after the quit: the next launch.
    let cfg = rig.state.helpers.cfg.clone().unwrap();
    let next = Rig::with_cfg(cfg.clone(), rig.dir.join("unused"));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let token = next.state.adopt_running("x");
        assert!(!token.is_empty());
        settle(&next.state);
        let live: Vec<String> = next.state.entries().into_iter().filter(|r| r.alive).map(|r| r.id).collect();
        if live == ["keep"] {
            break;
        }
        assert!(Instant::now() < deadline, "only the persisting terminal survives a quit: {live:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
    // ⌥⌘Q: everything.
    next.state.on_quit(true);
    let last = Rig::with_cfg(cfg, rig.dir.join("unused2"));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        last.state.adopt_running("x");
        settle(&last.state);
        if last.state.entries().iter().all(|r| !r.alive) {
            break;
        }
        assert!(Instant::now() < deadline, "Quit and Stop Terminals ends every one");
        std::thread::sleep(Duration::from_millis(50));
    }
    lock(&next.state.helpers.active).take();
    lock(&last.state.helpers.active).take();
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only probes.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn an_upgrade_retires_the_old_helper_which_keeps_its_terminals_and_leaves_after_the_last() {
    let Some(rig) = Rig::new("retire") else { return };
    let (a, fa) = recording_channel();
    rig.spawn("old", CAT, a);
    wait_for(&fa, |x| x.ends_with(b"ready"));
    let old = rig.client();
    let old_pid = old.welcome.pid;
    // What `ensure` does with a helper whose core or caps this build can't use.
    let fresh = rig.state.helpers.retire_and_replace(old.clone()).unwrap();
    assert_ne!(fresh.welcome.pid, old_pid, "a fresh helper at the primary socket");
    assert!(rig.state.is_live("old"), "the old terminal stays reachable");
    pty_write_bytes(&rig.state, "old", b"still").unwrap();
    assert!(wait_for(&fa, |x| x.ends_with(b"still")).ends_with(b"still"), "and typed into");
    let (b, fb) = recording_channel();
    rig.spawn("new", CAT, b);
    wait_for(&fb, |x| x.ends_with(b"ready"));
    assert!(fresh.is_live("new") && !old.is_live("new"), "new terminals go to the fresh helper");

    // A relaunch finds both: the primary and the retiring socket.
    let cfg = rig.state.helpers.cfg.clone().unwrap();
    assert_eq!(cfg.retired_socks(), vec![cfg.retired_sock(old.welcome.instance)]);
    let next = Rig::with_cfg(cfg, rig.dir.join("unused"));
    assert_eq!(next.state.adopt_running("x").len(), 2, "both leases");
    settle(&next.state);
    assert!(next.state.is_live("old") && next.state.is_live("new"));
    assert_eq!(lock(&next.state.helpers.retiring).len(), 1);
    lock(&next.state.helpers.active).take();
    lock(&next.state.helpers.retiring).clear();

    // Its last terminal ends: the retiring helper goes, and its socket.
    old.kill("old");
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(old_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!pid_alive(old_pid), "a retiring helper exits after its last terminal");
    assert!(rig.state.helpers.cfg.as_ref().unwrap().retired_socks().is_empty());
    assert!(rig.state.is_live("new"));
}

#[test]
fn an_update_that_moves_the_helpers_bundle_aside_adopts_it_and_retires_it_never_falls_back() {
    let Some(exe) = helper_exe() else { return };
    let root = std::env::temp_dir().join(format!("rl-ptyfacade-moved-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let bundle = root.join("Redline.app/Contents/MacOS");
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::copy(&exe, bundle.join("redline-ptyd")).unwrap();
    let cfg = HelperConfig {
        dir: root.join("data"),
        sock: "ptyd-test.sock".into(),
        exe: bundle.join("redline-ptyd"),
        peer_dir: std::env::current_exe().unwrap().parent().unwrap().to_path_buf(),
    };
    let rig = Rig::with_cfg(cfg.clone(), root.clone());
    let (a, fa) = recording_channel();
    rig.spawn("kept", CAT, a);
    wait_for(&fa, |x| x.ends_with(b"ready"));
    let old_pid = rig.helper_pid();
    lock(&rig.state.helpers.active).take();

    // The update: the old bundle moves aside, the new one takes its place.
    std::fs::rename(root.join("Redline.app"), root.join("Redline-old.app")).unwrap();
    std::fs::create_dir_all(&bundle).unwrap();
    std::fs::copy(&exe, bundle.join("redline-ptyd")).unwrap();
    let next = Rig::with_cfg(cfg.clone(), root.join("unused"));
    assert!(!next.state.adopt_running("x").is_empty(), "adopted, by identity");
    settle(&next.state);
    assert!(next.state.is_live("kept"), "its shell is reachable");
    assert!(lock(&next.state.helpers.active).is_none(), "an older build takes no new terminals");
    assert_eq!(lock(&next.state.helpers.retiring).len(), 1, "it retires");
    // The first new terminal starts a fresh helper from the new bundle:
    // never the in-process fallback.
    let (b, fb) = recording_channel();
    next.spawn("new", CAT, b);
    wait_for(&fb, |x| x.ends_with(b"ready"));
    assert!(!next.state.helpers.failed.load(Ordering::Acquire));
    assert_ne!(next.helper_pid(), old_pid);
    assert!(next.state.is_live("kept") && next.state.is_live("new"));
    // Then the old bundle is deleted outright: still adopted by identity.
    std::fs::remove_dir_all(root.join("Redline-old.app")).unwrap();
    let last = Rig::with_cfg(cfg, root.join("unused2"));
    assert_eq!(last.state.adopt_running("y").len(), 2);
    settle(&last.state);
    assert!(last.state.is_live("kept"));
    lock(&last.state.helpers.active).take();
    lock(&last.state.helpers.retiring).clear();
    drop(next);
    // SAFETY: the old helper this test started.
    unsafe { libc::kill(old_pid as i32, libc::SIGKILL) };
    drop(rig);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn two_terminals_opening_at_once_share_one_helper_and_lose_nothing() {
    let Some(rig) = Rig::new("race") else { return };
    let helpers = rig.state.helpers.clone();
    let threads: Vec<_> = (0..4).map(|_| { let h = helpers.clone(); std::thread::spawn(move || h.ensure().unwrap().welcome.pid) }).collect();
    let pids: Vec<u32> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(pids.windows(2).all(|w| w[0] == w[1]), "one helper, one client: {pids:?}");
    std::thread::sleep(Duration::from_millis(100));
    assert!(!lock(&rig.events).iter().any(|e| e.starts_with("gone")), "no client was dropped: {:?}", lock(&rig.events));
}

/// `failed_channel_detaches_without_stopping_the_pump`, over the helper: a
/// view whose channel fails is detached (the helper stops sending to it),
/// the shell goes on, and the next view gets everything as its replay.
#[test]
fn a_failed_channel_detaches_without_stopping_the_shell() {
    let Some(rig) = Rig::new("failed") else { return };
    let failing = Channel::new(|body| match body {
        InvokeResponseBody::Raw(bytes) if bytes.is_empty() => Ok(()),
        _ => Err(std::io::Error::other("gone").into()),
    });
    rig.spawn("t", CAT, failing);
    std::thread::sleep(Duration::from_millis(200));
    pty_write_bytes(&rig.state, "t", b"after").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(rig.state.is_live("t"), "the shell outlives its view");
    let (channel, replayed) = recording_channel();
    rig.client().attach("t", Some("reloaded"), channel).unwrap();
    assert_eq!(wait_for(&replayed, |b| b.ends_with(b"after")), b"readyafter", "all of it, as the replay");
    assert_eq!(lock(&replayed).len(), 1, "in one replay frame");
}

/// `the_screen_tail_is_the_newest_output_as_text`, over the helper.
#[test]
fn the_screen_tail_comes_from_the_helpers_ring() {
    let Some(rig) = Rig::new("tail") else { return };
    let (a, fa) = recording_channel();
    rig.spawn("live", "stty raw -echo; printf '\\033[1mWould\\033[1Cyou\\033[22m\\r\\nproceed?'; exec cat", a);
    wait_for(&fa, |b| b.ends_with(b"proceed?"));
    assert_eq!(pty_local::screen_text(&rig.client().tail("live", pty_local::SCREEN_TAIL_BYTES)), "Wouldyou\n\nproceed?");
    assert_eq!(rig.client().tail("live", 8), b"proceed?");
    // A tombstone's tail is the helper's own (tests/e2e.rs, the kill/exit/Reap case).
}

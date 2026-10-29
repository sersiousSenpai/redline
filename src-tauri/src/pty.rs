// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Embedded terminals: every `pty_*` command, over two backends.
//!
//! * **Helper** (`ptyd.rs`): the terminals live in `redline-ptyd`, a small
//!   process of their own, so a shell keeps running when Redline quits or
//!   crashes and the relaunched app reattaches with the same replay a
//!   webview reload gets.
//! * **Local** (`pty_local.rs`): the terminals live in this process, as they
//!   always did, and die with it. The fallback when the helper can't start,
//!   and the backend in the probe runtime profile and the tests.
//!
//! The commands keep every name and signature they had, so `TerminalView`,
//! `TerminalTabs`, `convo`, `term_attention` and the command list don't
//! change. Each one routes by id: a terminal a helper holds goes to that
//! helper, anything else to the local registry. New terminals go to the
//! helper when it is enabled (`redline.terminals.helper`, read once at boot).
//!
//! What stays in the app either way: the typed-text tracking (`KeyScan`,
//! it sees every keystroke), the kernel reads of cwds and process tables
//! (given the helper's pids), and `lsof` for port badges. The helper forks
//! nothing but shells.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager};

use crate::ptyd::{self, Client, HelperConfig};
use crate::pty_local::{self, KeyScan, LocalPtys};

pub use crate::pty_local::{last_pty_output_ms, InputState, TermProc};
pub(crate) use crate::pty_local::sanitize;

/// The settings row that turns the helper on (`"on"` / `"off"`), read once at
/// boot, before any spawn.
pub const HELPER_SETTING: &str = "redline.terminals.helper";
/// On since P2 (the quit menu and adoption); "off" is the escape hatch.
pub const HELPER_DEFAULT: bool = true;
/// Kept terminals outlive a quit ("Keep terminals running after Redline
/// quits"). Off: a quit ends every terminal, as it always did.
pub const KEEP_SETTING: &str = "redline.terminals.keepOnQuit";
/// The first ⌘Q with terminals running asks; "Don't ask again" turns it off.
/// A held plan review is said whatever this says.
pub const ASK_SETTING: &str = "redline.terminals.askOnQuit";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the composer tracks for a terminal the helper holds: the user's own
/// half-typed text and their last Esc, and one send at a time.
#[derive(Default)]
struct Typing {
    keys: Mutex<KeyScan>,
    submit: Mutex<()>,
}

/// The helper side of the registry.
struct Helpers {
    cfg: Option<HelperConfig>,
    enabled: bool,
    /// The helper could not be used this boot: new terminals are local.
    failed: AtomicBool,
    /// The one-line notice that terminals will close with Redline, shown in
    /// the first terminal after a failure.
    told: AtomicBool,
    /// The helper new terminals go to.
    active: Mutex<Option<Arc<Client>>>,
    /// Older helpers still holding terminals (P3's upgrade handshake).
    retiring: Mutex<Vec<Arc<Client>>>,
    sink: Mutex<Option<ptyd::Sink>>,
    typing: Mutex<HashMap<String, Arc<Typing>>>,
    /// Placement written before the terminal's shell exists (the frontend
    /// names a terminal before its view mounts): used by its spawn.
    pending_meta: Mutex<HashMap<String, (Option<bool>, Option<Vec<u8>>)>>,
    /// Held while a helper is being connected or started (`ensure`).
    ensuring: Mutex<()>,
}

impl Helpers {
    fn off() -> Self {
        Self {
            cfg: None,
            enabled: false,
            failed: AtomicBool::new(false),
            told: AtomicBool::new(false),
            active: Mutex::new(None),
            retiring: Mutex::new(Vec::new()),
            sink: Mutex::new(None),
            typing: Mutex::new(HashMap::new()),
            pending_meta: Mutex::new(HashMap::new()),
            ensuring: Mutex::new(()),
        }
    }

    fn clients(&self) -> Vec<Arc<Client>> {
        let mut all: Vec<Arc<Client>> = lock(&self.active).iter().cloned().collect();
        all.extend(lock(&self.retiring).iter().cloned());
        all.retain(|c| c.connected());
        all
    }

    /// The helper holding a live terminal with this id.
    fn client_for(&self, id: &str) -> Option<Arc<Client>> {
        self.clients().into_iter().find(|c| c.is_live(id))
    }

    /// The helper that knows this id at all (live, or a tombstone).
    fn client_knowing(&self, id: &str) -> Option<Arc<Client>> {
        self.clients().into_iter().find(|c| c.is_live(id) || c.tombs().iter().any(|t| t.id == id))
    }

    fn typing(&self, id: &str) -> Arc<Typing> {
        lock(&self.typing).entry(id.to_string()).or_default().clone()
    }

    fn wanted(&self) -> bool {
        self.enabled && self.cfg.is_some() && !self.failed.load(Ordering::Acquire)
    }

    /// The helper for a new terminal: connected, or started now (the first
    /// terminal of a boot, never `setup()`: nothing touches a shell at boot).
    fn ensure(&self) -> Result<Arc<Client>, String> {
        if let Some(c) = lock(&self.active).as_ref().filter(|c| c.connected()) {
            return Ok(c.clone());
        }
        // Single flight: two terminals opening at once must not each start
        // (or connect) a client, or the one replaced would drop and report
        // the other's live shells gone.
        let _one = lock(&self.ensuring);
        if let Some(c) = lock(&self.active).as_ref().filter(|c| c.connected()) {
            return Ok(c.clone());
        }
        let cfg = self.cfg.as_ref().ok_or("no terminal helper configured")?;
        let sink = lock(&self.sink).clone().ok_or("terminal helper events are not wired")?;
        let token = crate::auth::daemon_token();
        let client = Client::connect_or_spawn(cfg, token, sink.clone())
            .or_else(|_| Client::connect_or_spawn(cfg, token, sink))?;
        if !client.current() {
            return self.retire_and_replace(client);
        }
        self.adopt(client.clone());
        Ok(client)
    }

    /// The upgrade handshake (plan P10). A helper with another frame core, or
    /// without a cap this build needs, keeps the terminals it has: it moves
    /// to a socket of its own (`Retire`, frozen in the core), stays listed,
    /// attachable and killable, and exits after its last terminal. New
    /// terminals go to a fresh helper at the primary socket.
    fn retire_and_replace(&self, old: Arc<Client>) -> Result<Arc<Client>, String> {
        let cfg = self.cfg.as_ref().ok_or("no terminal helper configured")?;
        let sink = lock(&self.sink).clone().ok_or("terminal helper events are not wired")?;
        tracing::info!(build = %old.welcome.build, core = old.welcome.core, "retiring the running terminal helper");
        old.retire(&cfg.retired_sock(old.welcome.instance))?;
        old.flush(Duration::from_millis(500));
        crate::auth::accept_leased_token(&old.welcome.token);
        lock(&self.retiring).push(old);
        // The old helper unlinks the primary as it moves; wait for that, so
        // the fresh one never connects back to it.
        let primary = cfg.dir.join(&cfg.sock);
        let deadline = Instant::now() + Duration::from_secs(2);
        while primary.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let fresh = Client::connect_or_spawn(cfg, crate::auth::daemon_token(), sink)?;
        if !fresh.current() {
            return Err(format!("a fresh terminal helper ({}) still can't take new terminals", fresh.welcome.build));
        }
        self.adopt(fresh.clone());
        Ok(fresh)
    }

    fn adopt(&self, client: Arc<Client>) {
        if client.welcome.token != crate::auth::daemon_token() && !client.welcome.token.is_empty() {
            // A helper leased an older boot's token to its shells: their curl
            // bridges keep working.
            crate::auth::accept_leased_token(&client.welcome.token);
        }
        *lock(&self.active) = Some(client);
    }

    fn fail(&self, why: &str) {
        if !self.failed.swap(true, Ordering::AcqRel) {
            tracing::warn!(%why, "terminal helper unavailable; terminals stay in-process this boot");
            crate::db::note_friction("ptyd_unavailable", Some("terminal"), None, Some(why));
        }
    }
}

/// Registry of every terminal, local or in a helper.
#[derive(Clone)]
pub struct PtyState {
    local: LocalPtys,
    helpers: Arc<Helpers>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyState {
    /// In-process only.
    pub fn new() -> Self {
        Self { local: LocalPtys::new(), helpers: Arc::new(Helpers::off()) }
    }

    /// New terminals go to the helper `cfg` names.
    pub fn with_helper(cfg: HelperConfig) -> Self {
        let mut helpers = Helpers::off();
        helpers.cfg = Some(cfg);
        helpers.enabled = true;
        Self { local: LocalPtys::new(), helpers: Arc::new(helpers) }
    }

    /// Wire the helper's events to the app: `pty-exit`, the composer's
    /// paste mode, the keeper's activity signal. They run on a thread of
    /// their own, never the socket reader's, because a handler may ask the
    /// helper something (the composer's readiness reads the foreground) and
    /// the reader is what would answer.
    pub fn start_events(&self, app: AppHandle) {
        let (tx, rx) = std::sync::mpsc::channel::<ptyd::Event>();
        let helpers = Arc::downgrade(&self.helpers);
        std::thread::Builder::new()
            .name("ptyd-events".into())
            .spawn(move || {
                for event in rx {
                    on_event(&app, &helpers, event);
                }
            })
            .ok();
        let sink: ptyd::Sink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        *lock(&self.helpers.sink) = Some(sink);
    }

    /// At boot, before the server binds: adopt a helper that is already
    /// running (one that outlived the last launch). Never starts one, and
    /// waits at most the Hello's 200 ms per socket: the list that fills the
    /// cache is read off the setup thread (`pty_list` waits for it).
    /// Returns the tokens the adopted helpers' shells hold, the one to seed
    /// this boot's master token with first. The caller seeds it before
    /// anything mints, then accepts the rest (`auth::accept_leased_token`).
    pub fn adopt_running(&self, candidate_token: &str) -> Vec<String> {
        if !self.helpers.enabled {
            return Vec::new();
        }
        let Some(cfg) = self.helpers.cfg.as_ref() else { return Vec::new() };
        let Some(sink) = lock(&self.helpers.sink).clone() else { return Vec::new() };
        let mut primary: Option<String> = None;
        let mut others: Vec<String> = Vec::new();
        let mut adopted: Vec<Arc<Client>> = Vec::new();
        // Retiring helpers first (an upgrade left them holding older
        // terminals): listed, attachable, killable, given nothing new.
        for name in cfg.retired_socks() {
            match Client::connect(&cfg.at_sock(&name), candidate_token, sink.clone()) {
                Ok(client) => {
                    others.push(client.welcome.token.clone());
                    adopted.push(client.clone());
                    lock(&self.helpers.retiring).push(client);
                }
                Err(e) => tracing::warn!(error = %e, sock = %name, "could not reach a retiring terminal helper"),
            }
        }
        if cfg.dir.join(&cfg.sock).exists() {
            match Client::connect(cfg, candidate_token, sink) {
                Ok(client) => {
                    primary = Some(client.welcome.token.clone());
                    adopted.push(client.clone());
                    if client.current() {
                        *lock(&self.helpers.active) = Some(client);
                    } else {
                        // An older build (an update moved its bundle aside,
                        // or its frames aren't ours): its terminals are
                        // adopted, it retires now, and a fresh helper starts
                        // with the first new terminal (never here).
                        if let Err(e) = client.retire(&cfg.retired_sock(client.welcome.instance)) {
                            tracing::warn!(error = %e, "could not retire the running terminal helper");
                        }
                        lock(&self.helpers.retiring).push(client);
                    }
                }
                Err(e) => tracing::warn!(error = %e, "could not adopt the running terminal helper"),
            }
        }
        for client in adopted {
            let _ = std::thread::Builder::new().name("ptyd-adopt".into()).spawn(move || {
                if let Err(e) = client.refresh() {
                    tracing::warn!(error = %e, "could not list an adopted terminal helper's terminals");
                }
            });
        }
        primary.into_iter().chain(others).filter(|t| !t.is_empty()).collect()
    }

    /// Every live terminal a helper holds (what a launch adopted), with the
    /// unix ms of its newest output. Waits for each helper's first list (off
    /// the setup thread).
    pub fn adopted_terms(&self) -> Vec<(String, u64)> {
        let clients = self.helpers.clients();
        for c in &clients {
            c.wait_ready(Duration::from_secs(5));
        }
        clients.iter().flat_map(|c| c.terms()).filter(|t| t.alive).map(|t| (t.id, t.last_output)).collect()
    }

    /// The app is exiting. `stop_all`: every terminal ends (⌥⌘Q, or keeping
    /// them is off); otherwise only those not marked to persist. In-process
    /// terminals end with the process either way.
    pub fn on_quit(&self, stop_all: bool) {
        for client in self.helpers.clients() {
            client.kill_where(stop_all);
            client.flush(Duration::from_millis(500));
        }
    }

    /// Whether `id` names a terminal whose shell is still running.
    pub fn is_live(&self, id: &str) -> bool {
        self.local.is_live(id) || self.helpers.client_for(id).is_some()
    }
}

fn on_event(app: &AppHandle, helpers: &std::sync::Weak<Helpers>, event: ptyd::Event) {
    match event {
        ptyd::Event::Exit { id, status, expected } => {
            if let Some(h) = helpers.upgrade() {
                lock(&h.typing).remove(&id);
            }
            if !expected {
                crate::db::note_friction("pty_exit", Some("terminal"), None, Some(&format!("shell exited unexpectedly (wait status {status})")));
                let _ = app.emit("pty-exit", PtyExit { id });
            }
        }
        ptyd::Event::Mode { id } => crate::convo::input_changed(app, &id),
        ptyd::Event::Activity(ms) => pty_local::note_output_ms(ms),
        ptyd::Event::Gone { ids } => {
            if !ids.is_empty() {
                // The helper died under live terminals: each one is gone.
                crate::db::note_friction("ptyd_crash", Some("terminal"), None, Some(&format!("{} terminals ended with the helper", ids.len())));
            }
            if let Some(h) = helpers.upgrade() {
                let mut typing = lock(&h.typing);
                for id in &ids {
                    typing.remove(id);
                }
            }
            for id in ids {
                let _ = app.emit("pty-exit", PtyExit { id });
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

const FALLBACK_NOTE: &[u8] = b"\x1b[2m(Terminals will close with Redline this time.)\x1b[0m\r\n";

/// The environment a shell gets: the app's own, plus its terminal's id and
/// the daemon token, as the in-process spawn builds it (portable-pty starts
/// from the parent's environment too).
fn shell_env(id: &str) -> Vec<String> {
    let mut env: Vec<String> = std::env::vars_os()
        .filter_map(|(k, v)| Some(format!("{}={}", k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|kv| {
            let key = kv.split('=').next().unwrap_or_default();
            ![("TERM"), crate::auth::ENV_DAEMON_TOKEN, crate::term_attention::ENV_TERMINAL_ID].contains(&key)
        })
        .collect();
    env.push("TERM=xterm-256color".into());
    env.push(format!("{}={}", crate::auth::ENV_DAEMON_TOKEN, crate::auth::daemon_token()));
    env.push(format!("{}={}", crate::term_attention::ENV_TERMINAL_ID, id));
    env
}

// Spawn/kill/resize/cwd run on the blocking pool by name (`OFF_MAIN_COMMANDS`
// in lib.rs), off the main IPC thread. `pty_write`/`pty_ack` stay sync on
// purpose: main-thread invocation order is what guarantees keystroke byte
// order, and with the helper they only enqueue. The JS side (`enqueuePtyOp`)
// fences spawn/kill/resize per id.
#[tauri::command]
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
    // Spawn is idempotent and rebinds: a live terminal anywhere is attached.
    if let Some(client) = state.helpers.client_for(&id) {
        return client.attach(&id, attachment_id.as_deref(), on_output);
    }
    if state.local.is_live(&id) || !state.helpers.wanted() {
        let note = state.helpers.failed.load(Ordering::Acquire) && !state.helpers.told.swap(true, Ordering::AcqRel);
        pty_local::pty_spawn(app, &state.local, id.clone(), cwd, cols, rows, on_output, attachment_id)?;
        if note {
            pty_local::note(&state.local, &id, FALLBACK_NOTE);
        }
        return Ok(());
    }
    let client = match state.helpers.ensure() {
        Ok(c) => c,
        Err(why) => {
            state.helpers.fail(&why);
            state.helpers.told.store(true, Ordering::Release);
            pty_local::pty_spawn(app, &state.local, id.clone(), cwd, cols, rows, on_output, attachment_id)?;
            pty_local::note(&state.local, &id, FALLBACK_NOTE);
            return Ok(());
        }
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // An explicit cwd wins; otherwise $HOME, so a terminal never inherits
    // wherever the app happened to be launched from.
    let start_dir = cwd.filter(|d| !d.is_empty()).or_else(|| std::env::var("HOME").ok()).filter(|d| !d.is_empty());
    let (persist, meta) = lock(&state.helpers.pending_meta).remove(&id).unwrap_or_default();
    let persist = persist.unwrap_or(true);
    client
        .spawn(&id, start_dir, cols.max(1), rows.max(1), vec![shell.clone(), "-l".into()], shell_env(&id), persist, meta.unwrap_or_default(), attachment_id.as_deref(), on_output)
        .map_err(|e| {
            crate::db::note_friction("pty_spawn_failed", Some("terminal"), None, Some(&format!("{shell}: {e}")));
            e
        })
}

fn setting_on(app: &AppHandle, key: &str, default: bool) -> bool {
    app.try_state::<crate::Settings>()
        .and_then(|s| s.db.get_setting(key))
        .map(|v| v == "on")
        .unwrap_or(default)
}

/// Whether a quit keeps the terminals marked to persist (the setting).
pub fn keep_on_quit(app: &AppHandle) -> bool {
    setting_on(app, KEEP_SETTING, true)
}

/// Settings ▸ Terminal: what the helper does for this app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    /// Terminals live in the helper (takes effect at the next launch).
    helper: bool,
    /// The helper is actually in use this launch.
    helper_active: bool,
    keep_on_quit: bool,
    ask_on_quit: bool,
}

#[tauri::command]
pub fn terminal_settings(app: AppHandle, state: tauri::State<'_, PtyState>) -> TerminalSettings {
    TerminalSettings {
        helper: setting_on(&app, HELPER_SETTING, HELPER_DEFAULT),
        helper_active: state.helpers.wanted(),
        keep_on_quit: keep_on_quit(&app),
        ask_on_quit: setting_on(&app, ASK_SETTING, true),
    }
}

/// `key` is one of `helper`, `keepOnQuit`, `askOnQuit`: an allowlist, so this
/// is never a general settings write.
#[tauri::command]
pub fn set_terminal_setting(app: AppHandle, key: String, on: bool) -> Result<(), String> {
    let row = match key.as_str() {
        "helper" => HELPER_SETTING,
        "keepOnQuit" => KEEP_SETTING,
        "askOnQuit" => ASK_SETTING,
        _ => return Err(format!("unknown terminal setting: {key}")),
    };
    let settings = app.try_state::<crate::Settings>().ok_or("settings are not loaded")?;
    settings.db.set_setting(row, if on { "on" } else { "off" }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_write(app: AppHandle, state: tauri::State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let Some(client) = state.helpers.client_for(&id) else {
        return pty_local::pty_write(app, &state.local, id, data);
    };
    client.write(&id, data.as_bytes())?;
    // These are the user's keystrokes (xterm's onData): what they leave
    // half-typed in the TUI is what a composer send would append to.
    let typing = state.helpers.typing(&id);
    let flipped = lock(&typing.keys).feed(data.as_bytes(), Instant::now());
    if flipped {
        crate::convo::input_changed(&app, &id);
    }
    Ok(())
}

/// Internal write helper, callable from Rust (the menu-skip keystroke after a
/// held POST is released). A missing terminal is a soft success.
pub fn pty_write_bytes(state: &PtyState, id: &str, bytes: &[u8]) -> Result<(), String> {
    match state.helpers.client_for(id) {
        Some(client) => client.write(id, bytes),
        None => pty_local::pty_write_bytes(&state.local, id, bytes),
    }
}

/// The verified twin of `pty_write`: an unregistered id is an error. Every
/// programmatic injection goes through here, paced (`PTY_CHUNK`). With the
/// helper the pacing happens in the helper, where the write happens.
#[tauri::command(async)]
pub async fn pty_write_checked(state: tauri::State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let Some(client) = state.helpers.client_for(&id) else {
        return pty_local::pty_write_checked(&state.local, id, data).await;
    };
    tauri::async_runtime::spawn_blocking(move || client.write_checked(&id, data.as_bytes(), true, Duration::ZERO))
        .await
        .map_err(|e| e.to_string())?
}

/// Short Rust injections (a menu-skip keystroke): one write, an error when
/// the terminal does not exist.
#[allow(dead_code)] // the Rust-callable API; the tests use it
pub fn pty_write_bytes_checked(state: &PtyState, id: &str, bytes: &[u8]) -> Result<(), String> {
    debug_assert!(bytes.len() <= pty_local::PTY_CHUNK, "unpaced write of {} bytes will be truncated by the tty input queue", bytes.len());
    match state.helpers.client_for(id) {
        Some(client) => client.write(id, bytes),
        None => pty_local::pty_write_bytes_checked(&state.local, id, bytes),
    }
}

// --- the conversation composer ---------------------------------------------------

pub fn input_state(state: &PtyState, id: &str) -> Option<InputState> {
    let Some(client) = state.helpers.client_for(id) else {
        return pty_local::input_state(&state.local, id);
    };
    let info = client.info(id).filter(|t| t.alive)?;
    let foreground = client.foregrounds().remove(id).flatten();
    let dirty = lock(&state.helpers.typing(id).keys).count > 0;
    Some(InputState {
        paste_mode: info.paste,
        dirty,
        cli_foreground: match (foreground, info.pid) {
            (Some(front), Some(shell)) => front != shell,
            _ => true,
        },
    })
}

/// The CLI took a prompt: whatever was typed is gone from its box.
pub fn clear_typed(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<PtyState>() else { return };
    if state.helpers.client_for(id).is_some() {
        lock(&state.helpers.typing(id).keys).count = 0;
    } else {
        pty_local::clear_typed(&state.local, id);
    }
}

/// Paste `text` into the terminal and press Return, paced like every
/// programmatic write. Callers check readiness; this only serialises sends
/// per terminal. Blocks for the length of the write, so it runs off the main
/// thread. With the helper the Return carries its settle as a gap, measured
/// from the paste's last byte where the bytes are written.
pub fn submit_text(state: &PtyState, id: &str, text: &str) -> Result<(), String> {
    let Some(client) = state.helpers.client_for(id) else {
        return pty_local::submit_text(&state.local, id, text);
    };
    let typing = state.helpers.typing(id);
    let _turn = lock(&typing.submit);
    let text = sanitize(text);
    if text.trim().is_empty() {
        return Err("nothing to send".into());
    }
    client.write_paced(id, &pty_local::bracketed(&text))?;
    client.write_checked(id, b"\r", false, pty_local::SUBMIT_SETTLE)?;
    lock(&typing.keys).count = 0;
    Ok(())
}

/// Return on its own: confirms the dialog `/effort` opens.
pub fn press_return(state: &PtyState, id: &str) -> Result<(), String> {
    match state.helpers.client_for(id) {
        Some(client) => client.write(id, b"\r"),
        None => pty_local::press_return(&state.local, id),
    }
}

/// The composer's send: refused with the blocker while the CLI can't take it
/// (`convo` readiness), else pasted and submitted. On the blocking pool
/// (`OFF_MAIN_COMMANDS`): a long send is paced.
#[tauri::command]
pub fn pty_submit(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    terminal_id: String,
    text: String,
) -> Result<crate::convo::SubmitResult, String> {
    if let Some(blocker) = crate::convo::composer_blocker(&app, &terminal_id) {
        return Ok(crate::convo::SubmitResult::Blocked { blocker });
    }
    submit_text(&state, &terminal_id, &text)?;
    crate::convo::input_changed(&app, &terminal_id);
    Ok(crate::convo::SubmitResult::Sent)
}

/// Stop: one Esc, dropped if another reached this terminal within
/// `DOUBLE_ESC_GUARD` (typed or sent), so Stop never opens the rewind menu.
#[tauri::command]
pub fn pty_interrupt(state: tauri::State<'_, PtyState>, terminal_id: String) -> Result<(), String> {
    interrupt(&state, &terminal_id).map(|_| ())
}

fn interrupt(state: &PtyState, id: &str) -> Result<bool, String> {
    let Some(client) = state.helpers.client_for(id) else {
        return pty_local::interrupt(&state.local, id);
    };
    let typing = state.helpers.typing(id);
    {
        let mut keys = lock(&typing.keys);
        if keys.esc_at.is_some_and(|at| at.elapsed() < pty_local::DOUBLE_ESC_GUARD) {
            return Ok(false);
        }
        keys.esc_at = Some(Instant::now());
    }
    client.write(id, b"\x1b").map(|_| true)
}

// --- the registry ----------------------------------------------------------------

/// A terminal as the frontend sees it. `meta` is what the app stored with
/// `pty_set_meta` (the owner, title and session a relaunched app rebuilds a
/// terminal's place from); `exit` marks a tombstone, a shell that exited
/// while nobody watched.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    id: String,
    cwd: Option<String>,
    pid: Option<u32>,
    alive: bool,
    /// Held by the helper: it outlives the app.
    kept: bool,
    persist: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<i32>,
}

impl PtyInfo {
    fn from_helper(t: &ptyd::TermInfo) -> Self {
        Self {
            id: t.id.clone(),
            cwd: t.cwd.clone(),
            pid: t.pid,
            alive: t.alive,
            kept: true,
            persist: t.persist,
            meta: (!t.meta.is_empty()).then(|| serde_json::from_slice(&t.meta).ok()).flatten(),
            started_at: (t.started_at > 0).then_some(t.started_at),
            exit: t.exit,
        }
    }
}

impl PtyState {
    fn entries(&self) -> Vec<PtyInfo> {
        let mut rows: Vec<PtyInfo> = self
            .local
            .entries()
            .into_iter()
            .map(|e| PtyInfo { id: e.id, cwd: e.cwd, pid: e.pid, alive: e.alive, kept: false, persist: false, meta: None, started_at: None, exit: None })
            .collect();
        for client in self.helpers.clients() {
            // A boot's first list is read off the setup thread: answer after it.
            client.wait_ready(Duration::from_secs(3));
            rows.extend(client.terms().iter().map(PtyInfo::from_helper));
            rows.extend(client.tombs().iter().map(PtyInfo::from_helper));
        }
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        rows
    }
}

#[tauri::command]
pub fn pty_list(state: tauri::State<'_, PtyState>) -> Vec<PtyInfo> {
    state.entries()
}

/// Rebind an existing shell without forking it: one replay frame, then live
/// bytes, each retained byte exactly once.
#[tauri::command]
pub fn pty_attach(state: tauri::State<'_, PtyState>, id: String, on_output: Channel<Response>, attachment_id: String) -> Result<(), String> {
    match state.helpers.client_for(&id) {
        Some(client) => client.attach(&id, Some(&attachment_id), on_output),
        None => pty_local::pty_attach(&state.local, id, on_output, attachment_id),
    }
}

/// Unmount releases only this subscriber; an earlier mount's cleanup cannot
/// detach the successor.
#[tauri::command]
pub fn pty_detach(state: tauri::State<'_, PtyState>, id: String, attachment_id: String) {
    match state.helpers.client_knowing(&id) {
        Some(client) => client.detach(&id, &attachment_id),
        None => pty_local::pty_detach(&state.local, id, attachment_id),
    }
}

/// A terminal's newest output with its escapes stripped (`pty_local`'s
/// `screen_text`): what the CLI last drew. One round trip to the helper.
#[tauri::command]
pub fn pty_screen_tail(state: tauri::State<'_, PtyState>, id: String) -> String {
    match state.helpers.client_knowing(&id) {
        Some(client) => pty_local::screen_text(&client.tail(&id, pty_local::SCREEN_TAIL_BYTES)),
        None => pty_local::pty_screen_tail(&state.local, id),
    }
}

/// Registry membership: the handoff's spawn probe.
#[tauri::command]
pub fn pty_is_live(state: tauri::State<'_, PtyState>, id: String) -> bool {
    state.is_live(&id)
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    match state.helpers.client_for(&id) {
        Some(client) => client.resize(&id, cols.max(1), rows.max(1)),
        None => pty_local::pty_resize(&state.local, id, cols, rows),
    }
}

/// Frontend ACK: `n` bytes reached xterm, release that much credit. Trivial,
/// so it stays a sync command; a missing id is a soft no-op.
#[tauri::command]
pub fn pty_ack(state: tauri::State<'_, PtyState>, id: String, n: usize, attachment_id: Option<String>) {
    match state.helpers.client_for(&id) {
        Some(client) => client.ack(&id, n, attachment_id.as_deref()),
        None => pty_local::pty_ack(&state.local, id, n, attachment_id),
    }
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    lock(&state.helpers.pending_meta).remove(&id);
    if let Some(client) = state.helpers.client_for(&id) {
        client.kill(&id);
        lock(&state.helpers.typing).remove(&id);
        return Ok(());
    }
    pty_local::pty_kill(&state.local, id)
}

#[tauri::command]
pub fn pty_kill_all(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    for client in state.helpers.clients() {
        client.kill_where(true);
    }
    lock(&state.helpers.typing).clear();
    pty_local::pty_kill_all(&state.local)
}

/// Store what a relaunched app needs to put a kept terminal back where it
/// was (`{owner, title, sessionId, harness}`, at most 2 KB), and whether it
/// outlives a quit (`persist`; the close dialog's "Also after Redline
/// quits"). Either may be left out to keep what is there. A terminal whose
/// shell doesn't exist yet gets it at its spawn. In-process terminals end
/// with the app: nothing to store.
#[tauri::command]
pub fn pty_set_meta(state: tauri::State<'_, PtyState>, id: String, meta: Option<serde_json::Value>, persist: Option<bool>) -> Result<(), String> {
    set_meta(&state, &id, meta, persist)
}

fn set_meta(state: &PtyState, id: &str, meta: Option<serde_json::Value>, persist: Option<bool>) -> Result<(), String> {
    let bytes = meta.map(|m| serde_json::to_vec(&m)).transpose().map_err(|e| e.to_string())?;
    if bytes.as_ref().is_some_and(|b| b.len() > redline_pty_proto::MAX_META) {
        return Err(format!("terminal metadata is over {} bytes", redline_pty_proto::MAX_META));
    }
    let Some(client) = state.helpers.client_for(id) else {
        if state.helpers.wanted() && !state.local.is_live(id) {
            let mut pending = lock(&state.helpers.pending_meta);
            let entry = pending.entry(id.to_string()).or_default();
            if persist.is_some() {
                entry.0 = persist;
            }
            if bytes.is_some() {
                entry.1 = bytes;
            }
        }
        return Ok(());
    };
    let info = client.info(id);
    let persist = persist.or_else(|| info.as_ref().map(|t| t.persist)).unwrap_or(true);
    let meta = bytes.or_else(|| info.map(|t| t.meta)).unwrap_or_default();
    client.set_meta(id, persist, meta)
}

/// Forget a tombstone (the sidebar's Dismiss).
#[tauri::command]
pub fn pty_reap(state: tauri::State<'_, PtyState>, id: String) {
    if let Some(client) = state.helpers.client_knowing(&id) {
        client.reap(&id);
    }
}

// --- process reads (the app's, from the kernel, given the helper's pids) ---------

fn helper_pid(state: &PtyState, id: &str) -> Option<u32> {
    state.helpers.client_for(id).and_then(|c| c.info(id)).and_then(|t| t.pid)
}

/// The shell's live working directory, from the kernel. `None` when unknown.
#[tauri::command]
pub fn pty_cwd(state: tauri::State<'_, PtyState>, id: String) -> Option<String> {
    match helper_pid(&state, &id) {
        Some(pid) => pty_local::libproc::cwd(pid),
        None => pty_local::pty_cwd(&state.local, id),
    }
}

/// Batched twin of `pty_cwd`; ids with no answer are absent.
#[tauri::command]
pub fn pty_cwds(state: tauri::State<'_, PtyState>, ids: Vec<String>) -> HashMap<String, String> {
    let (helper, local): (Vec<String>, Vec<String>) = ids.into_iter().partition(|id| helper_pid(&state, id).is_some());
    let mut out = pty_local::pty_cwds(&state.local, local);
    for id in helper {
        if let Some(cwd) = helper_pid(&state, &id).and_then(pty_local::libproc::cwd) {
            out.insert(id, cwd);
        }
    }
    out
}

/// One row per live terminal, for the tile wall's badges: one `lsof` for the
/// fleet, the process table from the kernel (`pty_local::procs_for`).
#[tauri::command]
pub fn pty_procs(state: tauri::State<'_, PtyState>) -> Vec<TermProc> {
    pty_local::procs_for(&foreground_snapshot(&state))
}

/// `(id, shell pid, foreground process group)` for every live terminal: the
/// local registry's ttys, and one `Fg` round trip per helper.
pub(crate) fn foreground_snapshot(state: &PtyState) -> Vec<(String, Option<u32>, Option<u32>)> {
    let mut rows = pty_local::foreground_snapshot(&state.local);
    for client in state.helpers.clients() {
        let mut fg = client.foregrounds();
        rows.extend(client.terms().into_iter().filter(|t| t.alive).map(|t| {
            let front = fg.remove(&t.id).flatten();
            (t.id, t.pid, front)
        }));
    }
    rows
}

/// `(client_pid, terminal_id)` for the process holding the hook connection
/// from `peer_port`, over the shells of both backends.
pub fn client_pid_and_terminal_for_port(state: &PtyState, peer_port: u16) -> (Option<u32>, Option<String>) {
    let mut shells = pty_local::shell_pid_to_terminal(&state.local);
    for client in state.helpers.clients() {
        shells.extend(client.terms().into_iter().filter_map(|t| t.pid.map(|pid| (pid, t.id))));
    }
    pty_local::client_pid_for_port(peer_port, &shells)
}

#[cfg(test)]
#[path = "pty_helper_tests.rs"]
mod helper_tests;

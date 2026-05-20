// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Embedded terminals backed by real PTYs (via `portable-pty`).
//!
//! A keyed registry of PTYs — one per terminal tab, addressed by a string `id`
//! the frontend generates. Output bytes are base64-framed and pushed to the
//! frontend as `pty-output` events (`{ id, data }`); `pty-exit` (`{ id }`) fires
//! when a shell ends. This gives co-presence — the user runs `claude` here,
//! beside the review surface, instead of in a separate terminal window.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Child shell pid — used to read its live working directory so a new
    /// terminal can open wherever this one has `cd`'d to.
    pid: Option<u32>,
}

/// Registry of live PTYs keyed by the frontend-assigned terminal id.
#[derive(Clone, Default)]
pub struct PtyState(Arc<Mutex<HashMap<String, PtySession>>>);

impl PtyState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String, // base64
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
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

    guard.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            killer,
            pid,
        },
    );
    drop(guard);

    // Reader pump: PTY bytes → base64 → `pty-output` tagged with this id.
    let app_for_reader = app.clone();
    let id_for_reader = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = b64().encode(&buf[..n]);
                    let payload = PtyOutput {
                        id: id_for_reader.clone(),
                        data: encoded,
                    };
                    if app_for_reader.emit("pty-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_reader.emit(
            "pty-exit",
            PtyExit {
                id: id_for_reader.clone(),
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

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let session = guard.get_mut(&id).ok_or("no terminal running")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("pty write failed: {e}"))?;
    session.writer.flush().ok();
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let session = guard.get(&id).ok_or("no terminal running")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

/// The live working directory of a terminal's shell — so "open a terminal
/// here" can follow wherever the user `cd`'d. macOS/Linux: ask `lsof` for the
/// shell pid's `cwd` fd. Returns `None` if it can't be determined.
#[tauri::command]
pub fn pty_cwd(state: tauri::State<'_, PtyState>, id: String) -> Option<String> {
    let pid = {
        let guard = state.0.lock().unwrap();
        guard.get(&id)?.pid?
    };
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|p| p.to_string()))
        .filter(|p| !p.is_empty())
}

#[tauri::command]
pub fn pty_kill_all(state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    for (_, mut session) in guard.drain() {
        let _ = session.killer.kill();
    }
    Ok(())
}

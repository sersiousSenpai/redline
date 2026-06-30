// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Text-to-speech for the voice agent's **better-than-`speechSynthesis`** voices.
//! The engine choice and any per-provider API key live in `app_settings` (local
//! SQLite, per user), edited through the Voice Settings panel. `tts_synth` turns
//! one chunk of text into audio (base64 WAV) for the frontend to play through the
//! Web Audio API; the same `tts_synth` command serves every server-side engine,
//! so the frontend driver is identical whether the audio came from the cloud or
//! a local model.
//!
//! Two engines beyond the pure-frontend `system` (`speechSynthesis`):
//!   - **`openai`** — cloud `gpt-4o-mini-tts`, called from Rust (no browser CORS,
//!     and the key never enters the webview). Premium, opt-in by user key.
//!   - **`kokoro`** — Kokoro-82M neural TTS running **locally and free, no key**,
//!     via a process-isolated Python sidecar (see `resources/kokoro_sidecar.py`).
//!     The sidecar is kept warm so each sentence is ~sub-second. Kokoro's
//!     phonemizer is GPL, so it lives in a SEPARATE PROCESS and never links into
//!     Redline's Apache-2.0 binary — we only exchange text and audio bytes over a
//!     pipe. The ~88 MB int8 model is downloaded on first use into the app data
//!     dir. ElevenLabs / Deepgram would slot into the same `match`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::db::Database;

const SETTING_ENGINE: &str = "tts_engine";
const SETTING_OPENAI_KEY: &str = "tts_openai_key";
const SETTING_OPENAI_VOICE: &str = "tts_openai_voice";
const SETTING_KOKORO_VOICE: &str = "tts_kokoro_voice";
const SETTING_ELEVEN_KEY: &str = "tts_eleven_key";
const SETTING_ELEVEN_VOICE: &str = "tts_eleven_voice";
/// Explicit path to the Python 3 that has `kokoro-onnx`. Auto-discovered and
/// cached here when a working interpreter is found; the user can also set it.
const SETTING_PYTHON_PATH: &str = "tts_python_path";

const DEFAULT_OPENAI_VOICE: &str = "alloy";
const DEFAULT_KOKORO_VOICE: &str = "af_heart";
/// ElevenLabs stock voice "Rachel" — stock voice IDs are stable across accounts.
const DEFAULT_ELEVEN_VOICE: &str = "21m00Tcm4TlvDq8ikWAM";
/// Low-latency, good-quality model — the right balance for live conversation.
/// (`eleven_flash_v2_5` is lower latency; `eleven_multilingual_v2` higher quality.)
const ELEVEN_MODEL: &str = "eleven_turbo_v2_5";
/// Max concurrent ElevenLabs requests we issue. ElevenLabs caps concurrency per
/// plan (Free 2 / Starter 3 / Creator 5 / …) and returns 429
/// `concurrent_limit_exceeded` above it. The frontend fires every queued
/// sentence's synth at once (eager 1-ahead prefetch), so without a cap a
/// multi-sentence reply trips the limit. 2 stays within every paid tier while
/// still pipelining a clip ahead; the sequential playback model hides it.
const ELEVEN_MAX_CONCURRENCY: usize = 2;

// The Kokoro sidecar script is compiled into the binary and written to disk on
// first use — no Tauri resource-path / dev-vs-bundle ambiguity to chase.
const KOKORO_SIDECAR_PY: &str = include_str!("../resources/kokoro_sidecar.py");

// Model files (int8, ~88 MB) — downloaded on first use. From the kokoro-onnx
// project's pinned model release.
const KOKORO_MODEL_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";
const KOKORO_VOICES_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
const KOKORO_MODEL_FILE: &str = "kokoro-v1.0.int8.onnx";
const KOKORO_VOICES_FILE: &str = "voices-v1.0.bin";

/// Emit a setup-progress event roughly every megabyte, so the download bar moves
/// without flooding the IPC channel with thousands of tiny updates.
const KOKORO_PROGRESS_STEP: u64 = 1_000_000;

/// TTS state: the DB (settings/keys), a reused HTTP client, the Kokoro model
/// directory, and the warm Kokoro sidecar (lazily spawned). Cloned into managed
/// Tauri state; mirrors how `VoiceState` carries its `Arc<Database>`.
#[derive(Clone)]
pub struct TtsState {
    db: Arc<Database>,
    http: reqwest::Client,
    kokoro_dir: PathBuf,
    /// The warm Kokoro sidecar process, spawned on first local synth and kept
    /// alive across sentences. `None` until first use / after a death.
    kokoro: Arc<AsyncMutex<Option<KokoroSidecar>>>,
    /// Caps how many ElevenLabs requests we have in flight at once, so the
    /// frontend's eager per-sentence prefetch can't trip ElevenLabs' per-plan
    /// concurrency limit (429 `concurrent_limit_exceeded`).
    eleven_sem: Arc<Semaphore>,
}

impl TtsState {
    pub fn new(db: Arc<Database>, data_dir: PathBuf) -> Self {
        Self {
            db,
            http: reqwest::Client::new(),
            kokoro_dir: data_dir.join("kokoro"),
            kokoro: Arc::new(AsyncMutex::new(None)),
            eleven_sem: Arc::new(Semaphore::new(ELEVEN_MAX_CONCURRENCY)),
        }
    }

    fn model_path(&self) -> PathBuf {
        self.kokoro_dir.join(KOKORO_MODEL_FILE)
    }
    fn voices_path(&self) -> PathBuf {
        self.kokoro_dir.join(KOKORO_VOICES_FILE)
    }
    fn model_present(&self) -> bool {
        self.model_path().exists() && self.voices_path().exists()
    }
    /// Redline's PRIVATE Python virtualenv — created on first "Enable" so the
    /// user never installs Python packages or hunts for an interpreter. Kept
    /// under the Kokoro dir; the sidecar runs this interpreter.
    fn venv_dir(&self) -> PathBuf {
        self.kokoro_dir.join("venv")
    }
    fn venv_python(&self) -> PathBuf {
        self.venv_dir().join("bin").join("python3")
    }

    /// Best-effort kill of the warm Kokoro sidecar at app teardown. Runs in a
    /// sync context (`RunEvent::Exit`), so it only `try_lock`s; `kill_on_drop`
    /// (and the OS reaping children of the exiting process) is the backstop.
    pub fn kokoro_kill(&self) {
        if let Ok(mut guard) = self.kokoro.try_lock() {
            if let Some(mut sc) = guard.take() {
                let _ = sc.child.start_kill();
            }
        }
    }
}

/// The warm Kokoro sidecar: the child process plus its stdio handles. One synth
/// at a time (guarded by the `AsyncMutex` in `TtsState`); the frontend's
/// one-ahead prefetch simply queues behind the lock — fine at Kokoro's latency.
struct KokoroSidecar {
    child: tokio::process::Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
}

// --- Settings --------------------------------------------------------------

/// Voice settings surfaced to the UI. The API key itself is **never** returned —
/// only whether one is stored — so it can't leak back into the webview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettings {
    /// `"system"` (frontend `speechSynthesis`), `"openai"`, `"kokoro"`, or
    /// `"elevenlabs"`.
    engine: String,
    has_openai_key: bool,
    openai_voice: String,
    kokoro_voice: String,
    has_eleven_key: bool,
    eleven_voice: String,
    python_path: String,
}

fn read_settings(tts: &TtsState) -> TtsSettings {
    TtsSettings {
        engine: tts
            .db
            .get_setting(SETTING_ENGINE)
            .unwrap_or_else(|| "system".to_string()),
        has_openai_key: tts
            .db
            .get_setting(SETTING_OPENAI_KEY)
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false),
        openai_voice: tts
            .db
            .get_setting(SETTING_OPENAI_VOICE)
            .unwrap_or_else(|| DEFAULT_OPENAI_VOICE.to_string()),
        kokoro_voice: tts
            .db
            .get_setting(SETTING_KOKORO_VOICE)
            .unwrap_or_else(|| DEFAULT_KOKORO_VOICE.to_string()),
        has_eleven_key: tts
            .db
            .get_setting(SETTING_ELEVEN_KEY)
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false),
        eleven_voice: tts
            .db
            .get_setting(SETTING_ELEVEN_VOICE)
            .unwrap_or_else(|| DEFAULT_ELEVEN_VOICE.to_string()),
        python_path: tts.db.get_setting(SETTING_PYTHON_PATH).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn tts_get_settings(tts: tauri::State<'_, TtsState>) -> TtsSettings {
    read_settings(&tts)
}

/// Persist the engine choice and (optionally) the OpenAI key/voice and Kokoro
/// voice. Each `Option` is only written when `Some` — so saving one field doesn't
/// clobber another (notably the stored key the UI never sees); pass `Some("")` to
/// explicitly clear the key.
#[tauri::command]
pub fn tts_set_settings(
    tts: tauri::State<'_, TtsState>,
    engine: String,
    openai_key: Option<String>,
    openai_voice: Option<String>,
    kokoro_voice: Option<String>,
    eleven_key: Option<String>,
    eleven_voice: Option<String>,
    python_path: Option<String>,
) -> Result<(), String> {
    tts.db
        .set_setting(SETTING_ENGINE, &engine)
        .map_err(|e| e.to_string())?;
    if let Some(key) = openai_key {
        tts.db
            .set_setting(SETTING_OPENAI_KEY, key.trim())
            .map_err(|e| e.to_string())?;
    }
    if let Some(voice) = openai_voice {
        tts.db
            .set_setting(SETTING_OPENAI_VOICE, &voice)
            .map_err(|e| e.to_string())?;
    }
    if let Some(voice) = kokoro_voice {
        tts.db
            .set_setting(SETTING_KOKORO_VOICE, &voice)
            .map_err(|e| e.to_string())?;
    }
    if let Some(key) = eleven_key {
        tts.db
            .set_setting(SETTING_ELEVEN_KEY, key.trim())
            .map_err(|e| e.to_string())?;
    }
    if let Some(voice) = eleven_voice {
        tts.db
            .set_setting(SETTING_ELEVEN_VOICE, &voice)
            .map_err(|e| e.to_string())?;
    }
    if let Some(py) = python_path {
        tts.db
            .set_setting(SETTING_PYTHON_PATH, py.trim())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Synthesis -------------------------------------------------------------

/// Audio for one chunk of speech, base64-encoded for the IPC hop. The frontend
/// decodes it with the Web Audio API and plays it in order.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAudio {
    audio_base64: String,
    mime: String,
}

/// Synthesize one chunk of text with the configured engine. Errors if the engine
/// is `system` (handled client-side) or the chosen engine isn't ready.
#[tauri::command]
pub async fn tts_synth(
    tts: tauri::State<'_, TtsState>,
    app: AppHandle,
    text: String,
) -> Result<TtsAudio, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".to_string());
    }
    let engine = tts
        .db
        .get_setting(SETTING_ENGINE)
        .unwrap_or_else(|| "system".to_string());
    let result = match engine.as_str() {
        "openai" => synth_openai(&tts, &text).await,
        "elevenlabs" => synth_eleven(&tts, &text).await,
        "kokoro" => synth_kokoro(&tts, &app, &text).await,
        other => Err(format!(
            "the '{other}' voice engine has no server-side synthesis"
        )),
    };
    // Synth errors are swallowed into silence on the frontend (the stream must go
    // on), so log them here at `error` level (visible at the default `info`
    // filter) — this is the only place the real provider response (HTTP status +
    // body snippet for cloud engines) is captured.
    if let Err(ref e) = result {
        tracing::error!(target: "tts", engine = %engine, "synthesis failed: {e}");
    }
    result
}

async fn synth_openai(tts: &TtsState, text: &str) -> Result<TtsAudio, String> {
    let key = tts
        .db
        .get_setting(SETTING_OPENAI_KEY)
        .filter(|k| !k.trim().is_empty())
        .ok_or("no OpenAI API key set — add one in Voice Settings")?;
    let voice = tts
        .db
        .get_setting(SETTING_OPENAI_VOICE)
        .unwrap_or_else(|| DEFAULT_OPENAI_VOICE.to_string());

    // WAV (PCM) decodes reliably via Web Audio `decodeAudioData` across engines;
    // the per-sentence clips are short, so the size over MP3 is a non-issue.
    let resp = tts
        .http
        .post("https://api.openai.com/v1/audio/speech")
        .bearer_auth(key.trim())
        .json(&serde_json::json!({
            "model": "gpt-4o-mini-tts",
            "voice": voice,
            "input": text,
            "response_format": "wav",
        }))
        .send()
        .await
        .map_err(|e| format!("OpenAI TTS request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("OpenAI TTS error {status}: {snippet}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading TTS audio failed: {e}"))?;
    Ok(TtsAudio {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: "audio/wav".to_string(),
    })
}

async fn synth_eleven(tts: &TtsState, text: &str) -> Result<TtsAudio, String> {
    let key = tts
        .db
        .get_setting(SETTING_ELEVEN_KEY)
        .filter(|k| !k.trim().is_empty())
        .ok_or("no ElevenLabs API key set — add one in Voice Settings")?;
    let voice = tts
        .db
        .get_setting(SETTING_ELEVEN_VOICE)
        .unwrap_or_else(|| DEFAULT_ELEVEN_VOICE.to_string());

    // Hold a permit for the whole request so we never exceed our self-imposed
    // concurrency cap — the eager frontend prefetch fires every queued
    // sentence's synth at once, which otherwise trips ElevenLabs' 429.
    let _permit = tts
        .eleven_sem
        .acquire()
        .await
        .map_err(|e| format!("voice synth queue closed: {e}"))?;

    // ElevenLabs addresses voices by id in the URL path and authenticates via
    // the `xi-api-key` header (not bearer). The default response is MP3, which
    // Web Audio `decodeAudioData` handles fine and is smaller per sentence.
    let resp = tts
        .http
        .post(format!(
            "https://api.elevenlabs.io/v1/text-to-speech/{}",
            voice.trim()
        ))
        .header("xi-api-key", key.trim())
        .json(&serde_json::json!({
            "text": text,
            "model_id": ELEVEN_MODEL,
        }))
        .send()
        .await
        .map_err(|e| format!("ElevenLabs TTS request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        return Err(format!("ElevenLabs TTS error {status}: {snippet}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("reading TTS audio failed: {e}"))?;
    Ok(TtsAudio {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: "audio/mpeg".to_string(),
    })
}

// --- Kokoro (local) --------------------------------------------------------

async fn synth_kokoro(tts: &TtsState, app: &AppHandle, text: &str) -> Result<TtsAudio, String> {
    if !tts.model_present() {
        return Err(
            "the Kokoro voice isn't installed yet — open Voice settings (⚙) and download it"
                .to_string(),
        );
    }
    let voice = tts
        .db
        .get_setting(SETTING_KOKORO_VOICE)
        .unwrap_or_else(|| DEFAULT_KOKORO_VOICE.to_string());
    // Speed is left at 1.0 here; the frontend applies the speed slider via Web
    // Audio `playbackRate`, so it's uniform across every engine.
    let req = serde_json::json!({ "text": text, "voice": voice, "speed": 1.0 }).to_string();

    let mut guard = tts.kokoro.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_kokoro(tts).await?);
    }
    // Try once; if the pipe is broken (the sidecar died), respawn and retry once.
    let first = kokoro_roundtrip(guard.as_mut().unwrap(), &req).await;
    let b64 = match first {
        Ok(b64) => b64,
        Err(_) => {
            *guard = Some(spawn_kokoro(tts).await?);
            kokoro_roundtrip(guard.as_mut().unwrap(), &req).await?
        }
    };
    let _ = app; // reserved for a future "kokoro-speaking" event
    Ok(TtsAudio {
        audio_base64: b64,
        mime: "audio/wav".to_string(),
    })
}

/// Spawn the Python sidecar, materializing the bundled script first, and wait for
/// its `{"ready":true}` handshake (or surface the load error it reports).
async fn spawn_kokoro(tts: &TtsState) -> Result<KokoroSidecar, String> {
    tokio::fs::create_dir_all(&tts.kokoro_dir)
        .await
        .map_err(|e| format!("could not create the Kokoro directory: {e}"))?;
    let script = tts.kokoro_dir.join("kokoro_sidecar.py");
    tokio::fs::write(&script, KOKORO_SIDECAR_PY)
        .await
        .map_err(|e| format!("could not write the Kokoro sidecar: {e}"))?;

    // Resolve a Python that actually has `kokoro-onnx`. Prefer the cached/explicit
    // path; otherwise discover one (and cache it). A GUI-launched app has a bare
    // PATH, so we can't just trust `python3`.
    let python = match tts
        .db
        .get_setting(SETTING_PYTHON_PATH)
        .filter(|s| !s.trim().is_empty())
    {
        Some(p) => p,
        None => {
            let (ok, py, detail) = resolve_working_python(tts).await;
            if !ok {
                return Err(detail);
            }
            py.unwrap_or_else(|| "python3".to_string())
        }
    };
    let mut child = tokio::process::Command::new(&python)
        .arg(&script)
        .arg(tts.model_path())
        .arg(tts.voices_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "could not find Python (looked for `{python}`). Install Python 3 \
                     and run `pip install kokoro-onnx`, or set REDLINE_PYTHON."
                )
            } else {
                format!("failed to start the Kokoro sidecar: {e}")
            }
        })?;

    let stdin = child.stdin.take().ok_or("kokoro stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("kokoro stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("kokoro stderr unavailable")?;

    // Drain stderr to the log so a full pipe can't block the long-lived child.
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if !l.trim().is_empty() {
                tracing::debug!(target: "kokoro", "{l}");
            }
        }
    });

    let mut sidecar = KokoroSidecar {
        child,
        stdin,
        stdout: BufReader::new(stdout).lines(),
    };
    // Handshake — the sidecar prints exactly one of `ready`/`error` once loaded.
    let msg = read_kokoro_msg(&mut sidecar.stdout).await?;
    if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
        return Err(format!("Kokoro failed to start: {err}"));
    }
    Ok(sidecar)
}

/// Send one request line and read back the single response object.
async fn kokoro_roundtrip(sc: &mut KokoroSidecar, req_json: &str) -> Result<String, String> {
    let line = format!("{req_json}\n");
    sc.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Kokoro write failed: {e}"))?;
    sc.stdin
        .flush()
        .await
        .map_err(|e| format!("Kokoro flush failed: {e}"))?;
    let msg = read_kokoro_msg(&mut sc.stdout).await?;
    if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
        return Err(format!("Kokoro synth error: {err}"));
    }
    msg.get("audio")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Kokoro returned no audio".to_string())
}

/// Read the next protocol message, skipping any non-protocol chatter the Python
/// libraries might print to stdout (we only accept lines carrying one of our
/// keys).
async fn read_kokoro_msg(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
) -> Result<serde_json::Value, String> {
    loop {
        match lines.next_line().await {
            Ok(Some(l)) => {
                let t = l.trim();
                if t.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                    if v.get("audio").is_some()
                        || v.get("error").is_some()
                        || v.get("ready").is_some()
                    {
                        return Ok(v);
                    }
                }
                // Otherwise it's library noise on stdout — ignore and keep reading.
            }
            Ok(None) => return Err("the Kokoro sidecar closed unexpectedly".to_string()),
            Err(e) => return Err(format!("reading Kokoro output failed: {e}")),
        }
    }
}

/// Readiness of the local Kokoro engine, for the settings UI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KokoroStatus {
    /// Both model files are present on disk.
    model_present: bool,
    /// A Python that can `import kokoro_onnx` was found.
    python_ready: bool,
    /// The interpreter that worked (shown in the UI), empty if none.
    python_path: String,
    /// Human-readable guidance (what's missing / how to fix it).
    detail: String,
}

#[tauri::command]
pub async fn tts_kokoro_status(tts: tauri::State<'_, TtsState>) -> Result<KokoroStatus, String> {
    let model_present = tts.model_present();
    let (python_ready, python_path, py_detail) = resolve_working_python(&tts).await;
    let detail = if python_ready && model_present {
        "Natural voice is ready.".to_string()
    } else {
        py_detail
    };
    Ok(KokoroStatus {
        model_present,
        python_ready,
        python_path: python_path.unwrap_or_default(),
        detail,
    })
}

/// Pre-spawn the Kokoro sidecar (which loads the model during its handshake) so
/// the first real sentence doesn't pay the ~seconds of cold-start. Best-effort:
/// a no-op unless Kokoro is the engine and installed.
#[tauri::command]
pub async fn tts_kokoro_warm(tts: tauri::State<'_, TtsState>) -> Result<(), String> {
    let engine = tts.db.get_setting(SETTING_ENGINE).unwrap_or_default();
    if engine != "kokoro" || !tts.model_present() {
        return Ok(());
    }
    let mut guard = tts.kokoro.lock().await;
    if guard.is_none() {
        *guard = Some(spawn_kokoro(&tts).await?);
    }
    Ok(())
}

enum PyProbe {
    Ok,
    /// Python ran, but `import kokoro_onnx` failed (package not in that interp).
    MissingPackage,
    /// The interpreter itself couldn't be launched.
    NoPython,
}

/// Try to `import kokoro_onnx` with one interpreter.
async fn probe_python(py: &str) -> PyProbe {
    let out = tokio::process::Command::new(py)
        .arg("-c")
        .arg("import kokoro_onnx")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => PyProbe::Ok,
        Ok(_) => PyProbe::MissingPackage, // python exists, import failed
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PyProbe::NoPython,
        Err(_) => PyProbe::NoPython,
    }
}

fn push_unique(v: &mut Vec<String>, s: String) {
    let s = s.trim().to_string();
    if !s.is_empty() && !v.contains(&s) {
        v.push(s);
    }
}

/// The interpreter the user's login shell resolves `python3`/`python` to — the
/// one their `pip install` most likely used. A Finder-launched app doesn't
/// inherit this PATH, so we ask the shell explicitly.
async fn login_shell_python() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = tokio::process::Command::new(shell)
        .arg("-lc")
        .arg("command -v python3 || command -v python")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!s.is_empty()).then_some(s)
}

/// Candidate interpreters to probe, most-specific first.
async fn python_candidates(tts: &TtsState) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    // Redline's own private venv is preferred whenever it exists.
    push_unique(&mut v, tts.venv_python().to_string_lossy().to_string());
    if let Some(p) = tts.db.get_setting(SETTING_PYTHON_PATH) {
        push_unique(&mut v, p);
    }
    if let Ok(p) = std::env::var("REDLINE_PYTHON") {
        push_unique(&mut v, p);
    }
    if let Some(p) = login_shell_python().await {
        push_unique(&mut v, p);
    }
    for p in [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ] {
        push_unique(&mut v, p.to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        push_unique(&mut v, format!("{home}/.pyenv/shims/python3"));
    }
    push_unique(&mut v, "python3".to_string());
    push_unique(&mut v, "python".to_string());
    v
}

/// Find a Python that can import `kokoro_onnx`, caching the winner so synthesis
/// uses the same interpreter. Returns `(ready, path, guidance)`.
async fn resolve_working_python(tts: &TtsState) -> (bool, Option<String>, String) {
    let mut saw_python = false;
    for cand in python_candidates(tts).await {
        match probe_python(&cand).await {
            PyProbe::Ok => {
                let _ = tts.db.set_setting(SETTING_PYTHON_PATH, &cand);
                return (true, Some(cand.clone()), format!("Using {cand}"));
            }
            PyProbe::MissingPackage => saw_python = true,
            PyProbe::NoPython => {}
        }
    }
    if saw_python {
        (
            false,
            None,
            "Not set up yet — click Enable to install the voice engine (one-time)."
                .to_string(),
        )
    } else {
        (
            false,
            None,
            "Python 3 wasn't found. Install Python 3 from python.org, then click Enable."
                .to_string(),
        )
    }
}

/// Ensure the `uv` toolchain binary is present (download + unpack on first use).
/// `uv` is a single self-contained executable from Astral; we use it to fetch a
/// pinned Python and resolve the install, so Redline never depends on the user's
/// own Python (which may be a version `onnxruntime` has no wheels for).
async fn ensure_uv(tts: &TtsState, app: &AppHandle) -> Result<PathBuf, String> {
    let uv = tts.kokoro_dir.join("bin").join("uv");
    if uv.exists() {
        return Ok(uv);
    }
    let asset = match std::env::consts::ARCH {
        "aarch64" => "uv-aarch64-apple-darwin",
        "x86_64" => "uv-x86_64-apple-darwin",
        other => {
            return Err(format!(
                "the natural voice engine doesn't support this CPU architecture ({other}) yet"
            ))
        }
    };
    tokio::fs::create_dir_all(tts.kokoro_dir.join("bin"))
        .await
        .map_err(|e| format!("could not create the voice bin directory: {e}"))?;

    let url = format!("https://github.com/astral-sh/uv/releases/latest/download/{asset}.tar.gz");
    let tarball = tts.kokoro_dir.join("uv.tar.gz");
    let _ = tokio::fs::remove_file(&tarball).await;
    download_if_missing(tts, app, &url, &tarball, "uv").await?;

    // Unpack with the system `tar` (gzip built in on macOS) and lift out the
    // single `uv` binary; the tarball expands to `<asset>/uv`.
    let dl = tts.kokoro_dir.join("uv-unpack");
    let _ = tokio::fs::remove_dir_all(&dl).await;
    tokio::fs::create_dir_all(&dl)
        .await
        .map_err(|e| format!("could not create the unpack directory: {e}"))?;
    let mut t = tokio::process::Command::new("tar");
    t.arg("-xzf").arg(&tarball).arg("-C").arg(&dl);
    run_checked(t, "unpacking the voice toolchain").await?;

    let extracted = dl.join(asset).join("uv");
    tokio::fs::copy(&extracted, &uv)
        .await
        .map_err(|e| format!("installing the voice toolchain failed: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&uv) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&uv, perms);
        }
    }
    let _ = tokio::fs::remove_dir_all(&dl).await;
    let _ = tokio::fs::remove_file(&tarball).await;
    Ok(uv)
}

/// Run a command, returning the tail of stderr on failure.
async fn run_checked(mut cmd: tokio::process::Command, what: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("{what} failed to start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let mut tail: Vec<&str> = err.lines().rev().take(6).collect();
    tail.reverse();
    Err(format!("{what} failed:\n{}", tail.join("\n")))
}

/// Build Redline's private voice environment with `uv`: fetch a managed Python
/// 3.12, create a venv from it, and install `kokoro-onnx` — none of which touches
/// the user's own Python. Emits `kokoro-setup` phase events.
async fn ensure_kokoro_venv(tts: &TtsState, app: &AppHandle) -> Result<(), String> {
    let uv = ensure_uv(tts, app).await?;
    let venv_dir = tts.venv_dir();

    // Fetch a managed CPython 3.12 (uv downloads it if absent) — the version
    // onnxruntime reliably ships wheels for — then (re)build the venv from it.
    let _ = app.emit(
        "kokoro-setup",
        KokoroSetup {
            phase: "python".to_string(),
            received: 0,
            total: 0,
        },
    );
    {
        let mut c = tokio::process::Command::new(&uv);
        c.arg("python").arg("install").arg("3.12");
        run_checked(c, "downloading Python for the voice engine").await?;
    }
    let _ = tokio::fs::remove_dir_all(&venv_dir).await; // clean rebuild each Enable
    {
        let mut c = tokio::process::Command::new(&uv);
        c.arg("venv").arg(&venv_dir).arg("--python").arg("3.12");
        run_checked(c, "creating the private voice environment").await?;
    }

    let vpy = tts.venv_python();
    let _ = app.emit(
        "kokoro-setup",
        KokoroSetup {
            phase: "deps".to_string(),
            received: 0,
            total: 0,
        },
    );
    {
        // uv's resolver installs kokoro-onnx (which pulls its own bundled
        // espeak-ng wheel) into our private venv.
        let mut c = tokio::process::Command::new(&uv);
        c.arg("pip")
            .arg("install")
            .arg("--python")
            .arg(&vpy)
            .arg("kokoro-onnx");
        run_checked(c, "installing the voice engine").await?;
    }

    let _ = tts
        .db
        .set_setting(SETTING_PYTHON_PATH, &vpy.to_string_lossy());
    Ok(())
}

/// Progress for the one-time Kokoro model download.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KokoroSetup {
    /// `"model"`, `"voices"`, or `"done"`.
    phase: String,
    received: u64,
    total: u64,
}

/// Download the Kokoro model + voices into the app data dir (idempotent — skips
/// files already present). Emits `kokoro-setup` progress events.
/// One-click "Enable natural voice": set up a private Python venv with
/// `kokoro-onnx` (only if one isn't already reachable) and download the model.
/// The user installs and configures nothing.
#[tauri::command]
pub async fn tts_kokoro_install(
    tts: tauri::State<'_, TtsState>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::fs::create_dir_all(&tts.kokoro_dir)
        .await
        .map_err(|e| format!("could not create the Kokoro directory: {e}"))?;

    // 1. A Python that can import kokoro-onnx — reuse one if already reachable
    //    (e.g. the user already had it), otherwise build our own private venv.
    let (ok, _, _) = resolve_working_python(&tts).await;
    if !ok {
        ensure_kokoro_venv(&tts, &app).await?;
        let (ok2, _, _) = resolve_working_python(&tts).await;
        if !ok2 {
            return Err(
                "the voice engine didn't finish installing — please try Enable again"
                    .to_string(),
            );
        }
    }

    // 2. The model files.
    download_if_missing(&tts, &app, KOKORO_MODEL_URL, &tts.model_path(), "model").await?;
    download_if_missing(&tts, &app, KOKORO_VOICES_URL, &tts.voices_path(), "voices").await?;

    let _ = app.emit(
        "kokoro-setup",
        KokoroSetup {
            phase: "done".to_string(),
            received: 0,
            total: 0,
        },
    );
    Ok(())
}

async fn download_if_missing(
    tts: &TtsState,
    app: &AppHandle,
    url: &str,
    dest: &Path,
    phase: &str,
) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    // Download to a `.part` sibling, then atomically rename — a crash mid-download
    // never leaves a truncated file that looks complete.
    let tmp = dest.with_extension("part");
    let mut resp = tts
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("downloading the Kokoro {phase} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "downloading the Kokoro {phase} failed: HTTP {}",
            resp.status()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("creating the Kokoro {phase} file failed: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let _ = app.emit(
        "kokoro-setup",
        KokoroSetup {
            phase: phase.to_string(),
            received: 0,
            total,
        },
    );
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("downloading the Kokoro {phase} failed: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("writing the Kokoro {phase} failed: {e}"))?;
        received += chunk.len() as u64;
        if received - last_emit >= KOKORO_PROGRESS_STEP {
            last_emit = received;
            let _ = app.emit(
                "kokoro-setup",
                KokoroSetup {
                    phase: phase.to_string(),
                    received,
                    total,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("flushing the Kokoro {phase} failed: {e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("finalizing the Kokoro {phase} failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> TtsState {
        let db = Arc::new(Database::open_in_memory().unwrap());
        TtsState::new(db, std::env::temp_dir())
    }

    #[test]
    fn settings_default_to_system_engine_without_key() {
        let tts = test_state();
        let s = read_settings(&tts);
        assert_eq!(s.engine, "system");
        assert!(!s.has_openai_key);
        assert_eq!(s.openai_voice, DEFAULT_OPENAI_VOICE);
        assert_eq!(s.kokoro_voice, DEFAULT_KOKORO_VOICE);
        assert!(!s.has_eleven_key);
        assert_eq!(s.eleven_voice, DEFAULT_ELEVEN_VOICE);
    }

    #[test]
    fn key_is_stored_but_never_echoed_back() {
        let tts = test_state();
        tts.db.set_setting(SETTING_ENGINE, "openai").unwrap();
        tts.db.set_setting(SETTING_OPENAI_KEY, "sk-secret").unwrap();
        let s = read_settings(&tts);
        assert_eq!(s.engine, "openai");
        assert!(s.has_openai_key, "presence is reported");
        // The struct has no field carrying the key value at all.
    }

    #[test]
    fn eleven_key_presence_only_and_voice_round_trips() {
        let tts = test_state();
        tts.db.set_setting(SETTING_ENGINE, "elevenlabs").unwrap();
        tts.db.set_setting(SETTING_ELEVEN_KEY, "el-secret").unwrap();
        tts.db
            .set_setting(SETTING_ELEVEN_VOICE, "pNInz6obpgDQGcFmaJgB")
            .unwrap();
        let s = read_settings(&tts);
        assert_eq!(s.engine, "elevenlabs");
        assert!(s.has_eleven_key, "presence is reported, key value is not");
        assert_eq!(s.eleven_voice, "pNInz6obpgDQGcFmaJgB");
    }

    #[test]
    fn kokoro_voice_round_trips() {
        let tts = test_state();
        tts.db.set_setting(SETTING_ENGINE, "kokoro").unwrap();
        tts.db.set_setting(SETTING_KOKORO_VOICE, "am_adam").unwrap();
        let s = read_settings(&tts);
        assert_eq!(s.engine, "kokoro");
        assert_eq!(s.kokoro_voice, "am_adam");
    }

    #[test]
    fn model_absent_on_a_fresh_dir() {
        // A fresh temp-dir-based state has no downloaded model.
        let db = Arc::new(Database::open_in_memory().unwrap());
        let dir = std::env::temp_dir().join(format!("redline-kokoro-test-{}", std::process::id()));
        let tts = TtsState::new(db, dir);
        assert!(!tts.model_present());
    }
}

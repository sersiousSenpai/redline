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
//!     pipe. The ~325 MB fp32 model is downloaded on first use into the app data
//!     dir. ElevenLabs / Deepgram would slot into the same `match`.
//!
//! The premium local voice, `studio`, streams rather than answering one clip
//! per request, so it has its own commands and module (`tts_studio.rs`). It
//! shares this file's uv, Python-environment and download code, and the
//! generations `tts_cancel` cancels.
//!
//! Every request carries the frontend driver's **generation**. `cancel()` there
//! (Stop, a barge-in, the next turn) calls `tts_cancel` with the old one, and a
//! request from a cancelled generation is dropped before it reaches an engine:
//! Kokoro synthesizes one request at a time, so without this the next reply's
//! first sentence waited behind the rest of the cancelled one.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::db::Database;
use crate::tts_studio::Studio;

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
/// `concurrent_limit_exceeded` above it. The frontend keeps the sentence in
/// hand plus two read ahead in flight, so without a cap a multi-sentence reply
/// trips the limit. 2 stays within every tier while still pipelining a clip
/// ahead; the sequential playback model hides it.
const ELEVEN_MAX_CONCURRENCY: usize = 2;
/// How long one cloud synthesis may take, connect to last byte. A sentence
/// takes a few seconds at worst; a request that stalls past this is given up
/// so the system voice reads that sentence, rather than holding the reply's
/// audio until Stop and an ElevenLabs permit for as long as it stalls.
const CLOUD_TIMEOUT: Duration = Duration::from_secs(20);

// The Kokoro sidecar script is compiled into the binary and written to disk on
// first use — no Tauri resource-path / dev-vs-bundle ambiguity to chase.
const KOKORO_SIDECAR_PY: &str = include_str!("../resources/kokoro_sidecar.py");

// Model files — downloaded on first use. From the kokoro-onnx project's pinned
// model release. The fp32 model is ~3x faster than the int8 one on Apple CPUs
// (int8 ops fall back to slow kernels there) at the reference quality.
const KOKORO_MODEL_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
const KOKORO_VOICES_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
const KOKORO_MODEL_FILE: &str = "kokoro-v1.0.onnx";
const KOKORO_VOICES_FILE: &str = "voices-v1.0.bin";
/// The int8 model earlier versions downloaded. It keeps working until the fp32
/// one is downloaded and verified beside it (`ensure_current_model`), and is
/// deleted then.
const KOKORO_LEGACY_MODEL_FILE: &str = "kokoro-v1.0.int8.onnx";

/// What a download must come to before it replaces anything: the release's
/// published size, and the SHA-256 of that release asset.
#[derive(Clone, Copy)]
pub(crate) struct FileCheck {
    pub(crate) bytes: u64,
    pub(crate) sha256: &'static str,
}

/// The uv release both local voice engines build their Python with, pinned by
/// the SHA-256 Astral publishes beside each tarball. uv in turn checks the
/// CPython it downloads against the hashes built into this release.
const UV_URL: &str = "https://github.com/astral-sh/uv/releases/download/0.11.25/";
const UV_AARCH64: FileCheck = FileCheck {
    bytes: 21_911_525,
    sha256: "5fc334bb25d19806262efd1f6e7d380155c7e817d89bf426df4ba7ae873c9471",
};
const UV_X86_64: FileCheck = FileCheck {
    bytes: 23_478_284,
    sha256: "65ff85b33212f75d34d7c0f0724aba9a742c74f62559f67dc0d6c543dc2fc52f",
};

const KOKORO_MODEL_CHECK: FileCheck = FileCheck {
    bytes: 325_532_387,
    sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
};
const KOKORO_VOICES_CHECK: FileCheck = FileCheck {
    bytes: 28_214_398,
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
};

/// Emit a setup-progress event roughly every megabyte, so the download bar moves
/// without flooding the IPC channel with thousands of tiny updates.
const PROGRESS_STEP: u64 = 1_000_000;
/// A download that goes this long without a response or a byte is given up.
/// The background upgrade runs unattended under the one-download lock, so a
/// stalled connection would otherwise hold it, and every later attempt, for
/// the rest of the session.
pub(crate) const DOWNLOAD_STALL: Duration = Duration::from_secs(60);

/// What `tts_synth` answers for a request whose generation was cancelled. The
/// driver expects it and never reports it. Also how a cancelled download ends.
pub(crate) const CANCELLED: &str = "cancelled";
/// How many cancelled generations to remember. The driver keeps at most a few
/// requests in flight, so only the last few cancels can still have any queued.
const CANCELS_KEPT: usize = 32;

/// A Kokoro request gets this long, plus `KOKORO_PER_CHAR` per character, before
/// the sidecar counts as hung. Generous on purpose: the slow int8 model took
/// ~6 s for a 277-character sentence on a loaded machine, and this allows ~19 s.
const KOKORO_TIMEOUT_FLOOR: Duration = Duration::from_secs(5);
const KOKORO_PER_CHAR: Duration = Duration::from_millis(50);
/// Loading the model on spawn (the handshake) gets this long.
const KOKORO_SPAWN_TIMEOUT: Duration = Duration::from_secs(60);
const KOKORO_HUNG: &str = "the Kokoro voice stopped responding and was restarted";

/// TTS state: the DB (settings/keys), a reused HTTP client, the Kokoro model
/// directory, and the warm Kokoro sidecar (lazily spawned). Cloned into managed
/// Tauri state; mirrors how `VoiceState` carries its `Arc<Database>`.
#[derive(Clone)]
pub struct TtsState {
    db: Arc<Database>,
    http: reqwest::Client,
    data_dir: PathBuf,
    kokoro_dir: PathBuf,
    /// The warm Kokoro sidecar process, spawned on first local synth and kept
    /// alive across sentences. `None` until first use / after a death.
    kokoro: Arc<AsyncMutex<Option<KokoroSidecar>>>,
    /// Caps how many ElevenLabs requests we have in flight at once, so the
    /// frontend's per-sentence read-ahead can't trip ElevenLabs' per-plan
    /// concurrency limit (429 `concurrent_limit_exceeded`).
    eleven_sem: Arc<Semaphore>,
    /// Generations the frontend has cancelled (`tts_cancel`), newest last.
    cancelled: Arc<StdMutex<VecDeque<u64>>>,
    /// One model download at a time: an Enable click and the background
    /// upgrade must not write the same `.part` file.
    model_dl: Arc<AsyncMutex<()>>,
    /// `KOKORO_TIMEOUT_FLOOR`, a field so tests can make a hang quick to detect.
    kokoro_timeout_floor: Duration,
    /// The studio voice's sidecar, installer and settings (`tts_studio.rs`).
    studio: Studio,
}

impl TtsState {
    pub fn new(db: Arc<Database>, data_dir: PathBuf) -> Self {
        let http = reqwest::Client::new();
        let studio = Studio::new(&data_dir, http.clone(), db.clone());
        Self {
            db,
            http,
            kokoro_dir: data_dir.join("kokoro"),
            data_dir,
            kokoro: Arc::new(AsyncMutex::new(None)),
            eleven_sem: Arc::new(Semaphore::new(ELEVEN_MAX_CONCURRENCY)),
            cancelled: Arc::new(StdMutex::new(VecDeque::new())),
            model_dl: Arc::new(AsyncMutex::new(())),
            kokoro_timeout_floor: KOKORO_TIMEOUT_FLOOR,
            studio,
        }
    }

    pub(crate) fn studio(&self) -> &Studio {
        &self.studio
    }

    /// The fp32 model once it's in place, else the int8 one an older install
    /// downloaded (so an upgrade in progress never stops the voice).
    fn model_path(&self) -> PathBuf {
        let current = self.kokoro_dir.join(KOKORO_MODEL_FILE);
        let legacy = self.kokoro_dir.join(KOKORO_LEGACY_MODEL_FILE);
        if !current.exists() && legacy.exists() {
            legacy
        } else {
            current
        }
    }
    fn voices_path(&self) -> PathBuf {
        self.kokoro_dir.join(KOKORO_VOICES_FILE)
    }
    fn model_present(&self) -> bool {
        self.model_path().exists() && self.voices_path().exists()
    }
    /// Kokoro can read without a setup step: its model is here, and so is the
    /// Python it was set up with. The studio voice's stand-in check, cheap
    /// enough for every chat that mounts, where `tts_kokoro_status` starts a
    /// login shell and probes interpreters.
    pub(crate) fn kokoro_ready(&self) -> bool {
        self.model_present()
            && self
                .db
                .get_setting(SETTING_PYTHON_PATH)
                .is_some_and(|p| !p.trim().is_empty())
    }
    /// Only the int8 model is here: the voice works, and the fp32 one should
    /// be fetched beside it.
    fn needs_model_upgrade(&self) -> bool {
        self.model_path().ends_with(KOKORO_LEGACY_MODEL_FILE)
    }

    fn cancel(&self, generation: u64) {
        let mut c = self.cancelled.lock().unwrap_or_else(|p| p.into_inner());
        c.push_back(generation);
        if c.len() > CANCELS_KEPT {
            c.pop_front();
        }
    }
    pub(crate) fn is_cancelled(&self, generation: u64) -> bool {
        let c = self.cancelled.lock().unwrap_or_else(|p| p.into_inner());
        c.contains(&generation)
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
/// read-ahead of two sentences queues behind the lock, and a queued request
/// whose generation is cancelled meanwhile is dropped when its turn comes.
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
    /// `"system"` (frontend `speechSynthesis`), `"openai"`, `"kokoro"`,
    /// `"elevenlabs"`, or `"studio"`.
    engine: String,
    has_openai_key: bool,
    openai_voice: String,
    kokoro_voice: String,
    has_eleven_key: bool,
    eleven_voice: String,
    python_path: String,
    /// The studio voice's model variant, preset speaker and default style.
    studio_model: String,
    studio_voice: String,
    studio_style: String,
}

fn read_settings(tts: &TtsState) -> TtsSettings {
    let (studio_model, studio_voice, studio_style) = tts.studio.prefs();
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
        studio_model,
        studio_voice,
        studio_style,
    }
}

#[tauri::command]
pub fn tts_get_settings(tts: tauri::State<'_, TtsState>) -> TtsSettings {
    read_settings(&tts)
}

/// Persist the engine choice and (optionally) the OpenAI key/voice and Kokoro
/// voice. Each `Option` is only written when `Some` — so saving one field doesn't
/// clobber another (notably the stored key the UI never sees); pass `Some("")` to
/// explicitly clear the key. The studio voice's own settings are saved through
/// `tts_studio` (`prefs`).
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
    /// The speed already rendered into the audio. Kokoro takes the user's speed
    /// itself, which keeps the pitch; the cloud engines come back at 1 and the
    /// player makes up the rest with `playbackRate`.
    speed: f64,
}

/// Synthesize one chunk of text with the configured engine. Errors if the engine
/// is `system` (handled client-side), the chosen engine isn't ready, or the
/// request's `generation` has been cancelled (with exactly `CANCELLED`).
///
/// `voice` makes this one request a Kokoro sample in that voice, whatever
/// engine and voice are saved: the settings ▶ auditions a voice before the
/// user saves anything. It rides this command rather than one of its own
/// because every async command costs ~11 KB of release binary (lib.rs,
/// `OFF_MAIN_COMMANDS`).
#[tauri::command]
pub async fn tts_synth(
    tts: tauri::State<'_, TtsState>,
    text: String,
    generation: u64,
    speed: Option<f64>,
    voice: Option<String>,
) -> Result<TtsAudio, String> {
    synth(&tts, &text, generation, speed, voice).await
}

/// Drop every request of `generation` that hasn't reached an engine yet, and
/// stop the studio voice's requests of it mid-stream.
#[tauri::command]
pub fn tts_cancel(tts: tauri::State<'_, TtsState>, generation: u64) {
    tts.cancel(generation);
    tts.studio.cancel(generation);
}

async fn synth(
    tts: &TtsState,
    text: &str,
    generation: u64,
    speed: Option<f64>,
    voice: Option<String>,
) -> Result<TtsAudio, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("empty text".to_string());
    }
    if tts.is_cancelled(generation) {
        return Err(CANCELLED.to_string());
    }
    let voice = voice.filter(|v| !v.trim().is_empty());
    let engine = match voice {
        Some(_) => "kokoro".to_string(),
        None => tts
            .db
            .get_setting(SETTING_ENGINE)
            .unwrap_or_else(|| "system".to_string()),
    };
    let result = match engine.as_str() {
        "openai" => synth_openai(tts, text).await,
        "elevenlabs" => synth_eleven(tts, text, generation).await,
        "kokoro" => {
            let voice = voice.unwrap_or_else(|| {
                tts.db
                    .get_setting(SETTING_KOKORO_VOICE)
                    .unwrap_or_else(|| DEFAULT_KOKORO_VOICE.to_string())
            });
            // The bounds kokoro-onnx accepts; the frontend clamps to the same.
            let speed = speed.filter(|s| s.is_finite()).unwrap_or(1.0).clamp(0.5, 2.0);
            synth_kokoro(tts, text, &voice, speed, generation).await
        }
        other => Err(format!(
            "the '{other}' voice engine has no server-side synthesis"
        )),
    };
    // Synth errors are swallowed on the frontend (the stream must go on, in the
    // system voice), so log them here at `error` level (visible at the default
    // `info` filter) — this is the only place the real provider response (HTTP
    // status + body snippet for cloud engines) is captured.
    if let Err(ref e) = result {
        if e != CANCELLED {
            tracing::error!(target: "tts", engine = %engine, "synthesis failed: {e}");
        }
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
        .timeout(CLOUD_TIMEOUT)
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
        speed: 1.0,
    })
}

async fn synth_eleven(tts: &TtsState, text: &str, generation: u64) -> Result<TtsAudio, String> {
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
    // concurrency cap — the frontend's read-ahead keeps up to three sentences
    // in flight, which otherwise trips ElevenLabs' 429 on the free tier.
    let _permit = tts
        .eleven_sem
        .acquire()
        .await
        .map_err(|e| format!("voice synth queue closed: {e}"))?;
    // A request that waited out a cancel behind the cap costs nothing now.
    if tts.is_cancelled(generation) {
        return Err(CANCELLED.to_string());
    }

    // ElevenLabs addresses voices by id in the URL path and authenticates via
    // the `xi-api-key` header (not bearer). The default response is MP3, which
    // Web Audio `decodeAudioData` handles fine and is smaller per sentence.
    let resp = tts
        .http
        .post(format!(
            "https://api.elevenlabs.io/v1/text-to-speech/{}",
            voice.trim()
        ))
        .timeout(CLOUD_TIMEOUT)
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
        speed: 1.0,
    })
}

// --- Kokoro (local) --------------------------------------------------------

async fn synth_kokoro(
    tts: &TtsState,
    text: &str,
    voice: &str,
    speed: f64,
    generation: u64,
) -> Result<TtsAudio, String> {
    if !tts.model_present() {
        return Err(
            "the Kokoro voice isn't installed yet — open Voice settings (⚙) and download it"
                .to_string(),
        );
    }
    let req = serde_json::json!({ "text": text, "voice": voice, "speed": speed }).to_string();
    let limit = tts.kokoro_timeout_floor + KOKORO_PER_CHAR * text.chars().count() as u32;

    let mut guard = tts.kokoro.lock().await;
    // Requests wait their turn on that lock. One whose generation was
    // cancelled while it waited is dropped here, before it costs a synthesis.
    if tts.is_cancelled(generation) {
        return Err(CANCELLED.to_string());
    }
    if guard.is_none() {
        *guard = Some(spawn_kokoro(tts).await?);
    }
    // Try once; if the pipe is broken (the sidecar died), respawn and retry once.
    // Nothing else is retried: after a hang that sentence goes to the system
    // voice and the next one gets the fresh sidecar, and an error the sidecar
    // reported for this text or voice would only be reported again.
    let b64 = match kokoro_request(&mut guard, tts, &req, limit).await {
        Err(e) if guard.is_none() && e != KOKORO_HUNG => {
            kokoro_request(&mut guard, tts, &req, limit).await?
        }
        result => result?,
    };
    Ok(TtsAudio {
        audio_base64: b64,
        mime: "audio/wav".to_string(),
        speed,
    })
}

/// One request against the warm sidecar (spawning it if there is none),
/// bounded by `limit`. A sidecar whose pipe broke is dropped, and one that
/// doesn't answer in time is killed and dropped, so the next request spawns a
/// fresh one instead of queueing behind a hung process forever. One that
/// reports an error for the request stays: it is healthy, and reloading the
/// model takes seconds.
async fn kokoro_request(
    slot: &mut Option<KokoroSidecar>,
    tts: &TtsState,
    req: &str,
    limit: Duration,
) -> Result<String, String> {
    let sc = match slot {
        Some(sc) => sc,
        None => slot.insert(spawn_kokoro(tts).await?),
    };
    let msg = match tokio::time::timeout(limit, kokoro_roundtrip(sc, req)).await {
        Ok(Ok(msg)) => msg,
        Ok(Err(e)) => {
            *slot = None;
            return Err(e);
        }
        Err(_) => {
            if let Some(mut hung) = slot.take() {
                let _ = hung.child.start_kill();
            }
            tracing::warn!(target: "kokoro", "no answer in {limit:?}; killed the sidecar");
            return Err(KOKORO_HUNG.to_string());
        }
    };
    if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
        return Err(format!("Kokoro synth error: {err}"));
    }
    msg.get("audio")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Kokoro returned no audio".to_string())
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
    // Bounded too: the caller holds the Kokoro lock, and every sentence waits
    // on it. Dropping the child on the way out kills it (`kill_on_drop`).
    let msg = tokio::time::timeout(KOKORO_SPAWN_TIMEOUT, read_kokoro_msg(&mut sidecar.stdout))
        .await
        .map_err(|_| "the Kokoro voice didn't finish loading within a minute".to_string())??;
    if let Some(err) = msg.get("error").and_then(|v| v.as_str()) {
        return Err(format!("Kokoro failed to start: {err}"));
    }
    Ok(sidecar)
}

/// Send one request line and read back the single response object. An `Err`
/// means the pipe failed, i.e. the sidecar is gone.
async fn kokoro_roundtrip(
    sc: &mut KokoroSidecar,
    req_json: &str,
) -> Result<serde_json::Value, String> {
    let line = format!("{req_json}\n");
    sc.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Kokoro write failed: {e}"))?;
    sc.stdin
        .flush()
        .await
        .map_err(|e| format!("Kokoro flush failed: {e}"))?;
    read_kokoro_msg(&mut sc.stdout).await
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
///
/// An install that only has the int8 model then fetches the fp32 one in the
/// background of this call (`kokoro-setup` phase `upgrade`), which is why
/// every caller fires it and forgets it rather than awaiting it. Only the
/// voice panel and its settings start that 325 MB download: a chat's
/// read-aloud warms with `upgrade: false`.
#[tauri::command]
pub async fn tts_kokoro_warm(
    tts: tauri::State<'_, TtsState>,
    app: AppHandle,
    upgrade: Option<bool>,
) -> Result<(), String> {
    let engine = tts.db.get_setting(SETTING_ENGINE).unwrap_or_default();
    if engine != "kokoro" || !tts.model_present() {
        return Ok(());
    }
    {
        let mut guard = tts.kokoro.lock().await;
        if guard.is_none() {
            *guard = Some(spawn_kokoro(&tts).await?);
        }
    }
    // Every panel open warms, so only the first one with nothing downloading
    // starts the upgrade; a failed one is tried again on a later open.
    if upgrade.unwrap_or(true) && tts.needs_model_upgrade() && tts.model_dl.try_lock().is_ok() {
        if let Err(e) = ensure_current_model(&tts, &app, "upgrade").await {
            tracing::warn!(target: "kokoro", "model upgrade failed, keeping the int8 model: {e}");
        }
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

/// The `uv` that builds a local voice engine's private Python. Kokoro's and
/// the studio voice's are interchangeable, so whichever engine fetched one
/// first lends it to the other; otherwise the pinned release is downloaded
/// into `root/bin`. `uv` is a single self-contained executable from Astral;
/// we use it to fetch a pinned Python and resolve the install, so Redline
/// never depends on the user's own Python (which may be a version
/// `onnxruntime` or MLX has no wheels for).
pub(crate) async fn ensure_uv(
    http: &reqwest::Client,
    data_dir: &Path,
    root: &Path,
    progress: &(dyn Fn(u64, u64) -> bool + Sync),
) -> Result<PathBuf, String> {
    let uv = root.join("bin").join("uv");
    for found in [&uv, &data_dir.join("kokoro/bin/uv"), &data_dir.join("voice-studio/bin/uv")] {
        if found.exists() {
            return Ok(found.clone());
        }
    }
    let (asset, check) = match std::env::consts::ARCH {
        "aarch64" => ("uv-aarch64-apple-darwin", UV_AARCH64),
        "x86_64" => ("uv-x86_64-apple-darwin", UV_X86_64),
        other => {
            return Err(format!(
                "the natural voice engine doesn't support this CPU architecture ({other}) yet"
            ))
        }
    };
    tokio::fs::create_dir_all(root.join("bin"))
        .await
        .map_err(|e| format!("could not create the voice bin directory: {e}"))?;

    let url = format!("{UV_URL}{asset}.tar.gz");
    let tarball = root.join("uv.tar.gz");
    fetch_checked(http, &url, &tarball, "the voice toolchain", check, DOWNLOAD_STALL, progress)
        .await?;

    // Unpack with the system `tar` (gzip built in on macOS) and lift out the
    // single `uv` binary; the tarball expands to `<asset>/uv`.
    let dl = root.join("uv-unpack");
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
    #[cfg(unix)]
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
pub(crate) async fn run_checked(mut cmd: tokio::process::Command, what: &str) -> Result<(), String> {
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

/// A `uv` command that keeps everything it downloads or installs inside one
/// engine's directory: Python under `root/python`, the cache under
/// `root/uv-cache`, and only Pythons installed there, so a venv never borrows
/// the user's own interpreter. `uv python install` otherwise unpacks into
/// `~/.local/share/uv` and links `python3.12` into `~/.local/bin` (`--no-bin`
/// stops that), which is where a Kokoro enabled before this change put them,
/// beyond the reach of deleting Redline's data. The user's uv config is
/// ignored for the same reason.
pub(crate) fn uv_cmd(uv: &Path, root: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(uv);
    c.env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_CACHE_DIR", root.join("uv-cache"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_NO_CONFIG", "1")
        .stdin(Stdio::null());
    c
}

/// The three `uv` steps that build `root/venv`: fetch a managed CPython 3.12
/// (the version onnxruntime and MLX reliably ship wheels for), create the
/// venv from it, and pip-install `install` into it.
pub(crate) fn venv_steps(uv: &Path, root: &Path, install: &[OsString]) -> [tokio::process::Command; 3] {
    let venv = root.join("venv");
    let mut python = uv_cmd(uv, root);
    python.args(["python", "install", "3.12", "--no-bin"]);
    let mut create = uv_cmd(uv, root);
    create.arg("venv").arg(&venv).args(["--python", "3.12"]);
    let mut deps = uv_cmd(uv, root);
    deps.args(["pip", "install", "--python"])
        .arg(venv.join("bin").join("python3"))
        .args(install);
    [python, create, deps]
}

/// Build Redline's private voice environment in `root` with `uv` (rebuilt
/// clean each time), none of which touches the user's own Python. `phase`
/// hears `"python"` and `"deps"` as each part starts. The download cache is
/// dropped afterwards: the venv's files are its own copies.
pub(crate) async fn build_venv(
    uv: &Path,
    root: &Path,
    install: &[OsString],
    phase: &(dyn Fn(&str) + Sync),
) -> Result<PathBuf, String> {
    let [python, create, deps] = venv_steps(uv, root, install);
    phase("python");
    run_checked(python, "downloading Python for the voice engine").await?;
    let venv = root.join("venv");
    let _ = tokio::fs::remove_dir_all(&venv).await;
    run_checked(create, "creating the private voice environment").await?;
    phase("deps");
    run_checked(deps, "installing the voice engine").await?;
    let _ = tokio::fs::remove_dir_all(root.join("uv-cache")).await;
    Ok(venv.join("bin").join("python3"))
}

/// Build Kokoro's private environment (`build_venv`) with `kokoro-onnx` in
/// it. Emits `kokoro-setup` phase events.
async fn ensure_kokoro_venv(tts: &TtsState, app: &AppHandle) -> Result<(), String> {
    let uv = ensure_uv(&tts.http, &tts.data_dir, &tts.kokoro_dir, &|received, total| {
        emit_setup(app, "uv", received, total);
        true
    })
    .await?;
    // uv's resolver installs kokoro-onnx (which pulls its own bundled
    // espeak-ng wheel) into our private venv.
    let vpy = build_venv(&uv, &tts.kokoro_dir, &["kokoro-onnx".into()], &|phase| {
        emit_setup(app, phase, 0, 0)
    })
    .await?;
    let _ = tts
        .db
        .set_setting(SETTING_PYTHON_PATH, &vpy.to_string_lossy());
    Ok(())
}

/// Progress for the one-time Kokoro model download.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KokoroSetup {
    /// `"model"`, `"voices"`, `"upgrade"` (the fp32 model replacing an
    /// install's int8 one, in the background), or `"done"`.
    phase: String,
    received: u64,
    total: u64,
}

fn emit_setup(app: &AppHandle, phase: &str, received: u64, total: u64) {
    let _ = app.emit(
        "kokoro-setup",
        KokoroSetup {
            phase: phase.to_string(),
            received,
            total,
        },
    );
}

/// One-click "Enable natural voice": set up a private Python venv with
/// `kokoro-onnx` (only if one isn't already reachable) and download the model
/// and voices into the app data dir (idempotent — skips files already present).
/// Emits `kokoro-setup` progress events. The user installs and configures
/// nothing.
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
    ensure_current_model(&tts, &app, "model").await?;
    let voices = tts.voices_path();
    download_if_missing(&tts, &app, KOKORO_VOICES_URL, &voices, "voices", KOKORO_VOICES_CHECK)
        .await?;

    emit_setup(&app, "done", 0, 0);
    Ok(())
}

/// Make the fp32 model the one on disk: download and verify it if it isn't
/// there, then retire an int8 model an older install left beside it. A failed
/// download leaves the int8 model loading as before.
async fn ensure_current_model(tts: &TtsState, app: &AppHandle, phase: &str) -> Result<(), String> {
    let _one_at_a_time = tts.model_dl.lock().await;
    let dest = tts.kokoro_dir.join(KOKORO_MODEL_FILE);
    let fetched =
        download_if_missing(tts, app, KOKORO_MODEL_URL, &dest, phase, KOKORO_MODEL_CHECK).await;
    if fetched.is_ok() {
        retire_legacy_model(tts).await;
    }
    // Nothing awaits the background upgrade to show how it went, so it ends
    // its own progress line either way (a failure is logged by the caller).
    if phase == "upgrade" {
        emit_setup(app, "done", 0, 0);
    }
    fetched
}

/// Once the fp32 model is in place, stop a sidecar that may still have the
/// int8 one loaded (the next sentence spawns a fresh one on the new model) and
/// delete the int8 file.
async fn retire_legacy_model(tts: &TtsState) {
    let legacy = tts.kokoro_dir.join(KOKORO_LEGACY_MODEL_FILE);
    if !legacy.exists() || !tts.kokoro_dir.join(KOKORO_MODEL_FILE).exists() {
        return;
    }
    if let Some(mut old) = tts.kokoro.lock().await.take() {
        let _ = old.child.start_kill();
    }
    let _ = tokio::fs::remove_file(&legacy).await;
}

async fn download_if_missing(
    tts: &TtsState,
    app: &AppHandle,
    url: &str,
    dest: &Path,
    phase: &str,
    check: FileCheck,
) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    let what = format!("the Kokoro {phase}");
    fetch_checked(&tts.http, url, dest, &what, check, DOWNLOAD_STALL, &|received, total| {
        emit_setup(app, phase, received, total);
        true
    })
    .await
}

/// Stream `url` into `<dest>.part`, then rename it into place — a crash
/// mid-download never leaves a truncated file that looks complete. The file is
/// hashed as it arrives and only the exact published file (`check`) is renamed
/// in; one that comes out different is deleted, `.part` and all, so `dest`
/// (and whatever model sits beside it) is left as it was.
///
/// A download cut off part-way (the network drops, or `stall` passes with
/// nothing received) keeps its `.part`, and the next call resumes it with an
/// HTTP Range request instead of starting over: the studio voice's weights are
/// 2.4 GB. What arrived before is hashed from disk, so the check still covers
/// every byte. Each attempt asks for `url` itself, never a URL it was once
/// redirected to: a model host redirects to a signed link that expires.
///
/// `progress` returning false stops it the same way, with exactly `CANCELLED`:
/// an install the user cancelled, to resume later.
pub(crate) async fn fetch_checked(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    what: &str,
    check: FileCheck,
    stall: Duration,
    progress: &(dyn Fn(u64, u64) -> bool + Sync),
) -> Result<(), String> {
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    let stalled = || format!("downloading {what} stalled — try again");
    let failed = |e: &dyn std::fmt::Display| format!("downloading {what} failed: {e}");
    let mut hasher = Sha256::new();
    let mut received = std::fs::metadata(&tmp).map_or(0, |m| m.len());
    if received > check.bytes {
        let _ = tokio::fs::remove_file(&tmp).await;
        received = 0;
    }
    if received == check.bytes {
        // Complete, but never renamed in (a crash between the two).
        received = hash_into(&tmp, &mut hasher)?;
    } else {
        let mut request = http.get(url);
        if received > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={received}-"));
        }
        let mut resp = tokio::time::timeout(stall, request.send())
            .await
            .map_err(|_| stalled())?
            .map_err(|e| failed(&e))?;
        let status = resp.status();
        if !status.is_success() {
            if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
                let _ = tokio::fs::remove_file(&tmp).await;
            }
            return Err(failed(&format_args!("HTTP {status}")));
        }
        let mut file = if received > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
            received = hash_into(&tmp, &mut hasher)?;
            std::fs::OpenOptions::new().append(true).open(&tmp).map(tokio::fs::File::from_std)
        } else {
            // A server that ignores Range sends the whole file again.
            received = 0;
            tokio::fs::File::create(&tmp).await
        }
        .map_err(|e| format!("opening {what} for writing failed: {e}"))?;
        progress(received, check.bytes);
        let mut last_emit = received;
        let streamed = async {
            while let Some(chunk) = tokio::time::timeout(stall, resp.chunk())
                .await
                .map_err(|_| stalled())?
                .map_err(|e| failed(&e))?
            {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("writing {what} failed: {e}"))?;
                hasher.update(&chunk);
                received += chunk.len() as u64;
                if received - last_emit >= PROGRESS_STEP {
                    last_emit = received;
                    if !progress(received, check.bytes) {
                        return Err(CANCELLED.to_string());
                    }
                }
            }
            Ok::<(), String>(())
        }
        .await;
        // What was written stays on disk, whole, for the next call to resume.
        let flushed = file.flush().await;
        streamed?;
        flushed.map_err(|e| format!("writing {what} failed: {e}"))?;
    }
    if received != check.bytes || format!("{:x}", hasher.finalize()) != check.sha256 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "the downloaded {what} wasn't the published file ({received} bytes), so it was \
             discarded — try again"
        ));
    }
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("finalizing {what} failed: {e}"))
}

/// Feed a file to `hasher`, returning its length. A plain blocking read: it
/// runs once per resumed download, on a task nothing waits on, and an async
/// file would cost the binary a blocking task per operation.
fn hash_into(path: &Path, hasher: &mut Sha256) -> Result<u64, String> {
    let failed = |e: std::io::Error| format!("reading a partial download failed: {e}");
    let mut file = std::fs::File::open(path).map_err(failed)?;
    std::io::copy(&mut file, hasher).map_err(failed)
}

#[cfg(test)]
pub(crate) mod tests {
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

    /// A fresh app data dir (with its `kokoro` dir) for one test.
    fn scratch_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-tts-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("kokoro")).unwrap();
        dir
    }

    /// A stand-in for the Python sidecar. `spawn_kokoro` runs the configured
    /// interpreter as `<python> <script> <model> <voices>`, so a shell script
    /// in the interpreter's place speaks the protocol. It logs each spawn (with
    /// the model it was given) and each request beside itself, and answers
    /// every request with a tiny clip, except: it never answers one containing
    /// "hang", reports an error for the voice "zz_nope" as kokoro-onnx does,
    /// and exits on the first "DIE_ONCE" (answering it after a respawn). With
    /// a `broken` file beside it, it fails to load, as a bad model does.
    const FAKE_SIDECAR: &str = r#"#!/bin/sh
dir=$(dirname "$0")
echo "spawn $2" >> "$dir/spawns.log"
if [ -e "$dir/broken" ]; then echo '{"error":"failed to load Kokoro model: broken"}'; exit 0; fi
echo '{"ready":true}'
while IFS= read -r line; do
  echo "$line" >> "$dir/requests.log"
  case "$line" in
    *hang*) read -r _ ;;
    *zz_nope*) echo '{"error":"Voice zz_nope not found in available voices"}' ;;
    *DIE_ONCE*) [ -e "$dir/died" ] || { touch "$dir/died"; exit 0; }; echo '{"audio":"UklGRg=="}' ;;
    *) echo '{"audio":"UklGRg=="}' ;;
  esac
done
"#;

    /// Kokoro as the engine, installed with `model_file`, on the fake sidecar.
    /// Returns the state and its Kokoro dir (where the fake writes its logs).
    #[cfg(unix)]
    fn fake_kokoro(label: &str, model_file: &str) -> (TtsState, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let data = scratch_dir(label);
        let dir = data.join("kokoro");
        std::fs::write(dir.join(model_file), b"").unwrap();
        std::fs::write(dir.join(KOKORO_VOICES_FILE), b"").unwrap();
        let fake = dir.join("fake-python");
        std::fs::write(&fake, FAKE_SIDECAR).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.set_setting(SETTING_ENGINE, "kokoro").unwrap();
        db.set_setting(SETTING_PYTHON_PATH, &fake.to_string_lossy()).unwrap();
        (TtsState::new(db, data), dir)
    }

    fn log_lines(dir: &Path, name: &str) -> Vec<String> {
        std::fs::read_to_string(dir.join(name))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    /// Serve `body` to one HTTP request on a loopback port.
    fn serve_once(body: &'static [u8]) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut req = [0u8; 2048];
                let _ = s.read(&mut req);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(body);
            }
        });
        format!("http://{addr}/kokoro-v1.0.onnx")
    }

    /// Where `fetch_checked` keeps a download until it is verified.
    fn part(dest: &Path) -> PathBuf {
        let mut p = dest.as_os_str().to_owned();
        p.push(".part");
        PathBuf::from(p)
    }

    /// A loopback HTTP server for as long as the test runs. `respond` gets each
    /// request's head and returns the raw response and how many of its bytes
    /// to write before hanging up, as a dropped connection does.
    pub(crate) fn serve(respond: impl Fn(&str) -> (Vec<u8>, usize) + Send + 'static) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                let mut req = [0u8; 4096];
                let n = s.read(&mut req).unwrap_or(0);
                let (bytes, keep) = respond(&String::from_utf8_lossy(&req[..n]));
                let _ = s.write_all(&bytes[..keep.min(bytes.len())]);
            }
        });
        format!("http://{addr}")
    }

    /// An HTTP response with `body`, whole.
    pub(crate) fn http(status: &str, headers: &str, body: &[u8]) -> (Vec<u8>, usize) {
        let mut r = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        let len = r.len();
        (r, len)
    }

    /// The byte offset a request's `Range: bytes=N-` asks from, if any.
    fn range_from(head: &str) -> Option<usize> {
        head.lines()
            .find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(String::from))
            .and_then(|r| r.trim_end_matches('-').parse().ok())
    }

    /// A body of `len` bytes that no two offsets share a pattern in for long.
    fn noise(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect()
    }

    fn check_for(body: &[u8]) -> FileCheck {
        FileCheck {
            bytes: body.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(body)).into_boxed_str()),
        }
    }

    /// Serve the start of a body on a loopback port, then go quiet with the
    /// connection open, as a stalled download does.
    fn serve_then_stall() -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut req = [0u8; 2048];
                let _ = s.read(&mut req);
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n");
                let _ = s.write_all(&[0u8; 10]);
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        format!("http://{addr}/kokoro-v1.0.onnx")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_generation_never_reaches_the_sidecar() {
        let (tts, dir) = fake_kokoro("cancelled", KOKORO_MODEL_FILE);
        tts.cancel(41);
        let stale = synth(&tts, "The rest of the stopped reply.", 41, None, None).await;
        assert_eq!(stale.err().as_deref(), Some(CANCELLED));
        assert!(log_lines(&dir, "spawns.log").is_empty(), "not even a spawn");
        // The next generation speaks normally.
        synth(&tts, "The next reply.", 42, None, None).await.unwrap();
        assert_eq!(log_lines(&dir, "requests.log").len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_request_cancelled_while_it_waits_for_kokoro_is_dropped_on_its_turn() {
        let (tts, dir) = fake_kokoro("queued", KOKORO_MODEL_FILE);
        synth(&tts, "Warm up.", 1, None, None).await.unwrap();
        // The sentence ahead of it is synthesizing: it holds the lock.
        let ahead = tts.kokoro.lock().await;
        let queued = tokio::spawn({
            let tts = tts.clone();
            async move { synth(&tts, "Behind the stop.", 2, None, None).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tts.cancel(2);
        drop(ahead);
        assert_eq!(queued.await.unwrap().err().as_deref(), Some(CANCELLED));
        assert_eq!(
            log_lines(&dir, "requests.log").len(),
            1,
            "only the warm-up reached the sidecar"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_sidecar_times_out_and_the_next_sentence_gets_a_fresh_one() {
        let (mut tts, dir) = fake_kokoro("hung", KOKORO_MODEL_FILE);
        tts.kokoro_timeout_floor = Duration::from_millis(200);
        let started = std::time::Instant::now();
        let hung = synth(&tts, "hang", 1, None, None).await;
        assert_eq!(hung.err().as_deref(), Some(KOKORO_HUNG));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(tts.kokoro.lock().await.is_none(), "the hung sidecar was dropped");
        synth(&tts, "The next sentence.", 1, None, None).await.unwrap();
        assert_eq!(log_lines(&dir, "spawns.log").len(), 2, "respawned once");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_warm_sidecar_that_died_is_respawned_and_the_sentence_retried() {
        let (tts, dir) = fake_kokoro("died", KOKORO_MODEL_FILE);
        synth(&tts, "Warm up.", 1, None, None).await.unwrap();
        synth(&tts, "DIE_ONCE", 1, None, None).await.unwrap();
        assert_eq!(log_lines(&dir, "spawns.log").len(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_sidecar_that_cant_load_is_tried_once_per_sentence() {
        let (tts, dir) = fake_kokoro("broken", KOKORO_MODEL_FILE);
        std::fs::write(dir.join("broken"), b"").unwrap();
        let err = synth(&tts, "One.", 1, None, None).await.err().unwrap();
        assert!(err.contains("failed to load"), "{err}");
        // A second spawn would fail the same way, and every sentence waits on
        // the lock behind it (up to a minute each when the load hangs).
        assert_eq!(log_lines(&dir, "spawns.log").len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_error_kokoro_reports_for_a_request_keeps_the_warm_sidecar() {
        let (tts, dir) = fake_kokoro("synth-error", KOKORO_MODEL_FILE);
        synth(&tts, "Warm up.", 1, None, None).await.unwrap();
        let err = synth(&tts, "A sample.", 1, None, Some("zz_nope".into()))
            .await
            .err()
            .unwrap();
        assert!(err.contains("zz_nope not found"), "{err}");
        synth(&tts, "The next sentence.", 1, None, None).await.unwrap();
        // The sidecar is fine; reloading the model would only repeat the error.
        assert_eq!(log_lines(&dir, "spawns.log").len(), 1);
        assert_eq!(log_lines(&dir, "requests.log").len(), 3, "the bad one isn't retried");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kokoro_renders_the_users_speed_and_an_auditioned_voice() {
        let (tts, dir) = fake_kokoro("speed", KOKORO_MODEL_FILE);
        tts.db.set_setting(SETTING_KOKORO_VOICE, "am_adam").unwrap();
        let saved = synth(&tts, "One.", 1, Some(1.5), None).await.unwrap();
        assert_eq!(saved.speed, 1.5, "the player must not speed it up again");
        let sample = synth(&tts, "Two.", 1, Some(9.0), Some("af_heart+am_michael".into()))
            .await
            .unwrap();
        assert_eq!(sample.speed, 2.0, "clamped to what kokoro-onnx accepts");
        let reqs: Vec<serde_json::Value> = log_lines(&dir, "requests.log")
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(reqs[0]["voice"], "am_adam");
        assert_eq!(reqs[0]["speed"], 1.5);
        assert_eq!(reqs[1]["voice"], "af_heart+am_michael");
        assert_eq!(reqs[1]["speed"], 2.0);
        // An audition never replaces the saved voice.
        assert_eq!(read_settings(&tts).kokoro_voice, "am_adam");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_voice_sample_uses_kokoro_whatever_engine_is_saved() {
        let (tts, dir) = fake_kokoro("sample", KOKORO_MODEL_FILE);
        tts.db.set_setting(SETTING_ENGINE, "system").unwrap();
        assert!(synth(&tts, "Plain speech.", 1, None, None).await.is_err());
        synth(&tts, "A sample.", 2, None, Some("bf_emma".into())).await.unwrap();
        assert_eq!(log_lines(&dir, "requests.log").len(), 1);
        assert_eq!(read_settings(&tts).engine, "system", "nothing was saved");
    }

    #[test]
    fn the_int8_model_keeps_loading_until_the_fp32_one_is_in_place() {
        let data = scratch_dir("models");
        let dir = data.join("kokoro");
        std::fs::write(dir.join(KOKORO_VOICES_FILE), b"").unwrap();
        let tts = TtsState::new(Arc::new(Database::open_in_memory().unwrap()), data);
        assert!(!tts.model_present());
        assert!(tts.model_path().ends_with(KOKORO_MODEL_FILE), "a fresh install gets fp32");
        assert!(!tts.needs_model_upgrade());

        std::fs::write(dir.join(KOKORO_LEGACY_MODEL_FILE), b"int8").unwrap();
        assert!(tts.model_present());
        assert!(tts.model_path().ends_with(KOKORO_LEGACY_MODEL_FILE));
        assert!(tts.needs_model_upgrade());

        std::fs::write(dir.join(KOKORO_MODEL_FILE), b"fp32").unwrap();
        assert!(tts.model_path().ends_with(KOKORO_MODEL_FILE));
        assert!(!tts.needs_model_upgrade());
    }

    /// The studio voice asks whether Kokoro can stand in at every chat's
    /// mount: the model and the Python it was set up with, no probing.
    #[test]
    fn kokoro_stands_in_once_its_model_and_python_are_set_up() {
        let data = scratch_dir("ready");
        let dir = data.join("kokoro");
        let tts = TtsState::new(Arc::new(Database::open_in_memory().unwrap()), data);
        tts.db.set_setting(SETTING_PYTHON_PATH, "/a/venv/bin/python3").unwrap();
        assert!(!tts.kokoro_ready(), "no model yet");
        std::fs::write(dir.join(KOKORO_MODEL_FILE), b"fp32").unwrap();
        std::fs::write(dir.join(KOKORO_VOICES_FILE), b"").unwrap();
        assert!(tts.kokoro_ready());
        tts.db.set_setting(SETTING_PYTHON_PATH, " ").unwrap();
        assert!(!tts.kokoro_ready(), "a model with no Python found for it");
    }

    #[tokio::test]
    async fn a_download_that_isnt_the_published_model_is_discarded() {
        let data = scratch_dir("bad-download");
        let dir = data.join("kokoro");
        std::fs::write(dir.join(KOKORO_LEGACY_MODEL_FILE), b"int8").unwrap();
        std::fs::write(dir.join(KOKORO_VOICES_FILE), b"").unwrap();
        let tts = TtsState::new(Arc::new(Database::open_in_memory().unwrap()), data);
        let dest = dir.join(KOKORO_MODEL_FILE);
        let url = serve_once(b"cut off mid-download");
        let err = fetch_checked(
            &tts.http,
            &url,
            &dest,
            "the Kokoro upgrade",
            KOKORO_MODEL_CHECK,
            DOWNLOAD_STALL,
            &|_, _| true,
        )
        .await
        .unwrap_err();
        assert!(err.contains("wasn't the published file"), "{err}");
        assert!(!dest.exists());
        assert!(!part(&dest).exists(), "no half file left behind");
        assert!(tts.model_present());
        assert!(tts.model_path().ends_with(KOKORO_LEGACY_MODEL_FILE), "the int8 model still loads");
    }

    #[tokio::test]
    async fn a_stalled_download_is_given_up_and_keeps_what_arrived_for_the_next_try() {
        let data = scratch_dir("stalled-download");
        let dest = data.join("kokoro").join(KOKORO_MODEL_FILE);
        let http = reqwest::Client::new();
        let started = std::time::Instant::now();
        let err = fetch_checked(
            &http,
            &serve_then_stall(),
            &dest,
            "the Kokoro upgrade",
            KOKORO_MODEL_CHECK,
            Duration::from_millis(300),
            &|_, _| true,
        )
        .await
        .unwrap_err();
        assert!(err.contains("stalled"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(4), "not held until the server gave up");
        assert!(!dest.exists(), "nothing unverified is put in place");
        assert_eq!(std::fs::read(part(&dest)).unwrap(), [0u8; 10], "resumed next time");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_verified_download_switches_the_voice_to_fp32_and_retires_int8() {
        let (tts, dir) = fake_kokoro("upgrade", KOKORO_LEGACY_MODEL_FILE);
        synth(&tts, "Speaking on int8.", 1, None, None).await.unwrap();

        const BODY: &[u8] = b"fp32 weights";
        let check = FileCheck {
            bytes: BODY.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(BODY)).into_boxed_str()),
        };
        let dest = dir.join(KOKORO_MODEL_FILE);
        let url = serve_once(BODY);
        fetch_checked(&tts.http, &url, &dest, "the Kokoro upgrade", check, DOWNLOAD_STALL, &|_, _| true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), BODY);
        retire_legacy_model(&tts).await;
        assert!(!dir.join(KOKORO_LEGACY_MODEL_FILE).exists());
        assert!(tts.kokoro.lock().await.is_none(), "the int8 sidecar was stopped");

        synth(&tts, "Speaking on fp32.", 1, None, None).await.unwrap();
        let spawns = log_lines(&dir, "spawns.log");
        assert!(spawns[0].ends_with(KOKORO_LEGACY_MODEL_FILE), "{spawns:?}");
        assert!(spawns[1].ends_with(KOKORO_MODEL_FILE), "{spawns:?}");
    }

    /// A model host answers the canonical URL with a redirect to a signed,
    /// short-lived link. The first attempt drops a third of the way in; the
    /// second resumes from what is on disk, through a freshly signed link,
    /// and the whole file still has to hash to the pin.
    #[tokio::test]
    async fn a_dropped_download_resumes_through_a_fresh_redirect() {
        let body: &'static [u8] = Box::leak(noise(300_000).into_boxed_slice());
        let signed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ranges = Arc::new(StdMutex::new(Vec::<Option<usize>>::new()));
        let base = serve({
            let (signed, ranges) = (signed.clone(), ranges.clone());
            move |head| {
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                if path.starts_with("/resolve/") {
                    let sig = signed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    return http("302 Found", &format!("Location: /cdn?sig={sig}\r\n"), b"");
                }
                let latest = signed.load(std::sync::atomic::Ordering::SeqCst);
                if path != format!("/cdn?sig={latest}") {
                    return http("403 Forbidden", "", b"expired");
                }
                let from = range_from(head);
                ranges.lock().unwrap().push(from);
                match from {
                    None => {
                        let (r, len) = http("200 OK", "", body);
                        (r, len - body.len() + 100_000)
                    }
                    Some(at) => http(
                        "206 Partial Content",
                        &format!("Content-Range: bytes {at}-{}/{}\r\n", body.len() - 1, body.len()),
                        &body[at..],
                    ),
                }
            }
        });
        let data = scratch_dir("resume");
        let dest = data.join("model.safetensors");
        let url = format!("{base}/resolve/main/model.safetensors");
        let http_client = reqwest::Client::new();

        let check = check_for(body);
        let err = fetch_checked(&http_client, &url, &dest, "the model", check, DOWNLOAD_STALL, &|_, _| true)
            .await
            .unwrap_err();
        assert!(err.contains("failed"), "{err}");
        assert!(!dest.exists());
        let kept = std::fs::metadata(part(&dest)).unwrap().len() as usize;
        assert!(kept > 0 && kept <= 100_000, "{kept}");

        let seen = Arc::new(StdMutex::new(Vec::new()));
        let saw = seen.clone();
        let note = move |received, total| {
            saw.lock().unwrap().push((received, total));
            true
        };
        fetch_checked(&http_client, &url, &dest, "the model", check_for(body), DOWNLOAD_STALL, &note)
        .await
        .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!part(&dest).exists());
        assert_eq!(*ranges.lock().unwrap(), [None, Some(kept)], "resumed where it stopped");
        assert_eq!(signed.load(std::sync::atomic::Ordering::SeqCst), 2, "re-signed for the resume");
        assert_eq!(seen.lock().unwrap()[0], (kept as u64, body.len() as u64));
    }

    #[tokio::test]
    async fn a_server_that_ignores_range_starts_the_file_over() {
        let body: &'static [u8] = Box::leak(noise(50_000).into_boxed_slice());
        let base = serve(move |_| http("200 OK", "", body));
        let data = scratch_dir("no-range");
        let dest = data.join("vocab.json");
        std::fs::write(part(&dest), &body[..20_000]).unwrap();
        let client = reqwest::Client::new();
        let url = format!("{base}/f");
        fetch_checked(&client, &url, &dest, "the vocabulary", check_for(body), DOWNLOAD_STALL, &|_, _| true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    #[tokio::test]
    async fn a_resumed_download_that_hashes_wrong_is_discarded_whole() {
        let body: &'static [u8] = Box::leak(noise(50_000).into_boxed_slice());
        let base = serve(move |head| {
            let at = range_from(head).unwrap_or(0);
            http("206 Partial Content", "", &body[at..])
        });
        let data = scratch_dir("bad-resume");
        let dest = data.join("config.json");
        // The first 1,000 bytes on disk aren't the file's.
        std::fs::write(part(&dest), vec![7u8; 1_000]).unwrap();
        let client = reqwest::Client::new();
        let url = format!("{base}/f");
        let err = fetch_checked(&client, &url, &dest, "the config", check_for(body), DOWNLOAD_STALL, &|_, _| true)
            .await
            .unwrap_err();
        assert!(err.contains("wasn't the published file"), "{err}");
        assert!(!dest.exists());
        assert!(!part(&dest).exists(), "the next try starts clean");
    }

    #[tokio::test]
    async fn a_finished_download_that_was_never_renamed_is_verified_offline() {
        let body = noise(4_000);
        let data = scratch_dir("unrenamed");
        let dest = data.join("generation_config.json");
        std::fs::write(part(&dest), &body).unwrap();
        let client = reqwest::Client::new();
        // Nothing listens there: the bytes on disk are enough.
        let check = check_for(&body);
        fetch_checked(&client, "http://127.0.0.1:9/f", &dest, "the config", check, DOWNLOAD_STALL, &|_, _| true)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    /// Every uv step keeps its Python, cache and venv inside the engine's own
    /// directory. Nothing may land in `~/.local` (where a Kokoro enabled
    /// before this change put `python3.12`), and the interpreter it builds
    /// on must be one uv installed there.
    #[test]
    fn uv_steps_stay_inside_the_engines_directory() {
        let data = scratch_dir("uv-argv");
        for root in [data.join("kokoro"), data.join("voice-studio")] {
            let uv = root.join("bin/uv");
            let steps = venv_steps(&uv, &root, &["kokoro-onnx".into()]);
            for step in &steps {
                let cmd = step.as_std();
                assert_eq!(cmd.get_program(), uv.as_os_str());
                let envs: Vec<(String, String)> = cmd
                    .get_envs()
                    .map(|(k, v)| {
                        let v = v.map(|v| v.to_string_lossy().to_string()).unwrap_or_default();
                        (k.to_string_lossy().to_string(), v)
                    })
                    .collect();
                let env = |k: &str| envs.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
                assert_eq!(env("UV_PYTHON_INSTALL_DIR"), Some(root.join("python").to_string_lossy().into()));
                assert_eq!(env("UV_CACHE_DIR"), Some(root.join("uv-cache").to_string_lossy().into()));
                assert_eq!(env("UV_PYTHON_PREFERENCE").as_deref(), Some("only-managed"));
                assert_eq!(env("UV_NO_CONFIG").as_deref(), Some("1"));
                let paths = cmd
                    .get_args()
                    .map(|a| a.to_string_lossy().to_string())
                    .chain(envs.iter().map(|(_, v)| v.clone()));
                for p in paths {
                    assert!(!p.contains("/.local/"), "{p}");
                    if p.starts_with('/') {
                        assert!(p.starts_with(&*root.to_string_lossy()), "{p} is outside {root:?}");
                    }
                }
            }
            let args = |i: usize| -> Vec<String> {
                steps[i].as_std().get_args().map(|a| a.to_string_lossy().to_string()).collect()
            };
            assert_eq!(args(0), ["python", "install", "3.12", "--no-bin"]);
            assert_eq!(args(1)[0], "venv");
            assert_eq!(args(1)[1], root.join("venv").to_string_lossy());
            assert_eq!(args(2)[..4], ["pip", "install", "--python", &*root.join("venv/bin/python3").to_string_lossy()]);
        }
    }

    #[tokio::test]
    async fn a_uv_either_engine_fetched_is_lent_to_the_other() {
        let data = scratch_dir("uv-share");
        std::fs::create_dir_all(data.join("kokoro/bin")).unwrap();
        std::fs::write(data.join("kokoro/bin/uv"), b"#!/bin/sh\n").unwrap();
        let client = reqwest::Client::new();
        let uv = ensure_uv(&client, &data, &data.join("voice-studio"), &|_, _| true).await.unwrap();
        assert_eq!(uv, data.join("kokoro/bin/uv"), "no second download");
    }
}

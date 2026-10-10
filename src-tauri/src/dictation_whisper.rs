// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Local **Whisper** (whisper.cpp) speech-to-text — the higher-quality,
//! pluggable alternative to Apple's `SFSpeechRecognizer` for dictation
//! (`dictation.rs`): a stronger local model, not an input trick.
//!
//! This module owns everything that is *not* audio capture:
//!   - **Models** — `base.en` (~148 MB, the default) and an opt-in
//!     `large-v3-turbo` quantized to q5_0 (~574 MB), better with names and
//!     code terms. Each downloads on first use into `<data>/whisper/`, pinned
//!     by size and SHA-256 and resumable (`pinned_fetch.rs`). End users install
//!     nothing else; whisper.cpp is compiled into the binary and
//!     Metal-accelerated on Apple silicon. The `dictation_whisper_model`
//!     setting picks one; base.en is used whenever turbo isn't on disk.
//!   - **The resident model** — a lazily-loaded `WhisperContext` kept warm behind
//!     a `Mutex`, loaded while the user is still speaking (`warm`), so only a
//!     first-ever release waits on it. Released on app exit (`RunEvent::Exit`).
//!   - **Inference** — [`WhisperState::transcribe`] turns one accumulated
//!     utterance (16 kHz mono `f32`) into text. It is blocking (whisper.cpp is
//!     CPU/GPU-bound), so it runs on the blocking pool, under `dictation_stop`.
//!     Four guards keep Whisper from inventing words:
//!       1. a **silence gate**: an utterance with no window that sounds like
//!          speech is never decoded ([`speech_gate`]);
//!       2. **hallucination thresholds** on the decoder (entropy 2.8, average
//!          log-probability −1.25), which measured far fewer invented endings
//!          over thousands of real dictations;
//!       3. the capture's **vocabulary** goes in as the initial prompt only
//!          once the gate has passed — over near-silence a prompt makes Whisper
//!          read the dictionary back ([`plan_decode`]);
//!       4. a decoded segment that is only a note about non-speech —
//!          "(clapping)", "[BLANK_AUDIO]", "*static*", a lone "." — is
//!          dropped, so a key tap never types a note into a composer
//!          ([`is_note`]).
//!   - **Resampling** — [`resample_to_16k`] converts the microphone's
//!     hardware-rate PCM (44.1/48 kHz) down to the 16 kHz Whisper requires.
//!
//! The *audio tee* (extracting PCM from the live mic tap into the accumulator)
//! lives in `dictation.rs` next to the AVAudioEngine plumbing; this module only
//! consumes the finished sample buffer.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

use crate::db::Database;
use crate::pinned_fetch::{self, Pinned};

#[cfg(target_os = "macos")]
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

/// DB setting: which dictation recognizer to use. `auto` (default) prefers
/// Whisper when its model is present, else Apple; `apple` / `whisper` force one.
/// Mirrors `SETTING_ENGINE` in `tts.rs` — a plain key in `app_settings`.
pub const SETTING_DICTATION_ENGINE: &str = "dictation_engine";
/// DB setting: which Whisper model to run, `base` (default) or `turbo`.
pub const SETTING_WHISPER_MODEL: &str = "dictation_whisper_model";

/// Sample rate Whisper expects — all whisper.cpp models are trained on 16 kHz.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// One downloadable Whisper model.
#[derive(Debug)]
pub struct WhisperModel {
    /// The setting value and the id the frontend uses.
    pub id: &'static str,
    file: &'static str,
    pin: Pinned,
}

/// Both files come from the whisper.cpp project's model repository, at one
/// pinned revision, with the size and SHA-256 that revision publishes.
pub const BASE_EN: WhisperModel = WhisperModel {
    id: "base",
    file: "ggml-base.en.bin",
    pin: Pinned {
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin",
        bytes: 147_964_211,
        sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    },
};
pub const TURBO: WhisperModel = WhisperModel {
    id: "turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    pin: Pinned {
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
};
pub const MODELS: [&WhisperModel; 2] = [&BASE_EN, &TURBO];

/// The model to run for a `setting`, given which files are on disk: the one
/// the setting names when it is there, else whichever one is, base first.
/// `None` when neither is installed.
pub fn resolve_model(
    setting: &str,
    present: impl Fn(&WhisperModel) -> bool,
) -> Option<&'static WhisperModel> {
    let wanted: &'static WhisperModel = if setting == TURBO.id { &TURBO } else { &BASE_EN };
    if present(wanted) {
        return Some(wanted);
    }
    MODELS.into_iter().find(|m| present(m))
}

/// A download that goes this long without a response or a byte is retried
/// (resuming), and given up after the last retry.
const DOWNLOAD_STALL: Duration = Duration::from_secs(60);

// --- Decoding guards ------------------------------------------------------

/// Decoder thresholds against invented text: a segment whose token entropy is
/// above this, or whose average log-probability is below `LOGPROB_THOLD`, is
/// re-decoded at a higher temperature. Measured over thousands of real
/// dictations, these took invented sentence endings from ~2% to under 0.1%.
const ENTROPY_THOLD: f32 = 2.8;
const LOGPROB_THOLD: f32 = -1.25;

/// The silence gate's window: 50 ms at 16 kHz, the same span as one
/// `dictation-level` event.
const GATE_WINDOW: usize = (WHISPER_SAMPLE_RATE as usize) / 20;
/// Below this loudest-window RMS the utterance is silence.
const SILENCE_RMS: f32 = 0.002;
/// A window that sounds like speech has at least this RMS *and* this peak.
const SPEECH_WINDOW_RMS: f32 = 0.003;
const SPEECH_WINDOW_PEAK: f32 = 0.02;

/// Whether `pcm` (16 kHz mono) holds anything worth decoding: its loudest
/// 50 ms window reaches `SILENCE_RMS`, and at least one window has the RMS and
/// the peak of speech. A breath, a desk tap or room tone fails it, and Whisper
/// never gets the chance to invent words over it.
pub fn speech_gate(pcm: &[f32]) -> bool {
    let mut loudest = 0.0f32;
    let mut speech = false;
    for window in pcm.chunks(GATE_WINDOW) {
        let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
        let peak = window.iter().fold(0.0f32, |p, s| p.max(s.abs()));
        loudest = loudest.max(rms);
        speech |= rms >= SPEECH_WINDOW_RMS && peak >= SPEECH_WINDOW_PEAK;
    }
    loudest >= SILENCE_RMS && speech
}

/// How to decode one utterance: whether to at all, and with what prompt.
#[derive(Debug, PartialEq)]
pub struct DecodePlan {
    pub prompt: Option<String>,
}

/// The silence gate first, the vocabulary prompt only after it: `None` means
/// "don't decode, it's silence", so the prompt can never meet near-silence.
pub fn plan_decode(pcm: &[f32], vocab: &[String]) -> Option<DecodePlan> {
    if !speech_gate(pcm) {
        return None;
    }
    Some(DecodePlan { prompt: vocab_prompt(vocab) })
}

/// The longest prompt worth building: whisper.cpp conditions on at most the
/// last 224 tokens of it, and a term is rarely shorter than 4 bytes a token.
const PROMPT_MAX_BYTES: usize = 1_000;

/// The vocabulary as Whisper's initial prompt: the terms as a comma list, the
/// most important (the front of `vocab`, which arrives ranked) LAST, because
/// whisper.cpp keeps the tail of a long prompt and the tail sits nearest the
/// audio. Terms that would push it past `PROMPT_MAX_BYTES` are left out, the
/// least important first.
pub fn vocab_prompt(vocab: &[String]) -> Option<String> {
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0;
    for term in vocab {
        if bytes + term.len() + 2 > PROMPT_MAX_BYTES {
            break;
        }
        bytes += term.len() + 2;
        kept.push(term);
    }
    if kept.is_empty() {
        return None;
    }
    kept.reverse();
    Some(format!(" {}.", kept.join(", ")))
}

/// Whether a decoded segment is only a transcriber's note about non-speech:
/// one or more `[…]`, `(…)` or `*…*` notes, or no letters or digits at all
/// (".", "♪"). Whisper writes these over taps and breaths, the sounds loud
/// enough to pass the silence gate.
pub fn is_note(segment: &str) -> bool {
    let mut rest = segment.trim();
    if !rest.chars().any(char::is_alphanumeric) {
        return true;
    }
    while !rest.is_empty() {
        let close = match rest.as_bytes()[0] {
            b'[' => ']',
            b'(' => ')',
            b'*' => '*',
            _ => return false,
        };
        let Some(end) = rest[1..].find(close) else {
            return false;
        };
        rest = rest[end + 2..].trim_start();
    }
    true
}

/// Decoder threads: three quarters of the cores, between 4 and 12 — enough to
/// finish a short utterance fast without starving the UI on a big machine.
pub fn decode_threads(cores: usize) -> i32 {
    ((cores * 3) / 4).clamp(4, 12) as i32
}

// --- State ----------------------------------------------------------------

/// The model resident in memory, and which one it is.
#[cfg(target_os = "macos")]
struct Loaded {
    id: &'static str,
    ctx: WhisperContext,
}

/// Whisper backend state, managed by Tauri next to `DictationState` / `TtsState`.
/// Carries the DB (settings), a reused HTTP client for the model download,
/// the model directory, and the lazily-loaded resident model. Cloneable (all
/// fields are `Arc`/cheap) so it can be moved onto the thread that warms it.
#[derive(Clone)]
pub struct WhisperState {
    db: Arc<Database>,
    http: reqwest::Client,
    whisper_dir: PathBuf,
    /// One model download at a time: two clicks must not write the same `.part`.
    download: Arc<AsyncMutex<()>>,
    /// The resident whisper.cpp model, loaded on first use and kept warm across
    /// utterances. `None` until first use / after teardown. `WhisperContext`
    /// is `Send + Sync` (the crate guarantees it), so it lives behind a plain
    /// `Mutex` in shared state.
    #[cfg(target_os = "macos")]
    ctx: Arc<Mutex<Option<Loaded>>>,
}

impl WhisperState {
    pub fn new(db: Arc<Database>, data_dir: PathBuf) -> Self {
        Self {
            db,
            http: reqwest::Client::new(),
            whisper_dir: data_dir.join("whisper"),
            download: Arc::new(AsyncMutex::new(())),
            #[cfg(target_os = "macos")]
            ctx: Arc::new(Mutex::new(None)),
        }
    }

    fn path_of(&self, model: &WhisperModel) -> PathBuf {
        self.whisper_dir.join(model.file)
    }

    /// The model the settings and the disk resolve to, if any is installed.
    pub fn model(&self) -> Option<&'static WhisperModel> {
        resolve_model(&self.model_setting(), |m| self.path_of(m).exists())
    }

    /// A Whisper model has finished downloading — what `auto` engine
    /// resolution asks.
    pub fn model_present(&self) -> bool {
        self.model().is_some()
    }

    /// The configured engine setting (`auto` / `apple` / `whisper`), defaulting
    /// to `auto`.
    pub fn engine_setting(&self) -> String {
        self.db
            .get_setting(SETTING_DICTATION_ENGINE)
            .unwrap_or_else(|| "auto".to_string())
    }

    /// The configured model setting (`base` / `turbo`), defaulting to `base`.
    pub fn model_setting(&self) -> String {
        self.db
            .get_setting(SETTING_WHISPER_MODEL)
            .unwrap_or_else(|| BASE_EN.id.to_string())
    }

    /// Each model, whether it is installed, and how much of an interrupted
    /// download is waiting to resume — for the settings UI.
    pub fn statuses(&self) -> Vec<WhisperModelStatus> {
        MODELS
            .into_iter()
            .map(|m| {
                let path = self.path_of(m);
                WhisperModelStatus {
                    id: m.id,
                    present: path.exists(),
                    bytes: m.pin.bytes,
                    partial: std::fs::metadata(pinned_fetch::part_path(&path))
                        .map(|md| md.len())
                        .unwrap_or(0),
                }
            })
            .collect()
    }

    /// Release the resident model at app teardown. Best-effort (`try_lock`); the
    /// OS reclaims the memory on process exit regardless.
    pub fn kill(&self) {
        #[cfg(target_os = "macos")]
        {
            if let Ok(mut guard) = self.ctx.try_lock() {
                *guard = None;
            }
        }
    }

    /// Load the selected model if it isn't the one resident — called as a
    /// capture starts, so the load overlaps the user speaking. **Blocking.**
    #[cfg(target_os = "macos")]
    pub fn warm(&self) -> Result<(), String> {
        let mut guard = self
            .ctx
            .lock()
            .map_err(|_| "whisper model lock poisoned".to_string())?;
        self.load_into(&mut guard).map(|_| ())
    }

    #[cfg(target_os = "macos")]
    fn load_into<'g>(&self, guard: &'g mut Option<Loaded>) -> Result<&'g WhisperContext, String> {
        let model = self
            .model()
            .ok_or_else(|| "the Whisper model isn't installed yet".to_string())?;
        if guard.as_ref().map(|l| l.id) != Some(model.id) {
            // Free the old model before loading the next: both at once would
            // briefly hold ~0.7 GB.
            *guard = None;
            let ctx = WhisperContext::new_with_params(
                &self.path_of(model).to_string_lossy(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("failed to load the Whisper model: {e}"))?;
            *guard = Some(Loaded { id: model.id, ctx });
        }
        Ok(&guard.as_ref().expect("loaded above").ctx)
    }

    /// Transcribe one accumulated utterance (16 kHz mono `f32`) to text, with
    /// the capture's vocabulary. Silence comes back as "" without a decode.
    /// **Blocking** — never on the main thread or a runtime worker.
    #[cfg(target_os = "macos")]
    pub fn transcribe(&self, pcm_16k_mono: &[f32], vocab: &[String]) -> Result<String, String> {
        let Some(plan) = plan_decode(pcm_16k_mono, vocab) else {
            return Ok(String::new());
        };
        let mut guard = self
            .ctx
            .lock()
            .map_err(|_| "whisper model lock poisoned".to_string())?;
        let ctx = self.load_into(&mut guard)?;
        decode(ctx, pcm_16k_mono, plan.prompt.as_deref(), true)
    }
}

/// One whisper.cpp pass over `pcm`, greedy, English. `guards` sets the
/// hallucination thresholds and drops note-only segments (off only to measure
/// what they buy).
#[cfg(target_os = "macos")]
fn decode(ctx: &WhisperContext, pcm: &[f32], prompt: Option<&str>, guards: bool) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("failed to create the Whisper state: {e}"))?;
    // A token is at least one byte, so this many slots always fit: whisper-rs
    // only reports the "-1" overflow, and would misread any larger one.
    let tokens = match prompt {
        Some(p) => ctx
            .tokenize(p, p.len() + 8)
            .map_err(|e| format!("reading the vocabulary failed: {e}"))?,
        None => Vec::new(),
    };

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    params.set_n_threads(decode_threads(cores));
    if guards {
        params.set_entropy_thold(ENTROPY_THOLD);
        params.set_logprob_thold(LOGPROB_THOLD);
    }
    if !tokens.is_empty() {
        params.set_tokens(&tokens);
    }

    state
        .full(params, pcm)
        .map_err(|e| format!("Whisper inference failed: {e}"))?;

    let n = state
        .full_n_segments()
        .map_err(|e| format!("reading Whisper output failed: {e}"))?;
    let mut out = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            if !(guards && is_note(&seg)) {
                out.push_str(&seg);
            }
        }
    }
    Ok(out.trim().to_string())
}

/// Resample mono `f32` PCM from `src_rate` down to 16 kHz for Whisper. Uses
/// rubato's windowed-sinc resampler (anti-aliased — a plain decimation would
/// fold high-frequency energy into the speech band). One-shot over the whole
/// utterance (batch mode); the last input chunk is zero-padded and the output is
/// trimmed to the mathematically-expected length. A no-op when already 16 kHz.
pub fn resample_to_16k(input: &[f32], src_rate: u32) -> Result<Vec<f32>, String> {
    if input.is_empty() {
        return Ok(Vec::new());
    }
    if src_rate == WHISPER_SAMPLE_RATE {
        return Ok(input.to_vec());
    }
    let ratio = WHISPER_SAMPLE_RATE as f64 / src_rate as f64;
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        oversampling_factor: 128,
        interpolation: SincInterpolationType::Linear,
        window: WindowFunction::BlackmanHarris2,
    };
    // `chunk_size` is the fixed input block SincFixedIn consumes per `process`.
    let chunk = 1024usize;
    let mut resampler = SincFixedIn::<f32>::new(ratio, 1.1, params, chunk, 1)
        .map_err(|e| format!("resampler init failed: {e}"))?;

    let expected = (input.len() as f64 * ratio).round() as usize;
    let mut out: Vec<f32> = Vec::with_capacity(expected + chunk);
    let mut pos = 0usize;
    while pos < input.len() {
        // For a fixed-input resampler this is constant (== chunk), but ask each
        // time so we stay correct if that ever changes.
        let need = resampler.input_frames_next();
        let end = (pos + need).min(input.len());
        let mut frame = Vec::with_capacity(need);
        frame.extend_from_slice(&input[pos..end]);
        frame.resize(need, 0.0); // zero-pad the final short chunk
        let res = resampler
            .process(&[frame], None)
            .map_err(|e| format!("resample failed: {e}"))?;
        out.extend_from_slice(&res[0]);
        pos = end;
    }
    out.truncate(expected);
    Ok(out)
}

// --- Model download + commands ---------------------------------------------

/// Progress for a Whisper model download. Mirrors `KokoroSetup`, plus which
/// model it is.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhisperSetup {
    /// `"model"` while downloading, `"done"` when finished.
    phase: String,
    model: &'static str,
    received: u64,
    total: u64,
}

/// One model in the settings UI's list (part of `dictation_status`).
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelStatus {
    pub id: &'static str,
    pub present: bool,
    /// The published file size.
    pub bytes: u64,
    /// Bytes an interrupted download left to resume from (0 if none).
    pub partial: u64,
}

/// Set the dictation engine setting, and with `whisper_model` the Whisper
/// model setting too.
#[tauri::command]
pub fn dictation_set_engine(
    whisper: tauri::State<'_, WhisperState>,
    engine: String,
    whisper_model: Option<String>,
) -> Result<(), String> {
    let engine = match engine.as_str() {
        "auto" | "apple" | "whisper" => engine,
        other => return Err(format!("unknown dictation engine '{other}'")),
    };
    if let Some(model) = whisper_model {
        let model = model_by_id(&model)?;
        whisper
            .db
            .set_setting(SETTING_WHISPER_MODEL, model.id)
            .map_err(|e| e.to_string())?;
    }
    whisper
        .db
        .set_setting(SETTING_DICTATION_ENGINE, &engine)
        .map_err(|e| e.to_string())
}

fn model_by_id(id: &str) -> Result<&'static WhisperModel, String> {
    MODELS
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown Whisper model '{id}'"))
}

/// Download a Whisper model (`base` by default, or `turbo`) into the app data
/// dir — idempotent, and resuming an interrupted download. Emits
/// `whisper-setup` progress events. Downloading turbo is the opt-in, so it
/// also becomes the model dictation runs.
///
/// It runs on the blocking pool (`OFF_MAIN_COMMANDS`) and drives the download
/// to its end there, rather than as an `async` command with a task type of
/// its own in the binary.
#[tauri::command]
pub fn whisper_install(
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
    model: Option<String>,
) -> Result<(), String> {
    let model = model_by_id(model.as_deref().unwrap_or(BASE_EN.id))?;
    tauri::async_runtime::block_on(install(&whisper, &app, model))
}

/// The download behind `whisper_install`, one at a time.
async fn install(whisper: &WhisperState, app: &AppHandle, model: &'static WhisperModel) -> Result<(), String> {
    let _one_at_a_time = whisper.download.lock().await;
    std::fs::create_dir_all(&whisper.whisper_dir)
        .map_err(|e| format!("could not create the Whisper directory: {e}"))?;
    let dest = whisper.path_of(model);
    if !dest.exists() {
        let emit = |phase: &str, received, total| {
            let _ = app.emit(
                "whisper-setup",
                WhisperSetup { phase: phase.to_string(), model: model.id, received, total },
            );
        };
        pinned_fetch::fetch_pinned(
            &whisper.http,
            &model.pin,
            &dest,
            "the Whisper model",
            DOWNLOAD_STALL,
            &|received, total| emit("model", received, total),
        )
        .await?;
        emit("done", 0, 0);
    }
    if model.id == TURBO.id {
        whisper
            .db
            .set_setting(SETTING_WHISPER_MODEL, TURBO.id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A 16 kHz, 16-bit mono WAV as `f32` samples (skips any chunk but `data`).
#[cfg(test)]
pub(crate) fn read_wav_16k(path: &str) -> Vec<f32> {
    let bytes = std::fs::read(path).unwrap();
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if &bytes[at..at + 4] == b"fmt " {
            let rate = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap());
            assert_eq!(rate, WHISPER_SAMPLE_RATE, "{path}");
        }
        if &bytes[at..at + 4] == b"data" {
            return bytes[at + 8..(at + 8 + len).min(bytes.len())]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk in {path}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> WhisperState {
        let db = Arc::new(Database::open_in_memory().unwrap());
        WhisperState::new(db, std::env::temp_dir())
    }

    #[test]
    fn engine_defaults_to_auto() {
        let ws = test_state();
        assert_eq!(ws.engine_setting(), "auto");
    }

    #[test]
    fn engine_setting_round_trips() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.set_setting(SETTING_DICTATION_ENGINE, "whisper").unwrap();
        let ws = WhisperState::new(db, std::env::temp_dir());
        assert_eq!(ws.engine_setting(), "whisper");
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("redline-whisper-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("whisper")).unwrap();
        dir
    }

    #[test]
    fn model_absent_on_a_fresh_dir() {
        let ws = WhisperState::new(Arc::new(Database::open_in_memory().unwrap()), scratch("fresh"));
        assert!(!ws.model_present());
        assert!(ws.statuses().iter().all(|s| !s.present && s.partial == 0));
    }

    #[test]
    fn base_runs_until_turbo_is_both_chosen_and_on_disk() {
        let only = |ids: &'static [&'static str]| move |m: &WhisperModel| ids.contains(&m.id);
        assert_eq!(resolve_model("base", only(&["base", "turbo"])).map(|m| m.id), Some("base"));
        assert_eq!(resolve_model("turbo", only(&["base", "turbo"])).map(|m| m.id), Some("turbo"));
        // Chosen but not downloaded (or deleted): base keeps dictation working.
        assert_eq!(resolve_model("turbo", only(&["base"])).map(|m| m.id), Some("base"));
        // Only turbo on disk runs whatever the setting says.
        assert_eq!(resolve_model("base", only(&["turbo"])).map(|m| m.id), Some("turbo"));
        assert!(resolve_model("", only(&[])).is_none());
    }

    #[test]
    fn the_model_setting_and_disk_pick_the_file_and_report_a_resumable_part() {
        let data = scratch("pick");
        let db = Arc::new(Database::open_in_memory().unwrap());
        let ws = WhisperState::new(db.clone(), data.clone());
        std::fs::write(data.join("whisper").join(BASE_EN.file), b"base").unwrap();
        std::fs::write(data.join("whisper").join(format!("{}.part", TURBO.file)), [0u8; 42]).unwrap();
        assert_eq!(ws.model().map(|m| m.id), Some("base"));
        db.set_setting(SETTING_WHISPER_MODEL, "turbo").unwrap();
        assert_eq!(ws.model().map(|m| m.id), Some("base"), "turbo is only half downloaded");
        let turbo = ws.statuses().into_iter().find(|s| s.id == "turbo").unwrap();
        assert_eq!((turbo.present, turbo.partial, turbo.bytes), (false, 42, TURBO.pin.bytes));
        std::fs::write(data.join("whisper").join(TURBO.file), b"turbo").unwrap();
        assert_eq!(ws.model().map(|m| m.id), Some("turbo"));
    }

    #[test]
    fn the_models_are_pinned_to_one_revision_of_their_published_files() {
        for m in MODELS {
            assert!(m.pin.url.ends_with(m.file), "{}", m.pin.url);
            assert!(m.pin.url.contains("/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/"));
            assert_eq!(m.pin.sha256.len(), 64);
        }
    }

    /// 16 kHz of `amp`-amplitude 220 Hz tone, `ms` long.
    fn tone(amp: f32, ms: usize) -> Vec<f32> {
        (0..WHISPER_SAMPLE_RATE as usize * ms / 1000)
            .map(|i| amp * (i as f32 / WHISPER_SAMPLE_RATE as f32 * 220.0 * std::f32::consts::TAU).sin())
            .collect()
    }

    #[test]
    fn the_gate_passes_speech_and_stops_silence_room_tone_and_a_faint_tick() {
        assert!(speech_gate(&tone(0.1, 800)), "an ordinary spoken level");
        assert!(!speech_gate(&[]));
        assert!(!speech_gate(&vec![0.0; 16_000]), "digital silence");
        assert!(!speech_gate(&tone(0.002, 2_000)), "room tone under the silence floor");
        // A steady hum loud enough to clear the silence floor, but with no
        // window that has a speech-like peak.
        assert!(!speech_gate(&tone(0.004, 2_000)), "a hum with no speech peak");
        // One sharp tick in a quiet second: a speech-like peak, but its window
        // is too quiet on average to be speech.
        let mut tick = vec![0.0005f32; 16_000];
        tick[8_000] = 0.06;
        assert!(!speech_gate(&tick), "a faint tick");
        // A short word inside a long silence still counts.
        let mut word = vec![0.0f32; 16_000];
        word.extend(tone(0.05, 120));
        word.extend(vec![0.0f32; 16_000]);
        assert!(speech_gate(&word));
    }

    #[test]
    fn the_vocabulary_prompt_is_only_built_after_the_gate_passes() {
        let vocab = vec!["Kokoro".to_string(), "VoicePanel".to_string()];
        assert_eq!(plan_decode(&vec![0.0; 16_000], &vocab), None, "silence: no decode, no prompt");
        let plan = plan_decode(&tone(0.1, 800), &vocab).expect("speech decodes");
        assert_eq!(plan.prompt.as_deref(), Some(" VoicePanel, Kokoro."));
        assert_eq!(plan_decode(&tone(0.1, 800), &[]), Some(DecodePlan { prompt: None }));
    }

    #[test]
    fn the_prompt_keeps_the_most_important_terms_and_puts_them_last() {
        let vocab: Vec<String> = (0..300).map(|i| format!("Term{i:03}")).collect();
        let prompt = vocab_prompt(&vocab).unwrap();
        assert!(prompt.len() <= PROMPT_MAX_BYTES + 2, "{}", prompt.len());
        assert!(prompt.ends_with("Term001, Term000."), "rank 0 sits nearest the audio");
        assert!(!prompt.contains("Term299"), "the least important are the ones left out");
    }

    #[test]
    fn notes_about_non_speech_are_told_from_words() {
        for note in ["[BLANK_AUDIO]", " [BLANK_AUDIO] [BLANK_AUDIO]", "(clapping)", "*static*", ".", " ♪ ", ""] {
            assert!(is_note(note), "{note:?}");
        }
        for words in ["Thank you.", "Use the (old) path", "[clap] Hello", "*really* fast", "(unclosed"] {
            assert!(!is_note(words), "{words:?}");
        }
    }

    #[test]
    fn decode_threads_are_three_quarters_of_the_cores_within_four_to_twelve() {
        assert_eq!(decode_threads(2), 4);
        assert_eq!(decode_threads(8), 6);
        assert_eq!(decode_threads(10), 7);
        assert_eq!(decode_threads(16), 12);
        assert_eq!(decode_threads(24), 12);
    }

    #[test]
    fn resample_noop_when_already_16k() {
        let input: Vec<f32> = (0..1000).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = resample_to_16k(&input, WHISPER_SAMPLE_RATE).unwrap();
        assert_eq!(out, input);
    }

    #[test]
    fn resample_empty_is_empty() {
        assert!(resample_to_16k(&[], 48_000).unwrap().is_empty());
    }

    #[test]
    fn resample_48k_to_16k_thirds_the_length() {
        // One second of 48 kHz → ~16 000 frames (ratio 1/3), within a small
        // tolerance for the resampler's edge handling.
        let src_rate = 48_000u32;
        let input: Vec<f32> = (0..src_rate)
            .map(|i| (i as f32 / src_rate as f32 * 440.0 * std::f32::consts::TAU).sin())
            .collect();
        let out = resample_to_16k(&input, src_rate).unwrap();
        let expected = WHISPER_SAMPLE_RATE as usize;
        let diff = (out.len() as isize - expected as isize).unsigned_abs();
        assert!(
            diff <= 8,
            "expected ~{expected} frames, got {} (diff {diff})",
            out.len()
        );
    }

    #[test]
    fn resample_44100_to_16k_matches_ratio() {
        let src_rate = 44_100u32;
        let input: Vec<f32> = (0..src_rate).map(|i| (i as f32 * 0.001).sin()).collect();
        let out = resample_to_16k(&input, src_rate).unwrap();
        let expected = (src_rate as f64 * WHISPER_SAMPLE_RATE as f64 / src_rate as f64).round();
        let expected = expected as usize; // == WHISPER_SAMPLE_RATE
        let diff = (out.len() as isize - expected as isize).unsigned_abs();
        assert!(diff <= 8, "got {} vs {expected}", out.len());
    }

    /// Accuracy harness over a spoken test set (opt-in; needs the models).
    /// `REDLINE_WHISPER_EVAL=<manifest.json>` (entries with `id`, `voice`,
    /// `file`: 16-bit mono WAV), `REDLINE_WHISPER_MODELS=<dir with the ggml
    /// files>`, `REDLINE_WHISPER_VOCAB=<JSON array>` and
    /// `REDLINE_WHISPER_OUT=<jsonl>`. Writes one line per clip and variant:
    /// each model bare (no gate, guards or prompt — the old path), gated and
    /// guarded without a prompt, and with the vocabulary prompt too (the
    /// shipping path); and "ungated", the shipping path without its gate,
    /// which shows what the gate saves on non-speech. `REDLINE_WHISPER_ONLY` and `REDLINE_WHISPER_VARIANTS`
    /// (comma lists) narrow the models and variants, and
    /// `REDLINE_WHISPER_PROMPT_FILE` replaces the built prompt with a file's
    /// text, to compare prompt formats.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs the Whisper models and a spoken test set"]
    fn whisper_accuracy_over_a_spoken_test_set() {
        use std::io::Write;
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let manifest: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(env("REDLINE_WHISPER_EVAL")).unwrap()).unwrap();
        let vocab: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(env("REDLINE_WHISPER_VOCAB")).unwrap()).unwrap();
        let models = PathBuf::from(env("REDLINE_WHISPER_MODELS"));
        let mut out = std::fs::File::create(env("REDLINE_WHISPER_OUT")).unwrap();
        let listed = |k: &str, v: &str| std::env::var(k).map_or(true, |l| l.split(',').any(|x| x == v));
        let prompt = match std::env::var("REDLINE_WHISPER_PROMPT_FILE") {
            Ok(path) => Some(std::fs::read_to_string(path).unwrap()),
            Err(_) => vocab_prompt(&vocab),
        };
        for model in MODELS {
            if !listed("REDLINE_WHISPER_ONLY", model.id) {
                continue;
            }
            let ctx = WhisperContext::new_with_params(
                &models.join(model.file).to_string_lossy(),
                WhisperContextParameters::default(),
            )
            .unwrap();
            for clip in &manifest {
                let pcm = read_wav_16k(clip["file"].as_str().unwrap());
                for (variant, guarded, gated, prompt) in [
                    ("bare", false, false, None),
                    ("guarded", true, true, None),
                    ("prompted", true, true, prompt.as_deref()),
                    ("ungated", true, false, prompt.as_deref()),
                ] {
                    if !listed("REDLINE_WHISPER_VARIANTS", variant) {
                        continue;
                    }
                    let started = std::time::Instant::now();
                    let text = if gated && !speech_gate(&pcm) {
                        String::new()
                    } else {
                        decode(&ctx, &pcm, prompt, guarded).unwrap()
                    };
                    let line = serde_json::json!({
                        "engine": format!("whisper-{}-{variant}", model.id),
                        "id": clip["id"], "voice": clip["voice"], "text": text,
                        "ms": started.elapsed().as_millis() as u64,
                    });
                    writeln!(out, "{line}").unwrap();
                }
            }
        }
    }
}

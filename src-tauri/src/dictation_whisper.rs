// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Local **Whisper** (whisper.cpp) speech-to-text — the higher-quality,
//! pluggable alternative to Apple's `SFSpeechRecognizer` for the voice agent's
//! push-to-talk microphone (`dictation.rs`). Whisper is what makes tools like
//! Wispr/OpenWhispr feel better: a stronger local model, not an input trick.
//!
//! This module owns everything that is *not* audio capture:
//!   - **Model management** — the ~140 MB `ggml-base.en.bin` is downloaded on
//!     first use into the app data dir (`<data>/whisper/`), mirroring the Kokoro
//!     TTS model download (`tts.rs`). End users install nothing; whisper.cpp is
//!     compiled into the binary at build time and Metal-accelerated on Apple
//!     silicon.
//!   - **The resident model** — a lazily-loaded `WhisperContext` kept warm behind
//!     a `Mutex`, so only the first utterance pays the model-load cost. Released
//!     on app exit (`RunEvent::Exit`), like the warm Kokoro sidecar.
//!   - **Inference** — [`WhisperState::transcribe`] turns one accumulated
//!     utterance (16 kHz mono `f32`) into text. It is blocking (whisper.cpp is
//!     CPU/GPU-bound), so callers run it under `tokio::task::spawn_blocking`.
//!   - **Resampling** — [`resample_to_16k`] converts the microphone's
//!     hardware-rate PCM (44.1/48 kHz) down to the 16 kHz Whisper requires. This
//!     is the one piece exercised by `cargo test`; the whisper.cpp / Metal path
//!     needs a signed on-device run (same caveat as the rest of the voice work).
//!
//! The *audio tee* (extracting PCM from the live mic tap into the accumulator)
//! lives in `dictation.rs` next to the AVAudioEngine plumbing; this module only
//! consumes the finished sample buffer.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::Database;

#[cfg(target_os = "macos")]
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

/// DB setting: which dictation recognizer to use. `auto` (default) prefers
/// Whisper when its model is present, else Apple; `apple` / `whisper` force one.
/// Mirrors `SETTING_ENGINE` in `tts.rs` — a plain key in `app_settings`.
pub const SETTING_DICTATION_ENGINE: &str = "dictation_engine";

/// Sample rate Whisper expects — all whisper.cpp models are trained on 16 kHz.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// The default model: `base.en` (~142 MB) — a good quality/latency balance for
/// English push-to-talk. Made a const so `small.en` / `large-v3-turbo` is a
/// one-line swap (bump both the filename and the URL together).
const WHISPER_MODEL_FILE: &str = "ggml-base.en.bin";
const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

/// Emit a download-progress event roughly every megabyte (as `tts.rs` does for
/// Kokoro), so the bar moves without flooding the IPC channel.
const WHISPER_PROGRESS_STEP: u64 = 1_000_000;

/// Whisper backend state, managed by Tauri next to `DictationState` / `TtsState`.
/// Carries the DB (engine setting), a reused HTTP client for the model download,
/// the model directory, and the lazily-loaded resident model. Cloneable (all
/// fields are `Arc`/cheap) so it can be moved into `spawn_blocking`.
#[derive(Clone)]
pub struct WhisperState {
    db: Arc<Database>,
    http: reqwest::Client,
    whisper_dir: PathBuf,
    /// The resident whisper.cpp model, loaded on first transcription and kept
    /// warm across utterances. `None` until first use / after teardown.
    /// `WhisperContext` is `Send + Sync` (the crate guarantees it), so it lives
    /// happily behind a plain `Mutex` in shared state.
    #[cfg(target_os = "macos")]
    ctx: Arc<Mutex<Option<WhisperContext>>>,
}

impl WhisperState {
    pub fn new(db: Arc<Database>, data_dir: PathBuf) -> Self {
        Self {
            db,
            http: reqwest::Client::new(),
            whisper_dir: data_dir.join("whisper"),
            #[cfg(target_os = "macos")]
            ctx: Arc::new(Mutex::new(None)),
        }
    }

    fn model_path(&self) -> PathBuf {
        self.whisper_dir.join(WHISPER_MODEL_FILE)
    }

    /// The Whisper model file has finished downloading.
    pub fn model_present(&self) -> bool {
        self.model_path().exists()
    }

    /// The configured engine setting (`auto` / `apple` / `whisper`), defaulting
    /// to `auto`.
    pub fn engine_setting(&self) -> String {
        self.db
            .get_setting(SETTING_DICTATION_ENGINE)
            .unwrap_or_else(|| "auto".to_string())
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

    /// Transcribe one accumulated utterance (16 kHz mono `f32`) to text.
    /// **Blocking** — whisper.cpp inference is CPU/GPU-bound; call under
    /// `tokio::task::spawn_blocking`. Loads the resident model on first use.
    #[cfg(target_os = "macos")]
    pub fn transcribe(&self, pcm_16k_mono: &[f32]) -> Result<String, String> {
        if pcm_16k_mono.is_empty() {
            return Ok(String::new());
        }
        let mut guard = self
            .ctx
            .lock()
            .map_err(|_| "whisper model lock poisoned".to_string())?;
        if guard.is_none() {
            let path = self.model_path();
            if !path.exists() {
                return Err("the Whisper model isn't installed yet".to_string());
            }
            let ctx = WhisperContext::new_with_params(
                &path.to_string_lossy(),
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("failed to load the Whisper model: {e}"))?;
            *guard = Some(ctx);
        }
        let ctx = guard.as_ref().expect("model loaded above");
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("failed to create the Whisper state: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Use most cores but leave headroom for the UI thread; cap so a big
        // machine doesn't oversubscribe on a short utterance.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .clamp(1, 8);
        params.set_n_threads(threads);

        state
            .full(params, pcm_16k_mono)
            .map_err(|e| format!("Whisper inference failed: {e}"))?;

        let n = state
            .full_n_segments()
            .map_err(|e| format!("reading Whisper output failed: {e}"))?;
        let mut out = String::new();
        for i in 0..n {
            if let Ok(seg) = state.full_get_segment_text(i) {
                out.push_str(&seg);
            }
        }
        Ok(out.trim().to_string())
    }
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

/// Progress for the one-time Whisper model download. Mirrors `KokoroSetup`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhisperSetup {
    /// `"model"` while downloading, `"done"` when finished.
    phase: String,
    received: u64,
    total: u64,
}

/// Whether the Whisper model is installed — for the settings UI and the `auto`
/// engine resolution.
#[tauri::command]
pub fn whisper_model_present(whisper: tauri::State<'_, WhisperState>) -> bool {
    whisper.model_present()
}

/// Get the dictation engine setting (`auto` / `apple` / `whisper`).
#[tauri::command]
pub fn dictation_get_engine(whisper: tauri::State<'_, WhisperState>) -> String {
    whisper.engine_setting()
}

/// Set the dictation engine setting.
#[tauri::command]
pub fn dictation_set_engine(
    whisper: tauri::State<'_, WhisperState>,
    engine: String,
) -> Result<(), String> {
    let engine = match engine.as_str() {
        "auto" | "apple" | "whisper" => engine,
        other => return Err(format!("unknown dictation engine '{other}'")),
    };
    whisper
        .db
        .set_setting(SETTING_DICTATION_ENGINE, &engine)
        .map_err(|e| e.to_string())
}

/// Download the Whisper model into the app data dir (idempotent — skips a file
/// already present). Emits `whisper-setup` progress events, mirroring the Kokoro
/// `kokoro-setup` pattern the TTS settings UI already renders.
#[tauri::command]
pub async fn whisper_install(
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
) -> Result<(), String> {
    tokio::fs::create_dir_all(&whisper.whisper_dir)
        .await
        .map_err(|e| format!("could not create the Whisper directory: {e}"))?;
    download_if_missing(&whisper, &app, WHISPER_MODEL_URL, &whisper.model_path()).await?;
    let _ = app.emit(
        "whisper-setup",
        WhisperSetup {
            phase: "done".to_string(),
            received: 0,
            total: 0,
        },
    );
    Ok(())
}

/// Streaming download to a `.part` sibling + atomic rename, so a crash mid-way
/// never leaves a truncated file that looks complete. Emits `whisper-setup`.
async fn download_if_missing(
    whisper: &WhisperState,
    app: &AppHandle,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    let tmp = dest.with_extension("part");
    let mut resp = whisper
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("downloading the Whisper model failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "downloading the Whisper model failed: HTTP {}",
            resp.status()
        ));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("creating the Whisper model file failed: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let _ = app.emit(
        "whisper-setup",
        WhisperSetup {
            phase: "model".to_string(),
            received: 0,
            total,
        },
    );
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("downloading the Whisper model failed: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("writing the Whisper model failed: {e}"))?;
        received += chunk.len() as u64;
        if received - last_emit >= WHISPER_PROGRESS_STEP {
            last_emit = received;
            let _ = app.emit(
                "whisper-setup",
                WhisperSetup {
                    phase: "model".to_string(),
                    received,
                    total,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("flushing the Whisper model failed: {e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| format!("finalizing the Whisper model failed: {e}"))?;
    Ok(())
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

    #[test]
    fn model_absent_on_a_fresh_dir() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let dir = std::env::temp_dir().join(format!("redline-whisper-test-{}", std::process::id()));
        let ws = WhisperState::new(db, dir);
        assert!(!ws.model_present());
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
}

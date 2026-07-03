// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Native, on-device speech-to-text for the voice agent's push-to-talk
//! microphone (Phase 2). macOS only: `SFSpeechRecognizer` with
//! `requiresOnDeviceRecognition` does the recognition (private, no network),
//! while an `AVAudioEngine` mic tap streams PCM buffers into the recognition
//! request. Partial transcripts stream out as `dictation-partial` while the
//! reviewer holds the talk button; releasing it calls `dictation_stop`, which
//! returns the latest transcript (and emits `dictation-final`) so the panel can
//! hand it straight to `voice_send`.
//!
//! **Full-duplex hands-free.** For the always-on voice conversation the mic
//! stays open continuously — even while the agent speaks — so the user can talk
//! over it and interrupt. That's only safe because `start_capture` enables Apple
//! voice-processing (`setVoiceProcessingEnabled`), i.e. acoustic echo
//! cancellation, so the open mic doesn't transcribe the agent's own TTS. Between
//! utterances the panel calls `dictation_cycle`, which finalizes the current
//! transcript and re-arms a fresh recognition task on the SAME running engine —
//! the microphone never closes and voice processing stays on.
//!
//! Unlike the warm `claude` child in `voice.rs`, there is no subprocess here —
//! just live Apple objects. They are all main-thread-affine, so every native
//! call is marshalled onto the UI thread with `AppHandle::run_on_main_thread`
//! (the same thread Tauri runs the window on). The live objects live in
//! `DictationState` behind an unsafe `Send` wrapper whose invariant is exactly
//! that: only ever touched on the main thread.
//!
//! **Untestable by `cargo test`.** The `unsafe` objc2 path against
//! `SFSpeechRecognizer` / `AVAudioEngine` and the TCC mic/speech prompts can
//! only be exercised by a signed run on a real machine — see the Phase 2
//! verification notes. The unit tests below cover only the plain-Rust glue.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dictation_whisper::{self, WhisperState};

#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_avf_audio::{
    AVAudioEngine, AVAudioFormat, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSError;
#[cfg(target_os = "macos")]
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationText {
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationErr {
    error: String,
}

fn emit_partial(app: &AppHandle, text: String) {
    let _ = app.emit("dictation-partial", DictationText { text });
}

fn emit_final(app: &AppHandle, text: String) {
    let _ = app.emit("dictation-final", DictationText { text });
}

fn emit_error(app: &AppHandle, error: impl Into<String>) {
    let _ = app.emit(
        "dictation-error",
        DictationErr {
            error: error.into(),
        },
    );
}

// --- Engine ----------------------------------------------------------------

/// Which recognizer produces the final transcript. Both paths share the one
/// live `AVAudioEngine` mic capture — Apple's on-device `SFSpeechRecognizer`
/// always runs (it's what streams `dictation-partial`s and drives hands-free
/// VAD). The difference is only *who produces the final text on release*:
///   - `Apple`   — `dictation_stop` returns Apple's latest transcript (today's
///     behaviour), zero extra work.
///   - `Whisper` — the mic tap *also* tees PCM into an accumulator; on release
///     `dictation_stop` resamples it to 16 kHz and runs local whisper.cpp for a
///     stronger transcript. Batch-only (no mid-utterance partials), so the
///     always-on Apple recognizer still covers hands-free segmentation — see
///     `dictation_cycle`, which stays on Apple's partial-driven path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Engine {
    Apple,
    Whisper,
}

/// Resolve the engine for a capture from the `auto`/`apple`/`whisper` setting:
/// `whisper` requires the model to be present (else Apple), `auto` prefers
/// Whisper whenever its model is installed.
fn resolve_engine(whisper: &WhisperState) -> Engine {
    match whisper.engine_setting().as_str() {
        "apple" => Engine::Apple,
        "whisper" | "auto" if whisper.model_present() => Engine::Whisper,
        _ => Engine::Apple,
    }
}

// --- State -----------------------------------------------------------------

/// One live dictation session — the Apple objects kept alive for the duration
/// of a press-and-hold. Dropping it releases them (objc release is
/// thread-safe). The retained blocks are kept here so they outlive the tap /
/// recognition task that copied them.
#[cfg(target_os = "macos")]
struct DictationSession {
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    /// Kept live for the whole capture and reused across utterances by
    /// `dictation_cycle` (a fresh recognition task on the same running engine).
    recognizer: Retained<SFSpeechRecognizer>,
    task: Retained<SFSpeechRecognitionTask>,
    _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    _result_handler: RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
}

// SAFETY: every field is an Apple object (or a block) that is only ever created,
// mutated, and dropped inside an `AppHandle::run_on_main_thread` closure — i.e.
// always on the UI thread. The recognition/tap blocks are invoked by the system
// on its own queues, but those invocations only read through the retained copies
// the system holds; they never touch this struct. So it is never actually shared
// across threads despite living in `Send` managed state.
#[cfg(target_os = "macos")]
unsafe impl Send for DictationSession {}

struct DictationInner {
    /// A capture is live (between `dictation_start` and `dictation_stop`).
    active: AtomicBool,
    /// The most recent transcript seen from the recognizer. `dictation_stop`
    /// returns this immediately rather than waiting for the lagging `isFinal`.
    latest: Mutex<String>,
    /// Engine resolved once per capture in `dictation_start`.
    engine: Mutex<Engine>,
    /// Whisper only: the mic tap tees hardware-rate mono `f32` PCM here for the
    /// whole utterance; `dictation_stop` drains and transcribes it. Cleared on
    /// each new capture / cycle / kill.
    #[cfg(target_os = "macos")]
    whisper_pcm: Mutex<Vec<f32>>,
    /// The mic's hardware sample rate (from the input node's format), captured
    /// when the tap is armed — needed to resample the accumulator to 16 kHz.
    #[cfg(target_os = "macos")]
    whisper_src_rate: AtomicU32,
    #[cfg(target_os = "macos")]
    session: Mutex<Option<DictationSession>>,
}

/// Push-to-talk dictation, managed as Tauri state. One capture at a time
/// (it's a held button). Cloneable so it can be moved into main-thread closures
/// and completion blocks; the `Arc` keeps a single shared inner.
#[derive(Clone)]
pub struct DictationState {
    inner: Arc<DictationInner>,
}

impl Default for DictationState {
    fn default() -> Self {
        Self::new()
    }
}

impl DictationState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(DictationInner {
                active: AtomicBool::new(false),
                latest: Mutex::new(String::new()),
                engine: Mutex::new(Engine::Apple),
                #[cfg(target_os = "macos")]
                whisper_pcm: Mutex::new(Vec::new()),
                #[cfg(target_os = "macos")]
                whisper_src_rate: AtomicU32::new(0),
                #[cfg(target_os = "macos")]
                session: Mutex::new(None),
            }),
        }
    }

    /// Tear down any live capture — backs `dictation_kill_all` and app teardown.
    pub fn kill_all(&self) {
        self.inner.active.store(false, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        {
            self.inner.whisper_pcm.lock().unwrap().clear();
            // Exit runs on the main thread (Tauri's run loop), so stopping the
            // engine here is safe; otherwise the `Drop` of the taken session
            // releases everything regardless.
            if let Some(session) = self.inner.session.lock().unwrap().take() {
                // SAFETY: main thread; the session's objects are still live.
                unsafe {
                    session.engine.stop();
                    session.input.removeTapOnBus(0);
                    session.request.endAudio();
                    session.task.cancel();
                }
            }
        }
    }
}

// --- Commands --------------------------------------------------------------

/// Begin push-to-talk capture. Emits `dictation-partial` as the reviewer
/// speaks and `dictation-error` if recognition can't start. Idempotent: a
/// second call while already listening is a no-op. On first use this triggers
/// the speech-recognition and microphone permission prompts.
#[tauri::command]
pub fn dictation_start(
    dictation: tauri::State<'_, DictationState>,
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
) -> Result<(), String> {
    // Claim the slot up front so a double-press can't spin up two engines.
    if dictation.inner.active.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    *dictation.inner.latest.lock().unwrap() = String::new();
    // Resolve the recognizer once for this capture (before the tap is armed).
    *dictation.inner.engine.lock().unwrap() = resolve_engine(&whisper);
    #[cfg(target_os = "macos")]
    dictation.inner.whisper_pcm.lock().unwrap().clear();

    #[cfg(target_os = "macos")]
    {
        let state = dictation.inner.clone();
        let app_main = app.clone();
        app.run_on_main_thread(move || authorize_then_capture(app_main, state))
            .map_err(|e| {
                dictation.inner.active.store(false, Ordering::SeqCst);
                format!("failed to schedule dictation start: {e}")
            })?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        dictation.inner.active.store(false, Ordering::SeqCst);
        Err("dictation is only available on macOS".to_string())
    }
}

/// Stop push-to-talk capture and return the final transcript, tearing the engine
/// down on the main thread and emitting `dictation-final`.
///
/// - **Apple engine:** returns the latest partial immediately (push-to-talk
///   shouldn't wait for the recognizer's lagging final pass) — today's behaviour.
/// - **Whisper engine:** after teardown, drains the accumulated PCM, resamples
///   it to 16 kHz, and runs local whisper.cpp (off the async runtime via
///   `spawn_blocking`) for a stronger transcript. If inference fails or yields
///   nothing, it falls back to whatever Apple heard. This is why the command is
///   `async` — the (short) inference completes before the return value the
///   push-to-talk UI reads.
#[tauri::command]
pub async fn dictation_stop(
    dictation: tauri::State<'_, DictationState>,
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
) -> Result<String, String> {
    dictation.inner.active.store(false, Ordering::SeqCst);
    // Apple's latest — the immediate answer for the Apple engine, and the
    // fallback if Whisper inference fails.
    let apple_text = dictation.inner.latest.lock().unwrap().clone();

    #[cfg(target_os = "macos")]
    {
        let engine = *dictation.inner.engine.lock().unwrap();
        let state = dictation.inner.clone();
        // Tear the engine down on the UI thread. For Whisper we must know the tap
        // has been removed before draining (so no late buffer races the drain),
        // so signal completion back over a oneshot and await it.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let scheduled = app.run_on_main_thread(move || {
            if let Some(session) = state.session.lock().unwrap().take() {
                // SAFETY: main thread; the session's objects are still live.
                unsafe {
                    session.engine.stop();
                    session.input.removeTapOnBus(0);
                    session.request.endAudio();
                    session.task.finish();
                }
            }
            let _ = tx.send(());
        });
        // If scheduling failed the session is reclaimed on next start / exit;
        // don't hang waiting for a signal that will never come.
        if scheduled.is_ok() {
            let _ = rx.await;
        }

        if engine == Engine::Whisper {
            let pcm: Vec<f32> =
                std::mem::take(&mut *dictation.inner.whisper_pcm.lock().unwrap());
            let src_rate = dictation.inner.whisper_src_rate.load(Ordering::SeqCst);
            // Surfaces whether the mic tee actually accumulated (0 samples ⇒ the
            // tap tee isn't feeding, and we'll fall back to Apple below).
            tracing::debug!(
                target: "dictation",
                pcm_samples = pcm.len(),
                src_rate,
                "whisper utterance drain"
            );
            // Whisper's stronger transcript when it produced one; otherwise fall
            // back to Apple's live transcript. Whisper can come up empty from a
            // genuine silence, an inference error, OR an empty capture (the mic
            // tee not accumulating) — in every one of those cases the user's
            // words must still land in the chat, and Apple's always-on recognizer
            // already heard them. Never return "" when Apple has text.
            let whisper_text = match transcribe_utterance(
                whisper.inner().clone(),
                pcm,
                src_rate,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(target: "dictation", "Whisper failed, using Apple: {e}");
                    String::new()
                }
            };
            let final_text = if whisper_text.trim().is_empty() {
                apple_text
            } else {
                whisper_text
            };
            *dictation.inner.latest.lock().unwrap() = final_text.clone();
            emit_final(&app, final_text.clone());
            return Ok(final_text);
        }
    }

    emit_final(&app, apple_text.clone());
    Ok(apple_text)
}

/// Resample one accumulated utterance to 16 kHz and run Whisper on it, off the
/// async runtime (`spawn_blocking`) since inference is CPU/GPU-bound.
#[cfg(target_os = "macos")]
async fn transcribe_utterance(
    whisper: WhisperState,
    pcm: Vec<f32>,
    src_rate: u32,
) -> Result<String, String> {
    if pcm.is_empty() || src_rate == 0 {
        return Ok(String::new());
    }
    tokio::task::spawn_blocking(move || {
        let mono_16k = dictation_whisper::resample_to_16k(&pcm, src_rate)?;
        whisper.transcribe(&mono_16k)
    })
    .await
    .map_err(|e| format!("transcription task failed: {e}"))?
}

/// Commit the current utterance and immediately re-arm a fresh recognition on
/// the SAME running engine, returning the finalized transcript. Unlike
/// `dictation_stop`, the microphone never closes — this is the per-utterance
/// boundary of a continuous, full-duplex conversation: the caller sends the
/// returned text as a turn while the mic keeps listening (so the user can talk
/// over the agent's reply). A no-op returning "" if no capture is live.
#[tauri::command]
pub fn dictation_cycle(
    dictation: tauri::State<'_, DictationState>,
    app: AppHandle,
) -> Result<String, String> {
    if !dictation.inner.active.load(Ordering::SeqCst) {
        return Ok(String::new());
    }
    let text = dictation.inner.latest.lock().unwrap().clone();

    #[cfg(target_os = "macos")]
    {
        let state = dictation.inner.clone();
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let mut guard = state.session.lock().unwrap();
            if let Some(session) = guard.as_mut() {
                // Finalize the current utterance's recognition and detach its tap.
                // SAFETY: main thread; the session's objects are still live.
                unsafe {
                    session.input.removeTapOnBus(0);
                    session.request.endAudio();
                    session.task.finish();
                }
                // Fresh transcript for the next utterance.
                *state.latest.lock().unwrap() = String::new();
                // Hands-free stays on Apple's partial-driven path (batch Whisper
                // can't segment on VAD); drop any teed PCM so it can't grow
                // across the conversation.
                state.whisper_pcm.lock().unwrap().clear();
                // Re-arm on the SAME running engine — the mic never closes and
                // voice processing stays enabled (the engine isn't stopped).
                // SAFETY: main thread; input/recognizer are still live.
                let format = unsafe { session.input.outputFormatForBus(0) };
                let (request, task, tap, result_handler) =
                    arm_recognition(&app_main, &state, &session.recognizer, &session.input, &format);
                session.request = request;
                session.task = task;
                session._tap = tap;
                session._result_handler = result_handler;
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app;

    Ok(text)
}

/// Stop any live capture — also invoked on app teardown.
#[tauri::command]
pub fn dictation_kill_all(dictation: tauri::State<'_, DictationState>) -> Result<(), String> {
    dictation.kill_all();
    Ok(())
}

// --- Native capture (macOS) ------------------------------------------------

/// Gate capture behind speech-recognition authorization. On the main thread.
#[cfg(target_os = "macos")]
fn authorize_then_capture(app: AppHandle, state: Arc<DictationInner>) {
    // SAFETY: on the main thread; `authorizationStatus` is a pure class read.
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status.0 == SFSpeechRecognizerAuthorizationStatus::Authorized.0 {
        start_capture(&app, &state);
        return;
    }
    if status.0 == SFSpeechRecognizerAuthorizationStatus::NotDetermined.0 {
        // First use: ask. The completion block fires on an arbitrary queue, so
        // it bounces start-up back onto the main thread.
        let app_cb = app.clone();
        let state_cb = state.clone();
        let handler = RcBlock::new(move |granted: SFSpeechRecognizerAuthorizationStatus| {
            let app_main = app_cb.clone();
            let state_main = state_cb.clone();
            let authorized = granted.0 == SFSpeechRecognizerAuthorizationStatus::Authorized.0;
            let _ = app_cb.run_on_main_thread(move || {
                if authorized {
                    start_capture(&app_main, &state_main);
                } else {
                    state_main.active.store(false, Ordering::SeqCst);
                    emit_error(
                        &app_main,
                        "Speech recognition permission was denied. Enable it for \
                         Redline under System Settings → Privacy & Security → \
                         Speech Recognition.",
                    );
                }
            });
        });
        // SAFETY: main thread; the system copies and retains the handler block.
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        return;
    }
    // Denied / Restricted.
    state.active.store(false, Ordering::SeqCst);
    emit_error(
        &app,
        "Speech recognition isn't authorized for Redline. Enable it under \
         System Settings → Privacy & Security → Speech Recognition.",
    );
}

/// Build a fresh recognition request + task + mic tap on an existing engine's
/// input node, wiring partials to `dictation-partial` and installing the tap.
/// Shared by `start_capture` (first arm) and `dictation_cycle` (per-utterance
/// re-arm on the still-running engine, so the mic never closes between turns).
/// `format` is the input node's output format *after* voice processing is
/// enabled. Main thread; the returned blocks are retained by the caller.
#[cfg(target_os = "macos")]
#[allow(clippy::type_complexity)]
fn arm_recognition(
    app: &AppHandle,
    state: &Arc<DictationInner>,
    recognizer: &SFSpeechRecognizer,
    input: &AVAudioInputNode,
    format: &AVAudioFormat,
) -> (
    Retained<SFSpeechAudioBufferRecognitionRequest>,
    Retained<SFSpeechRecognitionTask>,
    RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
) {
    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        // Private + offline — the locked design (no audio leaves the device).
        request.setRequiresOnDeviceRecognition(true);
    }

    // Results stream in on the recognizer's queue: stash the latest text (so
    // `dictation_stop`/`dictation_cycle` can return it) and push a partial.
    let app_res = app.clone();
    let state_res = state.clone();
    let result_handler = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            // SAFETY: the recognizer hands back a valid result or error pointer.
            if let Some(result) = unsafe { result.as_ref() } {
                let text = unsafe { result.bestTranscription().formattedString() }.to_string();
                *state_res.latest.lock().unwrap() = text.clone();
                emit_partial(&app_res, text);
            } else if let Some(error) = unsafe { error.as_ref() } {
                emit_error(&app_res, error.localizedDescription().to_string());
            }
        },
    );
    let task =
        unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &result_handler) };

    // Whisper tee: when this capture uses the Whisper engine, the tap *also*
    // extracts mono `f32` samples and appends them to the accumulator (Apple's
    // recognizer still runs — it drives partials / hands-free). Record the
    // hardware sample rate once so `dictation_stop` can resample to 16 kHz.
    let engine = *state.engine.lock().unwrap();
    if engine == Engine::Whisper {
        // SAFETY: main thread; reading the format's rate is a pure getter.
        let rate = unsafe { format.sampleRate() } as u32;
        state.whisper_src_rate.store(rate, Ordering::SeqCst);
    }

    // Mic tap: forward every captured PCM buffer into the recognition request.
    // The request is `Retained`-cloned (+1) into the block so it outlives this
    // stack frame.
    let request_tap = request.clone();
    let state_tap = state.clone();
    let tap = RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            // SAFETY: CoreAudio passes a live, non-null PCM buffer per tap call.
            unsafe { request_tap.appendAudioPCMBuffer(buffer.as_ref()) };
            if engine == Engine::Whisper {
                // SAFETY: the same live buffer, read-only, on CoreAudio's thread.
                if let Some(mono) = unsafe { extract_mono_f32(buffer.as_ref()) } {
                    state_tap.whisper_pcm.lock().unwrap().extend_from_slice(&mono);
                }
            }
        },
    );
    // SAFETY: main thread; installing a tap on a (possibly already running)
    // engine's input bus is supported.
    unsafe {
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(format), RcBlock::as_ptr(&tap));
    }
    (request, task, tap, result_handler)
}

/// Build the recognizer + audio engine, enable echo cancellation, arm the first
/// recognition, and start the engine. Runs on the main thread; on any failure it
/// clears `active` and emits `dictation-error`.
#[cfg(target_os = "macos")]
fn start_capture(app: &AppHandle, state: &Arc<DictationInner>) {
    // SAFETY (whole fn): on the UI thread; every object is freshly created and
    // owned here, and the blocks are retained for the session's lifetime.
    let recognizer = unsafe { SFSpeechRecognizer::new() };
    if !unsafe { recognizer.isAvailable() } {
        state.active.store(false, Ordering::SeqCst);
        emit_error(app, "Speech recognition is currently unavailable.");
        return;
    }

    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    // NOTE: Apple voice-processing (acoustic echo cancellation) — the foundation
    // of full-duplex talk-over — is intentionally NOT enabled here yet. Turning it
    // on before the microphone is authorized appeared to leave the input open but
    // silent (captured no audio), so it needs on-device iteration before it ships.
    // Until then dictation is plain half-duplex capture (the known-good path).
    // The tap must use the input node's own output format, or CoreAudio throws
    // when the tap format doesn't match the hardware.
    let format = unsafe { input.outputFormatForBus(0) };

    let (request, task, tap, result_handler) =
        arm_recognition(app, state, &recognizer, &input, &format);

    unsafe { engine.prepare() };

    if let Err(err) = unsafe { engine.startAndReturnError() } {
        unsafe {
            input.removeTapOnBus(0);
            task.cancel();
        }
        state.active.store(false, Ordering::SeqCst);
        emit_error(
            app,
            format!(
                "Couldn't start the microphone: {}",
                err.localizedDescription()
            ),
        );
        return;
    }

    *state.session.lock().unwrap() = Some(DictationSession {
        engine,
        input,
        request,
        recognizer,
        task,
        _tap: tap,
        _result_handler: result_handler,
    });
}

/// Extract one mic tap's PCM as mono `f32`, downmixing multi-channel input by
/// averaging. Returns `None` for an empty buffer or a non-float format (where
/// `floatChannelData` is null). The input node's tap format is standard
/// deinterleaved float32, so frames within a channel are `stride` apart and each
/// channel has its own pointer.
///
/// SAFETY: `buffer` must be a live `AVAudioPCMBuffer` for the duration of the
/// call (CoreAudio guarantees this inside the tap block).
#[cfg(target_os = "macos")]
unsafe fn extract_mono_f32(buffer: &AVAudioPCMBuffer) -> Option<Vec<f32>> {
    let frames = buffer.frameLength() as usize;
    if frames == 0 {
        return None;
    }
    let ch_data = buffer.floatChannelData();
    if ch_data.is_null() {
        return None;
    }
    let channels = (buffer.format().channelCount() as usize).max(1);
    let stride = (buffer.stride() as usize).max(1);
    let mut out = Vec::with_capacity(frames);
    if channels == 1 {
        let ch0 = (*ch_data).as_ptr();
        for f in 0..frames {
            out.push(*ch0.add(f * stride));
        }
    } else {
        let inv = 1.0 / channels as f32;
        for f in 0..frames {
            let mut sum = 0.0f32;
            for c in 0..channels {
                let ptr = (*ch_data.add(c)).as_ptr();
                sum += *ptr.add(f * stride);
            }
            out.push(sum * inv);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_state_is_inactive_with_empty_transcript() {
        let state = DictationState::new();
        assert!(!state.inner.active.load(Ordering::SeqCst));
        assert_eq!(*state.inner.latest.lock().unwrap(), "");
    }

    #[test]
    fn kill_all_clears_active() {
        let state = DictationState::new();
        state.inner.active.store(true, Ordering::SeqCst);
        state.kill_all();
        assert!(!state.inner.active.load(Ordering::SeqCst));
    }

    #[test]
    fn dictation_text_payload_serializes_camel_case() {
        let v = serde_json::to_value(DictationText {
            text: "hello".into(),
        })
        .unwrap();
        assert_eq!(v["text"], "hello");
    }
}

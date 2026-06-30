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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
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
    _recognizer: Retained<SFSpeechRecognizer>,
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
    app: AppHandle,
) -> Result<(), String> {
    // Claim the slot up front so a double-press can't spin up two engines.
    if dictation.inner.active.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    *dictation.inner.latest.lock().unwrap() = String::new();

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

/// Stop push-to-talk capture and return the latest transcript. Returns
/// immediately with the most recent partial (push-to-talk shouldn't wait for
/// the recognizer's lagging final pass) and tears the engine down on the main
/// thread. Also emits `dictation-final` for any listener that prefers the event.
#[tauri::command]
pub fn dictation_stop(
    dictation: tauri::State<'_, DictationState>,
    app: AppHandle,
) -> Result<String, String> {
    dictation.inner.active.store(false, Ordering::SeqCst);
    let text = dictation.inner.latest.lock().unwrap().clone();

    #[cfg(target_os = "macos")]
    {
        let state = dictation.inner.clone();
        // Best-effort teardown on the UI thread; ignore the (rare) schedule
        // failure — the session would then be reclaimed on next start / exit.
        let _ = app.run_on_main_thread(move || {
            if let Some(session) = state.session.lock().unwrap().take() {
                // SAFETY: main thread; the session's objects are still live.
                unsafe {
                    session.engine.stop();
                    session.input.removeTapOnBus(0);
                    session.request.endAudio();
                    session.task.finish();
                }
            }
        });
    }

    emit_final(&app, text.clone());
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

/// Build the recognizer + request + audio engine, wire the mic tap to the
/// request and the recognition results to `dictation-*` events, and start the
/// engine. Runs on the main thread; on any failure it clears `active` and emits
/// `dictation-error`.
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

    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        // Private + offline — the locked design (no audio leaves the device).
        request.setRequiresOnDeviceRecognition(true);
    }

    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    // The tap must use the input node's own output format, or CoreAudio throws
    // when the tap format doesn't match the hardware.
    let format = unsafe { input.outputFormatForBus(0) };

    // Results stream in on the recognizer's queue: stash the latest text (so
    // `dictation_stop` can return it) and push a `dictation-partial`.
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

    // Mic tap: forward every captured PCM buffer into the recognition request.
    // The request is `Retained`-cloned (+1) into the block so it outlives this
    // stack frame.
    let request_tap = request.clone();
    let tap = RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            // SAFETY: CoreAudio passes a live, non-null PCM buffer per tap call.
            unsafe { request_tap.appendAudioPCMBuffer(buffer.as_ref()) };
        },
    );
    unsafe {
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
        engine.prepare();
    }

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
        _recognizer: recognizer,
        task,
        _tap: tap,
        _result_handler: result_handler,
    });
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

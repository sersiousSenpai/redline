// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Native, on-device speech-to-text: dictation into any composer, and the voice
//! agent's microphone. macOS only: `SFSpeechRecognizer` with
//! `requiresOnDeviceRecognition` does the recognition (private, no network),
//! while an `AVAudioEngine` mic tap streams PCM buffers into the recognition
//! request. Partial transcripts stream out as `dictation-partial` while the
//! user speaks; `dictation_stop` returns the final transcript (and emits
//! `dictation-final`), from Apple or, when installed, local Whisper
//! (`dictation_whisper.rs`).
//!
//! **One owner holds the mic.** Every capture is started for an `owner`, a
//! string the frontend picks per surface, and every event echoes it so a
//! listener reads only its own capture. A push-to-talk start (`kind: "hold"`)
//! takes the mic from whoever has it, who hears `dictation-preempted`; an
//! open-mic start (`"open"`, the default) is refused while another owner holds
//! it. A stop or cancel from an owner that no longer holds the mic does
//! nothing. Callers that pass no owner share `"default"`, which keeps the
//! one-capture-at-a-time behaviour they were written for.
//!
//! **A warm mic with pre-roll.** The audio engine keeps running for `WARM`
//! after a capture ends, its one permanent tap filling a ring with the last
//! `PREROLL_MS` of audio. A capture started while warm opens at once and
//! begins with that ring, so a first syllable spoken as the key goes down is
//! never clipped. Each start checks the warm engine is still running on the
//! same input format, and rebuilds it if sleep or a device change stopped it.
//!
//! **Levels.** While capturing, the tap emits `dictation-level` once per 50 ms
//! of audio (20 Hz), RMS and peak in dBFS: the waveform of a dictation strip,
//! and the silence an end-of-turn detector listens for.
//!
//! **Vocabulary.** A start may carry the capture's vocabulary, ranked (the
//! frontend builds it in `vocab.ts`). Apple's recognizer gets it as
//! `contextualStrings`, with automatic punctuation; Whisper gets it as its
//! prompt, once its silence gate has passed.
//!
//! Between utterances of a continuous conversation, `dictation_cycle`
//! finalizes the current transcript and re-arms a fresh recognition task on the
//! SAME running engine, so the microphone never closes.
//!
//! There is no subprocess here, just live Apple objects. They are all
//! main-thread-affine, so every native call is marshalled onto the UI thread
//! with `AppHandle::run_on_main_thread`. The live objects live in
//! `DictationInner` behind unsafe `Send` wrappers whose invariant is exactly
//! that: only ever touched on the main thread. The one exception is the
//! recognition request the tap feeds from CoreAudio's thread (`TapRequest`).
//!
//! **Mostly untestable by `cargo test`.** The `unsafe` objc2 path against
//! `SFSpeechRecognizer` / `AVAudioEngine` and the TCC mic/speech prompts need a
//! signed run on a real machine. The unit tests cover the plain-Rust rules
//! (ownership, the pre-roll ring, the level windows, the output route), and one
//! opt-in test runs the tap's own buffer step against the real microphone.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::dictation_whisper::{self, WhisperModelStatus, WhisperState};

#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::{rc::Retained, runtime::NSObjectProtocol, sel, AnyThread};
#[cfg(target_os = "macos")]
use objc2_avf_audio::{
    AVAudioEngine, AVAudioFormat, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSError, NSString};
#[cfg(target_os = "macos")]
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};

// --- Event payloads --------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationText {
    owner: String,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationErr {
    owner: String,
    error: String,
    /// The recognizer's `NSError` domain and code, when the error is one — so
    /// a listener can tell "no speech detected" from a real failure without
    /// matching on localized text.
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i64>,
}

/// One 50 ms window of a capture's audio (`dictation-level`).
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DictationLevel {
    owner: String,
    /// RMS and peak of the window, dBFS (−100 is digital silence).
    rms: f32,
    peak: f32,
    /// Where the window ends, in ms from the capture's start.
    ms: u64,
}

/// `dictation-preempted`: `owner` lost the mic to a push-to-talk from `by`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationPreempted {
    owner: String,
    by: String,
    /// What `owner`'s capture had heard so far, for it to keep or drop.
    text: String,
}

fn emit_text(app: &AppHandle, event: &str, owner: &str, text: String) {
    let _ = app.emit(event, DictationText { owner: owner.to_string(), text });
}

fn emit_error(app: &AppHandle, owner: &str, error: impl Into<String>) {
    let _ = app.emit(
        "dictation-error",
        DictationErr {
            owner: owner.to_string(),
            error: error.into(),
            domain: None,
            code: None,
        },
    );
}

/// Recognizer errors that only mean a task ended without (more) speech: "No
/// speech detected" (`kAFAssistantErrorDomain` 1110, which macOS 27 also
/// reports for a cancel), its 216 sibling, and "Request was canceled"
/// (`kLSRErrorDomain` 301). From a task Redline itself finished or cancelled,
/// or with no capture armed, they are noise — surfacing one turned hands-free
/// off for nothing.
#[cfg(any(target_os = "macos", test))]
fn is_benign_recognizer_error(domain: &str, code: i64) -> bool {
    matches!(
        (domain, code),
        ("kAFAssistantErrorDomain", 1110 | 216) | ("kLSRErrorDomain", 301)
    )
}

// --- Engine ----------------------------------------------------------------

/// Which recognizer produces the final transcript. Both paths share the one
/// live `AVAudioEngine` mic capture — Apple's on-device `SFSpeechRecognizer`
/// always runs (it's what streams `dictation-partial`s). The difference is only
/// *who produces the final text on release*:
///   - `Apple`   — `dictation_stop` returns Apple's latest transcript, zero
///     extra work.
///   - `Whisper` — the mic tap *also* tees PCM into an accumulator; on release
///     `dictation_stop` resamples it to 16 kHz and runs local whisper.cpp for a
///     stronger transcript. Batch-only (no mid-utterance partials), so
///     `dictation_cycle` stays on Apple's partial-driven path.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Engine {
    Apple,
    Whisper,
}

/// Resolve the engine for a capture from the `auto`/`apple`/`whisper` setting:
/// `whisper` requires a model to be present (else Apple), `auto` prefers
/// Whisper whenever a model is installed.
fn resolve_engine(whisper: &WhisperState) -> Engine {
    match whisper.engine_setting().as_str() {
        "apple" => Engine::Apple,
        "whisper" | "auto" if whisper.model_present() => Engine::Whisper,
        _ => Engine::Apple,
    }
}

// --- Owners ----------------------------------------------------------------

/// The owner every caller that passes none shares.
pub const DEFAULT_OWNER: &str = "default";

/// How a capture holds the mic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// Push-to-talk: a key or button held down. Takes the mic from anyone.
    Hold,
    /// An open mic (a toggle, a lock, hands-free). Yields to everyone.
    Open,
}

impl Kind {
    fn parse(kind: Option<&str>) -> Result<Self, String> {
        match kind {
            None | Some("open") => Ok(Kind::Open),
            Some("hold") => Ok(Kind::Hold),
            Some(other) => Err(format!("unknown capture kind '{other}'")),
        }
    }
}

#[derive(Clone, Debug)]
struct Holder {
    owner: String,
    /// Which claim this is: a start's main-thread half checks it still is the
    /// live one before it opens anything.
    seq: u64,
}

#[derive(Debug, PartialEq)]
enum Claim {
    /// The mic is free.
    Start,
    /// The owner already holds it: a repeated press.
    Already,
    /// A push-to-talk takes it from this owner.
    Preempt(String),
    /// This owner holds it, and an open mic doesn't take it away.
    Refuse(String),
}

/// What a start by `owner` does, given who holds the mic.
fn claim(current: Option<&Holder>, owner: &str, kind: Kind) -> Claim {
    match current {
        None => Claim::Start,
        Some(h) if h.owner == owner => Claim::Already,
        Some(h) if kind == Kind::Hold => Claim::Preempt(h.owner.clone()),
        Some(h) => Claim::Refuse(h.owner.clone()),
    }
}

/// What `dictation_start` answers.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationGrant {
    /// The caller holds the mic now: it just took it, or already had it.
    granted: bool,
    /// Who holds the mic after the call.
    holder: String,
    /// The owner this start took the mic from (it got `dictation-preempted`).
    #[serde(skip_serializing_if = "Option::is_none")]
    preempted: Option<String>,
}

// --- Vocabulary ------------------------------------------------------------

/// At most this many terms reach the recognizers per capture.
pub const VOCAB_CAP: usize = 150;
/// A longer "term" is a sentence, not vocabulary.
const VOCAB_TERM_MAX: usize = 64;

/// The vocabulary a start passed, made safe for both recognizers: trimmed,
/// without blanks, control characters or overlong entries, de-duplicated
/// ignoring case (the first, highest-ranked spelling wins), and capped.
fn clean_vocab(raw: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty() && t.len() <= VOCAB_TERM_MAX && !t.chars().any(char::is_control))
        .filter(|t| seen.insert(t.to_lowercase()))
        .take(VOCAB_CAP)
        .collect()
}

// --- Pre-roll and levels -----------------------------------------------------

/// How long the warm mic stays open after a capture ends.
#[cfg(target_os = "macos")]
const WARM: std::time::Duration = std::time::Duration::from_secs(5);
/// How much audio from before a press a capture starts with.
const PREROLL_MS: f64 = 300.0;
/// One `dictation-level` event per this much audio.
const LEVEL_WINDOW_MS: u64 = 50;

/// A fixed ring of the last `PREROLL_MS` of mic audio, mono at the mic's rate.
#[derive(Default)]
struct PreRoll {
    buf: Vec<f32>,
    /// Where the next sample goes.
    next: usize,
    /// How many samples the ring holds (at most `buf.len()`).
    len: usize,
}

impl PreRoll {
    /// Size the ring for a mic at `rate` and empty it.
    fn reset(&mut self, rate: f64) {
        self.buf = vec![0.0; (rate * PREROLL_MS / 1000.0).round() as usize];
        self.next = 0;
        self.len = 0;
    }

    fn push(&mut self, samples: &[f32]) {
        let cap = self.buf.len();
        if cap == 0 {
            return;
        }
        // Only the newest `cap` samples can survive.
        let samples = &samples[samples.len().saturating_sub(cap)..];
        let first = samples.len().min(cap - self.next);
        self.buf[self.next..self.next + first].copy_from_slice(&samples[..first]);
        self.buf[..samples.len() - first].copy_from_slice(&samples[first..]);
        self.next = (self.next + samples.len()) % cap;
        self.len = (self.len + samples.len()).min(cap);
    }

    /// The ring's contents, oldest first.
    fn snapshot(&self) -> Vec<f32> {
        let cap = self.buf.len();
        if self.len == 0 {
            return Vec::new();
        }
        let start = (self.next + cap - self.len) % cap;
        let mut out = Vec::with_capacity(self.len);
        out.extend_from_slice(&self.buf[start..(start + self.len).min(cap)]);
        out.extend_from_slice(&self.buf[..(start + self.len).saturating_sub(cap)]);
        out
    }
}

/// Cuts a capture's audio into `LEVEL_WINDOW_MS` windows and measures each.
struct LevelMeter {
    owner: String,
    window: usize,
    sum_sq: f64,
    n: usize,
    peak: f32,
    windows: u64,
}

impl LevelMeter {
    fn new(owner: String, rate: f64) -> Self {
        Self {
            owner,
            window: ((rate * LEVEL_WINDOW_MS as f64 / 1000.0).round() as usize).max(1),
            sum_sq: 0.0,
            n: 0,
            peak: 0.0,
            windows: 0,
        }
    }

    /// Measure `samples`, adding one level to `out` per window they complete.
    /// A window is a span of audio, not of time, so a burst of buffers can't
    /// raise the event rate past 20 per second of sound.
    fn feed(&mut self, samples: &[f32], out: &mut Vec<DictationLevel>) {
        for &s in samples {
            self.sum_sq += f64::from(s) * f64::from(s);
            self.peak = self.peak.max(s.abs());
            self.n += 1;
            if self.n == self.window {
                self.windows += 1;
                out.push(DictationLevel {
                    owner: self.owner.clone(),
                    rms: dbfs((self.sum_sq / self.n as f64).sqrt() as f32),
                    peak: dbfs(self.peak),
                    ms: self.windows * LEVEL_WINDOW_MS,
                });
                self.sum_sq = 0.0;
                self.n = 0;
                self.peak = 0.0;
            }
        }
    }
}

/// Linear amplitude to dBFS, to a tenth, floored at −100 (digital silence).
fn dbfs(x: f32) -> f32 {
    (200.0 * x.max(1e-5).log10()).round() / 10.0
}

/// What the mic tap reads and writes on CoreAudio's thread, behind one lock,
/// so a capture starts and ends between two buffers, never inside one.
#[derive(Default)]
struct TapShared {
    preroll: PreRoll,
    /// The warm mic's sample rate.
    rate: f64,
    /// Whisper captures only: the utterance so far, at `rate`, from the
    /// pre-roll on.
    pcm: Option<Vec<f32>>,
    /// The live capture's level meter.
    meter: Option<LevelMeter>,
    /// The live capture's recognition request.
    #[cfg(target_os = "macos")]
    request: Option<TapRequest>,
}

impl TapShared {
    fn reset(&mut self, rate: f64) {
        self.rate = rate;
        self.preroll.reset(rate);
    }

    /// One mic buffer, downmixed to mono: into the live capture, then the ring.
    fn feed(&mut self, mono: &[f32], levels: &mut Vec<DictationLevel>) {
        if let Some(pcm) = self.pcm.as_mut() {
            pcm.extend_from_slice(mono);
        }
        if let Some(meter) = self.meter.as_mut() {
            meter.feed(mono, levels);
        }
        self.preroll.push(mono);
    }
}

/// The live capture's request as the tap holds it.
///
/// SAFETY: an audio-buffer request is fed from the tap's own thread (the
/// documented way to use one) and ended on the main thread; the `TapShared`
/// lock serializes the two, and `Retained`'s reference count is atomic.
#[cfg(target_os = "macos")]
struct TapRequest(Retained<SFSpeechAudioBufferRecognitionRequest>);
#[cfg(target_os = "macos")]
unsafe impl Send for TapRequest {}

// --- Output route ----------------------------------------------------------

/// Where Redline's audio goes now, for deciding whether the mic can stay open
/// while it speaks (`dictation_status`).
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputRoute {
    /// `"headphones"` (the mic won't hear it), `"speakers"` (it will), or
    /// `"unknown"` — treat that one as speakers.
    kind: &'static str,
    /// The default output device's transport: `builtin`, `bluetooth`, `usb`,
    /// `hdmi`, `displayport`, `airplay`, `thunderbolt`, `virtual`,
    /// `aggregate` or `other`.
    transport: &'static str,
}

/// FourCC as CoreAudio spells its constants.
const fn fourcc(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

/// Name the route from the device's transport and, for a built-in device, its
/// data source. Bluetooth output is nearly always earbuds or a headset;
/// displays, TVs and AirPlay are speakers; USB and Thunderbolt can be either
/// (a headset or an interface driving monitors), so they stay unknown.
fn classify_route(transport: u32, source: Option<u32>) -> OutputRoute {
    let (kind, transport) = match transport {
        t if t == fourcc(b"bltn") => (
            match source {
                Some(s) if s == fourcc(b"hdpn") => "headphones",
                Some(s) if s == fourcc(b"ispk") => "speakers",
                _ => "unknown",
            },
            "builtin",
        ),
        t if t == fourcc(b"blue") || t == fourcc(b"blea") => ("headphones", "bluetooth"),
        t if t == fourcc(b"hdmi") => ("speakers", "hdmi"),
        t if t == fourcc(b"dprt") => ("speakers", "displayport"),
        t if t == fourcc(b"airp") => ("speakers", "airplay"),
        t if t == fourcc(b"usb ") => ("unknown", "usb"),
        t if t == fourcc(b"thun") => ("unknown", "thunderbolt"),
        t if t == fourcc(b"virt") => ("unknown", "virtual"),
        t if t == fourcc(b"grup") => ("unknown", "aggregate"),
        _ => ("unknown", "other"),
    };
    OutputRoute { kind, transport }
}

/// The three CoreAudio property reads the route needs, declared by hand rather
/// than pulling in a bindings crate for them.
#[cfg(target_os = "macos")]
mod coreaudio {
    use super::fourcc;
    use std::ffi::c_void;

    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    const SYSTEM_OBJECT: u32 = 1;

    fn read_u32(object: u32, selector: &[u8; 4], scope: &[u8; 4]) -> Option<u32> {
        let address = PropertyAddress { selector: fourcc(selector), scope: fourcc(scope), element: 0 };
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: a fixed-size u32 property read into a u32 we own; CoreAudio
        // property reads are safe from any thread.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut u32).cast(),
            )
        };
        (status == 0).then_some(value)
    }

    /// The default output device's transport type and, if it has one, its
    /// current output data source.
    pub fn default_output() -> Option<(u32, Option<u32>)> {
        let device = read_u32(SYSTEM_OBJECT, b"dOut", b"glob").filter(|&d| d != 0)?;
        let transport = read_u32(device, b"tran", b"glob")?;
        Some((transport, read_u32(device, b"ssrc", b"outp")))
    }
}

fn output_route() -> OutputRoute {
    #[cfg(target_os = "macos")]
    if let Some((transport, source)) = coreaudio::default_output() {
        return classify_route(transport, source);
    }
    OutputRoute { kind: "unknown", transport: "other" }
}

// --- State -----------------------------------------------------------------

/// The warm microphone: the engine and its one permanent tap, kept running
/// for `WARM` after a capture. Dropping it releases the objects (objc release
/// is thread-safe); the tap block is kept here so it outlives the tap.
#[cfg(target_os = "macos")]
struct WarmMic {
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    /// The format the tap was installed with: the pre-roll is handed to a
    /// recognizer in it, and a change means the hardware changed under us.
    format: Retained<AVAudioFormat>,
    /// Kept loaded with the engine, and reused by every capture.
    recognizer: Retained<SFSpeechRecognizer>,
    _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
}

/// One capture's recognition: armed at its start, retired at its end.
#[cfg(target_os = "macos")]
struct CaptureTask {
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    _result_handler: RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
}

// SAFETY: every field is an Apple object (or a block) that is only ever created,
// mutated, and dropped inside an `AppHandle::run_on_main_thread` closure — i.e.
// always on the UI thread. The recognition/tap blocks are invoked by the system
// on its own queues, but those invocations only read through the retained copies
// the system holds and the `TapShared` lock; they never touch these structs.
#[cfg(target_os = "macos")]
unsafe impl Send for WarmMic {}
#[cfg(target_os = "macos")]
unsafe impl Send for CaptureTask {}

struct DictationInner {
    /// Who holds the mic, from `dictation_start` to its stop, cancel or
    /// preemption.
    holder: Mutex<Option<Holder>>,
    /// Numbers each claim, so a start's main-thread half can tell it has been
    /// superseded.
    claims: AtomicU64,
    /// A capture is live (`holder` is set) — the cheap read for callbacks.
    active: AtomicBool,
    /// The most recent transcript seen from the recognizer. `dictation_stop`
    /// returns this immediately rather than waiting for the lagging `isFinal`.
    latest: Mutex<String>,
    /// Engine resolved once per capture in `dictation_start`.
    engine: Mutex<Engine>,
    /// The live capture's vocabulary, ranked.
    vocab: Mutex<Vec<String>>,
    tap: Mutex<TapShared>,
    /// Bumped by every start and stop, so a cool-down timer knows a newer one
    /// has superseded it.
    #[cfg(target_os = "macos")]
    warm_epoch: AtomicU64,
    /// Bumped each time a recognition task is armed or retired, so a task's
    /// late callback can tell it is no longer the live one.
    #[cfg(target_os = "macos")]
    armed: AtomicU64,
    #[cfg(target_os = "macos")]
    mic: Mutex<Option<WarmMic>>,
    #[cfg(target_os = "macos")]
    capture: Mutex<Option<CaptureTask>>,
}

impl DictationInner {
    /// Take the mic for `owner` if the ownership rules allow it. The grant,
    /// and the new claim's number when this start has to open a capture.
    fn take_mic(&self, owner: &str, kind: Kind) -> (DictationGrant, Option<u64>) {
        let mut holder = self.holder.lock().unwrap();
        let preempted = match claim(holder.as_ref(), owner, kind) {
            Claim::Already => {
                return (DictationGrant { granted: true, holder: owner.to_string(), preempted: None }, None)
            }
            Claim::Refuse(by) => return (DictationGrant { granted: false, holder: by, preempted: None }, None),
            Claim::Start => None,
            Claim::Preempt(old) => Some(old),
        };
        let seq = self.claims.fetch_add(1, Ordering::SeqCst) + 1;
        *holder = Some(Holder { owner: owner.to_string(), seq });
        self.active.store(true, Ordering::SeqCst);
        (DictationGrant { granted: true, holder: owner.to_string(), preempted }, Some(seq))
    }

    /// Let go of the mic if `owner` holds it (whoever does, for `None`).
    /// Whether it did: a stop from an owner that lost the mic must not end
    /// the capture that took it.
    fn release(&self, owner: Option<&str>) -> bool {
        let mut holder = self.holder.lock().unwrap();
        let held = holder.as_ref().is_some_and(|h| owner.is_none_or(|o| h.owner == o));
        if held {
            *holder = None;
            self.active.store(false, Ordering::SeqCst);
        }
        held
    }

    /// The owner of claim `seq`, while that claim still holds the mic.
    fn owner_of(&self, seq: u64) -> Option<String> {
        self.holder
            .lock()
            .unwrap()
            .as_ref()
            .filter(|h| h.seq == seq)
            .map(|h| h.owner.clone())
    }

    /// The live claim's number, if `owner` holds the mic.
    fn seq_of(&self, owner: &str) -> Option<u64> {
        self.holder
            .lock()
            .unwrap()
            .as_ref()
            .filter(|h| h.owner == owner)
            .map(|h| h.seq)
    }
}

/// Dictation, managed as Tauri state. Cloneable so it can be moved into
/// main-thread closures and completion blocks; the `Arc` keeps a single shared
/// inner.
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
                holder: Mutex::new(None),
                claims: AtomicU64::new(0),
                active: AtomicBool::new(false),
                latest: Mutex::new(String::new()),
                engine: Mutex::new(Engine::Apple),
                vocab: Mutex::new(Vec::new()),
                tap: Mutex::new(TapShared::default()),
                #[cfg(target_os = "macos")]
                warm_epoch: AtomicU64::new(0),
                #[cfg(target_os = "macos")]
                armed: AtomicU64::new(0),
                #[cfg(target_os = "macos")]
                mic: Mutex::new(None),
                #[cfg(target_os = "macos")]
                capture: Mutex::new(None),
            }),
        }
    }

    /// Tear down any capture and the warm mic — backs `dictation_kill_all`
    /// and app teardown, both on the main thread.
    pub fn kill_all(&self) {
        self.inner.release(None);
        #[cfg(target_os = "macos")]
        teardown_mic(&self.inner);
    }
}

// --- Commands --------------------------------------------------------------

/// Begin a capture for `owner` (default `"default"`), as push-to-talk
/// (`kind: "hold"`) or an open mic (`"open"`, the default), with an optional
/// ranked `vocab`. Emits `dictation-partial` and `dictation-level` as the user
/// speaks, and `dictation-error` if recognition can't start. A repeated start
/// by the holder is a no-op; see the module docs for who takes the mic from
/// whom. On first use this triggers the speech-recognition and microphone
/// permission prompts.
#[tauri::command]
pub fn dictation_start(
    dictation: tauri::State<'_, DictationState>,
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
    owner: Option<String>,
    kind: Option<String>,
    vocab: Option<Vec<String>>,
) -> Result<DictationGrant, String> {
    let owner = owner.unwrap_or_else(|| DEFAULT_OWNER.to_string());
    let kind = Kind::parse(kind.as_deref())?;
    let inner = &dictation.inner;
    let (grant, seq) = inner.take_mic(&owner, kind);
    let Some(seq) = seq else {
        return Ok(grant);
    };
    let heard = std::mem::take(&mut *inner.latest.lock().unwrap());
    // Resolve the recognizer once for this capture (before the tap is armed).
    let engine = resolve_engine(&whisper);
    *inner.engine.lock().unwrap() = engine;
    *inner.vocab.lock().unwrap() = clean_vocab(vocab.unwrap_or_default());
    if let Some(old) = &grant.preempted {
        let _ = app.emit(
            "dictation-preempted",
            DictationPreempted { owner: old.clone(), by: owner.clone(), text: heard },
        );
    }

    #[cfg(target_os = "macos")]
    {
        inner.warm_epoch.fetch_add(1, Ordering::SeqCst);
        if engine == Engine::Whisper {
            // Load the model while the user speaks, not after they let go.
            let whisper = whisper.inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = whisper.warm() {
                    tracing::warn!(target: "dictation", "Whisper warm-up failed: {e}");
                }
            });
        }
        let state = inner.clone();
        let app_main = app.clone();
        let takeover = grant.preempted.is_some();
        app.run_on_main_thread(move || {
            if takeover {
                retire_capture(&state, false);
            }
            authorize_then_capture(app_main, state, seq)
        })
        .map_err(|e| {
            inner.release(Some(&owner));
            format!("failed to schedule dictation start: {e}")
        })?;
        Ok(grant)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        inner.release(Some(&owner));
        Err("dictation is only available on macOS".to_string())
    }
}

/// Stop `owner`'s capture and return the final transcript, emitting
/// `dictation-final`. The mic stays warm for `WARM`. A stop from an owner
/// that doesn't hold the mic returns "" and touches nothing.
///
/// - **Apple engine:** returns the latest partial immediately (push-to-talk
///   shouldn't wait for the recognizer's lagging final pass).
/// - **Whisper engine:** drains the accumulated PCM, resamples it to 16 kHz,
///   and runs local whisper.cpp with the capture's vocabulary (off the async
///   runtime via `spawn_blocking`). If inference fails or yields nothing, it
///   falls back to whatever Apple heard. This is why the command is `async` —
///   the (short) inference completes before the return value the UI reads.
#[tauri::command]
pub async fn dictation_stop(
    dictation: tauri::State<'_, DictationState>,
    whisper: tauri::State<'_, WhisperState>,
    app: AppHandle,
    owner: Option<String>,
) -> Result<String, String> {
    let owner = owner.unwrap_or_else(|| DEFAULT_OWNER.to_string());
    if !dictation.inner.release(Some(&owner)) {
        return Ok(String::new());
    }
    // Apple's latest — the immediate answer for the Apple engine, and the
    // fallback if Whisper inference fails.
    let apple_text = dictation.inner.latest.lock().unwrap().clone();

    #[cfg(target_os = "macos")]
    {
        let engine = *dictation.inner.engine.lock().unwrap();
        let vocab = std::mem::take(&mut *dictation.inner.vocab.lock().unwrap());
        let state = dictation.inner.clone();
        let app_main = app.clone();
        // End the capture on the UI thread and get its PCM back: once the tap
        // has let go of it, no late buffer can race the drain.
        let (tx, rx) = tokio::sync::oneshot::channel::<(Vec<f32>, f64)>();
        let scheduled = app.run_on_main_thread(move || {
            let drained = retire_capture(&state, true);
            schedule_cooldown(&app_main, &state);
            let _ = tx.send(drained);
        });
        // If scheduling failed the session is reclaimed on next start / exit;
        // don't hang waiting for a signal that will never come.
        let (pcm, src_rate) = if scheduled.is_ok() { rx.await.unwrap_or_default() } else { Default::default() };

        if engine == Engine::Whisper {
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
            // words must still land, and Apple's always-on recognizer
            // already heard them. Never return "" when Apple has text.
            let whisper_text =
                match transcribe_utterance(whisper.inner().clone(), pcm, src_rate as u32, vocab).await {
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
            emit_text(&app, "dictation-final", &owner, final_text.clone());
            return Ok(final_text);
        }
    }

    emit_text(&app, "dictation-final", &owner, apple_text.clone());
    Ok(apple_text)
}

/// Resample one accumulated utterance to 16 kHz and run Whisper on it, off the
/// async runtime (`spawn_blocking`) since inference is CPU/GPU-bound.
#[cfg(target_os = "macos")]
async fn transcribe_utterance(
    whisper: WhisperState,
    pcm: Vec<f32>,
    src_rate: u32,
    vocab: Vec<String>,
) -> Result<String, String> {
    if pcm.is_empty() || src_rate == 0 {
        return Ok(String::new());
    }
    tokio::task::spawn_blocking(move || {
        let mono_16k = dictation_whisper::resample_to_16k(&pcm, src_rate)?;
        whisper.transcribe(&mono_16k, &vocab)
    })
    .await
    .map_err(|e| format!("transcription task failed: {e}"))?
}

/// Commit `owner`'s current utterance and immediately re-arm a fresh
/// recognition on the SAME running engine, returning the finalized transcript.
/// Unlike `dictation_stop`, the microphone never closes — the per-utterance
/// boundary of a continuous conversation. A no-op returning "" unless `owner`
/// holds the mic.
#[tauri::command]
pub fn dictation_cycle(
    dictation: tauri::State<'_, DictationState>,
    app: AppHandle,
    owner: Option<String>,
) -> Result<String, String> {
    let owner = owner.unwrap_or_else(|| DEFAULT_OWNER.to_string());
    let Some(seq) = dictation.inner.seq_of(&owner) else {
        return Ok(String::new());
    };
    let text = std::mem::take(&mut *dictation.inner.latest.lock().unwrap());

    #[cfg(target_os = "macos")]
    {
        let state = dictation.inner.clone();
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if state.owner_of(seq).is_none() {
                return;
            }
            // Finalize this utterance's recognition, then listen for the next
            // on the same engine. The ring holds this utterance's own end, so
            // the next one starts without it.
            retire_capture(&state, true);
            if let Some(mic) = state.mic.lock().unwrap().as_ref() {
                arm_capture(&app_main, &state, mic, &owner, false);
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (&app, seq);

    Ok(text)
}

/// With an `owner`: cancel that owner's capture if it holds the mic (Esc, a
/// composer unmounting), discarding its text and leaving the mic warm.
/// Without one: tear every capture and the warm mic down — also what app
/// teardown does.
#[tauri::command]
pub fn dictation_kill_all(
    dictation: tauri::State<'_, DictationState>,
    app: AppHandle,
    owner: Option<String>,
) -> Result<(), String> {
    let Some(owner) = owner else {
        dictation.kill_all();
        return Ok(());
    };
    if dictation.inner.release(Some(&owner)) {
        #[cfg(target_os = "macos")]
        {
            let state = dictation.inner.clone();
            let app_main = app.clone();
            let _ = app.run_on_main_thread(move || {
                retire_capture(&state, false);
                schedule_cooldown(&app_main, &state);
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &app;
    Ok(())
}

/// Everything a dictation surface or its settings asks about at once.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// Who holds the mic, if anyone.
    holder: Option<String>,
    /// The engine setting: `auto`, `apple` or `whisper`.
    engine: String,
    /// The Whisper model setting: `base` or `turbo`.
    whisper_model: String,
    /// The Whisper model a capture would run now (`None`: none installed).
    whisper_active: Option<&'static str>,
    whisper_models: Vec<WhisperModelStatus>,
    output_route: OutputRoute,
}

/// The dictation status: ownership, engine and model settings, which models
/// are installed (or half downloaded), and the current output route — query
/// it per turn, since headphones come and go.
#[tauri::command]
pub fn dictation_status(
    dictation: tauri::State<'_, DictationState>,
    whisper: tauri::State<'_, WhisperState>,
) -> DictationStatus {
    DictationStatus {
        holder: dictation.inner.holder.lock().unwrap().as_ref().map(|h| h.owner.clone()),
        engine: whisper.engine_setting(),
        whisper_model: whisper.model_setting(),
        whisper_active: whisper.model().map(|m| m.id),
        whisper_models: whisper.statuses(),
        output_route: output_route(),
    }
}

// --- Native capture (macOS) ------------------------------------------------

/// Gate capture behind speech-recognition authorization. On the main thread.
#[cfg(target_os = "macos")]
fn authorize_then_capture(app: AppHandle, state: Arc<DictationInner>, seq: u64) {
    // SAFETY: on the main thread; `authorizationStatus` is a pure class read.
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status.0 == SFSpeechRecognizerAuthorizationStatus::Authorized.0 {
        begin_capture(&app, &state, seq);
        return;
    }
    let denied = move |app: &AppHandle, state: &DictationInner, message: &str| {
        if let Some(owner) = state.owner_of(seq) {
            state.release(Some(&owner));
            emit_error(app, &owner, message);
        }
    };
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
                    begin_capture(&app_main, &state_main, seq);
                } else {
                    denied(
                        &app_main,
                        &state_main,
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
    denied(
        &app,
        &state,
        "Speech recognition isn't authorized for Redline. Enable it under \
         System Settings → Privacy & Security → Speech Recognition.",
    );
}

/// Open the capture for claim `seq`: warm the mic (or reuse it), arm the
/// recognition with the pre-roll, and start the engine if it was cold. On the
/// main thread; on a failure it releases the mic and emits `dictation-error`.
#[cfg(target_os = "macos")]
fn begin_capture(app: &AppHandle, state: &Arc<DictationInner>, seq: u64) {
    // A stop, a cancel or another start got here first.
    let Some(owner) = state.owner_of(seq) else {
        return;
    };
    let fail = |message: String| {
        state.release(Some(&owner));
        emit_error(app, &owner, message);
    };
    let cold = match ensure_mic(app, state) {
        Ok(cold) => cold,
        Err(e) => return fail(e),
    };
    let guard = state.mic.lock().unwrap();
    let mic = guard.as_ref().expect("ensure_mic left a mic");
    arm_capture(app, state, mic, &owner, true);
    if !cold {
        return;
    }
    // SAFETY: main thread; the engine and its tap are live.
    unsafe { mic.engine.prepare() };
    if let Err(err) = unsafe { mic.engine.startAndReturnError() } {
        drop(guard);
        teardown_mic(state);
        fail(format!("Couldn't start the microphone: {}", err.localizedDescription()));
    }
}

/// Make sure a warm mic is ready: the running one if its engine still runs on
/// the input format it was built for, else a fresh one with its tap installed
/// (not yet started). Whether it is fresh — the caller starts it once the
/// capture is armed, so not a buffer is lost. Main thread.
#[cfg(target_os = "macos")]
fn ensure_mic(app: &AppHandle, state: &Arc<DictationInner>) -> Result<bool, String> {
    if let Some(mic) = state.mic.lock().unwrap().as_ref() {
        // SAFETY (this fn): on the UI thread, on objects created here or kept
        // alive in `state.mic`.
        let now = unsafe { mic.input.outputFormatForBus(0) };
        let same = unsafe {
            now.sampleRate() == mic.format.sampleRate() && now.channelCount() == mic.format.channelCount()
        };
        if same && unsafe { mic.engine.isRunning() } {
            return Ok(false);
        }
    }
    // Asleep, unplugged or switched since: build a new one.
    teardown_mic(state);

    let recognizer = unsafe { SFSpeechRecognizer::new() };
    if !unsafe { recognizer.isAvailable() } {
        return Err("Speech recognition is currently unavailable.".to_string());
    }
    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    // NOTE: Apple voice-processing (acoustic echo cancellation) is
    // intentionally NOT enabled: turning it on before the microphone is
    // authorized left the input open but silent, so dictation is plain
    // half-duplex capture (the known-good path). The tap must use the input
    // node's own output format, or CoreAudio throws when the tap format doesn't
    // match the hardware.
    let format = unsafe { input.outputFormatForBus(0) };
    state.tap.lock().unwrap().reset(unsafe { format.sampleRate() });

    let app_tap = app.clone();
    let state_tap = state.clone();
    let tap = RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            // SAFETY: CoreAudio passes a live, non-null PCM buffer per tap call.
            let levels = unsafe { on_buffer(&state_tap, buffer.as_ref()) };
            for level in levels {
                let _ = app_tap.emit("dictation-level", level);
            }
        },
    );
    unsafe {
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
    }
    *state.mic.lock().unwrap() = Some(WarmMic { engine, input, format, recognizer, _tap: tap });
    Ok(true)
}

/// The tap's work for one mic buffer, on CoreAudio's thread: hand it to the
/// live recognition request, then feed its mono samples to the capture (the
/// Whisper accumulator, the level meter) and the pre-roll ring. Returns the
/// levels to emit, so no event is sent while the lock is held.
///
/// SAFETY: `buffer` must be a live `AVAudioPCMBuffer` for the duration of the
/// call (CoreAudio guarantees this inside the tap block).
#[cfg(target_os = "macos")]
unsafe fn on_buffer(state: &DictationInner, buffer: &AVAudioPCMBuffer) -> Vec<DictationLevel> {
    let mut levels = Vec::new();
    let mut tap = state.tap.lock().unwrap();
    if let Some(request) = &tap.request {
        request.0.appendAudioPCMBuffer(buffer);
    }
    if let Some(mono) = extract_mono_f32(buffer) {
        tap.feed(&mono, &mut levels);
    }
    levels
}

/// Arm a fresh recognition for `owner` on the warm mic: a request carrying the
/// capture's vocabulary, a task streaming its partials to
/// `dictation-partial`, and — with `preroll` — the ring's last `PREROLL_MS`
/// handed to it first. Main thread; the task is kept in `state.capture`.
#[cfg(target_os = "macos")]
fn arm_capture(app: &AppHandle, state: &Arc<DictationInner>, mic: &WarmMic, owner: &str, preroll: bool) {
    // SAFETY (this fn): on the UI thread, on objects created here or kept
    // alive by the warm mic.
    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        // Private + offline — the locked design (no audio leaves the device).
        request.setRequiresOnDeviceRecognition(true);
        let vocab = state.vocab.lock().unwrap();
        if !vocab.is_empty() {
            let strings: Vec<Retained<NSString>> = vocab.iter().map(|t| NSString::from_str(t)).collect();
            request.setContextualStrings(&NSArray::from_retained_slice(&strings));
        }
        // macOS 13 and later; the app still runs on 11.
        if request.respondsToSelector(sel!(setAddsPunctuation:)) {
            request.setAddsPunctuation(true);
        }
    }

    // Results stream in on the recognizer's queue: stash the latest text (so
    // `dictation_stop`/`dictation_cycle` can return it) and push a partial.
    let app_res = app.clone();
    let state_res = state.clone();
    let owner_res = owner.to_string();
    let mine = state.armed.fetch_add(1, Ordering::SeqCst) + 1;
    let result_handler = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            // The live task of an armed capture, or one Redline has since
            // finished or cancelled (whose late words and errors are its own).
            let live = state_res.active.load(Ordering::SeqCst)
                && state_res.armed.load(Ordering::SeqCst) == mine;
            // SAFETY: the recognizer hands back a valid result or error pointer.
            if let Some(result) = unsafe { result.as_ref() } {
                if !live {
                    return;
                }
                let text = unsafe { result.bestTranscription().formattedString() }.to_string();
                *state_res.latest.lock().unwrap() = text.clone();
                emit_text(&app_res, "dictation-partial", &owner_res, text);
            } else if let Some(error) = unsafe { error.as_ref() } {
                let domain = error.domain().to_string();
                let code = error.code() as i64;
                let message = error.localizedDescription().to_string();
                tracing::warn!(target: "dictation", domain = %domain, code, live, "recognizer error: {message}");
                if !live && is_benign_recognizer_error(&domain, code) {
                    return;
                }
                let _ = app_res.emit(
                    "dictation-error",
                    DictationErr {
                        owner: owner_res.clone(),
                        error: message,
                        domain: Some(domain),
                        code: Some(code),
                    },
                );
            }
        },
    );
    let task = unsafe { mic.recognizer.recognitionTaskWithRequest_resultHandler(&request, &result_handler) };

    let whisper = *state.engine.lock().unwrap() == Engine::Whisper;
    {
        let mut tap = state.tap.lock().unwrap();
        let ring = if preroll { tap.preroll.snapshot() } else { Vec::new() };
        if let Some(buffer) = unsafe { preroll_buffer(&mic.format, &ring) } {
            unsafe { request.appendAudioPCMBuffer(&buffer) };
        }
        tap.pcm = whisper.then_some(ring);
        tap.meter = Some(LevelMeter::new(owner.to_string(), tap.rate));
        tap.request = Some(TapRequest(request.clone()));
    }
    *state.capture.lock().unwrap() = Some(CaptureTask { request, task, _result_handler: result_handler });
}

/// End the live capture's recognition — `finish` keeps what it heard,
/// otherwise it is cancelled — and detach it from the tap. Returns its Whisper
/// PCM (empty for an Apple capture) and the rate it was taken at. Main thread.
#[cfg(target_os = "macos")]
fn retire_capture(state: &DictationInner, finish: bool) -> (Vec<f32>, f64) {
    state.armed.fetch_add(1, Ordering::SeqCst);
    let drained = {
        let mut tap = state.tap.lock().unwrap();
        tap.request = None;
        tap.meter = None;
        (tap.pcm.take().unwrap_or_default(), tap.rate)
    };
    if let Some(capture) = state.capture.lock().unwrap().take() {
        // SAFETY: main thread; the capture's objects are still live.
        unsafe {
            capture.request.endAudio();
            if finish {
                capture.task.finish();
            } else {
                capture.task.cancel();
            }
        }
    }
    drained
}

/// Stop the warm mic and release it, with any capture still on it. Main
/// thread. No lock is held across the engine calls: stopping waits for a tap
/// call in flight, which needs the `TapShared` lock.
#[cfg(target_os = "macos")]
fn teardown_mic(state: &DictationInner) {
    retire_capture(state, false);
    let mic = state.mic.lock().unwrap().take();
    if let Some(mic) = mic {
        // SAFETY: main thread; the mic's objects are still live.
        unsafe {
            mic.engine.stop();
            mic.input.removeTapOnBus(0);
        }
    }
    state.tap.lock().unwrap().preroll = PreRoll::default();
}

/// Close the warm mic `WARM` after this stop, unless a capture has started (or
/// another stop has re-armed the timer) by then.
#[cfg(target_os = "macos")]
fn schedule_cooldown(app: &AppHandle, state: &Arc<DictationInner>) {
    let epoch = state.warm_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WARM).await;
        let _ = app.run_on_main_thread(move || {
            if state.warm_epoch.load(Ordering::SeqCst) == epoch && !state.active.load(Ordering::SeqCst) {
                teardown_mic(&state);
            }
        });
    });
}

/// The pre-roll as one buffer in the tap's own format, so the recognizer
/// hears it as just more of the stream: the mono ring copied into every
/// channel. `None` for an empty ring or a non-float format.
///
/// SAFETY: main thread; `format` is the live tap format.
#[cfg(target_os = "macos")]
unsafe fn preroll_buffer(format: &AVAudioFormat, mono: &[f32]) -> Option<Retained<AVAudioPCMBuffer>> {
    if mono.is_empty() {
        return None;
    }
    let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
        AVAudioPCMBuffer::alloc(),
        format,
        mono.len() as u32,
    )?;
    let data = buffer.floatChannelData();
    if data.is_null() {
        return None;
    }
    let stride = (buffer.stride() as usize).max(1);
    for c in 0..(format.channelCount() as usize).max(1) {
        let channel = (*data.add(c)).as_ptr();
        for (f, &s) in mono.iter().enumerate() {
            *channel.add(f * stride) = s;
        }
    }
    buffer.setFrameLength(mono.len() as u32);
    Some(buffer)
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

    fn inner() -> Arc<DictationInner> {
        DictationState::new().inner
    }

    #[test]
    fn fresh_state_is_inactive_with_empty_transcript() {
        let state = DictationState::new();
        assert!(!state.inner.active.load(Ordering::SeqCst));
        assert_eq!(*state.inner.latest.lock().unwrap(), "");
    }

    #[test]
    fn kill_all_clears_active() {
        let state = DictationState::new();
        state.inner.take_mic("door", Kind::Open);
        state.kill_all();
        assert!(!state.inner.active.load(Ordering::SeqCst));
        assert!(state.inner.holder.lock().unwrap().is_none());
    }

    #[test]
    fn the_holder_keeps_the_mic_and_a_second_press_is_a_no_op() {
        assert_eq!(claim(None, "door", Kind::Open), Claim::Start);
        let door = Holder { owner: "door".into(), seq: 1 };
        assert_eq!(claim(Some(&door), "door", Kind::Open), Claim::Already);
        assert_eq!(claim(Some(&door), "door", Kind::Hold), Claim::Already);
    }

    #[test]
    fn push_to_talk_takes_the_mic_and_an_open_mic_never_does() {
        let open = Holder { owner: "voice-panel".into(), seq: 1 };
        assert_eq!(claim(Some(&open), "comment", Kind::Hold), Claim::Preempt("voice-panel".into()));
        assert_eq!(claim(Some(&open), "door", Kind::Open), Claim::Refuse("voice-panel".into()));
        // The newest held key wins over an older one: it is the user's latest
        // direct gesture.
        let held = Holder { owner: "comment".into(), seq: 2 };
        assert_eq!(claim(Some(&held), "door", Kind::Hold), Claim::Preempt("comment".into()));
        assert_eq!(claim(Some(&held), "voice-panel", Kind::Open), Claim::Refuse("comment".into()));
    }

    #[test]
    fn a_preempted_owner_cannot_stop_or_cancel_the_capture_that_took_its_mic() {
        let inner = inner();
        let (grant, first) = inner.take_mic("voice-panel", Kind::Open);
        assert_eq!(grant, DictationGrant { granted: true, holder: "voice-panel".into(), preempted: None });
        let (refused, none) = inner.take_mic("door", Kind::Open);
        assert_eq!((refused.granted, refused.holder.as_str(), none), (false, "voice-panel", None));

        let (grant, second) = inner.take_mic("comment", Kind::Hold);
        assert_eq!(grant.preempted.as_deref(), Some("voice-panel"));
        assert!(second > first, "a new claim");
        assert_eq!(inner.owner_of(first.unwrap()), None, "the old claim's start won't open anything");
        assert!(!inner.release(Some("voice-panel")), "its late stop is a no-op");
        assert_eq!(inner.seq_of("comment"), second);
        assert!(inner.active.load(Ordering::SeqCst));

        assert!(inner.release(Some("comment")));
        assert!(!inner.active.load(Ordering::SeqCst));
        assert_eq!(inner.take_mic("voice-panel", Kind::Open).0.granted, true, "free again");
    }

    #[test]
    fn callers_without_an_owner_share_one_capture_as_before() {
        let inner = inner();
        let (_, seq) = inner.take_mic(DEFAULT_OWNER, Kind::parse(None).unwrap());
        assert!(seq.is_some());
        assert_eq!(inner.take_mic(DEFAULT_OWNER, Kind::Open).1, None, "a second start is a no-op");
        assert!(inner.release(Some(DEFAULT_OWNER)));
        assert!(!inner.release(Some(DEFAULT_OWNER)), "a stop with nothing live does nothing");
    }

    #[test]
    fn a_capture_kind_is_hold_or_open() {
        assert_eq!(Kind::parse(Some("hold")), Ok(Kind::Hold));
        assert_eq!(Kind::parse(Some("open")), Ok(Kind::Open));
        assert!(Kind::parse(Some("toggle")).is_err());
    }

    #[test]
    fn the_preroll_ring_holds_the_last_300_ms_in_order() {
        let mut ring = PreRoll::default();
        assert!(ring.snapshot().is_empty(), "no mic yet");
        ring.push(&[1.0]);
        assert!(ring.snapshot().is_empty(), "an unsized ring keeps nothing");

        ring.reset(10.0); // 3 samples at 10 Hz
        ring.push(&[1.0, 2.0]);
        assert_eq!(ring.snapshot(), vec![1.0, 2.0]);
        ring.push(&[3.0, 4.0]);
        assert_eq!(ring.snapshot(), vec![2.0, 3.0, 4.0], "wraps, oldest first");
        ring.push(&[5.0]);
        assert_eq!(ring.snapshot(), vec![3.0, 4.0, 5.0]);
        ring.push(&[6.0, 7.0, 8.0, 9.0, 10.0]);
        assert_eq!(ring.snapshot(), vec![8.0, 9.0, 10.0], "a long buffer keeps its newest");

        ring.reset(48_000.0);
        assert_eq!(ring.buf.len(), 14_400);
        let second: Vec<f32> = (0..48_000).map(|i| i as f32).collect();
        for chunk in second.chunks(1024) {
            ring.push(chunk);
        }
        assert_eq!(ring.snapshot(), second[48_000 - 14_400..].to_vec());
    }

    #[test]
    fn levels_come_once_per_50_ms_of_audio_in_dbfs() {
        let mut meter = LevelMeter::new("door".into(), 48_000.0);
        let tone: Vec<f32> = (0..48_000)
            .map(|i| 0.5 * (i as f32 / 48_000.0 * 440.0 * std::f32::consts::TAU).sin())
            .collect();
        let mut levels = Vec::new();
        for chunk in tone.chunks(1024) {
            meter.feed(chunk, &mut levels);
        }
        assert_eq!(levels.len(), 20, "20 Hz however the buffers fall");
        assert_eq!(levels.iter().map(|l| l.ms).collect::<Vec<_>>(), (1..=20).map(|w| w * 50).collect::<Vec<_>>());
        assert!(levels.iter().all(|l| l.owner == "door"));
        // A 0.5 sine: RMS 0.354 (−9.0 dBFS), peak 0.5 (−6.0 dBFS).
        assert!(levels.iter().all(|l| (l.rms + 9.0).abs() <= 0.1), "{levels:?}");
        assert!(levels.iter().all(|l| (l.peak + 6.0).abs() <= 0.1), "{levels:?}");

        // One big buffer still yields one level per window.
        let mut levels = Vec::new();
        LevelMeter::new("door".into(), 16_000.0).feed(&vec![0.0; 8_000], &mut levels);
        assert_eq!(levels.len(), 10);
        assert!(levels.iter().all(|l| l.rms == -100.0 && l.peak == -100.0));
    }

    #[test]
    fn the_tap_feeds_the_live_capture_and_the_ring_together() {
        let mut tap = TapShared::default();
        tap.reset(1_000.0); // a 300-sample ring, 50-sample windows
        tap.feed(&[0.1; 250], &mut Vec::new());
        // A Whisper capture starts with the ring, then takes what follows.
        tap.pcm = Some(tap.preroll.snapshot());
        tap.meter = Some(LevelMeter::new("door".into(), tap.rate));
        let mut levels = Vec::new();
        tap.feed(&[0.2; 100], &mut levels);
        let pcm = tap.pcm.take().unwrap();
        assert_eq!(pcm.len(), 350);
        assert_eq!((pcm[249], pcm[250]), (0.1, 0.2));
        assert_eq!(levels.len(), 2, "the pre-roll isn't metered again");
        assert_eq!(tap.preroll.snapshot().len(), 300);
    }

    #[test]
    fn dbfs_floors_digital_silence() {
        assert_eq!(dbfs(1.0), 0.0);
        assert_eq!(dbfs(0.0), -100.0);
        assert_eq!(dbfs(0.1), -20.0);
    }

    #[test]
    fn the_vocabulary_is_trimmed_deduplicated_and_capped_in_rank_order() {
        let raw = vec![
            "  Kokoro ".to_string(),
            "kokoro".to_string(),
            String::new(),
            "Tauri".to_string(),
            "line\nbreak".to_string(),
            "x".repeat(VOCAB_TERM_MAX + 1),
        ];
        assert_eq!(clean_vocab(raw), vec!["Kokoro".to_string(), "Tauri".to_string()]);
        let many: Vec<String> = (0..400).map(|i| format!("term{i}")).collect();
        let kept = clean_vocab(many);
        assert_eq!(kept.len(), VOCAB_CAP);
        assert_eq!(kept[0], "term0");
    }

    #[test]
    fn the_output_route_names_headphones_only_when_the_mic_cant_hear_them() {
        let route = |t: &[u8; 4], s: Option<&[u8; 4]>| classify_route(fourcc(t), s.map(fourcc)).kind;
        assert_eq!(route(b"bltn", Some(b"hdpn")), "headphones");
        assert_eq!(route(b"bltn", Some(b"ispk")), "speakers");
        assert_eq!(route(b"bltn", None), "unknown");
        assert_eq!(route(b"blue", None), "headphones");
        assert_eq!(route(b"blea", None), "headphones");
        assert_eq!(route(b"hdmi", None), "speakers");
        assert_eq!(route(b"airp", None), "speakers");
        assert_eq!(route(b"usb ", None), "unknown");
        assert_eq!(classify_route(fourcc(b"usb "), None).transport, "usb");
        assert_eq!(classify_route(0, None), OutputRoute { kind: "unknown", transport: "other" });
    }

    #[test]
    fn only_end_of_speech_errors_are_benign() {
        assert!(is_benign_recognizer_error("kAFAssistantErrorDomain", 1110));
        assert!(is_benign_recognizer_error("kAFAssistantErrorDomain", 216));
        assert!(is_benign_recognizer_error("kLSRErrorDomain", 301));
        // Real failures still reach the panel: the speech service crashing or
        // going unreachable, a refused request.
        assert!(!is_benign_recognizer_error("kAFAssistantErrorDomain", 1101));
        assert!(!is_benign_recognizer_error("kAFAssistantErrorDomain", 1107));
        assert!(!is_benign_recognizer_error("kLSRErrorDomain", 300));
        assert!(!is_benign_recognizer_error("NSCocoaErrorDomain", 1110));
    }

    #[test]
    fn every_payload_names_its_owner() {
        let v = serde_json::to_value(DictationErr {
            owner: "door".into(),
            error: "No speech detected".into(),
            domain: Some("kAFAssistantErrorDomain".into()),
            code: Some(1110),
        })
        .unwrap();
        assert_eq!((v["domain"].as_str(), v["code"].as_i64()), (Some("kAFAssistantErrorDomain"), Some(1110)));
        let plain = serde_json::to_value(DictationErr { owner: "door".into(), error: "x".into(), domain: None, code: None })
            .unwrap();
        assert_eq!(plain, serde_json::json!({ "owner": "door", "error": "x" }));
        let text = serde_json::to_value(DictationText { owner: "door".into(), text: "hello".into() }).unwrap();
        assert_eq!(text, serde_json::json!({ "owner": "door", "text": "hello" }));
        let level = serde_json::to_value(DictationLevel { owner: "door".into(), rms: -30.5, peak: -12.0, ms: 50 }).unwrap();
        assert_eq!(level, serde_json::json!({ "owner": "door", "rms": -30.5, "peak": -12.0, "ms": 50 }));
        let grant = serde_json::to_value(DictationGrant { granted: true, holder: "door".into(), preempted: None }).unwrap();
        assert_eq!(grant, serde_json::json!({ "granted": true, "holder": "door" }));
    }

    /// The tap's own buffer step against the real microphone for ~1.2 s:
    /// CoreAudio's buffers fill the 300 ms ring and the meter yields ~20
    /// levels a second. Prints the levels and the output route. Needs
    /// microphone permission for the process running the tests.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "opens the real microphone"]
    fn a_real_mic_fills_the_preroll_and_meters_twenty_levels_a_second() {
        let state = inner();
        let levels = Arc::new(Mutex::new(Vec::new()));
        let rate;
        unsafe {
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            rate = format.sampleRate();
            {
                let mut tap = state.tap.lock().unwrap();
                tap.reset(rate);
                tap.meter = Some(LevelMeter::new("test".into(), rate));
            }
            let (s, l) = (state.clone(), levels.clone());
            let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                l.lock().unwrap().extend(on_buffer(&s, buffer.as_ref()));
            });
            input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
            engine.prepare();
            engine.startAndReturnError().expect("the microphone starts");
            std::thread::sleep(std::time::Duration::from_millis(1_200));
            engine.stop();
            input.removeTapOnBus(0);
        }
        let levels = levels.lock().unwrap();
        println!("rate {rate} Hz, {} levels, route {:?}", levels.len(), output_route());
        for l in levels.iter().take(6) {
            println!("  {} ms: rms {} dBFS, peak {} dBFS", l.ms, l.rms, l.peak);
        }
        assert_eq!(state.tap.lock().unwrap().preroll.snapshot().len(), (rate * 0.3).round() as usize);
        assert!((18..=25).contains(&levels.len()), "{} levels in 1.2 s", levels.len());
        assert!(levels.windows(2).all(|w| w[1].ms == w[0].ms + 50));
    }
}

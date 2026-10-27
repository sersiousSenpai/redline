// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The **studio voice** (`tts_engine` = `"studio"`): Qwen3-TTS, 12 Hz 1.7B
//! CustomVoice, on MLX — the premium local engine. Like Kokoro it runs in a
//! separate Python process started from Redline's own private environment, so
//! Python, MLX and ~3 GB of weights never enter this binary and only text and
//! audio cross the pipe. Unlike Kokoro it streams: a request's audio arrives in
//! ~0.3 s chunks, the first about 0.1 s after the text, and each chunk is
//! forwarded to the webview as it comes.
//!
//! Everything lives under `<app data>/voice-studio/`: `python/` (uv's CPython),
//! `venv/` (built from the hash-pinned `resources/studio-requirements.lock`),
//! `models/<variant>/` (pinned below; the files every variant shares, the
//! 682 MB speech tokenizer among them, are downloaded once into
//! `models/shared/` and hard-linked in), `models/polish/…` (the dictation
//! polish model, when installed), the sidecar script (written from this
//! binary at every start), its `sidecar.log`, and `install.json` (what is
//! installed, and how fast it spoke here). The webview drives all of it
//! through one command, `tts_studio`.
//!
//! **Protocol**: `resources/studio_tts_sidecar.py`, protocol 1 (JSON lines).
//! **Frames** to the webview, one `Channel` per request: a 12-byte header —
//! u32 generation (its low 32 bits), u32 sequence, u16 flags, u16 reserved,
//! little-endian — then 24 kHz mono PCM16. The last frame has `FINAL` set and
//! carries the request's outcome as JSON instead of audio: the sidecar's
//! `end` (with stats), `cancelled`, or `error` with a `code`; `CANCELLED` or
//! `ERROR` says which.
//!
//! **Generations** are the ones every speech driver draws from its app-wide
//! counter, and `tts_cancel` cancels exactly one: requests are cancelled at the
//! sidecar by id and never superseded by a newer generation, so the voice
//! panel stopping its reply never cuts off a chat being read aloud.
//!
//! **Failure** ends a request rather than holding it: no audio 1.5 s after it
//! reaches the front of the sidecar's queue (4 s while the model loads) ends it
//! `stalled`; an exit, a `fatal` or a broken pipe ends everything pending
//! `sidecar_exited`, and the next request starts a fresh process — but a
//! second exit within 10 minutes turns the engine off until Redline restarts
//! (`studio-status`). The frontend hears each as "finish this turn in the
//! fallback voice". `speak` refuses outright with `studio_not_installed`,
//! `studio_disabled`, `sidecar_exited` (it could not start), or
//! `memory_pressure` (macOS at "warn" or worse and the model not loaded: no
//! reload then).
//!
//! **Dictation polish** is the sidecar's second model slot: a small instruct
//! model (`POLISH`, its own opt-in download) that tidies a dictation after it
//! lands (src/audio/dictationPolish.ts). It has its own queue and thread in the
//! sidecar, so it never waits behind speech; the sidecar refuses a reply that
//! answers the speaker instead of tidying them, and sends their words back
//! unchanged. Its one reply comes back as a single `FINAL` frame on the
//! request's `Channel`, the outcome being `polished` (with the `text` to use).
//! It is best effort: no reply within its budget (`Timing::polish`, more for a
//! longer text, plus the loading allowance while the model loads) ends it
//! `slow` and cancels it at the sidecar, and the frontend polishes with the
//! cleanup child instead.
//!
//! **Events**: `studio-status` `{state, reason}` as the process or model
//! changes (`loading`, `ready`, `unloaded` — `reason` `idle` or
//! `memory_pressure` — `off`, `exited`, `disabled`); `studio-setup`
//! `{phase, received, total, polish}` through an install (`preflight`, `uv`,
//! `python`, `deps`, `model`, `warm`, `speed`), ending
//! `{phase: "done", speedRatio, slow}` or `{phase: "error", message}`;
//! `polish` says it is the polish model's install.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, JavaScriptChannelId, Response};

use crate::db::Database;
use crate::pinned_fetch::fetch_pinned;
use crate::tts::{
    build_venv, ensure_uv, inflate, locked_install, FileCheck, TtsState, CANCELLED as STOPPED,
    DOWNLOAD_STALL,
};

const SETTING_MODEL: &str = "tts_studio_model";
const SETTING_VOICE: &str = "tts_studio_voice";
const SETTING_STYLE: &str = "tts_studio_style";
const DEFAULT_VOICE: &str = "ryan";

// The sidecar and its lock as raw deflate streams, inflated with the decoder
// the prompt archive already links (a test checks each against its source
// beside it, and says how to regenerate them).
const SIDECAR_Z: &[u8] = include_bytes!("../resources/studio_tts_sidecar.py.deflate");
const LOCK_Z: &[u8] = include_bytes!("../resources/studio-requirements.lock.deflate");

const fn pin(bytes: u64, sha256: &'static str) -> FileCheck {
    FileCheck { bytes, sha256 }
}

/// A model variant: its repo at a pinned revision, the files that are its
/// own, about what it occupies in memory while in use, and what a fresh
/// install needs (free disk, the Mac's memory).
pub(crate) struct Variant {
    id: &'static str,
    repo: &'static str,
    revision: &'static str,
    own: &'static [(&'static str, FileCheck)],
    memory: u64,
    disk: u64,
    ram: u64,
}

const HF: &str = "https://huggingface.co/";

/// Files every variant ships byte for byte the same.
const SHARED: [(&str, FileCheck); 9] = [
    (
        "generation_config.json",
        pin(
            245,
            "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa",
        ),
    ),
    (
        "merges.txt",
        pin(
            1_671_839,
            "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3",
        ),
    ),
    (
        "preprocessor_config.json",
        pin(
            127,
            "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119",
        ),
    ),
    (
        "tokenizer_config.json",
        pin(
            7_344,
            "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670",
        ),
    ),
    (
        "vocab.json",
        pin(
            2_776_833,
            "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        ),
    ),
    (
        "speech_tokenizer/config.json",
        pin(
            2_336,
            "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
        ),
    ),
    (
        "speech_tokenizer/configuration.json",
        pin(
            76,
            "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
        ),
    ),
    (
        "speech_tokenizer/preprocessor_config.json",
        pin(
            234,
            "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
        ),
    ),
    (
        "speech_tokenizer/model.safetensors",
        pin(
            682_293_092,
            "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
        ),
    ),
];

pub(crate) const VARIANTS: [Variant; 2] = [
    // The default. 0 bad reads in 60, number lines included, where 4-bit
    // garbled 3 number lines in 10 (speech recognition on 60 seeded reads).
    Variant {
        id: "1.7B-CustomVoice-8bit",
        repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        revision: "41d3337e8b7f2843a75841595fc14e4b9a7a4b96",
        own: &[
            (
                "config.json",
                pin(
                    6_058,
                    "43f29f9ab55cf387bd2ce1d07e9d95a5ca8974fa2fda4e2b45c13ae64aad3bfa",
                ),
            ),
            (
                "model.safetensors",
                pin(
                    2_393_308_931,
                    "b696f4bf45f54497b6de758981e76f1410bd68af05a657477dee466b0202df1a",
                ),
            ),
            (
                "model.safetensors.index.json",
                pin(
                    71_786,
                    "2551ed02dc288b90cd6b7ec98652433f08ef2ae98fb3eda5248a4b9e5b47d08b",
                ),
            ),
        ],
        memory: 4_200_000_000,
        disk: NEED_DISK,
        ram: NEED_RAM,
    },
    // "Low memory": 0.8 GB less, weaker on numbers and identifiers.
    Variant {
        id: "1.7B-CustomVoice-4bit",
        repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit",
        revision: "f35faf19b0cc2160865af64ecf0f22f83d335135",
        own: &[
            (
                "config.json",
                pin(
                    6_058,
                    "5a1dd8d7c9f4d04d5bdac309e9e748f16a96b0724d9c4de4974982dd84078715",
                ),
            ),
            (
                "model.safetensors",
                pin(
                    1_625_226_859,
                    "45a5b5ccd3cc473b9d3890ea922937036b56b948e8bd8c678e725329abdd1d00",
                ),
            ),
            (
                "model.safetensors.index.json",
                pin(
                    71_786,
                    "8ea3f7115ca2b729e5af4e83b2580d1be97dd54d80e8ef7aa27257c04d84d325",
                ),
            ),
        ],
        memory: 3_400_000_000,
        disk: NEED_DISK,
        ram: NEED_RAM,
    },
];

/// The dictation polish model: Qwen3.5-2B (Qwen team, Apache-2.0) as
/// mlx-community's 4-bit MLX conversion, run through mlx-lm in the sidecar's
/// polish slot. Measured on 60 messy dictations and 128 never-answer cases
/// (2026-10-10): none answered once the sidecar's check of each reply had run,
/// 99.1% of jargon kept, 331 ms p95 for 30 words on a quiet M3 Max. Its 1.7 GB
/// is a vision-language conversion whose vision weights the loader drops,
/// which is why it briefly takes ~3.5 GB as it loads and ~1.9 GB after.
pub(crate) const POLISH: Variant = Variant {
    id: "polish/Qwen3.5-2B-4bit",
    repo: "mlx-community/Qwen3.5-2B-4bit",
    revision: "674aaa7240b91e8012fcad5d791b7dfe5ba90207",
    own: &[
        (
            "chat_template.jinja",
            pin(
                7_755,
                "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80",
            ),
        ),
        (
            "config.json",
            pin(
                3_113,
                "beb7fc5a6e0405fe332821cf1a8ef7b69bb390a8c8933171647de5579debf949",
            ),
        ),
        (
            "model.safetensors",
            pin(
                1_722_271_785,
                "713fe7e5d3c3965f7106b0d0ee17615f7869c23c8d327996df8c1196fbcf07d5",
            ),
        ),
        (
            "tokenizer.json",
            pin(
                19_989_343,
                "87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4",
            ),
        ),
        (
            "tokenizer_config.json",
            pin(
                1_139,
                "e98f1901ac6f0adff67b1d540bfa0c36ac1a0cf59eb72ed78146ef89aafa1182",
            ),
        ),
    ],
    memory: 1_900_000_000,
    // 1.7 GB of model, ~0.5 GB of Python and packages if they aren't in yet.
    disk: 2_500_000_000,
    ram: 8_000_000_000,
};

fn variant(id: &str) -> Option<&'static Variant> {
    VARIANTS.iter().find(|v| v.id == id)
}

/// A voice variant, or the polish model: what can be installed.
fn installable(id: &str) -> Option<&'static Variant> {
    variant(id).or((id == POLISH.id).then_some(&POLISH))
}

/// The files `v` shares with the other voice variants (`models/shared`).
fn shared_of(v: &Variant) -> &'static [(&'static str, FileCheck)] {
    if v.id == POLISH.id {
        &[]
    } else {
        &SHARED
    }
}

/// Frame flags (module docs).
pub(crate) const FINAL: u16 = 1;
pub(crate) const CANCELLED: u16 = 2;
pub(crate) const ERROR: u16 = 4;

/// Why a request was refused outright; the frontend speaks it in the fallback.
const NOT_INSTALLED: &str = "studio_not_installed";
const DISABLED: &str = "studio_disabled";
const INSTALLING: &str = "the studio voice is still installing";
/// macOS reports memory pressure at "warn" or worse and the model isn't
/// loaded: loading 3-4 GB now would only push other apps out.
const PRESSURE: &str = "memory_pressure";
/// A polish asked for without the polish model installed: the frontend
/// polishes with the cleanup child.
const POLISH_NOT_INSTALLED: &str = "polish_not_installed";
/// The running sidecar started before the polish model was installed, and
/// speech is under way: no restart under it, so the next polish gets one.
const POLISH_LATER: &str = "polish_unavailable";

/// A fresh install needs this much free disk: 3.1 GB of models, ~0.5 GB of
/// Python and packages, and room to spare.
const NEED_DISK: u64 = 4_500_000_000;
const NEED_RAM: u64 = 16_000_000_000;
/// The speed check (synthesis time ÷ audio played) above which this Mac is
/// too slow to speak ahead of playback; 1.7B measured ~0.27 on an M3 Max.
const MAX_SPEED_RATIO: f64 = 0.5;
const SPEED_TEXT: &str = "The plan has three parts, and the first one is ready for review. \
                          Tell me when you want to hear the rest.";
/// The first load ever compiles Metal kernels (~10 s), so the install's
/// warm-up gets a long allowance.
const WARM_LIMIT: Duration = Duration::from_secs(180);
const SPEED_LIMIT: Duration = Duration::from_secs(60);
const IDLE_UNLOAD_S: &str = "300";
/// The polish model goes sooner: 1.9 GB beside the voice's 4.2, and a
/// dictation warms it again while the user is still speaking.
const POLISH_IDLE_UNLOAD_S: &str = "120";

#[derive(Clone, Copy)]
struct Timing {
    /// No audio this long after a request reaches the front of the sidecar's
    /// queue, with the model loaded: `stalled`.
    warm: Duration,
    /// The same while the model loads (or reloads after an idle unload) or
    /// the request waits behind a warm-up, and for a gap between two chunks.
    loading: Duration,
    /// A request given up on that the sidecar, model loaded, still hasn't let
    /// go of this long after: the sidecar is wedged, and is killed.
    hung: Duration,
    /// Nothing spoken this long: the process is stopped. (The sidecar itself
    /// unloads the model after `IDLE_UNLOAD_S`.)
    idle: Duration,
    /// This long after the voice surfaces closed and nothing was spoken: stopped.
    closed: Duration,
    /// A second unexpected exit within this window turns the engine off.
    exit_window: Duration,
    /// A polish of up to 30 words, the model loaded, answers within this or
    /// ends `slow`; longer ones get more (`polish_budget`).
    polish: Duration,
    tick: Duration,
}

const TIMING: Timing = Timing {
    warm: Duration::from_millis(1500),
    loading: Duration::from_secs(4),
    hung: Duration::from_secs(5),
    idle: Duration::from_secs(30 * 60),
    closed: Duration::from_secs(5 * 60),
    exit_window: Duration::from_secs(10 * 60),
    // 331 ms p95 for 30 words on a quiet machine; 2-4x that while builds run.
    polish: Duration::from_millis(700),
    tick: Duration::from_millis(100),
};

/// Where a request's audio and outcome go.
enum Sink {
    /// The webview's: a piece's frames, or a polish's one reply.
    Audio(Channel<Response>),
    /// Redline's own request (the install's warm-up and speed check): where
    /// its outcome is left for `ask`.
    Reply(Arc<StdMutex<Option<Value>>>),
    /// Already ended toward the webview; whatever else arrives is dropped.
    Gone,
}

struct Request {
    generation: u64,
    speak: bool,
    sink: Sink,
    frames: u32,
    last_frame: Option<Instant>,
    /// When it was cancelled or given up on.
    gone_at: Option<Instant>,
    /// A polish-slot request: when it is given up on.
    until: Option<Instant>,
}

impl Request {
    /// End it toward its sink with `outcome`; the sidecar may still hold it.
    fn end(&mut self, outcome: Value, flags: u16, out: &mut Out) {
        match std::mem::replace(&mut self.sink, Sink::Gone) {
            Sink::Audio(ch) => {
                let body = serde_json::to_vec(&outcome).unwrap_or_default();
                out.frames.push((
                    ch,
                    frame(self.generation, self.frames, FINAL | flags, &body),
                ));
            }
            Sink::Reply(tx) => out.replies.push((tx, outcome)),
            Sink::Gone => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Model {
    /// Not loaded: no process, or one that hasn't loaded yet.
    Off,
    Loading,
    Ready,
    Unloaded,
}

/// The running sidecar. Taking it out of `Core` and killing it is a stop;
/// its threads notice and wind down.
struct Live {
    epoch: u64,
    /// Lines for the writer thread, which waits on the condvar.
    inbox: Arc<(StdMutex<Vec<String>>, Condvar)>,
    child: Arc<StdMutex<Child>>,
    /// Why Redline ended it, when it did (a wedged sidecar).
    why: Option<&'static str>,
    /// It was started with the polish model (installed by then).
    polish: bool,
}

impl Live {
    fn kill(&self) {
        // Never held for long: only to kill, and to reap a killed process.
        let _ = self.child.lock().map(|mut c| c.kill());
    }
}

struct Core {
    model_id: String,
    voice: String,
    style: String,
    live: Option<Live>,
    epoch: u64,
    next_id: u64,
    /// Requests written to the sidecar that it hasn't finished, by id, in
    /// the order written — which is its queue's order.
    queue: Vec<(u64, Request)>,
    /// Polishes and the polish model's warm-ups, which the sidecar runs on
    /// a queue of their own, by id.
    polish: Vec<(u64, Request)>,
    /// The polish model, as the sidecar last said (`Off`: not loaded).
    polish_model: Model,
    /// The vocabulary the polish model's prompt was last built for: the
    /// sidecar builds it again (~0.3 s) for any other.
    polish_vocab: Value,
    /// The first request in the queue, and since when.
    front: Option<u64>,
    front_since: Instant,
    /// The first speech request in it, and since when: the one the
    /// watchdog watches (it may wait behind a warm-up).
    speech: Option<u64>,
    speech_since: Instant,
    model: Model,
    reason: Option<String>,
    exits: Vec<Instant>,
    disabled: bool,
    last_used: Instant,
    surfaces: Vec<String>,
    closed_at: Option<Instant>,
    /// The model being installed (a variant's id, or `POLISH`'s).
    installing: Option<&'static str>,
    /// `install.json`, read on first use.
    record: Option<Value>,
}

impl Core {
    /// Note when the front of the queue, or its first speech, changed: the
    /// watchdog counts from then.
    fn rehead(&mut self, now: Instant) {
        let front = self.queue.first().map(|(id, _)| *id);
        if front != self.front {
            self.front = front;
            self.front_since = now;
        }
        let speech = self.queue.iter().find(|(_, r)| r.speak).map(|(id, _)| *id);
        if speech != self.speech {
            self.speech = speech;
            self.speech_since = now;
        }
    }

    fn request(&mut self, id: u64) -> Option<&mut Request> {
        self.queue
            .iter_mut()
            .find(|(i, _)| *i == id)
            .map(|(_, r)| r)
    }

    fn live_epoch(&self) -> Option<u64> {
        self.live.as_ref().map(|l| l.epoch)
    }

    fn send_line(&self, line: Value) {
        if let Some(live) = &self.live {
            let (lines, wake) = &*live.inbox;
            lines
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("{line}\n"));
            wake.notify_one();
        }
    }

    /// The process is gone: everything pending ends, and neither model is
    /// loaded any more.
    fn end_all(&mut self, code: &str, message: &str, out: &mut Out) {
        let polishes = std::mem::take(&mut self.polish);
        for (_, mut r) in std::mem::take(&mut self.queue).into_iter().chain(polishes) {
            r.end(
                json!({"type": "error", "code": code, "message": message}),
                ERROR,
                out,
            );
        }
        self.polish_model = Model::Off;
        self.polish_vocab = Value::Null;
        self.rehead(Instant::now());
    }

    /// The sidecar went away unasked (or wedged, or could not start).
    /// Everything pending ends `sidecar_exited`; the second time within
    /// `window` the engine is off until restart.
    fn exited(&mut self, why: &str, window: Duration, out: &mut Out) {
        self.live = None;
        self.model = Model::Off;
        self.end_all("sidecar_exited", why, out);
        let now = Instant::now();
        self.exits.retain(|t| now.duration_since(*t) < window);
        self.exits.push(now);
        self.disabled = self.exits.len() >= 2;
        let state = if self.disabled { "disabled" } else { "exited" };
        self.reason = Some(why.to_string());
        out.events
            .push(("studio-status", json!({"state": state, "reason": why})));
        tracing::warn!(target: "studio", "the studio voice's sidecar exited: {why}");
    }

    /// A deliberate stop: ends what is pending and never counts as a crash.
    fn stop(&mut self, why: &str, out: &mut Out) {
        let Some(live) = self.live.take() else {
            return;
        };
        live.kill();
        self.end_all("sidecar_exited", "the studio voice was stopped", out);
        self.model = Model::Off;
        self.reason = Some(why.to_string());
        out.events
            .push(("studio-status", json!({"state": "off", "reason": why})));
    }
}

/// What a locked step decided to send; sent once the lock is released.
#[derive(Default)]
struct Out {
    frames: Vec<(Channel<Response>, Vec<u8>)>,
    replies: Vec<(Arc<StdMutex<Option<Value>>>, Value)>,
    events: Vec<(&'static str, Value)>,
}

type Events = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The studio voice's process, installer and settings. Cheap to clone.
#[derive(Clone)]
pub struct Studio(Arc<Inner>);

struct Inner {
    dir: PathBuf,
    data_dir: PathBuf,
    db: Arc<Database>,
    http: reqwest::Client,
    core: StdMutex<Core>,
    events: StdMutex<Option<Events>>,
    last_progress: StdMutex<Option<Instant>>,
    /// The install in progress was cancelled; it stops at its next step.
    stop_install: AtomicBool,
    /// Removals still deleting `dir`: an install waits them out, or they
    /// would take its new files with them.
    removing: AtomicUsize,
    timing: Timing,
    pressure: fn() -> Option<u64>,
}

impl Studio {
    pub(crate) fn new(data_dir: &Path, http: reqwest::Client, db: Arc<Database>) -> Self {
        Self::with(data_dir, http, db, TIMING, memory_pressure)
    }

    fn with(
        data_dir: &Path,
        http: reqwest::Client,
        db: Arc<Database>,
        timing: Timing,
        pressure: fn() -> Option<u64>,
    ) -> Self {
        let setting = |key: &str, default: &str| {
            db.get_setting(key)
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        let now = Instant::now();
        let core = Core {
            model_id: setting(SETTING_MODEL, VARIANTS[0].id),
            voice: setting(SETTING_VOICE, DEFAULT_VOICE),
            style: setting(SETTING_STYLE, ""),
            live: None,
            epoch: 0,
            next_id: 1,
            queue: Vec::new(),
            polish: Vec::new(),
            polish_model: Model::Off,
            polish_vocab: Value::Null,
            front: None,
            front_since: now,
            speech: None,
            speech_since: now,
            model: Model::Off,
            reason: None,
            exits: Vec::new(),
            disabled: false,
            last_used: now,
            surfaces: Vec::new(),
            closed_at: None,
            installing: None,
            record: None,
        };
        Self(Arc::new(Inner {
            dir: data_dir.join("voice-studio"),
            data_dir: data_dir.to_path_buf(),
            db,
            http,
            core: StdMutex::new(core),
            events: StdMutex::new(None),
            last_progress: StdMutex::new(None),
            stop_install: AtomicBool::new(false),
            removing: AtomicUsize::new(0),
            timing,
            pressure,
        }))
    }

    /// Where `studio-status` and `studio-setup` go (the app's event bus).
    pub fn on_event(&self, emit: impl Fn(&str, Value) + Send + Sync + 'static) {
        *self.0.events.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(emit));
    }

    pub(crate) fn prefs(&self) -> (String, String, String) {
        let core = self.0.lock();
        (
            core.model_id.clone(),
            core.voice.clone(),
            core.style.clone(),
        )
    }

    /// Save the studio settings `prefs` names (`model`, `voice`, `style`).
    /// Switching the model stops the sidecar; the next request starts one on
    /// the new model. A model that doesn't exist, or a switch while an
    /// install runs, is refused before anything is saved.
    pub(crate) fn set_prefs(&self, prefs: &Value) -> Result<(), String> {
        let model = prefs["model"].as_str();
        if let Some(m) = model.filter(|m| variant(m).is_none()) {
            return Err(format!("there is no studio voice model '{m}'"));
        }
        let mut out = Out::default();
        {
            let mut guard = self.0.lock();
            let core = &mut *guard;
            let switched = model.is_some_and(|m| m != core.model_id);
            if switched && core.installing.is_some() {
                return Err(INSTALLING.into());
            }
            for (key, setting, value) in [
                ("model", SETTING_MODEL, &mut core.model_id),
                ("voice", SETTING_VOICE, &mut core.voice),
                ("style", SETTING_STYLE, &mut core.style),
            ] {
                if let Some(v) = prefs[key].as_str().map(str::trim) {
                    self.0
                        .db
                        .set_setting(setting, v)
                        .map_err(|e| e.to_string())?;
                    *value = v.to_string();
                }
            }
            if switched {
                core.stop("switch", &mut out);
            }
        }
        self.0.flush(out);
        Ok(())
    }

    /// Queue one piece of speech; its frames follow on `on_audio`.
    pub(crate) fn speak(
        &self,
        text: &str,
        generation: u64,
        piece: &Value,
        on_audio: Channel<Response>,
    ) -> Result<(), String> {
        let inner = &self.0;
        let mut out = Out::default();
        let spoke = {
            let mut core = inner.lock();
            inner.can_speak(&mut core).and_then(|()| {
                let voice = piece["voice"].as_str().filter(|v| !v.trim().is_empty());
                let line = json!({
                    "generation": generation, "op": "speak", "text": text,
                    "voice": voice.unwrap_or(&core.voice), "instruct": piece["instruct"],
                    "interval": piece["interval"], "supersede": false,
                });
                inner.submit(
                    &mut core,
                    line,
                    generation,
                    true,
                    Sink::Audio(on_audio),
                    &mut out,
                )
            })
        };
        inner.flush(out);
        spoke
    }

    /// End every request of `generation` now, and tell the sidecar to drop
    /// them; their late audio is dropped here.
    pub(crate) fn cancel(&self, generation: u64) {
        let mut out = Out::default();
        {
            let mut guard = self.0.lock();
            let core = &mut *guard;
            let now = Instant::now();
            let mut ids = Vec::new();
            // Speech, and polishes (their warm-ups are generation 0, which no
            // driver ever draws).
            for (id, r) in core.queue.iter_mut().chain(core.polish.iter_mut()) {
                let ours = r.speak || r.until.is_some();
                if ours && r.generation == generation && r.gone_at.is_none() {
                    r.end(json!({"type": "cancelled"}), CANCELLED, &mut out);
                    r.gone_at = Some(now);
                    ids.push(*id);
                }
            }
            for id in ids {
                core.send_line(json!({"op": "cancel", "target": id}));
            }
        }
        self.0.flush(out);
    }

    /// Load the model ahead of the first sentence (pre-warm on intent): only
    /// when the studio voice is the engine, unless `always` (a settings
    /// preview, before the engine is saved).
    pub(crate) fn warm(&self, always: bool) -> Result<(), String> {
        let inner = &self.0;
        if !always && inner.db.get_setting("tts_engine").as_deref() != Some("studio") {
            return Ok(());
        }
        let mut out = Out::default();
        let warmed = {
            let mut core = inner.lock();
            inner.can_speak(&mut core).and_then(|()| {
                if !matches!(core.model, Model::Off | Model::Unloaded) {
                    return Ok(());
                }
                let line = json!({"op": "warmup", "voice": core.voice});
                inner.submit(&mut core, line, 0, false, Sink::Gone, &mut out)?;
                core.model = Model::Loading;
                Ok(())
            })
        };
        inner.flush(out);
        warmed
    }

    /// Polish one dictation (module docs): its outcome arrives as one `FINAL`
    /// frame on `reply`. Refused at once, so the frontend polishes with the
    /// cleanup child, when the polish model isn't installed or can't be had
    /// now.
    pub(crate) fn polish(
        &self,
        text: &str,
        vocab: &Value,
        generation: u64,
        reply: Channel<Response>,
    ) -> Result<(), String> {
        let inner = &self.0;
        let mut out = Out::default();
        let asked = {
            let mut core = inner.lock();
            inner.can_polish(&mut core).and_then(|()| {
                // Ready, its prompt built for this vocabulary and no warm-up
                // ahead of it: the plain budget. Otherwise it loads, or builds
                // the prompt, first.
                let warm = core.polish_model == Model::Ready
                    && core.polish_vocab == *vocab
                    && core.polish.iter().all(|(_, r)| r.generation != 0);
                let words = text.split_whitespace().count();
                let limit = inner.polish_budget(words, warm);
                let line = json!({"op": "polish", "text": text, "vocab": vocab});
                let sink = Sink::Audio(reply);
                inner.submit_polish(&mut core, line, generation, limit, sink, &mut out)?;
                // After a restart for it, too: the new sidecar builds it.
                core.polish_vocab = vocab.clone();
                Ok(())
            })
        };
        inner.flush(out);
        asked
    }

    /// Load the polish model, and build its prompt for `vocab`, ahead of a
    /// dictation's polish: a dictation started into a composer that polishes.
    /// Nothing when it isn't installed, or is ready for this vocabulary.
    /// `false` when it isn't installed: the cleanup child will polish, and the
    /// frontend warms that instead.
    pub(crate) fn warm_polish(&self, vocab: &Value) -> Result<bool, String> {
        let inner = &self.0;
        let mut out = Out::default();
        let warmed = {
            let mut core = inner.lock();
            if !inner.polish_installed(&mut core) {
                return Ok(false);
            }
            let current = match core.polish_model {
                Model::Loading => true,
                Model::Ready => core.polish_vocab == *vocab,
                Model::Off | Model::Unloaded => false,
            };
            if current {
                return Ok(true);
            }
            inner.can_polish(&mut core).and_then(|()| {
                let line = json!({"op": "warmup", "slot": "polish", "vocab": vocab});
                inner.submit_polish(&mut core, line, 0, WARM_LIMIT, Sink::Gone, &mut out)?;
                core.polish_vocab = vocab.clone();
                if core.polish_model != Model::Ready {
                    core.polish_model = Model::Loading;
                }
                Ok(true)
            })
        };
        inner.flush(out);
        warmed
    }

    /// A voice surface (the voice panel, a chat's read-aloud) opened or closed.
    /// Five minutes after the last one closes the process is stopped.
    pub(crate) fn surface(&self, name: &str, open: bool) {
        let mut core = self.0.lock();
        core.surfaces.retain(|s| s != name);
        if open {
            core.surfaces.push(name.to_string());
            core.closed_at = None;
        } else if core.surfaces.is_empty() {
            core.closed_at = Some(Instant::now());
        }
    }

    /// Stop the process at app exit. Sync (`RunEvent::Exit`), so it only
    /// tries the lock; the sidecar also exits by itself when its stdin closes.
    pub(crate) fn kill(&self) {
        if let Ok(mut core) = self.0.core.try_lock() {
            if let Some(live) = core.live.take() {
                live.kill();
            }
        }
    }

    /// What the settings card and the voice surfaces go by: whether this Mac
    /// can run it, what is installed (`models`: the polish model too), the
    /// process's state (`off`, `starting`, `loading`, `ready`, `unloaded` or
    /// `disabled`) and why, the model an install is fetching (`installing`),
    /// the install's speed check, and macOS's memory-pressure level (2 and up
    /// is "warn").
    pub(crate) fn status(&self) -> Value {
        let inner = &self.0;
        let mut core = inner.lock();
        let installed = inner.installed(&mut core);
        let record = core.record.clone().unwrap_or_default();
        let speed = record["models"][&core.model_id]["speedRatio"].as_f64();
        let state = if core.disabled {
            "disabled"
        } else if core.live.is_none() {
            "off"
        } else {
            match core.model {
                Model::Off => "starting",
                Model::Loading => "loading",
                Model::Ready => "ready",
                Model::Unloaded => "unloaded",
            }
        };
        json!({
            "supported": supported(), "model": core.model_id, "installed": installed,
            "models": record["models"], "runtimeCurrent": record["lock"] == lock_hash().as_str(),
            "state": state, "reason": core.reason, "installing": core.installing,
            "speedRatio": speed, "slow": speed.is_some_and(|r| r > MAX_SPEED_RATIO),
            "pressure": (inner.pressure)(),
        })
    }

    /// The runtime's interpreter, once it is built from this binary's lock:
    /// numpy and onnxruntime are in it, so the end-of-turn model can run on it
    /// where Kokoro's runtime isn't installed (turn_scorer.rs).
    pub(crate) fn python(&self) -> Option<PathBuf> {
        let inner = &self.0;
        let mut core = inner.lock();
        let record = core.record.get_or_insert_with(|| read_record(&inner.dir));
        let python = inner.dir.join("venv/bin/python3");
        (record["lock"] == lock_hash().as_str() && python.exists()).then_some(python)
    }

    /// Whether `model` (else the selected one; the polish model's id for
    /// it) can be installed here, with the numbers behind it. Each of
    /// `blockers` is a code the settings card words: `unsupported` (not Apple
    /// Silicon on macOS 14 or later), `ram` (less than `needRamBytes`), `disk`
    /// (less free than `needDiskBytes`), `memory` (less free right now than
    /// `needMemoryBytes`, which it uses while in use).
    pub(crate) fn preflight(&self, model: Option<&str>) -> Value {
        let model = model.map_or_else(|| self.0.lock().model_id.clone(), String::from);
        installable(&model).map_or(Value::Null, |v| self.0.preflight(v))
    }

    /// Install the selected model (or, with `polish`, the polish model) and
    /// the runtime it needs, in the background: progress, then `done` (with a
    /// voice's speed check) or `error`, on `studio-setup`. One install at a
    /// time.
    pub(crate) fn install(&self, polish: bool) {
        let model = {
            let mut core = self.0.lock();
            if core.installing.is_some() {
                return;
            }
            let model = if polish {
                POLISH.id.to_string()
            } else {
                core.model_id.clone()
            };
            core.installing = Some(installable(&model).map_or("", |v| v.id));
            self.0.stop_install.store(false, Ordering::Relaxed);
            // Installing again is the way back from a crash-disabled engine.
            core.disabled = false;
            core.exits.clear();
            model
        };
        let inner = self.0.clone();
        background(Box::new(move || {
            while inner.removing.load(Ordering::SeqCst) > 0 {
                std::thread::sleep(Duration::from_millis(50));
            }
            let result = tauri::async_runtime::block_on(inner.install(&model));
            inner.lock().installing = None;
            let mut done = result.unwrap_or_else(|e| {
                tracing::warn!(target: "studio", "install failed: {e}");
                json!({"phase": "error", "message": e})
            });
            done["polish"] = polish.into();
            inner.emit("studio-setup", done);
        }));
    }

    /// Stop the install at its next step: mid-download, or between steps.
    /// What it fetched stays, so installing again resumes it.
    pub(crate) fn cancel_install(&self) {
        self.0.stop_install.store(true, Ordering::Relaxed);
    }

    /// Remove the studio voice, or with `polish` local polish, in the
    /// background; an install started meanwhile waits for it to finish. The
    /// last of the two to go takes everything under `voice-studio/` with it,
    /// the runtime too. While the voice stays, the sidecar lets go of the
    /// polish model and speaks on; while local polish stays, the process
    /// stops and the voice's models go.
    pub(crate) fn remove(&self, polish: bool) -> Result<(), String> {
        let mut out = Out::default();
        let doomed = {
            let mut core = self.0.lock();
            if core.installing.is_some() {
                return Err(INSTALLING.into());
            }
            let dir = &self.0.dir;
            let models = dir.join("models");
            // The other of the two is installed, and keeps the runtime.
            let other = core.record.get_or_insert_with(|| read_record(dir))["models"]
                .as_object()
                .is_some_and(|m| m.keys().any(|id| (id == POLISH.id) != polish));
            let doomed = if !other {
                core.stop("removed", &mut out);
                core.record = Some(json!({}));
                vec![dir.clone()]
            } else if polish {
                self.0.record_in(&mut core, &|r| {
                    if let Some(models) = r["models"].as_object_mut() {
                        models.remove(POLISH.id);
                    }
                })?;
                core.send_line(json!({"op": "unload", "slot": "polish"}));
                vec![models.join(POLISH.id)]
            } else {
                self.0.record_in(&mut core, &|r| {
                    r["models"] = json!({POLISH.id: r["models"][POLISH.id].take()});
                })?;
                core.stop("removed", &mut out);
                let voice = VARIANTS.iter().map(|v| v.id).chain(["shared"]);
                voice.map(|d| models.join(d)).collect()
            };
            // Counted before this returns, so an install asked for next waits.
            self.0.removing.fetch_add(1, Ordering::SeqCst);
            doomed
        };
        self.0.flush(out);
        let inner = self.0.clone();
        background(Box::new(move || {
            for dir in &doomed {
                let _ = std::fs::remove_dir_all(dir);
            }
            inner.removing.fetch_sub(1, Ordering::SeqCst);
        }));
        Ok(())
    }
}

/// Run `job` on a thread of its own: the sidecar's writer and reader, the
/// install (minutes, mostly waiting on the network) and the removal. Boxed,
/// so every one shares a single instance of the thread-start code.
fn background(job: Box<dyn FnOnce() + Send>) {
    std::thread::spawn(job);
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn emit(&self, event: &str, payload: Value) {
        let emit = self
            .events
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(emit) = emit {
            emit(event, payload);
        }
    }

    fn flush(&self, out: Out) {
        for (ch, frame) in out.frames {
            let _ = ch.send(Response::new(frame));
        }
        for (slot, outcome) in out.replies {
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(outcome);
        }
        for (event, payload) in out.events {
            self.emit(event, payload);
        }
    }

    fn installed(&self, core: &mut Core) -> bool {
        let model = core.model_id.clone();
        self.has(core, &model)
    }

    fn polish_installed(&self, core: &mut Core) -> bool {
        self.has(core, POLISH.id)
    }

    /// Whether `model` is installed, and the runtime it runs on is this
    /// Redline's.
    fn has(&self, core: &mut Core, model: &str) -> bool {
        let record = core.record.get_or_insert_with(|| read_record(&self.dir));
        record["lock"] == lock_hash().as_str()
            && record["models"].get(model).is_some()
            && self.dir.join("venv/bin/python3").exists()
    }

    fn can_speak(&self, core: &mut Core) -> Result<(), String> {
        if core.disabled {
            return Err(DISABLED.into());
        }
        if !self.installed(core) {
            return Err(NOT_INSTALLED.into());
        }
        if matches!(core.model, Model::Off | Model::Unloaded)
            && (self.pressure)().is_some_and(|l| l >= 2)
        {
            return Err(PRESSURE.into());
        }
        Ok(())
    }

    /// Like `can_speak`, for the polish model.
    fn can_polish(&self, core: &mut Core) -> Result<(), String> {
        if core.disabled {
            return Err(DISABLED.into());
        }
        if !self.polish_installed(core) {
            return Err(POLISH_NOT_INSTALLED.into());
        }
        if matches!(core.polish_model, Model::Off | Model::Unloaded)
            && (self.pressure)().is_some_and(|l| l >= 2)
        {
            return Err(PRESSURE.into());
        }
        Ok(())
    }

    /// How long a polish of `words` gets: `timing.polish` up to 30 words,
    /// 10 ms a word more past that (80 words measured 806 ms p95, quiet), at
    /// most twice it; and the loading allowance on top unless the model is
    /// `warm` for it.
    fn polish_budget(&self, words: usize, warm: bool) -> Duration {
        let t = self.timing;
        let more = Duration::from_millis(10) * words.saturating_sub(30) as u32;
        let budget = (t.polish + more).min(t.polish * 2);
        if warm {
            budget
        } else {
            budget + t.loading
        }
    }

    /// Write a polish-slot request, given up on after `limit`. A sidecar
    /// started before the polish model was installed is started again with
    /// it — unless speech is under way, which it would cut off.
    fn submit_polish(
        self: &Arc<Self>,
        core: &mut Core,
        mut line: Value,
        generation: u64,
        limit: Duration,
        sink: Sink,
        out: &mut Out,
    ) -> Result<(), String> {
        if core.live.as_ref().is_some_and(|l| !l.polish) {
            if !core.queue.is_empty() {
                return Err(POLISH_LATER.into());
            }
            core.stop("polish", out);
        }
        self.ensure_live(core, out)?;
        let now = Instant::now();
        let id = core.next_id;
        core.next_id += 1;
        line["id"] = id.into();
        core.polish.push((
            id,
            Request {
                generation,
                speak: false,
                sink,
                frames: 0,
                last_frame: None,
                gone_at: None,
                until: Some(now + limit),
            },
        ));
        core.last_used = now;
        core.send_line(line);
        Ok(())
    }

    /// Write one request to the sidecar under the next id, starting a
    /// sidecar if none is running. A sidecar that can't start ends nothing
    /// here: the request is refused, and the failure counts as an exit.
    fn submit(
        self: &Arc<Self>,
        core: &mut Core,
        mut line: Value,
        generation: u64,
        speak: bool,
        sink: Sink,
        out: &mut Out,
    ) -> Result<(), String> {
        self.ensure_live(core, out)?;
        let now = Instant::now();
        let id = core.next_id;
        core.next_id += 1;
        line["id"] = id.into();
        core.queue.push((
            id,
            Request {
                generation,
                speak,
                sink,
                frames: 0,
                last_frame: None,
                gone_at: None,
                until: None,
            },
        ));
        core.rehead(now);
        core.last_used = now;
        core.send_line(line);
        Ok(())
    }

    /// Start the sidecar and its two threads: a stdin writer, fed through an
    /// inbox, that also runs the ticker (watchdog and idle stop) between
    /// batches, and a stdout router. Its stderr goes to `sidecar.log`, so it can never fill
    /// a pipe and stall the process. Plain threads over blocking pipes: async
    /// tasks would cost the release binary a state machine and a task each.
    fn ensure_live(self: &Arc<Self>, core: &mut Core, out: &mut Out) -> Result<(), String> {
        if core.live.is_some() {
            return Ok(());
        }
        let polish = self.polish_installed(core);
        let mut child = match self.launch(&core.model_id, polish) {
            Ok(child) => child,
            Err(e) => {
                tracing::error!(target: "studio", "{e}");
                core.exited("it could not start", self.timing.exit_window, out);
                return Err("sidecar_exited".into());
            }
        };
        core.epoch += 1;
        let epoch = core.epoch;
        let (stdin, stdout) = (child.stdin.take(), child.stdout.take());
        let child = Arc::new(StdMutex::new(child));
        let inbox = Arc::new((StdMutex::new(Vec::new()), Condvar::new()));
        core.live = Some(Live {
            epoch,
            inbox: inbox.clone(),
            child: child.clone(),
            why: None,
            polish,
        });
        core.model = Model::Off;
        core.reason = None;

        let writer = self.clone();
        background(Box::new(move || {
            let Some(mut stdin) = stdin else { return };
            // Until the process is no longer the running one: closing stdin
            // then is the sidecar's cue to exit.
            while writer.tick(epoch) {
                let (lines, wake) = &*inbox;
                let mut waiting = lines.lock().unwrap_or_else(|p| p.into_inner());
                if waiting.is_empty() {
                    waiting = wake
                        .wait_timeout(waiting, writer.timing.tick)
                        .map_or_else(|p| p.into_inner().0, |w| w.0);
                }
                let batch = std::mem::take(&mut *waiting);
                drop(waiting);
                for line in batch {
                    if stdin
                        .write_all(line.as_bytes())
                        .and_then(|()| stdin.flush())
                        .is_err()
                    {
                        writer.end(epoch, "a write to it failed");
                    }
                }
            }
        }));
        let reader = self.clone();
        background(Box::new(move || {
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Some(Ok(line)) = lines.next() {
                    if let Some(why) = reader.on_line(epoch, &line) {
                        reader.end(epoch, why);
                    }
                }
            }
            // Its output is closed: make sure it is gone, and reap it.
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
                let _ = c.wait();
            }
            reader.lost(epoch);
        }));
        Ok(())
    }

    /// End the process of `epoch` for `why` (a fatal report, a wedge); its
    /// reader then reports the exit.
    fn end(&self, epoch: u64, why: &'static str) {
        let mut core = self.lock();
        if let Some(live) = core.live.as_mut().filter(|l| l.epoch == epoch) {
            live.why.get_or_insert(why);
            live.kill();
        }
    }

    /// The process of `epoch` is gone. Unless Redline stopped it on purpose,
    /// that is an exit.
    fn lost(&self, epoch: u64) {
        let mut out = Out::default();
        {
            let mut core = self.lock();
            if core.live_epoch() != Some(epoch) {
                return; // stopped on purpose
            }
            let why = core
                .live
                .as_ref()
                .and_then(|l| l.why)
                .unwrap_or("it closed its output");
            core.exited(why, self.timing.exit_window, &mut out);
        }
        self.flush(out);
    }

    fn launch(&self, model: &str, polish: bool) -> Result<Child, String> {
        let script = self.dir.join("studio_tts_sidecar.py");
        std::fs::write(&script, inflate(SIDECAR_Z))
            .map_err(|e| format!("could not write the studio voice's sidecar: {e}"))?;
        let mut c = std::process::Command::new(self.dir.join("venv/bin/python3"));
        c.arg("-I")
            .arg(&script)
            .arg("--models-root")
            .arg(self.dir.join("models"))
            .args(["--model", model, "--idle-unload-s", IDLE_UNLOAD_S]);
        // The polish model loads only when a dictation is first polished.
        if polish {
            c.args(["--polish-model", POLISH.id]);
            c.args(["--polish-idle-unload-s", POLISH_IDLE_UNLOAD_S]);
        }
        // Below 32 GB, MLX's buffer cache gives back ~350 MB for ~6% speed.
        if sysctl_int("hw.memsize").is_some_and(|ram| ram < 32 << 30) {
            c.args(["--cache-limit-mb", "0"]);
        }
        let log = std::fs::File::create(self.dir.join("sidecar.log"))
            .map_or_else(|_| Stdio::null(), Stdio::from);
        c.env("HF_HOME", self.dir.join("hf"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log);
        c.spawn()
            .map_err(|e| format!("could not start the studio voice: {e}"))
    }

    /// Route one line of the sidecar's output. `Some` ends the process.
    fn on_line(&self, epoch: u64, line: &str) -> Option<&'static str> {
        // The sidecar keeps library output off stdout, so a line that isn't
        // JSON is skipped rather than logged.
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return None;
        };
        let kind = msg["type"].as_str().unwrap_or_default().to_string();
        let id = msg["id"].as_u64();
        // Audio is decoded into its frame before the lock is taken.
        let mut pcm = None;
        if kind == "chunk" {
            let mut f = vec![0u8; 12];
            let b64 = msg["pcm16"].as_str().unwrap_or_default();
            if base64::engine::general_purpose::STANDARD
                .decode_vec(b64, &mut f)
                .is_ok()
            {
                pcm = Some(f);
            }
        }
        let mut out = Out::default();
        let mut end = None;
        {
            let mut core = self.lock();
            if core.live_epoch() != Some(epoch) {
                return Some("stopped");
            }
            let now = Instant::now();
            match kind.as_str() {
                "hello" if msg["protocol"] != 1 => end = Some("it speaks another protocol"),
                "hello" => tracing::info!(target: "studio", "sidecar up: {}", msg["versions"]),
                "fatal" => end = Some("it reported a fatal error"),
                // The polish model's own load and unload: the voice's state,
                // and the voice surfaces, are not about it.
                "state" if msg["slot"] == "polish" => {
                    core.polish_model = match msg["state"].as_str() {
                        Some("loading") => Model::Loading,
                        Some("ready") => Model::Ready,
                        Some("unloaded") => Model::Unloaded,
                        _ => core.polish_model,
                    };
                }
                "state" => {
                    core.model = match msg["state"].as_str() {
                        Some("loading") => Model::Loading,
                        Some("ready") => Model::Ready,
                        Some("unloaded") => Model::Unloaded,
                        _ => core.model,
                    };
                    core.reason = msg["reason"].as_str().map(String::from);
                    out.events.push((
                        "studio-status",
                        json!({"state": msg["state"], "reason": msg["reason"]}),
                    ));
                }
                "chunk" if msg["final"] != true => {
                    if let (Some(r), Some(mut f)) = (id.and_then(|id| core.request(id)), pcm) {
                        if let Sink::Audio(ch) = &r.sink {
                            let seq = msg["seq"].as_u64().unwrap_or(r.frames as u64) as u32;
                            header(&mut f, r.generation, seq, 0);
                            out.frames.push((ch.clone(), f));
                        }
                        r.frames += 1;
                        r.last_frame = Some(now);
                    }
                }
                _ if msg["final"] == true => {
                    let flags = match kind.as_str() {
                        "cancelled" => CANCELLED,
                        "error" => ERROR,
                        _ => 0,
                    };
                    let at = core.queue.iter().position(|(i, _)| Some(*i) == id);
                    if let Some((_, mut r)) = at.map(|at| core.queue.remove(at)) {
                        match kind.as_str() {
                            "warm" => core.model = Model::Ready,
                            "error" if !r.speak => core.model = Model::Off,
                            _ => {}
                        }
                        r.end(msg, flags, &mut out);
                        core.rehead(now);
                        core.last_used = now;
                    } else if let Some(at) = core.polish.iter().position(|(i, _)| Some(*i) == id) {
                        let (_, mut r) = core.polish.remove(at);
                        match kind.as_str() {
                            "warm" => core.polish_model = Model::Ready,
                            // A load that failed says nothing else.
                            "error" if core.polish_model == Model::Loading => {
                                core.polish_model = Model::Off
                            }
                            _ => {}
                        }
                        r.end(msg, flags, &mut out);
                        core.last_used = now;
                    }
                }
                _ => {}
            }
        }
        self.flush(out);
        end
    }

    /// The watchdog and the idle stops, run by the writer every `timing.tick`
    /// (and after each line): `false` once the process of `epoch` is gone.
    fn tick(&self, epoch: u64) -> bool {
        let t = self.timing;
        let now = Instant::now();
        let mut out = Out::default();
        let mut wedged = None;
        {
            let mut core = self.lock();
            if core.live_epoch() != Some(epoch) {
                return false;
            }
            let ready = core.model == Model::Ready;
            let front = core.queue.first().map(|(id, r)| (*id, r.speak));
            let speech = core
                .speech
                .and_then(|id| core.request(id).map(|r| (id, r.gone_at, r.last_frame)));
            let front_since = core.front_since;
            if front.is_some_and(|(_, speak)| !speak)
                && now.duration_since(front_since) > WARM_LIMIT
            {
                wedged = Some("its warm-up never finished");
            }
            // A polish past its budget ends `slow`, and the sidecar is told
            // to drop it; one the sidecar never lets go of is forgotten.
            let mut late = Vec::new();
            for (id, r) in core.polish.iter_mut() {
                if r.gone_at.is_none() && r.until.is_some_and(|until| now > until) {
                    let slow =
                        json!({"type": "error", "code": "slow", "message": "no polish in time"});
                    r.end(slow, ERROR, &mut out);
                    r.gone_at = Some(now);
                    late.push(*id);
                }
            }
            core.polish.retain(|(_, r)| {
                r.gone_at
                    .is_none_or(|at| now.duration_since(at) < WARM_LIMIT)
            });
            for id in late {
                core.send_line(json!({"op": "cancel", "target": id}));
            }
            let polishing = core.polish.iter().any(|(_, r)| r.gone_at.is_none());
            match speech {
                Some((id, None, last_frame)) => {
                    // Behind a warm-up it waits on the model, so it gets the
                    // loading allowance; at the front, the warm one.
                    let (since, limit) = match last_frame {
                        Some(at) => (at, t.loading),
                        None if front == Some((id, true)) => (
                            core.speech_since.max(front_since),
                            if ready { t.warm } else { t.loading },
                        ),
                        None => (core.speech_since, t.loading),
                    };
                    if now.duration_since(since) > limit {
                        if let Some(r) = core.request(id) {
                            let stalled = json!({"type": "error", "code": "stalled", "message": "no audio in time"});
                            r.end(stalled, ERROR, &mut out);
                            r.gone_at = Some(now);
                        }
                        core.send_line(json!({"op": "cancel", "target": id}));
                    }
                }
                Some((id, Some(at), _)) => {
                    if ready
                        && front == Some((id, true))
                        && now.duration_since(at.max(front_since)) > t.hung
                    {
                        wedged = Some("it stopped answering");
                    }
                }
                None if front.is_some() || polishing => {}
                None => {
                    let idle = now.duration_since(core.last_used);
                    if idle > t.idle {
                        core.stop("idle", &mut out);
                    } else if core
                        .closed_at
                        .is_some_and(|at| now.duration_since(at.max(core.last_used)) > t.closed)
                    {
                        core.stop("closed", &mut out);
                    }
                }
            }
        }
        self.flush(out);
        if let Some(why) = wedged {
            self.end(epoch, why);
        }
        true
    }

    /// Ask the sidecar something of Redline's own and wait for its answer:
    /// the install's warm-up (of the polish model, for `"slot": "polish"`)
    /// and speed check, on the install's own thread. An `error` is an `Err`.
    fn ask(self: &Arc<Self>, line: Value, speak: bool, limit: Duration) -> Result<Value, String> {
        let slot = Arc::new(StdMutex::new(None));
        let mut out = Out::default();
        let asked = {
            let mut core = self.lock();
            let sink = Sink::Reply(slot.clone());
            if line["slot"] == "polish" {
                self.can_polish(&mut core)
                    .and_then(|()| self.submit_polish(&mut core, line, 0, limit, sink, &mut out))
            } else {
                self.can_speak(&mut core)
                    .and_then(|()| self.submit(&mut core, line, 0, speak, sink, &mut out))
            }
        };
        self.flush(out);
        asked?;
        let started = Instant::now();
        let answer = loop {
            if let Some(answer) = slot.lock().unwrap_or_else(|p| p.into_inner()).take() {
                break answer;
            }
            if started.elapsed() > limit {
                return Err("the studio voice didn't answer in time".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        match answer["type"].as_str() {
            Some("error") => Err(format!(
                "the studio voice failed: {}",
                answer["message"]
                    .as_str()
                    .or(answer["code"].as_str())
                    .unwrap_or("unknown error")
            )),
            _ => Ok(answer),
        }
    }

    fn setup(&self, phase: &str, received: u64, total: u64) {
        let polish = self.lock().installing == Some(POLISH.id);
        self.emit(
            "studio-setup",
            json!({"phase": phase, "received": received, "total": total, "polish": polish}),
        );
    }

    /// Download progress, at most five times a second; false once the
    /// install is cancelled.
    fn progress(&self, phase: &str, received: u64, total: u64) -> bool {
        let now = Instant::now();
        {
            let mut last = self.last_progress.lock().unwrap_or_else(|p| p.into_inner());
            if last.is_none_or(|at| now.duration_since(at) >= Duration::from_millis(200))
                || received >= total
            {
                *last = Some(now);
                drop(last);
                self.setup(phase, received, total);
            }
        }
        self.going()
    }

    /// Whether the install is still wanted.
    fn going(&self) -> bool {
        !self.stop_install.load(Ordering::Relaxed)
    }

    fn preflight(&self, v: &Variant) -> Value {
        let supported = supported();
        let ram = sysctl_int("hw.memsize").unwrap_or(0);
        // The share of memory macOS counts as available, as `memory_pressure` reports it.
        let free_memory = ram / 100 * sysctl_int("kern.memorystatus_level").unwrap_or(100);
        let free_disk = crate::activation::free_bytes(&self.data_dir).unwrap_or(u64::MAX);
        let models = self.dir.join("models");
        let mut have = 0;
        for (dir, files) in [("shared", shared_of(v)), (v.id, v.own)] {
            for (path, c) in files {
                if std::fs::metadata(models.join(dir).join(path)).is_ok_and(|m| m.len() == c.bytes)
                {
                    have += c.bytes;
                }
            }
        }
        let need_disk = v.disk.saturating_sub(have);
        let blockers: Vec<&str> = [
            (!supported, "unsupported"),
            (supported && ram < v.ram, "ram"),
            (supported && free_disk < need_disk, "disk"),
            (supported && free_memory < v.memory, "memory"),
        ]
        .into_iter()
        .filter_map(|(blocked, code)| blocked.then_some(code))
        .collect();
        json!({
            "supported": supported, "blockers": blockers, "ramBytes": ram,
            "freeMemoryBytes": free_memory, "freeDiskBytes": free_disk,
            "needDiskBytes": need_disk, "needMemoryBytes": v.memory, "needRamBytes": v.ram,
        })
    }

    /// Change `install.json` (the cached copy and the file).
    fn record(&self, change: &dyn Fn(&mut Value)) -> Result<(), String> {
        self.record_in(&mut self.lock(), change)
    }

    fn record_in(&self, core: &mut Core, change: &dyn Fn(&mut Value)) -> Result<(), String> {
        let record = core.record.get_or_insert_with(|| read_record(&self.dir));
        change(record);
        std::fs::write(
            self.dir.join("install.json"),
            serde_json::to_vec_pretty(record).unwrap_or_default(),
        )
        .map_err(|e| format!("could not record the studio voice's install: {e}"))
    }

    /// Install `model` (the polish model's id, or a voice variant's) and the
    /// runtime: its `done` event.
    async fn install(self: &Arc<Self>, model: &str) -> Result<Value, String> {
        let v = installable(model)
            .ok_or_else(|| format!("there is no studio voice model '{model}'"))?;
        self.setup("preflight", 0, 0);
        let preflight = self.preflight(v);
        if preflight["blockers"]
            .as_array()
            .is_some_and(|b| !b.is_empty())
        {
            return Err(format!("preflight: {}", preflight["blockers"]));
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("could not create the studio voice's directory: {e}"))?;
        let lock = lock_hash();
        let current = self
            .lock()
            .record
            .get_or_insert_with(|| read_record(&self.dir))["lock"]
            == lock.as_str();
        if !current || !self.dir.join("venv/bin/python3").exists() {
            // The venv is about to be rebuilt under a running sidecar.
            let mut out = Out::default();
            self.lock().stop("install", &mut out);
            self.flush(out);
            self.install_runtime().await?;
            self.record(&|r| r["lock"] = lock.as_str().into())?;
        }
        if !self.going() {
            return Err(STOPPED.into());
        }
        self.fetch_model(v, shared_of(v), HF).await?;
        self.record(&|r| r["models"][model] = json!({}))?;

        self.setup("warm", 0, 0);
        if v.id == POLISH.id {
            // Its first load builds its kernels: the install waits that out,
            // so the first dictation it polishes doesn't — unless the voice is
            // speaking from a sidecar started without it, which a restart
            // would cut off; the first dictation then loads it.
            let warm = json!({"op": "warmup", "slot": "polish"});
            if let Err(e) = self.ask(warm, false, WARM_LIMIT) {
                if e != POLISH_LATER {
                    return Err(e);
                }
            }
            return Ok(json!({"phase": "done"}));
        }
        let voice = DEFAULT_VOICE;
        self.ask(json!({"op": "warmup", "voice": voice}), false, WARM_LIMIT)?;
        self.setup("speed", 0, 0);
        let speak = json!({"generation": 0, "op": "speak", "text": SPEED_TEXT, "voice": voice, "seed": 7, "supersede": false});
        let spoke = self.ask(speak, true, SPEED_LIMIT)?;
        let stats = &spoke["stats"];
        let ratio = match (stats["gen_ms"].as_f64(), stats["audio_ms"].as_f64()) {
            (Some(spent), Some(audio)) if audio > 0.0 => spent / audio,
            _ => return Err("the studio voice's speed check produced no audio".into()),
        };
        self.record(&|r| r["models"][model] = json!({"speedRatio": ratio}))?;
        Ok(json!({"phase": "done", "speedRatio": ratio, "slow": ratio > MAX_SPEED_RATIO}))
    }

    /// Build the Python runtime under `voice-studio/`: uv, its CPython, and
    /// exactly the locked wheels — each checked against its hash, none built
    /// from source, and nothing resolved beyond the list (mlx-audio's own
    /// requirements would pull in audio I/O packages the sidecar never uses).
    async fn install_runtime(&self) -> Result<(), String> {
        let uv = ensure_uv(&self.http, &self.data_dir, &self.dir, &|r, t| {
            self.progress("uv", r, t)
        })
        .await?;
        let lockfile = self.dir.join("requirements.lock");
        std::fs::write(&lockfile, inflate(LOCK_Z))
            .map_err(|e| format!("could not write the studio voice's package list: {e}"))?;
        let venv = self.dir.join("venv");
        build_venv(&uv, &self.dir, &venv, &locked_install(lockfile), &|phase| {
            self.setup(phase, 0, 0)
        })
        .await?;
        Ok(())
    }

    /// Download `v` from `base` (Hugging Face, or a test server): the
    /// `shared` files into `models/shared`, linked into the variant, and its
    /// own files. A file already there at its published size was verified on
    /// the way in. A dropped connection is resumed twice (`fetch_pinned`)
    /// before the install gives up.
    async fn fetch_model(
        &self,
        v: &Variant,
        shared_files: &[(&str, FileCheck)],
        base: &str,
    ) -> Result<(), String> {
        let models = self.dir.join("models");
        let shared = models.join("shared");
        let dir = models.join(v.id);
        let present =
            |path: &Path, c: &FileCheck| std::fs::metadata(path).is_ok_and(|m| m.len() == c.bytes);
        let jobs: Vec<(PathBuf, &str, FileCheck)> = shared_files
            .iter()
            .map(|(p, c)| (shared.join(p), *p, *c))
            .chain(v.own.iter().map(|(p, c)| (dir.join(p), *p, *c)))
            .filter(|(dest, _, c)| !present(dest, c))
            .collect();
        let total: u64 = jobs.iter().map(|(_, _, c)| c.bytes).sum();
        let mut done = 0;
        for (dest, path, check) in &jobs {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    format!("could not create the studio voice's model directory: {e}")
                })?;
            }
            let url = format!("{base}{}/resolve/{}/{path}", v.repo, v.revision);
            let what = format!("the studio voice's {path}");
            fetch_pinned(
                &self.http,
                &check.at(&url),
                dest,
                &what,
                DOWNLOAD_STALL,
                &|r, _| self.progress("model", done + r, total),
            )
            .await?;
            done += check.bytes;
            self.progress("model", done, total);
        }
        for (path, check) in shared_files {
            let to = dir.join(path);
            if present(&to, check) {
                continue;
            }
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::remove_file(&to);
            let from = shared.join(path);
            std::fs::hard_link(&from, &to)
                .or_else(|_| std::fs::copy(&from, &to).map(drop))
                .map_err(|e| format!("could not place the studio voice's {path}: {e}"))?;
        }
        Ok(())
    }
}

/// Write a frame header (module docs) into the first 12 bytes of `f`.
fn header(f: &mut [u8], generation: u64, seq: u32, flags: u16) {
    f[..4].copy_from_slice(&(generation as u32).to_le_bytes());
    f[4..8].copy_from_slice(&seq.to_le_bytes());
    f[8..10].copy_from_slice(&flags.to_le_bytes());
    f[10..12].fill(0);
}

fn frame(generation: u64, seq: u32, flags: u16, body: &[u8]) -> Vec<u8> {
    let mut f = vec![0u8; 12];
    header(&mut f, generation, seq, flags);
    f.extend_from_slice(body);
    f
}

/// `install.json`: `{"lock": <lock_hash>, "models": {<variant>: {"speedRatio": …}}}`.
fn read_record(dir: &Path) -> Value {
    std::fs::read(dir.join("install.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}

/// Names the embedded lock in `install.json`, so a Redline that pins other
/// packages rebuilds the runtime (and keeps the models).
pub(crate) fn lock_hash() -> String {
    format!("{:x}", Sha256::digest(LOCK_Z))
}

/// MLX runs on Apple Silicon, and its wheels need macOS 14.
fn supported() -> bool {
    let mut buf = [0u8; 32];
    let major = sysctl("kern.osproductversion", &mut buf).and_then(|n| {
        std::str::from_utf8(&buf[..n])
            .ok()?
            .split(['.', '\0'])
            .next()?
            .parse::<u32>()
            .ok()
    });
    std::env::consts::ARCH == "aarch64" && major.is_some_and(|m| m >= 14)
}

/// macOS's memory-pressure level: 1 normal, 2 warn, 4 critical.
fn memory_pressure() -> Option<u64> {
    sysctl_int("kern.memorystatus_vm_pressure_level")
}

#[cfg(target_os = "macos")]
fn sysctl(name: &str, buf: &mut [u8]) -> Option<usize> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut len = buf.len();
    // SAFETY: `buf` is valid for `len` bytes, and sysctl writes at most that.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0).then_some(len)
}

#[cfg(not(target_os = "macos"))]
fn sysctl(_: &str, _: &mut [u8]) -> Option<usize> {
    None
}

fn sysctl_int(name: &str) -> Option<u64> {
    let mut buf = [0u8; 8];
    match sysctl(name, &mut buf)? {
        4 => Some(u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64),
        8 => Some(u64::from_ne_bytes(buf)),
        _ => None,
    }
}

/// Everything the studio voice does, in one command (each command, and each
/// argument, costs release binary). `op`:
/// - `speak`: one piece of a reply, `args` `{text, generation, voice?,
///   instruct?, interval?}`. Returns once it is queued; its audio and then its
///   outcome arrive as frames on `on_audio` (a `Channel`; module docs). Fails
///   at once, so the frontend speaks the piece in its fallback voice, when the
///   engine is off, not installed, can't start, or memory is too tight to load
///   it.
/// - `polish`: one dictation, `args` `{text, vocab, generation}`; its outcome
///   arrives as one frame on `on_audio`. Fails at once, so the frontend
///   polishes with the cleanup child, when the polish model isn't installed
///   or can't be had now.
/// - `status` (with `kokoro`: whether Kokoro can stand in), `preflight`
///   (`args` `{model?}`): the queries.
/// - `prefs`: save `args` `{model?, voice?, style?}`.
/// - `install` (`args` `{model?}`, saved first; or `{polish: true}`):
///   progress and the outcome on `studio-setup`; `cancel` stops it (its
///   outcome is the error `cancelled`), and installing again resumes.
/// - `warm`: pre-warm on intent, `args` `{always?}`; or the polish model's,
///   `args` `{polish: true, vocab}`, answering whether it is installed.
/// - `surface`: `args` `{surface, open}`, a voice surface opened or closed.
/// - `remove` (`args` `{polish?}`: local polish, else the voice; the last
///   of the two takes the runtime with it).
///
/// A plain command that never blocks (the install and the removal run on
/// threads of their own), so calls keep their order: one piece of speech
/// never overtakes the one before it.
#[tauri::command]
pub fn tts_studio(
    webview: tauri::Webview,
    tts: tauri::State<'_, TtsState>,
    op: String,
    args: Option<Value>,
    on_audio: Option<String>,
) -> Result<Value, String> {
    let studio = tts.studio();
    let args = args.unwrap_or_default();
    match op.as_str() {
        // The piece's audio, or the polish's reply, goes on `on_audio`.
        "speak" | "polish" => {
            let channel = on_audio.and_then(|id| id.parse::<JavaScriptChannelId>().ok());
            let on_audio: Channel<Response> =
                channel.ok_or("it needs a channel")?.channel_on(webview);
            let generation = args["generation"].as_u64().unwrap_or_default();
            let text = args["text"].as_str().unwrap_or_default();
            if op == "polish" {
                studio.polish(text, &args["vocab"], generation, on_audio)?;
            } else if tts.is_cancelled(generation) {
                let cancelled = frame(generation, 0, FINAL | CANCELLED, br#"{"type":"cancelled"}"#);
                let _ = on_audio.send(Response::new(cancelled));
            } else {
                studio.speak(text, generation, &args, on_audio)?;
            }
        }
        "status" => {
            // Whether Kokoro can stand in, answered here: its own status
            // starts a login shell and Pythons, and every chat asks.
            let mut status = studio.status();
            status["kokoro"] = tts.kokoro_ready().into();
            return Ok(status);
        }
        "preflight" => return Ok(studio.preflight(args["model"].as_str())),
        "prefs" => studio.set_prefs(&args)?,
        // The model to install is saved as it starts: one picked in the
        // settings card stays a choice until then.
        "install" if args["polish"] == true => studio.install(true),
        "install" => {
            studio.set_prefs(&args)?;
            studio.install(false)
        }
        // Whether local polish will do it: the frontend warms the cleanup
        // child when it won't.
        "warm" if args["polish"] == true => return studio.warm_polish(&args["vocab"]).map(Value::Bool),
        "warm" => studio.warm(args["always"] == true)?,
        "cancel" => studio.cancel_install(),
        "surface" => studio.surface(
            args["surface"].as_str().unwrap_or_default(),
            args["open"] == true,
        ),
        "remove" => studio.remove(args["polish"] == true)?,
        other => return Err(format!("the studio voice has no '{other}'")),
    }
    Ok(Value::Null)
}

#[cfg(test)]
#[path = "tts_studio_tests.rs"]
mod tests;

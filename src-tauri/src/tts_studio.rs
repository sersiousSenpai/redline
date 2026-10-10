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
//! `models/shared/` and hard-linked in), the sidecar script (written from this
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
//! **Events**: `studio-status` `{state, reason}` as the process or model
//! changes (`loading`, `ready`, `unloaded` — `reason` `idle` or
//! `memory_pressure` — `off`, `exited`, `disabled`); `studio-setup`
//! `{phase, received, total}` through an install (`preflight`, `uv`,
//! `python`, `deps`, `model`, `warm`, `speed`), ending
//! `{phase: "done", speedRatio, slow}` or `{phase: "error", message}`.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, JavaScriptChannelId, Response};

use crate::db::Database;
use crate::tts::{
    build_venv, ensure_uv, fetch_checked, FileCheck, TtsState, CANCELLED as STOPPED, DOWNLOAD_STALL,
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

/// A model variant: its repo at a pinned revision, the three files that are
/// its own, and about what it occupies in memory while speaking.
pub(crate) struct Variant {
    id: &'static str,
    repo: &'static str,
    revision: &'static str,
    own: [(&'static str, FileCheck); 3],
    memory: u64,
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
        own: [
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
    },
    // "Low memory": 0.8 GB less, weaker on numbers and identifiers.
    Variant {
        id: "1.7B-CustomVoice-4bit",
        repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit",
        revision: "f35faf19b0cc2160865af64ecf0f22f83d335135",
        own: [
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
    },
];

fn variant(id: &str) -> Option<&'static Variant> {
    VARIANTS.iter().find(|v| v.id == id)
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
    tick: Duration,
}

const TIMING: Timing = Timing {
    warm: Duration::from_millis(1500),
    loading: Duration::from_secs(4),
    hung: Duration::from_secs(5),
    idle: Duration::from_secs(30 * 60),
    closed: Duration::from_secs(5 * 60),
    exit_window: Duration::from_secs(10 * 60),
    tick: Duration::from_millis(100),
};

/// Where a request's audio and outcome go.
enum Sink {
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
    installing: bool,
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

    fn end_all(&mut self, code: &str, message: &str, out: &mut Out) {
        for (_, mut r) in std::mem::take(&mut self.queue) {
            r.end(
                json!({"type": "error", "code": code, "message": message}),
                ERROR,
                out,
            );
        }
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
            installing: false,
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
            if switched && core.installing {
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
            let mut core = self.0.lock();
            let now = Instant::now();
            let mut ids = Vec::new();
            for (id, r) in core.queue.iter_mut() {
                if r.speak && r.generation == generation && r.gone_at.is_none() {
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
    /// can run it, what is installed, the process's state (`off`, `starting`,
    /// `loading`, `ready`, `unloaded` or `disabled`) and why, the install's
    /// speed check, and macOS's memory-pressure level (2 and up is "warn").
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

    /// Whether `model` (else the selected one) can be installed here, with
    /// the numbers behind it. Each of `blockers` is a code the settings card
    /// words: `unsupported` (not Apple Silicon on macOS 14 or later), `ram`
    /// (under 16 GB), `disk` (less free than `needDiskBytes`), `memory` (less
    /// free right now than `needMemoryBytes`, which it uses while speaking).
    pub(crate) fn preflight(&self, model: Option<&str>) -> Value {
        let model = model.map_or_else(|| self.0.lock().model_id.clone(), String::from);
        variant(&model).map_or(Value::Null, |v| self.0.preflight(v))
    }

    /// Install the selected model and the runtime it needs, in the
    /// background: progress, then `done` (with the speed check) or `error`,
    /// on `studio-setup`.
    pub(crate) fn install(&self) {
        let model = {
            let mut core = self.0.lock();
            if core.installing {
                return;
            }
            core.installing = true;
            self.0.stop_install.store(false, Ordering::Relaxed);
            // Installing again is the way back from a crash-disabled engine.
            core.disabled = false;
            core.exits.clear();
            core.model_id.clone()
        };
        let inner = self.0.clone();
        background(Box::new(move || {
            let result = tauri::async_runtime::block_on(inner.install(&model));
            inner.lock().installing = false;
            let done = match result {
                Ok(ratio) => {
                    json!({"phase": "done", "speedRatio": ratio, "slow": ratio > MAX_SPEED_RATIO})
                }
                Err(e) => {
                    tracing::warn!(target: "studio", "install failed: {e}");
                    json!({"phase": "error", "message": e})
                }
            };
            inner.emit("studio-setup", done);
        }));
    }

    /// Stop the install at its next step: mid-download, or between steps.
    /// What it fetched stays, so installing again resumes it.
    pub(crate) fn cancel_install(&self) {
        self.0.stop_install.store(true, Ordering::Relaxed);
    }

    /// Stop the process and delete everything under `voice-studio/`.
    pub(crate) fn remove(&self) -> Result<(), String> {
        let mut out = Out::default();
        {
            let mut core = self.0.lock();
            if core.installing {
                return Err(INSTALLING.into());
            }
            core.stop("removed", &mut out);
            core.record = Some(json!({}));
        }
        self.0.flush(out);
        let dir = self.0.dir.clone();
        background(Box::new(move || {
            let _ = std::fs::remove_dir_all(dir);
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
        let record = core.record.get_or_insert_with(|| read_record(&self.dir));
        record["lock"] == lock_hash().as_str()
            && record["models"].get(&core.model_id).is_some()
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
        let mut child = match self.launch(&core.model_id) {
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

    fn launch(&self, model: &str) -> Result<Child, String> {
        let script = self.dir.join("studio_tts_sidecar.py");
        std::fs::write(&script, inflate(SIDECAR_Z))
            .map_err(|e| format!("could not write the studio voice's sidecar: {e}"))?;
        let mut c = std::process::Command::new(self.dir.join("venv/bin/python3"));
        c.arg("-I")
            .arg(&script)
            .arg("--models-root")
            .arg(self.dir.join("models"))
            .args(["--model", model, "--idle-unload-s", IDLE_UNLOAD_S]);
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
                    let at = core.queue.iter().position(|(i, _)| Some(*i) == id);
                    if let Some((_, mut r)) = at.map(|at| core.queue.remove(at)) {
                        match kind.as_str() {
                            "warm" => core.model = Model::Ready,
                            "error" if !r.speak => core.model = Model::Off,
                            _ => {}
                        }
                        let flags = match kind.as_str() {
                            "cancelled" => CANCELLED,
                            "error" => ERROR,
                            _ => 0,
                        };
                        r.end(msg, flags, &mut out);
                        core.rehead(now);
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
                None if front.is_some() => {}
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
    /// the install's warm-up and speed check, on the install's own thread.
    /// An `error` is an `Err`.
    fn ask(self: &Arc<Self>, line: Value, speak: bool, limit: Duration) -> Result<Value, String> {
        let slot = Arc::new(StdMutex::new(None));
        let mut out = Out::default();
        let asked = {
            let mut core = self.lock();
            self.can_speak(&mut core).and_then(|()| {
                self.submit(
                    &mut core,
                    line,
                    0,
                    speak,
                    Sink::Reply(slot.clone()),
                    &mut out,
                )
            })
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
        self.emit(
            "studio-setup",
            json!({"phase": phase, "received": received, "total": total}),
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
        for (dir, files) in [("shared", &SHARED[..]), (v.id, &v.own[..])] {
            for (path, c) in files {
                if std::fs::metadata(models.join(dir).join(path)).is_ok_and(|m| m.len() == c.bytes)
                {
                    have += c.bytes;
                }
            }
        }
        let need_disk = NEED_DISK.saturating_sub(have);
        let blockers: Vec<&str> = [
            (!supported, "unsupported"),
            (supported && ram < NEED_RAM, "ram"),
            (supported && free_disk < need_disk, "disk"),
            (supported && free_memory < v.memory, "memory"),
        ]
        .into_iter()
        .filter_map(|(blocked, code)| blocked.then_some(code))
        .collect();
        json!({
            "supported": supported, "blockers": blockers, "ramBytes": ram,
            "freeMemoryBytes": free_memory, "freeDiskBytes": free_disk,
            "needDiskBytes": need_disk, "needMemoryBytes": v.memory,
        })
    }

    /// Change `install.json` (the cached copy and the file).
    fn record(&self, change: &dyn Fn(&mut Value)) -> Result<(), String> {
        let mut core = self.lock();
        let record = core.record.get_or_insert_with(|| read_record(&self.dir));
        change(record);
        std::fs::write(
            self.dir.join("install.json"),
            serde_json::to_vec_pretty(record).unwrap_or_default(),
        )
        .map_err(|e| format!("could not record the studio voice's install: {e}"))
    }

    async fn install(self: &Arc<Self>, model: &str) -> Result<f64, String> {
        let v =
            variant(model).ok_or_else(|| format!("there is no studio voice model '{model}'"))?;
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
        self.fetch_model(v, &SHARED, HF).await?;
        self.record(&|r| r["models"][model] = json!({}))?;

        self.setup("warm", 0, 0);
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
        Ok(ratio)
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
        let install: Vec<OsString> = ["--require-hashes", "--no-deps", "--no-build", "-r"]
            .into_iter()
            .map(OsString::from)
            .chain([lockfile.into_os_string()])
            .collect();
        build_venv(&uv, &self.dir, &install, &|phase| self.setup(phase, 0, 0)).await?;
        Ok(())
    }

    /// Download `v` from `base` (Hugging Face, or a test server): the
    /// `shared` files into `models/shared`, linked into the variant, and its
    /// own files. A file already there at its published size was verified on
    /// the way in. A dropped connection is resumed twice before the install
    /// gives up.
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
            let mut tries = 0;
            loop {
                let fetched = fetch_checked(
                    &self.http,
                    &url,
                    dest,
                    &what,
                    *check,
                    DOWNLOAD_STALL,
                    &|r, _| self.progress("model", done + r, total),
                )
                .await;
                match fetched {
                    Err(e)
                        if tries < 2
                            && self.going()
                            && !e.contains("wasn't the published file") =>
                    {
                        tries += 1
                    }
                    other => break other?,
                }
            }
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

fn inflate(z: &[u8]) -> String {
    let mut out = String::new();
    let _ = flate2::read::DeflateDecoder::new(z).read_to_string(&mut out);
    out
}

/// Names the embedded lock in `install.json`, so a Redline that pins other
/// packages rebuilds the runtime (and keeps the models).
fn lock_hash() -> String {
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
/// - `status` (with `kokoro`: whether Kokoro can stand in), `preflight`
///   (`args` `{model?}`): the queries.
/// - `prefs`: save `args` `{model?, voice?, style?}`.
/// - `install` (`args` `{model?}`, saved first): progress and the outcome on
///   `studio-setup`; `cancel` stops it (its outcome is the error
///   `cancelled`), and installing again resumes.
/// - `warm`: pre-warm on intent, `args` `{always?}`.
/// - `surface`: `args` `{surface, open}`, a voice surface opened or closed.
/// - `remove`.
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
        "speak" => {
            let channel = on_audio.and_then(|id| id.parse::<JavaScriptChannelId>().ok());
            let on_audio: Channel<Response> =
                channel.ok_or("speak needs a channel")?.channel_on(webview);
            let generation = args["generation"].as_u64().unwrap_or_default();
            if tts.is_cancelled(generation) {
                let cancelled = frame(generation, 0, FINAL | CANCELLED, br#"{"type":"cancelled"}"#);
                let _ = on_audio.send(Response::new(cancelled));
            } else {
                let text = args["text"].as_str().unwrap_or_default();
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
        "install" => {
            studio.set_prefs(&args)?;
            studio.install()
        }
        "warm" => studio.warm(args["always"] == true)?,
        "cancel" => studio.cancel_install(),
        "surface" => studio.surface(
            args["surface"].as_str().unwrap_or_default(),
            args["open"] == true,
        ),
        "remove" => studio.remove()?,
        other => return Err(format!("the studio voice has no '{other}'")),
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::ipc::InvokeResponseBody;

    /// A stand-in for the sidecar, speaking protocol 1. `Studio` runs
    /// `venv/bin/python3 -I <script> …`; a shell script in that interpreter's
    /// place runs this instead. It logs each spawn (with its pid and argv)
    /// and each line it is sent beside itself, answers a warm-up with
    /// loading/ready, and speaks three tiny chunks and an `end` per request,
    /// except that the text may say: "WAIT<n>" (the first chunk comes after n
    /// ms), "SLOW" (200 ms between chunks), "STALL" (nothing until it is
    /// cancelled), "HANG" (never answers anything again), "DIE" (exits),
    /// "PRESSURE" (first reports an unload under memory pressure) or "LATE"
    /// (one more chunk after its `end`); a warm-up for the voice "WARM<n>"
    /// loads for n ms.
    const FAKE_SIDECAR: &str = r#"
import base64, collections, json, os, re, sys, threading, time
here = os.path.dirname(os.path.abspath(__file__))
def append(name, line):
    with open(os.path.join(here, name), "a") as f:
        f.write(line + "\n")
append("spawns.log", " ".join([str(os.getpid())] + sys.argv[1:]))
out = threading.Lock()
def emit(obj):
    with out:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
queue, cv, cancelled = collections.deque(), threading.Condition(), set()
pcm = base64.b64encode(b"\x01\x00" * 240).decode()
def chunk(rid, gen, seq):
    emit({"type": "chunk", "id": rid, "generation": gen, "seq": seq, "final": False,
          "sr": 24000, "samples": 240, "pcm16": pcm})
def work():
    while True:
        with cv:
            while not queue:
                cv.wait()
            req = queue.popleft()
        rid, gen, text = req.get("id"), req.get("generation"), req.get("text", "")
        if req.get("op") == "warmup":
            emit({"type": "state", "state": "loading"})
            load = re.search(r"WARM(\d+)", req.get("voice") or "")
            time.sleep(int(load.group(1)) / 1000 if load else 0)
            emit({"type": "state", "state": "ready"})
            emit({"type": "warm", "id": rid, "final": True})
            continue
        if "DIE" in text:
            os._exit(1)
        if "HANG" in text:
            time.sleep(3600)
        if "PRESSURE" in text:
            emit({"type": "state", "state": "unloaded", "reason": "memory_pressure"})
        while "STALL" in text and rid not in cancelled:
            time.sleep(0.01)
        wait = re.search(r"WAIT(\d+)", text)
        for seq in range(3):
            time.sleep(int(wait.group(1)) / 1000 if wait and seq == 0 else 0.2 if "SLOW" in text and seq else 0.01)
            if rid in cancelled:
                emit({"type": "cancelled", "id": rid, "generation": gen, "final": True})
                break
            chunk(rid, gen, seq)
        else:
            emit({"type": "end", "id": rid, "generation": gen, "seq": 3, "final": True,
                  "stats": {"gen_ms": 100, "audio_ms": 400}})
            if "LATE" in text:
                chunk(rid, gen, 3)
threading.Thread(target=work, daemon=True).start()
emit({"type": "hello", "protocol": 1, "pid": os.getpid()})
for line in sys.stdin:
    append("requests.log", line.strip())
    req = json.loads(line)
    if req.get("op") == "cancel":
        cancelled.add(req.get("target"))
        continue
    with cv:
        queue.append(req)
        cv.notify()
"#;

    const FAST: Timing = Timing {
        warm: Duration::from_millis(250),
        loading: Duration::from_millis(1500),
        hung: Duration::from_millis(400),
        idle: Duration::from_secs(60),
        closed: Duration::from_secs(60),
        exit_window: Duration::from_secs(60),
        tick: Duration::from_millis(20),
    };

    fn normal_pressure() -> Option<u64> {
        Some(1)
    }

    type Seen = Arc<StdMutex<Vec<(String, Value)>>>;

    /// A studio voice "installed" in a fresh app data dir, on the fake
    /// sidecar. Returns it, the directory the fake logs to, and the events it
    /// emitted.
    fn fake_studio(
        label: &str,
        timing: Timing,
        pressure: fn() -> Option<u64>,
    ) -> (Studio, PathBuf, Seen) {
        use std::os::unix::fs::PermissionsExt;
        let data =
            std::env::temp_dir().join(format!("redline-studio-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let bin = data.join("voice-studio/venv/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("fake_sidecar.py"), FAKE_SIDECAR).unwrap();
        let python = bin.join("python3");
        std::fs::write(
            &python,
            "#!/bin/sh\nexec python3 \"$(dirname \"$0\")/fake_sidecar.py\" \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        let record = json!({"lock": lock_hash(), "models": {VARIANTS[0].id: {}}});
        std::fs::write(data.join("voice-studio/install.json"), record.to_string()).unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        let studio = Studio::with(&data, reqwest::Client::new(), db, timing, pressure);
        let seen: Seen = Arc::default();
        let events = seen.clone();
        studio.on_event(move |event, payload| {
            events.lock().unwrap().push((event.to_string(), payload))
        });
        (studio, bin, seen)
    }

    type Frames = Arc<StdMutex<Vec<Vec<u8>>>>;

    fn recorder() -> (Channel<Response>, Frames) {
        let frames: Frames = Arc::default();
        let kept = frames.clone();
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Raw(bytes) = body else {
                panic!("studio frames are raw bytes");
            };
            kept.lock().unwrap().push(bytes);
            Ok(())
        });
        (channel, frames)
    }

    fn flags(f: &[u8]) -> u16 {
        u16::from_le_bytes([f[8], f[9]])
    }

    fn outcome(f: &[u8]) -> Value {
        serde_json::from_slice(&f[12..]).unwrap()
    }

    /// Speak `text` as `generation`, returning where its frames land.
    fn say(studio: &Studio, text: &str, generation: u64) -> Frames {
        let (channel, frames) = recorder();
        studio
            .speak(text, generation, &Value::Null, channel)
            .unwrap();
        frames
    }

    /// Every frame of a request, once its final one has arrived.
    async fn finished(frames: &Frames) -> Vec<Vec<u8>> {
        for _ in 0..500 {
            {
                let f = frames.lock().unwrap();
                if f.last().is_some_and(|f| flags(f) & FINAL != 0) {
                    return f.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "no final frame after {} frames",
            frames.lock().unwrap().len()
        );
    }

    async fn until(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..500 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn log_lines(dir: &Path, name: &str) -> Vec<String> {
        std::fs::read_to_string(dir.join(name))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn status_events(seen: &Seen) -> Vec<Value> {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "studio-status")
            .map(|(_, p)| p.clone())
            .collect()
    }

    async fn warmed(studio: &Studio) {
        studio.warm(true).unwrap();
        until("the model to be ready", || {
            studio.status()["state"] == "ready"
        })
        .await;
    }

    #[tokio::test]
    async fn speech_streams_as_raw_frames_and_ends_with_its_outcome() {
        let (studio, dir, _) = fake_studio("frames", FAST, normal_pressure);
        // Generations are seeded from the clock: the header carries the low 32 bits.
        let generation = (1u64 << 32) + 5;
        let frames = finished(&say(&studio, "Hello there.", generation)).await;
        assert_eq!(frames.len(), 4, "three chunks and the outcome");
        for (seq, f) in frames[..3].iter().enumerate() {
            assert_eq!(f[..4], 5u32.to_le_bytes());
            assert_eq!(f[4..8], (seq as u32).to_le_bytes());
            assert_eq!(flags(f), 0);
            assert_eq!(f[12..], [1u8, 0].repeat(240), "the PCM, decoded");
        }
        let last = &frames[3];
        assert_eq!(flags(last), FINAL);
        assert_eq!(outcome(last)["type"], "end");
        assert_eq!(outcome(last)["stats"]["gen_ms"], 100);

        let sent: Value = serde_json::from_str(&log_lines(&dir, "requests.log")[0]).unwrap();
        assert_eq!(sent["op"], "speak");
        assert_eq!(sent["voice"], DEFAULT_VOICE);
        assert_eq!(sent["generation"], generation);
        assert_eq!(
            sent["supersede"], false,
            "a newer generation must never cut this one off"
        );
        let spawn = &log_lines(&dir, "spawns.log")[0];
        assert!(
            spawn.contains("--model 1.7B-CustomVoice-8bit --idle-unload-s 300"),
            "{spawn}"
        );
    }

    /// The voice panel and a chat's read-aloud draw generations from one
    /// counter and share the sidecar: stopping one stops only its own.
    #[tokio::test]
    async fn cancelling_one_generation_leaves_the_other_speaking() {
        let (studio, dir, _) = fake_studio("cross-cancel", FAST, normal_pressure);
        let panel = say(&studio, "SLOW The panel's reply.", 100);
        let read_aloud = say(&studio, "SLOW A chat read aloud.", 101);
        until("the panel's first chunk", || {
            !panel.lock().unwrap().is_empty()
        })
        .await;
        studio.cancel(100);
        let stopped = panel.lock().unwrap().clone();
        let last = stopped.last().unwrap();
        assert_eq!(
            flags(last),
            FINAL | CANCELLED,
            "ended at once, not when the sidecar gets to it"
        );

        let read = finished(&read_aloud).await;
        assert_eq!(read.len(), 4);
        assert_eq!(outcome(read.last().unwrap())["type"], "end");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(*panel.lock().unwrap(), stopped, "no audio after its end");
        let cancels: Vec<Value> = log_lines(&dir, "requests.log")
            .iter()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|l| l["op"] == "cancel")
            .collect();
        assert_eq!(
            cancels,
            [json!({"op": "cancel", "target": 1})],
            "by id, never by generation"
        );
    }

    #[tokio::test]
    async fn audio_for_a_request_that_already_ended_is_dropped() {
        let (studio, _, _) = fake_studio("late", FAST, normal_pressure);
        let frames = say(&studio, "LATE One more.", 7);
        finished(&frames).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(frames.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn a_request_with_no_audio_in_time_ends_stalled_and_is_cancelled_at_the_sidecar() {
        let (studio, dir, _) = fake_studio("stall", FAST, normal_pressure);
        warmed(&studio).await;
        let started = Instant::now();
        let frames = finished(&say(&studio, "STALL Never mind.", 9)).await;
        let waited = started.elapsed();
        assert!(waited >= FAST.warm && waited < FAST.loading, "{waited:?}");
        assert_eq!(flags(&frames[0]), FINAL | ERROR);
        assert_eq!(outcome(&frames[0])["code"], "stalled");
        assert!(log_lines(&dir, "requests.log")
            .iter()
            .any(|l| l.contains(r#""target":2"#)));
        // The sidecar lets go of it, and the next request speaks.
        let next = finished(&say(&studio, "Next.", 10)).await;
        assert_eq!(outcome(next.last().unwrap())["type"], "end");
    }

    /// The watchdog counts from when a request reaches the front of the
    /// sidecar's queue, and gives a loading model longer.
    #[tokio::test]
    async fn the_watchdog_allows_for_a_loading_model_and_a_queue_ahead() {
        // The stalled request below takes the fake 700 ms to let go of.
        let timing = Timing {
            hung: Duration::from_secs(2),
            ..FAST
        };
        let (studio, _, _) = fake_studio("watchdog", timing, normal_pressure);
        // Nothing loaded yet: 700 ms to the first audio is fine.
        let cold = finished(&say(&studio, "WAIT700 Cold.", 1)).await;
        assert_eq!(outcome(cold.last().unwrap())["type"], "end");
        warmed(&studio).await;
        // Loaded: the same wait is a stall.
        let warm = finished(&say(&studio, "WAIT700 Warm.", 2)).await;
        assert_eq!(outcome(warm.last().unwrap())["code"], "stalled");
        // Behind ~400 ms of another request's speech, a fast one is not.
        let ahead = say(&studio, "SLOW Ahead.", 3);
        let behind = say(&studio, "Behind.", 3);
        assert_eq!(
            outcome(finished(&ahead).await.last().unwrap())["type"],
            "end"
        );
        assert_eq!(
            outcome(finished(&behind).await.last().unwrap())["type"],
            "end"
        );
    }

    /// Speech sent while the model warms up waits on it with the loading
    /// allowance, then gets the warm one at the front, and is never left
    /// waiting on a load that runs long.
    #[tokio::test]
    async fn speech_behind_a_warm_up_waits_for_the_model_but_not_forever() {
        let (studio, _, _) = fake_studio("behind-warm", FAST, normal_pressure);
        studio.0.lock().voice = "WARM800".into();
        studio.warm(true).unwrap();
        let soon = finished(&say(&studio, "Right after the panel opened.", 1)).await;
        assert_eq!(outcome(soon.last().unwrap())["type"], "end");

        let (studio, _, _) = fake_studio("behind-long-warm", FAST, normal_pressure);
        studio.0.lock().voice = "WARM3000".into();
        studio.warm(true).unwrap();
        let started = Instant::now();
        let waited = finished(&say(&studio, "During a first-ever load.", 1)).await;
        assert_eq!(outcome(&waited[0])["code"], "stalled");
        assert!(
            started.elapsed() < Duration::from_millis(2500),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn an_exit_ends_what_is_pending_and_a_second_turns_the_engine_off() {
        let (studio, dir, seen) = fake_studio("respawn", FAST, normal_pressure);
        let died = finished(&say(&studio, "DIE", 1)).await;
        assert_eq!(outcome(&died[0])["code"], "sidecar_exited");
        assert_eq!(status_events(&seen).last().unwrap()["state"], "exited");

        let again = finished(&say(&studio, "Back again.", 2)).await;
        assert_eq!(outcome(again.last().unwrap())["type"], "end");
        assert_eq!(log_lines(&dir, "spawns.log").len(), 2, "started afresh");

        let died = finished(&say(&studio, "DIE", 3)).await;
        assert_eq!(outcome(&died[0])["code"], "sidecar_exited");
        assert_eq!(status_events(&seen).last().unwrap()["state"], "disabled");
        let (channel, _) = recorder();
        let refused = studio.speak("Anyone?", 4, &Value::Null, channel);
        assert_eq!(refused.unwrap_err(), DISABLED);
        assert_eq!(studio.status()["state"], "disabled");
        assert_eq!(log_lines(&dir, "spawns.log").len(), 2, "no third start");
    }

    #[tokio::test]
    async fn a_wedged_sidecar_is_killed_and_counts_as_an_exit() {
        let (studio, dir, seen) = fake_studio("hung", FAST, normal_pressure);
        warmed(&studio).await;
        let frames = finished(&say(&studio, "HANG", 1)).await;
        assert_eq!(outcome(&frames[0])["code"], "stalled");
        until("the wedged sidecar to be killed", || {
            status_events(&seen)
                .last()
                .is_some_and(|e| e["state"] == "exited")
        })
        .await;
        let pid: i32 = log_lines(&dir, "spawns.log")[0]
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        // SAFETY: signal 0 only checks that the pid exists.
        until(
            "the process to be gone",
            || unsafe { libc::kill(pid, 0) } != 0,
        )
        .await;
        let next = finished(&say(&studio, "Fresh start.", 2)).await;
        assert_eq!(outcome(next.last().unwrap())["type"], "end");
    }

    static LEVEL: AtomicU64 = AtomicU64::new(1);

    fn test_pressure() -> Option<u64> {
        Some(LEVEL.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn memory_pressure_is_relayed_and_no_reload_starts_under_it() {
        let (studio, _, seen) = fake_studio("pressure", FAST, test_pressure);
        warmed(&studio).await;
        finished(&say(&studio, "PRESSURE Still speaking.", 1)).await;
        assert!(status_events(&seen)
            .contains(&json!({"state": "unloaded", "reason": "memory_pressure"})));

        LEVEL.store(2, Ordering::SeqCst);
        let (channel, _) = recorder();
        assert_eq!(
            studio
                .speak("Reload?", 2, &Value::Null, channel)
                .unwrap_err(),
            PRESSURE
        );
        assert_eq!(studio.warm(true).unwrap_err(), PRESSURE);
        LEVEL.store(1, Ordering::SeqCst);
        let back = finished(&say(&studio, "Pressure's gone.", 3)).await;
        assert_eq!(outcome(back.last().unwrap())["type"], "end");
    }

    #[tokio::test]
    async fn an_idle_sidecar_is_stopped_without_counting_as_a_crash() {
        let timing = Timing {
            idle: Duration::from_millis(300),
            ..FAST
        };
        let (studio, dir, seen) = fake_studio("idle", timing, normal_pressure);
        for generation in 1..=3 {
            finished(&say(&studio, "Then nothing.", generation)).await;
            until("the idle stop", || studio.status()["state"] == "off").await;
            assert_eq!(
                status_events(&seen).last().unwrap(),
                &json!({"state": "off", "reason": "idle"})
            );
        }
        assert_eq!(
            log_lines(&dir, "spawns.log").len(),
            3,
            "started again each time, never disabled"
        );
    }

    #[tokio::test]
    async fn the_sidecar_stops_a_while_after_the_voice_surfaces_close() {
        let timing = Timing {
            closed: Duration::from_millis(300),
            ..FAST
        };
        let (studio, _, seen) = fake_studio("closed", timing, normal_pressure);
        studio.surface("panel", true);
        studio.surface("read-aloud", true);
        finished(&say(&studio, "Open.", 1)).await;
        studio.surface("panel", false);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            studio.status()["state"],
            "starting",
            "a surface is still open"
        );
        studio.surface("read-aloud", false);
        until("the stop", || studio.status()["state"] == "off").await;
        assert_eq!(
            status_events(&seen).last().unwrap(),
            &json!({"state": "off", "reason": "closed"})
        );
    }

    #[tokio::test]
    async fn app_exit_kills_the_sidecar() {
        let (studio, dir, _) = fake_studio("exit", FAST, normal_pressure);
        let frames = say(&studio, "SLOW Mid-sentence.", 1);
        until("audio", || !frames.lock().unwrap().is_empty()).await;
        let pid: i32 = log_lines(&dir, "spawns.log")[0]
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        studio.kill();
        // SAFETY: signal 0 only checks that the pid exists.
        until(
            "the process to be gone",
            || unsafe { libc::kill(pid, 0) } != 0,
        )
        .await;
        assert_eq!(studio.status()["state"], "off");
    }

    #[tokio::test]
    async fn nothing_is_spoken_until_this_runtime_and_model_are_installed() {
        let (studio, dir, _) = fake_studio("not-installed", FAST, normal_pressure);
        let record = dir.join("../../install.json");
        for stale in [
            json!({}),
            json!({"lock": "an older lock", "models": {VARIANTS[0].id: {}}}),
            json!({"lock": lock_hash(), "models": {VARIANTS[1].id: {}}}),
        ] {
            std::fs::write(&record, stale.to_string()).unwrap();
            studio.0.lock().record = None;
            let (channel, _) = recorder();
            assert_eq!(
                studio.speak("Hi.", 1, &Value::Null, channel).unwrap_err(),
                NOT_INSTALLED
            );
            assert_eq!(studio.status()["installed"], false);
        }
        assert!(log_lines(&dir, "spawns.log").is_empty());
    }

    #[tokio::test]
    async fn switching_the_model_saves_it_and_stops_the_old_sidecar() {
        let (studio, _, seen) = fake_studio("switch", FAST, normal_pressure);
        finished(&say(&studio, "On eight bit.", 1)).await;
        let low = VARIANTS[1].id.to_string();
        studio
            .set_prefs(&json!({"model": low, "voice": "serena"}))
            .unwrap();
        assert_eq!(
            studio.prefs(),
            (low.clone(), "serena".into(), String::new())
        );
        assert_eq!(studio.0.db.get_setting(SETTING_MODEL), Some(low.clone()));
        assert_eq!(
            status_events(&seen).last().unwrap(),
            &json!({"state": "off", "reason": "switch"})
        );
        assert!(studio
            .set_prefs(&json!({"model": "2B-imaginary", "voice": "aiden"}))
            .is_err());
        assert_eq!(
            studio.prefs().1,
            "serena",
            "nothing saved from a refused change"
        );
        assert_eq!(
            studio.status()["installed"],
            false,
            "the 4-bit model was never installed"
        );
        // An install fetches the model it started with: no switching under it.
        studio.0.lock().installing = true;
        let eight = VARIANTS[0].id;
        assert_eq!(
            studio.set_prefs(&json!({"model": eight})).unwrap_err(),
            INSTALLING
        );
        studio.set_prefs(&json!({"model": low, "voice": "ryan"})).unwrap();
        assert_eq!(studio.prefs(), (low, "ryan".into(), String::new()));
    }

    /// The settings card checks a model the user is only looking at.
    #[test]
    fn preflight_answers_for_the_model_asked_about() {
        let (studio, _, _) = fake_studio("preflight", FAST, normal_pressure);
        let low = studio.preflight(Some(VARIANTS[1].id));
        assert_eq!(low["needMemoryBytes"], VARIANTS[1].memory);
        let selected = studio.preflight(None);
        assert_eq!(selected["needMemoryBytes"], VARIANTS[0].memory);
        assert_eq!(studio.preflight(Some("2B-imaginary")), Value::Null);
    }

    #[test]
    fn the_pins_are_the_published_files() {
        let eight = &VARIANTS[0];
        assert_eq!(eight.id, "1.7B-CustomVoice-8bit");
        assert_eq!(eight.revision, "41d3337e8b7f2843a75841595fc14e4b9a7a4b96");
        let (path, weights) = eight.own[1];
        assert_eq!(path, "model.safetensors");
        assert_eq!(weights.bytes, 2_393_308_931);
        assert_eq!(
            weights.sha256,
            "b696f4bf45f54497b6de758981e76f1410bd68af05a657477dee466b0202df1a"
        );
        for v in &VARIANTS {
            let files: Vec<&(&str, FileCheck)> = SHARED.iter().chain(&v.own).collect();
            let mut paths: Vec<&str> = files.iter().map(|(p, _)| *p).collect();
            paths.sort();
            paths.dedup();
            assert_eq!(paths.len(), 12, "{}: every file once", v.id);
            for (path, check) in files {
                assert_eq!(check.sha256.len(), 64, "{path}");
                assert!(check
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            }
        }
        let download = |v: &Variant| {
            SHARED
                .iter()
                .chain(&v.own)
                .map(|(_, c)| c.bytes)
                .sum::<u64>()
        };
        assert_eq!(
            download(eight),
            3_080_138_901,
            "the 3.1 GB the settings card promises"
        );
        assert!(download(&VARIANTS[1]) < download(eight));
    }

    /// Regenerate a `.deflate` beside its source with
    /// `python3 -c 'import sys, zlib; c = zlib.compressobj(9, zlib.DEFLATED, -15);
    /// sys.stdout.buffer.write(c.compress(sys.stdin.buffer.read()) + c.flush())' < F > F.deflate`.
    #[test]
    fn the_embedded_sidecar_and_lock_are_their_sources() {
        assert_eq!(
            inflate(SIDECAR_Z),
            include_str!("../resources/studio_tts_sidecar.py"),
            "stale .deflate"
        );
        let lock = inflate(LOCK_Z);
        assert_eq!(
            lock,
            include_str!("../resources/studio-requirements.lock"),
            "stale .deflate"
        );
        let pins: Vec<&str> = lock.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(pins.len(), 31);
        for pin in &pins {
            let (name, rest) = pin.split_once("==").unwrap();
            assert!(
                !name.is_empty() && rest.contains(" --hash=sha256:"),
                "{pin}"
            );
        }
        assert!(pins.iter().any(|p| p.starts_with("mlx-audio==0.5.8 ")));
    }

    /// A warm on intent (the Discuss pill's hover, a voice surface opening)
    /// loads 4 GB only for someone who speaks with the studio voice; a
    /// settings preview asks for one regardless.
    #[tokio::test]
    async fn a_warm_on_intent_loads_the_model_only_for_the_studio_engine() {
        let (studio, dir, _) = fake_studio("warm-engine", FAST, normal_pressure);
        studio.warm(false).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            log_lines(&dir, "spawns.log").is_empty(),
            "Kokoro's user pays nothing"
        );
        studio.0.db.set_setting("tts_engine", "studio").unwrap();
        studio.warm(false).unwrap();
        until("the model to be ready", || {
            studio.status()["state"] == "ready"
        })
        .await;
        assert_eq!(log_lines(&dir, "spawns.log").len(), 1);
    }

    /// Cancel stops an install inside a download: no retry, and what came is
    /// kept for the next install to resume.
    #[tokio::test]
    async fn a_cancelled_install_stops_mid_download_and_keeps_what_came() {
        let body: Vec<u8> = (0..3_000_000u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        let big = pin(
            body.len() as u64,
            Box::leak(format!("{:x}", Sha256::digest(&body)).into_boxed_str()),
        );
        let hits = Arc::new(AtomicU64::new(0));
        let base = crate::tts::tests::serve({
            let hits = hits.clone();
            move |_| {
                hits.fetch_add(1, Ordering::SeqCst);
                crate::tts::tests::http("200 OK", "", &body)
            }
        });
        let small = pin(1, "0");
        let v = Variant {
            id: "v",
            repo: "v",
            revision: "rev",
            own: [("a", small), ("b", small), ("c", small)],
            memory: 0,
        };
        let (studio, _, _) = fake_studio("cancel", FAST, normal_pressure);
        studio.cancel_install();
        let shared = [("speech_tokenizer/model.safetensors", big)];
        let err = studio
            .0
            .fetch_model(&v, &shared, &format!("{base}/"))
            .await
            .unwrap_err();
        assert_eq!(err, STOPPED);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "not retried");
        let part = studio
            .0
            .dir
            .join("models/shared/speech_tokenizer/model.safetensors.part");
        assert!(std::fs::metadata(part).unwrap().len() >= 1_000_000);
    }

    /// Two variants from a loopback "model host": the shared files are fetched
    /// once and hard-linked into both, each variant's own files land in its
    /// own directory, and progress goes out as `studio-setup` "model".
    #[tokio::test]
    async fn shared_model_files_download_once_and_are_hard_linked() {
        use std::os::unix::fs::MetadataExt;
        let body = |path: &str| format!("bytes of {path}").into_bytes();
        let check = |path: &str| {
            let b = body(path);
            pin(
                b.len() as u64,
                Box::leak(format!("{:x}", Sha256::digest(&b)).into_boxed_str()),
            )
        };
        let hits = Arc::new(StdMutex::new(Vec::<String>::new()));
        let base = crate::tts::tests::serve({
            let hits = hits.clone();
            move |head| {
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                hits.lock().unwrap().push(path.clone());
                let file = path.splitn(5, '/').nth(4).unwrap_or("").to_string();
                crate::tts::tests::http("200 OK", "", &body(&file))
            }
        });
        let shared = [
            ("vocab.json", check("vocab.json")),
            (
                "speech_tokenizer/model.safetensors",
                check("speech_tokenizer/model.safetensors"),
            ),
        ];
        let variant = |id: &'static str| Variant {
            id,
            repo: id,
            revision: "rev",
            own: [
                ("config.json", check("config.json")),
                ("model.safetensors", check("model.safetensors")),
                (
                    "model.safetensors.index.json",
                    check("model.safetensors.index.json"),
                ),
            ],
            memory: 0,
        };
        let (studio, _, seen) = fake_studio("fetch", FAST, normal_pressure);
        let (a, b) = (variant("a"), variant("b"));
        studio
            .0
            .fetch_model(&a, &shared, &format!("{base}/"))
            .await
            .unwrap();
        studio
            .0
            .fetch_model(&b, &shared, &format!("{base}/"))
            .await
            .unwrap();

        let hits = hits.lock().unwrap().clone();
        assert_eq!(
            hits.iter()
                .filter(|h| h.ends_with("/speech_tokenizer/model.safetensors"))
                .count(),
            1
        );
        assert!(hits.contains(&"/a/resolve/rev/config.json".to_string()));
        assert!(hits.contains(&"/b/resolve/rev/model.safetensors".to_string()));
        assert_eq!(hits.len(), 2 + 3 + 3);
        let models = studio.0.dir.join("models");
        let shared_ino =
            std::fs::metadata(models.join("shared/speech_tokenizer/model.safetensors"))
                .unwrap()
                .ino();
        for id in ["a", "b"] {
            let linked = models.join(id).join("speech_tokenizer/model.safetensors");
            assert_eq!(
                std::fs::metadata(&linked).unwrap().ino(),
                shared_ino,
                "{id}: one copy on disk"
            );
            assert_eq!(
                std::fs::read(models.join(id).join("config.json")).unwrap(),
                body("config.json")
            );
        }
        let progress: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "studio-setup")
            .map(|(_, p)| p.clone())
            .collect();
        assert!(progress.iter().all(|p| p["phase"] == "model"));
        assert!(
            progress.iter().any(|p| p["received"] == p["total"]),
            "{progress:?}"
        );
    }

    // --- Opt-in: the real sidecar and model -------------------------------
    //
    // REDLINE_STUDIO_VENV names a venv with the locked packages, and
    // REDLINE_STUDIO_MODELS a models root holding 1.7B-CustomVoice-8bit; the
    // runtime and resume tests need the network. Run with
    // `cargo test --lib tts_studio -- --ignored --nocapture --test-threads=1`.

    fn from_env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("set {name} to run this test"))
    }

    fn scratch_install(label: &str) -> Studio {
        let venv = from_env("REDLINE_STUDIO_VENV");
        let models = from_env("REDLINE_STUDIO_MODELS");
        let data = std::env::temp_dir().join(format!(
            "redline-studio-real-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&data);
        let dir = data.join("voice-studio");
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::os::unix::fs::symlink(venv, dir.join("venv")).unwrap();
        let id = VARIANTS[0].id;
        std::os::unix::fs::symlink(Path::new(&models).join(id), dir.join("models").join(id))
            .unwrap();
        std::fs::write(
            dir.join("install.json"),
            json!({"lock": lock_hash(), "models": {id: {}}}).to_string(),
        )
        .unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        Studio::with(&data, reqwest::Client::new(), db, TIMING, memory_pressure)
    }

    fn audio_ms(frames: &[Vec<u8>]) -> f64 {
        let samples: usize = frames
            .iter()
            .filter(|f| flags(f) == 0)
            .map(|f| (f.len() - 12) / 2)
            .sum();
        samples as f64 / 24.0
    }

    /// Like `until`, for a real model on a machine other work may be loading.
    async fn patiently(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..60_000 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn final_of(frames: &Frames) -> Option<Vec<u8>> {
        frames
            .lock()
            .unwrap()
            .last()
            .filter(|f| flags(f) & FINAL != 0)
            .cloned()
    }

    #[tokio::test]
    #[ignore = "needs REDLINE_STUDIO_VENV and REDLINE_STUDIO_MODELS"]
    async fn real_sidecar_first_audio_speed_and_cancel() {
        let studio = scratch_install("sidecar");
        let started = Instant::now();
        studio.warm(true).unwrap();
        patiently("the warm-up", || studio.0.lock().queue.is_empty()).await;
        assert_eq!(studio.status()["state"], "ready");
        println!("spawn to warm: {:?}", started.elapsed());

        let text = "The plan has three parts, and the first one is ready for review. \
                    Tell me when you want to hear the rest.";
        for run in 1..=3 {
            let started = Instant::now();
            let frames = say(&studio, text, run);
            patiently("first audio", || !frames.lock().unwrap().is_empty()).await;
            let first = started.elapsed();
            patiently("the end", || final_of(&frames).is_some()).await;
            let total = started.elapsed();
            let all = frames.lock().unwrap().clone();
            let end = outcome(all.last().unwrap());
            assert_eq!(end["type"], "end", "{end}");
            let played = audio_ms(&all);
            println!(
                "run {run}: first audio {:.0} ms, {} chunks, {:.0} ms of audio in {:.0} ms \
                 (ratio {:.3}; sidecar first_audio_ms {}, rtf {})",
                first.as_secs_f64() * 1e3,
                all.len() - 1,
                played,
                total.as_secs_f64() * 1e3,
                total.as_secs_f64() * 1e3 / played,
                end["stats"]["first_audio_ms"],
                end["stats"]["rtf"],
            );
        }

        let long =
            "Here is a much longer passage, so that there is plenty left to cut off. ".repeat(6);
        for run in 1..=3 {
            let frames = say(&studio, &long, 10 + run);
            patiently("first audio", || !frames.lock().unwrap().is_empty()).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let cancelled = Instant::now();
            studio.cancel(10 + run);
            assert_eq!(
                flags(frames.lock().unwrap().last().unwrap()),
                FINAL | CANCELLED
            );
            patiently("the sidecar to let go", || studio.0.lock().queue.is_empty()).await;
            let released = cancelled.elapsed();
            let next = Instant::now();
            let after = say(&studio, "Okay, moving on.", 20 + run);
            patiently("first audio after the cancel", || {
                !after.lock().unwrap().is_empty()
            })
            .await;
            println!(
                "cancel {run}: final frame at once, sidecar let go in {:.1} ms, next first audio {:.0} ms",
                released.as_secs_f64() * 1e3,
                next.elapsed().as_secs_f64() * 1e3
            );
            patiently("the end", || final_of(&after).is_some()).await;
        }
        studio.kill();
    }

    /// The runtime from nothing, for real: the pinned uv, uv's CPython and the
    /// hash-pinned lock, all inside a scratch `voice-studio/`, with nothing
    /// written to `~/.local`. The venv then imports what the sidecar loads.
    #[tokio::test]
    #[ignore = "needs the network (~150 MB)"]
    async fn real_runtime_installs_from_the_lock_inside_its_directory() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let watched = [
            home.join(".local/bin"),
            home.join(".local/share/uv"),
            home.join(".local/share/uv/python"),
        ];
        let snapshot = || {
            watched
                .iter()
                .map(|d| {
                    let mut entries: Vec<(OsString, Option<std::time::SystemTime>)> =
                        std::fs::read_dir(d)
                            .map(|it| {
                                it.flatten()
                                    .map(|e| {
                                        (
                                            e.file_name(),
                                            e.metadata().and_then(|m| m.modified()).ok(),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                    entries.sort();
                    entries
                })
                .collect::<Vec<_>>()
        };
        let before = snapshot();
        let data = std::env::temp_dir().join(format!(
            "redline-studio-real-runtime-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&data);
        let db = Arc::new(Database::open_in_memory().unwrap());
        let studio = Studio::with(&data, reqwest::Client::new(), db, TIMING, memory_pressure);
        let dir = studio.0.dir.clone();
        std::fs::create_dir_all(&dir).unwrap();
        let started = Instant::now();
        studio.0.install_runtime().await.unwrap();
        println!("\nruntime built in {:?}", started.elapsed());
        let probe = std::process::Command::new(dir.join("venv/bin/python3"))
            .args(["-I", "-c", "import mlx.core, mlx_audio.tts.utils, scipy, transformers, sys; print(sys.version.split()[0], mlx.core.__version__)"])
            .output()
            .unwrap();
        assert!(
            probe.status.success(),
            "{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        println!(
            "python, mlx: {}",
            String::from_utf8_lossy(&probe.stdout).trim()
        );
        let cfg = std::fs::read_to_string(dir.join("venv/pyvenv.cfg")).unwrap();
        assert!(
            cfg.contains(&*dir.join("python").to_string_lossy()),
            "{cfg}"
        );
        assert!(!dir.join("uv-cache").exists());
        assert_eq!(snapshot(), before, "nothing changed under ~/.local");
        let _ = std::fs::remove_dir_all(&data);
    }

    /// A real resume through the model host's signed redirect: the first
    /// 681 MB of the shared speech tokenizer are taken from a local copy,
    /// and only the last megabyte crosses the network.
    #[tokio::test]
    #[ignore = "needs the network and REDLINE_STUDIO_MODELS"]
    async fn real_range_resume_through_the_signed_redirect() {
        let models = from_env("REDLINE_STUDIO_MODELS");
        let (path, check) = SHARED[8];
        let local = std::fs::read(Path::new(&models).join(VARIANTS[0].id).join(path)).unwrap();
        let data =
            std::env::temp_dir().join(format!("redline-studio-real-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(&data).unwrap();
        let dest = data.join("model.safetensors");
        let keep = local.len() - 1_000_000;
        std::fs::write(data.join("model.safetensors.part"), &local[..keep]).unwrap();
        drop(local);
        let v = &VARIANTS[0];
        let url = format!("{HF}{}/resolve/{}/{path}", v.repo, v.revision);
        let resumed_from = Arc::new(AtomicU64::new(u64::MAX));
        let started = Instant::now();
        let from = resumed_from.clone();
        let note = move |r, _| {
            from.fetch_min(r, Ordering::SeqCst);
            true
        };
        fetch_checked(
            &reqwest::Client::new(),
            &url,
            &dest,
            "the tokenizer",
            check,
            DOWNLOAD_STALL,
            &note,
        )
        .await
        .unwrap();
        println!(
            "\nresumed the last {} bytes in {:?}",
            check.bytes - keep as u64,
            started.elapsed()
        );
        assert_eq!(
            resumed_from.load(Ordering::SeqCst),
            keep as u64,
            "a 206 from where the file stopped"
        );
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), check.bytes);
        let _ = std::fs::remove_dir_all(&data);
    }
}

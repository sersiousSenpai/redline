// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The optional end-of-turn model: has the speaker finished? Hands-free voice
//! (`src/audio/endpoint.ts`) asks it during a pause that sounds finished:
//! a sure yes ends the turn early, and a no holds a pause open that the
//! silence rule alone would have cut off mid-thought.
//!
//! The model is Smart Turn v3.1 (BSD-2-Clause, Daily): a Whisper-tiny encoder
//! with a linear head, 8.7 MB of int8 ONNX, reading the last 8 s of the
//! capture's audio. It runs in a Python process of its own on a local voice's
//! runtime — Kokoro's, else the studio voice's — each of which has numpy and
//! onnxruntime, so a question never waits behind a sentence being
//! synthesized, and the binary carries only this glue and the small script.
//! The script computes the model's input — Whisper's 80-bin log-mel over an
//! 8 s window, zero-padded at the start and normalized — in numpy, matching
//! the reference code's transformers feature extractor to 1e-5, so
//! transformers isn't needed.
//!
//! On the dictation test set a question takes 14.5 ms here, p95 (20–32 ms
//! with Kokoro synthesizing beside it), and as the endpointer uses it, it
//! took the turns ended early by a one-second pause mid-thought from 67% to
//! 16%.
//!
//! It is downloaded on demand, pinned by revision, size and SHA-256
//! (`pinned_fetch`). With neither runtime, no model, or a process that
//! doesn't answer in time, there is no score, and the endpointer keeps its
//! silence rule. A question is never waited on: a scorer busy with another
//! (or starting) answers no score at once, and the question's write and its
//! answer share one deadline, so a process that stops reading is ended
//! rather than holding a thread. The process exits when its stdin closes,
//! with Redline.
//!
//! One command, `turn_scorer({ op })`, run on the blocking pool:
//! - `status`: whether the runtime and the model are there, and the process
//!   is up;
//! - `install`: download the model;
//! - `warm`: start the process, and have the mic keep each capture's last 8 s;
//! - `score`: the probability that the live capture's speaker has finished;
//! - `stop`: end the process and stop keeping audio.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::dictation::DictationState;
use crate::dictation_whisper;
use crate::pinned_fetch::{self, Pinned};
use crate::tts_studio::Studio;

const MODEL: Pinned = Pinned {
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.1-cpu.onnx",
    bytes: 8_679_180,
    sha256: "fb68d55c2d542ce79e44b12013bfd571e90df8594ab096d757198e851b0c6594",
};
const MODEL_FILE: &str = "smart-turn-v3.1-cpu.onnx";
const SCRIPT: &str = include_str!("../resources/turn_scorer.py");

/// The audio the model reads: the capture's last 8 s.
const AUDIO_MS: f64 = 8_000.0;
/// Loading the model on spawn gets this long.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// A question written and answered slower than this is no use to a pause
/// being timed; the process is taken for wedged, ended, and restarted on the
/// next warm.
const ANSWER_TIMEOUT: Duration = Duration::from_millis(300);
/// A download that goes this long without a byte is given up.
const DOWNLOAD_STALL: Duration = Duration::from_secs(30);

/// The running model process: its stdin, its stdout, and what has been read
/// from that of a line not yet ended.
struct Scorer {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    pending: Vec<u8>,
    next: u32,
}

impl Scorer {
    /// Start `python -I -B <script> <model>` and wait for it to load.
    fn spawn(python: &Path, script: &Path, model: &Path) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg("-I")
            .arg("-B")
            .arg(script)
            .arg(model)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn't start the end-of-turn model: {e}"))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err("the end-of-turn model has no pipes".to_string());
        };
        // A question's write waits on `poll`, against its deadline (`send`).
        if !nonblocking(&stdin) {
            let _ = child.kill();
            return Err("the end-of-turn model's pipe can't be made non-blocking".to_string());
        }
        let mut scorer = Self {
            child,
            stdin,
            stdout,
            pending: Vec::new(),
            next: 0,
        };
        match scorer.line(Instant::now() + LOAD_TIMEOUT) {
            Ok(line) if line.trim() == "ready" => Ok(scorer),
            Ok(line) => Err(format!(
                "the end-of-turn model didn't load: {}",
                line.trim().trim_start_matches("error").trim()
            )),
            Err(true) => Err("the end-of-turn model's runtime couldn't load it".to_string()),
            Err(false) => Err("the end-of-turn model didn't load in time".to_string()),
        }
    }

    /// The next line from the model's stdout, waiting until `deadline`:
    /// `Err(true)` once it has closed, `Err(false)` at the deadline. Read on
    /// the asking thread, with `poll` for the deadline: no reader thread.
    fn line(&mut self, deadline: Instant) -> Result<String, bool> {
        loop {
            if let Some(end) = self.pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=end).collect();
                return Ok(String::from_utf8_lossy(&line[..end]).into_owned());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if !ready(&self.stdout, false, left)? {
                return Err(false);
            }
            let mut chunk = [0u8; 512];
            match self.stdout.read(&mut chunk) {
                Ok(0) | Err(_) => return Err(true),
                Ok(n) => self.pending.extend_from_slice(&chunk[..n]),
            }
        }
    }

    /// Write all of `bytes` by `deadline`: `false` once the process has
    /// stopped reading (the pipe stayed full) or has closed it. The pipe
    /// doesn't block (`spawn`), so a full one is waited on with `poll`.
    fn send(&mut self, mut bytes: &[u8], deadline: Instant) -> bool {
        while !bytes.is_empty() {
            match self.stdin.write(bytes) {
                Ok(0) => return false,
                Ok(n) => bytes = &bytes[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if ready(&self.stdin, true, left) != Ok(true) {
                        return false;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        true
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// The probability that the speaker of 16 kHz mono `pcm` has finished;
    /// `None` when the process can't say, or not in time.
    fn score(&mut self, pcm: &[i16]) -> Option<f32> {
        self.next = self.next.wrapping_add(1);
        let id = self.next;
        let mut request = format!("{id} {}\n", pcm.len()).into_bytes();
        request.reserve(pcm.len() * 2);
        for s in pcm {
            request.extend_from_slice(&s.to_le_bytes());
        }
        // One deadline for the question and its answer: 8 s of audio is
        // 256 KB, four times what the pipe holds, so a process that stops
        // reading would otherwise hold this thread for good.
        let deadline = Instant::now() + ANSWER_TIMEOUT;
        if !self.send(&request, deadline) {
            return None;
        }
        loop {
            let line = self.line(deadline).ok()?;
            // An answer to a question given up on, or a library's chatter.
            if let Some((rid, p)) = line.split_once(' ') {
                if rid.parse() == Ok(id) {
                    // In thousandths: a float parser costs the binary more.
                    return p
                        .trim()
                        .parse::<u16>()
                        .ok()
                        .map(|p| f32::from(p.min(1000)) / 1000.0);
                }
            }
        }
    }
}

impl Drop for Scorer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether `pipe` is ready within `wait` — to `write` into (there is room,
/// or it has closed), else to read from (there is something, or it has
/// closed); `Err(true)` when it can't be waited on.
#[cfg(unix)]
fn ready(pipe: &impl std::os::fd::AsRawFd, write: bool, wait: Duration) -> Result<bool, bool> {
    let ms = wait.as_millis().min(i32::MAX as u128) as i32;
    loop {
        let mut fd = libc::pollfd {
            fd: pipe.as_raw_fd(),
            events: if write { libc::POLLOUT } else { libc::POLLIN },
            revents: 0,
        };
        // SAFETY: one pollfd for a descriptor `pipe` keeps open for the call.
        match unsafe { libc::poll(&mut fd, 1, ms) } {
            0 => return Ok(false),
            n if n > 0 => return Ok(true),
            _ if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted => {}
            _ => return Err(true),
        }
    }
}

#[cfg(not(unix))]
fn ready<T>(_pipe: &T, _write: bool, _wait: Duration) -> Result<bool, bool> {
    Err(true)
}

/// Make writes to `stdin` return at once when the pipe is full.
#[cfg(unix)]
fn nonblocking(stdin: &ChildStdin) -> bool {
    use std::os::fd::AsRawFd;
    let fd = stdin.as_raw_fd();
    // SAFETY: fcntl on a descriptor `stdin` keeps open for the calls.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        flags >= 0 && libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
    }
}

#[cfg(not(unix))]
fn nonblocking(_stdin: &ChildStdin) -> bool {
    false
}

/// The capture's kept audio as the model reads it: 16 kHz mono 16-bit.
fn pcm_16k(tail: Option<(Vec<f32>, f64)>) -> Option<Vec<i16>> {
    let (audio, rate) = tail.filter(|(a, _)| !a.is_empty())?;
    let mono = dictation_whisper::resample_to_16k(&audio, rate.round() as u32).ok()?;
    Some(
        mono.iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect(),
    )
}

/// What `turn_scorer` reports, whatever the op.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnScorerReply {
    /// A runtime it runs on is installed (Kokoro's, or the studio voice's):
    /// the model can run.
    runtime: bool,
    /// The model is downloaded.
    model: bool,
    /// The process is up.
    warm: bool,
    /// `score`'s answer: how likely it is the speaker has finished.
    score: Option<f32>,
}

pub struct TurnScorerState {
    dir: PathBuf,
    /// Kokoro's interpreter: the model's first choice.
    kokoro: PathBuf,
    /// The studio voice, whose runtime is the second.
    studio: Studio,
    http: reqwest::Client,
    proc: Mutex<Option<Scorer>>,
    /// One download at a time: two clicks must not write the same `.part`.
    download: Mutex<()>,
}

impl TurnScorerState {
    /// The model lives in `<app data>/turn`, and runs on `kokoro` (the Kokoro
    /// runtime's interpreter), else on `studio`'s runtime.
    pub fn new(data_dir: &Path, kokoro: PathBuf, studio: Studio) -> Self {
        Self {
            dir: data_dir.join("turn"),
            kokoro,
            studio,
            http: reqwest::Client::new(),
            proc: Mutex::new(None),
            download: Mutex::new(()),
        }
    }

    fn model_path(&self) -> PathBuf {
        self.dir.join(MODEL_FILE)
    }

    /// The interpreter the model runs on, chosen as it starts: Kokoro's when
    /// that voice is installed, else the studio voice's runtime once it is
    /// built from this binary's lock (an older one has no onnxruntime).
    fn python(&self) -> Option<PathBuf> {
        if self.kokoro.exists() {
            return Some(self.kokoro.clone());
        }
        self.studio.python()
    }

    fn status(&self, score: Option<f32>) -> TurnScorerReply {
        TurnScorerReply {
            runtime: self.python().is_some(),
            model: self.model_path().exists(),
            // Busy, answering or starting: it is taken as up, never waited on.
            warm: self
                .proc
                .try_lock()
                .map_or(true, |mut p| p.as_mut().is_some_and(Scorer::alive)),
            score,
        }
    }

    async fn install(&self, pin: &Pinned<'_>) -> Result<(), String> {
        let _one_at_a_time = self.download.lock().unwrap();
        let dest = self.model_path();
        if dest.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("couldn't create {}: {e}", self.dir.display()))?;
        pinned_fetch::fetch_pinned(
            &self.http,
            pin,
            &dest,
            "the end-of-turn model",
            DOWNLOAD_STALL,
            &|_, _| true,
        )
        .await
    }

    /// Start the model's process, unless it is running.
    fn warm(&self) -> Result<(), String> {
        let mut proc = self.proc.lock().unwrap();
        if proc.as_mut().is_some_and(Scorer::alive) {
            return Ok(());
        }
        *proc = None;
        let Some(python) = self.python() else {
            return Err(
                "the end-of-turn model needs the Kokoro voice or the studio voice installed"
                    .to_string(),
            );
        };
        let model = self.model_path();
        if !model.exists() {
            return Err("the end-of-turn model isn't downloaded".to_string());
        }
        let script = self.dir.join("turn_scorer.py");
        if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
            std::fs::write(&script, SCRIPT)
                .map_err(|e| format!("couldn't write the end-of-turn model's script: {e}"))?;
        }
        *proc = Some(Scorer::spawn(&python, &script, &model)?);
        Ok(())
    }

    /// Ask about `pcm`. A scorer busy with another question, or starting, is
    /// no score at once: the pause being timed can't wait for it. A process
    /// that didn't take the question or answer it in time is ended, for the
    /// next warm to restart.
    fn score(&self, pcm: Option<Vec<i16>>) -> Option<f32> {
        let pcm = pcm?;
        let Ok(mut proc) = self.proc.try_lock() else {
            return None;
        };
        let score = proc.as_mut()?.score(&pcm);
        if score.is_none() {
            *proc = None;
        }
        score
    }

    fn stop(&self) {
        self.proc.lock().unwrap().take();
    }
}

/// The end-of-turn model: `status`, `install`, `warm`, `score` or `stop`
/// (see the module docs). Runs on the blocking pool (`OFF_MAIN_COMMANDS`):
/// a download, a model load and a question all wait on another process.
#[tauri::command]
pub fn turn_scorer(
    scorer: tauri::State<'_, TurnScorerState>,
    dictation: tauri::State<'_, DictationState>,
    op: String,
) -> Result<TurnScorerReply, String> {
    let mut score = None;
    match op.as_str() {
        "status" => {}
        "install" => tauri::async_runtime::block_on(scorer.install(&MODEL))?,
        "warm" => {
            scorer.warm()?;
            dictation.keep_tail(Some(AUDIO_MS));
        }
        "score" => score = scorer.score(pcm_16k(dictation.tail())),
        "stop" => {
            dictation.keep_tail(None);
            scorer.stop();
        }
        _ => return Err(format!("unknown end-of-turn op '{op}'")),
    }
    Ok(scorer.status(score))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for the model's process, speaking its protocol from a shell
    /// script run in the interpreter's place: it reads each question's header
    /// line and samples, and answers by its `mode` file — 0.97 (the
    /// default), `stale` (an answer to the question before, then this one's),
    /// `nan` (it could not score), or `hang` (never). With `broken` beside it,
    /// it fails to load and says so; with `dead`, it exits without a word;
    /// with `slow`, it takes a second to load; with `deaf`, it loads and then
    /// never reads a question.
    const FAKE: &str = r#"#!/bin/sh
dir=$(dirname "$0")
if [ -e "$dir/dead" ]; then exit 1; fi
if [ -e "$dir/broken" ]; then echo "error bad model file"; exit 0; fi
if [ -e "$dir/slow" ]; then sleep 1; fi
echo ready
if [ -e "$dir/deaf" ]; then exec sleep 30; fi
while read -r id n; do
  dd bs=1 count=$((2 * n)) of=/dev/null 2>/dev/null
  echo "$id $n" >> "$dir/asked.log"
  case "$(cat "$dir/mode" 2>/dev/null)" in
    stale) echo "$((id - 1)) 100"; echo "$id 800" ;;
    nan) echo "$id -" ;;
    hang) ;;
    *) echo "$id 970" ;;
  esac
done
"#;

    /// The studio voice of the app data in `data`, as it is on disk.
    fn studio_of(data: &Path) -> Studio {
        let db = std::sync::Arc::new(crate::db::Database::open_in_memory().unwrap());
        Studio::new(data, reqwest::Client::new(), db)
    }

    /// Put the fake in an interpreter's place at `python`.
    #[cfg(unix)]
    fn place_fake(python: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(python, FAKE).unwrap();
        std::fs::set_permissions(python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A scorer whose interpreter is the fake, with its model in place.
    #[cfg(unix)]
    fn fake(label: &str) -> (TurnScorerState, PathBuf) {
        let data =
            std::env::temp_dir().join(format!("redline-turn-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("turn")).unwrap();
        let python = data.join("fake-python");
        place_fake(&python);
        std::fs::write(data.join("turn").join(MODEL_FILE), b"").unwrap();
        (TurnScorerState::new(&data, python, studio_of(&data)), data)
    }

    #[cfg(unix)]
    #[test]
    fn a_question_is_its_samples_and_the_answer_its_probability() {
        let (state, data) = fake("asks");
        assert_eq!(
            state.status(None),
            TurnScorerReply {
                runtime: true,
                model: true,
                warm: false,
                score: None
            }
        );
        state.warm().unwrap();
        assert!(state.status(None).warm);
        assert_eq!(state.score(Some(vec![0; 1600])), Some(0.97));
        assert_eq!(state.score(Some(vec![0; 800])), Some(0.97));
        let asked = std::fs::read_to_string(data.join("asked.log")).unwrap();
        assert_eq!(asked, "1 1600\n2 800\n");
        // Warm again: the same process.
        state.warm().unwrap();
        assert_eq!(state.score(Some(vec![0; 10])), Some(0.97));
        assert!(std::fs::read_to_string(data.join("asked.log"))
            .unwrap()
            .ends_with("3 10\n"));
        // Nothing kept to ask about: no question at all.
        assert_eq!(state.score(None), None);
        state.stop();
        assert!(!state.status(None).warm);
        assert_eq!(state.score(Some(vec![0; 10])), None, "stopped");
    }

    #[cfg(unix)]
    #[test]
    fn an_answer_to_an_earlier_question_is_passed_over() {
        let (state, data) = fake("stale");
        std::fs::write(data.join("mode"), "stale").unwrap();
        state.warm().unwrap();
        assert_eq!(state.score(Some(vec![0; 100])), Some(0.80));
    }

    #[cfg(unix)]
    #[test]
    fn no_answer_in_time_is_no_score_and_ends_the_process() {
        let (state, data) = fake("hang");
        std::fs::write(data.join("mode"), "hang").unwrap();
        state.warm().unwrap();
        let asked = Instant::now();
        assert_eq!(state.score(Some(vec![0; 100])), None);
        assert!(asked.elapsed() < ANSWER_TIMEOUT * 3);
        assert!(!state.status(None).warm, "taken for wedged");
        // The next warm starts a fresh one.
        std::fs::write(data.join("mode"), "").unwrap();
        state.warm().unwrap();
        assert_eq!(state.score(Some(vec![0; 100])), Some(0.97));
    }

    /// The bug this guards against: 8 s of audio is 256 KB, four times what
    /// the pipe holds, so a process that stopped reading held the asking
    /// thread in its write for good, and every later question queued behind
    /// it on the lock.
    #[cfg(unix)]
    #[test]
    fn a_process_that_stops_reading_costs_a_question_its_deadline_not_a_thread() {
        let (state, data) = fake("deaf");
        std::fs::write(data.join("deaf"), "").unwrap();
        state.warm().unwrap();
        let asked = Instant::now();
        assert_eq!(state.score(Some(vec![0; 128_000])), None);
        assert!(asked.elapsed() < ANSWER_TIMEOUT * 3, "{:?}", asked.elapsed());
        assert!(!state.status(None).warm, "ended, not left holding a write");
        std::fs::remove_file(data.join("deaf")).unwrap();
        state.warm().unwrap();
        assert_eq!(state.score(Some(vec![0; 128_000])), Some(0.97));
    }

    #[cfg(unix)]
    #[test]
    fn a_busy_scorer_is_no_score_at_once() {
        let (state, data) = fake("busy");
        std::fs::write(data.join("slow"), "").unwrap();
        let state = std::sync::Arc::new(state);
        let starting = {
            let state = state.clone();
            std::thread::spawn(move || state.warm())
        };
        // The start holds the process's lock while the model loads.
        while state.proc.try_lock().is_ok() {
            std::thread::yield_now();
        }
        let asked = Instant::now();
        assert_eq!(state.score(Some(vec![0; 100])), None);
        assert!(asked.elapsed() < Duration::from_millis(50), "{:?}", asked.elapsed());
        assert!(state.status(None).runtime, "nor does the status wait on it");
        starting.join().unwrap().unwrap();
        assert_eq!(state.score(Some(vec![0; 100])), Some(0.97));
    }

    #[cfg(unix)]
    #[test]
    fn it_runs_on_kokoro_s_runtime_else_the_studio_voice_s() {
        let data =
            std::env::temp_dir().join(format!("redline-turn-runtimes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("turn")).unwrap();
        std::fs::write(data.join("turn").join(MODEL_FILE), b"").unwrap();
        let kokoro = data.join("kokoro/venv/bin/python3");
        let studio = data.join("voice-studio/venv/bin/python3");
        // Each state reads the studio voice's install as it is now.
        let state = || TurnScorerState::new(&data, kokoro.clone(), studio_of(&data));
        assert_eq!(state().python(), None, "neither is installed");
        assert!(!state().status(None).runtime);

        // A studio runtime built from an older lock has no onnxruntime.
        place_fake(&studio);
        let record = data.join("voice-studio/install.json");
        std::fs::write(&record, r#"{"lock": "older", "models": {}}"#).unwrap();
        assert_eq!(state().python(), None);
        let current = serde_json::json!({"lock": crate::tts_studio::lock_hash(), "models": {}});
        std::fs::write(&record, current.to_string()).unwrap();
        let only_studio = state();
        assert_eq!(only_studio.python(), Some(studio.clone()));
        assert!(only_studio.status(None).runtime);
        only_studio.warm().unwrap();
        assert_eq!(only_studio.score(Some(vec![0; 100])), Some(0.97));

        // With Kokoro installed too, Kokoro's.
        place_fake(&kokoro);
        assert_eq!(state().python(), Some(kokoro));
    }

    #[cfg(unix)]
    #[test]
    fn a_score_it_could_not_compute_is_no_score() {
        let (state, data) = fake("nan");
        std::fs::write(data.join("mode"), "nan").unwrap();
        state.warm().unwrap();
        assert_eq!(state.score(Some(vec![0; 100])), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_model_that_fails_to_load_says_why_and_nothing_runs() {
        let (state, data) = fake("broken");
        std::fs::write(data.join("broken"), "").unwrap();
        let err = state.warm().unwrap_err();
        assert!(err.contains("bad model file"), "{err}");
        assert!(!state.status(None).warm);
        std::fs::write(data.join("dead"), "").unwrap();
        let err = state.warm().unwrap_err();
        assert!(err.contains("couldn't load"), "{err}");
    }

    #[test]
    fn without_the_runtime_or_the_model_it_is_unavailable() {
        let data = std::env::temp_dir().join(format!("redline-turn-none-{}", std::process::id()));
        let state = TurnScorerState::new(&data, data.join("no-python"), studio_of(&data));
        assert_eq!(
            state.status(None),
            TurnScorerReply {
                runtime: false,
                model: false,
                warm: false,
                score: None
            }
        );
        assert!(state.warm().unwrap_err().contains("Kokoro"));
    }

    #[test]
    fn the_kept_audio_is_sent_at_16_khz_in_16_bits() {
        assert_eq!(pcm_16k(None), None);
        assert_eq!(
            pcm_16k(Some((Vec::new(), 48_000.0))),
            None,
            "nothing kept yet"
        );
        let pcm = pcm_16k(Some((vec![0.5; 4_800], 16_000.0))).unwrap();
        assert_eq!((pcm.len(), pcm[0]), (4_800, 16_383));
        let clipped = pcm_16k(Some((vec![2.0; 10], 16_000.0))).unwrap();
        assert_eq!(clipped[0], 32_767);
        // A 48 kHz mic: a third as many samples.
        let third = pcm_16k(Some((vec![0.0; 48_000], 48_000.0))).unwrap().len();
        assert!(third.abs_diff(16_000) <= 2, "{third}");
    }

    #[test]
    fn the_install_keeps_only_the_pinned_file() {
        use sha2::{Digest, Sha256};
        let served: &'static [u8] = b"model bytes";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in listener.incoming().take(2) {
                let Ok(mut s) = s else { continue };
                let mut req = [0u8; 2048];
                let _ = s.read(&mut req);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    served.len()
                );
                let _ = s.write_all(served);
            }
        });
        let url: &'static str = Box::leak(format!("http://{addr}/{MODEL_FILE}").into_boxed_str());
        let sha: &'static str = Box::leak(format!("{:x}", Sha256::digest(served)).into_boxed_str());
        let data =
            std::env::temp_dir().join(format!("redline-turn-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let state = TurnScorerState::new(&data, data.join("no-python"), studio_of(&data));
        let wrong = Pinned {
            url,
            bytes: served.len() as u64,
            sha256: "00",
        };
        assert!(tauri::async_runtime::block_on(state.install(&wrong)).is_err());
        assert!(
            !state.status(None).model,
            "a file that isn't the pinned one is refused"
        );
        let pin = Pinned {
            url,
            bytes: served.len() as u64,
            sha256: sha,
        };
        tauri::async_runtime::block_on(state.install(&pin)).unwrap();
        assert!(state.status(None).model);
        assert_eq!(std::fs::read(state.model_path()).unwrap(), served);
    }

    #[test]
    fn it_runs_off_the_main_thread_as_a_plain_command() {
        let pool = crate::codehealth::command_list(include_str!("lib.rs"), "OFF_MAIN_COMMANDS");
        assert!(
            pool.iter().any(|n| n == "turn_scorer"),
            "lib.rs: `turn_scorer` must be in OFF_MAIN_COMMANDS"
        );
        assert!(include_str!("turn_scorer.rs").contains("#[tauri::command]\npub fn turn_scorer("));
    }

    /// The real model on the real runtime, on the dictation test set: run with
    /// `REDLINE_TURN_PYTHON=<a Kokoro or studio venv's python3> REDLINE_TURN_MODEL=<model.onnx>
    /// REDLINE_TURN_CLIPS=<dir of *-fin.wav and *-unf.wav> cargo test --lib
    /// turn_scorer -- --ignored --nocapture`. Prints the round trip's p50/p95.
    #[test]
    #[ignore]
    fn the_real_model_tells_a_finished_phrase_from_a_cut_one() {
        let python = PathBuf::from(std::env::var("REDLINE_TURN_PYTHON").unwrap());
        let model = PathBuf::from(std::env::var("REDLINE_TURN_MODEL").unwrap());
        let clips = PathBuf::from(std::env::var("REDLINE_TURN_CLIPS").unwrap());
        let data = std::env::temp_dir().join(format!("redline-turn-real-{}", std::process::id()));
        std::fs::create_dir_all(data.join("turn")).unwrap();
        std::fs::copy(&model, data.join("turn").join(MODEL_FILE)).unwrap();
        let state = TurnScorerState::new(&data, python, studio_of(&data));
        let loaded = Instant::now();
        state.warm().unwrap();
        println!("load {} ms", loaded.elapsed().as_millis());
        let mut times = Vec::new();
        let (mut fin, mut unf) = (Vec::new(), Vec::new());
        let mut paths: Vec<_> = std::fs::read_dir(&clips)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        paths.sort();
        for path in paths
            .iter()
            .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        {
            let audio = dictation_whisper::read_wav_16k(path.to_str().unwrap());
            // Up to 250 ms into the pause after the speech: the endpointer's first question.
            let speech = audio
                .iter()
                .rposition(|s| s.abs() > 0.02)
                .unwrap_or(audio.len());
            let upto = (speech + 4_000).min(audio.len());
            let pcm = pcm_16k(Some((audio[..upto].to_vec(), 16_000.0))).unwrap();
            let asked = Instant::now();
            let p = state.score(Some(pcm)).expect("an answer");
            times.push(asked.elapsed().as_secs_f64() * 1000.0);
            let name = path.file_name().unwrap().to_string_lossy();
            if name.ends_with("-fin.wav") {
                fin.push(p)
            } else {
                unf.push(p)
            }
        }
        times.sort_by(f64::total_cmp);
        let pct = |q: f64| times[((times.len() as f64 * q) as usize).min(times.len() - 1)];
        let done = |ps: &[f32]| ps.iter().filter(|&&p| p >= 0.5).count() as f64 / ps.len() as f64;
        println!(
            "{} questions: round trip p50 {:.1} ms, p95 {:.1} ms; finished judged finished {:.0}%, cut judged finished {:.0}%",
            times.len(),
            pct(0.5),
            pct(0.95),
            100.0 * done(&fin),
            100.0 * done(&unf)
        );
        assert!(pct(0.95) < 50.0);
        assert!(done(&fin) > done(&unf));
    }
}

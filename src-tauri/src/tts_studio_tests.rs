// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `tts_studio.rs`'s `mod tests`, moved out verbatim: a `#[path]` child of the
//! same parent, so `use super::*` still resolves as it did inline.

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
/// loads for n ms. Polishes (and the polish slot's warm-ups) run on a
/// queue and thread of their own, as in the sidecar, and only in a
/// process started with `--polish-model`: the reply drops "um" and "uh"
/// and ends with a full stop, unless the text says "WAIT<n>" (it comes
/// after n ms), "STALL" (nothing until it is cancelled) or "FAIL" (an
/// error).
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
polishes, pcv = collections.deque(), threading.Condition()
def polish_work():
    while True:
        with pcv:
            while not polishes:
                pcv.wait()
            req = polishes.popleft()
        rid, text = req.get("id"), req.get("text", "")
        if req.get("op") == "warmup":
            emit({"type": "state", "slot": "polish", "state": "loading"})
            time.sleep(0.05)
            emit({"type": "state", "slot": "polish", "state": "ready"})
            emit({"type": "warm", "id": rid, "final": True, "slot": "polish"})
            continue
        if req.get("op") == "unload":
            emit({"type": "state", "slot": "polish", "state": "unloaded", "reason": "request"})
            emit({"type": "unloaded", "id": rid, "final": True, "slot": "polish"})
            continue
        wait = re.search(r"WAIT(\d+)", text)
        time.sleep(int(wait.group(1)) / 1000 if wait else 0.01)
        while "STALL" in text and rid not in cancelled:
            time.sleep(0.01)
        if rid in cancelled:
            emit({"type": "cancelled", "id": rid, "final": True})
        elif "FAIL" in text:
            emit({"type": "error", "id": rid, "code": "polish_failed", "message": "it broke", "final": True})
        else:
            said = " ".join(w for w in text.split() if w not in ("um", "uh"))
            out = said[:1].upper() + said[1:] + "."
            emit({"type": "polished", "id": rid, "final": True, "text": out, "changed": True,
                  "guard": None, "stats": {}})
threading.Thread(target=work, daemon=True).start()
threading.Thread(target=polish_work, daemon=True).start()
emit({"type": "hello", "protocol": 1, "pid": os.getpid()})
for line in sys.stdin:
    append("requests.log", line.strip())
    req = json.loads(line)
    if req.get("op") == "cancel":
        cancelled.add(req.get("target"))
        continue
    if req.get("op") == "polish" or req.get("slot") == "polish":
        if "--polish-model" not in sys.argv:
            emit({"type": "error", "id": req.get("id"), "code": "polish_unavailable", "final": True})
            continue
        with pcv:
            polishes.append(req)
            pcv.notify()
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
    polish: Duration::from_millis(150),
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
    studio.0.lock().installing = Some(VARIANTS[0].id);
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

/// Remove deletes in the background; Install pressed right after waits for
/// that, or the deletion would take the new install's files with it.
#[tokio::test]
async fn an_install_right_after_a_removal_waits_for_it() {
    use std::os::unix::fs::PermissionsExt;
    let (studio, _, seen) = fake_studio("reinstall", FAST, normal_pressure);
    let data = studio.0.data_dir.clone();
    let old = studio.0.dir.join("venv/lib/site");
    std::fs::create_dir_all(&old).unwrap();
    for i in 0..3000 {
        std::fs::write(old.join(format!("m{i}.py")), b"x").unwrap();
    }
    // The install goes no further than a uv that fails at once (lent from
    // Kokoro's directory, which a removal leaves alone): no network.
    let uv = data.join("kokoro/bin/uv");
    std::fs::create_dir_all(uv.parent().unwrap()).unwrap();
    std::fs::write(&uv, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
    let at_start = Arc::new(StdMutex::new(None));
    let (seen_at_start, venv) = (at_start.clone(), studio.0.dir.join("venv"));
    let earlier = seen.clone();
    studio.on_event(move |event, payload| {
        if payload["phase"] == "preflight" {
            seen_at_start.lock().unwrap().get_or_insert(venv.exists());
        }
        earlier.lock().unwrap().push((event.to_string(), payload));
    });
    studio.remove(false).unwrap();
    studio.install(false);
    until("the install to end", || {
        seen.lock()
            .unwrap()
            .iter()
            .any(|(e, p)| e == "studio-setup" && p["phase"] == "error")
    })
    .await;
    assert_eq!(
        *at_start.lock().unwrap(),
        Some(false),
        "the install began only once the old files were gone"
    );
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
        let files: Vec<&(&str, FileCheck)> = SHARED.iter().chain(v.own).collect();
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
            .chain(v.own)
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
    assert_eq!(pins.len(), 37);
    for pin in &pins {
        let (name, rest) = pin.split_once("==").unwrap();
        assert!(
            !name.is_empty() && rest.contains(" --hash=sha256:"),
            "{pin}"
        );
    }
    assert!(pins.iter().any(|p| p.starts_with("mlx-audio==0.5.8 ")));
    // The polish model's runtime: the mlx-lm it was measured on.
    assert!(pins.iter().any(|p| p.starts_with("mlx-lm==0.32.0 ")));
    // The end-of-turn model's, where Kokoro isn't installed: the
    // onnxruntime it was measured on.
    assert!(pins.iter().any(|p| p.starts_with("onnxruntime==1.27.0 ")));
    assert!(inflate(SIDECAR_Z).contains(r#""ops": ["speak", "polish","#));
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
        own: Vec::leak(vec![("a", small), ("b", small), ("c", small)]),
        memory: 0,
        disk: 0,
        ram: 0,
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
        own: Vec::leak(vec![
            ("config.json", check("config.json")),
            ("model.safetensors", check("model.safetensors")),
            (
                "model.safetensors.index.json",
                check("model.safetensors.index.json"),
            ),
        ]),
        memory: 0,
        disk: 0,
        ram: 0,
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

// --- Dictation polish ---------------------------------------------------

/// Mark the polish model installed beside the voice.
fn install_polish(studio: &Studio) {
    studio
        .0
        .record(&|r| r["models"][POLISH.id] = json!({}))
        .unwrap();
}

/// Polish `text` as `generation`, returning where its reply lands.
fn polish_with(studio: &Studio, text: &str, vocab: &Value, generation: u64) -> Frames {
    let (channel, frames) = recorder();
    studio.polish(text, vocab, generation, channel).unwrap();
    frames
}

fn polish(studio: &Studio, text: &str, generation: u64) -> Frames {
    polish_with(studio, text, &json!(["QueueTray"]), generation)
}

/// Every line Redline wrote to the sidecar.
fn sent(dir: &Path) -> Vec<Value> {
    log_lines(dir, "requests.log")
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn polish_installed(studio: &Studio) -> bool {
    studio.0.polish_installed(&mut studio.0.lock())
}

fn polish_ready(studio: &Studio) -> bool {
    let core = studio.0.lock();
    core.polish_model == Model::Ready && core.polish.is_empty()
}

/// A polish goes to the sidecar's polish slot with its vocabulary, and
/// its one reply comes back as a single final frame under its generation.
#[tokio::test]
async fn a_polish_round_trips_as_one_frame() {
    let (studio, dir, _) = fake_studio("polish", FAST, normal_pressure);
    install_polish(&studio);
    let generation = (1u64 << 32) + 9;
    let frames = finished(&polish(&studio, "um so the QueueTray moves", generation)).await;
    assert_eq!(frames.len(), 1, "no audio, just the reply");
    let f = &frames[0];
    assert_eq!(f[..4], 9u32.to_le_bytes());
    assert_eq!(flags(f), FINAL);
    assert_eq!(outcome(f)["type"], "polished");
    assert_eq!(outcome(f)["text"], "So the QueueTray moves.");
    assert_eq!(
        sent(&dir),
        [
            json!({"id": 1, "op": "polish", "text": "um so the QueueTray moves", "vocab": ["QueueTray"]})
        ]
    );
    let spawn = &log_lines(&dir, "spawns.log")[0];
    assert!(
        spawn.contains("--polish-model polish/Qwen3.5-2B-4bit --polish-idle-unload-s 120"),
        "{spawn}"
    );
}

/// Local polish is the runtime and its own model: its install fetches
/// nothing of the voice's, and it polishes where no voice is installed
/// (Voice settings offers it whatever the speaking engine).
#[tokio::test]
async fn local_polish_needs_only_the_runtime_and_its_own_model() {
    assert!(shared_of(&POLISH).is_empty(), "no speech tokenizer");
    let voice_files: Vec<&str> = SHARED
        .iter()
        .chain(VARIANTS.iter().flat_map(|v| v.own))
        .map(|(_, c)| c.sha256)
        .collect();
    assert!(POLISH.own.iter().all(|(_, c)| !voice_files.contains(&c.sha256)));
    let (studio, _, _) = fake_studio("polish-alone", FAST, normal_pressure);
    studio
        .0
        .record(&|r| r["models"] = json!({POLISH.id: {}}))
        .unwrap();
    assert_eq!(studio.status()["installed"], false, "no voice");
    let (channel, _) = recorder();
    assert_eq!(
        studio.speak("Hello.", 1, &json!({}), channel).unwrap_err(),
        NOT_INSTALLED
    );
    assert_eq!(studio.warm_polish(&json!(["QueueTray"])), Ok(true));
    let frames = finished(&polish(&studio, "um so the QueueTray moves", 2)).await;
    assert_eq!(outcome(&frames[0])["type"], "polished");
}

/// A dictation warms the polish model ahead of its polish: once per
/// vocabulary, and apart from the voice, whose state and surfaces hear
/// nothing of it.
#[tokio::test]
async fn the_polish_model_warms_once_per_vocabulary_apart_from_the_voice() {
    let (studio, dir, seen) = fake_studio("polish-warm", FAST, normal_pressure);
    install_polish(&studio);
    let vocab = json!(["QueueTray"]);
    assert_eq!(studio.warm_polish(&vocab), Ok(true), "local polish will do it");
    assert_eq!(studio.warm_polish(&vocab), Ok(true));
    until("the polish model", || polish_ready(&studio)).await;
    studio.warm_polish(&vocab).unwrap();
    studio.warm_polish(&json!(["TalkPanel"])).unwrap();
    until("the polish model", || polish_ready(&studio)).await;
    let warmups: Vec<Value> = sent(&dir)
        .into_iter()
        .filter(|l| l["op"] == "warmup")
        .collect();
    assert_eq!(
        warmups,
        [
            json!({"id": 1, "op": "warmup", "slot": "polish", "vocab": ["QueueTray"]}),
            json!({"id": 2, "op": "warmup", "slot": "polish", "vocab": ["TalkPanel"]}),
        ]
    );
    assert!(
        status_events(&seen).is_empty(),
        "{:?}",
        status_events(&seen)
    );
    assert_eq!(
        studio.status()["state"],
        "starting",
        "the voice isn't loaded"
    );
}

#[test]
fn a_longer_polish_or_a_cold_model_gets_more_time() {
    let (studio, _, _) = fake_studio("polish-budget", TIMING, normal_pressure);
    let budget = |words, warm| studio.0.polish_budget(words, warm).as_millis();
    assert_eq!(budget(13, true), 700);
    assert_eq!(budget(30, true), 700);
    assert_eq!(budget(80, true), 1200);
    assert_eq!(budget(400, true), 1400);
    assert_eq!(budget(30, false), 4700);
}

/// Past its budget a polish ends `slow` (the frontend then polishes with
/// the cleanup child) and is cancelled at the sidecar. A model that isn't
/// loaded, or whose prompt is for another vocabulary, gets the loading
/// allowance on top.
#[tokio::test]
async fn a_polish_past_its_budget_ends_slow_and_a_cold_model_gets_longer() {
    let (studio, dir, _) = fake_studio("polish-slow", FAST, normal_pressure);
    install_polish(&studio);
    let cold = finished(&polish(&studio, "WAIT400 the tray", 1)).await;
    assert_eq!(outcome(&cold[0])["type"], "polished");
    studio.warm_polish(&json!(["QueueTray"])).unwrap();
    until("the polish model", || polish_ready(&studio)).await;
    let started = Instant::now();
    let slow = finished(&polish(&studio, "STALL the tray", 2)).await;
    let waited = started.elapsed();
    assert!(waited >= FAST.polish && waited < FAST.loading, "{waited:?}");
    assert_eq!(flags(&slow[0]), FINAL | ERROR);
    assert_eq!(outcome(&slow[0])["code"], "slow");
    assert!(sent(&dir).contains(&json!({"op": "cancel", "target": 3})));
    // The sidecar lets go of it, and the next one polishes.
    let next = finished(&polish(&studio, "um the pin", 3)).await;
    assert_eq!(outcome(&next[0])["text"], "The pin.");
    // Another vocabulary means a prompt to build first: not slow.
    let other = polish_with(&studio, "WAIT400 the pin", &json!(["TalkPanel"]), 4);
    assert_eq!(outcome(&finished(&other).await[0])["type"], "polished");
}

/// Without the polish model nothing starts: the frontend hears at once
/// that it should polish with the cleanup child.
#[tokio::test]
async fn polish_is_refused_at_once_without_its_model() {
    let (studio, dir, _) = fake_studio("polish-missing", FAST, normal_pressure);
    let (channel, frames) = recorder();
    assert_eq!(
        studio
            .polish("um the tray", &json!([]), 1, channel)
            .unwrap_err(),
        POLISH_NOT_INSTALLED
    );
    assert_eq!(studio.warm_polish(&json!([])), Ok(false), "the cleanup child will polish");
    assert!(!polish_installed(&studio));
    install_polish(&studio);
    assert!(polish_installed(&studio));
    // ...nor on a runtime another Redline built.
    studio
        .0
        .record(&|r| r["lock"] = "an older lock".into())
        .unwrap();
    let (channel, _) = recorder();
    assert_eq!(
        studio
            .polish("the tray", &json!([]), 2, channel)
            .unwrap_err(),
        POLISH_NOT_INSTALLED
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(frames.lock().unwrap().is_empty());
    assert!(log_lines(&dir, "spawns.log").is_empty());
}

/// A sidecar started before the polish model was installed is started
/// again with it for the next polish — but never under speech.
#[tokio::test]
async fn a_sidecar_from_before_the_polish_install_restarts_for_it_between_replies() {
    let (studio, dir, seen) = fake_studio("polish-restart", FAST, normal_pressure);
    finished(&say(&studio, "Before.", 1)).await;
    install_polish(&studio);
    let speaking = say(&studio, "SLOW Still talking.", 2);
    let (channel, _) = recorder();
    assert_eq!(
        studio
            .polish("the tray", &json!([]), 3, channel)
            .unwrap_err(),
        POLISH_LATER
    );
    assert_eq!(
        outcome(finished(&speaking).await.last().unwrap())["type"],
        "end"
    );
    let reply = finished(&polish(&studio, "um the tray", 4)).await;
    assert_eq!(outcome(&reply[0])["text"], "The tray.");
    // The new sidecar built its prompt for this vocabulary.
    assert_eq!(studio.0.lock().polish_vocab, json!(["QueueTray"]));
    let spawns = log_lines(&dir, "spawns.log");
    assert_eq!(spawns.len(), 2);
    assert!(!spawns[0].contains("--polish-model") && spawns[1].contains("--polish-model"));
    assert_eq!(
        status_events(&seen).last().unwrap(),
        &json!({"state": "off", "reason": "polish"}),
        "a stop, not a crash"
    );
}

/// A polish ends with its generation's cancel, as speech does, and with
/// the sidecar.
#[tokio::test]
async fn a_polish_ends_with_its_generation_or_with_the_sidecar() {
    let (studio, dir, _) = fake_studio("polish-cancel", FAST, normal_pressure);
    install_polish(&studio);
    let stalled = polish(&studio, "STALL the tray", 5);
    let after = polish(&studio, "WAIT100 the pin", 6);
    tokio::time::sleep(Duration::from_millis(50)).await;
    studio.cancel(5);
    let ended = stalled.lock().unwrap().clone();
    assert_eq!(flags(&ended[0]), FINAL | CANCELLED, "at once");
    until("the sidecar to be told", || {
        sent(&dir).contains(&json!({"op": "cancel", "target": 1}))
    })
    .await;
    assert_eq!(outcome(&finished(&after).await[0])["type"], "polished");

    let stuck = polish(&studio, "STALL again", 7);
    finished(&say(&studio, "DIE", 8)).await;
    assert_eq!(
        outcome(&finished(&stuck).await[0])["code"],
        "sidecar_exited"
    );
}

/// Removing the polish model takes only its files: the running sidecar
/// lets go of it, and the voice speaks on.
#[tokio::test]
async fn removing_the_polish_model_leaves_the_voice() {
    let (studio, dir, _) = fake_studio("polish-remove", FAST, normal_pressure);
    install_polish(&studio);
    let model = studio.0.dir.join("models").join(POLISH.id);
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("model.safetensors"), b"weights").unwrap();
    finished(&polish(&studio, "um the tray", 1)).await;
    studio.remove(true).unwrap();
    until("its files to go", || !model.exists()).await;
    assert!(sent(&dir).contains(&json!({"op": "unload", "slot": "polish"})));
    assert!(read_record(&studio.0.dir)["models"]
        .get(POLISH.id)
        .is_none());
    assert!(!polish_installed(&studio));
    assert_eq!(studio.status()["installed"], true, "the voice stays");
    let (channel, _) = recorder();
    assert_eq!(
        studio
            .polish("the tray", &json!([]), 2, channel)
            .unwrap_err(),
        POLISH_NOT_INSTALLED
    );
    let spoke = finished(&say(&studio, "Still here.", 3)).await;
    assert_eq!(outcome(spoke.last().unwrap())["type"], "end");
    assert_eq!(log_lines(&dir, "spawns.log").len(), 1, "never restarted");
}

/// The voice and local polish share the runtime: removing the voice
/// leaves local polish working on it, and the last of the two to go
/// takes everything with it.
#[tokio::test]
async fn the_last_of_the_voice_and_local_polish_takes_the_runtime() {
    let (studio, _, seen) = fake_studio("polish-last", FAST, normal_pressure);
    install_polish(&studio);
    let root = studio.0.dir.clone();
    let models = root.join("models");
    for d in [VARIANTS[0].id, "shared", POLISH.id] {
        std::fs::create_dir_all(models.join(d)).unwrap();
        std::fs::write(models.join(d).join("model.safetensors"), b"weights").unwrap();
    }
    finished(&say(&studio, "Before.", 1)).await;
    studio.remove(false).unwrap();
    let voice_gone =
        || !models.join(VARIANTS[0].id).exists() && !models.join("shared").exists();
    until("the voice's files to go", voice_gone).await;
    assert_eq!(studio.status()["installed"], false);
    assert_eq!(
        status_events(&seen).last().unwrap(),
        &json!({"state": "off", "reason": "removed"})
    );
    assert!(models.join(POLISH.id).exists() && root.join("venv").exists());
    let reply = finished(&polish(&studio, "um the tray", 2)).await;
    assert_eq!(outcome(&reply[0])["text"], "The tray.");
    studio.remove(true).unwrap();
    until("everything to go", || !root.exists()).await;
    assert!(!polish_installed(&studio));
}

/// The polish model is checked for what it needs, not the voice's 16 GB
/// and 4.5 GB, and can never be picked as a voice.
#[test]
fn the_polish_model_is_checked_for_its_own_needs() {
    let (studio, _, _) = fake_studio("polish-preflight", FAST, normal_pressure);
    let p = studio.preflight(Some(POLISH.id));
    assert_eq!(p["needMemoryBytes"], POLISH.memory);
    assert_eq!(p["needRamBytes"], 8_000_000_000u64);
    assert!(p["needDiskBytes"].as_u64().unwrap() <= 2_500_000_000);
    assert!(studio.set_prefs(&json!({"model": POLISH.id})).is_err());
}

/// The polish model's install says so in every `studio-setup` event, so
/// the settings card shows its progress in its own row.
#[tokio::test]
async fn the_polish_install_names_itself_in_its_progress() {
    use std::os::unix::fs::PermissionsExt;
    let (studio, _, seen) = fake_studio("polish-install", FAST, normal_pressure);
    // A runtime to rebuild, with a uv that fails at once: no network.
    studio
        .0
        .record(&|r| r["lock"] = "an older lock".into())
        .unwrap();
    let uv = studio.0.data_dir.join("kokoro/bin/uv");
    std::fs::create_dir_all(uv.parent().unwrap()).unwrap();
    std::fs::write(&uv, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
    studio.install(true);
    assert_eq!(studio.status()["installing"], POLISH.id);
    until("the install to end", || {
        seen.lock()
            .unwrap()
            .iter()
            .any(|(e, p)| e == "studio-setup" && p["phase"] == "error")
    })
    .await;
    let setup: Vec<Value> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(e, _)| e == "studio-setup")
        .map(|(_, p)| p.clone())
        .collect();
    assert!(
        setup.len() >= 2 && setup.iter().all(|p| p["polish"] == true),
        "{setup:?}"
    );
    assert_eq!(studio.status()["installing"], Value::Null);
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
                let mut entries: Vec<(std::ffi::OsString, Option<std::time::SystemTime>)> =
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
    fetch_pinned(
        &reqwest::Client::new(),
        &check.at(&url),
        &dest,
        "the tokenizer",
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

/// REDLINE_STUDIO_VENV names a venv with the locked packages (mlx-lm
/// among them), and REDLINE_POLISH_MODEL a directory holding the polish
/// model's five files; no voice model is needed. A generous budget, so
/// a machine busy with other work reports its latency rather than
/// failing on it: what each polish took is printed against the 700 ms.
#[tokio::test]
#[ignore = "needs REDLINE_STUDIO_VENV and REDLINE_POLISH_MODEL"]
async fn real_sidecar_polishes_a_dictation_and_never_answers_it() {
    let venv = from_env("REDLINE_STUDIO_VENV");
    let model = from_env("REDLINE_POLISH_MODEL");
    let data =
        std::env::temp_dir().join(format!("redline-studio-real-polish-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let dir = data.join("voice-studio");
    let polish_dir = dir.join("models").join(POLISH.id);
    std::fs::create_dir_all(polish_dir.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(venv, dir.join("venv")).unwrap();
    std::os::unix::fs::symlink(model, &polish_dir).unwrap();
    std::fs::write(
        dir.join("install.json"),
        json!({"lock": lock_hash(), "models": {POLISH.id: {}}}).to_string(),
    )
    .unwrap();
    let db = Arc::new(Database::open_in_memory().unwrap());
    let timing = Timing {
        polish: Duration::from_secs(15),
        ..TIMING
    };
    let studio = Studio::with(&data, reqwest::Client::new(), db, timing, memory_pressure);

    let vocab = json!(["VoicePanel", "tts.rs", "Kokoro", "QueueTray"]);
    let started = Instant::now();
    studio.warm_polish(&vocab).unwrap();
    patiently("the polish model", || polish_ready(&studio)).await;
    println!("\nspawn to warm: {:?}", started.elapsed());

    let dictated = "um so the VoicePanel should, should stop reading when the Kokoro \
                        sidecar in tts dot rs times out and uh fall back to the system voice";
    let asked = "can you tell me why the QueueTray hides the newest line when a reply is long";
    for (n, said) in [dictated, asked, dictated, asked, dictated, asked]
        .into_iter()
        .enumerate()
    {
        let started = Instant::now();
        let frames = polish_with(&studio, said, &vocab, n as u64 + 1);
        patiently("the polish", || final_of(&frames).is_some()).await;
        let took = started.elapsed();
        let reply = outcome(&final_of(&frames).unwrap());
        println!(
            "{:>5.0} ms ({} words; budget {} ms): {}",
            took.as_secs_f64() * 1e3,
            said.split_whitespace().count(),
            TIMING.polish.as_millis(),
            reply
        );
        assert_eq!(reply["type"], "polished", "{reply}");
        let text = reply["text"].as_str().unwrap();
        if said == asked {
            assert!(
                text.starts_with("Can you tell me why the QueueTray") && text.ends_with('?'),
                "still the speaker's question: {text}"
            );
        } else {
            assert_eq!(reply["guard"], Value::Null, "{reply}");
            assert!(!text.contains(" um ") && !text.contains(" uh "), "{text}");
            for term in ["VoicePanel", "Kokoro", "tts.rs"] {
                assert!(text.contains(term), "{term} kept: {text}");
            }
        }
    }
    let _ = std::fs::remove_dir_all(&data);
}

// SPDX-License-Identifier: Apache-2.0
//! Event-triggered, local keyframe recordings. The persisted frame list is the
//! recording; no video codec, model service, or shell process is involved.
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Database;
use crate::mission_context as context;
use crate::state::now_millis;

const MAX_FRAMES: usize = 8;
const INTERVAL_MS: u64 = 1_000;
const COOLDOWN_MS: i64 = 10_000;
const PROCESSING_MS: u64 = 15_000;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
static WORKER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static SCHEDULED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static INTAKE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct IntakeGuard(String);
impl Drop for IntakeGuard {
    fn drop(&mut self) {
        INTAKE
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&self.0);
    }
}
fn reserve_intake(mission: &str, tab: &str) -> Option<IntakeGuard> {
    let key = format!("{mission}:{tab}");
    let mut active = INTAKE.get_or_init(Default::default).lock().unwrap();
    if active.len() >= 2 || !active.insert(key.clone()) {
        return None;
    }
    Some(IntakeGuard(key))
}
fn check_cooldown(db: &Database, mission: &str, tab: &str) -> Result<(), String> {
    let recent: Option<i64> = db.lock_conn().query_row("SELECT MAX(created_at) FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.tabId')=?2 AND json_extract(body,'$.adapter')='redline-keyframes-v1'",params![mission,tab],|r|r.get(0)).map_err(|e|e.to_string())?;
    if recent.is_some_and(|at| now_millis() - at < COOLDOWN_MS) {
        return Err("capture event coalesced during cooldown".into());
    }
    Ok(())
}

pub struct SegmentSeed {
    pub mission_id: String,
    pub tab_id: String,
    pub label: String,
    pub url: String,
    pub key: String,
    pub bytes: Vec<u8>,
    pub page_text: String,
    pub revision: Option<String>,
}

fn bounded(text: &str, bytes: usize) -> String {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn changed(app: &AppHandle, mission: &str, id: Option<&str>) {
    let _ = app.emit(
        "mission-capture-changed",
        json!({"missionId":mission,"captureId":id}),
    );
}

fn record(db: &Database, mission: &str, id: &str) -> Result<Value, String> {
    context::get(&db.lock_conn(), mission, "capture", id)?.ok_or_else(|| "capture not found".into())
}

fn modify(
    db: &Database,
    mission: &str,
    id: &str,
    f: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<Value, String> {
    let mut conn = db.lock_conn();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut capture = context::get(&tx, mission, "capture", id)?.ok_or("capture not found")?;
    if capture["status"] == "expired" || capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
    {
        return Err("capture has expired".into());
    }
    f(&mut capture)?;
    context::put(&tx, mission, "capture", id, &capture)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(capture)
}

fn enrolled(db: &Database, mission: &str, tab: &str, label: &str) -> Result<(), String> {
    if label != format!("browser-{tab}") {
        return Err("capture target and tab differ".into());
    }
    let tabs = crate::browser_workspace::tabs(db, mission)?;
    if !tabs.iter().any(|entry| {
        entry["id"].as_str() == Some(tab)
            || entry["browseId"]
                .as_str()
                .is_some_and(|id| format!("t-{id}") == tab)
    }) {
        return Err("capture page is no longer enrolled in its mission".into());
    }
    Ok(())
}

const OBSERVE: &str = "JSON.stringify({url:location.href,documentId:String(performance.timeOrigin),revision:window.__redline_revision?window.__redline_revision():String(performance.timeOrigin),text:(document.body?document.body.innerText:'').slice(0,8000)})";

async fn observe(
    app: &AppHandle,
    db: &Database,
    mission: &str,
    tab: &str,
    label: &str,
    url: &str,
) -> Result<Value, String> {
    context::capture_scope_policy(db, mission, tab, url)?;
    enrolled(db, mission, tab, label)?;
    if !crate::browser_workspace::protected(label) || app.get_webview(label).is_none() {
        return Err("capture stopped because the selected page is no longer visible".into());
    }
    let observation: Value = serde_json::from_str(&crate::daemon_eval(app, label, OBSERVE).await?)
        .map_err(|e| e.to_string())?;
    if observation["url"].as_str() != Some(url) {
        return Err("capture page navigated; the new page needs a new event".into());
    }
    context::capture_scope_policy(
        db,
        mission,
        tab,
        observation["url"].as_str().unwrap_or_default(),
    )?;
    Ok(observation)
}

fn stable_frame(before: &Value, after: &Value) -> bool {
    before["url"].is_string()
        && before["documentId"].is_string()
        && before["revision"].is_string()
        && before["url"] == after["url"]
        && before["documentId"] == after["documentId"]
        && before["revision"] == after["revision"]
}

/// Cheap scheduling entry; all database/native work runs outside the caller.
pub fn start_segment(app: AppHandle, db: Arc<Database>, seed: SegmentSeed) {
    let Some(guard) = reserve_intake(&seed.mission_id, &seed.tab_id) else {
        return;
    };
    start_segment_guarded(app, db, seed, guard);
}
fn start_segment_guarded(
    app: AppHandle,
    db: Arc<Database>,
    mut seed: SegmentSeed,
    guard: IntakeGuard,
) {
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let mission = seed.mission_id.clone();
        let result = async {
            check_cooldown(&db, &seed.mission_id, &seed.tab_id)?;
            let mut observed = observe(
                &app,
                &db,
                &seed.mission_id,
                &seed.tab_id,
                &seed.label,
                &seed.url,
            )
            .await?;
            if seed
                .revision
                .as_ref()
                .is_some_and(|revision| observed["revision"].as_str() != Some(revision))
            {
                return Err(
                    "initial screenshot revision changed; discarded from mission recording"
                        .to_owned(),
                );
            }
            if seed.revision.is_none() {
                let bytes =
                    crate::thumbs::capture_shot(&app, &seed.label, crate::shots::SHOT_WIDTH)
                        .await?;
                let after = observe(
                    &app,
                    &db,
                    &seed.mission_id,
                    &seed.tab_id,
                    &seed.label,
                    &seed.url,
                )
                .await?;
                if !stable_frame(&observed, &after) {
                    return Err("unverified initial screenshot discarded".into());
                }
                seed.bytes = bytes;
                seed.page_text = after["text"].as_str().unwrap_or("").to_owned();
                observed = after;
            }
            if seed.bytes.is_empty() || seed.bytes.len() > MAX_FRAME_BYTES {
                return Err("initial frame exceeds capture bounds".into());
            }
            let database = db.clone();
            let capture_app = app.clone();
            let capture = tauri::async_runtime::spawn_blocking(move || {
                prepare(&capture_app, &database, seed, observed)
            })
            .await
            .map_err(|e| e.to_string())??;
            let id = capture["id"]
                .as_str()
                .ok_or("capture has no identity")?
                .to_owned();
            changed(&app, &mission, Some(&id));
            schedule(app.clone(), db.clone(), mission.clone(), id, false);
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            tracing::debug!(%error, %mission, "mission recording not started");
        }
    });
}

/// Pin/rejection events can request a segment without recording a duplicate
/// navigation ledger row. Every target comes from the source event itself.
pub fn capture_event(
    app: AppHandle,
    db: Arc<Database>,
    mission_id: String,
    tab_id: String,
    url: String,
) {
    let Some(guard) = reserve_intake(&mission_id, &tab_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let label = format!("browser-{tab_id}");
        let result = async {
            context::capture_admission(&db, &mission_id, &tab_id, &url)?;
            check_cooldown(&db, &mission_id, &tab_id)?;
            let before = observe(&app, &db, &mission_id, &tab_id, &label, &url).await?;
            let bytes = crate::thumbs::capture_shot(&app, &label, crate::shots::SHOT_WIDTH).await?;
            let after = observe(&app, &db, &mission_id, &tab_id, &label, &url).await?;
            if !stable_frame(&before, &after) {
                return Err("page changed during event screenshot".to_owned());
            }
            let key = format!("mc-{}", &crate::ledger::sha256_hex(&bytes)[..60]);
            start_segment_guarded(
                app.clone(),
                db.clone(),
                SegmentSeed {
                    mission_id: mission_id.clone(),
                    tab_id,
                    label,
                    url,
                    key,
                    bytes,
                    page_text: after["text"].as_str().unwrap_or("").into(),
                    revision: after["revision"].as_str().map(str::to_owned),
                },
                guard,
            );
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            tracing::debug!(%error,%mission_id,"mission event capture skipped");
        }
    });
}

fn prepare(
    app: &AppHandle,
    db: &Database,
    seed: SegmentSeed,
    observed: Value,
) -> Result<Value, String> {
    let policy = context::capture_admission(db, &seed.mission_id, &seed.tab_id, &seed.url)?;
    let now = now_millis();
    check_cooldown(db, &seed.mission_id, &seed.tab_id)?;
    // The shared page shot is keyed by DOM text and can be overwritten. Pin the
    // actual pixel bytes under a content-addressed recording key instead.
    let hash = crate::ledger::sha256_hex(&seed.bytes);
    let key = format!("mc-{}", &hash[..60]);
    let frame = json!({"at":now,"url":seed.url,"mediaRef":format!("shot://{key}"),"sourceShotRef":format!("shot://{}",seed.key),"byteSize":seed.bytes.len(),"contentHash":hash,"revision":observed["revision"],"pageText":bounded(&seed.page_text,8000),"processingStatus":"pending"});
    let capture = context::enqueue_capture_with_store(
        db,
        &seed.mission_id,
        json!({"tabId":seed.tab_id,"url":seed.url,"mediaRef":frame["mediaRef"],"contentHash":frame["contentHash"],"byteSize":seed.bytes.len(),"startedAt":now,"endedAt":now,"keyframes":[frame],"adapter":"redline-keyframes-v1","label":seed.label,"documentId":observed["documentId"],"maxDurationMs":policy["maxDurationMs"].as_u64().unwrap_or(7000).min((MAX_FRAMES as u64-1)*INTERVAL_MS),"frameCount":1,"recordingComplete":false}),
        &|| crate::shots::write_shot(app, &key, &seed.bytes).map(|_| ()),
    )?;
    if capture["status"] != "queued" {
        return Err("recording content already exists".into());
    }
    Ok(capture)
}

fn schedule(app: AppHandle, db: Arc<Database>, mission: String, id: String, recovering: bool) {
    let key = format!("{mission}:{id}");
    {
        let mut scheduled = SCHEDULED.get_or_init(Default::default).lock().unwrap();
        if scheduled.len() >= 20 || !scheduled.insert(key.clone()) {
            return;
        }
    }
    tauri::async_runtime::spawn(async move {
        let _permit = WORKER
            .acquire()
            .await
            .expect("capture semaphore remains open");
        let result = run(&app, &db, &mission, &id, recovering).await;
        if let Err(error) = result {
            let _ = modify(&db, &mission, &id, |capture| {
                capture["status"] = json!("failed");
                capture["error"] = json!(error);
                Ok(())
            });
        }
        changed(&app, &mission, Some(&id));
        SCHEDULED.get().unwrap().lock().unwrap().remove(&key);
        drop(_permit);
        resume(app, db);
    });
}

async fn run(
    app: &AppHandle,
    db: &Arc<Database>,
    mission: &str,
    id: &str,
    recovering: bool,
) -> Result<(), String> {
    let capture = record(db, mission, id)?;
    if !matches!(
        capture["status"].as_str(),
        Some("queued" | "capturing" | "processing")
    ) {
        return Ok(());
    }
    let tab = capture["tabId"].as_str().ok_or("missing tab")?.to_owned();
    let label = capture["label"]
        .as_str()
        .ok_or("missing target")?
        .to_owned();
    let url = capture["url"].as_str().ok_or("missing source")?.to_owned();
    let deadline =
        capture["startedAt"].as_i64().unwrap_or(0) + capture["maxDurationMs"].as_i64().unwrap_or(0);
    if !recovering && capture["recordingComplete"] != true {
        modify(db, mission, id, |c| {
            c["status"] = json!("capturing");
            Ok(())
        })?;
        changed(app, mission, Some(id));
        for index in 1..MAX_FRAMES {
            let at = capture["startedAt"].as_i64().unwrap_or(0) + index as i64 * INTERVAL_MS as i64;
            if at > deadline || now_millis() > deadline {
                break;
            }
            if at > now_millis() {
                tokio::time::sleep(Duration::from_millis((at - now_millis()).max(0) as u64)).await;
            }
            let frame = async {
                let before = observe(app, db, mission, &tab, &label, &url).await?;
                if before["documentId"] != capture["documentId"] {
                    return Err("capture document changed".into());
                }
                let bytes =
                    crate::thumbs::capture_shot(app, &label, crate::shots::SHOT_WIDTH).await?;
                let after = observe(app, db, mission, &tab, &label, &url).await?;
                if !stable_frame(&before, &after) {
                    return Err("page changed during screenshot; frame discarded".into());
                }
                if bytes.len() > MAX_FRAME_BYTES || now_millis() > deadline {
                    return Err("frame exceeded recording bounds".into());
                }
                let database = db.clone();
                let app = app.clone();
                let mission = mission.to_owned();
                let id = id.to_owned();
                tauri::async_runtime::spawn_blocking(move || {
                    append_frame(&app, &database, &mission, &id, after, bytes)
                })
                .await
                .map_err(|e| e.to_string())?
            }
            .await;
            if let Err(error) = frame {
                modify(db, mission, id, |c| {
                    c["recordingError"] = json!(error);
                    Ok(())
                })?;
                break;
            }
            changed(app, mission, Some(id));
        }
    }
    modify(db, mission, id, |capture| {
        capture["recordingComplete"] = json!(true);
        capture["status"] = json!("processing");
        if recovering {
            capture["recovered"] = json!(true);
        }
        Ok(())
    })?;
    let app = app.clone();
    let db = db.clone();
    let mission = mission.to_owned();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || process(&app, &db, &mission, &id))
        .await
        .map_err(|e| e.to_string())?
}

fn append_frame(
    app: &AppHandle,
    db: &Database,
    mission: &str,
    id: &str,
    observation: Value,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let current = record(db, mission, id)?;
    let tab = current["tabId"].as_str().ok_or("missing tab")?;
    let url = current["url"].as_str().ok_or("missing URL")?;
    let policy = context::capture_scope_policy(db, mission, tab, url)?;
    let hash = crate::ledger::sha256_hex(&bytes);
    if current["keyframes"].as_array().is_some_and(|frames| {
        frames
            .last()
            .is_some_and(|frame| frame["contentHash"] == hash)
    }) {
        return Ok(());
    }
    let key = format!("mc-{}", &hash[..60]);
    let mut conn = db.lock_conn();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut capture = context::get(&tx, mission, "capture", id)?.ok_or("capture missing")?;
    let latest_policy =
        context::get(&tx, mission, "capture_policy", "current")?.ok_or("capture disabled")?;
    if latest_policy != policy {
        return Err("capture settings changed before frame persistence".into());
    }
    context::capture_policy_in(&tx, mission, tab, url, true)?;
    if capture["status"] != "capturing"
        || capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
    {
        return Err("capture no longer accepts frames".into());
    }
    let used: u64 = tx.query_row("SELECT COALESCE(SUM(json_extract(body,'$.byteSize')),0) FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?2",params![mission,now_millis()],|r|r.get(0)).map_err(|e|e.to_string())?;
    if used.saturating_add(bytes.len() as u64) > policy["maxBytes"].as_u64().unwrap_or(0) {
        return Err("capture storage budget reached".into());
    }
    let frames = capture["keyframes"]
        .as_array_mut()
        .ok_or("frame list missing")?;
    if frames.len() >= MAX_FRAMES {
        return Err("frame limit reached".into());
    }
    crate::shots::write_shot(app, &key, &bytes)?;
    frames.push(json!({"at":now_millis(),"url":url,"mediaRef":format!("shot://{key}"),"contentHash":hash,"byteSize":bytes.len(),"revision":observation["revision"],"pageText":bounded(observation["text"].as_str().unwrap_or(""),8000),"processingStatus":"pending"}));
    capture["frameCount"] = json!(frames.len());
    capture["endedAt"] = json!(now_millis());
    capture["byteSize"] = json!(capture["byteSize"].as_u64().unwrap_or(0) + bytes.len() as u64);
    context::put(&tx, mission, "capture", id, &capture)?;
    tx.commit().map_err(|e| e.to_string())
}

fn frame_key(frame: &Value) -> Result<&str, String> {
    let key = frame["mediaRef"]
        .as_str()
        .and_then(|s| s.strip_prefix("shot://"))
        .ok_or("frame is unavailable")?;
    if !crate::shots::valid_key(key) {
        return Err("invalid frame reference".into());
    }
    Ok(key)
}

fn structural_summary(ocr: &crate::capture_ocr::OcrResult) -> String {
    let labels = ocr
        .text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" · ");
    bounded(
        &format!(
            "Local screenshot text layout: {} recognized regions. Visible text: {}",
            ocr.regions.len(),
            if labels.is_empty() {
                "none recognized"
            } else {
                &labels
            }
        ),
        1200,
    )
}

fn process(app: &AppHandle, db: &Database, mission: &str, id: &str) -> Result<(), String> {
    process_with(
        db,
        mission,
        id,
        &|frame| {
            let path = crate::shots::shots_dir(app)?.join(format!("{}.png", frame_key(frame)?));
            if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_FRAME_BYTES as u64 {
                return Err("stored frame exceeds byte limit".into());
            }
            std::fs::read(path).map_err(|e| e.to_string())
        },
        &crate::capture_ocr::recognize_png,
        &|| changed(app, mission, Some(id)),
    )
}

fn checkpoint_ocr(
    db: &Database,
    mission: &str,
    id: &str,
    index: usize,
    result: Result<crate::capture_ocr::OcrResult, String>,
) -> Result<bool, String> {
    let mut conn = db.lock_conn();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut capture = context::get(&tx, mission, "capture", id)?.ok_or("capture not found")?;
    if capture["status"] == "expired" || capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
    {
        return Err("capture expired while OCR ran".into());
    }
    let allowed = context::capture_policy_in(
        &tx,
        mission,
        capture["tabId"].as_str().unwrap_or(""),
        capture["url"].as_str().unwrap_or(""),
        true,
    );
    let active = allowed.is_ok();
    if let Err(error) = allowed {
        capture["status"] = json!("paused");
        capture["error"] = json!(error);
    } else {
        let frame = &mut capture["keyframes"][index];
        match result {
            Ok(ocr) => {
                frame["summary"] = json!(structural_summary(&ocr));
                frame["ocr"] = json!(ocr.text);
                frame["confidence"] = json!(ocr.confidence);
                frame["extractorVersion"] = json!(ocr.extractor_version);
                frame["modelVersion"] = json!(ocr.model_version);
                frame["regions"] = serde_json::to_value(ocr.regions).map_err(|e| e.to_string())?;
                frame["processingStatus"] = json!("indexed");
                frame["error"] = Value::Null;
            }
            Err(error) => {
                // A resumed/retried frame may carry an older derivative. A
                // failed replacement cannot retain that text or confidence.
                for field in [
                    "ocr",
                    "summary",
                    "confidence",
                    "regions",
                    "extractorVersion",
                    "modelVersion",
                ] {
                    frame[field] = Value::Null;
                }
                frame["processingStatus"] = json!("failed");
                frame["error"] = json!(error);
            }
        }
        capture["processingCheckpoint"] = json!(index + 1);
    }
    context::put(&tx, mission, "capture", id, &capture)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(active)
}

fn process_with(
    db: &Database,
    mission: &str,
    id: &str,
    load: &dyn Fn(&Value) -> Result<Vec<u8>, String>,
    ocr: &dyn Fn(&[u8]) -> Result<crate::capture_ocr::OcrResult, String>,
    notify: &dyn Fn(),
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let count = record(db, mission, id)?["keyframes"]
        .as_array()
        .map_or(0, Vec::len);
    for index in 0..count.min(MAX_FRAMES) {
        let capture = record(db, mission, id)?;
        let frame = &capture["keyframes"][index];
        if matches!(
            frame["processingStatus"].as_str(),
            Some("indexed" | "failed")
        ) {
            continue;
        }
        let result = (|| {
            context::capture_scope_policy(
                db,
                mission,
                capture["tabId"].as_str().unwrap_or(""),
                capture["url"].as_str().unwrap_or(""),
            )?;
            if started.elapsed().as_millis() >= PROCESSING_MS as u128 {
                return Err("segment processing budget reached".to_owned());
            }
            let bytes = load(frame)?;
            if bytes.len() > MAX_FRAME_BYTES {
                return Err("stored frame exceeds byte limit".into());
            }
            if crate::ledger::sha256_hex(&bytes) != frame["contentHash"].as_str().unwrap_or("") {
                return Err("frame integrity check failed".into());
            }
            ocr(&bytes)
        })();
        if !checkpoint_ocr(db, mission, id, index, result)? {
            return Ok(());
        }
        notify();
    }
    let capture = record(db, mission, id)?;
    let frames = capture["keyframes"].as_array().ok_or("no frames")?;
    let ocr = frames
        .iter()
        .filter(|f| f["processingStatus"] == "indexed")
        .filter_map(|f| f["ocr"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let page = frames
        .first()
        .and_then(|f| f["pageText"].as_str())
        .unwrap_or("");
    let succeeded = frames
        .iter()
        .filter(|f| f["processingStatus"] == "indexed")
        .count();
    let confidence = frames
        .iter()
        .filter(|f| f["processingStatus"] == "indexed")
        .filter_map(|f| f["confidence"].as_f64())
        .sum::<f64>()
        / succeeded.max(1) as f64;
    let summary = format!(
        "Local keyframe recording: {} frames; {} processed by OCR; {} OCR failures. {}",
        frames.len(),
        succeeded,
        frames.len() - succeeded,
        frames
            .first()
            .and_then(|f| f["summary"].as_str())
            .unwrap_or(
            "No visual text summary is available; accompanying DOM text is retained separately."
        )
    );
    context::index_capture(
        db,
        mission,
        id,
        json!({"extractorVersion":"redline-keyframe-ocr-v1","modelVersion":frames.iter().find_map(|f|f["modelVersion"].as_str()).unwrap_or("unavailable"),"local":true,"confidence":confidence,"ocr":bounded(&ocr,16000),"pageText":bounded(page,8000),"summary":bounded(&summary,2000),"evidenceKind":"Timestamped screenshots with local Apple Vision OCR and text-layout descriptions; no semantic image interpretation"}),
    )?;
    modify(db, mission, id, |c| {
        c["processingElapsedMs"] = json!(started.elapsed().as_millis() as u64);
        c["ocrFailures"] = json!(frames.len() - succeeded);
        c["error"] = if succeeded < frames.len() {
            json!(format!(
                "{} frames could not be read by local OCR",
                frames.len() - succeeded
            ))
        } else {
            Value::Null
        };
        Ok(())
    })?;
    Ok(())
}

/// Replay extraction checkpoints after restart, never an old page capture.
pub fn resume(app: AppHandle, db: Arc<Database>) {
    tauri::async_runtime::spawn(async move {
        let mut cursor = 0;
        loop {
            if SCHEDULED
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .len()
                >= 20
            {
                return;
            }
            let database = db.clone();
            let pending =
                tauri::async_runtime::spawn_blocking(move || pending_page(&database, cursor)).await;
            let pending = match pending {
                Ok(Ok(rows)) => rows,
                other => {
                    tracing::warn!(?other, "mission capture recovery failed");
                    return;
                }
            };
            if pending.is_empty() {
                return;
            }
            for (row, mission, id) in pending {
                cursor = row;
                if let Ok(capture) = record(&db, &mission, &id) {
                    if context::capture_scope_policy(
                        &db,
                        &mission,
                        capture["tabId"].as_str().unwrap_or(""),
                        capture["url"].as_str().unwrap_or(""),
                    )
                    .is_ok()
                    {
                        if capture["status"] == "paused" {
                            let _ = modify(&db, &mission, &id, |c| {
                                c["status"] = json!("queued");
                                Ok(())
                            });
                        }
                        schedule(app.clone(), db.clone(), mission, id, true);
                    }
                }
                if SCHEDULED.get().unwrap().lock().unwrap().len() >= 20 {
                    return;
                }
            }
            tokio::task::yield_now().await;
        }
    });
}

type PendingCapture = (i64, String, String);
fn pending_page(db: &Database, cursor: i64) -> Result<Vec<PendingCapture>, String> {
    let conn = db.lock_conn();
    let mut statement=conn.prepare("SELECT capture.rowid,capture.mission_id,capture.id FROM mission_records capture JOIN mission_records policy ON policy.mission_id=capture.mission_id AND policy.kind='capture_policy' AND policy.id='current' WHERE capture.rowid>?1 AND capture.kind='capture' AND json_extract(capture.body,'$.adapter')='redline-keyframes-v1' AND json_extract(capture.body,'$.status') IN ('queued','capturing','processing','paused') AND json_extract(capture.body,'$.expiresAt')>?2 AND json_extract(policy.body,'$.enabled')=1 AND COALESCE(json_extract(policy.body,'$.paused'),0)=0 AND EXISTS (SELECT 1 FROM json_each(policy.body,'$.tabIds') tab WHERE tab.value=json_extract(capture.body,'$.tabId')) ORDER BY capture.rowid LIMIT 100").map_err(|e|e.to_string())?;
    let rows = statement
        .query_map(params![cursor, now_millis()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub(crate) fn readable_capture(db: &Database, mission: &str, id: &str) -> Result<Value, String> {
    let capture = record(db, mission, id)?;
    if capture["status"] == "expired" {
        return Ok(capture);
    }
    context::capture_policy_in(
        &db.lock_conn(),
        mission,
        capture["tabId"].as_str().unwrap_or(""),
        capture["url"].as_str().unwrap_or(""),
        false,
    )?;
    Ok(capture)
}

/// The global shot sweeper must treat every retained frame as referenced.
/// Exceeding this bounded inventory fails closed rather than deleting frames.
pub fn retained_frame_keys(db: &Database) -> Result<HashSet<String>, String> {
    let conn = db.lock_conn();
    let mut stmt=conn.prepare("SELECT DISTINCT json_extract(frame.value,'$.mediaRef') FROM mission_records, json_each(body,'$.keyframes') frame WHERE kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?1 UNION SELECT json_extract(body,'$.mediaRef') FROM mission_records WHERE kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?1 LIMIT 20001").map_err(|e|e.to_string())?;
    let refs = stmt
        .query_map([now_millis()], |r| r.get::<_, Option<String>>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if refs.len() > 20000 {
        return Err("capture reference inventory exceeded its safety bound".into());
    }
    Ok(refs
        .into_iter()
        .flatten()
        .filter_map(|reference| reference.strip_prefix("shot://").map(str::to_owned))
        .filter(|key| crate::shots::valid_key(key))
        .collect())
}

fn prepare_retry(db: &Database, mission: &str, id: &str) -> Result<(), String> {
    let capture = readable_capture(db, mission, id)?;
    context::capture_scope_policy(
        db,
        mission,
        capture["tabId"].as_str().unwrap_or(""),
        capture["url"].as_str().unwrap_or(""),
    )?;
    modify(db, mission, id, |capture| {
        if matches!(
            capture["status"].as_str(),
            Some("queued" | "capturing" | "processing")
        ) {
            return Ok(());
        }
        for frame in capture["keyframes"]
            .as_array_mut()
            .ok_or("capture has no retained frames")?
        {
            if frame["processingStatus"] == "failed" {
                frame["processingStatus"] = json!("pending");
                frame["error"] = Value::Null;
            }
        }
        capture["recordingComplete"] = json!(true);
        capture["status"] = json!("queued");
        capture["error"] = Value::Null;
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
pub async fn mission_capture_retry(
    app: AppHandle,
    mission: tauri::State<'_, crate::mission::MissionState>,
    mission_id: String,
    capture_id: String,
) -> Result<(), String> {
    let db = mission.db.clone();
    if SCHEDULED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .contains(&format!("{mission_id}:{capture_id}"))
    {
        return Ok(());
    }
    let database = db.clone();
    let owner = mission_id.clone();
    let id = capture_id.clone();
    tauri::async_runtime::spawn_blocking(move || prepare_retry(&database, &owner, &id))
        .await
        .map_err(|e| e.to_string())??;
    changed(&app, &mission_id, Some(&capture_id));
    schedule(app, db, mission_id, capture_id, true);
    Ok(())
}

#[tauri::command]
pub async fn mission_capture_frame(
    app: AppHandle,
    mission: tauri::State<'_, crate::mission::MissionState>,
    mission_id: String,
    capture_id: String,
    key: String,
) -> Result<String, String> {
    let db = mission.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capture = readable_capture(&db, &mission_id, &capture_id)?;
        if capture["status"] == "expired"
            || capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
        {
            return Err("recording is unavailable".into());
        }
        let frame = capture["keyframes"]
            .as_array()
            .and_then(|frames| {
                frames
                    .iter()
                    .find(|f| frame_key(f).ok() == Some(key.as_str()))
            })
            .ok_or("frame does not belong to this capture")?;
        let path = crate::shots::shots_dir(&app)?.join(format!("{}.png", frame_key(frame)?));
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_FRAME_BYTES as u64 {
            return Err("frame exceeds byte limit".into());
        }
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        if frame["contentHash"]
            .as_str()
            .is_some_and(|hash| crate::ledger::sha256_hex(&bytes) != hash)
        {
            return Err("frame integrity check failed".into());
        }
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Database, String) {
        let db = Database::open_in_memory().unwrap();
        context::initialize(&db).unwrap();
        db.insert_mission(&crate::state::Mission {
            mission_id: "m1".into(),
            title: "Capture test".into(),
            goal: "Retain exact evidence".into(),
            status: "active".into(),
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
        context::put(&db.lock_conn(),"m1","capture_policy","current",&json!({"enabled":true,"paused":false,"tabIds":["tab1"],"excludedHosts":[],"maxDurationMs":7000,"maxBytes":1000000,"retentionMs":60000,"localOnly":true})).unwrap();
        let at = now_millis();
        let hash = crate::ledger::sha256_hex(b"pixels");
        let capture=context::enqueue_capture(&db,"m1",json!({"adapter":"redline-keyframes-v1","tabId":"tab1","url":"https://source.test","mediaRef":"shot://mc-first","contentHash":hash,"byteSize":6,"startedAt":at,"endedAt":at,"keyframes":[{"at":at,"url":"https://source.test","mediaRef":"shot://mc-first","sourceShotRef":"shot://bs-original","contentHash":hash,"pageText":"Accompanying DOM text","processingStatus":"pending"}],"recordingComplete":true})).unwrap();
        let id = capture["id"].as_str().unwrap().to_owned();
        modify(&db, "m1", &id, |c| {
            c["status"] = json!("processing");
            Ok(())
        })
        .unwrap();
        (db, id)
    }
    fn policy_change(db: &Database, field: &str, value: Value) {
        let mut policy = context::get(&db.lock_conn(), "m1", "capture_policy", "current")
            .unwrap()
            .unwrap();
        policy[field] = value;
        context::put(&db.lock_conn(), "m1", "capture_policy", "current", &policy).unwrap();
    }
    fn result() -> crate::capture_ocr::OcrResult {
        crate::capture_ocr::OcrResult {
            text: "Visible announcement".into(),
            confidence: 0.8,
            extractor_version: "fixture-v1".into(),
            model_version: "fixture-local".into(),
            regions: vec![],
            truncated: false,
        }
    }

    #[test]
    fn pause_or_exclusion_during_ocr_cannot_publish_derivatives() {
        for (field, value) in [
            ("paused", json!(true)),
            ("excludedHosts", json!(["source.test"])),
            ("tabIds", json!([])),
        ] {
            let (db, id) = fixture();
            process_with(
                &db,
                "m1",
                &id,
                &|_| Ok(b"pixels".to_vec()),
                &|_| {
                    policy_change(&db, field, value.clone());
                    Ok(result())
                },
                &|| {},
            )
            .unwrap();
            let capture = record(&db, "m1", &id).unwrap();
            assert_eq!(capture["status"], "paused");
            assert!(capture["keyframes"][0]["ocr"].is_null());
            assert!(capture["derivatives"].is_null());
            assert_eq!(
                db.lock_conn()
                    .query_row("SELECT COUNT(*) FROM mission_derivatives", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
    #[test]
    fn failed_ocr_is_explicit_and_retry_only_reprocesses_failed_frames() {
        let (db, id) = fixture();
        assert!(checkpoint_ocr(&db, "m1", &id, 0, Ok(result())).unwrap());
        modify(&db, "m1", &id, |c| {
            let mut second = c["keyframes"][0].clone();
            second["mediaRef"] = json!("shot://mc-second");
            second["processingStatus"] = json!("pending");
            second["ocr"] = Value::Null;
            c["keyframes"].as_array_mut().unwrap().push(second);
            Ok(())
        })
        .unwrap();
        let calls = std::cell::Cell::new(0);
        process_with(
            &db,
            "m1",
            &id,
            &|_| Ok(b"pixels".to_vec()),
            &|_| {
                calls.set(calls.get() + 1);
                Err("Vision unavailable".into())
            },
            &|| {},
        )
        .unwrap();
        let failed = record(&db, "m1", &id).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(failed["ocrFailures"], 1);
        assert_eq!(failed["keyframes"][1]["error"], "Vision unavailable");
        prepare_retry(&db, "m1", &id).unwrap();
        process_with(
            &db,
            "m1",
            &id,
            &|_| Ok(b"pixels".to_vec()),
            &|_| {
                calls.set(calls.get() + 1);
                Ok(result())
            },
            &|| {},
        )
        .unwrap();
        let finished = record(&db, "m1", &id).unwrap();
        assert_eq!(calls.get(), 2);
        assert_eq!(finished["ocrFailures"], 0);
        assert_eq!(finished["keyframes"][0]["ocr"], "Visible announcement");
        assert_eq!(finished["recordingComplete"], true);
    }
    #[test]
    fn paused_checkpoints_resume_without_replaying_completed_extraction() {
        let (db, id) = fixture();
        policy_change(&db, "paused", json!(true));
        process_with(
            &db,
            "m1",
            &id,
            &|_| panic!("paused work must not read media"),
            &|_| panic!("paused work must not run OCR"),
            &|| {},
        )
        .unwrap();
        assert_eq!(record(&db, "m1", &id).unwrap()["status"], "paused");
        policy_change(&db, "paused", json!(false));
        prepare_retry(&db, "m1", &id).unwrap();
        process_with(
            &db,
            "m1",
            &id,
            &|_| Ok(b"pixels".to_vec()),
            &|_| Ok(result()),
            &|| {},
        )
        .unwrap();
        process_with(
            &db,
            "m1",
            &id,
            &|_| panic!("completed frame must not be read again"),
            &|_| panic!("completed OCR must not run again"),
            &|| {},
        )
        .unwrap();
        assert_eq!(record(&db, "m1", &id).unwrap()["status"], "indexed");
    }
    #[test]
    fn retention_and_forgetting_original_image_clear_all_copied_frame_content() {
        let (db, id) = fixture();
        process_with(
            &db,
            "m1",
            &id,
            &|_| Ok(b"pixels".to_vec()),
            &|_| Ok(result()),
            &|| {},
        )
        .unwrap();
        let keys = retained_frame_keys(&db).unwrap();
        assert!(keys.contains("mc-first"));
        let plan = crate::shots::plan_sweep(
            &[("mc-first".into(), 6, now_millis())],
            &keys,
            now_millis(),
            1_000_000,
            365,
        );
        assert!(plan.delete.is_empty());
        context::forget_shot_reference(&db, "bs-original").unwrap();
        let retired = record(&db, "m1", &id).unwrap();
        assert_eq!(retired["status"], "expired");
        assert!(retired["keyframes"][0]["mediaRef"].is_null());
        assert!(retired["keyframes"][0]["ocr"].is_null());
        assert!(retired["keyframes"][0]["sourceShotRef"].is_null());
        assert!(retained_frame_keys(&db).unwrap().is_empty());
        assert_eq!(
            db.lock_conn()
                .query_row("SELECT COUNT(*) FROM mission_derivatives", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(prepare_retry(&db, "m1", &id).is_err());
    }
    #[test]
    fn excluded_recordings_disappear_from_detail_and_search() {
        let (db, id) = fixture();
        process_with(
            &db,
            "m1",
            &id,
            &|_| Ok(b"pixels".to_vec()),
            &|_| Ok(result()),
            &|| {},
        )
        .unwrap();
        policy_change(&db, "excludedHosts", json!(["source.test"]));
        assert!(readable_capture(&db, "m1", &id).is_err());
        let hits=context::dispatch(&db,context::parse_request(json!({"missionId":"m1","workspaceId":"m1","op":"searchEvidence","query":"announcement"})).unwrap()).unwrap();
        assert_eq!(hits["captures"], json!([]));
    }
    #[test]
    fn expired_recordings_never_reappear_after_resume() {
        let (db, id) = fixture();
        modify(&db, "m1", &id, |c| {
            c["expiresAt"] = json!(now_millis() - 1);
            Ok(())
        })
        .unwrap();
        let retired = context::dispatch(
            &db,
            context::parse_request(
                json!({"missionId":"m1","workspaceId":"m1","op":"getCapture","captureId":id}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(retired["status"], "expired");
        assert!(retired["keyframes"][0]["mediaRef"].is_null());
        assert!(checkpoint_ocr(&db, "m1", &id, 0, Ok(result())).is_err());
    }
    #[test]
    fn intake_is_bounded_and_coalesces_same_target_before_native_work() {
        let first = reserve_intake("intake-test", "tab1").unwrap();
        assert!(reserve_intake("intake-test", "tab1").is_none());
        let second = reserve_intake("intake-test", "tab2").unwrap();
        assert!(reserve_intake("intake-test", "tab3").is_none());
        drop(first);
        assert!(reserve_intake("intake-test", "tab3").is_some());
        drop(second);
    }
    #[test]
    fn recovery_cursor_passes_excluded_backlogs_larger_than_one_page() {
        let (db, id) = fixture();
        let source = record(&db, "m1", &id).unwrap();
        for index in 0..105 {
            let mut capture = source.clone();
            capture["id"] = json!(format!("pending-{index}"));
            capture["url"] = json!(if index == 104 {
                "https://eligible.test"
            } else {
                "https://excluded.test"
            });
            context::put(
                &db.lock_conn(),
                "m1",
                "capture",
                &format!("pending-{index}"),
                &capture,
            )
            .unwrap();
        }
        policy_change(
            &db,
            "excludedHosts",
            json!(["excluded.test", "source.test"]),
        );
        let first = pending_page(&db, 0).unwrap();
        assert_eq!(first.len(), 100);
        let second = pending_page(&db, first.last().unwrap().0).unwrap();
        assert!(second.iter().any(|(_, _, id)| id == "pending-104"));
        let capture = record(&db, "m1", "pending-104").unwrap();
        assert!(
            context::capture_scope_policy(&db, "m1", "tab1", capture["url"].as_str().unwrap())
                .is_ok()
        );
    }
    #[test]
    fn rejected_first_frame_admission_never_calls_media_store() {
        let (db, id) = fixture();
        let mut seed = record(&db, "m1", &id).unwrap();
        seed["byteSize"] = json!(2_000_000);
        let stores = std::cell::Cell::new(0);
        assert!(context::enqueue_capture_with_store(&db, "m1", seed, &|| {
            stores.set(stores.get() + 1);
            Ok(())
        })
        .is_err());
        assert_eq!(stores.get(), 0);
        policy_change(&db, "paused", json!(true));
        assert!(context::enqueue_capture_with_store(
            &db,
            "m1",
            record(&db, "m1", &id).unwrap(),
            &|| {
                stores.set(stores.get() + 1);
                Ok(())
            }
        )
        .is_err());
        assert_eq!(stores.get(), 0);
    }
    #[test]
    fn identical_first_pixels_preserve_distinct_recording_events_and_legacy_idempotency() {
        let (db, first_id) = fixture();
        let first = record(&db, "m1", &first_id).unwrap();
        let pass_cooldown = || {
            db.lock_conn().execute(
                "UPDATE mission_records SET created_at=?1 WHERE mission_id='m1' AND kind='capture'",
                [now_millis() - COOLDOWN_MS - 1],
            ).unwrap();
        };

        pass_cooldown();
        let later = context::enqueue_capture(&db, "m1", first.clone()).unwrap();
        assert_ne!(later["id"], first["id"]);
        assert_eq!(later["url"], first["url"]);
        assert_eq!(later["contentHash"], first["contentHash"]);

        pass_cooldown();
        let mut other_source = first.clone();
        other_source["url"] = json!("https://other-source.test");
        other_source["keyframes"][0]["url"] = other_source["url"].clone();
        let other = context::enqueue_capture(&db, "m1", other_source).unwrap();
        assert_ne!(other["id"], first["id"]);
        assert_ne!(other["id"], later["id"]);
        assert_eq!(other["url"], "https://other-source.test");
        assert_eq!(other["contentHash"], first["contentHash"]);
        assert_eq!(record(&db, "m1", &first_id).unwrap()["url"], "https://source.test");

        let mut legacy_seed = first;
        legacy_seed["adapter"] = json!("redline-shots-v1");
        legacy_seed["contentHash"] = json!(crate::ledger::sha256_hex(b"legacy pixels"));
        legacy_seed["mediaRef"] = json!("shot://legacy-shot");
        legacy_seed["keyframes"][0]["mediaRef"] = legacy_seed["mediaRef"].clone();
        legacy_seed["keyframes"][0]["contentHash"] = legacy_seed["contentHash"].clone();
        let legacy = context::enqueue_capture(&db, "m1", legacy_seed.clone()).unwrap();
        let replay = context::enqueue_capture(&db, "m1", legacy_seed).unwrap();
        assert_eq!(replay["id"], legacy["id"]);
    }
    #[test]
    fn changed_document_revision_or_url_cannot_enter_a_recording() {
        let before = json!({"url":"https://one.test","documentId":"1","revision":"1:0"});
        assert!(stable_frame(&before, &before));
        for (field, value) in [
            ("url", "https://two.test"),
            ("documentId", "2"),
            ("revision", "1:1"),
        ] {
            let mut after = before.clone();
            after[field] = json!(value);
            assert!(!stable_frame(&before, &after));
        }
    }
    #[test]
    fn byte_limits_preserve_unicode_boundaries() {
        assert_eq!(bounded("ééé", 5), "éé");
    }
}

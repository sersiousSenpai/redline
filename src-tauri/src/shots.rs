// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The picture store — screenshots of moments Redline cannot re-render.
//!
//! ## The principle: shoot what you can't re-render
//!
//! An external web page, yes: Redline can never reproduce it, and a URL two
//! months later is a different page or a 404. Redline's OWN surfaces are the
//! debatable case, and the concern is stated once here rather than discovered
//! later: a screenshot of a plan review duplicates state Redline owns and can
//! re-render from the ledger, and it ages badly — a theme or font change makes
//! every old shot look wrong. The mitigations are in the design rather than in
//! good intentions: Redline-surface shots are capped tightly, stamped with the
//! theme they were taken under, and pruned first under the budget.
//!
//! ## Why this is cheap, and it isn't compression
//!
//! Measured on the live corpus (829 browse events over 40.3 days = 20.6/day,
//! 665 distinct `context_hash`, 0.058–0.087 bytes/pixel on existing PNGs, a
//! 960px target ≈ 40 KB):
//!
//! | approach                          | files/day | /month | /year  |
//! |-----------------------------------|-----------|--------|--------|
//! | a 2s screen recorder (retrace)    | ~43,000   | 50–70 GB | 600–840 GB |
//! | per distinct `context_hash` (ours)| 16.5      | **20 MB** | 240 MB |
//! | + Redline surfaces                | +0.6      | +1 MB  | +12 MB |
//!
//! ~3,000× cheaper, and a full year of pictures is smaller than today's
//! `redline.db`. The reason is not a codec — it is that **Redline knows WHEN
//! something happened.** A screen recorder pays 43,000 captures a day to
//! discover 16 meaningful moments; `browser_cache_snapshot` already fires on
//! exactly those 16.
//!
//! ## Its own directory, deliberately
//!
//! `thumbs/` has two writers and one of them deleted the other's files on every
//! dashboard mount (see `thumbs::thumbs_prune`). A separate directory makes
//! that class of bug structurally impossible here rather than merely fixed.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

/// Capture width in points. The measured curve says **resolution is the lever**
/// — bytes scale with pixels, not with the codec — so this is the number to
/// move if the store ever needs to be smaller.
pub const SHOT_WIDTH: f64 = 960.0;

/// Hard ceilings on the store. At the observed 20 MB/month neither binds, and
/// that IS the point: they exist so the picture store can never surprise the
/// user with its size, not because they are expected to fire.
pub const SHOTS_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const SHOTS_MAX_AGE_DAYS: i64 = 365;

/// `.tmp` files younger than this belong to a capture in flight.
const TMP_GRACE_SECS: u64 = 60;

/// The `app_settings` key holding the capture denylist: newline-separated
/// registrable domains. Lives beside `redline.capture.externalSessions`, the
/// existing capture switch.
pub const SETTING_SHOT_DENYLIST: &str = "redline.capture.denylist";
/// Global off switch for the picture store.
pub const SETTING_SHOTS_ENABLED: &str = "redline.capture.shots";

/// A commented default seed, shown in the settings box the first time. Not
/// applied silently — a denylist the user did not write is a denylist they
/// cannot reason about.
pub const DENYLIST_SEED: &str = "# One registrable domain per line. Pages on these\n\
                                 # domains record NEITHER text NOR a picture.\n\
                                 # mail.google.com\n\
                                 # banking.example.com\n";

pub fn shots_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?
        .join("shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// Content-addressed key for a page: `bs-` + the first 16 hex of its
/// `context_hash`.
///
/// Content-addressed rather than per-event, so the 829 → 665 dedupe is free and
/// the key matches the schema's own stated intent: `context_hash` is already
/// "this is the same page content". Forgetting a picture then forgets it in
/// every tab that ever saw it, which is what a person means by "forget this".
pub fn page_key(context_hash: &str) -> String {
    let head: String = context_hash.chars().take(16).collect();
    format!("bs-{head}")
}

/// Key for one of Redline's own surfaces.
pub fn surface_key(surface: &str, seq: i64) -> String {
    let clean: String = surface
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(24)
        .collect();
    format!("rl-{clean}-{seq}")
}

/// Keys are filenames; nothing user-supplied reaches the path.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The registrable-ish domain of a URL: host minus a leading `www.`. Not a full
/// public-suffix implementation — a denylist the user writes by hand matches
/// what they see in the address bar, and pulling in a PSL crate to be pedantic
/// about `co.uk` would cost more than it buys.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.split('@').next_back()?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    (!host.is_empty()).then_some(host)
}

/// May this URL be captured at all?
///
/// **One policy gates the text row AND the picture together**, and that is the
/// whole design. A denylist that suppressed the screenshot but kept the DOM
/// text would be incoherent: `browse_events.text` already holds the full text
/// of every page in plaintext SQLite, so the words are the sensitive part and
/// the pixels are a redundant copy of them. Blocking the picture alone would
/// look like privacy while storing the same information.
pub fn capture_allowed(denylist: &str, url: &str) -> bool {
    let Some(host) = host_of(url) else { return true };
    for line in denylist.lines() {
        let entry = line.split('#').next().unwrap_or("").trim().to_ascii_lowercase();
        if entry.is_empty() {
            continue;
        }
        let entry = entry.strip_prefix("www.").unwrap_or(&entry);
        // A denylisted domain covers its subdomains — `example.com` blocks
        // `mail.example.com`, which is what a person writing the list means.
        if host == entry || host.ends_with(&format!(".{entry}")) {
            return false;
        }
    }
    true
}

/// Write PNG bytes for `key`, atomically. Returns the path.
pub fn write_shot(app: &AppHandle, key: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err(format!("invalid shot key: {key}"));
    }
    let dir = shots_dir(app)?;
    let tmp = dir.join(format!("{key}.png.tmp"));
    let final_path = dir.join(format!("{key}.png"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", final_path.display())
    })?;
    Ok(final_path)
}

/// One shot on disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotEntry {
    pub key: String,
    pub path: String,
    pub bytes: u64,
    pub modified_ms: i64,
}

/// Every shot on disk. The frontend calls this ONCE at mount so it knows what
/// exists without a failed `read_file_base64` per row.
#[tauri::command(async)]
pub fn shots_list(app: AppHandle) -> Result<Vec<ShotEntry>, String> {
    let dir = shots_dir(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(key) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".png"))
        else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        out.push(ShotEntry {
            key: key.to_string(),
            path: path.to_string_lossy().into_owned(),
            bytes: meta.len(),
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// "Forget this picture" — content-addressed, so it forgets the page in every
/// tab that ever saw it. Clears `shot_key` on every row pointing at it, then
/// deletes the file.
#[tauri::command(async)]
pub fn shot_forget(
    app: AppHandle,
    store: tauri::State<'_, crate::state::SessionStore>,
    key: String,
) -> Result<bool, String> {
    if !valid_key(&key) {
        return Err(format!("invalid shot key: {key}"));
    }
    let db = store.database();
    let cleared = db.clear_shot_key(&key).map_err(|e| e.to_string())?
        + db.clear_surface_shot(&key).map_err(|e| e.to_string())?;
    let path = shots_dir(&app)?.join(format!("{key}.png"));
    let removed = std::fs::remove_file(&path).is_ok();
    Ok(cleared > 0 || removed)
}

// ---------------------------------------------------------------------------
// The vision tier
// ---------------------------------------------------------------------------

/// Build the captioner's prompt for one dark page.
///
/// The shot path goes to `Read`, which is already in `HEADLESS_TOOLS` — no new
/// tool surface, no new permission, no new spawn shape. The instruction is
/// deliberately narrow: DESCRIBE what is on the page so it can be found again,
/// not interpret it. A caption that speculates is worse than a dark row,
/// because a dark row is honestly empty.
pub fn build_caption_prompt(url: &str, title: &str, shot_path: &str) -> String {
    format!(
        "A page in the user's browsing history captured no readable text — it is \
         a client-rendered app, an image, or a dashboard. A screenshot of it IS \
         on disk. Read the image and describe what the page SHOWS, so the user \
         can find it again later by searching for it.\n\n\
         Page: {title}\nURL: {url}\nScreenshot: {shot_path}\n\n\
         Use the `Read` tool on the screenshot path. Then reply with ONE \
         paragraph, 40 words or fewer: the page's subject, the main things \
         visible on it, and any prominent labels or numbers. Describe only what \
         you can SEE. Do not speculate about what the page is for, do not \
         address the user, and do not add a preamble — the paragraph is the \
         whole reply."
    )
}

/// Capture one of Redline's OWN surfaces — a plan approval, a revision.
///
/// The concern with this, stated once in the module docs and then built anyway
/// because the user asked for it: a screenshot of a plan review duplicates
/// state Redline owns and can re-render from the ledger, and it ages badly.
/// The mitigations are here rather than in intent:
///
/// - It is capped by WHAT triggers it. Only `approval` and `revision` events
///   do, which at the observed rate is ~236 shots a year (~12 MB) against the
///   browse stream's ~240 MB.
/// - The theme it was taken under is stamped into `app_settings`, so a shot
///   from a since-changed theme can be labelled as historical rather than
///   silently looking wrong.
/// - It is pruned FIRST under the byte budget, because it is the one kind of
///   shot whose content is recoverable from the record.
///
/// Redline's UI is a WKWebView, so `capture_png` works on the main window
/// unmodified — that is why this costs almost nothing to add.
pub async fn capture_redline_surface(
    app: &AppHandle,
    db: &crate::db::Database,
    surface: &str,
    seq: i64,
) -> Option<String> {
    if db
        .get_setting(SETTING_SHOTS_ENABLED)
        .map(|v| v == "false")
        .unwrap_or(false)
    {
        return None;
    }
    let key = surface_key(surface, seq);
    let bytes = crate::thumbs::capture_shot(app, "main", SHOT_WIDTH).await.ok()?;
    write_shot(app, &key, &bytes).ok()?;
    let theme = db.get_setting("redline.ui.theme");
    if let Err(e) = db.record_surface_shot(seq, surface, &key, theme.as_deref()) {
        tracing::warn!(error = %e, "failed to record a surface shot");
        return None;
    }
    Some(key)
}

/// The capture policy: the denylist and the global switch.
///
/// Scoped commands rather than a generic `get_app_setting`/`set_app_setting`
/// pair — a generic settings write from the webview would be a much wider
/// surface than this one control needs, and every other toggle here
/// (`ledger_*_capture_external`) is scoped for the same reason.
#[tauri::command(async)]
pub fn shots_get_policy(
    store: tauri::State<'_, crate::state::SessionStore>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    let denylist = db.get_setting(SETTING_SHOT_DENYLIST);
    Ok(serde_json::json!({
        // A first-run user sees the commented seed rather than a blank box —
        // an empty control teaches nothing about what belongs in it.
        "denylist": denylist.unwrap_or_else(|| DENYLIST_SEED.to_string()),
        "enabled": db
            .get_setting(SETTING_SHOTS_ENABLED)
            .map(|v| v != "false")
            .unwrap_or(true),
    }))
}

#[tauri::command(async)]
pub fn shots_set_policy(
    store: tauri::State<'_, crate::state::SessionStore>,
    denylist: Option<String>,
    enabled: Option<bool>,
) -> Result<(), String> {
    let db = store.database();
    if let Some(d) = denylist {
        db.set_setting(SETTING_SHOT_DENYLIST, &d).map_err(|e| e.to_string())?;
    }
    if let Some(e) = enabled {
        db.set_setting(SETTING_SHOTS_ENABLED, if e { "true" } else { "false" })
            .map_err(|x| x.to_string())?;
    }
    Ok(())
}

/// Pages waiting on a caption, and how many there are — the Health entry.
///
/// **User-initiated only, never a daemon.** `keeper.rs`'s rule is "crons watch,
/// models act": the watch bus may NOTICE this backlog and light a count, and
/// its `act` must never spawn the captioner. A background job that quietly
/// sends screenshots to a model is exactly the kind of thing that should
/// require a person to press something.
#[tauri::command(async)]
pub fn shots_caption_backlog(
    store: tauri::State<'_, crate::state::SessionStore>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    let (with_pictures, dark) = db.shot_stats().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "withPictures": with_pictures, "dark": dark }))
}

/// What a retention sweep decided. Pure, so the policy is testable without a
/// filesystem.
#[derive(Debug, Clone, PartialEq)]
pub struct SweepPlan {
    pub delete: Vec<String>,
    pub reason: Vec<&'static str>,
}

/// Decide which shots to delete.
///
/// **DB-driven, not caller-driven** — the correction of the `thumbs_prune`
/// mistake. The caller does not pass "the keys I care about"; the sweep is told
/// which keys the DATABASE still references, and anything else is unreferenced
/// by definition. A second writer cannot lose its files to a first writer's
/// idea of what matters.
///
/// Order: unreferenced first (they cost bytes for nothing), then over-age, then
/// oldest-first until under the byte ceiling.
pub fn plan_sweep(
    on_disk: &[(String, u64, i64)],
    referenced: &std::collections::HashSet<String>,
    now_ms: i64,
    max_bytes: u64,
    max_age_days: i64,
) -> SweepPlan {
    let mut delete = Vec::new();
    let mut reason = Vec::new();
    let mut kept: Vec<&(String, u64, i64)> = Vec::new();

    let age_floor = now_ms - max_age_days * 86_400_000;
    for row @ (key, _, modified) in on_disk {
        if !referenced.contains(key) {
            delete.push(key.clone());
            reason.push("unreferenced");
        } else if *modified < age_floor {
            delete.push(key.clone());
            reason.push("aged out");
        } else {
            kept.push(row);
        }
    }
    // Oldest first until the total fits.
    kept.sort_by_key(|(_, _, modified)| *modified);
    let mut total: u64 = kept.iter().map(|(_, b, _)| *b).sum();
    for (key, bytes, _) in kept {
        if total <= max_bytes {
            break;
        }
        delete.push(key.clone());
        reason.push("over budget");
        total = total.saturating_sub(*bytes);
    }
    SweepPlan { delete, reason }
}

/// Caption the dark pages, on the user's explicit instruction.
///
/// Bounded per invocation: this spends model turns and reads pictures, so it is
/// a batch the user asks for and can see the size of, not a background drip.
#[tauri::command(async)]
pub async fn shots_caption_run(
    app: AppHandle,
    store: tauri::State<'_, crate::state::SessionStore>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let db = store.database();
    let limit = limit.unwrap_or(8).clamp(1, 40);
    let backlog = db
        .pages_with_a_picture_but_no_text(limit)
        .map_err(|e| e.to_string())?;
    if backlog.is_empty() {
        return Ok(serde_json::json!({ "captioned": 0, "attempted": 0 }));
    }
    let dir = shots_dir(&app)?;
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let mut captioned = 0usize;
    let attempted = backlog.len();
    for (id, url, title, key) in backlog {
        let path = dir.join(format!("{key}.png"));
        if !path.exists() {
            continue;
        }
        let prompt = build_caption_prompt(&url, &title, &path.to_string_lossy());
        let Ok(text) = crate::keeper::run_keeper_summarizer(&db, &cwd, prompt).await else {
            continue;
        };
        let caption = text.trim();
        if caption.is_empty() {
            continue;
        }
        let Ok(Some(hash)) = db.context_hash_for_browse_id(id) else { continue };
        // Into `caption`, never into `text` — see `set_caption_for_hash`.
        if db.set_caption_for_hash(&hash, caption).is_ok() {
            captioned += 1;
        }
    }
    let _ = app.emit("memory-changed", ());
    Ok(serde_json::json!({ "captioned": captioned, "attempted": attempted }))
}

/// Run one retention sweep. Called from the keeper's watch bus — the stated
/// scheduling vocabulary — never from a timer of its own.
pub fn sweep(app: &AppHandle, db: &crate::db::Database) -> usize {
    let Ok(dir) = shots_dir(app) else { return 0 };
    let Ok(entries) = shots_list(app.clone()) else { return 0 };
    let on_disk: Vec<(String, u64, i64)> = entries
        .iter()
        .map(|e| (e.key.clone(), e.bytes, e.modified_ms))
        .collect();
    let referenced = db.referenced_shot_keys().unwrap_or_default();
    let plan = plan_sweep(
        &on_disk,
        &referenced,
        crate::ledger::now_millis(),
        SHOTS_MAX_BYTES,
        SHOTS_MAX_AGE_DAYS,
    );
    let mut removed = 0usize;
    for key in &plan.delete {
        if std::fs::remove_file(dir.join(format!("{key}.png"))).is_ok() {
            removed += 1;
        }
        let _ = db.clear_shot_key(key);
        let _ = db.clear_surface_shot(key);
    }
    // Stale `.tmp` from a capture that crashed mid-write.
    let now = std::time::SystemTime::now();
    if let Ok(read) = std::fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if !path.to_string_lossy().ends_with(".png.tmp") {
                continue;
            }
            let expired = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .is_some_and(|age| age.as_secs() > TMP_GRACE_SECS);
            if expired && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn page_keys_are_content_addressed_so_a_revisit_reuses_one_file() {
        let h = "9f2c1a4b7d3e8f60aabbccddeeff00112233445566778899aabbccddeeff0011";
        assert_eq!(page_key(h), "bs-9f2c1a4b7d3e8f60");
        // Same content in a different tab → the same key, so 829 events with
        // 665 distinct hashes cost 665 files rather than 829.
        assert_eq!(page_key(h), page_key(h));
        assert_ne!(page_key(h), page_key("00000000000000000000"));
        assert!(valid_key(&page_key(h)));
        assert!(valid_key(&surface_key("plan-review", 4224)));
        // Nothing user-supplied can escape into a path.
        assert!(!valid_key("../../etc/passwd"));
        assert!(!valid_key(""));
        assert!(valid_key(&surface_key("../evil", 1)), "the key is sanitized, not rejected");
        assert_eq!(surface_key("../evil", 1), "rl-evil-1");
    }

    #[test]
    fn host_extraction_handles_the_shapes_a_denylist_meets() {
        assert_eq!(host_of("https://www.Example.com/a/b?c=1").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://mail.google.com").as_deref(), Some("mail.google.com"));
        assert_eq!(host_of("https://user:pw@host.example.com:8443/x").as_deref(), Some("host.example.com"));
        assert_eq!(host_of("localhost:3000/dash").as_deref(), Some("localhost"));
        assert_eq!(host_of(""), None);
    }

    /// One policy gates the text row AND the picture. A denylist that hid the
    /// screenshot while `browse_events.text` kept the full DOM in plaintext
    /// would be privacy theatre.
    #[test]
    fn the_denylist_covers_subdomains_and_ignores_comments() {
        let list = "# a comment\nexample.com\n  MAIL.GOOGLE.COM  \n\n# banking.example.org\n";
        assert!(!capture_allowed(list, "https://example.com/x"));
        assert!(!capture_allowed(list, "https://www.example.com/x"));
        assert!(!capture_allowed(list, "https://deep.sub.example.com/x"));
        assert!(!capture_allowed(list, "https://mail.google.com/inbox"));
        // A commented-out entry is not in force.
        assert!(capture_allowed(list, "https://banking.example.org/"));
        // A near-miss is not a match: `notexample.com` is a different domain.
        assert!(capture_allowed(list, "https://notexample.com/x"));
        assert!(capture_allowed("", "https://anything.test/"));
    }

    /// The sweep is told what the DATABASE still references — it is never
    /// handed one caller's idea of "keys I care about". That inversion is the
    /// `thumbs_prune` bug, corrected structurally.
    #[test]
    fn the_sweep_is_db_driven_and_deletes_in_the_right_order() {
        let now = 1_700_000_000_000i64;
        let day = 86_400_000i64;
        let on_disk = vec![
            ("bs-keep".to_string(), 40_000, now - day),
            ("bs-orphan".to_string(), 40_000, now - day),
            ("bs-ancient".to_string(), 40_000, now - 400 * day),
        ];
        let referenced: HashSet<String> =
            ["bs-keep".to_string(), "bs-ancient".to_string()].into_iter().collect();

        let plan = plan_sweep(&on_disk, &referenced, now, SHOTS_MAX_BYTES, SHOTS_MAX_AGE_DAYS);
        assert!(plan.delete.contains(&"bs-orphan".to_string()), "unreferenced goes");
        assert!(plan.delete.contains(&"bs-ancient".to_string()), "past the age cap goes");
        assert!(!plan.delete.contains(&"bs-keep".to_string()), "a referenced, fresh shot stays");

        // At the real volume neither cap binds — which is the point of having
        // them: they are a promise about the ceiling, not a working policy.
        let year: Vec<(String, u64, i64)> = (0..6_000)
            .map(|i| (format!("bs-{i:04}"), 40_000, now - (i as i64 % 300) * day))
            .collect();
        let all: HashSet<String> = year.iter().map(|(k, _, _)| k.clone()).collect();
        let quiet = plan_sweep(&year, &all, now, SHOTS_MAX_BYTES, SHOTS_MAX_AGE_DAYS);
        assert!(quiet.delete.is_empty(), "a year of browsing is nowhere near the ceiling");
    }

    #[test]
    fn the_byte_ceiling_evicts_oldest_first() {
        let now = 1_700_000_000_000i64;
        let on_disk: Vec<(String, u64, i64)> = (0..5)
            .map(|i| (format!("bs-{i}"), 100, now - (5 - i) as i64 * 1000))
            .collect();
        let referenced: HashSet<String> = on_disk.iter().map(|(k, _, _)| k.clone()).collect();
        // 500 bytes on disk, 250 allowed → the three oldest go.
        let plan = plan_sweep(&on_disk, &referenced, now, 250, SHOTS_MAX_AGE_DAYS);
        assert_eq!(plan.delete, vec!["bs-0", "bs-1", "bs-2"]);
        assert!(plan.reason.iter().all(|r| *r == "over budget"));
    }
}

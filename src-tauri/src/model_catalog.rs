// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Picker metadata, independent of the immutable binary capability caches.
//! No prompt, thread, or inference request is sent by discovery.

use crate::codex_app_server::CodexModel;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const FRESH_FOR: Duration = Duration::from_secs(30 * 60);
const MANUAL_COOLDOWN: Duration = Duration::from_secs(10);
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub models: Vec<CodexModel>,
    /// A successful harness check is not a guarantee of upstream availability.
    pub checked_at: Option<u64>,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Default)]
struct Entry {
    snapshot: Option<Snapshot>,
    attempted: Option<Instant>,
    next_check: Option<Instant>,
    failures: u32,
}

impl Entry {
    fn reusable(&self, now: Instant, force: bool) -> bool {
        self.snapshot.is_some()
            && (self
                .attempted
                .is_some_and(|at| now.saturating_duration_since(at) < MANUAL_COOLDOWN)
                || (!force && self.next_check.is_some_and(|at| now < at)))
    }

    fn finish(
        &mut self,
        result: Result<Vec<CodexModel>, String>,
        now: Instant,
        checked_at: u64,
    ) -> Snapshot {
        self.attempted = Some(now);
        match result {
            Ok(models) if !models.is_empty() => {
                self.failures = 0;
                self.next_check = Some(now + FRESH_FOR);
                self.snapshot = Some(Snapshot {
                    models,
                    checked_at: Some(checked_at),
                    source: "harness".into(),
                    warning: None,
                });
            }
            _ => {
                self.failures = self.failures.saturating_add(1);
                let seconds = (30_u64 * 2_u64.pow(self.failures.min(6) - 1)).min(15 * 60);
                self.next_check = Some(now + Duration::from_secs(seconds));
                let previous = self.snapshot.take();
                self.snapshot = Some(Snapshot {
                    warning: Some(
                        if previous.as_ref().is_some_and(|s| s.checked_at.is_some()) {
                            "Couldn't refresh. Showing the last checked models."
                        } else {
                            "Model list unavailable. You can still use the harness default."
                        }
                        .into(),
                    ),
                    ..previous.unwrap_or(Snapshot {
                        models: vec![],
                        checked_at: None,
                        source: "unavailable".into(),
                        warning: None,
                    })
                });
            }
        }
        self.snapshot.clone().unwrap()
    }
}

type SharedEntry = Arc<tokio::sync::Mutex<Entry>>;
static CACHE: OnceLock<Mutex<HashMap<String, SharedEntry>>> = OnceLock::new();

fn stamp(path: &std::path::Path) -> String {
    let meta = path.metadata().ok();
    format!(
        "{}:{:?}:{}",
        path.display(),
        meta.as_ref().and_then(|m| m.modified().ok()),
        meta.map_or(0, |m| m.len())
    )
}

/// Only filesystem metadata is inspected. Credentials never enter this cache.
/// Keychain-only account changes are bounded by the TTL or an explicit refresh.
fn scope(backend: &str, bin: &str) -> String {
    let mut key = format!("{backend}|{}", stamp(std::path::Path::new(bin)));
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let root = match backend {
        "claude-code" => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude")),
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex")),
        // These adapters do not expose a stable account/config revision. Do
        // not guess private credential locations; use TTL/manual refresh.
        _ => return key,
    };
    let files: &[&str] = match backend {
        "claude-code" => &["settings.json", ".credentials.json"],
        "codex" => &["config.toml", "auth.json"],
        _ => &[],
    };
    key.push('|');
    key.push_str(&root.to_string_lossy());
    for file in files {
        key.push('|');
        key.push_str(&stamp(&root.join(file)));
    }
    key
}

pub async fn snapshot(backend: String, force: bool) -> Result<Snapshot, String> {
    let backend_for_bin = backend.clone();
    let bin = tokio::task::spawn_blocking(move || match backend_for_bin.as_str() {
        "claude-code" => Ok(crate::claude_proc::resolve_claude_bin()),
        "codex" => Ok(crate::codex_app_server::resolve_codex_bin()),
        "cursor" | "antigravity" => crate::plan_provider::resolve(&backend_for_bin).map(|b| b.path),
        _ => Err("Unknown planning harness".into()),
    })
    .await
    .map_err(|e| e.to_string())??;
    let key = scope(&backend, &bin);
    let entry = {
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Bound growth as installations/settings change. In-flight entries stay
        // alive through Arc and cannot overwrite a replacement scope's result.
        if !cache.contains_key(&key) {
            cache.retain(|k, _| !k.starts_with(&format!("{backend}|")));
        }
        cache.entry(key).or_default().clone()
    };
    Ok(refresh(entry, force, || async move {
        match backend.as_str() {
            "claude-code" => claude_live(&bin).await,
            "codex" => tokio::time::timeout(Duration::from_secs(15), codex_live(&bin))
                .await
                .unwrap_or_else(|_| Err("Codex model discovery timed out".into())),
            _ => tokio::task::spawn_blocking(move || {
                crate::plan_provider::model_catalog_for_bin(&backend, &bin)
            })
            .await
            .map_err(|e| e.to_string())?,
        }
    })
    .await)
}

async fn refresh<F, Fut>(entry: SharedEntry, force: bool, probe: F) -> Snapshot
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<CodexModel>, String>>,
{
    let mut entry = entry.lock().await;
    if entry.reusable(Instant::now(), force) {
        return entry.snapshot.clone().unwrap();
    }
    let result = probe().await;
    entry.finish(
        result,
        Instant::now(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    )
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse future model ids verbatim; neither families nor effort names are enumerated.
fn claude_rows(response: &Value) -> Result<Vec<CodexModel>, String> {
    let rows = response["models"]
        .as_array()
        .ok_or("Claude returned no model catalog")?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let slug = row["value"].as_str()?.trim();
            if slug.is_empty() || slug == "default" {
                return None;
            }
            Some(CodexModel {
                slug: slug.into(),
                display_name: row["displayName"].as_str().unwrap_or(slug).into(),
                description: row["description"].as_str().unwrap_or_default().into(),
                default_effort: row["defaultEffort"].as_str().map(str::to_owned),
                efforts: if row["supportsEffort"] == false {
                    vec![]
                } else {
                    strings(&row["supportedEffortLevels"])
                },
            })
        })
        .collect())
}

async fn claude_live(bin: &str) -> Result<Vec<CodexModel>, String> {
    // The Agent SDK initialize handshake supplies supportedModels(). Never send
    // a user message. Disable hooks/MCP and persistence; retain normal auth.
    let mut command = crate::claude_proc::claude_command(bin);
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--settings",
        "{\"disableAllHooks\":true}",
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        command.current_dir(home);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start Claude model discovery")?;
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        let mut stdin = child.stdin.take().ok_or("Claude metadata input unavailable")?;
        let mut lines = BufReader::new(child.stdout.take().ok_or("Claude metadata output unavailable")?.take(MAX_BYTES)).lines();
        stdin.write_all(b"{\"type\":\"control_request\",\"request_id\":\"redline-models\",\"request\":{\"subtype\":\"initialize\",\"hooks\":{}}}\n").await.map_err(|_| "Claude metadata input closed")?;
        while let Some(line) = lines.next_line().await.map_err(|_| "Claude metadata output failed")? {
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue; };
            if event["type"] == "control_response" && event["response"]["request_id"] == "redline-models" {
                if event["response"]["subtype"] != "success" { return Err("Claude model discovery was rejected".into()); }
                return claude_rows(&event["response"]["response"]);
            }
        }
        Err("Claude returned no model catalog".into())
    }).await.map_err(|_| "Claude model discovery timed out".to_string()).and_then(|r| r);
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

fn codex_rows(page: &Value) -> Result<Vec<CodexModel>, String> {
    let rows = page["data"]
        .as_array()
        .ok_or("Codex returned no model catalog")?;
    Ok(rows
        .iter()
        .filter(|row| row["hidden"] != true)
        .filter_map(|row| {
            let slug = row["model"].as_str().or_else(|| row["id"].as_str())?.trim();
            if slug.is_empty() {
                return None;
            }
            Some(CodexModel {
                slug: slug.into(),
                display_name: row["displayName"].as_str().unwrap_or(slug).into(),
                description: row["description"].as_str().unwrap_or_default().into(),
                default_effort: row["defaultReasoningEffort"].as_str().map(str::to_owned),
                efforts: row["supportedReasoningEfforts"]
                    .as_array()
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(|level| {
                                level["reasoningEffort"].as_str().map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

async fn codex_live(bin: &str) -> Result<Vec<CodexModel>, String> {
    let mut models = vec![];
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    // Follow pagination without accepting an unbounded or looping provider.
    for _ in 0..20 {
        let page = crate::codex_app_server::inspect_request(
            bin,
            "model/list",
            json!({"limit":100,"includeHidden":false,"cursor":cursor}),
        )
        .await?;
        models.extend(codex_rows(&page)?);
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(models);
        }
        let next = cursor
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Invalid model catalog cursor")?;
        if !seen.insert(next.to_owned()) {
            return Err("Model catalog pagination loop".into());
        }
    }
    Err("Model catalog exceeded the page limit".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn model() -> CodexModel {
        CodexModel {
            slug: "future-model".into(),
            display_name: "Future".into(),
            description: "".into(),
            default_effort: None,
            efforts: vec!["future-effort".into()],
        }
    }
    #[test]
    fn freshness_manual_cooldown_and_failure_backoff() {
        let now = Instant::now();
        let mut entry = Entry::default();
        assert!(!entry.reusable(now, false));
        entry.finish(Ok(vec![model()]), now, 123);
        assert!(entry.reusable(now + Duration::from_secs(1), true));
        assert!(!entry.reusable(now + Duration::from_secs(11), true));
        assert!(entry.reusable(now + FRESH_FOR - Duration::from_secs(1), false));
        assert!(!entry.reusable(now + FRESH_FOR, false));
        let failed_at = now + FRESH_FOR;
        let failed = entry.finish(Err("offline".into()), failed_at, 999);
        assert_eq!(failed.models, vec![model()]);
        assert_eq!(failed.checked_at, Some(123));
        assert!(failed.warning.is_some());
        assert!(entry.reusable(failed_at + Duration::from_secs(29), false));
        assert!(!entry.reusable(failed_at + Duration::from_secs(30), false));
        entry.finish(
            Err("offline".into()),
            failed_at + Duration::from_secs(30),
            999,
        );
        assert!(entry.reusable(failed_at + Duration::from_secs(89), false));
        let recovered = entry.finish(Ok(vec![model()]), failed_at + Duration::from_secs(90), 1000);
        assert_eq!(recovered.checked_at, Some(1000));
        assert!(recovered.warning.is_none());
        assert_eq!(entry.failures, 0);
    }
    #[test]
    fn empty_or_invalid_catalog_does_not_erase_last_good() {
        let mut entry = Entry::default();
        entry.finish(Ok(vec![model()]), Instant::now(), 123);
        assert_eq!(
            entry.finish(Ok(vec![]), Instant::now(), 999).models,
            vec![model()]
        );
        assert!(claude_rows(&json!({})).is_err());
        assert!(codex_rows(&json!({})).is_err());
    }
    #[tokio::test]
    async fn concurrent_and_repeated_requests_share_one_probe() {
        let entry = SharedEntry::default();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let probe = || async {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(vec![model()])
        };
        let (a, b) = tokio::join!(
            refresh(entry.clone(), false, probe),
            refresh(entry.clone(), true, probe)
        );
        let c = refresh(entry, false, probe).await;
        assert_eq!(a.models, b.models);
        assert_eq!(b.models, c.models);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[test]
    fn claude_uses_harness_labels_and_per_model_efforts_without_version_rules() {
        let rows = claude_rows(&json!({"models":[
            {"value":"default","displayName":"Default"},
            {"value":"opus","displayName":"Opus next","supportedEffortLevels":["low","future-effort"]},
            {"value":"claude-new-family-99","displayName":"New family","supportsEffort":false,"supportedEffortLevels":["high"]},
            {"value":"haiku","displayName":"Haiku"}
        ]})).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].display_name, "Opus next");
        assert_eq!(rows[0].efforts, ["low", "future-effort"]);
        assert_eq!(rows[1].slug, "claude-new-family-99");
        assert!(rows[1].efforts.is_empty());
        assert!(rows[2].efforts.is_empty());
    }
    #[test]
    fn codex_uses_protocol_capabilities_and_hides_internal_models() {
        let rows = codex_rows(&json!({"data":[
            {"id":"row-id","model":"future-model","displayName":"Future", "defaultReasoningEffort":"future-effort","supportedReasoningEfforts":[{"reasoningEffort":"future-effort"}]},
            {"id":"hidden","hidden":true}
        ]})).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "future-model");
        assert_eq!(rows[0].default_effort.as_deref(), Some("future-effort"));
        assert_eq!(rows[0].efforts, ["future-effort"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_handshake_needs_no_user_prompt() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("redline-model-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        // Answer only the exact initialization request. A prompt, changed
        // protocol, or unexpected tool request produces no catalog.
        std::fs::write(&bin, r##"#!/bin/sh
IFS= read -r request
if [ "$request" = '{"type":"control_request","request_id":"redline-models","request":{"subtype":"initialize","hooks":{}}}' ]; then
  printf '%s\n' '{"type":"control_response","response":{"request_id":"redline-models","subtype":"success","response":{"models":[{"value":"new-model","displayName":"New model","supportedEffortLevels":["low"]}]}}}'
fi
"##).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let rows = claude_live(bin.to_str().unwrap()).await.unwrap();
        assert_eq!(rows[0].slug, "new-model");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    #[ignore = "Explicit local metadata smoke check; requires installed/authenticated harnesses"]
    async fn installed_harness_metadata_smoke() {
        let claude = claude_live(&crate::claude_proc::resolve_claude_bin())
            .await
            .unwrap();
        let codex = codex_live(&crate::codex_app_server::resolve_codex_bin())
            .await
            .unwrap();
        assert!(!claude.is_empty());
        assert!(!codex.is_empty());
        println!(
            "Claude picker: {:?}",
            claude
                .iter()
                .map(|row| &row.display_name)
                .collect::<Vec<_>>()
        );
        println!("Codex picker: {} models", codex.len());
    }
}

// SPDX-License-Identifier: Apache-2.0
//! Local intent routing and measured execution provenance. Derived labels are
//! separate from the immutable memory lake and never become user decisions.
use crate::{db::Database, meter::TurnMeter, SurfaceInfo};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Intent {
    Navigate { url: String },
    Recall,
    Plan,
    Discuss,
}
impl Intent {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Navigate { .. } => "navigate",
            Self::Recall => "recall",
            Self::Plan => "plan",
            Self::Discuss => "discuss",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    pub conversation_token_budget: Option<u64>,
    pub run_token_budget: Option<u64>,
    pub codex_parallelism: u32,
    pub claude_parallelism: u32,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            conversation_token_budget: None,
            run_token_budget: None,
            codex_parallelism: 3,
            claude_parallelism: 3,
        }
    }
}
pub fn policy(db: &Database) -> Policy {
    db.get_setting("redline.monochat.policy")
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}
pub fn validate_policy(policy: &Policy) -> Result<(), String> {
    if !(1..=16).contains(&policy.codex_parallelism)
        || !(1..=16).contains(&policy.claude_parallelism)
    {
        return Err("Harness concurrency must be between 1 and 16".into());
    }
    if [policy.conversation_token_budget, policy.run_token_budget]
        .into_iter()
        .flatten()
        .any(|limit| !(1000..=1_000_000_000).contains(&limit))
    {
        return Err("Token thresholds must be at least 1,000, or disabled".into());
    }
    Ok(())
}
pub fn conversation_budget(db: &Database, id: &str) -> Result<(), String> {
    if let Some(limit) = policy(db).conversation_token_budget {
        let observed: u64 = db
            .thread_meters("companion", id)
            .iter()
            .filter_map(|(_, value)| serde_json::from_str::<TurnMeter>(value).ok())
            .map(|meter| meter.total_tokens())
            .sum();
        if observed >= limit {
            return Err(format!("This conversation has reached its {limit} observed-token threshold. Adjust the threshold in Activity & usage to continue. Your draft is preserved."));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn monochat_policy_get(settings: tauri::State<'_, crate::Settings>) -> Policy {
    policy(&settings.db)
}
#[tauri::command]
pub fn monochat_policy_set(
    settings: tauri::State<'_, crate::Settings>,
    policy: Policy,
) -> Result<(), String> {
    validate_policy(&policy)?;
    settings
        .db
        .set_setting(
            "redline.monochat.policy",
            &serde_json::to_string(&policy).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
}

/// A conservative, zero-token fast path. Only an entire imperative with one
/// explicit HTTP(S) URL is executable; quoted text and mixed goals stay with
/// the reasoning harness. Other labels are retrieval hints, never authority.
pub fn classify(text: &str, surface: &SurfaceInfo) -> Intent {
    let text = text.trim();
    let lower = text.to_lowercase();
    if surface.kind == "browser" && !text.contains(['\n', '\r']) {
        for prefix in ["open ", "go to ", "navigate to ", "visit "] {
            if lower.starts_with(prefix) {
                let target = text[prefix.len()..].trim();
                if !target.chars().any(char::is_whitespace)
                    && !target.contains(['\"', '\'', '`', '<', '>'])
                {
                    if let Ok(url) = target.parse::<tauri::Url>() {
                        if matches!(url.scheme(), "http" | "https")
                            && url.host_str().is_some()
                            && url.username().is_empty()
                            && url.password().is_none()
                        {
                            return Intent::Navigate {
                                url: url.to_string(),
                            };
                        }
                    }
                }
            }
        }
    }
    if [
        "what did i ",
        "what did we ",
        "remember ",
        "find my ",
        "recall ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        Intent::Recall
    } else if ["plan ", "make a plan", "help me plan"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        Intent::Plan
    } else {
        Intent::Discuss
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub surface: String,
    pub target_id: Option<String>,
    pub intent: String,
    pub provider: String,
    pub model: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub meter: Option<TurnMeter>,
}

pub struct Span {
    db: std::sync::Arc<Database>,
    pub trace: Trace,
}
impl Span {
    pub fn begin(
        db: std::sync::Arc<Database>,
        conversation: &str,
        message: &str,
        surface: &SurfaceInfo,
        intent: &Intent,
        provider: &str,
    ) -> Self {
        let trace = Trace {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation.into(),
            message_id: message.into(),
            surface: surface.kind.clone(),
            target_id: surface.id.clone(),
            intent: intent.label().into(),
            provider: provider.into(),
            model: None,
            status: "running".into(),
            started_at: crate::state::now_millis(),
            finished_at: None,
            elapsed_ms: None,
            meter: None,
        };
        record(&db, &trace);
        Self { db, trace }
    }
    pub fn finish(&mut self, status: &str, meter: Option<TurnMeter>) {
        let now = crate::state::now_millis();
        self.trace.status = status.into();
        self.trace.finished_at = Some(now);
        self.trace.elapsed_ms = Some(now.saturating_sub(self.trace.started_at));
        self.trace.model = meter.as_ref().and_then(|meter| meter.model.clone());
        self.trace.meter = meter;
        record(&self.db, &self.trace);
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if self.trace.finished_at.is_none() {
            self.finish("interrupted", None);
        }
    }
}

fn schema(db: &Database) -> rusqlite::Result<()> {
    db.lock_conn().execute_batch("CREATE TABLE IF NOT EXISTS monochat_traces (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, started_at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS monochat_traces_conversation ON monochat_traces(conversation_id, started_at DESC);")
}
pub fn record(db: &Database, trace: &Trace) {
    let result = (|| -> rusqlite::Result<()> {
        schema(db)?;
        let payload = serde_json::to_string(trace).unwrap_or_default();
        let conn = db.lock_conn();
        conn.execute("INSERT INTO monochat_traces(id,conversation_id,started_at,payload) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", rusqlite::params![trace.id,trace.conversation_id,trace.started_at,payload])?;
        conn.execute("DELETE FROM monochat_traces WHERE id IN (SELECT id FROM monochat_traces ORDER BY started_at DESC LIMIT -1 OFFSET 5000)", [])?;
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "Could not record Monochat trace");
    }
}
pub fn recent(db: &Database, conversation: &str) -> Result<Vec<Trace>, String> {
    schema(db).map_err(|error| error.to_string())?;
    let conn = db.lock_conn();
    let mut stmt = conn.prepare("SELECT payload FROM monochat_traces WHERE conversation_id=?1 ORDER BY started_at DESC LIMIT 100").map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([conversation], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        row.map_err(|error| error.to_string())
            .and_then(|payload| serde_json::from_str(&payload).map_err(|error| error.to_string()))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capacity_preferences_and_trace_round_trip() {
        assert!(validate_policy(&Policy::default()).is_ok());
        assert!(validate_policy(&Policy {
            codex_parallelism: 0,
            ..Default::default()
        })
        .is_err());
        assert!(validate_policy(&Policy {
            run_token_budget: Some(99),
            ..Default::default()
        })
        .is_err());
        let db = std::sync::Arc::new(Database::open_in_memory().unwrap());
        assert!(conversation_budget(&db, "chat").is_ok());
        let mut span = Span::begin(
            db.clone(),
            "chat",
            "message",
            &SurfaceInfo::default(),
            &Intent::Recall,
            "codex",
        );
        assert_eq!(recent(&db, "chat").unwrap()[0].status, "running");
        let mut meter = TurnMeter::new();
        meter.input_tokens = 23;
        meter.output_tokens = 5;
        span.finish("complete", Some(meter));
        let rows = recent(&db, "chat").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].meter.as_ref().unwrap().total_tokens(), 28);
        assert!(recent(&db, "another-chat").unwrap().is_empty());
    }
    #[test]
    fn only_explicit_single_navigation_is_fast() {
        let browser = SurfaceInfo {
            kind: "browser".into(),
            ..Default::default()
        };
        assert!(matches!(
            classify("Go to https://example.com/docs?q=hello", &browser),
            Intent::Navigate { .. }
        ));
        for text in [
            "open https://example.com and buy it",
            "do not open https://example.com",
            "open javascript:alert(1)",
            "open https://user:secret@example.com",
            "Explain: open https://example.com",
            "open https://example.com\nthen delete it",
            "visit \"https://example.com\"",
            "open example.com",
        ] {
            assert!(
                !matches!(classify(text, &browser), Intent::Navigate { .. }),
                "{text}"
            );
        }
        assert!(!matches!(
            classify("open https://example.com", &SurfaceInfo::default()),
            Intent::Navigate { .. }
        ));
    }
}

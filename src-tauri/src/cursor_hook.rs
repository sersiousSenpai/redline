// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Cursor sends completed text and Stop separately. Never pair different turns.
use crate::plan_submission::{envelope, valid_id, PlanSubmission};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(300);
const CAPACITY: usize = 32;
#[derive(Default)]
pub struct ResponseCache {
    entries: HashMap<(String, String), (Instant, Option<PlanSubmission>)>,
    closed: HashMap<(String, String), Instant>,
}
impl ResponseCache {
    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, (at, _)| now.saturating_duration_since(*at) < TTL);
        self.closed
            .retain(|_, at| now.saturating_duration_since(*at) < TTL);
        while self.closed.len() > CAPACITY {
            let oldest = self
                .closed
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(key, _)| key.clone())
                .unwrap();
            self.closed.remove(&oldest);
        }
    }
    pub fn record(&mut self, payload: &Value, now: Instant) {
        self.prune(now);
        let Some(key) = key(payload) else { return };
        if self.closed.contains_key(&key) {
            return;
        }
        let submission = payload
            .get("text")
            .and_then(Value::as_str)
            .and_then(envelope)
            .map(|plan| PlanSubmission {
                backend: "cursor",
                conversation_id: key.0.clone(),
                generation_id: key.1.clone(),
                cwd: payload
                    .pointer("/workspace_roots/0")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                model: payload
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                plan,
            });
        if self.entries.len() >= CAPACITY && !self.entries.contains_key(&key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (now, submission));
    }
    fn observed(&mut self, payload: &Value, now: Instant) -> Option<Option<PlanSubmission>> {
        self.prune(now);
        let Some(key) = key(payload) else {
            return Some(None);
        };
        if self.closed.contains_key(&key) {
            return Some(None);
        }
        if payload.get("status").and_then(Value::as_str) != Some("completed") {
            self.entries.remove(&key);
            self.closed.insert(key, now);
            return Some(None);
        }
        let (_, entry) = self.entries.remove(&key)?;
        self.closed.insert(key, now);
        Some(entry)
    }
    #[cfg(test)]
    pub fn take(&mut self, payload: &Value, now: Instant) -> Option<PlanSubmission> {
        self.observed(payload, now).flatten()
    }
}

fn key(v: &Value) -> Option<(String, String)> {
    let c = v.get("conversation_id")?.as_str()?;
    let g = v.get("generation_id")?.as_str()?;
    (valid_id(c) && valid_id(g)).then(|| (c.into(), g.into()))
}
fn cache() -> &'static Mutex<ResponseCache> {
    static CACHE: OnceLock<Mutex<ResponseCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ResponseCache::default()))
}
fn changed() -> &'static tokio::sync::Notify {
    static CHANGED: OnceLock<tokio::sync::Notify> = OnceLock::new();
    CHANGED.get_or_init(tokio::sync::Notify::new)
}
pub fn record(v: &Value) {
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .record(v, Instant::now());
    changed().notify_waiters();
}
/// Cursor's real interactive CLI may fire Stop before afterAgentResponse.
/// Wait only for this exact generation; ordinary text releases as soon as its
/// response is observed. A missing response fails open after three seconds.
pub async fn take(v: &Value) -> Option<PlanSubmission> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let notified = changed().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if let Some(result) = cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .observed(v, Instant::now())
        {
            return result;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn real_cursor_stop_before_response_waits_for_only_its_generation() {
        let mut stop: Value =
            serde_json::from_str(include_str!("../tests/fixtures/cursor/stop-20260908.json"))
                .unwrap();
        let mut response: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/cursor/afterAgentResponse-20260908.json"
        ))
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        stop["conversation_id"] = json!(id);
        response["conversation_id"] = json!(id);
        let pending = tokio::spawn(async move { take(&stop).await });
        tokio::task::yield_now().await;
        let mut other = response.clone();
        other["generation_id"] = json!("other");
        record(&other);
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        record(&response);
        let submission = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(submission.model.as_deref(), Some("gpt-5.6-luna-high"));
        assert_eq!(submission.cwd, "/fixture/project");
        assert!(submission.plan.contains("Compatibility plan"));
    }
    #[test]
    fn aborted_generation_cannot_be_resurrected_by_late_response() {
        let now = Instant::now();
        let mut c = ResponseCache::default();
        let mut v = json!({"conversation_id":"late","generation_id":"one","status":"aborted","text":"<proposed_plan>Stale</proposed_plan>"});
        assert_eq!(c.observed(&v, now).map(|v| v.is_none()), Some(true));
        c.record(&v, now);
        v["status"] = json!("completed");
        assert!(c.take(&v, now).is_none());
    }
    #[test]
    fn generation_isolation_expiry_and_consumption() {
        let now = Instant::now();
        let mut c = ResponseCache::default();
        let response = json!({"conversation_id":"a","generation_id":"one","text":"<proposed_plan>A</proposed_plan>"});
        c.record(&response, now);
        assert!(c
            .take(
                &json!({"conversation_id":"a","generation_id":"two","status":"completed"}),
                now
            )
            .is_none());
        let stop = json!({"conversation_id":"a","generation_id":"one","status":"completed"});
        assert_eq!(c.take(&stop, now).unwrap().plan, "A");
        assert!(c.take(&stop, now).is_none());
        let mut c = ResponseCache::default();
        c.record(&response, now);
        assert!(c.take(&stop, now + TTL).is_none());
    }
    #[test]
    fn concurrent_conversations_aborts_and_more_than_five_cycles() {
        let now = Instant::now();
        let mut c = ResponseCache::default();
        for n in 0..8 {
            for id in ["a", "b"] {
                c.record(&json!({"conversation_id":id,"generation_id":n.to_string(),"text":format!("<proposed_plan>{id}</proposed_plan>")}),now);
            }
            for id in ["a", "b"] {
                assert_eq!(c.take(&json!({"conversation_id":id,"generation_id":n.to_string(),"status":"completed"}),now).unwrap().plan,id);
            }
        }
        let mut v = json!({"conversation_id":"a","generation_id":"last","text":"<proposed_plan>A</proposed_plan>","status":"aborted"});
        c.record(&v, now);
        assert!(c.take(&v, now).is_none());
        v["status"] = json!("completed");
        assert!(c.take(&v, now).is_none());
    }
}

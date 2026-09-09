// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Bind a launch's chosen provider/model/effort to the session its CLI creates.
//! UUID tokens isolate simultaneous identical prompts. Legacy hooks may use a
//! body hash only when there is exactly one possible launch in that context.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const HEADER: &str = "x-redline-plan-launch-id";
const TTL: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_PENDING: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchMetadata {
    pub body_hash: String,
    pub backend: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}
#[derive(Clone)]
struct Entry {
    at: Instant,
    project: Option<String>,
    session: Option<String>,
    metadata: LaunchMetadata,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
}

fn canonical(path: &str) -> String {
    let path = Path::new(path);
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_end_matches('/')
        .to_owned()
}
fn clean(value: Option<&str>, limit: usize) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(value) if value.len() > limit || value.chars().any(char::is_control) => {
            Err("launch metadata is invalid".into())
        }
        value => Ok(value.map(str::to_owned)),
    }
}
fn matches(entry: &Entry, backend: Option<&str>, cwd: &str) -> bool {
    backend
        .filter(|v| !v.is_empty())
        .is_none_or(|v| v == entry.metadata.backend)
        && entry
            .project
            .as_ref()
            .is_none_or(|p| !cwd.is_empty() && *p == canonical(cwd))
}
impl Registry {
    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, entry| now.saturating_duration_since(entry.at) < TTL);
    }
    fn register(&mut self, id: &str, entry: Entry, now: Instant) -> Result<(), String> {
        self.prune(now);
        if self.entries.contains_key(id) {
            return Err("that launch ID is already registered".into());
        }
        if self.entries.len() >= MAX_PENDING {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                self.entries.remove(&id);
            }
        }
        self.entries.insert(id.into(), entry);
        Ok(())
    }
    fn bind(
        &mut self,
        id: Option<&str>,
        body_hash: &str,
        session: &str,
        backend: Option<&str>,
        cwd: &str,
        now: Instant,
    ) {
        self.prune(now);
        let id = if let Some(id) = id.filter(|id| !id.is_empty()) {
            Some(id.to_owned())
        } else {
            let candidates: Vec<String> = self
                .entries
                .iter()
                .filter(|(_, entry)| {
                    entry.session.is_none()
                        && entry.metadata.body_hash == body_hash
                        && matches(entry, backend, cwd)
                })
                .map(|(id, _)| id.clone())
                .collect();
            if candidates.len() == 1 {
                candidates.into_iter().next()
            } else {
                None
            }
        };
        let Some(entry) = id.as_ref().and_then(|id| self.entries.get_mut(id)) else {
            return;
        };
        if entry.metadata.body_hash != body_hash
            || !matches(entry, backend, cwd)
            || entry.session.as_ref().is_some_and(|sid| sid != session)
        {
            return;
        }
        entry.session = Some(session.into());
    }
    fn claim(
        &mut self,
        id: Option<&str>,
        session: &str,
        backend: Option<&str>,
        cwd: &str,
        now: Instant,
    ) -> Option<LaunchMetadata> {
        self.prune(now);
        let id = if let Some(id) = id.filter(|id| !id.is_empty()) {
            id.to_owned()
        } else {
            let mut bound = self.entries.iter().filter(|(_, entry)| {
                entry.session.as_deref() == Some(session) && matches(entry, backend, cwd)
            });
            let id = bound.next()?.0.clone();
            if bound.next().is_some() {
                return None;
            }
            id
        };
        let entry = self.entries.get(&id)?;
        if entry.session.as_ref().is_some_and(|sid| sid != session) || !matches(entry, backend, cwd)
        {
            return None;
        }
        self.entries.remove(&id).map(|e| e.metadata)
    }
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

pub fn register(
    launch_id: &str,
    body_hash: &str,
    project_path: Option<&str>,
    backend: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(launch_id).map_err(|_| "launch ID must be a UUID")?;
    let backend = backend
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("claude-code");
    if !matches!(backend, "claude-code" | "codex" | "cursor" | "antigravity") {
        return Err("unknown planning backend".into());
    }
    if body_hash.len() != 64 || !body_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid launch body hash".into());
    }
    let now = Instant::now();
    let entry = Entry {
        at: now,
        project: project_path.filter(|p| !p.is_empty()).map(canonical),
        session: None,
        metadata: LaunchMetadata {
            body_hash: body_hash.into(),
            backend: backend.into(),
            model: clean(model, 256)?,
            effort: clean(effort, 32)?,
        },
    };
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .register(launch_id, entry, now)
}

pub fn bind_prompt(
    launch_id: Option<&str>,
    body_hash: &str,
    session_id: &str,
    backend: Option<&str>,
    cwd: &str,
) {
    registry().lock().unwrap_or_else(|e| e.into_inner()).bind(
        launch_id,
        body_hash,
        session_id,
        backend,
        cwd,
        Instant::now(),
    );
}

/// Consume only after the review session has been created, so callers can
/// persist all selected fields before emitting its first frontend event.
pub fn claim(
    launch_id: Option<&str>,
    session_id: &str,
    backend: Option<&str>,
    cwd: &str,
) -> Option<LaunchMetadata> {
    registry().lock().unwrap_or_else(|e| e.into_inner()).claim(
        launch_id,
        session_id,
        backend,
        cwd,
        Instant::now(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(now: Instant, effort: &str) -> Entry {
        Entry {
            at: now,
            project: Some("/fixture/repo".into()),
            session: None,
            metadata: LaunchMetadata {
                body_hash: "same-prompt".into(),
                backend: "codex".into(),
                model: Some("chosen-model".into()),
                effort: Some(effort.into()),
            },
        }
    }
    #[test]
    fn identical_concurrent_prompts_bind_by_uuid_not_arrival_order() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.register("first", entry(now, "low"), now).unwrap();
        r.register("second", entry(now, "high"), now).unwrap();
        r.bind(
            Some("second"),
            "same-prompt",
            "session-b",
            Some("codex"),
            "/fixture/repo",
            now,
        );
        r.bind(
            Some("first"),
            "same-prompt",
            "session-a",
            Some("codex"),
            "/fixture/repo",
            now,
        );
        assert_eq!(
            r.claim(None, "session-a", Some("codex"), "/fixture/repo", now)
                .unwrap()
                .effort
                .as_deref(),
            Some("low")
        );
        assert_eq!(
            r.claim(None, "session-b", Some("codex"), "/fixture/repo", now)
                .unwrap()
                .effort
                .as_deref(),
            Some("high")
        );
        assert!(r
            .claim(
                Some("first"),
                "session-a",
                Some("codex"),
                "/fixture/repo",
                now
            )
            .is_none());
    }
    #[test]
    fn legacy_hash_binding_refuses_ambiguous_launches() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.register("a", entry(now, "low"), now).unwrap();
        r.register("b", entry(now, "high"), now).unwrap();
        r.bind(None, "same-prompt", "session", None, "/fixture/repo", now);
        assert!(r
            .claim(None, "session", None, "/fixture/repo", now)
            .is_none());
        r.entries.remove("b");
        r.bind(None, "same-prompt", "session", None, "/fixture/repo", now);
        assert!(r
            .claim(None, "session", None, "/fixture/repo", now)
            .is_some());
    }
    #[test]
    fn context_mismatch_cannot_steal_or_consume_another_launch() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.register("a", entry(now, "high"), now).unwrap();
        assert!(r
            .claim(Some("a"), "session", Some("cursor"), "/fixture/repo", now)
            .is_none());
        assert!(r
            .claim(
                Some("a"),
                "session",
                Some("codex"),
                "/fixture/elsewhere",
                now
            )
            .is_none());
        r.bind(
            Some("a"),
            "same-prompt",
            "owner",
            None,
            "/fixture/repo",
            now,
        );
        assert!(r
            .claim(Some("a"), "other", None, "/fixture/repo", now)
            .is_none());
        assert!(r
            .claim(Some("a"), "owner", None, "/fixture/repo", now)
            .is_some());
    }
    #[test]
    fn stale_and_duplicate_registrations_do_not_leak() {
        let now = Instant::now();
        let mut r = Registry::default();
        r.register("a", entry(now, "low"), now).unwrap();
        assert!(r.register("a", entry(now, "high"), now).is_err());
        assert!(r
            .claim(Some("a"), "session", None, "/fixture/repo", now + TTL)
            .is_none());
        assert!(r.entries.is_empty());
        for i in 0..MAX_PENDING + 20 {
            r.register(&i.to_string(), entry(now, "low"), now).unwrap();
        }
        assert_eq!(r.entries.len(), MAX_PENDING);
    }
}

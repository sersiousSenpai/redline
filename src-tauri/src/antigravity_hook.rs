// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Antigravity's successful idle Stop -> the shared held-plan protocol.
//! Docs: https://antigravity.google/docs/hooks . CLI 1.1.28 fixtures additionally
//! establish NO_TOOL_CALL and transcript_full.jsonl, its untruncated log.
use crate::plan_submission::{envelope, valid_id, PlanSubmission};
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Resolve only the documented conversation layout; no arbitrary local hook
/// path may become a filesystem read. Symlinks cannot escape or cross sessions.
fn confined_transcript(
    path: &str,
    conversation: &str,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    if !valid_id(conversation) {
        return Err("invalid Antigravity conversation id".into());
    }
    let path = if let Some(tail) = path.strip_prefix("~/") {
        PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?).join(tail)
    } else {
        PathBuf::from(path)
    };
    if !path.is_absolute() {
        return Err("Antigravity transcript path must be absolute".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Antigravity transcript is unavailable")?;
    for root in roots {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        for filename in ["transcript.jsonl", "transcript_full.jsonl"] {
            let allowed = root
                .join(conversation)
                .join(".system_generated/logs")
                .join(filename);
            // Comparing against the literal expected path also rejects a
            // same-root symlink from this conversation into another one.
            if canonical == allowed && canonical.is_file() {
                return Ok(canonical);
            }
        }
    }
    Err("Antigravity transcript is outside its conversation logs".into())
}

fn read_tail(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let bytes = if start > 0 {
        let Some(newline) = bytes.iter().position(|b| *b == b'\n') else {
            return Ok(String::new());
        };
        &bytes[newline + 1..]
    } else {
        &bytes[..]
    };
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "Antigravity transcript tail is not valid UTF-8".into())
}

/// Last completed assistant response only: never resurrect a previous plan
/// when the current response is plain text, partial, truncated, or a new user turn.
fn last_response(tail: &str) -> Option<(u64, String)> {
    for line in tail.lines().rev().filter(|line| !line.trim().is_empty()) {
        let row: Value = serde_json::from_str(line).ok()?;
        match row.get("type")?.as_str()? {
            "USER_INPUT" => return None,
            "PLANNER_RESPONSE" => {
                if row.get("source").and_then(Value::as_str) != Some("MODEL")
                    || row.get("status").and_then(Value::as_str) != Some("DONE")
                    || row
                        .get("truncated_fields")
                        .and_then(Value::as_array)
                        .is_some_and(|v| v.iter().any(|f| f.as_str() == Some("content")))
                {
                    return None;
                }
                let plan = envelope(row.get("content")?.as_str()?)?;
                return Some((row.get("step_index")?.as_u64()?, plan));
            }
            // Tool and bookkeeping records may follow the final response.
            _ => continue,
        }
    }
    None
}

pub fn submission_under(
    payload: &Value,
    roots: &[PathBuf],
) -> Result<Option<PlanSubmission>, String> {
    let reason = payload.get("terminationReason").and_then(Value::as_str);
    if !matches!(reason, Some("model_stop" | "NO_TOOL_CALL"))
        || payload.get("fullyIdle").and_then(Value::as_bool) != Some(true)
        || payload
            .get("error")
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
    {
        return Ok(None);
    }
    let Some(conversation) = payload.get("conversationId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(execution) = payload.get("executionNum").and_then(Value::as_u64) else {
        return Ok(None);
    };
    let Some(path) = payload.get("transcriptPath").and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = confined_transcript(path, conversation, roots)?;
    let Some((step, plan)) = last_response(&read_tail(&path)?) else {
        return Ok(None);
    };
    let cwd = payload
        .pointer("/workspacePaths/0")
        .and_then(Value::as_str)
        .or_else(|| payload.get("redlineProjectPath").and_then(Value::as_str))
        .unwrap_or("")
        .to_owned();
    Ok(Some(PlanSubmission {
        backend: "antigravity",
        conversation_id: conversation.into(),
        generation_id: format!("execution-{execution}-step-{step}"),
        cwd,
        model: payload
            .get("modelName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan,
    }))
}

pub fn submission(payload: &Value) -> Result<Option<PlanSubmission>, String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
    submission_under(
        payload,
        &[
            home.join(".gemini/antigravity-cli/brain"),
            home.join(".gemini/antigravity/brain"),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn response(content: &str) -> Value {
        json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":content})
    }
    fn fixture() -> (PathBuf, Value) {
        let root = std::env::temp_dir().join(format!("redline-agy-{}", uuid::Uuid::new_v4()));
        let path = root.join("conversation-one/.system_generated/logs/transcript_full.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                "{}\n",
                response("<proposed_plan># Plan\nRead only.</proposed_plan>")
            ),
        )
        .unwrap();
        let payload = json!({"executionNum":0,"terminationReason":"NO_TOOL_CALL","fullyIdle":true,"error":"","conversationId":"conversation-one", "transcriptPath":path,"modelName":"gemini-fixture","workspacePaths":["/fixture/project"]});
        (root, payload)
    }
    #[test]
    fn sanitized_real_cli_fixtures_keep_the_observed_schema() {
        let stop: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/antigravity/stop-1.1.28.json"
        ))
        .unwrap();
        assert_eq!(stop["terminationReason"], "NO_TOOL_CALL");
        assert_eq!(stop["fullyIdle"], true);
        assert!(stop["transcriptPath"]
            .as_str()
            .unwrap()
            .ends_with("transcript_full.jsonl"));
        let (step, plan) = last_response(include_str!(
            "../tests/fixtures/antigravity/transcript-full-1.1.28.jsonl"
        ))
        .unwrap();
        assert_eq!(step, 1);
        assert!(plan.contains("Disposable compatibility plan"));
        let init: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/antigravity/headless-init-1.1.28.json"
        ))
        .unwrap();
        // Plan mode exposes writes in this CLI. Keep sidecars on the explicit
        // Claude fallback until a read-only tool boundary can be established.
        assert!(init["init"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool == "write_to_file"));
    }

    #[test]
    fn captured_cli_stop_normalizes_to_shared_plan_protocol() {
        let (root, payload) = fixture();
        let s = submission_under(&payload, &[root.clone()])
            .unwrap()
            .unwrap();
        assert_eq!(s.plan, "# Plan\nRead only.");
        assert_eq!(s.cwd, "/fixture/project");
        assert_eq!(s.generation_id, "execution-0-step-1");
        for (key, value) in [
            ("fullyIdle", json!(false)),
            ("terminationReason", json!("error")),
            ("error", json!("cancelled")),
            ("executionNum", json!(-1)),
        ] {
            let mut changed = payload.clone();
            changed[key] = value;
            assert!(submission_under(&changed, &[root.clone()])
                .unwrap()
                .is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn last_response_never_replays_old_or_truncated_plans() {
        let plan = response("<proposed_plan>Plan</proposed_plan>").to_string();
        assert!(last_response(&format!("{plan}\n{}", response("ordinary reply"))).is_none());
        assert!(last_response(&format!(
            "{plan}\n{}",
            json!({"type":"USER_INPUT","content":"new turn"})
        ))
        .is_none());
        assert!(last_response(&format!("{plan}\n{{partial")).is_none());
        let mut truncated = response("<proposed_plan>Plan</proposed_plan>");
        truncated["truncated_fields"] = json!(["content"]);
        assert!(last_response(&truncated.to_string()).is_none());
    }
    #[test]
    fn transcript_confinement_rejects_foreign_sessions_and_symlink_escapes() {
        let (root, mut payload) = fixture();
        let original = payload["transcriptPath"].as_str().unwrap().to_owned();
        payload["conversationId"] = json!("another-conversation");
        assert!(submission_under(&payload, &[root.clone()]).is_err());
        payload["conversationId"] = json!("../conversation-one");
        assert!(submission_under(&payload, &[root.clone()]).is_err());
        #[cfg(unix)]
        {
            let outside = root.join("outside.jsonl");
            std::fs::write(&outside, "sensitive").unwrap();
            std::fs::remove_file(&original).unwrap();
            std::os::unix::fs::symlink(&outside, &original).unwrap();
            payload["conversationId"] = json!("conversation-one");
            assert!(submission_under(&payload, &[root.clone()]).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bounded_tail_skips_partial_first_record_and_keeps_complete_last_plan() {
        let (root, payload) = fixture();
        let path = Path::new(payload["transcriptPath"].as_str().unwrap());
        let text = format!(
            "{}\n{}\n",
            "x".repeat(MAX_TAIL_BYTES as usize + 100),
            response("<proposed_plan>Final</proposed_plan>")
        );
        std::fs::write(path, text).unwrap();
        let tail = read_tail(path).unwrap();
        assert!(tail.len() <= MAX_TAIL_BYTES as usize);
        assert_eq!(last_response(&tail).unwrap().1, "Final");
        std::fs::remove_dir_all(root).unwrap();
    }
}

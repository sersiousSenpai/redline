// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The proposal grammar — the classifier's structured-JSON ops (`file` /
//! `create` / `promote` / `split` / `merge` / `collapse` / `supersede`) and the
//! supersede verifier's verdicts. Pure parsing: tolerant of prose and fences,
//! drops what it cannot use, never touches a store.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::json::extract_object_with_key;

// ---------------------------------------------------------------------------
// Proposal parsing (the classifier's structured-JSON output)
// ---------------------------------------------------------------------------

/// One part of a `split` op: a new sub-class title and the link ids that move to
/// it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SplitPart {
    pub title: String,
    #[serde(default)]
    pub link_ids: Vec<i64>,
}

/// A parsed proposal. `file`/`create` are additive (staged as proposed rows);
/// `promote`/`split`/`merge`/`collapse` are structural (queued for review).
#[derive(Debug, Clone, PartialEq)]
pub enum Proposal {
    File {
        parent_id: String,
        sub_class: Option<String>,
        target_kind: String,
        target_id: String,
        note: Option<String>,
        rationale: Option<String>,
    },
    Create {
        parent_id: String,
        title: String,
        rationale: Option<String>,
    },
    Promote {
        node_id: String,
        new_parent_id: Option<String>,
        rationale: Option<String>,
    },
    Split {
        node_id: String,
        into: Vec<SplitPart>,
        rationale: Option<String>,
    },
    Merge {
        node_ids: Vec<String>,
        title: Option<String>,
        parent_id: Option<String>,
        rationale: Option<String>,
    },
    Collapse {
        node_id: String,
        summary: String,
        cite_seqs: Vec<i64>,
        rationale: Option<String>,
    },
    /// A newer decision replaces an older one on the same subject. Staged for
    /// the verifier agent (never blind-applied); apply-time guardrails live in
    /// `Database::apply_supersession_locked`.
    Supersede {
        old_seq: i64,
        new_seq: i64,
        rationale: Option<String>,
    },
}

/// Extract the proposals JSON from a classifier's final message. Tolerates the
/// model wrapping it in a ```json fence or in surrounding prose: finds the first
/// balanced `{...}` object that parses and contains a `proposals` array. Pure.
pub fn parse_proposals(text: &str) -> Vec<Proposal> {
    let Some(obj) = extract_json_object(text) else {
        return Vec::new();
    };
    let Some(arr) = obj.get("proposals").and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter().filter_map(parse_one).collect()
}

/// The classifier's reply is the first balanced `{…}` that parses and carries a
/// `proposals` key — the shared extractor, keyed.
fn extract_json_object(text: &str) -> Option<Value> {
    extract_object_with_key(text, "proposals")
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn parse_one(v: &Value) -> Option<Proposal> {
    let op = str_field(v, "op")?;
    let rationale = str_field(v, "rationale").map(str::to_string);
    match op {
        "file" => {
            // A lake target id may be a number (prompt/ledger seq) or a string
            // (session/mission id) — accept both.
            let target_id = value_as_id(v.get("target_id"))?;
            Some(Proposal::File {
                parent_id: str_field(v, "parent_id")?.to_string(),
                sub_class: str_field(v, "sub_class").map(str::to_string),
                target_kind: str_field(v, "target_kind")?.to_string(),
                target_id,
                note: str_field(v, "note").map(str::to_string),
                rationale,
            })
        }
        "create" => Some(Proposal::Create {
            parent_id: str_field(v, "parent_id")?.to_string(),
            title: str_field(v, "title")?.to_string(),
            rationale,
        }),
        "promote" => Some(Proposal::Promote {
            node_id: str_field(v, "node_id")?.to_string(),
            new_parent_id: str_field(v, "new_parent_id").map(str::to_string),
            rationale,
        }),
        "split" => {
            let into: Vec<SplitPart> = v
                .get("into")
                .and_then(|x| serde_json::from_value(x.clone()).ok())
                .unwrap_or_default();
            if into.is_empty() {
                return None;
            }
            Some(Proposal::Split {
                node_id: str_field(v, "node_id")?.to_string(),
                into,
                rationale,
            })
        }
        "merge" => {
            let node_ids: Vec<String> = v
                .get("node_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if node_ids.len() < 2 {
                return None;
            }
            Some(Proposal::Merge {
                node_ids,
                title: str_field(v, "title").map(str::to_string),
                parent_id: str_field(v, "parent_id").map(str::to_string),
                rationale,
            })
        }
        "collapse" => {
            let cite_seqs: Vec<i64> = v
                .get("cite_seqs")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            Some(Proposal::Collapse {
                node_id: str_field(v, "node_id")?.to_string(),
                summary: str_field(v, "summary")?.to_string(),
                cite_seqs,
                rationale,
            })
        }
        "supersede" => {
            let old_seq = value_as_i64(v.get("old_seq"))?;
            let new_seq = value_as_i64(v.get("new_seq"))?;
            // Cheap screen only — old must precede new (which also makes
            // cycles impossible); the full guardrails (decision-kind check,
            // head-of-chain redirect) run at apply time.
            if old_seq <= 0 || new_seq <= 0 || old_seq >= new_seq {
                return None;
            }
            Some(Proposal::Supersede {
                old_seq,
                new_seq,
                rationale,
            })
        }
        _ => None, // unknown op — skipped (logged by the caller if it wants)
    }
}

/// A lake target id may arrive as a JSON number or string.
fn value_as_id(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// A ledger seq may arrive as a JSON number or numeric string.
fn value_as_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}


/// A supersession only applies when the verifier affirms it at or above this
/// confidence. Below it (or on an explicit refutation) the proposal is
/// dropped; with no verdict at all it stays staged for the review strip.
pub const SUPERSEDE_CONFIDENCE_MIN: f64 = 0.8;

/// One adjudication from the verifier agent.
#[derive(Debug, Clone, PartialEq)]
pub struct SupersedeVerdict {
    pub proposal_id: i64,
    pub apply: bool,
    pub confidence: f64,
    pub reason: String,
}

/// Parse the verifier's reply. Tolerant of prose/fences like the other agent
/// parsers; entries with no usable proposalId are dropped, missing fields
/// default to the safe side (apply=false, confidence=0).
pub fn parse_supersede_verdicts(text: &str) -> Vec<SupersedeVerdict> {
    let Some(obj) = extract_object_with_key(text, "verdicts") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(arr) = obj.get("verdicts").and_then(Value::as_array) {
        for v in arr {
            let Some(proposal_id) = value_as_i64(v.get("proposalId")) else {
                continue;
            };
            let apply = v.get("apply").and_then(Value::as_bool).unwrap_or(false);
            let confidence = v.get("confidence").and_then(Value::as_f64).unwrap_or(0.0);
            let reason = str_field(v, "reason").unwrap_or("").to_string();
            out.push(SupersedeVerdict {
                proposal_id,
                apply,
                confidence,
                reason,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_all_ops_from_a_fenced_block() {
        let text = r#"Here are my proposals:
```json
{"proposals":[
  {"op":"create","parent_id":"root-redline","title":"Loop Engineering","rationale":"8 items"},
  {"op":"file","parent_id":"root-redline","sub_class":"Loop Engineering","target_kind":"prompt","target_id":42,"note":"spawn","rationale":"coheres"},
  {"op":"promote","node_id":"cn-1","new_parent_id":"root-redline","rationale":"grew"},
  {"op":"split","node_id":"cn-2","into":[{"title":"Clerk","link_ids":[1,2]},{"title":"Sessions","link_ids":[3]}],"rationale":"two subjects"},
  {"op":"merge","node_ids":["cn-3","cn-4"],"title":"Auth","rationale":"dupes"},
  {"op":"collapse","node_id":"cn-5","summary":"old investing research","cite_seqs":[10,11,12],"rationale":"cold"},
  {"op":"supersede","old_seq":"318","new_seq":402,"rationale":"the beta approval reversed the earlier resolution"}
]}
```
That's it."#;
        let props = parse_proposals(text);
        assert_eq!(props.len(), 7);
        assert!(matches!(props[0], Proposal::Create { .. }));
        match &props[1] {
            Proposal::File { target_id, sub_class, .. } => {
                assert_eq!(target_id, "42"); // numeric id coerced to string
                assert_eq!(sub_class.as_deref(), Some("Loop Engineering"));
            }
            _ => panic!("expected file"),
        }
        match &props[3] {
            Proposal::Split { into, .. } => assert_eq!(into.len(), 2),
            _ => panic!("expected split"),
        }
        match &props[5] {
            Proposal::Collapse { cite_seqs, .. } => assert_eq!(cite_seqs, &vec![10, 11, 12]),
            _ => panic!("expected collapse"),
        }
        match &props[6] {
            Proposal::Supersede { old_seq, new_seq, .. } => {
                // string-coerced old_seq + numeric new_seq both parse
                assert_eq!((*old_seq, *new_seq), (318, 402));
            }
            _ => panic!("expected supersede"),
        }
    }

    #[test]
    fn parse_ignores_prose_and_bad_ops() {
        assert!(parse_proposals("no json here").is_empty());
        // merge with <2 ids and split with no parts are dropped.
        let text = r#"{"proposals":[
          {"op":"frobnicate","node_id":"x"},
          {"op":"merge","node_ids":["only-one"]},
          {"op":"split","node_id":"y","into":[]},
          {"op":"supersede","old_seq":9},
          {"op":"supersede","old_seq":9,"new_seq":9},
          {"op":"supersede","old_seq":12,"new_seq":9},
          {"op":"create","parent_id":"root","title":"Keep","rationale":"ok"}
        ]}"#;
        let props = parse_proposals(text);
        assert_eq!(props.len(), 1);
        assert!(matches!(props[0], Proposal::Create { .. }));
    }

    #[test]
    fn parse_supersede_verdicts_gates_on_shape() {
        let text = r#"Adjudicated.
```json
{"verdicts":[
  {"proposalId":7,"apply":true,"confidence":0.95,"reason":"clear reversal"},
  {"proposalId":"8","apply":false,"confidence":0.4,"reason":"different subjects"},
  {"apply":true,"confidence":1.0,"reason":"no id — dropped"},
  {"proposalId":9}
]}
```"#;
        let v = parse_supersede_verdicts(text);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], SupersedeVerdict { proposal_id: 7, apply: true, confidence: 0.95, reason: "clear reversal".into() });
        // numeric-string id coerces; refutation carries through
        assert_eq!(v[1].proposal_id, 8);
        assert!(!v[1].apply);
        // missing fields default to the safe side
        assert_eq!(v[2], SupersedeVerdict { proposal_id: 9, apply: false, confidence: 0.0, reason: String::new() });
        assert!(parse_supersede_verdicts("prose only").is_empty());
    }
}

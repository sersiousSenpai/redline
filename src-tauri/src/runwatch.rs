//! Live watcher for orchestrated multi-agent runs — the Orchestration
//! Monitor's data source.
//!
//! When an approved plan is launched via Orchestrate, the orchestrator claude
//! session executes the plan as a native Workflow, and Claude Code writes a
//! live-tailable artifact set under the orchestrator session's transcript dir:
//! the parent transcript announces the run (Run ID / Transcript dir / Script
//! file, plain text inside a tool_result), the per-run `journal.jsonl` pairs
//! `started`/`result` events (a `started` without a `result` IS the liveness
//! primitive), `agent-<id>.jsonl` files stream each agent's transcript, and a
//! `<runId>.json` manifest lands only at completion with the authoritative
//! per-agent progress. This module tails that set on a plain named thread
//! (~1s tick, byte-offset cursors, hand-rolled substring scanning — no new
//! crates by the binary-size constraint), folds it into a `RunSnapshot`, and
//! pings the UI with `orchestration-live` (ping-then-fetch, the house
//! pattern). Everything heuristic is labeled as such (`label_source`,
//! `notes`) — the UI stays honest about what is derived vs. authoritative.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;
use crate::state::SessionStore;

/// Tick cadence for a live watcher.
const TICK: Duration = Duration::from_secs(1);
/// Per-file read cap per tick; overflow seeks to the tail and says so.
const PER_TICK_CAP: u64 = 512 * 1024;
/// First-read catch-up cap for an agent transcript (app restart mid-run).
const CATCHUP_AGENT_CAP: u64 = 8 * 1024 * 1024;
/// The journal is the ground truth — catch it up whole.
const CATCHUP_JOURNAL_CAP: u64 = 64 * 1024 * 1024;
/// Script files are read once, bounded.
const SCRIPT_READ_CAP: u64 = 1024 * 1024;
/// Default backwards window for a fresh transcript-tail cursor.
const TAIL_WINDOW: u64 = 128 * 1024;
/// Per-call byte cap for the drawer's tail poll.
const TAIL_CALL_CAP: u64 = 1024 * 1024;
/// Per-call event cap for the drawer's tail poll.
const TAIL_EVENT_CAP: usize = 500;
/// Transcript dir gone + parent transcript silent this long → give up.
const DIRS_MISSING_GRACE_MS: i64 = 30 * 60 * 1000;
/// Preview truncation for prompts/results.
const PREVIEW_CHARS: usize = 240;
/// How much of an agent's prompt we keep in memory for label matching.
const PROMPT_MATCH_CAP: usize = 32 * 1024;

// --- snapshot model (serde camelCase, mirrored in src/types.ts) -------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseInfo {
    pub title: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTotals {
    /// Upper bound from script call sites — "~N planned", not a promise.
    pub planned_agents: Option<usize>,
    pub running: usize,
    pub done: usize,
    pub failed: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub tool_calls: u64,
    pub files_changed: Vec<String>,
    /// Agents whose observed model is the seat's configured FALLBACK rather
    /// than its primary — the run kept going degraded instead of failing.
    pub degraded: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTile {
    pub agent_id: String,
    pub label: Option<String>,
    /// "manifest" (authoritative) | "script" (heuristic match) | "preview".
    pub label_source: String,
    pub phase: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The observed model is the seat's configured FALLBACK, not its primary
    /// (`--fallback-model` kicked in) — graceful degradation, surfaced.
    pub degraded: bool,
    /// running | done | failed | cached. Mid-run `failed` only from an
    /// explicit `error` key in a journal result; the manifest is the
    /// authority on failure.
    pub state: String,
    pub started_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: u64,
    pub last_tool_name: Option<String>,
    pub prompt_preview: Option<String>,
    pub result_preview: Option<String>,
    pub files_changed: Vec<String>,
    pub transcript_bytes: u64,
}

impl AgentTile {
    fn new(agent_id: &str, state: &str) -> Self {
        AgentTile {
            agent_id: agent_id.to_string(),
            label: None,
            label_source: "preview".to_string(),
            phase: None,
            model: None,
            effort: None,
            degraded: false,
            state: state.to_string(),
            started_at: None,
            last_activity_at: None,
            duration_ms: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            tool_calls: 0,
            last_tool_name: None,
            prompt_preview: None,
            result_preview: None,
            files_changed: Vec::new(),
            transcript_bytes: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInfo {
    pub status: String,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
    pub agent_count: Option<u64>,
    pub total_tokens: Option<u64>,
    pub total_tool_calls: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub plan_session_id: String,
    pub claude_session_id: String,
    pub run_state: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub seq: u64,
    /// "pending" (no Workflow launch seen yet) | "workflow" | "sequential".
    pub mode: String,
    pub run_id: Option<String>,
    pub workflow_name: Option<String>,
    pub workflow_description: Option<String>,
    pub phases: Vec<PhaseInfo>,
    pub script_path: Option<String>,
    pub transcript_dir: Option<String>,
    pub totals: RunTotals,
    pub agents: Vec<AgentTile>,
    pub manifest: Option<ManifestInfo>,
    pub report_filed: bool,
    pub dirs_missing: bool,
    /// Honest degradation trail ("journal tail skipped …"), muted in the UI.
    pub notes: Vec<String>,
}

impl RunSnapshot {
    fn tile_mut(&mut self, agent_id: &str, state_if_new: &str) -> &mut AgentTile {
        if let Some(i) = self.agents.iter().position(|t| t.agent_id == agent_id) {
            return &mut self.agents[i];
        }
        self.agents.push(AgentTile::new(agent_id, state_if_new));
        self.agents.last_mut().unwrap()
    }

    fn note(&mut self, note: &str) {
        if !self.notes.iter().any(|n| n == note) {
            self.notes.push(note.to_string());
        }
    }

    /// Fold tile facts into the header totals. Cheap (tens of tiles).
    pub(crate) fn recompute_totals(&mut self) {
        let planned = self.totals.planned_agents;
        let mut t = RunTotals {
            planned_agents: planned,
            ..RunTotals::default()
        };
        let mut files: Vec<String> = Vec::new();
        for a in &self.agents {
            match a.state.as_str() {
                "running" => t.running += 1,
                "failed" => t.failed += 1,
                "done" | "cached" => t.done += 1,
                _ => {}
            }
            t.input_tokens += a.input_tokens;
            t.output_tokens += a.output_tokens;
            t.cache_creation_tokens += a.cache_creation_tokens;
            t.cache_read_tokens += a.cache_read_tokens;
            t.tool_calls += a.tool_calls;
            if a.degraded {
                t.degraded += 1;
            }
            files.extend(a.files_changed.iter().cloned());
        }
        files.sort();
        files.dedup();
        t.files_changed = files;
        self.totals = t;
    }
}

// --- pure parse seams -------------------------------------------------------

/// The Workflow launch facts announced (plain text) in the parent
/// transcript's tool_result. We scan the raw JSONL line, so each value ends
/// at the closing `"` of the JSON string or at an escape (`\n` → `\`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WorkflowLaunch {
    pub run_id: String,
    pub transcript_dir: String,
    pub script_path: Option<String>,
    #[allow(dead_code)]
    pub task_id: Option<String>,
}

fn scan_value(text: &str, key: &str) -> Option<String> {
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    let end = rest.find(['"', '\\']).unwrap_or(rest.len());
    let v = rest[..end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

pub(crate) fn parse_workflow_launch(text: &str) -> Option<WorkflowLaunch> {
    let run_id = scan_value(text, "Run ID: ")?;
    // Run ids are `wf_` + lowercase hex/dashes; anything else is a stray
    // mention of the label in ordinary prose, not a launch line.
    if !run_id.starts_with("wf_")
        || !run_id[3..]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    let transcript_dir = scan_value(text, "Transcript dir: ")?;
    Some(WorkflowLaunch {
        run_id,
        transcript_dir,
        script_path: scan_value(text, "Script file: "),
        task_id: scan_value(text, "Task ID: "),
    })
}

/// Collapse whitespace runs and truncate on a char boundary.
fn preview(s: &str, cap: usize) -> String {
    let mut out = String::with_capacity(cap.min(s.len()) + 1);
    let mut last_ws = false;
    for c in s.chars() {
        if out.chars().count() >= cap {
            out.push('…');
            break;
        }
        if c.is_whitespace() {
            if !last_ws && !out.is_empty() {
                out.push(' ');
            }
            last_ws = true;
        } else {
            out.push(c);
            last_ws = false;
        }
    }
    out.trim_end().to_string()
}

fn value_preview(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => preview(s, PREVIEW_CHARS),
        other => preview(&other.to_string(), PREVIEW_CHARS),
    }
}

/// Pull `filesChanged`-style arrays of strings out of a structured agent
/// result, wherever they sit (bounded recursion).
fn collect_files_changed(v: &serde_json::Value, out: &mut Vec<String>, depth: u8) {
    if depth > 3 || out.len() >= 64 {
        return;
    }
    if let Some(map) = v.as_object() {
        for (k, val) in map {
            if matches!(k.as_str(), "filesChanged" | "files_changed" | "files") {
                if let Some(arr) = val.as_array() {
                    for f in arr.iter().filter_map(serde_json::Value::as_str) {
                        if out.len() >= 64 {
                            return;
                        }
                        out.push(f.to_string());
                    }
                }
            } else {
                collect_files_changed(val, out, depth + 1);
            }
        }
    }
}

/// Apply one journal line. `started` without a later `result` = running
/// (the liveness primitive); `result` without a `started` = cached (resumed
/// runs re-emit results only). Malformed lines are skipped, never fatal.
pub(crate) fn apply_journal_line(snap: &mut RunSnapshot, line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let Some(agent_id) = v.get("agentId").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match v.get("type").and_then(serde_json::Value::as_str) {
        Some("started") => {
            snap.tile_mut(agent_id, "running");
            true
        }
        Some("result") => {
            let known = snap.agents.iter().any(|t| t.agent_id == agent_id);
            let tile = snap.tile_mut(agent_id, "cached");
            if known {
                let failed = v
                    .get("result")
                    .and_then(serde_json::Value::as_object)
                    .map(|o| o.contains_key("error"))
                    .unwrap_or(false);
                tile.state = if failed { "failed" } else { "done" }.to_string();
            }
            if let Some(result) = v.get("result") {
                tile.result_preview = Some(value_preview(result));
                let mut files = Vec::new();
                collect_files_changed(result, &mut files, 0);
                for f in files {
                    if !tile.files_changed.contains(&f) {
                        tile.files_changed.push(f);
                    }
                }
            }
            true
        }
        _ => false,
    }
}

/// Per-agent scratch the snapshot doesn't carry (the full prompt for label
/// matching — previews only in the serialized shape).
#[derive(Default)]
pub(crate) struct AgentAux {
    pub prompt: String,
    pub labeled: bool,
}

/// Apply one line of an `agent-<id>.jsonl` transcript to its tile.
pub(crate) fn apply_agent_line(tile: &mut AgentTile, aux: &mut AgentAux, line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    let mut changed = false;
    if let Some(ms) = v
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(iso_millis)
    {
        if tile.last_activity_at != Some(ms) {
            tile.last_activity_at = Some(tile.last_activity_at.unwrap_or(ms).max(ms));
            changed = true;
        }
        if tile.started_at.is_none() {
            tile.started_at = Some(ms);
        }
        if let (Some(s), Some(e)) = (tile.started_at, tile.last_activity_at) {
            tile.duration_ms = Some((e - s).max(0));
        }
    }
    match v.get("type").and_then(serde_json::Value::as_str) {
        Some("user") => {
            // Line 1: the prompt, as a plain content string.
            if aux.prompt.is_empty() {
                if let Some(p) = v
                    .pointer("/message/content")
                    .and_then(serde_json::Value::as_str)
                {
                    aux.prompt = p.chars().take(PROMPT_MATCH_CAP).collect();
                    tile.prompt_preview = Some(preview(p, PREVIEW_CHARS));
                    changed = true;
                }
            }
        }
        Some("assistant") => {
            if let Some(m) = v.get("message") {
                if let Some(model) = m.get("model").and_then(serde_json::Value::as_str) {
                    if tile.model.as_deref() != Some(model) {
                        tile.model = Some(model.to_string());
                        changed = true;
                    }
                }
                if let Some(effort) = v.get("effort").and_then(serde_json::Value::as_str) {
                    if tile.effort.as_deref() != Some(effort) {
                        tile.effort = Some(effort.to_string());
                        changed = true;
                    }
                }
                if let Some(u) = m.get("usage") {
                    let g = |k: &str| u.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
                    tile.input_tokens += g("input_tokens");
                    tile.output_tokens += g("output_tokens");
                    tile.cache_read_tokens += g("cache_read_input_tokens");
                    tile.cache_creation_tokens += g("cache_creation_input_tokens");
                    changed = true;
                }
                if let Some(blocks) = m.get("content").and_then(serde_json::Value::as_array) {
                    for b in blocks {
                        if b.get("type").and_then(serde_json::Value::as_str) == Some("tool_use") {
                            tile.tool_calls += 1;
                            if let Some(name) =
                                b.get("name").and_then(serde_json::Value::as_str)
                            {
                                tile.last_tool_name = Some(name.to_string());
                            }
                            changed = true;
                        }
                    }
                }
            }
        }
        _ => {}
    }
    changed
}

/// One `agent()` call site in the persisted script: its literal prompt
/// evidence (for matching a spawned agent back to the site) and its opts.
#[derive(Debug, Clone)]
pub(crate) struct AgentCall {
    pub label: Option<String>,
    pub phase: Option<String>,
    pub literal: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ScriptMeta {
    pub name: Option<String>,
    pub description: Option<String>,
    pub phases: Vec<PhaseInfo>,
}

/// Slice out a balanced `{…}`/`[…]`/`(…)` block starting at `open`, aware of
/// the three JS string kinds and escapes. Bounded — gives up (None) rather
/// than scanning forever on pathological input.
fn balanced_block(src: &str, open: usize, cap: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    let open_ch = *bytes.get(open)?;
    let close_ch = match open_ch {
        b'{' => b'}',
        b'[' => b']',
        b'(' => b')',
        _ => return None,
    };
    let mut depth = 0usize;
    let mut i = open;
    let end = src.len().min(open + cap);
    while i < end {
        let b = bytes[i];
        match b {
            b'\'' | b'"' | b'`' => {
                i += 1;
                while i < end {
                    if bytes[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == b {
                        break;
                    }
                    i += 1;
                }
            }
            _ if b == open_ch => depth += 1,
            _ if b == close_ch => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[open..=i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Unescape the common JS single-quote escapes (`\n`, `\t`, `\'`, `\"`,
/// `\\`, `` \` ``). Anything fancier passes through untouched.
fn unescape_js(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Read the string literal starting at `src[i]` (which must be a quote).
/// Template literals stop at `${` — the literal prefix is what we can match.
fn read_string_literal(src: &str, i: usize) -> Option<(String, usize)> {
    let bytes = src.as_bytes();
    let quote = *bytes.get(i)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    let mut j = i + 1;
    while j < src.len() {
        let b = bytes[j];
        if b == b'\\' {
            j += 2;
            continue;
        }
        if quote == b'`' && b == b'$' && bytes.get(j + 1) == Some(&b'{') {
            return Some((unescape_js(&src[i + 1..j]), j));
        }
        if b == quote {
            return Some((unescape_js(&src[i + 1..j]), j + 1));
        }
        j += 1;
    }
    None
}

/// Find `key: '<value>'` inside a block, lenient about quote kind, spacing
/// and trailing commas (NOT JSON.parse — meta blocks are hand-written JS).
fn find_string_field(block: &str, key: &str) -> Option<String> {
    let mut from = 0;
    while let Some(rel) = block[from..].find(key) {
        let at = from + rel;
        from = at + key.len();
        // Word-boundary on the left (avoid `phase` matching `phases`).
        if at > 0 {
            let prev = block.as_bytes()[at - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' {
                continue;
            }
        }
        let rest = &block[at + key.len()..];
        let trimmed = rest.trim_start();
        if !trimmed.starts_with(':') {
            continue;
        }
        let after = trimmed[1..].trim_start();
        let off = block.len() - after.len();
        if let Some((val, _)) = read_string_literal(block, off.min(block.len())) {
            return Some(val);
        }
        // `label: 'build:' + item.x` → the leading literal already returned
        // above; a non-string value (identifier, number) falls through.
    }
    None
}

/// The script's `export const meta = {…}` block: workflow name, description
/// and the phase plan — the up-front skeleton the tiles hang off.
pub(crate) fn extract_script_meta(src: &str) -> Option<ScriptMeta> {
    let at = src.find("export const meta")?;
    let brace = at + src[at..].find('{')?;
    let block = balanced_block(src, brace, 64 * 1024)?;
    let mut meta = ScriptMeta {
        name: find_string_field(block, "name"),
        description: find_string_field(block, "description"),
        phases: Vec::new(),
    };
    if let Some(pk) = block.find("phases") {
        if let Some(bk) = block[pk..].find('[') {
            if let Some(arr) = balanced_block(block, pk + bk, 32 * 1024) {
                let mut from = 0;
                while let Some(rel) = arr[from..].find('{') {
                    let Some(obj) = balanced_block(arr, from + rel, 4 * 1024) else {
                        break;
                    };
                    if let Some(title) = find_string_field(obj, "title") {
                        meta.phases.push(PhaseInfo {
                            title,
                            detail: find_string_field(obj, "detail"),
                        });
                    }
                    from = from + rel + obj.len();
                }
            }
        }
    }
    (meta.name.is_some() || !meta.phases.is_empty()).then_some(meta)
}

/// Longest string literal (≥16 chars unescaped) in the statement assigning
/// `ident` — the evidence that lets a spawned agent's prompt be matched back
/// to the call site that built it.
fn longest_literal_of_assignment(src: &str, ident: &str) -> Option<String> {
    let mut best: Option<String> = None;
    for pat in [format!("const {ident} ="), format!("let {ident} =")] {
        let Some(at) = src.find(&pat) else { continue };
        let start = at + pat.len();
        // Statement window: until the next top-level statement keyword at a
        // line start (good enough for the house prompt-concatenation style).
        let window_end = ["\nconst ", "\nlet ", "\nexport ", "\nawait ", "\nphase("]
            .iter()
            .filter_map(|k| src[start..].find(k))
            .min()
            .map(|i| start + i)
            .unwrap_or(src.len().min(start + 24 * 1024));
        let window = &src[start..window_end];
        let bytes = window.as_bytes();
        let mut i = 0;
        while i < window.len() {
            if matches!(bytes[i], b'\'' | b'"' | b'`') {
                if let Some((lit, next)) = read_string_literal(window, i) {
                    if lit.len() >= 16 && best.as_ref().map_or(true, |b| lit.len() > b.len()) {
                        best = Some(lit);
                    }
                    i = next.max(i + 1);
                    continue;
                }
            }
            i += 1;
        }
    }
    best
}

/// Every `agent(` call site: leading prompt literal (or the longest literal
/// of the identifier it passes), plus `label:`/`phase:` opts. The call-site
/// count is the "~N planned" upper bound.
pub(crate) fn extract_agent_calls(src: &str) -> Vec<AgentCall> {
    let mut calls = Vec::new();
    let bytes = src.as_bytes();
    let mut from = 0;
    while let Some(rel) = src[from..].find("agent(") {
        let at = from + rel;
        from = at + 6;
        // Reject `subagent(` / identifiers ending in "agent".
        if at > 0 {
            let prev = bytes[at - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'.' {
                continue;
            }
        }
        let open = at + 5;
        let window = balanced_block(src, open, 64 * 1024).unwrap_or(&src[open..src.len().min(open + 2048)]);
        let inner = &window[1..];
        let arg = inner.trim_start();
        let arg_off = open + 1 + (inner.len() - arg.len());
        let literal = match arg.as_bytes().first() {
            Some(b'\'') | Some(b'"') | Some(b'`') => {
                read_string_literal(src, arg_off).map(|(l, _)| l).filter(|l| l.len() >= 16)
            }
            Some(c) if c.is_ascii_alphabetic() || *c == b'_' => {
                let ident: String = arg
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                let member = arg[ident.len()..].trim_start().starts_with('.');
                if member {
                    None // `item.build` — dynamic, no literal evidence
                } else {
                    longest_literal_of_assignment(src, &ident)
                }
            }
            _ => None,
        };
        calls.push(AgentCall {
            label: find_string_field(window, "label"),
            phase: find_string_field(window, "phase"),
            literal,
        });
    }
    calls
}

/// Match an agent's prompt back to a call site: longest literal wins. A
/// match without a `label:` opt is no better than the preview fallback.
pub(crate) fn guess_label(prompt: &str, calls: &[AgentCall]) -> Option<(String, Option<String>)> {
    let mut best: Option<(&AgentCall, usize)> = None;
    for c in calls {
        let Some(lit) = &c.literal else { continue };
        if prompt.contains(lit.as_str()) && best.map_or(true, |(_, len)| lit.len() > len) {
            best = Some((c, lit.len()));
        }
    }
    let (call, _) = best?;
    let label = call.label.clone()?;
    Some((label, call.phase.clone()))
}

/// The completion manifest, parsed down to what the monitor uses.
#[derive(Debug, Clone)]
pub(crate) struct ManifestParsed {
    pub info: ManifestInfo,
    pub workflow_name: Option<String>,
    pub description: Option<String>,
    pub phases: Vec<PhaseInfo>,
    pub agents: Vec<ManifestAgent>,
}

#[derive(Debug, Clone)]
pub(crate) struct ManifestAgent {
    pub agent_id: String,
    pub label: Option<String>,
    pub phase_title: Option<String>,
    pub state: Option<String>,
    pub started_at: Option<i64>,
    pub model: Option<String>,
    pub last_tool_name: Option<String>,
}

pub(crate) fn parse_manifest(text: &str) -> Option<ManifestParsed> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let status = v.get("status")?.as_str()?.to_string();
    let s = |key: &str| v.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
    let n = |key: &str| v.get(key).and_then(serde_json::Value::as_u64);
    let phases = v
        .get("phases")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    Some(PhaseInfo {
                        title: p.get("title")?.as_str()?.to_string(),
                        detail: p.get("detail").and_then(serde_json::Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let agents = v
        .get("workflowProgress")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|e| e.get("type").and_then(serde_json::Value::as_str) == Some("workflow_agent"))
                .filter_map(|e| {
                    let f = |key: &str| e.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
                    Some(ManifestAgent {
                        agent_id: e.get("agentId")?.as_str()?.to_string(),
                        label: f("label"),
                        phase_title: f("phaseTitle"),
                        state: f("state"),
                        started_at: e.get("startedAt").and_then(serde_json::Value::as_i64),
                        model: f("model"),
                        last_tool_name: f("lastToolName"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ManifestParsed {
        info: ManifestInfo {
            status,
            duration_ms: v.get("durationMs").and_then(serde_json::Value::as_i64),
            summary: s("summary"),
            agent_count: n("agentCount"),
            total_tokens: n("totalTokens"),
            total_tool_calls: n("totalToolCalls"),
        },
        workflow_name: s("workflowName"),
        description: s("description"),
        phases,
        agents,
    })
}

/// Authoritative backfill: the manifest's per-agent progress overrides every
/// heuristic (labels, phases, states). Terminal event for the watcher.
pub(crate) fn apply_manifest(snap: &mut RunSnapshot, m: &ManifestParsed) {
    if snap.workflow_name.is_none() {
        snap.workflow_name = m.workflow_name.clone();
    }
    if snap.workflow_description.is_none() {
        snap.workflow_description = m.description.clone();
    }
    if snap.phases.is_empty() {
        snap.phases = m.phases.clone();
    }
    for ma in &m.agents {
        let tile = snap.tile_mut(&ma.agent_id, "done");
        if let Some(label) = &ma.label {
            tile.label = Some(label.clone());
            tile.label_source = "manifest".to_string();
        }
        if ma.phase_title.is_some() {
            tile.phase = ma.phase_title.clone();
        }
        if let Some(model) = &ma.model {
            tile.model = Some(model.clone());
        }
        if tile.started_at.is_none() {
            tile.started_at = ma.started_at;
        }
        if tile.last_tool_name.is_none() {
            tile.last_tool_name = ma.last_tool_name.clone();
        }
        match ma.state.as_deref() {
            Some("done") => tile.state = "done".to_string(),
            Some("failed") | Some("error") => tile.state = "failed".to_string(),
            Some("cached") => tile.state = "cached".to_string(),
            _ => {}
        }
    }
    snap.manifest = Some(m.info.clone());
    snap.mode = "workflow".to_string();
    snap.recompute_totals();
}

/// Epoch millis from the transcripts' ISO-8601 UTC stamps
/// (`2026-08-07T11:09:26.237Z`). Hand-rolled — no date crate in the tree.
pub(crate) fn iso_millis(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = 0i64;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = ts[20..].chars().take_while(char::is_ascii_digit).collect();
        ms = match frac.len() {
            0 => 0,
            1 => frac.parse::<i64>().unwrap_or(0) * 100,
            2 => frac.parse::<i64>().unwrap_or(0) * 10,
            _ => frac[..3].parse::<i64>().unwrap_or(0),
        };
    }
    // Days-from-civil (Hinnant) — valid for all Gregorian dates.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((((days * 24 + h) * 60 + mi) * 60 + s) * 1000 + ms)
}

/// `a` + 16 lowercase hex chars — the only agent id shape we ever join into
/// a path (the tail command's traversal guard).
pub(crate) fn valid_agent_id(id: &str) -> bool {
    id.len() == 17
        && id.starts_with('a')
        && id[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// --- graceful degradation (P8) ---------------------------------------------

/// True when `observed` (a full model id from a transcript, e.g.
/// `claude-sonnet-5`) is the model `configured` names — either the exact id,
/// or a seat-style alias (`sonnet`, `haiku`) appearing as a `-`-delimited
/// segment of the id. Case-insensitive; blank never matches.
pub(crate) fn model_matches(configured: &str, observed: &str) -> bool {
    let c = configured.trim().to_ascii_lowercase();
    let o = observed.trim().to_ascii_lowercase();
    if c.is_empty() || o.is_empty() {
        return false;
    }
    c == o || o.split('-').any(|seg| seg == c)
}

/// Pure degradation check: the seat asked for `primary` with `fallback`
/// configured, and the transcript shows the run actually got the fallback
/// (`--fallback-model` kicked in instead of the spawn failing). Anything
/// ambiguous — no observation yet, no configured primary (the CLI default
/// applies, so there is nothing to differ from), no configured fallback, or
/// an observed model matching the primary — is NOT degradation; never cry
/// wolf on a model we merely don't recognize.
pub(crate) fn detect_degraded(
    observed: Option<&str>,
    primary: Option<&str>,
    fallback: Option<&str>,
) -> bool {
    let (Some(obs), Some(pri), Some(fb)) = (observed, primary, fallback) else {
        return false;
    };
    !model_matches(pri, obs) && model_matches(fb, obs)
}

/// Re-derive every tile's `degraded` flag from its currently observed model
/// and drop ONE degradation note per run (the note text carries no agent id,
/// so `RunSnapshot::note`'s dedup keeps it single). The flag tracks the
/// observation — a manifest backfill that corrects a heuristic model read
/// also clears it. Returns whether anything changed.
pub(crate) fn apply_degradation(
    snap: &mut RunSnapshot,
    primary: Option<&str>,
    fallback: Option<&str>,
) -> bool {
    let mut changed = false;
    let mut newly = false;
    for tile in &mut snap.agents {
        let is_degraded = detect_degraded(tile.model.as_deref(), primary, fallback);
        if is_degraded != tile.degraded {
            tile.degraded = is_degraded;
            changed = true;
            newly |= is_degraded;
        }
    }
    if newly {
        snap.note(&format!(
            "model degraded: seat primary '{}' unavailable — running on fallback '{}'",
            primary.unwrap_or("?"),
            fallback.unwrap_or("?"),
        ));
    }
    changed
}

/// The seat's configured primary + fallback model, read from the seat store
/// (read-only — `seat.rs` owns the store; blank values behave like absent).
fn seat_models(seat: &str) -> (Option<String>, Option<String>) {
    let seats = crate::seat::all_seats();
    let Some(cfg) = seats.get(seat) else {
        return (None, None);
    };
    let clean = |o: &Option<String>| {
        o.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    (clean(&cfg.model), clean(&cfg.fallback))
}

// --- per-seat burn attribution (P8) ----------------------------------------

/// How often a live watcher books accrued burn deltas to the DB.
const BURN_FLUSH_MS: i64 = 10_000;

/// The Agent Seat a watched run's burn and degradation attribute to, derived
/// from the orchestration row's launch context. Every orchestration row today
/// is minted by the Orchestrate launch flow, whose run is spawned and steered
/// by the orchestrator seat — so the derivation resolves there. It goes
/// through the row (never a hardcoded literal at a call site) deliberately:
/// a future queue-launched run stamps its own origin into the launch context
/// and attributes through this one seam, the same way.
pub(crate) fn seat_for_run(_row: &db::OrchestrationRow) -> String {
    "orchestrator".to_string()
}

/// The token facts a run has accrued, summed over its agent tiles — the burn
/// source. Monotonic while a watcher lives (tile counters only ever grow), so
/// a persisted high-water mark makes booking idempotent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, serde::Deserialize)]
pub(crate) struct BurnFacts {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
    /// Discovered agent transcripts — each one is a spawned agent.
    #[serde(default)]
    pub spawns: u64,
}

pub(crate) fn burn_facts(snap: &RunSnapshot) -> BurnFacts {
    let mut f = BurnFacts::default();
    for a in &snap.agents {
        f.input_tokens += a.input_tokens;
        f.output_tokens += a.output_tokens;
        f.cache_read_tokens += a.cache_read_tokens;
        f.cache_creation_tokens += a.cache_creation_tokens;
    }
    f.spawns = snap.agents.len() as u64;
    f
}

/// Where a run's already-booked high-water mark lives (`app_settings`). Keyed
/// by the run's claude session id: a re-run mints a new claude session (and a
/// fresh transcript with counters starting at zero), so the mark resets with
/// it naturally. Rows are tiny and never expire — acceptable residue.
fn burn_mark_key(claude_sid: &str) -> String {
    format!("redline.seatBurn.mark.{claude_sid}")
}

/// Book the run's UNBOOKED burn onto the seat's `(seat, day)` row —
/// incrementally and idempotently. Only the positive delta above the
/// persisted high-water mark is added, and the mark never regresses: a
/// watcher that re-reads the same transcript bytes (restart, cursor reset)
/// rebuilds the same totals and books zero, and a capped catch-up read that
/// briefly rebuilds BELOW the mark books nothing rather than double-booking
/// later. Deltas land on the day they are observed (`day` = the flush day),
/// which is what day-granular metering means for a run that spans midnight.
/// Returns whether anything was booked.
pub(crate) fn flush_seat_burn(
    db: &db::Database,
    seat: &str,
    claude_sid: &str,
    snap: &RunSnapshot,
    day: &str,
) -> bool {
    if claude_sid.is_empty() {
        return false;
    }
    let key = burn_mark_key(claude_sid);
    let mark: BurnFacts = db
        .get_setting(&key)
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    let cur = burn_facts(snap);
    let delta = BurnFacts {
        input_tokens: cur.input_tokens.saturating_sub(mark.input_tokens),
        output_tokens: cur.output_tokens.saturating_sub(mark.output_tokens),
        cache_read_tokens: cur.cache_read_tokens.saturating_sub(mark.cache_read_tokens),
        cache_creation_tokens: cur
            .cache_creation_tokens
            .saturating_sub(mark.cache_creation_tokens),
        spawns: cur.spawns.saturating_sub(mark.spawns),
    };
    if delta == BurnFacts::default() {
        return false;
    }
    if db
        .add_seat_burn(
            seat,
            day,
            delta.input_tokens as i64,
            delta.output_tokens as i64,
            delta.cache_read_tokens as i64,
            delta.cache_creation_tokens as i64,
            delta.spawns as i64,
        )
        .is_err()
    {
        // Booking failed — leave the mark alone so the delta re-books on the
        // next flush instead of vanishing.
        return false;
    }
    let new_mark = BurnFacts {
        input_tokens: cur.input_tokens.max(mark.input_tokens),
        output_tokens: cur.output_tokens.max(mark.output_tokens),
        cache_read_tokens: cur.cache_read_tokens.max(mark.cache_read_tokens),
        cache_creation_tokens: cur.cache_creation_tokens.max(mark.cache_creation_tokens),
        spawns: cur.spawns.max(mark.spawns),
    };
    if let Ok(j) = serde_json::to_string(&new_mark) {
        let _ = db.set_setting(&key, &j);
    }
    true
}

/// UTC calendar day (`YYYY-MM-DD`) for an epoch-millis stamp — the fallback
/// when local time is unavailable. Civil-from-days (Hinnant), the inverse of
/// `iso_millis`'s days-from-civil; no date crate in the tree.
pub(crate) fn utc_day(ms: i64) -> String {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// LOCAL calendar day (`YYYY-MM-DD`) for an epoch-millis stamp — the
/// `seat_burn` day key (`Database::add_seat_burn` documents that the caller
/// formats a local day). POSIX `localtime_r` through a minimal extern
/// binding — no date/libc crate in the tree (the binary-size law). The
/// buffer is padded well past any known libc's `struct tm`, and a failed
/// call falls back to the UTC day.
#[cfg(unix)]
pub(crate) fn local_day(ms: i64) -> String {
    #[repr(C)]
    struct Tm {
        tm_sec: i32,
        tm_min: i32,
        tm_hour: i32,
        tm_mday: i32,
        tm_mon: i32,
        tm_year: i32,
        tm_wday: i32,
        tm_yday: i32,
        tm_isdst: i32,
        tm_gmtoff: i64,
        tm_zone: *const std::ffi::c_char,
        // Safety margin beyond macOS/glibc/musl layouts so a larger libc
        // `struct tm` can never write past our buffer.
        _reserved: [u8; 64],
    }
    extern "C" {
        fn localtime_r(timep: *const i64, result: *mut Tm) -> *mut Tm;
    }
    let secs = ms.div_euclid(1000);
    let mut tm = std::mem::MaybeUninit::<Tm>::uninit();
    let ok = unsafe { !localtime_r(&secs, tm.as_mut_ptr()).is_null() };
    if !ok {
        return utc_day(ms);
    }
    let tm = unsafe { tm.assume_init() };
    format!(
        "{:04}-{:02}-{:02}",
        i64::from(tm.tm_year) + 1900,
        tm.tm_mon + 1,
        tm.tm_mday
    )
}

#[cfg(not(unix))]
pub(crate) fn local_day(ms: i64) -> String {
    utc_day(ms)
}

// --- incremental file reading ----------------------------------------------

#[derive(Default)]
struct Cursor {
    offset: u64,
    partial: String,
    primed: bool,
}

/// Complete new lines since the cursor. Over-cap growth seeks to the tail,
/// drops the torn line (the `model_from_transcript` pattern) and reports the
/// skip. Partial trailing lines are held across calls — never parse a torn
/// line.
fn read_new_lines(path: &Path, cur: &mut Cursor, cap: u64) -> (Vec<String>, u64) {
    let Ok(mut f) = std::fs::File::open(path) else {
        return (Vec::new(), 0);
    };
    let Ok(md) = f.metadata() else {
        return (Vec::new(), 0);
    };
    let len = md.len();
    if len < cur.offset {
        // Truncated/replaced — restart honestly.
        cur.offset = 0;
        cur.partial.clear();
    }
    if len == cur.offset {
        return (Vec::new(), 0);
    }
    let mut skipped = 0u64;
    if len - cur.offset > cap {
        skipped = len - cur.offset - cap;
        cur.offset = len - cap;
        cur.partial.clear();
    }
    if f.seek(SeekFrom::Start(cur.offset)).is_err() {
        return (Vec::new(), 0);
    }
    let mut buf = Vec::with_capacity((len - cur.offset) as usize);
    let mut handle = f.take(len - cur.offset);
    if handle.read_to_end(&mut buf).is_err() {
        return (Vec::new(), 0);
    }
    cur.offset += buf.len() as u64;
    let chunk = String::from_utf8_lossy(&buf);
    let mut text = std::mem::take(&mut cur.partial);
    text.push_str(&chunk);
    let mut lines: Vec<String> = Vec::new();
    let mut rest = text.as_str();
    while let Some(i) = rest.find('\n') {
        lines.push(rest[..i].trim_end_matches('\r').to_string());
        rest = &rest[i + 1..];
    }
    cur.partial = rest.to_string();
    if skipped > 0 {
        // The first line after a tail-seek is torn mid-line.
        if lines.is_empty() {
            cur.partial.clear();
        } else {
            lines.remove(0);
        }
    }
    (lines, skipped)
}

// --- watcher ----------------------------------------------------------------

/// run_state values during which a watcher stays alive. `abandoned` (a
/// stand-down) and `stalled` are terminal: the watcher exits and boot
/// rehydration skips them. `awaiting_review` is deliberately NOT live
/// either — a run parked for the human's morning review has nothing left to
/// watch (it is not terminal, but its transitions are a later unit's work).
pub fn is_live_run_state(state: Option<&str>) -> bool {
    matches!(state, Some("orchestrating") | Some("running") | Some("in_code_review"))
}

struct WatchHandle {
    stop: Arc<AtomicBool>,
    snapshot: Arc<Mutex<RunSnapshot>>,
}

/// One watcher per live plan session, keyed by plan session id. `start`
/// replaces an existing watcher via its stop flag (re-run).
pub struct RunWatchState {
    inner: Mutex<HashMap<String, WatchHandle>>,
}

impl RunWatchState {
    pub fn new() -> Self {
        RunWatchState {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn snapshot_of(&self, plan_sid: &str) -> Option<RunSnapshot> {
        let map = self.inner.lock().unwrap();
        let h = map.get(plan_sid)?;
        if h.stop.load(Ordering::Relaxed) {
            return None;
        }
        let snap = h.snapshot.lock().unwrap().clone();
        Some(snap)
    }
}

/// Everything a scan pass needs; lives on the watcher thread (or the stack,
/// for a one-shot reconstruction).
struct WatchCtx {
    plan_sid: String,
    transcript_path: PathBuf,
    session_dir: PathBuf,
    snap: RunSnapshot,
    aux: HashMap<String, AgentAux>,
    parent: Cursor,
    journal: Cursor,
    agent_cursors: HashMap<String, Cursor>,
    script_calls: Vec<AgentCall>,
    script_parsed: bool,
    manifest_applied: bool,
    transcript_dir: Option<PathBuf>,
    parent_last_growth: i64,
    /// The Agent Seat this run's burn and degradation attribute to
    /// (derived from the launch context — `seat_for_run`).
    seat: String,
    /// One warn! per run when degradation is first observed.
    degraded_warned: bool,
}

impl WatchCtx {
    fn new(row: db::OrchestrationRow) -> Self {
        let seat = seat_for_run(&row);
        let transcript_path = PathBuf::from(&row.transcript_path);
        // `<dir>/<sessionId>.jsonl` → `<dir>/<sessionId>/` — where the
        // workflows/ and subagents/ trees live.
        let session_dir = transcript_path.with_extension("");
        let mut snap = RunSnapshot {
            plan_session_id: row.plan_session_id.clone(),
            claude_session_id: row.claude_session_id.clone(),
            run_state: row.run_state.clone(),
            started_at: row.started_at,
            mode: "pending".to_string(),
            run_id: row.run_id.clone(),
            script_path: row.script_path.clone(),
            transcript_dir: row.transcript_dir.clone(),
            ..RunSnapshot::default()
        };
        if let Some(mode) = &row.mode {
            snap.mode = mode.clone();
        }
        WatchCtx {
            plan_sid: row.plan_session_id,
            transcript_path,
            session_dir,
            transcript_dir: row.transcript_dir.map(PathBuf::from),
            snap,
            aux: HashMap::new(),
            parent: Cursor::default(),
            journal: Cursor::default(),
            agent_cursors: HashMap::new(),
            script_calls: Vec::new(),
            script_parsed: false,
            manifest_applied: false,
            parent_last_growth: crate::ledger::now_millis(),
            seat,
            degraded_warned: false,
        }
    }
}

/// Start (or restart) the watcher thread for a plan session. Idempotent per
/// re-run: an existing watcher is stopped via its flag and replaced.
pub fn start(app: &AppHandle, store: SessionStore, plan_sid: String) {
    let Some(state) = app.try_state::<RunWatchState>() else {
        tracing::warn!("RunWatchState not managed; run watcher not started");
        return;
    };
    let stop = Arc::new(AtomicBool::new(false));
    let snapshot = Arc::new(Mutex::new(RunSnapshot::default()));
    {
        let mut map = state.inner.lock().unwrap();
        if let Some(old) = map.remove(&plan_sid) {
            old.stop.store(true, Ordering::Relaxed);
        }
        map.insert(
            plan_sid.clone(),
            WatchHandle {
                stop: stop.clone(),
                snapshot: snapshot.clone(),
            },
        );
    }
    let app = app.clone();
    let thread_name = format!("runwatch-{}", &plan_sid[..plan_sid.len().min(8)]);
    let spawned = std::thread::Builder::new().name(thread_name).spawn(move || {
        watch_loop(app, store, plan_sid, stop, snapshot);
    });
    if let Err(e) = spawned {
        tracing::warn!(error = %e, "failed to spawn run watcher thread");
    }
}

/// Stop (and forget) the watcher for a plan session, if one is running — the
/// `start` replacement mechanism's other half, exposed for the recovery
/// commands (`reset_run` / `stand_down_run`). Idempotent: a session with no
/// watcher is a no-op.
pub fn stop(app: &AppHandle, plan_sid: &str) {
    let Some(state) = app.try_state::<RunWatchState>() else {
        return;
    };
    let mut map = state.inner.lock().unwrap();
    if let Some(h) = map.remove(plan_sid) {
        h.stop.store(true, Ordering::Relaxed);
        tracing::info!(plan_sid = %plan_sid, "run watcher stopped by recovery command");
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LivePing {
    plan_session_id: String,
    seq: u64,
}

fn watch_loop(
    app: AppHandle,
    store: SessionStore,
    plan_sid: String,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<RunSnapshot>>,
) {
    let db = store.database();
    let Some(row) = db.get_orchestration(&plan_sid) else {
        tracing::warn!(plan_sid = %plan_sid, "run watcher started with no orchestration row");
        return;
    };
    tracing::info!(plan_sid = %plan_sid, "run watcher started");
    let mut ctx = WatchCtx::new(row);
    let mut first = true;
    let mut last_burn_flush = crate::ledger::now_millis();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let run_state = db.get_run_state(&plan_sid);
        let live = is_live_run_state(run_state.as_deref());
        let state_changed = ctx.snap.run_state != run_state;
        ctx.snap.run_state = run_state;
        let changed = scan_once(&db, &mut ctx, false, live) || state_changed;
        if first {
            // Prime the shared cell even when nothing changed, so snapshot
            // reads hit the watcher instead of re-scanning the disk.
            ctx.snap.updated_at = crate::ledger::now_millis();
            *shared.lock().unwrap() = ctx.snap.clone();
            first = false;
        }
        if changed {
            ctx.snap.seq += 1;
            ctx.snap.updated_at = crate::ledger::now_millis();
            *shared.lock().unwrap() = ctx.snap.clone();
            let _ = app.emit(
                "orchestration-live",
                LivePing {
                    plan_session_id: plan_sid.clone(),
                    seq: ctx.snap.seq,
                },
            );
        }
        // Book accrued burn onto the spawning seat, throttled; the persisted
        // high-water mark keeps re-reads idempotent (`flush_seat_burn`).
        let now = crate::ledger::now_millis();
        if now - last_burn_flush >= BURN_FLUSH_MS {
            last_burn_flush = now;
            flush_seat_burn(
                &db,
                &ctx.seat,
                &ctx.snap.claude_session_id,
                &ctx.snap,
                &local_day(now),
            );
        }
        // Exit AFTER the scan so the terminal facts (manifest backfill, the
        // final run_state) go out as a last ping before the thread retires.
        if ctx.manifest_applied || !live || ctx.snap.dirs_missing {
            break;
        }
        std::thread::sleep(TICK);
    }
    // Final burn booking on a natural exit only. A watcher replaced by a
    // re-run (or stopped by a recovery command) skips it: its successor
    // re-derives the same totals over the same persisted mark, so nothing is
    // lost — and two watchers never race the mark.
    if !stop.load(Ordering::Relaxed) {
        let now = crate::ledger::now_millis();
        flush_seat_burn(
            &db,
            &ctx.seat,
            &ctx.snap.claude_session_id,
            &ctx.snap,
            &local_day(now),
        );
    }
    tracing::info!(plan_sid = %plan_sid, "run watcher exited");
    // Retire our own map entry — but never a successor's (re-run replaces
    // the handle before our stop flag trips).
    if let Some(state) = app.try_state::<RunWatchState>() {
        let mut map = state.inner.lock().unwrap();
        if let Some(h) = map.get(&plan_sid) {
            if Arc::ptr_eq(&h.stop, &stop) {
                map.remove(&plan_sid);
            }
        }
    }
}

/// One scan pass over the artifact set. Returns whether anything changed.
/// `one_shot` widens the caps for a from-disk reconstruction (History).
fn scan_once(db: &db::Database, ctx: &mut WatchCtx, one_shot: bool, live: bool) -> bool {
    let mut changed = false;

    // Phase A — discovery: scan the parent transcript for the Workflow
    // launch line. Cheap incremental reads; the tool_result is one line.
    if ctx.snap.mode != "workflow" {
        let cap = if ctx.parent.primed && !one_shot { PER_TICK_CAP } else { CATCHUP_JOURNAL_CAP };
        let (lines, _) = read_new_lines(&ctx.transcript_path, &mut ctx.parent, cap);
        ctx.parent.primed = true;
        if !lines.is_empty() {
            ctx.parent_last_growth = crate::ledger::now_millis();
        }
        for line in &lines {
            if !line.contains("Run ID: ") {
                continue;
            }
            let Some(launch) = parse_workflow_launch(line) else { continue };
            // Resumed runs symlink the transcript dir — canonicalize so
            // read_dir and the manifest stat see the real files.
            let dir = std::fs::canonicalize(&launch.transcript_dir)
                .unwrap_or_else(|_| PathBuf::from(&launch.transcript_dir));
            let _ = db.update_orchestration_discovery(
                &ctx.plan_sid,
                Some(&launch.run_id),
                Some(&dir.to_string_lossy()),
                launch.script_path.as_deref(),
                Some("workflow"),
            );
            if ctx.snap.mode == "sequential" {
                ctx.snap.note("workflow launch found after a sequential start — switching to the run journal");
            }
            ctx.snap.mode = "workflow".to_string();
            ctx.snap.run_id = Some(launch.run_id);
            ctx.snap.transcript_dir = Some(dir.to_string_lossy().to_string());
            ctx.transcript_dir = Some(dir);
            if ctx.snap.script_path.is_none() {
                ctx.snap.script_path = launch.script_path;
            }
            changed = true;
            break;
        }
        // Sequential fallback: no Workflow announcement, but subagent
        // transcripts exist directly under the session dir.
        if ctx.snap.mode == "pending" {
            let seq_dir = ctx.session_dir.join("subagents");
            let has_agents = std::fs::read_dir(&seq_dir)
                .map(|rd| {
                    rd.filter_map(Result::ok).any(|e| {
                        let name = e.file_name();
                        let name = name.to_string_lossy();
                        name.starts_with("agent-") && name.ends_with(".jsonl")
                    })
                })
                .unwrap_or(false);
            if has_agents {
                ctx.snap.mode = "sequential".to_string();
                ctx.snap.note(
                    "no Workflow run found — sequential fallback; tiles come from raw subagent transcripts",
                );
                let _ = db.update_orchestration_discovery(&ctx.plan_sid, None, None, None, Some("sequential"));
                changed = true;
            }
        }
    }

    // Script meta (workflow, once): the phase plan + call-site labels.
    if ctx.snap.mode == "workflow" && !ctx.script_parsed {
        if let Some(sp) = ctx.snap.script_path.clone() {
            let path = Path::new(&sp);
            if let Ok(md) = std::fs::metadata(path) {
                if md.len() <= SCRIPT_READ_CAP {
                    if let Ok(src) = std::fs::read_to_string(path) {
                        if let Some(meta) = extract_script_meta(&src) {
                            if ctx.snap.workflow_name.is_none() {
                                ctx.snap.workflow_name = meta.name;
                            }
                            if ctx.snap.workflow_description.is_none() {
                                ctx.snap.workflow_description = meta.description;
                            }
                            if ctx.snap.phases.is_empty() {
                                ctx.snap.phases = meta.phases;
                            }
                        }
                        ctx.script_calls = extract_agent_calls(&src);
                        if !ctx.script_calls.is_empty() {
                            ctx.snap.totals.planned_agents = Some(ctx.script_calls.len());
                        }
                        changed = true;
                    }
                }
                ctx.script_parsed = true;
            }
            // Missing script file: retry next tick (it may lag the launch).
        }
    }

    // The agent-file directory for the current mode.
    let agent_dir: Option<PathBuf> = match ctx.snap.mode.as_str() {
        "workflow" => ctx.transcript_dir.clone(),
        "sequential" => Some(ctx.session_dir.join("subagents")),
        _ => None,
    };

    // Journal (workflow only): the liveness ground truth.
    if ctx.snap.mode == "workflow" {
        if let Some(dir) = &ctx.transcript_dir {
            let jpath = dir.join("journal.jsonl");
            let cap = if ctx.journal.primed && !one_shot { PER_TICK_CAP } else { CATCHUP_JOURNAL_CAP };
            let (lines, skipped) = read_new_lines(&jpath, &mut ctx.journal, cap);
            ctx.journal.primed = true;
            if skipped > 0 {
                ctx.snap.note(&format!("journal tail skipped {skipped} bytes — counts may briefly lag"));
                changed = true;
            }
            for line in &lines {
                changed |= apply_journal_line(&mut ctx.snap, line);
            }
        }
    }

    // Agent transcripts: discover new files, tail known ones.
    if let Some(dir) = &agent_dir {
        match std::fs::read_dir(dir) {
            Ok(rd) => {
                let mut ids: Vec<String> = rd
                    .filter_map(Result::ok)
                    .filter_map(|e| {
                        let name = e.file_name();
                        let name = name.to_string_lossy().into_owned();
                        let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?.to_string();
                        valid_agent_id(&id).then_some(id)
                    })
                    .collect();
                ids.sort();
                for id in ids {
                    let path = dir.join(format!("agent-{id}.jsonl"));
                    let is_new = !ctx.agent_cursors.contains_key(&id);
                    let cur = ctx.agent_cursors.entry(id.clone()).or_default();
                    let cap = if cur.primed && !one_shot { PER_TICK_CAP } else { CATCHUP_AGENT_CAP };
                    let (lines, skipped) = read_new_lines(&path, cur, cap);
                    cur.primed = true;
                    let offset = cur.offset;
                    if is_new {
                        // In workflow mode the journal `started` normally
                        // precedes the file; either way a transcript on
                        // disk means the agent is (or was) running.
                        ctx.snap.tile_mut(&id, "running");
                        changed = true;
                        // Sequential agents label themselves via meta.json.
                        if ctx.snap.mode == "sequential" {
                            let meta_path = dir.join(format!("agent-{id}.meta.json"));
                            if let Ok(raw) = std::fs::read_to_string(&meta_path) {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                                    if let Some(desc) =
                                        v.get("description").and_then(serde_json::Value::as_str)
                                    {
                                        let tile = ctx.snap.tile_mut(&id, "running");
                                        tile.label = Some(desc.to_string());
                                        // Authored metadata, not a guess — no
                                        // `~` marker in the UI.
                                        tile.label_source = "manifest".to_string();
                                    }
                                }
                            }
                        }
                    }
                    if skipped > 0 {
                        ctx.snap.note(&format!(
                            "agent {} transcript skipped {} bytes",
                            &id[..7],
                            skipped
                        ));
                    }
                    if !lines.is_empty() || skipped > 0 {
                        let aux = ctx.aux.entry(id.clone()).or_default();
                        let tile = ctx.snap.tile_mut(&id, "running");
                        for line in &lines {
                            changed |= apply_agent_line(tile, aux, line);
                        }
                        tile.transcript_bytes = offset;
                        // Heuristic label, until the manifest says better.
                        if !aux.labeled && !aux.prompt.is_empty() && tile.label_source != "manifest" {
                            if let Some((label, phase)) = guess_label(&aux.prompt, &ctx.script_calls) {
                                tile.label = Some(label);
                                tile.label_source = "script".to_string();
                                if tile.phase.is_none() {
                                    tile.phase = phase;
                                }
                            }
                            aux.labeled = true;
                            changed = true;
                        }
                    }
                }
            }
            Err(_) => {
                // Directory expected but unreadable/missing — cleanup may
                // have eaten the transcripts. Grace-window before giving up
                // (the parent transcript going quiet too seals it).
                if ctx.snap.mode == "workflow"
                    && crate::ledger::now_millis() - ctx.parent_last_growth > DIRS_MISSING_GRACE_MS
                {
                    ctx.snap.dirs_missing = true;
                    ctx.snap.note("transcript dir is gone (cleanup?) — live view frozen at last facts");
                    changed = true;
                }
            }
        }
    }

    // Sequential mode has no journal: state derives from run liveness.
    if ctx.snap.mode == "sequential" && !live {
        for tile in &mut ctx.snap.agents {
            if tile.state == "running" {
                tile.state = "done".to_string();
                changed = true;
            }
        }
    }

    // Manifest: written only at completion — authoritative backfill.
    if ctx.snap.mode == "workflow" && !ctx.manifest_applied {
        if let Some(run_id) = ctx.snap.run_id.clone() {
            let mpath = ctx.session_dir.join("workflows").join(format!("{run_id}.json"));
            if let Ok(text) = std::fs::read_to_string(&mpath) {
                if let Some(parsed) = parse_manifest(&text) {
                    apply_manifest(&mut ctx.snap, &parsed);
                    ctx.manifest_applied = true;
                    changed = true;
                }
            }
        }
    }

    // Exit report (plan_runs row) — the RunReport handoff bar.
    let filed = db.get_plan_run(&ctx.plan_sid).is_some();
    if filed != ctx.snap.report_filed {
        ctx.snap.report_filed = filed;
        changed = true;
    }

    // Graceful-exhaustion surfacing (P8): an agent whose observed model is
    // the seat's configured FALLBACK (not its primary) means the CLI honored
    // `--fallback-model` and kept going degraded instead of failing — mark
    // the tiles (and one note + one warn per run) rather than staying silent.
    {
        let (primary, fallback) = seat_models(&ctx.seat);
        if apply_degradation(&mut ctx.snap, primary.as_deref(), fallback.as_deref()) {
            changed = true;
            if !ctx.degraded_warned && ctx.snap.agents.iter().any(|t| t.degraded) {
                ctx.degraded_warned = true;
                tracing::warn!(
                    plan_sid = %ctx.plan_sid,
                    seat = %ctx.seat,
                    primary = primary.as_deref().unwrap_or("?"),
                    fallback = fallback.as_deref().unwrap_or("?"),
                    "watched run degraded to the seat's fallback model"
                );
            }
        }
    }

    if changed {
        ctx.snap.recompute_totals();
    }
    changed
}

// --- commands ---------------------------------------------------------------

/// Every anchored run, newest first, run_state joined — the History tab's
/// list and the App's "is anything running" probe.
#[tauri::command]
pub fn list_orchestrations(store: tauri::State<'_, SessionStore>) -> Vec<db::OrchestrationRow> {
    store.database().list_orchestrations().unwrap_or_default()
}

/// The live snapshot when a watcher is running; otherwise a one-shot
/// reconstruction from whatever is still on disk (History, dead runs).
#[tauri::command]
pub fn orchestration_snapshot(
    app: AppHandle,
    store: tauri::State<'_, SessionStore>,
    plan_session_id: String,
) -> Option<RunSnapshot> {
    if let Some(state) = app.try_state::<RunWatchState>() {
        if let Some(snap) = state.snapshot_of(&plan_session_id) {
            // A watcher exists but may not have completed a scan yet.
            if !snap.plan_session_id.is_empty() {
                return Some(snap);
            }
        }
    }
    let db = store.database();
    let row = db.get_orchestration(&plan_session_id)?;
    let run_state = row.run_state.clone();
    let live = is_live_run_state(run_state.as_deref());
    let mut ctx = WatchCtx::new(row);
    scan_once(&db, &mut ctx, true, live);
    ctx.snap.run_state = run_state;
    ctx.snap.updated_at = crate::ledger::now_millis();
    Some(ctx.snap)
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    ToolUse { name: String, summary: String },
    #[serde(rename_all = "camelCase")]
    ToolResult { summary: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTailResult {
    pub events: Vec<AgentEvent>,
    pub next_cursor: u64,
    pub truncated: bool,
}

/// Summarize a tool call's input down to the one telling field.
fn summarize_tool_input(input: &serde_json::Value) -> String {
    for key in ["file_path", "command", "pattern", "prompt", "url", "path", "query", "description"] {
        if let Some(s) = input.get(key).and_then(serde_json::Value::as_str) {
            if !s.trim().is_empty() {
                return preview(s, 200);
            }
        }
    }
    preview(&input.to_string(), 200)
}

/// Parse transcript lines into drawer events. Thinking is elided; tool
/// inputs are summarized.
pub(crate) fn parse_agent_events(lines: &[String]) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("type").and_then(serde_json::Value::as_str) {
            Some("assistant") => {
                let Some(blocks) = v.pointer("/message/content").and_then(serde_json::Value::as_array)
                else {
                    continue;
                };
                for b in blocks {
                    match b.get("type").and_then(serde_json::Value::as_str) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(serde_json::Value::as_str) {
                                if !t.trim().is_empty() {
                                    events.push(AgentEvent::Text {
                                        text: t.chars().take(4000).collect(),
                                    });
                                }
                            }
                        }
                        Some("tool_use") => {
                            events.push(AgentEvent::ToolUse {
                                name: b
                                    .get("name")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string(),
                                summary: b
                                    .get("input")
                                    .map(summarize_tool_input)
                                    .unwrap_or_default(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                let Some(blocks) = v.pointer("/message/content").and_then(serde_json::Value::as_array)
                else {
                    continue; // line 1's plain-string prompt is not an event
                };
                for b in blocks {
                    if b.get("type").and_then(serde_json::Value::as_str) == Some("tool_result") {
                        let summary = match b.get("content") {
                            Some(serde_json::Value::String(s)) => preview(s, 300),
                            Some(serde_json::Value::Array(arr)) => {
                                let text: String = arr
                                    .iter()
                                    .filter_map(|c| c.get("text").and_then(serde_json::Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                preview(&text, 300)
                            }
                            _ => String::new(),
                        };
                        events.push(AgentEvent::ToolResult { summary });
                    }
                }
            }
            _ => {}
        }
    }
    events
}

/// Cursor-polled tail of one agent's transcript — the drawer's stream.
/// Polled only while a drawer is open; `cursor: None` starts at the last
/// 128 KB.
#[tauri::command]
pub fn orchestration_agent_tail(
    store: tauri::State<'_, SessionStore>,
    plan_session_id: String,
    agent_id: String,
    cursor: Option<u64>,
) -> Result<AgentTailResult, String> {
    if !valid_agent_id(&agent_id) {
        return Err("bad agent id".to_string());
    }
    let db = store.database();
    let row = db
        .get_orchestration(&plan_session_id)
        .ok_or_else(|| "no orchestration for that session".to_string())?;
    let session_dir = PathBuf::from(&row.transcript_path).with_extension("");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &row.transcript_dir {
        candidates.push(PathBuf::from(dir).join(format!("agent-{agent_id}.jsonl")));
    }
    candidates.push(session_dir.join("subagents").join(format!("agent-{agent_id}.jsonl")));
    let path = candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "agent transcript not found".to_string())?;

    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut truncated = false;
    let mut start = match cursor {
        Some(c) if c <= len => c,
        Some(_) => 0, // file replaced underneath us — restart
        None => {
            truncated = len > TAIL_WINDOW;
            len.saturating_sub(TAIL_WINDOW)
        }
    };
    if start == len {
        return Ok(AgentTailResult {
            events: Vec::new(),
            next_cursor: len,
            truncated: false,
        });
    }
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let to_read = (len - start).min(TAIL_CALL_CAP);
    let mut buf = vec![0u8; to_read as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // A mid-file start lands mid-line: begin after the first newline.
    let mut body: &str = &text;
    if start > 0 && cursor.is_none() {
        match body.find('\n') {
            Some(i) => {
                start += (i + 1) as u64;
                body = &text[i + 1..];
            }
            None => {
                return Ok(AgentTailResult {
                    events: Vec::new(),
                    next_cursor: len,
                    truncated,
                });
            }
        }
    }
    // Complete lines only; a torn trailing line is re-read next poll.
    let mut consumed = 0usize;
    let mut lines: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find('\n') {
        lines.push(rest[..i].trim_end_matches('\r').to_string());
        consumed += i + 1;
        rest = &rest[i + 1..];
        if lines.len() >= TAIL_EVENT_CAP {
            break;
        }
    }
    let events = parse_agent_events(&lines);
    Ok(AgentTailResult {
        events,
        next_cursor: start + consumed as u64,
        truncated,
    })
}

// --- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/golden/runwatch")
            .join(name);
        std::fs::read_to_string(path).expect("fixture")
    }

    #[test]
    fn parse_workflow_launch_reads_the_real_tool_result_line() {
        let line = fixture("parent_launch_line.jsonl");
        let launch = parse_workflow_launch(&line).expect("launch facts");
        assert_eq!(launch.run_id, "wf_c82ac4f1-bc0");
        assert!(launch
            .transcript_dir
            .ends_with("subagents/workflows/wf_c82ac4f1-bc0"));
        assert!(launch.script_path.unwrap().ends_with("streaming-chat-step1-wf_c82ac4f1-bc0.js"));
        assert_eq!(launch.task_id.as_deref(), Some("wlx8kjxvl"));
        assert_eq!(parse_workflow_launch("no run id here"), None);
        // A prose mention with a non-id value must not parse.
        assert_eq!(parse_workflow_launch("the Run ID: TBD later"), None);
    }

    #[test]
    fn journal_pairing_started_result_cached_failed_and_malformed_skip() {
        let mut snap = RunSnapshot::default();
        for line in fixture("journal.jsonl").lines() {
            apply_journal_line(&mut snap, line);
        }
        let state = |id: &str| {
            snap.agents
                .iter()
                .find(|t| t.agent_id == id)
                .map(|t| t.state.clone())
                .unwrap()
        };
        assert_eq!(snap.agents.len(), 7); // the malformed line adds nothing
        assert_eq!(state("a5e56841c453d5d8b"), "done");
        assert_eq!(state("a30af5ce428feeb89"), "done");
        assert_eq!(state("ae949f13b63e0bd4d"), "done");
        assert_eq!(state("a1e12fea5e9d56554"), "done");
        // started with no result yet = the liveness primitive.
        assert_eq!(state("a0f67ee297c91d36b"), "running");
        // result-only = cached (resumed run).
        assert_eq!(state("acafe12345678900d"), "cached");
        // explicit error key = the one mid-run failure signal.
        assert_eq!(state("adead12345678900e"), "failed");
        let cached = snap.agents.iter().find(|t| t.agent_id == "acafe12345678900d").unwrap();
        assert_eq!(cached.files_changed, vec!["src/cached.ts".to_string()]);
        let real = snap.agents.iter().find(|t| t.agent_id == "a5e56841c453d5d8b").unwrap();
        assert!(!real.files_changed.is_empty(), "real result carries filesChanged");
        assert!(real.result_preview.as_deref().unwrap_or("").len() > 10);
        snap.recompute_totals();
        assert_eq!(snap.totals.running, 1);
        assert_eq!(snap.totals.failed, 1);
        assert_eq!(snap.totals.done, 5); // 4 done + 1 cached
    }

    #[test]
    fn extract_script_meta_reads_the_real_meta_block() {
        let src = fixture("script.js");
        let meta = extract_script_meta(&src).expect("meta");
        assert_eq!(meta.name.as_deref(), Some("streaming-chat-step1"));
        assert!(meta.description.unwrap().contains("AI SDK v6"));
        assert_eq!(meta.phases.len(), 5);
        assert_eq!(meta.phases[0].title, "Foundations");
        assert!(meta.phases[0].detail.as_deref().unwrap().contains("SQL migration"));
        assert_eq!(meta.phases[4].title, "Verification");
    }

    #[test]
    fn extract_script_meta_is_lenient_and_rejects_garbage() {
        let lenient = r#"
            export const meta = {
              name: "double-quoted",
              description: 'trailing comma below',
              phases: [
                { title: 'One', detail: 'first', },
                { title: "Two" },
              ],
            }
        "#;
        let meta = extract_script_meta(lenient).expect("lenient meta");
        assert_eq!(meta.name.as_deref(), Some("double-quoted"));
        assert_eq!(meta.phases.len(), 2);
        assert_eq!(meta.phases[1].title, "Two");
        assert_eq!(meta.phases[1].detail, None);
        assert!(extract_script_meta("function foo() { return 1 }").is_none());
        assert!(extract_script_meta("export const meta = {").is_none());
    }

    #[test]
    fn extract_agent_calls_counts_sites_and_reads_labels() {
        let src = fixture("script.js");
        let calls = extract_agent_calls(&src);
        assert_eq!(calls.len(), 10, "10 agent() call sites in the fixture script");
        let labels: Vec<_> = calls.iter().filter_map(|c| c.label.as_deref()).collect();
        assert!(labels.contains(&"build:frontend-modules"));
        assert!(labels.contains(&"verify:browser-smoke"));
        // The identifier-arg sites carry their assignment's literal evidence
        // (the longest literal of the prompt-building statement).
        let client_build = calls
            .iter()
            .find(|c| c.label.as_deref() == Some("build:client-refactor"))
            .expect("client-refactor call site");
        assert!(client_build.literal.as_deref().map_or(false, |l| l.len() >= 16));
    }

    #[test]
    fn guess_label_matches_the_real_prompt_to_its_call_site() {
        let src = fixture("script.js");
        let calls = extract_agent_calls(&src);
        let head = fixture("agent_head.jsonl");
        let first = head.lines().next().unwrap();
        let v: serde_json::Value = serde_json::from_str(first).unwrap();
        let prompt = v.pointer("/message/content").unwrap().as_str().unwrap();
        let (label, phase) = guess_label(prompt, &calls).expect("label match");
        assert_eq!(label, "build:client-refactor");
        assert_eq!(phase.as_deref(), Some("Client refactor"));
        // A prompt matching nothing falls back to preview (None).
        assert!(guess_label("completely unrelated text", &calls).is_none());
    }

    #[test]
    fn apply_agent_line_sums_usage_and_tracks_tools() {
        let mut tile = AgentTile::new("a13046496e0682a9d", "running");
        let mut aux = AgentAux::default();
        for line in fixture("agent_head.jsonl").lines() {
            apply_agent_line(&mut tile, &mut aux, line);
        }
        assert_eq!(tile.input_tokens, 12);
        assert_eq!(tile.output_tokens, 454);
        assert_eq!(tile.cache_read_tokens, 95298);
        assert_eq!(tile.cache_creation_tokens, 103574);
        assert_eq!(tile.tool_calls, 3);
        assert_eq!(tile.last_tool_name.as_deref(), Some("Bash"));
        assert_eq!(tile.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(tile.effort.as_deref(), Some("xhigh"));
        assert_eq!(tile.started_at, iso_millis("2026-08-07T11:09:26.237Z"));
        assert!(tile.prompt_preview.as_deref().unwrap().starts_with("Repo root:"));
        assert!(tile.last_activity_at.unwrap() > tile.started_at.unwrap());
        assert!(tile.duration_ms.unwrap() > 0);
        assert!(aux.prompt.contains("client-side chat UI refactor"));
    }

    #[test]
    fn torn_line_two_chunk_feed_equals_whole_file() {
        let dir = std::env::temp_dir().join(format!("rl-runwatch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chunks.jsonl");
        let whole = "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n";
        // Whole-file read.
        std::fs::write(&path, whole).unwrap();
        let mut cur = Cursor::default();
        let (all, _) = read_new_lines(&path, &mut cur, PER_TICK_CAP);
        assert_eq!(all.len(), 3);
        // Two-chunk feed torn mid-line.
        std::fs::write(&path, &whole[..11]).unwrap(); // "...{\"b\""
        let mut cur = Cursor::default();
        let (first, _) = read_new_lines(&path, &mut cur, PER_TICK_CAP);
        assert_eq!(first, vec!["{\"a\":1}".to_string()]);
        std::fs::write(&path, whole).unwrap();
        let (second, _) = read_new_lines(&path, &mut cur, PER_TICK_CAP);
        assert_eq!(second, vec!["{\"b\":2}".to_string(), "{\"c\":3}".to_string()]);
        let mut joined = first;
        joined.extend(second);
        assert_eq!(joined, all);
        // Over-cap growth: seeks to tail, drops the torn first line, reports.
        let mut cur = Cursor::default();
        let (tail, skipped) = read_new_lines(&path, &mut cur, 10);
        assert!(skipped > 0);
        assert_eq!(tail, vec!["{\"c\":3}".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn manifest_backfill_overrides_heuristics() {
        let parsed = parse_manifest(&fixture("manifest.json")).expect("manifest");
        assert_eq!(parsed.info.status, "completed");
        assert_eq!(parsed.info.duration_ms, Some(2_900_819));
        assert_eq!(parsed.info.agent_count, Some(14));
        assert_eq!(parsed.info.total_tokens, Some(887_191));
        assert_eq!(parsed.info.total_tool_calls, Some(427));
        assert_eq!(parsed.workflow_name.as_deref(), Some("streaming-chat-step1"));
        assert_eq!(parsed.phases.len(), 5);
        assert_eq!(parsed.agents.len(), 14);

        // Pre-seed a tile with heuristic facts; the manifest must win.
        let mut snap = RunSnapshot::default();
        {
            let tile = snap.tile_mut("ae949f13b63e0bd4d", "running");
            tile.label = Some("guessed".to_string());
            tile.label_source = "script".to_string();
        }
        apply_manifest(&mut snap, &parsed);
        let tile = snap.agents.iter().find(|t| t.agent_id == "ae949f13b63e0bd4d").unwrap();
        assert_eq!(tile.label.as_deref(), Some("build:migration+env"));
        assert_eq!(tile.label_source, "manifest");
        assert_eq!(tile.phase.as_deref(), Some("Foundations"));
        assert_eq!(tile.state, "done");
        assert_eq!(snap.agents.len(), 14);
        assert_eq!(snap.mode, "workflow");
        assert!(snap.manifest.is_some());
        assert_eq!(snap.totals.done, 14);
    }

    #[test]
    fn parse_agent_events_summarizes_tools_and_elides_thinking() {
        let lines: Vec<String> = fixture("agent_head.jsonl").lines().map(str::to_string).collect();
        let events = parse_agent_events(&lines);
        assert!(events.len() >= 6, "3 tool_use + 3 tool_result + 1 text");
        let tools: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolUse { name, summary } => Some((name.clone(), summary.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(tools.len(), 3);
        assert!(tools.iter().any(|(n, s)| n == "Read" && s.contains("LeadDetailPanel")));
        assert!(matches!(events.last(), Some(AgentEvent::Text { .. })));
        // No thinking blocks leak through.
        let json = serde_json::to_string(&events).unwrap();
        assert!(!json.contains("signature"));
        // Serialized tag shape the FE consumes.
        assert!(json.contains("\"kind\":\"toolUse\""));
    }

    /// The History tab's one-shot reconstruction, end to end: a synthetic
    /// session dir assembled from the real-run fixtures (parent transcript →
    /// discovery; script → meta + call sites; journal → liveness; agent file
    /// → usage; manifest → authoritative backfill), scanned cold.
    #[test]
    fn one_shot_reconstruction_from_a_synthetic_session_dir() {
        let root = std::env::temp_dir().join(format!("rl-runwatch-e2e-{}", uuid::Uuid::new_v4()));
        let session_dir = root.join("sess");
        let run_dir = session_dir.join("subagents/workflows/wf_c82ac4f1-bc0");
        let scripts_dir = session_dir.join("workflows/scripts");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::create_dir_all(&scripts_dir).unwrap();
        // Re-home the launch line's absolute paths into the temp layout.
        let real_prefix = "/Users/yusufalbazian/.claude/projects/-Users-yusufalbazian-securitieslist-beta/1fa67bd8-6835-4cf7-9d2d-94234c0835df";
        let launch = fixture("parent_launch_line.jsonl")
            .replace(real_prefix, &session_dir.to_string_lossy());
        let parent = root.join("sess.jsonl");
        std::fs::write(&parent, launch).unwrap();
        std::fs::write(run_dir.join("journal.jsonl"), fixture("journal.jsonl")).unwrap();
        std::fs::write(
            run_dir.join("agent-a13046496e0682a9d.jsonl"),
            fixture("agent_head.jsonl"),
        )
        .unwrap();
        std::fs::write(
            scripts_dir.join("streaming-chat-step1-wf_c82ac4f1-bc0.js"),
            fixture("script.js"),
        )
        .unwrap();
        std::fs::write(
            session_dir.join("workflows/wf_c82ac4f1-bc0.json"),
            fixture("manifest.json"),
        )
        .unwrap();

        let db = db::Database::open_in_memory().unwrap();
        db.upsert_orchestration("p1", "sess", &parent.to_string_lossy(), None, None)
            .unwrap();
        let row = db.get_orchestration("p1").unwrap();
        let mut ctx = WatchCtx::new(row);
        scan_once(&db, &mut ctx, true, false);
        let snap = &ctx.snap;

        assert_eq!(snap.mode, "workflow");
        assert_eq!(snap.run_id.as_deref(), Some("wf_c82ac4f1-bc0"));
        assert_eq!(snap.workflow_name.as_deref(), Some("streaming-chat-step1"));
        assert_eq!(snap.phases.len(), 5);
        assert!(snap.manifest.is_some());
        // 14 manifest agents + the 2 synthesized journal-only ones.
        assert_eq!(snap.agents.len(), 16);
        let a13 = snap
            .agents
            .iter()
            .find(|t| t.agent_id == "a13046496e0682a9d")
            .unwrap();
        assert_eq!(a13.label.as_deref(), Some("build:client-refactor"));
        assert_eq!(a13.label_source, "manifest");
        assert_eq!(a13.state, "done");
        assert!(a13.output_tokens > 0, "usage folded from the agent transcript");
        // Discovery persisted for the next (warm) scan.
        let row = db.get_orchestration("p1").unwrap();
        assert_eq!(row.mode.as_deref(), Some("workflow"));
        assert!(row.transcript_dir.is_some());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn model_matching_handles_aliases_and_full_ids() {
        assert!(model_matches("claude-sonnet-5", "claude-sonnet-5"));
        assert!(model_matches("sonnet", "claude-sonnet-5"));
        assert!(model_matches("haiku", "claude-haiku-4-5"));
        assert!(model_matches("HAIKU", "Claude-Haiku-4-5"));
        assert!(!model_matches("opus", "claude-sonnet-5"));
        // No substring false-positives: only whole `-` segments match.
        assert!(!model_matches("son", "claude-sonnet-5"));
        assert!(!model_matches("", "claude-sonnet-5"));
        assert!(!model_matches("sonnet", ""));
    }

    #[test]
    fn degradation_detection_is_conservative() {
        // Fallback observed while primary was asked for = degraded.
        assert!(detect_degraded(Some("claude-haiku-4-5"), Some("opus"), Some("haiku")));
        // Primary observed = healthy.
        assert!(!detect_degraded(Some("claude-opus-4-6"), Some("opus"), Some("haiku")));
        // A model matching NEITHER is not flagged — never cry wolf on a
        // model we merely don't recognize.
        assert!(!detect_degraded(Some("claude-sonnet-5"), Some("opus"), Some("haiku")));
        // Missing any leg of the comparison = not degradation.
        assert!(!detect_degraded(None, Some("opus"), Some("haiku")));
        assert!(!detect_degraded(Some("claude-haiku-4-5"), None, Some("haiku")));
        assert!(!detect_degraded(Some("claude-haiku-4-5"), Some("opus"), None));
        // primary == fallback misconfig can never read as degraded.
        assert!(!detect_degraded(Some("claude-haiku-4-5"), Some("haiku"), Some("haiku")));
    }

    #[test]
    fn apply_degradation_marks_tiles_notes_once_and_counts_in_totals() {
        let mut snap = RunSnapshot::default();
        snap.tile_mut("a1", "running").model = Some("claude-haiku-4-5".to_string());
        snap.tile_mut("a2", "running").model = Some("claude-opus-4-6".to_string());
        snap.tile_mut("a3", "running"); // no model observed yet
        assert!(apply_degradation(&mut snap, Some("opus"), Some("haiku")));
        assert!(snap.agents[0].degraded);
        assert!(!snap.agents[1].degraded);
        assert!(!snap.agents[2].degraded);
        // Exactly ONE degradation note per run, naming both models.
        let notes: Vec<_> = snap.notes.iter().filter(|n| n.contains("degraded")).collect();
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("'opus'") && notes[0].contains("'haiku'"));
        // Re-applying the same facts changes nothing and adds no second note.
        assert!(!apply_degradation(&mut snap, Some("opus"), Some("haiku")));
        assert_eq!(snap.notes.iter().filter(|n| n.contains("degraded")).count(), 1);
        // The serialized totals carry the count for the FE payload.
        snap.recompute_totals();
        assert_eq!(snap.totals.degraded, 1);
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"degraded\":true"));
        assert!(json.contains("\"degraded\":1"));
        // A manifest backfill correcting the model back to primary clears it.
        snap.agents[0].model = Some("claude-opus-4-6".to_string());
        assert!(apply_degradation(&mut snap, Some("opus"), Some("haiku")));
        assert!(!snap.agents[0].degraded);
        // An unconfigured seat (no primary/fallback) never degrades anything.
        assert!(!apply_degradation(&mut snap, None, None));
    }

    #[test]
    fn burn_facts_sum_tiles_and_count_spawns() {
        let mut snap = RunSnapshot::default();
        {
            let t = snap.tile_mut("a1", "running");
            t.input_tokens = 10;
            t.output_tokens = 20;
            t.cache_read_tokens = 30;
            t.cache_creation_tokens = 40;
        }
        {
            let t = snap.tile_mut("a2", "done");
            t.input_tokens = 1;
            t.output_tokens = 2;
        }
        let f = burn_facts(&snap);
        assert_eq!(
            f,
            BurnFacts {
                input_tokens: 11,
                output_tokens: 22,
                cache_read_tokens: 30,
                cache_creation_tokens: 40,
                spawns: 2,
            }
        );
        assert_eq!(burn_facts(&RunSnapshot::default()), BurnFacts::default());
    }

    /// The idempotency contract: a watcher that re-reads the same transcript
    /// (restart, cursor reset, capped catch-up) must never double-book.
    #[test]
    fn flush_seat_burn_books_deltas_idempotently() {
        let db = db::Database::open_in_memory().unwrap();
        let totals = |db: &db::Database| {
            db.seat_burn_totals_by_seat()
                .unwrap()
                .into_iter()
                .find(|r| r.seat.as_deref() == Some("orchestrator"))
                .unwrap()
        };
        let mut snap = RunSnapshot::default();
        {
            let t = snap.tile_mut("a1", "running");
            t.input_tokens = 100;
            t.output_tokens = 50;
            t.cache_read_tokens = 10;
            t.cache_creation_tokens = 5;
        }
        // First flush books everything.
        assert!(flush_seat_burn(&db, "orchestrator", "sid-1", &snap, "2026-08-12"));
        let t = totals(&db);
        assert_eq!((t.input_tokens, t.output_tokens, t.spawns), (100, 50, 1));
        // Re-flushing the SAME facts books nothing.
        assert!(!flush_seat_burn(&db, "orchestrator", "sid-1", &snap, "2026-08-12"));
        assert_eq!(totals(&db).input_tokens, 100);
        // Growth books only the delta — landing on the day it is observed.
        snap.agents[0].input_tokens = 160;
        snap.tile_mut("a2", "running").output_tokens = 7;
        assert!(flush_seat_burn(&db, "orchestrator", "sid-1", &snap, "2026-08-13"));
        let t = totals(&db);
        assert_eq!((t.input_tokens, t.output_tokens, t.spawns), (160, 57, 2));
        // A watcher restart rebuilds the same totals from byte 0 — the
        // persisted mark still books zero.
        let mut rebuilt = RunSnapshot::default();
        {
            let t = rebuilt.tile_mut("a1", "running");
            t.input_tokens = 160;
            t.output_tokens = 50;
            t.cache_read_tokens = 10;
            t.cache_creation_tokens = 5;
        }
        rebuilt.tile_mut("a2", "running").output_tokens = 7;
        assert!(!flush_seat_burn(&db, "orchestrator", "sid-1", &rebuilt, "2026-08-13"));
        assert_eq!(totals(&db).input_tokens, 160);
        // A capped catch-up briefly rebuilds BELOW the mark: books nothing,
        // and the mark does not regress…
        let mut partial = RunSnapshot::default();
        partial.tile_mut("a1", "running").input_tokens = 40;
        assert!(!flush_seat_burn(&db, "orchestrator", "sid-1", &partial, "2026-08-13"));
        assert_eq!(totals(&db).input_tokens, 160);
        // …so a later full read past the mark books only the excess.
        let mut full = RunSnapshot::default();
        {
            let t = full.tile_mut("a1", "running");
            t.input_tokens = 200;
            t.output_tokens = 57;
            t.cache_read_tokens = 10;
            t.cache_creation_tokens = 5;
        }
        full.tile_mut("a2", "running");
        assert!(flush_seat_burn(&db, "orchestrator", "sid-1", &full, "2026-08-13"));
        assert_eq!(totals(&db).input_tokens, 200);
        // A re-run mints a new claude session: fresh mark, counted anew.
        let mut fresh = RunSnapshot::default();
        fresh.tile_mut("a9", "running").input_tokens = 5;
        assert!(flush_seat_burn(&db, "orchestrator", "sid-2", &fresh, "2026-08-13"));
        assert_eq!(totals(&db).input_tokens, 205);
        // An empty claude session id books nothing (no key to mark against).
        assert!(!flush_seat_burn(&db, "orchestrator", "", &fresh, "2026-08-13"));
    }

    #[test]
    fn run_burn_attributes_to_a_known_seat_via_the_row() {
        let db = db::Database::open_in_memory().unwrap();
        db.upsert_orchestration("p1", "sess", "/tmp/x.jsonl", None, None)
            .unwrap();
        let row = db.get_orchestration("p1").unwrap();
        let seat = seat_for_run(&row);
        // Orchestrations are spawned by the orchestrator seat today, and the
        // derived seat must be a real roster seat (KNOWN_SEATS), never junk.
        assert_eq!(seat, "orchestrator");
        assert!(crate::seat::KNOWN_SEATS.contains(&seat.as_str()));
    }

    #[test]
    fn day_key_formatting() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(-1), "1969-12-31");
        assert_eq!(
            utc_day(iso_millis("2026-08-07T11:09:26.237Z").unwrap()),
            "2026-08-07"
        );
        assert_eq!(
            utc_day(iso_millis("2026-12-31T23:59:59.999Z").unwrap()),
            "2026-12-31"
        );
        // local_day: the zone under test varies by machine, so assert the
        // shape and that it stays within a calendar day of the UTC answer.
        let ms = 1_786_100_966_237;
        let local = local_day(ms);
        assert_eq!(local.len(), 10);
        assert_eq!(&local[4..5], "-");
        assert_eq!(&local[7..8], "-");
        let candidates = [utc_day(ms - 86_400_000), utc_day(ms), utc_day(ms + 86_400_000)];
        assert!(candidates.contains(&local));
    }

    #[test]
    fn iso_millis_known_values() {
        assert_eq!(iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_millis("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(iso_millis("2026-08-07T11:09:26.237Z"), Some(1_786_100_966_237));
        assert_eq!(iso_millis("garbage"), None);
        assert_eq!(iso_millis("2026-13-07T11:09:26Z"), None);
    }

    #[test]
    fn agent_id_guard() {
        assert!(valid_agent_id("a13046496e0682a9d"));
        assert!(!valid_agent_id("a13046496e0682a9")); // too short
        assert!(!valid_agent_id("b13046496e0682a9d")); // wrong prefix
        assert!(!valid_agent_id("a13046496E0682A9D")); // uppercase
        assert!(!valid_agent_id("a/../../etc/passwd"));
    }

    #[test]
    fn live_run_states() {
        assert!(is_live_run_state(Some("orchestrating")));
        assert!(is_live_run_state(Some("running")));
        assert!(is_live_run_state(Some("in_code_review")));
        assert!(!is_live_run_state(Some("landed")));
        assert!(!is_live_run_state(Some("stalled")));
        // A stand-down is terminal: the watcher exits and boot rehydration
        // must skip it, or an abandoned run would resurrect on restart.
        assert!(!is_live_run_state(Some("abandoned")));
        assert!(!is_live_run_state(None));
    }
}

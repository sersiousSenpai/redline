// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The ONE accounting rule for everything Redline's agents spend.
//!
//! Two feeds carry usage into the app and they disagree about where the
//! numbers live (Experiment (j), `docs/protocol-verification.md`):
//!
//! - **stdout** (`--output-format stream-json`, ~20 headless seats). Its
//!   `assistant` lines are message-*start* snapshots — `output_tokens` reads
//!   `2` on a message that finished at `134`. The real per-message totals ride
//!   `stream_event`/`message_delta`, which carries no `message.id` of its own.
//! - **transcripts** (the PTY plan session, and `runwatch`'s per-agent
//!   `agent-<id>.jsonl`). Here the `assistant` lines DO carry final usage —
//!   and repeat the same `message.id` once per content block.
//!
//! Both hazards are the same hazard: usage is **cumulative per message**, so
//! anything that `+=` per line over-reports. Measured on this repo's own
//! `tests/golden/runwatch/agent_head.jsonl`, the summing version reports
//! 103,574 cache-creation tokens against a true 38,847 — **2.7× inflated**.
//!
//! [`TurnMeter::observe`] is therefore the only place in the codebase allowed
//! to read a `usage` object. `runwatch` delegates to it, the stream readers
//! delegate to it, and the transcript tailer delegates to it, so a third copy
//! of the rule can't drift back in.
//!
//! ### The rule
//!
//! Key every usage object by its `message.id` and keep the **per-field max**
//! for that id — never a sum. Max rather than "newest wins" because it is
//! order-independent: within one message id, `input`/`cache_read`/
//! `cache_creation` are identical between the snapshot and the final, and
//! `output_tokens` only grows. A reader that sees `assistant` before
//! `message_delta` (stdout's observed order) and one that sees only
//! `assistant` lines (a transcript) converge on the same totals.
//!
//! Tool calls dedupe the same way, on `toolu_…` ids — `content_block_start`
//! announces the call and the `assistant` line repeats it, and both feeds must
//! land on one count.
//!
//! ### What the terminal `result` line changes
//!
//! `result.usage` is authoritative: on the reference capture it equals the sum
//! of the per-message finals exactly. It is **adopted** (replacing the fold)
//! when non-zero. When it is all zeros it is ignored — an errored `result`
//! reports zeroed usage, and a turn that failed mid-flight really did spend
//! what the fold already counted. An under-report is worse than a zero.
//!
//! `result.modelUsage[model].contextWindow` states the model's window as fact,
//! which is what makes the context-pressure readout trustworthy instead of a
//! guess from the model id.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One message's usage, as last observed. Every field is monotone within a
/// `message.id`, which is what makes the per-field max sound.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MsgUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

impl MsgUsage {
    /// Context occupancy this message saw: everything the model had to read.
    /// `input_tokens` alone reads `2` on a real turn — the prompt is almost
    /// entirely cache — so the honest number is the sum.
    fn occupancy(&self) -> u64 {
        self.input
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_creation)
    }

    fn merge_max(&mut self, other: &MsgUsage) -> bool {
        let before = *self;
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_read = self.cache_read.max(other.cache_read);
        self.cache_creation = self.cache_creation.max(other.cache_creation);
        *self != before
    }

    fn from_usage(u: &Value) -> MsgUsage {
        let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        MsgUsage {
            input: g("input_tokens"),
            output: g("output_tokens"),
            cache_read: g("cache_read_input_tokens"),
            cache_creation: g("cache_creation_input_tokens"),
        }
    }

    fn is_zero(&self) -> bool {
        *self == MsgUsage::default()
    }
}

/// Longest activity label kept. Rule 2 (`docs/perf-budget.md`) forbids
/// unbounded content on a buffered stream, and a tool argument is arbitrary.
pub const ACTIVITY_LABEL_CAP: usize = 160;

/// One thing the turn was doing while you waited. The whole point of "show
/// more of the real stream": today a 40-second retrieval renders as a pulsing
/// logo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub at: i64,
    /// `requesting` | `thinking` | `tool` | `rateLimit` — the frontend picks
    /// the icon and tone from this, never by matching on the label text.
    pub kind: String,
    pub label: String,
}

/// The one activity entry (if any) a freshly folded line earned, given the
/// meter before and after. Ordered by how much the user needs it: a stall
/// beats a tool call beats thinking beats a bare request.
pub fn activity_from(
    v: &Value,
    before: &TurnMeter,
    after: &TurnMeter,
    at: i64,
) -> Option<Activity> {
    let entry = |kind: &str, label: String| {
        Some(Activity {
            at,
            kind: kind.to_string(),
            label: label.chars().take(ACTIVITY_LABEL_CAP).collect(),
        })
    };
    if after.rate_limited != before.rate_limited {
        if let Some(rl) = &after.rate_limited {
            let window = rl.kind.as_deref().unwrap_or("usage");
            return entry("rateLimit", format!("Rate limited ({window}) · waiting"));
        }
    }
    if after.tool_calls > before.tool_calls {
        return entry(
            "tool",
            after
                .last_tool_label
                .clone()
                .or_else(|| after.last_tool.clone())
                .unwrap_or_else(|| "working…".to_string()),
        );
    }
    if after.thinking_tokens > before.thinking_tokens {
        return entry("thinking", "Thinking…".to_string());
    }
    // `system`/`status` isn't a usage fact, so the meter ignores it — but it
    // is the EARLIEST signal there is, ahead of the first token.
    if v.get("type").and_then(Value::as_str) == Some("system")
        && v.get("subtype").and_then(Value::as_str) == Some("status")
        && v.get("status").and_then(Value::as_str) == Some("requesting")
    {
        return entry("requesting", "Requesting…".to_string());
    }
    None
}

/// An OUTSTANDING rate limit — the dead air the activity line exists to fill.
///
/// Deliberately not "a `rate_limit_event` arrived": every captured turn emits
/// one, including a 1.4-second one, with `status: "allowed"`. Only a status
/// that is *not* `allowed` means the turn is actually waiting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    /// The CLI's own word — `rejected`, `warning`, … Never `allowed`.
    pub status: String,
    /// Unix **seconds** (the CLI's unit, not millis) when the window resets.
    pub resets_at: Option<i64>,
    /// `five_hour`, `weekly`, … as the CLI names the window.
    pub kind: Option<String>,
}

/// Everything one turn spent, and what produced it. Serialized straight to the
/// frontend (`TurnMeter` in `src/lib/turnMeter.ts`) and persisted as the
/// `meter_json` column on a settled message row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnMeter {
    /// The model that ACTUALLY answered, off `message_start`/`assistant`. Not
    /// the configured seat override — this is the only field that reveals a
    /// `--fallback-model` swap.
    ///
    /// The ONE exception is the Codex arm ([`from_codex_turn`]), whose
    /// protocol reports no model to observe; there this carries the configured
    /// one, because a badge that says which model was asked for beats no badge
    /// at all.
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Free provenance: it rides the same `usage` object the token read
    /// already touches.
    pub service_tier: Option<String>,
    pub speed: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// High-water context occupancy: max over messages of
    /// (input + cache_read + cache_creation). NOT derived from the adopted
    /// `result.usage`, whose sum over messages is a spend total, not an
    /// occupancy.
    pub context_tokens: u64,
    /// The window the model actually had, stated by the CLI
    /// (`result.modelUsage[model].contextWindow`). `None` until the terminal
    /// line lands; the frontend falls back to its model table until then.
    pub context_window: Option<u64>,
    pub tool_calls: u64,
    /// The raw tool NAME (`Bash`, `Grep`) — what a chip and the Runs tile show.
    pub last_tool: Option<String>,
    /// The same call as a human phrase ("searching the lake…") for the
    /// activity line. Sharpens once the arguments arrive: `content_block_start`
    /// can only say "Grep", the `assistant` line says which pattern.
    pub last_tool_label: Option<String>,
    /// Best estimate of thinking tokens spent — the only thinking signal
    /// available. `thinking_delta.thinking` is always the empty string.
    pub thinking_tokens: Option<u64>,
    /// `end_turn` | `max_tokens` | `tool_use` | … `max_tokens` means the reply
    /// was TRUNCATED, which today looks byte-for-byte like a complete one.
    pub stop_reason: Option<String>,
    /// Set while a rate limit is outstanding; cleared by the next allowed
    /// event or the next text delta.
    pub rate_limited: Option<RateLimit>,
    pub num_turns: Option<u64>,
    pub duration_ms: Option<u64>,
    /// The CLI's own `total_cost_usd`. Recorded, never persisted to a schema
    /// column: `db.rs` legislates tokens only, money at display time.
    pub cost_usd: Option<f64>,
    /// Bumped on every observed change. The frontend drops any meter event
    /// with `rev <= current` — monotone, the same soundness argument as the
    /// delta `seq` guard.
    pub rev: u64,
    /// `message.id` -> last usage. THE dedupe.
    #[serde(skip)]
    seen: HashMap<String, MsgUsage>,
    /// The message a bare `message_delta` (which carries no id) belongs to.
    #[serde(skip)]
    current_msg: Option<String>,
    /// `toolu_…` ids already counted, so the two feeds can't double-count.
    #[serde(skip)]
    tool_ids: HashSet<String>,
    /// `result.usage` was adopted — later folds no longer touch the totals.
    #[serde(skip)]
    settled: bool,
}

impl TurnMeter {
    pub fn new() -> Self {
        Self::default()
    }

    /// A meter carrying only totals — what a `polis_llm::Usage` becomes on
    /// its way to `book`. `rev` is 1 when anything was spent or a model was
    /// named, so `is_empty` and `total_tokens` answer exactly as they would
    /// for the observed meter the usage came from.
    pub fn from_totals(
        model: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
    ) -> Self {
        let mut m = Self::default();
        let spent = input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens > 0;
        m.model = model;
        m.input_tokens = input_tokens;
        m.output_tokens = output_tokens;
        m.cache_read_tokens = cache_read_tokens;
        m.cache_creation_tokens = cache_creation_tokens;
        if spent || m.model.is_some() {
            m.rev = 1;
        }
        m
    }

    /// Whether anything at all has been observed — an all-default meter is
    /// worth neither an event nor a `meter_json` row.
    pub fn is_empty(&self) -> bool {
        self.rev == 0
    }

    /// Bump `rev` for a change the meter itself doesn't record — an activity
    /// entry with no usage fact behind it (`system`/`status`). Without this
    /// the frontend's monotone `rev` guard would drop the event carrying it.
    pub fn bump_rev(&mut self) {
        self.rev += 1;
    }

    /// Total tokens the turn spent (what a rollup adds up).
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    /// Fold one parsed line in. Returns whether anything changed; the caller
    /// uses that to decide whether to emit. Unknown line types are ignored,
    /// which is what lets an interactive transcript (with its `mode`,
    /// `ai-title`, `attachment`, … lines) share this one reader.
    pub fn observe(&mut self, v: &Value) -> bool {
        let changed = match v.get("type").and_then(Value::as_str) {
            Some("system") => self.observe_system(v),
            Some("stream_event") => self.observe_stream_event(v.get("event").unwrap_or(&Value::Null)),
            Some("assistant") => self.observe_assistant(v),
            Some("rate_limit_event") => self.observe_rate_limit(v),
            Some("result") => self.observe_result(v),
            _ => false,
        };
        if changed {
            self.rev += 1;
        }
        changed
    }

    /// A DISCRETE change is one worth an immediate event rather than waiting
    /// for the next coalescing tick: the first model observation, a new tool
    /// call, a rate-limit onset, the terminal adoption. Compared against the
    /// meter as it was before the fold.
    pub fn is_discrete_change(&self, before: &TurnMeter) -> bool {
        self.model != before.model
            || self.tool_calls != before.tool_calls
            || self.rate_limited != before.rate_limited
            || self.stop_reason != before.stop_reason
            || self.settled != before.settled
    }

    fn observe_system(&mut self, v: &Value) -> bool {
        match v.get("subtype").and_then(Value::as_str) {
            // The CONFIGURED model, as a floor. An `assistant` line overwrites
            // it with the observed one the moment the first message starts.
            Some("init") => match v.get("model").and_then(Value::as_str) {
                Some(m) if self.model.is_none() => {
                    self.model = Some(m.to_string());
                    true
                }
                _ => false,
            },
            // The only quantitative thinking signal the CLI emits.
            Some("thinking_tokens") => {
                let est = v.get("estimated_tokens").and_then(Value::as_u64);
                self.bump_thinking(est)
            }
            _ => false,
        }
    }

    fn observe_stream_event(&mut self, e: &Value) -> bool {
        match e.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let m = e.get("message").unwrap_or(&Value::Null);
                let mut changed = self.take_model(m);
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    self.current_msg = Some(id.to_string());
                    if let Some(u) = m.get("usage") {
                        changed |= self.fold_usage(id, u);
                    }
                }
                changed
            }
            // Where a stdout turn's REAL per-message totals and its
            // `stop_reason` both live. It carries no id of its own, so it
            // attributes to the message `message_start` opened.
            Some("message_delta") => {
                let mut changed = false;
                if let Some(sr) = e
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                {
                    changed |= self.set_stop_reason(sr);
                }
                if let Some(u) = e.get("usage") {
                    if let Some(id) = self.current_msg.clone() {
                        changed |= self.fold_usage(&id, u);
                    }
                    changed |= self.bump_thinking(
                        u.pointer("/output_tokens_details/thinking_tokens")
                            .and_then(Value::as_u64),
                    );
                }
                changed
            }
            Some("content_block_start") => {
                let b = e.get("content_block").unwrap_or(&Value::Null);
                if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return false;
                }
                // The name lands here with an EMPTY `input` — the args stream
                // in afterwards. Worth taking anyway: it is the earliest the
                // activity line can name what the turn is doing.
                self.count_tool(
                    b.get("id").and_then(Value::as_str),
                    b.get("name").and_then(Value::as_str),
                    None,
                )
            }
            Some("content_block_delta") => {
                let d = e.get("delta").unwrap_or(&Value::Null);
                match d.get("type").and_then(Value::as_str) {
                    // `delta.thinking` is ALWAYS "" — only the estimate is real.
                    Some("thinking_delta") => {
                        self.bump_thinking(d.get("estimated_tokens").and_then(Value::as_u64))
                    }
                    // Text is flowing again, so any stall is over.
                    Some("text_delta") => self.clear_rate_limit(),
                    _ => false,
                }
            }
            _ => false,
        }
    }

    fn observe_assistant(&mut self, v: &Value) -> bool {
        let Some(m) = v.get("message") else {
            return false;
        };
        let mut changed = self.take_model(m);
        // Transcript lines carry `effort` at the TOP level, beside `message`.
        if let Some(effort) = v.get("effort").and_then(Value::as_str) {
            if self.effort.as_deref() != Some(effort) {
                self.effort = Some(effort.to_string());
                changed = true;
            }
        }
        if let Some(sr) = m.get("stop_reason").and_then(Value::as_str) {
            changed |= self.set_stop_reason(sr);
        }
        if let Some(id) = m.get("id").and_then(Value::as_str) {
            self.current_msg = Some(id.to_string());
            if let Some(u) = m.get("usage") {
                changed |= self.fold_usage(id, u);
            }
        }
        // The COMPLETE tool call — name and arguments both. Deduped against
        // the `content_block_start` that already announced it.
        for b in m
            .get("content")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                changed |= self.count_tool(
                    b.get("id").and_then(Value::as_str),
                    b.get("name").and_then(Value::as_str),
                    b.get("input"),
                );
            }
        }
        changed
    }

    fn observe_rate_limit(&mut self, v: &Value) -> bool {
        let info = v.get("rate_limit_info").unwrap_or(&Value::Null);
        let status = info.get("status").and_then(Value::as_str).unwrap_or("");
        if status.is_empty() || status == "allowed" {
            return self.clear_rate_limit();
        }
        let next = RateLimit {
            status: status.to_string(),
            resets_at: info.get("resetsAt").and_then(Value::as_i64),
            kind: info
                .get("rateLimitType")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        if self.rate_limited.as_ref() == Some(&next) {
            return false;
        }
        self.rate_limited = Some(next);
        true
    }

    fn observe_result(&mut self, v: &Value) -> bool {
        let mut changed = false;
        if let Some(sr) = v.get("stop_reason").and_then(Value::as_str) {
            changed |= self.set_stop_reason(sr);
        }
        for (field, key) in [
            (&mut self.num_turns, "num_turns"),
            (&mut self.duration_ms, "duration_ms"),
        ] {
            if let Some(n) = v.get(key).and_then(Value::as_u64) {
                if *field != Some(n) {
                    *field = Some(n);
                    changed = true;
                }
            }
        }
        if let Some(c) = v.get("total_cost_usd").and_then(Value::as_f64) {
            if self.cost_usd != Some(c) {
                self.cost_usd = Some(c);
                changed = true;
            }
        }
        if let Some(u) = v.get("usage") {
            changed |= self.take_tier_and_speed(u);
            let total = MsgUsage::from_usage(u);
            // ADOPT, don't add — but only if it says something. An errored
            // result reports zeros, and the live fold is the honest number.
            if !total.is_zero() {
                self.input_tokens = total.input;
                self.output_tokens = total.output;
                self.cache_read_tokens = total.cache_read;
                self.cache_creation_tokens = total.cache_creation;
                self.settled = true;
                changed = true;
            }
        }
        // The window as the CLI states it, keyed by the model that answered
        // (falling back to the single entry when there is exactly one).
        if let Some(map) = v.get("modelUsage").and_then(Value::as_object) {
            let entry = self
                .model
                .as_deref()
                .and_then(|m| map.get(m))
                .or_else(|| if map.len() == 1 { map.values().next() } else { None });
            if let Some(w) = entry.and_then(|e| e.get("contextWindow")).and_then(Value::as_u64) {
                if self.context_window != Some(w) {
                    self.context_window = Some(w);
                    changed = true;
                }
            }
        }
        changed
    }

    // --- folds ---------------------------------------------------------

    fn fold_usage(&mut self, msg_id: &str, u: &Value) -> bool {
        let mut changed = self.take_tier_and_speed(u);
        let observed = MsgUsage::from_usage(u);
        let slot = self.seen.entry(msg_id.to_string()).or_default();
        if slot.merge_max(&observed) {
            changed = true;
        }
        // Occupancy is a per-message high-water mark and survives the
        // terminal adoption, which only replaces the spend totals.
        let occ = self.seen.values().map(MsgUsage::occupancy).max().unwrap_or(0);
        if occ > self.context_tokens {
            self.context_tokens = occ;
            changed = true;
        }
        if !self.settled && changed {
            let mut t = MsgUsage::default();
            for u in self.seen.values() {
                t.input = t.input.saturating_add(u.input);
                t.output = t.output.saturating_add(u.output);
                t.cache_read = t.cache_read.saturating_add(u.cache_read);
                t.cache_creation = t.cache_creation.saturating_add(u.cache_creation);
            }
            self.input_tokens = t.input;
            self.output_tokens = t.output;
            self.cache_read_tokens = t.cache_read;
            self.cache_creation_tokens = t.cache_creation;
        }
        changed
    }

    fn take_model(&mut self, m: &Value) -> bool {
        match m.get("model").and_then(Value::as_str) {
            Some(model) if self.model.as_deref() != Some(model) => {
                self.model = Some(model.to_string());
                true
            }
            _ => false,
        }
    }

    fn take_tier_and_speed(&mut self, u: &Value) -> bool {
        let mut changed = false;
        for (field, key) in [
            (&mut self.service_tier, "service_tier"),
            (&mut self.speed, "speed"),
        ] {
            if let Some(s) = u.get(key).and_then(Value::as_str) {
                if field.as_deref() != Some(s) {
                    *field = Some(s.to_string());
                    changed = true;
                }
            }
        }
        changed
    }

    fn count_tool(&mut self, id: Option<&str>, name: Option<&str>, input: Option<&Value>) -> bool {
        let Some(name) = name else { return false };
        let mut changed = false;
        // No id (shouldn't happen, but the wire is the wire) counts once by
        // falling back to a per-call key that can't collide.
        let key = id
            .map(str::to_string)
            .unwrap_or_else(|| format!("_anon{}", self.tool_ids.len()));
        if self.tool_ids.insert(key) {
            self.tool_calls += 1;
            changed = true;
        }
        if self.last_tool.as_deref() != Some(name) {
            self.last_tool = Some(name.to_string());
            changed = true;
        }
        let label = match input {
            Some(i) if !i.is_null() => crate::claude_proc::retrieval_status_label(name, i),
            _ => format!("{name}…"),
        };
        if self.last_tool_label.as_deref() != Some(label.as_str()) {
            self.last_tool_label = Some(label);
            changed = true;
        }
        changed
    }

    fn set_stop_reason(&mut self, sr: &str) -> bool {
        if self.stop_reason.as_deref() == Some(sr) {
            return false;
        }
        self.stop_reason = Some(sr.to_string());
        true
    }

    fn bump_thinking(&mut self, est: Option<u64>) -> bool {
        let Some(est) = est else { return false };
        if self.thinking_tokens.unwrap_or(0) >= est {
            return false;
        }
        self.thinking_tokens = Some(est);
        true
    }

    fn clear_rate_limit(&mut self) -> bool {
        self.rate_limited.take().is_some()
    }
}

// --- the Codex arm ---------------------------------------------------------

/// Fold a Codex turn's terminal notification into a meter.
///
/// Codex speaks a different protocol and, on every shape Redline has seen,
/// reports **no usage at all** — `codex_app_server::run_one_shot` returns one
/// `String`. So this reads the several places usage *could* land (both
/// `snake_case` and `camelCase`, and both the `exec --json` and app-server
/// nestings) and records the model regardless.
///
/// Zeros here are honest and mean "this harness did not say", not "this turn
/// was free". The badge still reads `Codex · GPT-5.6-Sol`, which is the whole
/// point: `--fallback-model`-style surprises aside, the user gets provenance
/// even where they cannot get economics.
///
/// `model` is the CONFIGURED model, not an observed one — see the note on
/// [`TurnMeter::model`]. Codex reports nothing to observe.
pub fn from_codex_turn(v: &Value, model: Option<&str>) -> TurnMeter {
    let mut m = TurnMeter::new();
    if let Some(model) = model.filter(|s| !s.trim().is_empty()) {
        m.model = Some(model.to_string());
        m.rev += 1;
    }
    let usage = ["/params/usage", "/params/turn/usage", "/usage", "/turn/usage"]
        .iter()
        .find_map(|p| v.pointer(p))
        .filter(|u| u.is_object());
    let Some(u) = usage else { return m };
    let g = |snake: &str, camel: &str| {
        u.get(snake)
            .or_else(|| u.get(camel))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    m.input_tokens = g("input_tokens", "inputTokens");
    m.output_tokens = g("output_tokens", "outputTokens");
    m.cache_read_tokens = g("cached_input_tokens", "cachedInputTokens");
    if m.total_tokens() > 0 {
        m.context_tokens = m.input_tokens.saturating_add(m.cache_read_tokens);
        m.rev += 1;
    }
    m
}

// --- burn booking ----------------------------------------------------------

/// Book one finished turn's tokens onto its Agent Seat's `(seat, day)` row.
///
/// EVERY exit books — success, error and cancelled alike. A cancelled turn
/// spent its input tokens; an errored turn spent them too. Booking only the
/// success path produces numbers that look right and are wrong, which is a
/// worse failure than the zeros this replaces: before this, `seat_burn` was
/// written by exactly one caller (`runwatch`, hardcoded to `orchestrator`), so
/// 19 of 20 seats reported zero burn forever.
///
/// `spawns` is 1 because a turn IS one `claude` subprocess — which is what
/// makes the per-seat rollup an economics-by-subprocess view.
pub fn book(db: &crate::db::Database, seat: &str, m: &TurnMeter) {
    if m.is_empty() || m.total_tokens() == 0 {
        return;
    }
    let day = crate::runwatch::local_day(crate::state::now_millis());
    if let Err(e) = db.add_seat_burn(
        seat,
        &day,
        m.input_tokens as i64,
        m.output_tokens as i64,
        m.cache_read_tokens as i64,
        m.cache_creation_tokens as i64,
        1,
    ) {
        tracing::warn!(error = %e, seat, "failed to book seat burn");
    }
}

/// Attach a settled turn's meter to the message row it produced, so the badge
/// and the footer survive a remount and a relaunch. Without this the footer
/// vanishes the moment the turn ends — the one state the user looks at most.
///
/// Called for ERROR rows as well as completed ones: a failed turn's economics
/// are the most interesting ones on the thread, and "the reply that cost 40k
/// and then died" is exactly what you want to see the next morning.
pub fn attach(db: &crate::db::Database, kind: &str, message_id: &str, m: &TurnMeter) {
    if m.is_empty() || message_id.is_empty() {
        return;
    }
    match serde_json::to_string(m) {
        Ok(json) => {
            if let Err(e) = db.set_thread_message_meter(kind, message_id, &json) {
                tracing::warn!(error = %e, kind, "failed to attach a turn meter");
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed to serialize a turn meter"),
    }
}

/// Take the turn's meter off its buffer and book it. Called ONCE per turn at
/// the reader's terminal, ABOVE the success/error/cancelled branch — a guard
/// test (`meter_settle_precedes_every_terminal_branch`) asserts exactly that
/// at every reader site, because "every exit books" is the kind of invariant
/// that decays silently one refactor at a time.
pub fn settle(
    db: &crate::db::Database,
    seat: &str,
    buf: &std::sync::Mutex<crate::turn::PartialBuf>,
) -> TurnMeter {
    let m = buf.lock().unwrap().meter.clone();
    book(db, seat, &m);
    m
}

// --- frontend reads ---------------------------------------------------------

/// Every stored meter for one thread, as `{messageId: meter}`. ONE call per
/// thread load rather than one per bubble — the surfaces already fetch their
/// history in a single round trip, and the meters ride the same shape.
///
/// `kind` is the `thread_table` vocabulary the whole app already shares
/// (`browse` | `linked` | `mission` | `companion` | `memchat` | `drafter` |
/// `voice` | `fork`), so a new surface joins by being in that map.
#[tauri::command]
pub fn thread_meters(
    store: tauri::State<'_, crate::state::SessionStore>,
    kind: String,
    thread_id: String,
) -> std::collections::HashMap<String, Value> {
    let db = store.database();
    db.thread_meters(&kind, &thread_id)
        .into_iter()
        .filter_map(|(id, json)| serde_json::from_str::<Value>(&json).ok().map(|v| (id, v)))
        .collect()
}

/// One PTY plan session's tailed meter (`plan_meter`). `None` until the
/// tailer has seen an assistant turn — a session that has only been asked a
/// question has spent nothing yet.
#[tauri::command]
pub fn plan_session_meter(
    store: tauri::State<'_, crate::state::SessionStore>,
    session_id: String,
) -> Option<Value> {
    store
        .database()
        .session_meter(&session_id)
        .and_then(|j| serde_json::from_str(&j).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold_file(path: &str) -> TurnMeter {
        let body = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let mut m = TurnMeter::new();
        for line in body.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(line).expect("fixture line parses");
            m.observe(&v);
        }
        m
    }

    /// THE regression this module exists for. `runwatch::apply_agent_line`
    /// summed usage on every `assistant` line, and consecutive lines repeat
    /// one `message.id` with cumulative usage — so cache-creation read 2.7×
    /// its true value in the Runs surface and the seat burn summary.
    #[test]
    fn dedupes_cumulative_usage_by_message_id() {
        let m = fold_file("tests/golden/runwatch/agent_head.jsonl");
        assert_eq!(m.input_tokens, 6, "summing every line would read 12");
        assert_eq!(m.output_tokens, 440, "summing every line would read 454");
        assert_eq!(
            m.cache_creation_tokens, 38_847,
            "summing every line would read 103,574 — the 2.7x over-report"
        );
        assert_eq!(
            m.cache_read_tokens, 64_727,
            "summing every line would read 95,298"
        );
        assert_eq!(m.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(m.effort.as_deref(), Some("xhigh"));
        assert_eq!(m.tool_calls, 3);
        assert_eq!(m.last_tool.as_deref(), Some("Bash"));
        // High-water occupancy, not the sum of the three messages' inputs.
        assert_eq!(m.context_tokens, 38_849);
    }

    /// The reference capture: every shape the meter reads, in one turn.
    #[test]
    fn folds_the_reference_capture() {
        let m = fold_file("tests/golden/stream/turn_thinking_tools.jsonl");
        // The per-message fold reproduces `result.usage` exactly, and the
        // adoption then confirms it rather than changing it.
        assert_eq!(m.input_tokens, 6);
        assert_eq!(m.output_tokens, 319);
        assert_eq!(m.cache_creation_tokens, 5_983);
        assert_eq!(m.cache_read_tokens, 30_186);
        assert_eq!(m.context_tokens, 12_256);
        assert_eq!(m.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(m.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(m.num_turns, Some(3));
        assert_eq!(m.duration_ms, Some(4_181));
        assert_eq!(m.service_tier.as_deref(), Some("standard"));
        assert_eq!(m.speed.as_deref(), Some("standard"));
        // Two tools, counted once each despite `content_block_start` AND the
        // `assistant` line both announcing them.
        assert_eq!(m.tool_calls, 2);
        assert_eq!(m.last_tool.as_deref(), Some("Grep"));
        assert_eq!(m.last_tool_label.as_deref(), Some("Grep…"));
        assert_eq!(m.thinking_tokens, Some(75));
        assert_eq!(m.context_window, Some(1_000_000));
        assert!(m.cost_usd.unwrap() > 0.0);
        // The routine `status: allowed` heartbeat is not a stall.
        assert_eq!(m.rate_limited, None);
        assert!(m.rev > 0);
    }

    #[test]
    fn folds_the_floor_case() {
        let m = fold_file("tests/golden/stream/turn_minimal.jsonl");
        assert_eq!(m.input_tokens, 2);
        assert_eq!(m.output_tokens, 4);
        assert_eq!(m.cache_creation_tokens, 5_476);
        assert_eq!(m.cache_read_tokens, 3_289);
        assert_eq!(m.context_tokens, 8_767);
        assert_eq!(m.tool_calls, 0);
        assert_eq!(m.last_tool, None);
        assert_eq!(m.stop_reason.as_deref(), Some("end_turn"));
    }

    /// A truncated reply currently looks byte-for-byte like a complete one.
    #[test]
    fn synthetic_truncation_sets_max_tokens() {
        let m = fold_file("tests/golden/stream/synthetic_max_tokens.jsonl");
        assert_eq!(m.stop_reason.as_deref(), Some("max_tokens"));
        assert_eq!(m.output_tokens, 64_000);
    }

    /// Only a non-`allowed` status is a stall; the next text delta ends it.
    #[test]
    fn rate_limit_onset_and_clear() {
        let m = fold_file("tests/golden/stream/synthetic_rate_limited.jsonl");
        assert_eq!(m.rate_limited, None, "the text delta cleared the stall");

        let mut m = TurnMeter::new();
        let allowed = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "allowed", "resetsAt": 1788574800_i64}
        });
        assert!(!m.observe(&allowed), "the routine heartbeat is not a change");
        assert_eq!(m.rate_limited, None);

        let rejected = serde_json::json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "rejected", "resetsAt": 1788574800_i64,
                "rateLimitType": "five_hour"
            }
        });
        assert!(m.observe(&rejected));
        let rl = m.rate_limited.clone().expect("outstanding");
        assert_eq!(rl.status, "rejected");
        assert_eq!(rl.resets_at, Some(1_788_574_800));
        assert_eq!(rl.kind.as_deref(), Some("five_hour"));
        // Repeating the same event while waiting is not a change.
        assert!(!m.observe(&rejected));
    }

    /// An errored `result` reports zeroed usage. Adopting it would erase the
    /// tokens a mid-flight failure genuinely spent.
    #[test]
    fn zeroed_result_usage_never_erases_the_fold() {
        let mut m = TurnMeter::new();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": {"type": "message_start", "message": {
                "id": "msg_1", "model": "claude-opus-5",
                "usage": {"input_tokens": 4, "output_tokens": 9,
                          "cache_read_input_tokens": 1000,
                          "cache_creation_input_tokens": 20}
            }}
        });
        m.observe(&start);
        assert_eq!(m.output_tokens, 9);

        let err: Value = serde_json::from_str(
            &std::fs::read_to_string("tests/golden/stream/turn_resume_error.jsonl").unwrap(),
        )
        .unwrap();
        m.observe(&err);
        assert_eq!(m.input_tokens, 4, "the fold survives a zeroed result");
        assert_eq!(m.output_tokens, 9);
        assert_eq!(m.cache_read_tokens, 1000);
        assert_eq!(m.cache_creation_tokens, 20);
    }

    /// stdout order (`assistant` snapshot, then `message_delta` final) and
    /// transcript order (`assistant` final only) converge — which is what the
    /// per-field max buys over "newest wins".
    #[test]
    fn snapshot_then_final_converges_either_way() {
        let snapshot = serde_json::json!({
            "type": "assistant",
            "message": {"id": "msg_x", "model": "claude-sonnet-5",
                "usage": {"input_tokens": 2, "output_tokens": 2,
                          "cache_read_input_tokens": 60, "cache_creation_input_tokens": 30}}
        });
        let final_delta = serde_json::json!({
            "type": "stream_event",
            "event": {"type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"input_tokens": 2, "output_tokens": 134,
                          "cache_read_input_tokens": 60, "cache_creation_input_tokens": 30}}
        });
        let mut forward = TurnMeter::new();
        forward.observe(&snapshot);
        forward.observe(&final_delta);

        let mut reversed = TurnMeter::new();
        // A transcript replay re-reading the same message id twice.
        reversed.observe(&snapshot);
        reversed.observe(&snapshot);
        assert_eq!(reversed.output_tokens, 2, "re-reading never accumulates");

        assert_eq!(forward.output_tokens, 134);
        assert_eq!(forward.context_tokens, 92);
        assert_eq!(forward.stop_reason.as_deref(), Some("end_turn"));
    }

    /// The interactive PTY transcript carries line types a headless one never
    /// has. They must fold in as no-ops, not panics.
    #[test]
    fn unknown_line_types_are_inert() {
        let mut m = TurnMeter::new();
        for raw in [
            r#"{"type":"mode","mode":"plan"}"#,
            r#"{"type":"ai-title","title":"x"}"#,
            r#"{"type":"attachment"}"#,
            r#"{"type":"file-history-snapshot"}"#,
            r#"{"type":"queue-operation"}"#,
            r#"{"type":"last-prompt"}"#,
            r#"{"type":"assistant"}"#,
            r#"{}"#,
        ] {
            let v: Value = serde_json::from_str(raw).unwrap();
            assert!(!m.observe(&v), "{raw} must not register as a change");
        }
        assert!(m.is_empty());
    }

    /// **Every exit books.** The mechanical half of this program is 20 spawn
    /// sites agreeing to do the same thing at their terminal, and "burn that
    /// books only on the success path" produces numbers that look right and
    /// are wrong — a worse failure than the zeros it replaces. So the
    /// invariant is asserted in source, in the `size_guard.rs` /
    /// `retrieval_modules_never_write_the_catalog` style, rather than left to
    /// review: `meter::settle` must appear ABOVE the reader's `'terminal:`
    /// branch, where success / error / cancelled have not yet diverged.
    #[test]
    fn meter_settle_precedes_every_terminal_branch() {
        const READERS: &[(&str, &str)] = &[
            ("browse.rs", include_str!("browse.rs")),
            ("linked.rs", include_str!("linked.rs")),
            ("mission.rs", include_str!("mission.rs")),
            ("memchat.rs", include_str!("memchat.rs")),
            ("companion.rs", include_str!("companion.rs")),
            ("draft_chat.rs", include_str!("draft_chat.rs")),
            ("fork.rs", include_str!("fork.rs")),
        ];
        for (name, src) in READERS {
            let settle = src
                .find("crate::meter::settle(")
                .unwrap_or_else(|| panic!("{name} never calls `meter::settle` — its turns book nothing"));
            let terminal = src
                .find("'terminal: {")
                .unwrap_or_else(|| panic!("{name} has no `'terminal:` block to book above"));
            assert!(
                settle < terminal,
                "{name} calls `meter::settle` INSIDE (or after) its `'terminal:` \
                 branch — a cancelled or errored turn would book nothing, and \
                 its tokens were spent all the same"
            );
        }
    }

    /// The silent paths have no pane and no `'terminal:` block, so they book
    /// through the drain itself. `collect_turn_seated` has exactly one exit,
    /// which is what makes that sound — but only if nobody quietly reverts to
    /// the unseated `collect_turn`.
    #[test]
    fn silent_drains_use_the_seated_collector() {
        const SILENT: &[(&str, &str)] = &[
            ("ai_commit.rs", include_str!("ai_commit.rs")),
            ("browse_locate.rs", include_str!("browse_locate.rs")),
            ("intake.rs", include_str!("intake.rs")),
            ("moot.rs", include_str!("moot.rs")),
            ("queue.rs", include_str!("queue.rs")),
        ];
        for (name, src) in SILENT {
            assert!(
                src.contains("collect_turn_seated("),
                "{name} drains a claude turn without booking its burn"
            );
            // The bare form drains the same bytes and books nothing.
            assert_eq!(
                src.matches("collect_turn(").count(),
                0,
                "{name} still calls the UNSEATED `collect_turn` somewhere — \
                 that drain's tokens vanish"
            );
        }
    }

    /// The daemon seats roll their own drain loop (they parse structured
    /// output, not chat text). Each must still fold and book.
    #[test]
    fn daemon_seats_fold_and_book() {
        const DAEMONS: &[(&str, &str, &str)] = &[
            ("librarian.rs", include_str!("librarian.rs"), "librarian"),
            ("shipwright.rs", include_str!("shipwright.rs"), "shipwright"),
            ("seatassign.rs", include_str!("seatassign.rs"), "seatassign"),
            ("ai_review.rs", include_str!("ai_review.rs"), "ai_review"),
            ("voice.rs", include_str!("voice.rs"), "voice"),
        ];
        for (name, src, seat) in DAEMONS {
            assert!(
                src.contains("meter.observe(&v)"),
                "{name} reads the stream without folding the meter"
            );
            assert!(
                src.contains(&format!("crate::meter::book(db, \"{seat}\"", ))
                    || src.contains(&format!("crate::meter::book(&db, \"{seat}\""))
                    || src.contains(&format!("crate::meter::book(db, \"{seat}\"")),
                "{name} folds a meter it never books to the `{seat}` seat"
            );
        }
    }

    /// The memory seats (`classifier`, `keeper`: the classifier, the supersede
    /// verifier, compaction, observations, the shots caption) spawn through
    /// the `polis_llm::Agent` seam since Session A4 of the Polis extraction.
    /// The fold and the booking moved with them and must both still happen:
    /// `RedlineAgent` drains through `collect_turn` (the `TurnMeter` fold) and
    /// hands the counters back as `Usage`; `run_memory_agent` books that usage
    /// through `RedlineUsage` on BOTH exits; `RedlineUsage` books through
    /// `meter::book`. A memory turn that skipped any link would spend tokens
    /// nobody counted.
    #[test]
    fn memory_seats_fold_in_the_agent_and_book_in_the_runner() {
        const HOST: &str = include_str!("polis_host.rs");
        let agent = crate::polis_src::polis_source("polis-memory", "src/agent.rs");
        const CLASSMEM: &str = include_str!("classmem.rs");
        const KEEPER: &str = include_str!("keeper.rs");
        assert!(
            HOST.contains("crate::claude_proc::collect_turn(stdout, stderr)"),
            "RedlineAgent must drain through the meter-folding collector"
        );
        assert!(HOST.contains("usage_from_meter(&out.meter)"), "…and hand the folded counters back");
        assert!(
            HOST.contains("crate::meter::book(self, seat, &m)"),
            "the Database's UsageSink must book through meter::book"
        );
        // Since A5 the runner is the facade's (`polis_memory::agent`), and the
        // seam's shape is the same: book on both exits, one seat per pass.
        assert_eq!(
            agent.matches("polis.sink.book(seat, &").count(),
            2,
            "run_memory_agent books on both exits — a failed pass spent its input tokens"
        );
        assert!(agent.contains("run_memory_agent(polis, \"classifier\""), "the classifier runs through the seam");
        assert!(agent.contains("run_memory_agent(polis, \"keeper\""), "the keeper runs through the seam");
        for (name, src) in [("classmem.rs", CLASSMEM), ("keeper.rs", KEEPER)] {
            assert_eq!(src.matches("collect_turn(").count(), 0, "{name} must not drain a turn itself any more");
            assert!(!src.contains("meter.observe(&v)"), "{name} must not fold a meter of its own — the agent does");
        }
    }

    /// The Codex arm. Zeros are honest — "this harness did not say" — but the
    /// model still has to reach the badge, or a Codex-backed surface is the
    /// one place in the app with no provenance at all.
    #[test]
    fn codex_reports_provenance_even_with_no_usage() {
        // The shape Redline actually sees today: a bare completion.
        let bare = serde_json::json!({"method": "turn/completed", "params": {}});
        let m = from_codex_turn(&bare, Some("gpt-5.6-sol"));
        assert_eq!(m.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(m.total_tokens(), 0);
        assert!(!m.is_empty(), "the model alone is worth an event");

        // …and the shapes it might grow, in either casing.
        for payload in [
            serde_json::json!({"params": {"usage": {
                "input_tokens": 120, "output_tokens": 30, "cached_input_tokens": 900}}}),
            serde_json::json!({"params": {"turn": {"usage": {
                "inputTokens": 120, "outputTokens": 30, "cachedInputTokens": 900}}}}),
        ] {
            let m = from_codex_turn(&payload, Some("gpt-5.6-sol"));
            assert_eq!(m.input_tokens, 120);
            assert_eq!(m.output_tokens, 30);
            assert_eq!(m.cache_read_tokens, 900);
            assert_eq!(m.context_tokens, 1_020);
        }

        // No configured model and no usage is an empty meter, not a row of
        // zeros pretending to be a measurement.
        assert!(from_codex_turn(&serde_json::json!({}), None).is_empty());
    }

    /// A consult delegates to another surface's agent on ITS seat. There is no
    /// precise parent→child cost edge (the request carries no caller
    /// identity), so the parent's activity line saying so is the honest
    /// substitute — and it comes through the shared label function, not a
    /// special case.
    #[test]
    fn a_consult_is_named_on_the_parent_activity_line() {
        let mut m = TurnMeter::new();
        m.observe(&serde_json::json!({
            "type": "assistant",
            "message": {"id": "msg_c", "content": [{
                "type": "tool_use", "id": "toolu_c", "name": "Bash",
                "input": {"command": "curl -s http://127.0.0.1:7676/v1/global/consult -X POST"}
            }]}
        }));
        assert_eq!(m.last_tool_label.as_deref(), Some("checking in with a colleague…"));
    }

    #[test]
    fn discrete_changes_are_the_ones_worth_interrupting_for() {
        let mut m = TurnMeter::new();
        let before = m.clone();
        m.observe(&serde_json::json!({
            "type": "stream_event",
            "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "tool_use", "id": "toolu_1", "name": "Grep"}}
        }));
        assert!(m.is_discrete_change(&before));

        // A plain usage fold is not: it rides the coalescing tick.
        let before = m.clone();
        m.observe(&serde_json::json!({
            "type": "stream_event",
            "event": {"type": "message_start",
                "message": {"id": "msg_1", "model": "claude-opus-5",
                            "usage": {"output_tokens": 3}}}
        }));
        assert!(m.is_discrete_change(&before), "first model IS discrete");
        let before = m.clone();
        m.observe(&serde_json::json!({
            "type": "stream_event",
            "event": {"type": "message_delta", "usage": {"output_tokens": 40}}
        }));
        assert!(!m.is_discrete_change(&before));
        assert_eq!(m.output_tokens, 40);
    }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! SCALED BUILDS (Track O): build an approved plan with a team of agents, at a
//! scale the user picked and under limits Redline actually enforces.
//!
//! The engine is Claude Code's own dynamic workflow, launched by typing an
//! `ultracode:` prompt into an interactive `claude` (workflows only turn on
//! for typed input). Everything Redline adds rides two `PreToolUse` HTTP hooks
//! installed for THAT session only, through a per-run `--settings` file, so
//! no other Claude session on the machine pays for them:
//!
//! * **Pre-flight** (matcher `Workflow`). The hook carries the generated
//!   script before any agent starts. Redline reads it (call sites, phases,
//!   per-agent models), shows an estimate, and holds the hook until the user
//!   presses Run, Edit or Cancel. An `allow` replaces the CLI's own "Run a
//!   dynamic workflow?" card.
//! * **Gate** (matcher `*`). Every tool call of the lead and of each workflow
//!   subagent passes through. It is a pass-through (no opinion, so the normal
//!   permission rules still apply) until a limit trips: a new agent beyond
//!   the agent cap, the token budget, or the time budget. Then the run
//!   PAUSES: every gated call is held until the user picks Extend or Stop.
//!
//! All of it verified on CLI 2.1.289 (Experiment (k) in
//! `docs/protocol-verification.md`): the Workflow call fires `PreToolUse`
//! with `tool_input.script`; subagent tool calls fire the session's hooks
//! with `agent_type: "workflow-subagent"` and an `agent_id`; the hook's
//! `allow` skips the CLI approval card.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path as AxPath, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

use crate::state::now_millis;

pub const DEFAULT_MAX_AGENTS: u32 = 8;
pub const DEFAULT_TOKEN_BUDGET: u64 = 5_000_000;
pub const DEFAULT_TIME_BUDGET_MINS: u32 = 240;
/// The hook timeouts written into the run's settings. A held hook answers
/// `HOLD_MARGIN` before its timeout, so the CLI never times out on us (a
/// timed-out hook is a non-blocking error: the call would just proceed).
pub const PREFLIGHT_HOOK_TIMEOUT_S: u64 = 1_800;
pub const GATE_HOOK_TIMEOUT_S: u64 = 3_600;
const HOLD_MARGIN_S: u64 = 30;

// --- Configuration ------------------------------------------------------------

/// The scale the user picked on the approve flow. `auto` is these defaults
/// with the lead on the orchestrator seat; `custom` is whatever they set.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScaleConfig {
    /// `auto` | `custom`.
    pub scale: String,
    pub max_agents: u32,
    /// Input + output + cache-write tokens across the workflow's agents.
    /// Cache reads are excluded: billed at a tenth, they would trip a 5M
    /// ceiling within an agent or two.
    pub token_budget: u64,
    pub time_budget_mins: u32,
    /// The session model (`--model`): the lead, and every agent that does not
    /// name its own.
    pub lead_model: String,
    /// The model for building agents, when it differs from the lead.
    #[serde(default)]
    pub worker_model: Option<String>,
    /// The model for read-only exploration agents.
    #[serde(default)]
    pub scout_model: Option<String>,
    /// `--effort`, inherited by every agent.
    #[serde(default)]
    pub effort: Option<String>,
    /// End with an independent verification agent.
    #[serde(default = "yes")]
    pub verify: bool,
    /// One line of steering the user wants the lead to follow.
    #[serde(default)]
    pub steer: Option<String>,
}

fn yes() -> bool {
    true
}

impl ScaleConfig {
    pub fn auto(lead_model: &str) -> Self {
        ScaleConfig {
            scale: "auto".into(),
            max_agents: DEFAULT_MAX_AGENTS,
            token_budget: DEFAULT_TOKEN_BUDGET,
            time_budget_mins: DEFAULT_TIME_BUDGET_MINS,
            lead_model: lead_model.into(),
            worker_model: None,
            scout_model: Some("haiku".into()),
            effort: None,
            verify: true,
            steer: None,
        }
    }

    /// Clamp to sane bounds and refuse unknown models. Every field reaches a
    /// command line or a prompt, so nothing passes through unchecked.
    pub fn sanitize(mut self) -> Result<Self, String> {
        let model = |m: &Option<String>, what: &str| -> Result<Option<String>, String> {
            match m.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                None => Ok(None),
                Some(m) if crate::seat::MODEL_OPTIONS.contains(&m) => Ok(Some(m.to_string())),
                Some(m) => Err(format!("unknown {what} model `{m}`")),
            }
        };
        self.scale = if self.scale == "custom" { "custom".into() } else { "auto".into() };
        self.max_agents = self.max_agents.clamp(1, 64);
        self.token_budget = self.token_budget.clamp(100_000, 500_000_000);
        self.time_budget_mins = self.time_budget_mins.clamp(5, 24 * 60);
        self.lead_model = model(&Some(self.lead_model.clone()), "lead")?.unwrap_or_else(|| "sonnet".into());
        self.worker_model = model(&self.worker_model, "worker")?;
        self.scout_model = model(&self.scout_model, "scout")?;
        self.effort = match self.effort.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            None => None,
            Some(e) if crate::seat::EFFORT_OPTIONS.contains(&e) => Some(e.to_string()),
            Some(e) => return Err(format!("unknown effort `{e}`")),
        };
        self.steer = self
            .steer
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .map(|s| s.chars().take(400).collect::<String>())
            .filter(|s| !s.is_empty());
        Ok(self)
    }

    /// The models agents may run on: the lead (inherited) plus the named
    /// worker and scout models.
    fn allowed_models(&self) -> Vec<&str> {
        let mut out = vec![self.lead_model.as_str()];
        out.extend(self.worker_model.as_deref());
        out.extend(self.scout_model.as_deref());
        out.sort_unstable();
        out.dedup();
        out
    }
}

// --- Pre-flight: reading the script ---------------------------------------------

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub agents: u32,
    /// False when agents are spawned per item (a `.map(`/loop), so the real
    /// count is only known at run time; `agents` is then a guess.
    pub agents_exact: bool,
    pub tokens: u64,
    pub minutes: u32,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub name: Option<String>,
    pub description: Option<String>,
    pub phases: Vec<String>,
    /// `agent(` call sites in the script.
    pub call_sites: u32,
    /// Agents are spawned per item somewhere (count known only at run time).
    pub dynamic: bool,
    /// `(model, call sites)`; agents that name none inherit the lead.
    pub models: Vec<(String, u32)>,
    pub estimate: Estimate,
    /// Plain-language concerns: over the agent cap, a model outside the
    /// configured set, an unreadable script.
    pub warnings: Vec<String>,
    pub script: String,
}

/// A deliberately rough per-agent token figure (input + output + cache
/// writes) by model. Labelled as an estimate everywhere it is shown.
fn tokens_per_agent(model: &str) -> u64 {
    match model {
        "haiku" => 120_000,
        "opus" | "fable" => 400_000,
        _ => 250_000,
    }
}

/// Read a workflow script into what the pre-flight card shows. Never fails:
/// an unreadable script still gets a card, with a warning saying so.
pub fn analyze_script(script: &str, cfg: &ScaleConfig) -> Preflight {
    let meta = crate::runwatch::extract_script_meta(script);
    let calls = crate::runwatch::extract_agent_calls(script);
    let dynamic = [".map(", ".flatMap(", "for (", "for(", "while (", "while("]
        .iter()
        .any(|needle| script.contains(needle));
    let call_sites = calls.len() as u32;

    let mut by_model: HashMap<String, u32> = HashMap::new();
    for call in &calls {
        let model = call.model.clone().unwrap_or_else(|| cfg.lead_model.clone());
        *by_model.entry(model).or_default() += 1;
    }
    let mut models: Vec<(String, u32)> = by_model.into_iter().collect();
    models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // Per-item fan-out: the count is a guess, bounded by the cap so the
    // estimate never promises more than Redline will allow without asking.
    let agents = if dynamic {
        (call_sites * 3).clamp(call_sites, cfg.max_agents.max(call_sites))
    } else {
        call_sites
    };
    let per_site: u64 = if calls.is_empty() {
        0
    } else {
        calls
            .iter()
            .map(|c| tokens_per_agent(c.model.as_deref().unwrap_or(&cfg.lead_model)))
            .sum::<u64>()
            / calls.len() as u64
    };
    let phases: Vec<String> = meta
        .as_ref()
        .map(|m| m.phases.iter().map(|p| p.title.clone()).collect())
        .unwrap_or_default();
    let estimate = Estimate {
        agents,
        agents_exact: !dynamic,
        tokens: per_site * agents as u64,
        // Phases run one after another; agents within a phase in parallel.
        minutes: 5 + 12 * (phases.len().max(1) as u32),
    };

    let mut warnings = Vec::new();
    if calls.is_empty() {
        warnings.push("Redline could not find any agent() calls in this script; read it before running.".into());
    }
    if !dynamic && call_sites > cfg.max_agents {
        warnings.push(format!(
            "The script starts {call_sites} agents, over this build's cap of {}. Redline will pause and ask when the cap is reached.",
            cfg.max_agents
        ));
    } else if dynamic && agents >= cfg.max_agents {
        warnings.push(format!(
            "Agents are started per item, so the count is only known as it runs; Redline pauses and asks at {}.",
            cfg.max_agents
        ));
    }
    let allowed = cfg.allowed_models();
    for (model, n) in &models {
        if !allowed.contains(&model.as_str()) {
            warnings.push(format!("{n} agent call(s) use `{model}`, which is outside this build's models ({}).", allowed.join(", ")));
        }
    }
    if estimate.tokens > cfg.token_budget {
        warnings.push("The estimate is over the token budget; Redline will pause and ask when the budget is reached.".into());
    }

    Preflight {
        name: meta.as_ref().and_then(|m| m.name.clone()),
        description: meta.as_ref().and_then(|m| m.description.clone()),
        phases,
        call_sites,
        dynamic,
        models,
        estimate,
        warnings,
        script: script.chars().take(64 * 1024).collect(),
    }
}

// --- The gate: limits and the pause -----------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub agents: u32,
    pub tokens: u64,
    pub minutes: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    Agents,
    Tokens,
    Time,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Phase {
    /// Launched; the lead is reading the brief and writing its script.
    Launching,
    /// A script is waiting on the user's pre-flight decision.
    Preflight,
    Running,
    Paused { reason: PauseReason },
    Stopped { reason: String },
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub agents: u32,
    pub tokens: u64,
    pub minutes: u32,
}

#[derive(Debug, PartialEq)]
pub enum GateVerdict {
    /// No opinion: the CLI's normal permission rules decide.
    Pass,
    /// Hold the call until the user decides. `newly` is true for the call
    /// that tripped the limit, so the pause is announced once.
    Hold { reason: PauseReason, newly: bool },
    Deny(String),
}

/// One run's control state. Pure: the gate's decisions are unit-tested here
/// and the HTTP handlers only wait on them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCtl {
    pub run_id: String,
    pub plan_session_id: String,
    pub config: ScaleConfig,
    pub limits: Limits,
    pub phase: Phase,
    /// When the user pressed Run: the time budget counts from here.
    pub started_at: Option<i64>,
    #[serde(skip)]
    pub agents_seen: HashSet<String>,
    pub preflight: Option<Preflight>,
}

/// Is this a lead's call to Redline's own daemon? A stopped build still lets
/// the lead file its exit report and open the review.
fn is_daemon_curl(tool: &str, input: &Value) -> bool {
    tool == "Bash"
        && input
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim_start)
            .is_some_and(|c| c.starts_with("curl ") && c.contains("http://127.0.0.1:7676/"))
}

impl RunCtl {
    pub fn new(run_id: &str, plan_session_id: &str, config: ScaleConfig) -> Self {
        RunCtl {
            run_id: run_id.into(),
            plan_session_id: plan_session_id.into(),
            limits: Limits {
                agents: config.max_agents,
                tokens: config.token_budget,
                minutes: config.time_budget_mins,
            },
            config,
            phase: Phase::Launching,
            started_at: None,
            agents_seen: HashSet::new(),
            preflight: None,
        }
    }

    pub fn usage(&self, now: i64, tokens: u64) -> Usage {
        Usage {
            agents: self.agents_seen.len() as u32,
            tokens,
            minutes: self
                .started_at
                .map(|t| ((now - t).max(0) / 60_000) as u32)
                .unwrap_or(0),
        }
    }

    /// Decide one gated tool call. `agent_id` is set for a workflow
    /// subagent's call and absent for the lead's.
    pub fn gate(&mut self, agent_id: Option<&str>, tool: &str, input: &Value, now: i64, tokens: u64) -> GateVerdict {
        match &self.phase {
            Phase::Stopped { reason } => {
                if agent_id.is_none() && is_daemon_curl(tool, input) {
                    return GateVerdict::Pass;
                }
                return GateVerdict::Deny(stop_message(reason, agent_id.is_some()));
            }
            Phase::Paused { reason } => {
                if agent_id.is_none() && is_daemon_curl(tool, input) {
                    return GateVerdict::Pass;
                }
                return GateVerdict::Hold { reason: *reason, newly: false };
            }
            Phase::Launching | Phase::Preflight => return GateVerdict::Pass,
            Phase::Running => {}
        }
        let mut trip = None;
        if let Some(id) = agent_id {
            if !self.agents_seen.contains(id) {
                if self.agents_seen.len() as u32 >= self.limits.agents {
                    trip = Some(PauseReason::Agents);
                } else {
                    self.agents_seen.insert(id.to_string());
                }
            }
        }
        let usage = self.usage(now, tokens);
        if trip.is_none() && usage.tokens > self.limits.tokens {
            trip = Some(PauseReason::Tokens);
        }
        if trip.is_none() && usage.minutes >= self.limits.minutes {
            trip = Some(PauseReason::Time);
        }
        match trip {
            Some(reason) => {
                self.phase = Phase::Paused { reason };
                if agent_id.is_none() && is_daemon_curl(tool, input) {
                    return GateVerdict::Pass;
                }
                GateVerdict::Hold { reason, newly: true }
            }
            None => GateVerdict::Pass,
        }
    }

    /// Extend: raise the limit that tripped by half (at least +2 agents,
    /// +1M tokens, +30 minutes) and resume.
    pub fn extend(&mut self, now: i64, tokens: u64) {
        let Phase::Paused { reason } = self.phase else { return };
        let usage = self.usage(now, tokens);
        match reason {
            PauseReason::Agents => self.limits.agents += (self.limits.agents / 2).max(2),
            PauseReason::Tokens => {
                self.limits.tokens = self.limits.tokens.max(usage.tokens) + (self.limits.tokens / 2).max(1_000_000)
            }
            PauseReason::Time => {
                self.limits.minutes = self.limits.minutes.max(usage.minutes) + (self.limits.minutes / 2).max(30)
            }
        }
        self.phase = Phase::Running;
    }

    pub fn stop(&mut self, reason: &str) {
        self.phase = Phase::Stopped { reason: reason.to_string() };
    }
}

fn stop_message(reason: &str, subagent: bool) -> String {
    if subagent {
        format!("Stopped by the user in Redline ({reason}). End this task now and return what you have; do not start new work.")
    } else {
        format!(
            "Stopped by the user in Redline ({reason}). Do not start agents, edit files or run commands. You may still file the exit report and open the review curl from the brief; then end your turn."
        )
    }
}

// --- What the run is handed --------------------------------------------------------

/// The per-run `--settings` file: the two hooks, scoped to this session.
pub fn settings_json(run_id: &str) -> Value {
    json!({
        "hooks": {
            "PreToolUse": [
                {"matcher": "Workflow", "hooks": [{"type": "http", "url": format!("http://127.0.0.1:7676/v1/scaled/{run_id}/preflight"), "timeout": PREFLIGHT_HOOK_TIMEOUT_S}]},
                {"matcher": "*", "hooks": [{"type": "http", "url": format!("http://127.0.0.1:7676/v1/scaled/{run_id}/gate"), "timeout": GATE_HOOK_TIMEOUT_S}]}
            ]
        }
    })
}

/// The lead's brief, served at `GET /v1/scaled/<run>/brief`: the approved
/// plan, this build's budget and models, and the execution contract. The
/// typed prompt stays one short line pointing here.
pub fn build_brief(cfg: &ScaleConfig, run_id: &str, plan_session_id: &str, plan_markdown: &str) -> String {
    let mut models = format!("- The session model is `{}`: you, and every agent that names no model, run on it.\n", cfg.lead_model);
    if let Some(m) = &cfg.worker_model {
        models.push_str(&format!("- Agents that BUILD (edit files, run tests) pass `{{ model: '{m}' }}` to agent().\n"));
    }
    if let Some(m) = &cfg.scout_model {
        models.push_str(&format!("- Read-only exploration agents pass `{{ model: '{m}' }}`.\n"));
    }
    if let Some(e) = &cfg.effort {
        models.push_str(&format!("- Effort is `{e}` for the whole run.\n"));
    }
    let verify = if cfg.verify {
        "- End with ONE independent verification agent that checks the whole change against the plan (tests, build, the plan's stated outcomes) and reports pass/fail per plan section.\n"
    } else {
        ""
    };
    let steer = cfg
        .steer
        .as_deref()
        .map(|s| format!("\n## The user's steer\n\n{s}\n"))
        .unwrap_or_default();
    format!(
        "# Scaled build {run_id} for Redline plan session {plan_session_id}\n\n\
You are the LEAD of a scaled build. The user approved the plan below in Redline and chose to build it with a team of agents. Build it with ONE dynamic workflow (the Workflow tool), within the budget below. The plan session that wrote it has stood down; nobody else is building it.\n\n\
## Budget (Redline enforces it)\n\n\
- At most {agents} agents in total. Size the workflow to the plan; fewer is better. Prefer pipeline depth over fan-out width.\n\
- About {tokens} tokens (input + output + cache writes) and {minutes} minutes.\n\
- Redline shows your workflow script to the user before it runs (Run / Edit / Cancel). If the user asks for changes, revise the script and call Workflow again.\n\
- When a limit is reached, Redline pauses every agent and asks the user to extend or stop. If a tool call is denied with \"Stopped by the user in Redline\", stop.\n\n\
## Models\n\n{models}{verify}{steer}\n\
## Execution contract\n\n\
- The plan is the scope contract: build exactly its stated changes, nothing more. If something is impossible as written, do the closest faithful subset and say so in the report.\n\
- Never enter plan mode or call ExitPlanMode. Never `git stash`: other sessions may own uncommitted edits. Run `git status --porcelain` first and keep your hands off files you did not change.\n\
- Give every building subtask a machine-checkable verify step (a test, a build, a grep).\n\
- Leave ALL changes uncommitted. No agent commits or pushes.\n\
- Only you, the lead, talk to Redline; agents never run the review curl.\n\n\
## When the workflow returns\n\n\
1. File the exit report (a write route: import the token exactly like this; never write the variable into the command yourself):\n\n\
```bash\ncurl -s http://127.0.0.1:7676/v1/orchestration/report \\\n  --variable %REDLINE_DAEMON_TOKEN= \\\n  --expand-header \"Authorization: Bearer {{{{REDLINE_DAEMON_TOKEN}}}}\" \\\n  -X POST -H 'Content-Type: application/json' \\\n  -d '{{\"planSessionId\":\"{plan_session_id}\",\"scriptPath\":\"<workflow script path>\",\"workflowRan\":true,\"summary\":\"<2-4 sentences>\",\"subtasks\":[{{\"title\":\"<subtask>\",\"planSection\":\"<plan heading>\",\"verified\":true,\"skipped\":false,\"notes\":\"<how it was verified>\"}}]}}'\n```\n\n\
2. Open the human review from the repo root, with the maximum Bash timeout (it blocks while the user reviews):\n\n\
```bash\ncurl -s \"http://127.0.0.1:7676/v1/reviews/start?repo=$PWD&source=uncommitted&plan={plan_session_id}\"\n```\n\n\
Address each review round, re-running the same curl.\n\n\
## The approved plan\n\n{plan}\n",
        agents = cfg.max_agents,
        tokens = format_tokens(cfg.token_budget),
        minutes = cfg.time_budget_mins,
        plan = crate::parser::strip_sidecar_lines(plan_markdown).trim_end(),
    )
}

fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 && n.is_multiple_of(100_000) {
        format!("{}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{}k", n / 1_000)
    } else {
        n.to_string()
    }
}

// --- Live state --------------------------------------------------------------------

/// What the frontend renders: the pre-flight card, the pause card, the chip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledView {
    #[serde(flatten)]
    pub ctl: RunCtl,
    pub usage: Usage,
}

pub enum PreflightDecision {
    Run,
    Edit(String),
    Cancel,
}

#[derive(Clone)]
pub struct ScaledState {
    runs: Arc<Mutex<HashMap<String, RunCtl>>>,
    preflight: Arc<Mutex<HashMap<String, oneshot::Sender<PreflightDecision>>>>,
    /// Bumped on every decision; held gate calls wake and re-check.
    changed: Arc<watch::Sender<u64>>,
}

impl Default for ScaledState {
    fn default() -> Self {
        ScaledState {
            runs: Arc::default(),
            preflight: Arc::default(),
            changed: Arc::new(watch::channel(0).0),
        }
    }
}

impl ScaledState {
    pub fn insert(&self, ctl: RunCtl) {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(ctl.run_id.clone(), ctl);
        self.bump();
    }

    fn bump(&self) {
        self.changed.send_modify(|n| *n += 1);
    }

    /// The run, from memory or, after a restart, rebuilt from its row (the
    /// agent count starts over; the limits and phase survive).
    fn ensure_loaded(&self, db: &crate::db::Database, run_id: &str) -> bool {
        if self.runs.lock().unwrap_or_else(|e| e.into_inner()).contains_key(run_id) {
            return true;
        }
        let Some(ctl) = db.get_scaled_run(run_id).ok().flatten() else { return false };
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).entry(run_id.to_string()).or_insert(ctl);
        true
    }

    fn with<R>(&self, run_id: &str, f: impl FnOnce(&mut RunCtl) -> R) -> Option<R> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).get_mut(run_id).map(f)
    }

    /// Runs waiting on the user (a pre-flight or a pause), for a remounted UI.
    pub fn pending(&self, tokens_of: impl Fn(&str) -> u64) -> Vec<ScaledView> {
        let now = now_millis();
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|c| matches!(c.phase, Phase::Preflight | Phase::Paused { .. }))
            .map(|c| ScaledView { usage: c.usage(now, tokens_of(&c.plan_session_id)), ctl: c.clone() })
            .collect()
    }
}

fn live_tokens(app: &AppHandle, plan_sid: &str) -> u64 {
    app.try_state::<crate::runwatch::RunWatchState>()
        .and_then(|s| s.live_budget_tokens(plan_sid))
        .unwrap_or(0)
}

fn view(app: &AppHandle, ctl: &RunCtl) -> ScaledView {
    ScaledView { usage: ctl.usage(now_millis(), live_tokens(app, &ctl.plan_session_id)), ctl: ctl.clone() }
}

fn persist(app: &AppHandle, ctl: &RunCtl) {
    let db = app.state::<crate::state::SessionStore>().database();
    if let Err(e) = db.upsert_scaled_run(ctl) {
        tracing::warn!(error = %e, "scaled: failed to persist the run");
    }
}

fn emit(app: &AppHandle, event: &str, ctl: &RunCtl) {
    let _ = app.emit(event, view(app, ctl));
}

fn hook_allow(reason: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": reason}})
}

fn hook_deny(reason: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}})
}

// --- HTTP: the hooks and the brief ---------------------------------------------------

/// `POST /v1/scaled/:run/preflight` — the Workflow call, held for Run / Edit
/// / Cancel. An unknown run is a pass-through (the CLI's own card decides).
pub(crate) async fn handle_preflight(
    State(app_state): State<crate::AppState>,
    AxPath(run_id): AxPath<String>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let app = app_state.app_handle.clone();
    let scaled = app.state::<ScaledState>().inner().clone();
    if !scaled.ensure_loaded(&app_state.store.database(), &run_id) {
        return Json(json!({}));
    }
    let script = payload.pointer("/tool_input/script").and_then(Value::as_str).unwrap_or("");
    let Some(ctl) = scaled.with(&run_id, |ctl| {
        if let Phase::Stopped { reason } = &ctl.phase {
            return Err(stop_message(reason, false));
        }
        ctl.preflight = Some(analyze_script(script, &ctl.config));
        ctl.phase = Phase::Preflight;
        Ok(ctl.clone())
    }) else {
        return Json(json!({}));
    };
    let ctl = match ctl {
        Ok(ctl) => ctl,
        Err(denied) => return Json(hook_deny(&denied)),
    };
    let (tx, rx) = oneshot::channel();
    scaled.preflight.lock().unwrap_or_else(|e| e.into_inner()).insert(run_id.clone(), tx);
    persist(&app, &ctl);
    emit(&app, "scaled-preflight", &ctl);
    let wait = Duration::from_secs(PREFLIGHT_HOOK_TIMEOUT_S - HOLD_MARGIN_S);
    let decision = match tokio::time::timeout(wait, rx).await {
        Ok(Ok(decision)) => decision,
        _ => PreflightDecision::Cancel,
    };
    scaled.preflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&run_id);
    let now = now_millis();
    let (out, ctl) = scaled
        .with(&run_id, |ctl| {
            let out = match &decision {
                PreflightDecision::Run => {
                    ctl.phase = Phase::Running;
                    ctl.started_at.get_or_insert(now);
                    hook_allow("Approved in Redline's pre-flight: run this workflow.")
                }
                PreflightDecision::Edit(note) => {
                    ctl.phase = Phase::Launching;
                    hook_deny(&format!(
                        "The user reviewed this workflow in Redline and wants changes before it runs: {note}. Revise the script and call Workflow again."
                    ))
                }
                PreflightDecision::Cancel => {
                    ctl.stop("cancelled before it ran");
                    hook_deny("The user cancelled this build in Redline before it ran. Do not run a workflow and do not build the plan yourself; end your turn.")
                }
            };
            (out, ctl.clone())
        })
        .unwrap_or_else(|| (json!({}), ctl));
    persist(&app, &ctl);
    scaled.bump();
    emit(&app, "scaled-changed", &ctl);
    Json(out)
}

/// `POST /v1/scaled/:run/gate` — every tool call of the run. No opinion
/// unless the run is paused (held) or stopped (denied).
pub(crate) async fn handle_gate(
    State(app_state): State<crate::AppState>,
    AxPath(run_id): AxPath<String>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let app = app_state.app_handle.clone();
    let scaled = app.state::<ScaledState>().inner().clone();
    if !scaled.ensure_loaded(&app_state.store.database(), &run_id) {
        return Json(json!({}));
    }
    // The pre-flight route owns the Workflow call.
    let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
    if tool == "Workflow" {
        return Json(json!({}));
    }
    let agent_id = payload
        .get("agent_id")
        .and_then(Value::as_str)
        .filter(|_| payload.get("agent_type").and_then(Value::as_str) == Some("workflow-subagent"))
        .map(str::to_string);
    let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(GATE_HOOK_TIMEOUT_S - HOLD_MARGIN_S);
    let mut rx = scaled.changed.subscribe();
    loop {
        let Some(plan_sid) = scaled.with(&run_id, |c| c.plan_session_id.clone()) else { return Json(json!({})) };
        let tokens = live_tokens(&app, &plan_sid);
        let verdict = scaled
            .with(&run_id, |ctl| (ctl.gate(agent_id.as_deref(), &tool, &input, now_millis(), tokens), ctl.clone()));
        let Some((verdict, ctl)) = verdict else { return Json(json!({})) };
        match verdict {
            GateVerdict::Pass => return Json(json!({})),
            GateVerdict::Deny(reason) => return Json(hook_deny(&reason)),
            GateVerdict::Hold { newly, .. } => {
                if newly {
                    persist(&app, &ctl);
                    emit(&app, "scaled-paused", &ctl);
                }
            }
        }
        rx.borrow_and_update();
        if tokio::time::timeout_at(deadline, rx.changed()).await.is_err() {
            // Nobody answered within the hook's lifetime: stop rather than let
            // the CLI time the hook out (which would silently resume).
            if let Some(ctl) = scaled.with(&run_id, |ctl| {
                ctl.stop("no answer to the pause within an hour");
                ctl.clone()
            }) {
                persist(&app, &ctl);
                scaled.bump();
                emit(&app, "scaled-changed", &ctl);
            }
        }
    }
}

/// `GET /v1/scaled/:run/brief` — the lead's brief (plain text).
pub(crate) async fn handle_brief(
    State(app_state): State<crate::AppState>,
    AxPath(run_id): AxPath<String>,
) -> (axum::http::StatusCode, String) {
    let app = app_state.app_handle.clone();
    let scaled = app.state::<ScaledState>().inner().clone();
    if !scaled.ensure_loaded(&app_state.store.database(), &run_id) {
        return (axum::http::StatusCode::NOT_FOUND, format!("no scaled build {run_id}"));
    }
    let Some((cfg, plan_sid)) = scaled.with(&run_id, |c| (c.config.clone(), c.plan_session_id.clone())) else {
        return (axum::http::StatusCode::NOT_FOUND, format!("no scaled build {run_id}"));
    };
    let Some(session) = app_state.store.get(&plan_sid) else {
        return (axum::http::StatusCode::NOT_FOUND, format!("no plan session {plan_sid}"));
    };
    let plan = session.revisions.last().map(|r| r.raw_plan_markdown.clone()).unwrap_or_default();
    (axum::http::StatusCode::OK, build_brief(&cfg, &run_id, &plan_sid, &plan))
}

// --- Commands --------------------------------------------------------------------------

/// Register a run and write its `--settings` file. Called by
/// `scaled_build_start` (lib.rs) once the plan is approved for it.
pub fn create_run(app: &AppHandle, plan_session_id: &str, config: ScaleConfig) -> Result<(RunCtl, String), String> {
    let run_id = format!("sb-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("scaled");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{run_id}.json"));
    let body = serde_json::to_string_pretty(&settings_json(&run_id)).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("could not write the build's settings: {e}"))?;
    let ctl = RunCtl::new(&run_id, plan_session_id, config);
    app.state::<ScaledState>().insert(ctl.clone());
    persist(app, &ctl);
    Ok((ctl, path.to_string_lossy().into_owned()))
}

/// The Auto scale's defaults, with the lead on the orchestrator seat's model
/// (never the CLI default: every agent that names no model inherits it).
/// The Custom dialog starts from these.
#[tauri::command]
pub fn scaled_defaults() -> ScaleConfig {
    let lead = crate::seat::model_for("orchestrator")
        .filter(|m| crate::seat::MODEL_OPTIONS.contains(&m.as_str()))
        .unwrap_or_else(|| "sonnet".to_string());
    ScaleConfig::auto(&lead)
}

#[tauri::command]
pub fn scaled_preflight_decide(
    app: AppHandle,
    scaled: tauri::State<'_, ScaledState>,
    run_id: String,
    decision: String,
    note: Option<String>,
) -> Result<(), String> {
    let decision = match decision.as_str() {
        "run" => PreflightDecision::Run,
        "cancel" => PreflightDecision::Cancel,
        "edit" => {
            let note = note.map(|n| n.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|n| !n.is_empty());
            PreflightDecision::Edit(note.ok_or("say what to change")?.chars().take(1_000).collect())
        }
        other => return Err(format!("unknown decision `{other}`")),
    };
    let tx = scaled.preflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&run_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(decision);
            Ok(())
        }
        None => {
            // The hook already gave up (timed out) or the app restarted.
            let _ = app.emit("scaled-changed", json!({"runId": run_id}));
            Err("this pre-flight is no longer waiting".into())
        }
    }
}

#[tauri::command]
pub fn scaled_pause_decide(
    app: AppHandle,
    scaled: tauri::State<'_, ScaledState>,
    run_id: String,
    decision: String,
) -> Result<(), String> {
    let plan_sid = scaled.with(&run_id, |c| c.plan_session_id.clone()).ok_or("no such build")?;
    let tokens = live_tokens(&app, &plan_sid);
    let ctl = scaled
        .with(&run_id, |ctl| {
            match decision.as_str() {
                "extend" => ctl.extend(now_millis(), tokens),
                "stop" => ctl.stop("stopped at its limit"),
                _ => return Err(format!("unknown decision `{decision}`")),
            }
            Ok(ctl.clone())
        })
        .ok_or("no such build")??;
    persist(&app, &ctl);
    scaled.bump();
    emit(&app, "scaled-changed", &ctl);
    Ok(())
}

/// Stop a build from the UI at any time (not only at a pause).
#[tauri::command]
pub fn scaled_stop(app: AppHandle, scaled: tauri::State<'_, ScaledState>, run_id: String) -> Result<(), String> {
    let ctl = scaled
        .with(&run_id, |ctl| {
            ctl.stop("stopped by the user");
            ctl.clone()
        })
        .ok_or("no such build")?;
    if let Some(tx) = scaled.preflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&run_id) {
        let _ = tx.send(PreflightDecision::Cancel);
    }
    persist(&app, &ctl);
    scaled.bump();
    emit(&app, "scaled-changed", &ctl);
    Ok(())
}

#[tauri::command]
pub fn scaled_pending(app: AppHandle, scaled: tauri::State<'_, ScaledState>) -> Vec<ScaledView> {
    scaled.pending(|sid| live_tokens(&app, sid))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = r#"export const meta = {
  name: 'build-auth',
  description: 'Build the auth rework',
  phases: [{ title: 'Explore' }, { title: 'Build' }, { title: 'Verify' }],
}
const scout = await agent('Map the auth module and list every caller of login()', { label: 'scout', model: 'haiku' })
const built = await parallel([
  () => agent('Implement the token refresh path described in the plan section', { label: 'refresh' }),
  () => agent('Implement the logout endpoint described in the plan section', { label: 'logout', model: 'opus' }),
])
await agent('Verify the whole change against the plan and run the tests', { label: 'verify' })
"#;

    fn cfg() -> ScaleConfig {
        ScaleConfig::auto("sonnet")
    }

    #[test]
    fn the_preflight_reads_call_sites_phases_and_models() {
        let p = analyze_script(SCRIPT, &cfg());
        assert_eq!(p.name.as_deref(), Some("build-auth"));
        assert_eq!(p.phases, ["Explore", "Build", "Verify"]);
        assert_eq!(p.call_sites, 4);
        assert!(!p.dynamic);
        assert!(p.estimate.agents_exact);
        assert_eq!(p.estimate.agents, 4);
        assert_eq!(p.models, [("sonnet".to_string(), 2), ("haiku".to_string(), 1), ("opus".to_string(), 1)]);
        // Opus is outside an Auto build's models (sonnet lead, haiku scouts).
        assert!(p.warnings.iter().any(|w| w.contains("`opus`")), "{:?}", p.warnings);
        assert_eq!(p.estimate.minutes, 5 + 12 * 3);
        assert!(p.estimate.tokens > 0);
    }

    #[test]
    fn a_per_item_fan_out_is_an_estimate_bounded_by_the_cap() {
        let script = "const files = ['a','b']\nawait parallel(files.map(f => () => agent('Fix the file ' + f + ' as the plan says')))";
        let p = analyze_script(script, &cfg());
        assert!(p.dynamic);
        assert!(!p.estimate.agents_exact);
        assert!(p.estimate.agents <= DEFAULT_MAX_AGENTS);
        let empty = analyze_script("return 1", &cfg());
        assert_eq!(empty.call_sites, 0);
        assert!(empty.warnings[0].contains("could not find any agent() calls"));
    }

    #[test]
    fn a_script_over_the_cap_is_flagged_before_it_runs() {
        let custom = ScaleConfig { scale: "custom".into(), max_agents: 2, ..cfg() };
        let p = analyze_script(SCRIPT, &custom);
        assert!(p.warnings.iter().any(|w| w.contains("over this build's cap of 2")));
    }

    #[test]
    fn config_is_clamped_and_unknown_models_are_refused() {
        let c = ScaleConfig { max_agents: 500, token_budget: 1, time_budget_mins: 0, steer: Some("  go\n fast  ".into()), ..cfg() }
            .sanitize()
            .unwrap();
        assert_eq!((c.max_agents, c.token_budget, c.time_budget_mins), (64, 100_000, 5));
        assert_eq!(c.steer.as_deref(), Some("go fast"));
        assert!(ScaleConfig { worker_model: Some("gpt-5".into()), ..cfg() }.sanitize().is_err());
        assert!(ScaleConfig { effort: Some("turbo".into()), ..cfg() }.sanitize().is_err());
        assert_eq!(ScaleConfig { scale: "weird".into(), ..cfg() }.sanitize().unwrap().scale, "auto");
    }

    fn running(max_agents: u32) -> RunCtl {
        let mut ctl = RunCtl::new("sb-1", "plan-1", ScaleConfig { max_agents, ..cfg() });
        ctl.phase = Phase::Running;
        ctl.started_at = Some(0);
        ctl
    }

    #[test]
    fn the_gate_passes_until_a_new_agent_would_exceed_the_cap() {
        let mut ctl = running(2);
        let read = json!({"file_path": "x"});
        assert_eq!(ctl.gate(Some("a1"), "Read", &read, 1, 0), GateVerdict::Pass);
        assert_eq!(ctl.gate(Some("a2"), "Read", &read, 1, 0), GateVerdict::Pass);
        // A known agent keeps going; the lead keeps going.
        assert_eq!(ctl.gate(Some("a1"), "Read", &read, 1, 0), GateVerdict::Pass);
        assert_eq!(ctl.gate(None, "Read", &read, 1, 0), GateVerdict::Pass);
        // A third agent trips the cap: held, announced once.
        assert_eq!(ctl.gate(Some("a3"), "Read", &read, 1, 0), GateVerdict::Hold { reason: PauseReason::Agents, newly: true });
        assert_eq!(ctl.gate(Some("a1"), "Read", &read, 1, 0), GateVerdict::Hold { reason: PauseReason::Agents, newly: false });
        // Extend raises the cap; the held agent is admitted on its re-check.
        ctl.extend(1, 0);
        assert_eq!(ctl.limits.agents, 4);
        assert_eq!(ctl.gate(Some("a3"), "Read", &read, 1, 0), GateVerdict::Pass);
        assert_eq!(ctl.usage(1, 0).agents, 3);
    }

    #[test]
    fn tokens_and_time_pause_the_run_and_extend_past_current_use() {
        let mut ctl = running(8);
        let v = Value::Null;
        assert_eq!(ctl.gate(Some("a"), "Read", &v, 1, DEFAULT_TOKEN_BUDGET + 1), GateVerdict::Hold { reason: PauseReason::Tokens, newly: true });
        ctl.extend(1, DEFAULT_TOKEN_BUDGET + 1);
        assert!(ctl.limits.tokens > DEFAULT_TOKEN_BUDGET + 1);
        assert_eq!(ctl.gate(Some("a"), "Read", &v, 1, DEFAULT_TOKEN_BUDGET + 1), GateVerdict::Pass);
        let late = DEFAULT_TIME_BUDGET_MINS as i64 * 60_000;
        assert_eq!(ctl.gate(Some("a"), "Read", &v, late, 0), GateVerdict::Hold { reason: PauseReason::Time, newly: true });
        ctl.extend(late, 0);
        assert_eq!(ctl.gate(Some("a"), "Read", &v, late, 0), GateVerdict::Pass);
    }

    #[test]
    fn a_stopped_build_denies_everything_but_the_leads_report_and_review() {
        let mut ctl = running(8);
        ctl.stop("stopped at its limit");
        let edit = json!({"file_path": "x"});
        match ctl.gate(Some("a"), "Edit", &edit, 1, 0) {
            GateVerdict::Deny(reason) => assert!(reason.contains("End this task now")),
            other => panic!("{other:?}"),
        }
        match ctl.gate(None, "Edit", &edit, 1, 0) {
            GateVerdict::Deny(reason) => assert!(reason.contains("exit report")),
            other => panic!("{other:?}"),
        }
        let report = json!({"command": "curl -s http://127.0.0.1:7676/v1/orchestration/report -X POST"});
        assert_eq!(ctl.gate(None, "Bash", &report, 1, 0), GateVerdict::Pass);
        // A subagent cannot sneak a curl through.
        assert!(matches!(ctl.gate(Some("a"), "Bash", &report, 1, 0), GateVerdict::Deny(_)));
        // Before the workflow runs, the gate has no opinion.
        let mut fresh = RunCtl::new("sb-2", "plan-1", cfg());
        assert_eq!(fresh.gate(None, "Bash", &report, 1, 0), GateVerdict::Pass);
    }

    #[test]
    fn a_run_survives_a_restart_without_its_waiting_preflight() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut ctl = running(3);
        ctl.limits.agents = 5;
        db.upsert_scaled_run(&ctl).unwrap();
        let back = db.get_scaled_run("sb-1").unwrap().unwrap();
        assert_eq!((back.limits.agents, back.phase.clone(), back.started_at), (5, Phase::Running, Some(0)));
        assert_eq!(back.config, ctl.config);
        // A pre-flight cannot still be held after a restart.
        ctl.phase = Phase::Preflight;
        db.upsert_scaled_run(&ctl).unwrap();
        assert_eq!(db.get_scaled_run("sb-1").unwrap().unwrap().phase, Phase::Launching);
        ctl.stop("stopped at its limit");
        db.upsert_scaled_run(&ctl).unwrap();
        assert!(matches!(db.get_scaled_run("sb-1").unwrap().unwrap().phase, Phase::Stopped { .. }));
        assert!(db.get_scaled_run("nope").unwrap().is_none());
    }

    #[test]
    fn the_settings_hook_only_this_run() {
        let s = settings_json("sb-abc");
        let hooks = s.pointer("/hooks/PreToolUse").unwrap().as_array().unwrap();
        assert_eq!(hooks[0]["matcher"], "Workflow");
        assert_eq!(hooks[0]["hooks"][0]["url"], "http://127.0.0.1:7676/v1/scaled/sb-abc/preflight");
        assert_eq!(hooks[0]["hooks"][0]["timeout"], PREFLIGHT_HOOK_TIMEOUT_S);
        assert_eq!(hooks[1]["matcher"], "*");
        assert_eq!(hooks[1]["hooks"][0]["url"], "http://127.0.0.1:7676/v1/scaled/sb-abc/gate");
        assert!(PREFLIGHT_HOOK_TIMEOUT_S > HOLD_MARGIN_S && GATE_HOOK_TIMEOUT_S > HOLD_MARGIN_S);
    }

    #[test]
    fn the_brief_carries_the_budget_models_contract_and_the_clean_plan() {
        let c = ScaleConfig {
            scale: "custom".into(),
            max_agents: 6,
            token_budget: 3_000_000,
            worker_model: Some("sonnet".into()),
            effort: Some("high".into()),
            steer: Some("Keep the API stable.".into()),
            ..ScaleConfig::auto("opus")
        };
        let b = build_brief(&c, "sb-9", "plan-7", "<!-- rl:blk-abc123 -->\n# Auth\n\nDo it.\n");
        assert!(b.contains("At most 6 agents"));
        assert!(b.contains("About 3M tokens"));
        assert!(b.contains("The session model is `opus`"));
        assert!(b.contains("{ model: 'sonnet' }"));
        assert!(b.contains("{ model: 'haiku' }"));
        assert!(b.contains("Effort is `high`"));
        assert!(b.contains("independent verification agent"));
        assert!(b.contains("Keep the API stable."));
        assert!(b.contains("Never `git stash`"));
        assert!(b.contains("\"planSessionId\":\"plan-7\""));
        assert!(b.contains("{{REDLINE_DAEMON_TOKEN}}"));
        assert!(b.contains("plan=plan-7"));
        assert!(b.contains("# Auth\n\nDo it."));
        assert!(!b.contains("rl:blk-"));
        assert!(!build_brief(&ScaleConfig { verify: false, ..c }, "sb-9", "plan-7", "x").contains("independent verification agent"));
    }
}

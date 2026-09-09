//! Control-plane auth (Shardplate Phase 2): the daemon on `127.0.0.1:7676`
//! is Redline's de facto extension API, and until now its entire trust model
//! was the loopback bind — any local process could post suggestions, drive
//! the browser, and stage memory proposals while Redline ran. This module
//! puts a lock on the mutating half without breaking the two contracts that
//! must stay open:
//!
//! - **Hook contract** routes (`/v1/plan`, `/v1/prompts/ingest`,
//!   `/v1/reviews/start`, feedback GET) are called by the user's *own*
//!   claude sessions anywhere on the machine via the globally installed
//!   hooks/skills. Those sessions are not Redline children and cannot carry
//!   a per-boot secret, so they stay open by design.
//! - **Read-only** routes stay open for now so an external session's MCP
//!   client (the daemon's own `/mcp` mount, read tools only) keeps working
//!   with zero configuration; tokenizing reads is an explicit second pass.
//!
//! Everything else — the agent-write routes — requires a bearer token:
//! either the per-boot master token (handed to every process Redline spawns
//! via the `REDLINE_DAEMON_TOKEN` env var) or a per-extension token scoped
//! to the route's scope (see `extension.rs`).
//!
//! Two deliberate deviations from the naive design:
//! - The token rides the **environment**, not the `--allowedTools` strings.
//!   The permission rules are persistent (settings.json backfill) and
//!   prefix-glob matched, so a per-boot literal there is both impossible to
//!   keep fresh and a transcript leak. But agents cannot reach an env var
//!   through the shell either: the bash sandbox **rejects any command
//!   containing shell expansion before it runs**, so the obvious
//!   `-H "Authorization: Bearer $REDLINE_DAEMON_TOKEN"` never executes.
//!   Agents therefore have *curl itself* import the variable, no shell
//!   involved:
//!
//!   ```text
//!   curl -s http://127.0.0.1:7676/v1/… \
//!     --variable %REDLINE_DAEMON_TOKEN= \
//!     --expand-header "Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}" \
//!     -X POST -H 'Content-Type: application/json' -d '{…}'
//!   ```
//!
//!   The trailing `=` supplies an empty default, so a caller without the
//!   variable (an external claude session running the globally installed
//!   skills) gets a readable 401 instead of curl's `variable expansion
//!   failure`. Needs curl >= 8.3, where both flags landed. The URL still
//!   sits immediately after `-s` and every flag after it, so the existing
//!   `curl -s http://127.0.0.1:7676/*` prefix rules keep matching — no
//!   allow-string churn anywhere.
//! - The middleware **fails closed on unregistered routes**: a new route
//!   401s until it gets a `ROUTE_TABLE` entry. That is the "freeze /v1"
//!   half of Phase 2 made mechanical — the table (and the generated
//!   `docs/api-v1.md`) cannot drift from the router silently.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use axum::extract::{MatchedPath, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Env var carrying the per-boot master token into every process Redline
/// spawns (agent turns via `claude_proc`, terminals via `pty`). Skills and
/// embedded prompts never name it to the shell — the bash sandbox rejects
/// commands containing expansion — so they have curl import it directly with
/// `--variable %REDLINE_DAEMON_TOKEN= --expand-header "Authorization: Bearer
/// {{REDLINE_DAEMON_TOKEN}}"` (curl >= 8.3).
pub const ENV_DAEMON_TOKEN: &str = "REDLINE_DAEMON_TOKEN";

/// How a route is guarded. The four classes are the whole story of the
/// v1 contract; every route declares exactly one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteClass {
    /// No credential. Read-only queries (open until the second-pass
    /// tokenization of reads) and static viewer assets.
    Open,
    /// No credential *by design*, even though it mutates: the globally
    /// installed hook/skill contract with claude sessions Redline did not
    /// spawn. Documented as such in the generated API table.
    HookContract,
    /// Bearer token required: the master per-boot token, or an extension
    /// token whose grant includes this scope.
    Protected(&'static str),
    /// Bearer token required and it must be THE master token — extension
    /// tokens never qualify, whatever their scopes. For control-plane verbs
    /// no extension has any business holding (today: `/v1/admin/shutdown`,
    /// which a booting sibling's preflight uses to retire a headless
    /// incumbent). Deliberately not a scope: scopes are requestable in
    /// extension manifests, and this must never be.
    MasterOnly,
}

/// One row of the frozen v1 contract. `path` is the axum route pattern
/// exactly as registered (`MatchedPath` returns the same string, which is
/// what makes the middleware lookup exact rather than fuzzy).
#[derive(Debug, Clone, Copy)]
pub struct RouteSpec {
    pub method: &'static str,
    pub path: &'static str,
    pub class: RouteClass,
    pub purpose: &'static str,
    pub request: &'static str,
    pub response: &'static str,
}

/// Scope names, one per protected capability group. Extensions request
/// these in their manifest; `extension.rs` validates against this list.
///
/// The names themselves live in `redline-extension-abi` (re-exported here)
/// so manifests, SDK helper docs, and this table spell them identically —
/// this module stays sovereign over route classes, `ROUTE_TABLE`, and the
/// `authorize()` decision. `SCOPE_PLAN_OFFER` is deliberately **not** a
/// reuse of `plan.comment`: "may propose, may not write" is exactly the
/// capability an offer invents, and `ROUTE_TABLE` is keyed on
/// `(method, path)` — so a flag in the body could never carry its own class.
pub use redline_extension_abi::scopes::{
    BROWSER_DRIVE as SCOPE_BROWSER_DRIVE, CONSULT as SCOPE_CONSULT,
    DRAFTER_SUGGEST as SCOPE_DRAFTER_SUGGEST, ORCH_REPORT as SCOPE_ORCH_REPORT, PLAN_COMMENT as SCOPE_PLAN_COMMENT,
    PLAN_OFFER as SCOPE_PLAN_OFFER, PLAN_SUGGEST as SCOPE_PLAN_SUGGEST,
    REVIEW_ANNOTATE as SCOPE_REVIEW_ANNOTATE, UI_PANEL as SCOPE_UI_PANEL,
    WORK_CLAIM as SCOPE_WORK_CLAIM, WORK_FILE as SCOPE_WORK_FILE, KNOWN_SCOPES,
};

/// Redline's OWN rows of the frozen `/v1` contract, in router registration
/// order — every route `lib.rs` registers itself. The memory and context
/// routes are Polis Memory's (`polis_server::ROUTES`, merged into the same
/// router) and join these in [`all_routes`], which is what the middleware
/// consults on every request (so it is load-bearing, not
/// documentation-adjacent) and what `docs/api-v1.md` is generated from. A
/// test asserts this table matches the `.route(...)` registrations in
/// `lib.rs` byte for byte, and another that the merged router serves every
/// polis row under this auth.
pub const ROUTE_TABLE: &[RouteSpec] = &[
    // The Model Context Protocol mount (E1): `polis_mcp::http_service`,
    // served at `/mcp` in `run_server` as a route (`any_service`). Streamable
    // HTTP speaks three verbs at that one path — POST (a message), GET (the
    // server→client event stream), DELETE (end the session) — and axum sets
    // `MatchedPath` = "/mcp" for it, so these three rows are what the
    // middleware sees. Read tools only (`memory_search`, `memory_context`,
    // `memory_grep`, `memory_tree`, `memory_node`, `memory_timeline`,
    // `memory_stats`, `memory_verify` + the legacy aliases), so Open, like the
    // reads it is built on. Not `nest_service`: that would also serve
    // `/mcp/anything` with no MatchedPath at all (outside this table), and
    // rmcp is path-agnostic. A sub-path is the router's own 404.
    RouteSpec {
        method: "POST",
        path: "/mcp",
        class: RouteClass::Open,
        purpose: "MCP (streamable HTTP): a JSON-RPC message — initialize, tools/list, tools/call, resources, prompts; read tools only",
        request: "JSON-RPC 2.0 body; Accept: application/json, text/event-stream; Mcp-Session-Id after initialize",
        response: "JSON or an SSE stream carrying the result; Mcp-Session-Id header on initialize",
    },
    RouteSpec {
        method: "GET",
        path: "/mcp",
        class: RouteClass::Open,
        purpose: "MCP (streamable HTTP): the server→client event stream for an open session",
        request: "Accept: text/event-stream; Mcp-Session-Id",
        response: "text/event-stream",
    },
    RouteSpec {
        method: "DELETE",
        path: "/mcp",
        class: RouteClass::Open,
        purpose: "MCP (streamable HTTP): end a session",
        request: "Mcp-Session-Id",
        response: "202 / 204",
    },
    RouteSpec {
        method: "GET",
        path: "/viewer",
        class: RouteClass::Open,
        purpose: "Redirect to /viewer/ so relative asset refs resolve",
        request: "—",
        response: "308 → /viewer/",
    },
    RouteSpec {
        method: "GET",
        path: "/viewer/",
        class: RouteClass::Open,
        purpose: "Async-share viewer page (sender's local preview)",
        request: "—",
        response: "text/html viewer bundle index",
    },
    RouteSpec {
        method: "GET",
        path: "/viewer/*path",
        class: RouteClass::Open,
        purpose: "Async-share viewer static assets (legacy standalone bundle)",
        request: "path of the bundled asset",
        response: "asset bytes with content type",
    },
    RouteSpec {
        method: "GET",
        path: "/assets/*path",
        class: RouteClass::Open,
        purpose: "Shared build chunks for the async-share viewer page (folded into the app build)",
        request: "path of the built asset under dist/assets",
        response: "asset bytes with content type",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/plan",
        class: RouteClass::HookContract,
        purpose: "Plan-hold ingest: the ExitPlanMode hook POSTs the plan and blocks until the review resolves",
        request: "JSON hook payload {session_id, plan markdown, cwd, ...}",
        response: "held; resolves to the review verdict (approve/deny reason)",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/codex/stop",
        class: RouteClass::HookContract,
        purpose: "Codex Plan-mode Stop hook: extracts the proposed plan and holds until review resolves",
        request: "JSON Codex Stop payload {session_id, turn_id, permission_mode, last_assistant_message, ...}",
        response: "{} to finish the turn, or {decision:\"block\", reason} to request revision",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/cursor/prompt",
        class: RouteClass::HookContract,
        purpose: "Cursor prompt capture using the shared memory ingest contract",
        request: "prompt, conversation_id, workspace_roots",
        response: "continue true",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/cursor/response",
        class: RouteClass::HookContract,
        purpose: "Cache the complete Cursor response for its exact conversation and generation",
        request: "conversation_id, generation_id, text",
        response: "empty object",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/cursor/stop",
        class: RouteClass::HookContract,
        purpose: "Hold the completed Cursor plan for review",
        request: "conversation_id, generation_id, status",
        response: "empty object or followup_message",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/antigravity/stop",
        class: RouteClass::HookContract,
        purpose: "Hold a completed Antigravity plan from its confined transcript",
        request: "conversationId, executionNum, transcriptPath, fullyIdle",
        response: "decision allow or continue with reason",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/runs/claim",
        class: RouteClass::HookContract,
        purpose: "Runner first-write ownership guard for a live task",
        request: "run, node and attempt headers; tool_name, tool_input",
        response: "PreToolUse allow or deny",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/sessions/:session_id/plan",
        class: RouteClass::Open,
        purpose: "Latest plan revision with block structure (agent-in-doc read)",
        request: "session id in path",
        response: "JSON {version, blocks:[{id, markdown}, ...]}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/sessions/:session_id/suggestions",
        class: RouteClass::Protected(SCOPE_PLAN_SUGGEST),
        purpose: "Post a tracked edit suggestion against a plan block",
        request: "JSON {block_id, op, markdown, ...}",
        response: "JSON accepted suggestion (or staleness error)",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/sessions/:session_id/comments",
        class: RouteClass::Protected(SCOPE_PLAN_COMMENT),
        purpose: "Capture a [feedback] comment (voice agent and read-only agents) that rides the next Revise",
        request: "JSON {body, block_id?, ...}",
        response: "JSON created comment",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/sessions/:session_id/comment-offers",
        class: RouteClass::Protected(SCOPE_PLAN_OFFER),
        purpose: "Stage an OFFERED plan item — a `＋ Add as item` chip in the discussion panel; nothing is written until the user taps it",
        request: "JSON {blockId, body, label?, agentId}",
        response: "JSON {id, status:\"pending\"} — the offer, not a comment",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/sessions/:session_id/feedback",
        class: RouteClass::HookContract,
        purpose: "Out-of-band delivery of the full review payload after a calm one-line deny",
        request: "session id in path",
        response: "the pending feedback body (plain text payload)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/browser/active",
        class: RouteClass::Open,
        purpose: "The tab the user is looking at (id, ordinal, url, title)",
        request: "—",
        response: "JSON active-tab summary",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/browser/tabs",
        class: RouteClass::Open,
        purpose: "All open tabs with ordinals",
        request: "—",
        response: "JSON tab list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/browser/thread",
        class: RouteClass::Open,
        purpose: "A tab's page-discussion thread",
        request: "?tab= ordinal or id",
        response: "JSON message list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/browser/snapshot",
        class: RouteClass::Open,
        purpose: "Text snapshot of a tab's DOM",
        request: "?tab= ordinal or id",
        response: "JSON {url, title, text}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/query",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Evaluate a DOM-extraction program on a live tab (wakes suspended tabs)",
        request: "JSON {tab?, query program}",
        response: "JSON extraction result",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/navigate",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Navigate a tab",
        request: "JSON {tab?, url}",
        response: "JSON navigation result",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/click",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Click an element on a live tab",
        request: "JSON {tab?, selector/target}",
        response: "JSON click result",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/open",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Open a new tab",
        request: "JSON {url}",
        response: "JSON new-tab summary",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/focus",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Focus a tab",
        request: "JSON {tab}",
        response: "JSON focus result",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/browser/download",
        class: RouteClass::Protected(SCOPE_BROWSER_DRIVE),
        purpose: "Save the viewed page or a linked file to disk (the agent's only file-write path)",
        request: "JSON {tab?, url?, destination}",
        response: "JSON saved-file path",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/mission/active",
        class: RouteClass::Open,
        purpose: "The active research mission's goal and enrollment",
        request: "—",
        response: "JSON mission summary (or none)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/mission/findings",
        class: RouteClass::Open,
        purpose: "The user's pinned findings for the active mission",
        request: "—",
        response: "JSON pin list",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/linked/consult",
        class: RouteClass::Protected(SCOPE_CONSULT),
        purpose: "Delegate a heavy tab to its own page-discussion agent for a digest (map-reduce)",
        request: "JSON {tab, question}",
        response: "JSON digest text",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/global/consult",
        class: RouteClass::Protected(SCOPE_CONSULT),
        purpose: "Companion fan-out: consult any surface's agent for a digest",
        request: "JSON {surface/agent, question}",
        response: "JSON digest text",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/global/agents",
        class: RouteClass::Open,
        purpose: "The agent map: which per-surface agents exist right now",
        request: "—",
        response: "JSON agent list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/code/projects",
        class: RouteClass::Open,
        purpose: "The user's known project folders (the browse agent's code map)",
        request: "—",
        response: "JSON project path list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/code/git",
        class: RouteClass::Open,
        purpose: "Whitelisted read-only git ops (status/branch/log/diff/show) in a known project",
        request: "?repo= known project, ?op= whitelisted op",
        response: "JSON git output",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/overview",
        class: RouteClass::Open,
        purpose: "Librarian friction digest: ground-truth counts and staleness",
        request: "—",
        response: "JSON overview",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/codehealth",
        class: RouteClass::Open,
        purpose: "Shipwright code digest: git state, recorded corrections, static repo health, runtime failures, unfinished work",
        request: "?repo=<absolute path>",
        response: "JSON code digest",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/sessions/:id/history",
        class: RouteClass::Open,
        purpose: "One plan session's full history",
        request: "session id in path",
        response: "JSON history",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/surface/active",
        class: RouteClass::Open,
        purpose: "Where the user is right now (mirrored ActiveSurface cell)",
        request: "—",
        response: "JSON surface id",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/journal/recent",
        class: RouteClass::Open,
        purpose: "Context-journal delta (Companion passive awareness)",
        request: "?since=...",
        response: "JSON journal entries",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/drafter/:draft_id/doc",
        class: RouteClass::Open,
        purpose: "The live draft's markdown mirror",
        request: "draft id in path",
        response: "JSON {blocks/markdown}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/drafter/:draft_id/suggestions",
        class: RouteClass::Protected(SCOPE_DRAFTER_SUGGEST),
        purpose: "Write a tracked suggestion into the draft (append/replace_block/insert_after/delete_block)",
        request: "JSON suggestion op",
        response: "JSON accepted suggestion (or staleness error)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/reviews/start",
        class: RouteClass::HookContract,
        purpose: "Code-review hold: captures the diff, opens the review pane, HOLDS until the reviewer submits",
        request: "?repo=&base=... from the /redline-code-review skill; defer=1 parks the review for the morning (queued overnight runs)",
        response: "held; resolves to structured line-anchored feedback (deferred: returns immediately)",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/reviews/annotations",
        class: RouteClass::Open,
        purpose: "List external annotations on a live review",
        request: "?repo= known project",
        response: "JSON annotation list",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/reviews/annotations",
        class: RouteClass::Protected(SCOPE_REVIEW_ANNOTATE),
        purpose: "Post a finding into a live review (external local tools)",
        request: "JSON schema-only body with required source tag",
        response: "JSON created annotation",
    },
    RouteSpec {
        method: "DELETE",
        path: "/v1/reviews/annotations",
        class: RouteClass::Protected(SCOPE_REVIEW_ANNOTATE),
        purpose: "Clear a source's annotations from a live review",
        request: "?repo=&source=...",
        response: "JSON cleared count",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/orchestration/report",
        class: RouteClass::Protected(SCOPE_ORCH_REPORT),
        purpose: "File an orchestrated run's structured exit report (claims paired against observed ground truth in the RunReport GUI)",
        request: "JSON {planSessionId, scriptPath, workflowRan, summary, subtasks:[{title, planSection, verified, skipped, notes}]}",
        response: "JSON {ok}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/work/ready",
        class: RouteClass::Open,
        purpose: "The work graph's claimable frontier, urgent-first: open items whose defer time has passed, with no deferred ancestor up the parent chain and no unclosed blocker",
        request: "?project=&limit=...",
        response: "JSON {items:[work item, ...]}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/work/:id",
        class: RouteClass::Open,
        purpose: "One work item plus every typed edge touching it",
        request: "item id in path",
        response: "JSON {item, edges:[{fromId, toId, type, ...}]}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/work",
        class: RouteClass::Protected(SCOPE_WORK_FILE),
        purpose: "File a new work item (task / bug / question / message); `parent` mints a child id and records the parent-child edge",
        request: "JSON {title, body?, kind?, priority?, status?, parent?, originKind?, originId?, projectPath?, pinned?, deferUntil?, author?}",
        response: "JSON {item} with the minted hierarchical id",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/work/:id/claim",
        class: RouteClass::Protected(SCOPE_WORK_CLAIM),
        purpose: "Claim an open work item: sets the assignee and a lease; 409 when it is not open",
        request: "JSON {assignee, leaseSeconds?}",
        response: "JSON {item} as claimed",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/work/:id/close",
        class: RouteClass::Protected(SCOPE_WORK_CLAIM),
        purpose: "Close a work item with a recorded reason; 409 when already closed",
        request: "JSON {reason?, author?}",
        response: "JSON {item} as closed",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/extensions",
        class: RouteClass::Open,
        purpose: "Installed extensions with live status (kind, scopes, events, strikes, panel)",
        request: "—",
        response: "JSON extension list",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/extensions/:name/panel",
        class: RouteClass::Protected(SCOPE_UI_PANEL),
        purpose: "Replace the extension's sanitized markdown panel (the sanctioned UI slot; `name` must match the bearer's grant)",
        request: "JSON {markdown}",
        response: "JSON {ok}",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/liveness",
        class: RouteClass::Open,
        purpose: "Identity card for a booting sibling: is this daemon Redline, and does it still have a window? (The dev preflight decides retire-vs-refuse on `hasWindow`.)",
        request: "—",
        response: "JSON {app: \"redline\", pid, hasWindow, version}",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/admin/shutdown",
        class: RouteClass::MasterOnly,
        purpose: "Gracefully retire this instance (persist, kill children, release :1420/:7676). Called by a booting sibling's preflight against a headless incumbent, authenticated with the on-disk `daemon.token`.",
        request: "— (empty body)",
        response: "JSON {ok, pid}; the process runs its exit cleanup and terminates moments later",
    },
];

/// Every route this daemon serves, in one table: Redline's own rows
/// ([`ROUTE_TABLE`]) followed by Polis Memory's (`polis_server::ROUTES`,
/// mapped onto this contract's classes — a polis `Write(scope)` is a
/// `Protected(scope)` here, same scope strings, pinned against the extension
/// ABI by a test). The middleware, the doc render and the drift tests all
/// read THIS. The fail-closed rule makes the mapping mandatory: a polis route
/// the merge serves but this table lacks would 401 even with the master
/// token — `merged_router_covers_every_polis_route` proves it cannot.
pub fn all_routes() -> &'static [RouteSpec] {
    static ALL: OnceLock<Vec<RouteSpec>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut rows: Vec<RouteSpec> = ROUTE_TABLE.to_vec();
        rows.extend(polis_server::ROUTES.iter().map(map_polis_route));
        rows
    })
}

/// A polis row as a row of this contract.
fn map_polis_route(spec: &polis_server::RouteSpec) -> RouteSpec {
    RouteSpec {
        method: spec.method,
        path: spec.path,
        class: match spec.class {
            polis_server::RouteClass::Open => RouteClass::Open,
            polis_server::RouteClass::HookContract => RouteClass::HookContract,
            polis_server::RouteClass::Write(scope) => RouteClass::Protected(scope),
        },
        purpose: spec.purpose,
        request: spec.request,
        response: spec.response,
    }
}

/// Look up the contract row for a request. `path` must be the registered
/// axum pattern (from `MatchedPath`), not the concrete URL.
pub fn route_spec(path: &str, method: &str) -> Option<&'static RouteSpec> {
    all_routes()
        .iter()
        .find(|s| s.path == path && s.method == method)
}

/// The per-boot master token. Minted lazily on first use (the middleware
/// and the first agent spawn race benignly through the `OnceLock`). A
/// relaunch mints a fresh one and every child spawned by the new process
/// gets the new value; the only copy outside process memory is the 0600
/// `daemon.token` file written by [`persist_daemon_token`] — same-user
/// only, and overwritten by every boot, so a stale file authenticates
/// against nothing.
pub fn daemon_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(mint_token)
}

/// File under the app data dir carrying [`daemon_token`] for this boot.
/// Read by `scripts/preflight-dev.mjs` (a booting sibling shares the user
/// but not the incumbent's environment) to authorize `/v1/admin/shutdown`
/// against a headless incumbent.
pub const TOKEN_FILE: &str = "daemon.token";

/// Persist this boot's master token to `<dir>/daemon.token`, owner-only.
/// Called once at setup, after the app data dir is known. Permissions are
/// fixed before the token bytes land so the file is never readable by
/// another user, even transiently.
pub fn persist_daemon_token(dir: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    use std::io::Write;
    let path = dir.join(TOKEN_FILE);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    #[cfg(unix)]
    {
        // `mode` only applies on create; an existing file from a prior boot
        // keeps its old bits, so pin them explicitly.
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(daemon_token().as_bytes())?;
    Ok(path)
}

/// A fresh scoped token for one extension for this boot (`extension.rs`
/// writes it to the extension's `.token` file and registers the grant).
pub fn mint_extension_token() -> String {
    mint_token()
}

/// 32 bytes of OS randomness, hex-encoded — same recipe as the collab
/// owner secret (two v4 UUIDs, no extra dependency).
fn mint_token() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// An extension's granted scopes, keyed by its per-boot token in the
/// registry below. Registered by `extension::install_boot_tokens` at setup.
#[derive(Debug, Clone)]
pub struct ExtensionGrant {
    pub name: String,
    pub scopes: Vec<String>,
}

fn grants() -> &'static RwLock<HashMap<String, ExtensionGrant>> {
    static GRANTS: OnceLock<RwLock<HashMap<String, ExtensionGrant>>> = OnceLock::new();
    GRANTS.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn register_grant(token: String, grant: ExtensionGrant) {
    grants().write().expect("grants lock").insert(token, grant);
}

/// The grant behind a bearer token, if it is a registered extension token.
/// Handlers that must bind a write to the caller's *identity* (not just its
/// scope) use this — e.g. the panel route's "`name` must match the bearer's
/// grant" rule. The master token has no grant and returns `None`.
pub fn grant_for(token: &str) -> Option<ExtensionGrant> {
    let grants = grants().read().expect("grants lock");
    grants
        .iter()
        .find(|(t, _)| ct_eq(t, token))
        .map(|(_, g)| g.clone())
}

/// Revoke every token granted to the named extension, immediately (B4:
/// marketplace uninstall/update must not leave a live token behind for the
/// rest of the boot — per-boot rotation alone is too slow a revocation for
/// an explicit uninstall). Returns how many tokens died.
pub fn revoke_grant(name: &str) -> usize {
    let mut grants = grants().write().expect("grants lock");
    let before = grants.len();
    grants.retain(|_, g| g.name != name);
    before - grants.len()
}

#[cfg(test)]
pub fn clear_grants_for_test() {
    grants().write().expect("grants lock").clear();
}

/// Serializes every test (here and in `extension.rs`) that touches the
/// process-global grant registry — cargo runs test threads in parallel.
#[cfg(test)]
pub fn grants_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Constant-time equality so the token check isn't a timing oracle. Both
/// sides are ASCII hex of fixed length in the honest case; length mismatch
/// short-circuits, which leaks only the length (public: always 64).
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Why a request was denied — surfaced verbatim in the 401 body so a
/// misconfigured caller can self-diagnose.
#[derive(Debug, PartialEq, Eq)]
pub enum Denial {
    UnknownRoute,
    MissingToken { scope: &'static str },
    BadToken,
    ScopeNotGranted { scope: &'static str },
    MasterTokenRequired,
}

impl Denial {
    pub fn message(&self) -> String {
        match self {
            Denial::UnknownRoute => {
                "route is not in the v1 contract (ROUTE_TABLE) — new routes must be registered there".to_string()
            }
            Denial::MissingToken { scope } => format!(
                "this route requires a bearer token (scope `{scope}`): add `--variable %REDLINE_DAEMON_TOKEN= --expand-header \"Authorization: Bearer {{{{REDLINE_DAEMON_TOKEN}}}}\"` after the URL (curl >= 8.3)"
            ),
            Denial::BadToken => "bearer token not recognized (stale? tokens rotate every Redline launch)".to_string(),
            Denial::ScopeNotGranted { scope } => {
                format!("extension token lacks the `{scope}` scope")
            }
            Denial::MasterTokenRequired => {
                "this route accepts only the per-boot master token (Redline's own surfaces and the boot preflight; extension tokens never qualify)".to_string()
            }
        }
    }
}

/// The pure auth decision: given the matched route pattern, the method, and
/// the (already-stripped) bearer token, allow or deny. Pure so the whole
/// contract is unit-testable without an HTTP stack; the axum middleware
/// below is thin glue over this.
pub fn authorize(path: &str, method: &str, bearer: Option<&str>) -> Result<(), Denial> {
    let spec = route_spec(path, method).ok_or(Denial::UnknownRoute)?;
    let scope = match spec.class {
        RouteClass::Open | RouteClass::HookContract => return Ok(()),
        // One arm for missing, wrong, and extension tokens alike: the answer
        // never distinguishes "unknown token" from "known but insufficient".
        RouteClass::MasterOnly => {
            return match bearer {
                Some(token) if ct_eq(token, daemon_token()) => Ok(()),
                _ => Err(Denial::MasterTokenRequired),
            };
        }
        RouteClass::Protected(scope) => scope,
    };
    let token = bearer.ok_or(Denial::MissingToken { scope })?;
    if ct_eq(token, daemon_token()) {
        return Ok(());
    }
    let grants = grants().read().expect("grants lock");
    match grants.iter().find(|(t, _)| ct_eq(t, token)) {
        None => Err(Denial::BadToken),
        Some((_, grant)) if grant.scopes.iter().any(|s| s == scope) => Ok(()),
        Some(_) => Err(Denial::ScopeNotGranted { scope }),
    }
}

fn bearer_of(req: &Request) -> Option<String> {
    bearer_of_headers(req.headers())
}

fn bearer_of_headers(headers: &axum::http::HeaderMap) -> Option<String> {
    let header = headers.get(axum::http::header::AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
}

/// The largest JSON-RPC body the MCP write gate will read before deciding.
/// A `memory_ingest` batch is bounded by the same budget the HTTP events
/// route accepts.
const MCP_BODY_CAP: usize = 4 * 1024 * 1024;

/// The HTTP route an MCP `tools/call` is authorized AS, when the tool is one
/// of the writes (E2): `memory_forget` is the `memory.forget` route, the other
/// four are `memory.write`. `None` for reads, notifications, other methods,
/// and anything that is not JSON-RPC — those pass as the mount's Open rows
/// say. A batch is a write if any element is.
pub fn mcp_write_route(body: &[u8]) -> Option<&'static str> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let messages: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    let mut route = None;
    for m in messages {
        if m.get("method").and_then(|x| x.as_str()) != Some("tools/call") {
            continue;
        }
        let Some(name) = m.get("params").and_then(|p| p.get("name")).and_then(|n| n.as_str()) else { continue };
        if !polis_mcp::WRITE_TOOLS.contains(&name) {
            continue;
        }
        if name == "memory_forget" {
            return Some("/v1/memory/forget");
        }
        route = Some("/v1/memory/remember");
    }
    route
}

/// The MCP mount (E1) is three Open rows — a read-only surface by contract —
/// and E2's five write tools ride the same JSON-RPC endpoint. This layer,
/// on the `/mcp` route alone, keeps the fail-closed rule for them: a
/// `tools/call` naming a write tool is authorized exactly as the HTTP route
/// it maps to (the same bearer, the same scope, the same 401 text); every
/// other message passes untouched. Reads stay open, as the plan wants.
pub async fn require_mcp_write_token(req: Request, next: Next) -> Response {
    if req.method() != axum::http::Method::POST {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, MCP_BODY_CAP).await {
        Ok(b) => b,
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, axum::Json(json!({ "error": "MCP body too large" }))).into_response();
        }
    };
    if let Some(route) = mcp_write_route(&bytes) {
        let bearer = bearer_of_headers(&parts.headers);
        if let Err(denial) = authorize(route, "POST", bearer.as_deref()) {
            let message = denial.message();
            crate::db::note_friction("auth_denied", Some("daemon"), None, Some(&format!("POST /mcp (as {route}): {message}")));
            return (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": message }))).into_response();
        }
    }
    next.run(Request::from_parts(parts, axum::body::Body::from(bytes))).await
}

/// Axum middleware applying `authorize` to every daemon request. Requests
/// that matched no route carry no `MatchedPath` and pass through to axum's
/// own 404 — the fail-closed rule is for routes that exist but aren't in
/// the contract table.
pub async fn require_daemon_auth(req: Request, next: Next) -> Response {
    let Some(matched) = req.extensions().get::<MatchedPath>() else {
        return next.run(req).await;
    };
    let path = matched.as_str().to_string();
    let method = req.method().as_str().to_string();
    let bearer = bearer_of(&req);
    match authorize(&path, &method, bearer.as_deref()) {
        Ok(()) => next.run(req).await,
        Err(denial) => {
            // Every 401 is friction: a skill carrying a stale curl recipe, an
            // extension missing a scope, a route added without a ROUTE_TABLE
            // row. The middleware holds no `Database` (it is thin glue over a
            // pure decision), so it records through the process-global sink.
            let message = denial.message();
            crate::db::note_friction(
                "auth_denied",
                Some("daemon"),
                None,
                Some(&format!("{method} {path}: {message}")),
            );
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({ "error": message })),
            )
                .into_response()
        }
    }
}

/// Render the frozen contract as `docs/api-v1.md`. A golden-style test
/// keeps the committed file in sync (`UPDATE_GOLDEN=1 cargo test api_doc`).
pub fn render_api_doc() -> String {
    let mut out = String::new();
    out.push_str("# Redline control-plane API — v1\n\n");
    out.push_str("The local daemon on `127.0.0.1:7676` (loopback only) is Redline's extension API. ");
    out.push_str("This table is generated from `ROUTE_TABLE` in `src-tauri/src/auth.rs` (Redline's own routes) followed by `polis_server::ROUTES` (the Polis Memory routes the daemon merges in — `crates/polis-server/src/lib.rs` of https://github.com/sersiousSenpai/polis-memory, at the rev `src-tauri/Cargo.toml` pins) — the same tables the auth middleware enforces on every request — via `UPDATE_GOLDEN=1 cargo test api_doc`. Do not edit by hand.\n\n");
    out.push_str("## Auth classes\n\n");
    out.push_str("- **open** — no credential (read-only surface; may tokenize in a later pass).\n");
    out.push_str("- **hook contract** — no credential *by design*: called by the user's own claude sessions anywhere on the machine through the globally installed hooks/skills, which cannot carry a per-boot secret.\n");
    out.push_str("- **token: `<scope>`** — requires `Authorization: Bearer <token>`, where the token is either the per-boot master token (env `REDLINE_DAEMON_TOKEN` in every Redline-spawned process) or an extension token granted that scope (see `~/.redline/extensions/`, `src-tauri/src/extension.rs`).\n");
    out.push_str("  Callers must not expand the variable through a shell (agent bash sandboxes reject commands containing expansion). Have curl import it instead, keeping the URL first so command-prefix permission rules still match:\n\n");
    out.push_str("  ```\n  curl -s http://127.0.0.1:7676/v1/… \\\n    --variable %REDLINE_DAEMON_TOKEN= \\\n    --expand-header \"Authorization: Bearer {{REDLINE_DAEMON_TOKEN}}\" \\\n    -X POST -H 'Content-Type: application/json' -d '{…}'\n  ```\n\n");
    out.push_str("  Both flags require **curl >= 8.3**. The trailing `=` is an empty default: without it curl aborts with `variable expansion failure`; with it an unset token yields a clean 401. macOS ships curl 8.4 on 14+, but 7.x on 11–13.\n\n");
    out.push_str("- **token: master only** — requires the per-boot master token itself; extension tokens never qualify, whatever their scopes. Reserved for control-plane verbs (instance retirement). The token is also persisted to `<app_data_dir>/daemon.token` (0600) so a booting sibling's preflight — same user, no inherited env — can authenticate against a headless incumbent.\n\n");
    out.push_str("Unregistered routes fail closed: a route added to the router without a `ROUTE_TABLE` entry answers 401.\n\n");
    out.push_str("## Routes\n\n");
    out.push_str("| Method | Path | Auth | Purpose | Request | Response |\n");
    out.push_str("|---|---|---|---|---|---|\n");
    for spec in all_routes() {
        let auth = match spec.class {
            RouteClass::Open => "open".to_string(),
            RouteClass::HookContract => "hook contract".to_string(),
            RouteClass::Protected(scope) => format!("token: `{scope}`"),
            RouteClass::MasterOnly => "token: master only".to_string(),
        };
        out.push_str(&format!(
            "| {} | `{}` | {} | {} | {} | {} |\n",
            spec.method, spec.path, auth, spec.purpose, spec.request, spec.response
        ));
    }
    out.push_str("\n## Scopes\n\n");
    for scope in KNOWN_SCOPES {
        let routes: Vec<String> = all_routes()
            .iter()
            .filter(|s| s.class == RouteClass::Protected(scope))
            .map(|s| format!("`{} {}`", s.method, s.path))
            .collect();
        out.push_str(&format!("- `{}` — {}\n", scope, routes.join(", ")));
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The router source, compile-time embedded so the drift test needs no
    /// runtime paths. Extraction below is deliberately dumb: every string
    /// literal that immediately follows a `.route(` in `run_server`.
    const LIB_SRC: &str = include_str!("lib.rs");

    fn registered_route_paths() -> Vec<String> {
        let mut paths = Vec::new();
        let mut rest = LIB_SRC;
        while let Some(idx) = rest.find(".route(") {
            rest = &rest[idx + ".route(".len()..];
            let Some(q1) = rest.find('"') else { break };
            let after = &rest[q1 + 1..];
            let Some(q2) = after.find('"') else { break };
            paths.push(after[..q2].to_string());
            rest = &after[q2..];
        }
        paths
    }

    #[test]
    fn route_table_matches_router_registrations() {
        let registered: std::collections::BTreeSet<String> =
            registered_route_paths().into_iter().collect();
        let table: std::collections::BTreeSet<String> =
            ROUTE_TABLE.iter().map(|s| s.path.to_string()).collect();
        assert!(
            !registered.is_empty(),
            "found no .route( registrations in lib.rs — extraction broke"
        );
        let missing: Vec<_> = registered.difference(&table).collect();
        let stale: Vec<_> = table.difference(&registered).collect();
        assert!(
            missing.is_empty() && stale.is_empty(),
            "ROUTE_TABLE drifted from the router: missing from table {missing:?}, stale in table {stale:?}"
        );
    }

    #[test]
    fn route_table_has_no_duplicate_method_path_pairs() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in all_routes() {
            assert!(
                seen.insert((spec.method, spec.path)),
                "duplicate ROUTE_TABLE entry: {} {}",
                spec.method,
                spec.path
            );
        }
    }

    #[test]
    fn protected_scopes_are_all_known() {
        for spec in all_routes() {
            if let RouteClass::Protected(scope) = spec.class {
                assert!(
                    KNOWN_SCOPES.contains(&scope),
                    "route {} {} uses unknown scope {scope}",
                    spec.method,
                    spec.path
                );
            }
        }
    }

    /// The polis rows are in the merged contract with their classes intact:
    /// the hook route open by design, the reads open, every write protected
    /// under the scope the polis table names.
    #[test]
    fn polis_rows_join_the_contract_with_their_classes() {
        assert_eq!(
            all_routes().len(),
            ROUTE_TABLE.len() + polis_server::ROUTES.len(),
            "every polis row is mapped, none twice"
        );
        assert_eq!(route_spec("/v1/prompts/ingest", "POST").unwrap().class, RouteClass::HookContract);
        assert_eq!(route_spec("/v1/memory/tree", "GET").unwrap().class, RouteClass::Open);
        assert_eq!(
            route_spec("/v1/memory/proposals", "POST").unwrap().class,
            RouteClass::Protected(redline_extension_abi::scopes::MEMORY_PROPOSE)
        );
        assert_eq!(
            route_spec("/v1/memory/forget", "POST").unwrap().class,
            RouteClass::Protected(redline_extension_abi::scopes::MEMORY_FORGET)
        );
        assert!(ROUTE_TABLE.iter().all(|r| !r.path.starts_with("/v1/memory/")), "no memory row stays in Redline's own table");
    }

    /// The scope strings polis-server writes are the strings the extension
    /// ABI grants — one vocabulary, so an extension token granted a memory
    /// scope in a manifest is the same scope the polis route demands.
    #[test]
    fn polis_scopes_match_the_extension_abi() {
        use redline_extension_abi::scopes as abi;
        assert_eq!(polis_server::scopes::MEMORY_PROPOSE, abi::MEMORY_PROPOSE);
        assert_eq!(polis_server::scopes::MEMORY_WRITE, abi::MEMORY_WRITE);
        assert_eq!(polis_server::scopes::MEMORY_FORGET, abi::MEMORY_FORGET);
        assert_eq!(polis_server::scopes::MEMORY_ORGANIZE, abi::MEMORY_ORGANIZE);
        for scope in polis_server::scopes::ALL {
            assert!(KNOWN_SCOPES.contains(scope), "polis scope {scope} is not a known extension scope");
        }
    }

    /// The whole point of `all_routes()`: the merged router, under THIS
    /// middleware, serves every polis row to the master token. Real requests
    /// through `polis_server::router()` over an in-memory database — a row
    /// the table lacked would come back 401 (fail closed), a row the router
    /// lacked would come back an empty 404.
    #[test]
    fn merged_router_covers_every_polis_route() {
        use axum::body::Body;
        use axum::http::Request;
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let db = std::sync::Arc::new(crate::db::Database::open_in_memory().unwrap());
        let handle = polis_memory::PolisHandle::new(db.polis_store(), None, db.clone(), db.clone());
        let state = polis_server::PolisState::bare(std::sync::Arc::new(handle));
        let app = polis_server::router::<polis_server::PolisState>()
            .layer(axum::middleware::from_fn(require_daemon_auth))
            .with_state(state);
        let rt = tokio::runtime::Runtime::new().unwrap();
        for spec in polis_server::ROUTES {
            let uri = spec.path.replace(":kind", "session").replace(":id", "x");
            let body = match spec.path {
                "/v1/prompts/ingest" => r#"{"prompt":"sweep","session_id":"s","cwd":"/tmp"}"#,
                "/v1/memory/proposals" => r#"{"proposals":[]}"#,
                "/v1/memory/remember" => r#"{"text":"kept","asUser":true}"#,
                "/v1/memory/annotate" => r#"{"targetKind":"none","text":"note"}"#,
                "/v1/memory/forget" => r#"{"targetKind":"prompt","targetId":"1","confirm":"forget"}"#,
                "/v1/memory/events" => r#"{"items":[{"body":"imported"}]}"#,
                "/v1/memory/browse" => r#"{"url":"https://example.test","text":"page"}"#,
                _ => "",
            };
            let req = Request::builder()
                .method(spec.method)
                .uri(&uri)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {}", daemon_token()))
                .body(Body::from(body))
                .unwrap();
            let resp = rt.block_on(app.clone().oneshot(req)).unwrap();
            let status = resp.status();
            let bytes = rt.block_on(resp.into_body().collect()).unwrap().to_bytes();
            assert_ne!(status, StatusCode::UNAUTHORIZED, "{} {} is served but not in all_routes(): {}", spec.method, spec.path, String::from_utf8_lossy(&bytes));
            assert!(
                !(status == StatusCode::NOT_FOUND && bytes.is_empty()) && status != StatusCode::METHOD_NOT_ALLOWED,
                "{} {} is in ROUTES but the merged router answered {status}",
                spec.method,
                spec.path
            );
        }
        // And without the token, the classes hold across the merge: the hook
        // and the reads pass, a write bounces.
        let open = Request::builder().uri("/v1/memory/verify").body(Body::empty()).unwrap();
        assert_eq!(rt.block_on(app.clone().oneshot(open)).unwrap().status(), StatusCode::OK);
        let write = Request::builder().method("POST").uri("/v1/memory/remember").header("content-type", "application/json").body(Body::from(r#"{"text":"x","asUser":true}"#)).unwrap();
        assert_eq!(rt.block_on(app.clone().oneshot(write)).unwrap().status(), StatusCode::UNAUTHORIZED);
    }

    /// The MCP mount, through the merged router under THIS middleware: a real
    /// `initialize` POST to `/mcp` is 200 with a session id (the row is in the
    /// table — a missing row would be a 401), a `tools/list` on that session
    /// names `memory_search`, a `/mcp/x` sub-path is the router's own 404
    /// (mounted as a route, not nested — a nested tail would carry no
    /// MatchedPath and rmcp would serve it anyway), and the mount's
    /// `MatchedPath` is exactly "/mcp" — what the three table rows are keyed on.
    /// The MCP write gate's mapping: only a `tools/call` of a write tool is
    /// authorized as a write, `memory_forget` as the forget route, a batch
    /// by its strongest element, and everything else passes.
    #[test]
    fn mcp_write_gate_maps_write_tools_to_their_http_routes() {
        let call = |name: &str| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}","arguments":{{}}}}}}"#);
        assert_eq!(mcp_write_route(call("memory_search").as_bytes()), None);
        assert_eq!(mcp_write_route(call("memory_remember").as_bytes()), Some("/v1/memory/remember"));
        assert_eq!(mcp_write_route(call("memory_ingest").as_bytes()), Some("/v1/memory/remember"));
        assert_eq!(mcp_write_route(call("memory_annotate").as_bytes()), Some("/v1/memory/remember"));
        assert_eq!(mcp_write_route(call("memory_supersede").as_bytes()), Some("/v1/memory/remember"));
        assert_eq!(mcp_write_route(call("memory_forget").as_bytes()), Some("/v1/memory/forget"));
        assert_eq!(mcp_write_route(br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#), None);
        assert_eq!(mcp_write_route(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#), None);
        assert_eq!(mcp_write_route(b"not json"), None);
        let batch = format!("[{},{}]", call("memory_stats"), call("memory_forget"));
        assert_eq!(mcp_write_route(batch.as_bytes()), Some("/v1/memory/forget"));
        for w in polis_mcp::WRITE_TOOLS {
            assert!(mcp_write_route(call(w).as_bytes()).is_some(), "{w} is gated");
        }
    }

    #[test]
    fn merged_router_serves_mcp_initialize_and_tools_list() {
        use axum::body::Body;
        use axum::http::Request as HttpRequest;
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let db = std::sync::Arc::new(crate::db::Database::open_in_memory().unwrap());
        let handle = polis_memory::PolisHandle::new(db.polis_store(), None, db.clone(), db.clone());
        let api: std::sync::Arc<dyn polis_core::MemoryApi> = std::sync::Arc::new(handle);
        let state = polis_server::PolisState::bare(api.clone());
        // What the middleware sees at the mount point, recorded by a probe
        // layer placed INSIDE the auth layer (so it runs only when auth passed).
        let seen: std::sync::Arc<std::sync::Mutex<Vec<Option<String>>>> = Default::default();
        let probe = seen.clone();
        let app = polis_server::router::<polis_server::PolisState>()
            .route(
                "/mcp",
                axum::routing::any_service(polis_mcp::http_service(api.clone())).layer(axum::middleware::from_fn(require_mcp_write_token)),
            )
            .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
                let probe = probe.clone();
                async move {
                    probe.lock().unwrap().push(req.extensions().get::<MatchedPath>().map(|m| m.as_str().to_string()));
                    next.run(req).await
                }
            }))
            .layer(axum::middleware::from_fn(require_daemon_auth))
            .with_state(state);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let post = |body: &str, session: Option<&str>| {
            // `Host` as a real client sends it: rmcp validates it against its
            // loopback allow-list (a DNS-rebinding guard) before anything else.
            let mut b = HttpRequest::builder()
                .method("POST")
                .uri("/mcp")
                .header("host", "127.0.0.1:7676")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream");
            if let Some(s) = session {
                b = b.header("mcp-session-id", s);
            }
            b.body(Body::from(body.to_string())).unwrap()
        };
        // initialize → 200 + Mcp-Session-Id, no token needed (an Open row).
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"redline-test","version":"0"}}}"#;
        let resp = rt.block_on(app.clone().oneshot(post(init, None))).unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "initialize through the merged router");
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .expect("initialize answers with an Mcp-Session-Id");
        let body = String::from_utf8_lossy(&rt.block_on(resp.into_body().collect()).unwrap().to_bytes()).to_string();
        assert!(body.contains("\"serverInfo\"") && body.contains("polis-memory"), "the initialize result rides the body: {body}");
        // The client's initialized notification, then tools/list on the session.
        let notified = rt.block_on(app.clone().oneshot(post(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, Some(&session)))).unwrap();
        assert!(notified.status().is_success(), "notifications/initialized: {}", notified.status());
        let resp = rt.block_on(app.clone().oneshot(post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, Some(&session)))).unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = String::from_utf8_lossy(&rt.block_on(resp.into_body().collect()).unwrap().to_bytes()).to_string();
        for tool in ["memory_search", "memory_context", "memory_grep", "memory_tree", "memory_node", "memory_timeline", "memory_stats", "memory_verify", "answer_pack", "query_prompts"] {
            assert!(body.contains(&format!("\"name\":\"{tool}\"")), "tools/list names {tool}: {body}");
        }
        // E2: the five write tools ARE on this surface — gated below by the
        // same token and scope as their HTTP routes; revert never is.
        for tool in polis_mcp::WRITE_TOOLS {
            assert!(body.contains(&format!("\"name\":\"{tool}\"")), "tools/list names the write tool {tool}");
        }
        assert!(!body.contains("revert"), "revert is never an MCP tool");
        // A write without a token is refused as its HTTP twin would be.
        let remember = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_remember","arguments":{"text":"gated","as_user":true}}}"#;
        let denied = rt.block_on(app.clone().oneshot(post(remember, Some(&session)))).unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED, "a write over MCP needs the token");
        let denied_body = String::from_utf8_lossy(&rt.block_on(denied.into_body().collect()).unwrap().to_bytes()).to_string();
        assert!(denied_body.contains("memory.write"), "the denial names the scope: {denied_body}");
        let forget = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_forget","arguments":{"target_kind":"prompt","target_id":"1","confirm":"forget"}}}"#;
        let denied = rt.block_on(app.clone().oneshot(post(forget, Some(&session)))).unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        let denied_body = String::from_utf8_lossy(&rt.block_on(denied.into_body().collect()).unwrap().to_bytes()).to_string();
        assert!(denied_body.contains("memory.forget"), "forget is the forget scope: {denied_body}");
        // With the master token the write goes through to the memory.
        let mut authed = post(remember, Some(&session));
        authed.headers_mut().insert(axum::http::header::AUTHORIZATION, format!("Bearer {}", daemon_token()).parse().unwrap());
        let ok = rt.block_on(app.clone().oneshot(authed)).unwrap();
        assert_eq!(ok.status(), StatusCode::OK, "the tokened write is served");
        // The transport streams the result: the tool runs as the body is
        // produced, so read it to the end before looking for the row.
        let ok_body = String::from_utf8_lossy(&rt.block_on(ok.into_body().collect()).unwrap().to_bytes()).to_string();
        assert!(ok_body.contains("remembered"), "the write's receipt rides the stream: {ok_body}");
        let found = api.search(&polis_core::api::SearchRequest { q: Some("gated".into()), ..Default::default() }).unwrap();
        assert!(!found.prompt_hits.is_empty(), "the remembered row is in the lake");
        // …and the daemon's own router carries the same gate on its `/mcp`
        // route (a source scrape, the drift test's style): a mount without it
        // would serve `memory_forget` to any loopback process token-free.
        let lib_src = include_str!("lib.rs");
        let mcp_line = lib_src.lines().find(|l| l.contains(".route(\"/mcp\"")).expect("lib.rs registers /mcp");
        assert!(mcp_line.contains("require_mcp_write_token"), "the /mcp route must carry require_mcp_write_token: {mcp_line}");
        // A read on the same session still needs no token.
        let stats = rt.block_on(app.clone().oneshot(post(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_stats","arguments":{}}}"#, Some(&session)))).unwrap();
        assert_eq!(stats.status(), StatusCode::OK, "reads stay open");
        // A sub-path is not a route: the router's own 404 (empty body), never
        // rmcp answering as if it were the mount.
        let sub = rt.block_on(app.clone().oneshot(HttpRequest::builder().uri("/mcp/nope").header("host", "127.0.0.1:7676").body(Body::empty()).unwrap())).unwrap();
        assert_eq!(sub.status(), StatusCode::NOT_FOUND);
        let sub_body = rt.block_on(sub.into_body().collect()).unwrap().to_bytes();
        assert!(sub_body.is_empty(), "a sub-path is unrouted, not served: {}", String::from_utf8_lossy(&sub_body));
        // The mount point's MatchedPath is "/mcp" — the three rows' key.
        let paths = seen.lock().unwrap().clone();
        assert!(paths.iter().filter(|p| p.as_deref() == Some("/mcp")).count() >= 3, "every /mcp request matched \"/mcp\": {paths:?}");
        assert!(paths.contains(&None), "the sub-path carried no MatchedPath: {paths:?}");
        for method in ["GET", "POST", "DELETE"] {
            assert_eq!(route_spec("/mcp", method).map(|r| r.class), Some(RouteClass::Open), "{method} /mcp is an Open row");
        }
    }

    #[test]
    fn daemon_token_is_stable_and_64_hex() {
        let t = daemon_token();
        assert_eq!(t.len(), 64);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(t, daemon_token(), "token must be stable within a boot");
    }

    #[test]
    fn open_and_hook_routes_need_no_token() {
        assert_eq!(authorize("/v1/browser/tabs", "GET", None), Ok(()));
        assert_eq!(authorize("/v1/plan", "POST", None), Ok(()));
        assert_eq!(authorize("/v1/codex/stop", "POST", None), Ok(()));
        assert_eq!(authorize("/v1/reviews/start", "GET", None), Ok(()));
        assert_eq!(
            authorize("/v1/sessions/:session_id/feedback", "GET", None),
            Ok(())
        );
        // Work-graph reads follow the house read convention: open.
        assert_eq!(authorize("/v1/work/ready", "GET", None), Ok(()));
        assert_eq!(authorize("/v1/work/:id", "GET", None), Ok(()));
        // The preflight's identity probe must work with zero credentials.
        assert_eq!(authorize("/v1/liveness", "GET", None), Ok(()));
    }

    /// `/v1/admin/shutdown` is the one master-only route: no token, a wrong
    /// token, and a fully-scoped extension token must all bounce identically;
    /// only the per-boot master token retires the instance.
    #[test]
    fn admin_shutdown_accepts_only_the_master_token() {
        let _guard = grants_test_lock();
        clear_grants_for_test();
        register_grant(
            "ext-token-omni".to_string(),
            ExtensionGrant {
                name: "omni".to_string(),
                scopes: KNOWN_SCOPES.iter().map(|s| s.to_string()).collect(),
            },
        );
        for bearer in [None, Some("wrong-token"), Some("ext-token-omni")] {
            assert_eq!(
                authorize("/v1/admin/shutdown", "POST", bearer),
                Err(Denial::MasterTokenRequired),
                "bearer {bearer:?} must not pass a master-only route"
            );
        }
        assert_eq!(
            authorize("/v1/admin/shutdown", "POST", Some(daemon_token())),
            Ok(())
        );
        clear_grants_for_test();
    }

    /// The persisted token file is byte-identical to the in-memory token and
    /// owner-only, and a re-persist (same boot or a stale file from a prior
    /// boot with looser bits) converges to the same state.
    #[test]
    fn persisted_token_file_matches_and_is_owner_only() {
        let dir = std::env::temp_dir().join(format!("redline-token-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("tempdir");
        // A stale world-readable file from a hypothetical prior boot.
        let stale = dir.join(TOKEN_FILE);
        std::fs::write(&stale, "stale").expect("seed stale file");
        let path = persist_daemon_token(&dir).expect("persist token");
        assert_eq!(path, stale);
        assert_eq!(
            std::fs::read_to_string(&path).expect("read token file"),
            daemon_token()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "token file must be owner-only");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutating_routes_reject_without_token_and_accept_master() {
        for (path, method) in [
            ("/v1/sessions/:session_id/suggestions", "POST"),
            ("/v1/sessions/:session_id/comments", "POST"),
            ("/v1/sessions/:session_id/comment-offers", "POST"),
            ("/v1/browser/navigate", "POST"),
            ("/v1/browser/query", "POST"),
            ("/v1/browser/download", "POST"),
            ("/v1/linked/consult", "POST"),
            ("/v1/global/consult", "POST"),
            ("/v1/memory/proposals", "POST"),
            ("/v1/drafter/:draft_id/suggestions", "POST"),
            ("/v1/reviews/annotations", "POST"),
            ("/v1/reviews/annotations", "DELETE"),
            ("/v1/work", "POST"),
            ("/v1/work/:id/claim", "POST"),
            ("/v1/work/:id/close", "POST"),
        ] {
            assert!(
                matches!(
                    authorize(path, method, None),
                    Err(Denial::MissingToken { .. })
                ),
                "{method} {path} must require a token"
            );
            assert!(
                matches!(
                    authorize(path, method, Some("wrong-token")),
                    Err(Denial::BadToken)
                ),
                "{method} {path} must reject a wrong token"
            );
            assert_eq!(
                authorize(path, method, Some(daemon_token())),
                Ok(()),
                "{method} {path} must accept the master token"
            );
        }
    }

    #[test]
    fn unregistered_route_fails_closed() {
        assert_eq!(
            authorize("/v1/not/in/contract", "POST", Some(daemon_token())),
            Err(Denial::UnknownRoute)
        );
    }

    #[test]
    fn extension_tokens_are_scope_checked() {
        let _guard = grants_test_lock();
        clear_grants_for_test();
        register_grant(
            "ext-token-1".to_string(),
            ExtensionGrant {
                name: "linter".to_string(),
                scopes: vec![SCOPE_REVIEW_ANNOTATE.to_string()],
            },
        );
        assert_eq!(
            authorize("/v1/reviews/annotations", "POST", Some("ext-token-1")),
            Ok(())
        );
        assert_eq!(
            authorize("/v1/browser/navigate", "POST", Some("ext-token-1")),
            Err(Denial::ScopeNotGranted {
                scope: SCOPE_BROWSER_DRIVE
            })
        );
        clear_grants_for_test();
    }

    /// B4 uninstall/update revocation: after `revoke_grant`, the extension's
    /// token is a stranger to `authorize()` — not merely scope-stripped.
    #[test]
    fn revoked_grant_token_is_denied() {
        let _guard = grants_test_lock();
        clear_grants_for_test();
        register_grant(
            "tok-revoke-me".to_string(),
            ExtensionGrant {
                name: "shortlived".to_string(),
                scopes: vec![SCOPE_PLAN_COMMENT.to_string()],
            },
        );
        assert_eq!(
            authorize("/v1/sessions/:session_id/comments", "POST", Some("tok-revoke-me")),
            Ok(())
        );
        assert_eq!(revoke_grant("shortlived"), 1);
        assert_eq!(
            authorize("/v1/sessions/:session_id/comments", "POST", Some("tok-revoke-me")),
            Err(Denial::BadToken)
        );
        assert_eq!(revoke_grant("shortlived"), 0, "second revoke finds nothing");
        clear_grants_for_test();
    }

    /// Golden: `docs/api-v1.md` is the rendered contract. Regenerate with
    /// `UPDATE_GOLDEN=1 cargo test api_doc` (same mechanism as the review
    /// feedback golden).
    #[test]
    fn api_doc_golden_is_current() {
        let rendered = render_api_doc();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/api-v1.md");
        if std::env::var("UPDATE_GOLDEN").is_ok() {
            std::fs::write(&path, &rendered).expect("write api doc golden");
            return;
        }
        let committed = std::fs::read_to_string(&path)
            .expect("docs/api-v1.md missing — run UPDATE_GOLDEN=1 cargo test api_doc");
        assert_eq!(
            committed, rendered,
            "docs/api-v1.md is stale — run UPDATE_GOLDEN=1 cargo test api_doc"
        );
    }
}

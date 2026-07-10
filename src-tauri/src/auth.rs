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
//! - **Read-only** routes stay open for now so the external `redline-mcp`
//!   facade keeps working with zero configuration; tokenizing reads is an
//!   explicit second pass.
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
//!   keep fresh and a transcript leak. Agents append
//!   `-H "Authorization: Bearer $REDLINE_DAEMON_TOKEN"` *after* the URL,
//!   which the existing `curl -s http://127.0.0.1:7676/*` prefix rules
//!   already match — no allow-string churn anywhere.
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
/// embedded prompts reference it as `$REDLINE_DAEMON_TOKEN` inside a
/// double-quoted `-H` argument so the shell expands it.
pub const ENV_DAEMON_TOKEN: &str = "REDLINE_DAEMON_TOKEN";

/// How a route is guarded. The three classes are the whole story of the
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
}

/// One row of the frozen v1 contract. `path` is the axum route pattern
/// exactly as registered (`MatchedPath` returns the same string, which is
/// what makes the middleware lookup exact rather than fuzzy).
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
pub const SCOPE_PLAN_SUGGEST: &str = "plan.suggest";
pub const SCOPE_PLAN_COMMENT: &str = "plan.comment";
pub const SCOPE_BROWSER_DRIVE: &str = "browser.drive";
pub const SCOPE_CONSULT: &str = "consult";
pub const SCOPE_MEMORY_PROPOSE: &str = "memory.propose";
pub const SCOPE_DRAFTER_SUGGEST: &str = "drafter.suggest";
pub const SCOPE_REVIEW_ANNOTATE: &str = "review.annotate";

pub const KNOWN_SCOPES: &[&str] = &[
    SCOPE_PLAN_SUGGEST,
    SCOPE_PLAN_COMMENT,
    SCOPE_BROWSER_DRIVE,
    SCOPE_CONSULT,
    SCOPE_MEMORY_PROPOSE,
    SCOPE_DRAFTER_SUGGEST,
    SCOPE_REVIEW_ANNOTATE,
];

/// The frozen `/v1` contract — every route the daemon serves, in router
/// registration order. The middleware consults this table on every request
/// (so it is load-bearing, not documentation-adjacent), `docs/api-v1.md`
/// is generated from it, and a test asserts it matches the `.route(...)`
/// registrations in `lib.rs` byte for byte.
pub const ROUTE_TABLE: &[RouteSpec] = &[
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
        purpose: "Async-share viewer static assets",
        request: "path of the bundled asset",
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
        path: "/v1/prompts/ingest",
        class: RouteClass::HookContract,
        purpose: "Polis lake capture: the global UserPromptSubmit hook POSTs its stdin payload (fail-open)",
        request: "JSON hook payload (prompt, session, cwd)",
        response: "200 always (never blocks the hook)",
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
        path: "/v1/memory/tree",
        class: RouteClass::Open,
        purpose: "ClassMemory catalog tree (retrieval walk entry point)",
        request: "—",
        response: "JSON class tree",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/node/:id",
        class: RouteClass::Open,
        purpose: "One ClassMemory node with members",
        request: "node id in path",
        response: "JSON node detail",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/memory/prompts",
        class: RouteClass::Open,
        purpose: "Prompts under a class (retrieval leaf read)",
        request: "?class= node id",
        response: "JSON prompt list",
    },
    RouteSpec {
        method: "POST",
        path: "/v1/memory/proposals",
        class: RouteClass::Protected(SCOPE_MEMORY_PROPOSE),
        purpose: "Stage reviewable ClassMemory proposal rows (never accepts or moves a node)",
        request: "JSON structured proposal ops",
        response: "JSON staged proposal ids",
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
        path: "/v1/context/prompts",
        class: RouteClass::Open,
        purpose: "Filtered lake query (bounded, injection-safe LIKE)",
        request: "?q=&project=&limit=...",
        response: "JSON prompt rows",
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
        path: "/v1/context/stats",
        class: RouteClass::Open,
        purpose: "Aggregate lake/catalog stats",
        request: "—",
        response: "JSON stats",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/browse/search",
        class: RouteClass::Open,
        purpose: "Search captured browsing history",
        request: "?q=...",
        response: "JSON hits",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/threads/:kind/:id",
        class: RouteClass::Open,
        purpose: "Generic read of any per-surface message thread (memory-by-session spine)",
        request: "kind + id in path",
        response: "JSON message list",
    },
    RouteSpec {
        method: "GET",
        path: "/v1/context/tree/:kind/:id",
        class: RouteClass::Open,
        purpose: "Session-tree walk: a node with parent + child digests",
        request: "kind + id in path",
        response: "JSON tree node",
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
        request: "?repo=&base=... from the /redline-code-review skill",
        response: "held; resolves to structured line-anchored feedback",
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
];

/// Look up the contract row for a request. `path` must be the registered
/// axum pattern (from `MatchedPath`), not the concrete URL.
pub fn route_spec(path: &str, method: &str) -> Option<&'static RouteSpec> {
    ROUTE_TABLE
        .iter()
        .find(|s| s.path == path && s.method == method)
}

/// The per-boot master token. Minted lazily on first use (the middleware
/// and the first agent spawn race benignly through the `OnceLock`); never
/// persisted — a relaunch mints a fresh one and every child spawned by the
/// new process gets the new value.
pub fn daemon_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(mint_token)
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
}

impl Denial {
    pub fn message(&self) -> String {
        match self {
            Denial::UnknownRoute => {
                "route is not in the v1 contract (ROUTE_TABLE) — new routes must be registered there".to_string()
            }
            Denial::MissingToken { scope } => format!(
                "this route requires a bearer token (scope `{scope}`): send `Authorization: Bearer $REDLINE_DAEMON_TOKEN`"
            ),
            Denial::BadToken => "bearer token not recognized (stale? tokens rotate every Redline launch)".to_string(),
            Denial::ScopeNotGranted { scope } => {
                format!("extension token lacks the `{scope}` scope")
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
    let header = req.headers().get(axum::http::header::AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
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
        Err(denial) => (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": denial.message() })),
        )
            .into_response(),
    }
}

/// Render the frozen contract as `docs/api-v1.md`. A golden-style test
/// keeps the committed file in sync (`UPDATE_GOLDEN=1 cargo test api_doc`).
pub fn render_api_doc() -> String {
    let mut out = String::new();
    out.push_str("# Redline control-plane API — v1\n\n");
    out.push_str("The local daemon on `127.0.0.1:7676` (loopback only) is Redline's extension API. ");
    out.push_str("This table is generated from `ROUTE_TABLE` in `src-tauri/src/auth.rs` — the same table the auth middleware enforces on every request — via `UPDATE_GOLDEN=1 cargo test api_doc`. Do not edit by hand.\n\n");
    out.push_str("## Auth classes\n\n");
    out.push_str("- **open** — no credential (read-only surface; may tokenize in a later pass).\n");
    out.push_str("- **hook contract** — no credential *by design*: called by the user's own claude sessions anywhere on the machine through the globally installed hooks/skills, which cannot carry a per-boot secret.\n");
    out.push_str("- **token: `<scope>`** — requires `Authorization: Bearer <token>`, where the token is either the per-boot master token (env `REDLINE_DAEMON_TOKEN` in every Redline-spawned process) or an extension token granted that scope (see `~/.redline/extensions/`, `src-tauri/src/extension.rs`).\n\n");
    out.push_str("Unregistered routes fail closed: a route added to the router without a `ROUTE_TABLE` entry answers 401.\n\n");
    out.push_str("## Routes\n\n");
    out.push_str("| Method | Path | Auth | Purpose | Request | Response |\n");
    out.push_str("|---|---|---|---|---|---|\n");
    for spec in ROUTE_TABLE {
        let auth = match spec.class {
            RouteClass::Open => "open".to_string(),
            RouteClass::HookContract => "hook contract".to_string(),
            RouteClass::Protected(scope) => format!("token: `{scope}`"),
        };
        out.push_str(&format!(
            "| {} | `{}` | {} | {} | {} | {} |\n",
            spec.method, spec.path, auth, spec.purpose, spec.request, spec.response
        ));
    }
    out.push_str("\n## Scopes\n\n");
    for scope in KNOWN_SCOPES {
        let routes: Vec<String> = ROUTE_TABLE
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
        for spec in ROUTE_TABLE {
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
        for spec in ROUTE_TABLE {
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
        assert_eq!(authorize("/v1/reviews/start", "GET", None), Ok(()));
        assert_eq!(
            authorize("/v1/sessions/:session_id/feedback", "GET", None),
            Ok(())
        );
    }

    #[test]
    fn mutating_routes_reject_without_token_and_accept_master() {
        for (path, method) in [
            ("/v1/sessions/:session_id/suggestions", "POST"),
            ("/v1/sessions/:session_id/comments", "POST"),
            ("/v1/browser/navigate", "POST"),
            ("/v1/browser/query", "POST"),
            ("/v1/browser/download", "POST"),
            ("/v1/linked/consult", "POST"),
            ("/v1/global/consult", "POST"),
            ("/v1/memory/proposals", "POST"),
            ("/v1/drafter/:draft_id/suggestions", "POST"),
            ("/v1/reviews/annotations", "POST"),
            ("/v1/reviews/annotations", "DELETE"),
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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The work-graph state plane: durable work items (task / bug / question /
//! message) with hash-based hierarchical ids (`rl-xxxx`, children `rl-xxxx.N`)
//! and typed edges between them, served over five `/v1/work/*` routes.
//!
//! BOUNDARY LAW: this module is tables, queries, and route handlers — it
//! never launches a process and never names the seat-spawn chokepoint (a
//! guard test beside the SQL in `db.rs` scans this file and fails on any
//! occurrence). Execution engines (whatever claims and runs an item) live
//! entirely elsewhere and talk to this plane over the routes; that is also
//! why the `work_items` row carries no branch / worktree / attempt state,
//! forever.
//!
//! Provenance, not ownership: `origin_kind`/`origin_id` are TEXT breadcrumbs
//! (no foreign key to `plan_runs` / `sessions` / `orchestrations` / anything),
//! and `project_path` is a filterable facet, never an owner. Deleting an
//! origin row leaves the item standing. See the schema comment in `db.rs`.
//!
//! The deep logic lives beside the SQL in `db.rs`: the recursive ready CTE
//! (deferred ancestors + unclosed blockers), the atomic claim + lease, the
//! keeper-tick lease expiry, exactly-once close — with the full test battery
//! in `db.rs`'s work-graph tests. Still a later wave's:
//! child/duplicate/supersede edge bookkeeping on close, and expired-lease
//! reclaim directly at claim time (today the keeper's expiry pass frees the
//! row first and the claim then races normally on `open`).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::Database;
use crate::ledger::{self, EventKind};

/// Work-item lifecycle vocabulary (the `status` column).
pub const WORK_STATUSES: &[&str] = &["open", "claimed", "closed", "held"];
/// What an item is (the `kind` column).
pub const WORK_KINDS: &[&str] = &["task", "bug", "question", "message"];
/// Typed edge vocabulary (the `work_edges.type` column).
pub const WORK_EDGE_TYPES: &[&str] = &[
    "blocks",
    "parent-child",
    "discovered-from",
    "relates-to",
    "duplicates",
    "supersedes",
    "replies-to",
];

/// Default claim lease when the caller names none: one hour.
const DEFAULT_LEASE_SECONDS: i64 = 3600;

/// One work item, exactly the `work_items` row (`db.rs` maps it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    pub body: Option<String>,
    pub status: String,
    /// P0-style: 0 = drop everything, larger = calmer; default 2 = normal.
    pub priority: i64,
    pub kind: String,
    pub assignee: Option<String>,
    pub claimed_at: Option<i64>,
    pub lease_expires_at: Option<i64>,
    pub closed_at: Option<i64>,
    pub close_reason: Option<String>,
    pub defer_until: Option<i64>,
    /// Provenance breadcrumb, never a foreign key.
    pub origin_kind: Option<String>,
    pub origin_id: Option<String>,
    /// Filterable facet, never an owner.
    pub project_path: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One typed edge, exactly the `work_edges` row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkEdge {
    pub from_id: String,
    pub to_id: String,
    #[serde(rename = "type")]
    pub edge_type: String,
    pub created_by: Option<String>,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Id minting
// ---------------------------------------------------------------------------

/// Mint a root id: `rl-` + a hex prefix of `sha256(title ‖ created_at ‖ salt)`,
/// starting at 4 chars and lengthening (8, 12, …) until it misses every
/// existing row. Hash-based so ids are stable-looking and unguessy; the
/// collision walk keeps them short in practice.
fn mint_root_id(db: &Database, title: &str, created_at: i64) -> String {
    for salt in 0u32.. {
        let hash = ledger::sha256_hex(format!("{title}\n{created_at}\n{salt}").as_bytes());
        for len in [4usize, 8, 12, 16] {
            let id = format!("rl-{}", &hash[..len]);
            if db.get_work_item(&id).is_none() {
                return id;
            }
        }
        // All four prefixes of this hash collide (pathological) — re-salt.
    }
    unreachable!("the salt walk always finds a free id");
}

/// Mint a child id under `parent`: `<parent>.N` where N is one past the
/// highest existing direct-child ordinal (never reuses a freed ordinal).
fn mint_child_id(db: &Database, parent: &str) -> String {
    let next = db
        .work_child_ids(parent)
        .iter()
        .filter_map(|id| id.rsplit('.').next()?.parse::<i64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    format!("{parent}.{next}")
}

// ---------------------------------------------------------------------------
// Handlers — five thin routes over the queries above. Registered in
// `lib.rs::run_server`; auth classes live in `auth::ROUTE_TABLE`.
// ---------------------------------------------------------------------------

fn err(status: StatusCode, msg: impl Into<String>) -> axum::response::Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

#[derive(Deserialize)]
pub struct ReadyQ {
    /// Optional facet filter (exact `project_path` match).
    project: Option<String>,
    limit: Option<i64>,
}

/// `GET /v1/work/ready` — the claimable frontier, urgent-first: open items
/// whose defer time has passed, with no deferred ancestor up the parent
/// chain and no unclosed blocker. The precise semantics are documented at
/// `Database::list_ready_work_items` (the recursive CTE).
pub async fn handle_work_ready(
    State(app): State<crate::AppState>,
    Query(q): Query<ReadyQ>,
) -> axum::response::Response {
    let db = app.store.database();
    let project = q.project.as_deref().map(str::trim).filter(|p| !p.is_empty());
    match db.list_ready_work_items(project, ledger::now_millis(), q.limit.unwrap_or(50)) {
        Ok(items) => Json(json!({ "items": items })).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /v1/work/:id` — one item plus every edge touching it.
pub async fn handle_work_get(
    State(app): State<crate::AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let db = app.store.database();
    let Some(item) = db.get_work_item(id.trim()) else {
        return err(StatusCode::NOT_FOUND, format!("no work item `{id}`"));
    };
    let edges = db.list_work_edges_touching(&item.id).unwrap_or_default();
    Json(json!({ "item": item, "edges": edges })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWorkBody {
    title: String,
    body: Option<String>,
    /// task | bug | question | message; default task.
    kind: Option<String>,
    /// P0-style; default 2 (normal).
    priority: Option<i64>,
    /// open | held at file time; default open.
    status: Option<String>,
    /// An existing item id — the new item becomes `<parent>.N` and a
    /// parent-child edge is recorded.
    parent: Option<String>,
    /// Provenance breadcrumbs (free text, never validated against any table).
    origin_kind: Option<String>,
    origin_id: Option<String>,
    project_path: Option<String>,
    pinned: Option<bool>,
    defer_until: Option<i64>,
    /// Who files it — the ledger author and the parent edge's `created_by`.
    /// Defaults to the local author.
    author: Option<String>,
}

/// `POST /v1/work` (scope `work.file`) — file a new item. Responds with the
/// created item (its minted id is the caller's handle).
pub async fn handle_work_file(
    State(app): State<crate::AppState>,
    Json(b): Json<FileWorkBody>,
) -> axum::response::Response {
    let title = b.title.trim().to_string();
    if title.is_empty() {
        return err(StatusCode::BAD_REQUEST, "title is required");
    }
    let kind = b.kind.as_deref().map(str::trim).unwrap_or("task");
    if !WORK_KINDS.contains(&kind) {
        return err(
            StatusCode::BAD_REQUEST,
            format!("unknown kind `{kind}` (task|bug|question|message)"),
        );
    }
    let status = b.status.as_deref().map(str::trim).unwrap_or("open");
    if !matches!(status, "open" | "held") {
        return err(
            StatusCode::BAD_REQUEST,
            format!("a new item files as open or held, not `{status}`"),
        );
    }
    let db = app.store.database();
    let parent = b.parent.as_deref().map(str::trim).filter(|p| !p.is_empty());
    if let Some(p) = parent {
        if db.get_work_item(p).is_none() {
            return err(StatusCode::NOT_FOUND, format!("no parent item `{p}`"));
        }
    }
    let now = ledger::now_millis();
    let id = match parent {
        Some(p) => mint_child_id(&db, p),
        None => mint_root_id(&db, &title, now),
    };
    let author = b.author.as_deref().map(str::trim).filter(|a| !a.is_empty());
    let item = WorkItem {
        id: id.clone(),
        title,
        body: b.body.filter(|s| !s.trim().is_empty()),
        status: status.to_string(),
        priority: b.priority.unwrap_or(2),
        kind: kind.to_string(),
        assignee: None,
        claimed_at: None,
        lease_expires_at: None,
        closed_at: None,
        close_reason: None,
        defer_until: b.defer_until,
        origin_kind: b.origin_kind.filter(|s| !s.trim().is_empty()),
        origin_id: b.origin_id.filter(|s| !s.trim().is_empty()),
        project_path: b.project_path.filter(|s| !s.trim().is_empty()),
        pinned: b.pinned.unwrap_or(false),
        created_at: now,
        updated_at: now,
    };
    if let Err(e) = db.insert_work_item(&item) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if let Some(p) = parent {
        // Mirrors the record_work_event pattern below: the failure is logged
        // WITH both ids — never silently dropped, never blocking the item.
        if let Err(e) = db.insert_work_edge(p, &id, "parent-child", author, now) {
            tracing::warn!(parent = %p, item = %id, error = %e, "parent-child edge insert failed");
        }
    }
    // The chain append either succeeds or the failure is logged WITH the item
    // id — never silently dropped. The row write is never blocked on it.
    if let Err(e) = ledger::record_work_event(&db, EventKind::WorkFile, &id, author, None, now) {
        tracing::warn!(item = %id, error = %e, "work_file chain append failed");
    }
    Json(json!({ "item": item })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimWorkBody {
    assignee: String,
    /// Lease length; default 3600.
    lease_seconds: Option<i64>,
}

/// `POST /v1/work/:id/claim` (scope `work.claim`) — take the item: `open` →
/// `claimed` with an assignee and a lease, atomically (one guarded UPDATE;
/// exactly one competing claimer wins). 409 when it is not open. A lapsed
/// lease is freed by the keeper's `expire_work_leases` pass — the row goes
/// back to `open` there and the next claim races normally.
pub async fn handle_work_claim(
    State(app): State<crate::AppState>,
    Path(id): Path<String>,
    Json(b): Json<ClaimWorkBody>,
) -> axum::response::Response {
    let assignee = b.assignee.trim().to_string();
    if assignee.is_empty() {
        return err(StatusCode::BAD_REQUEST, "assignee is required");
    }
    let db = app.store.database();
    let id = id.trim().to_string();
    if db.get_work_item(&id).is_none() {
        return err(StatusCode::NOT_FOUND, format!("no work item `{id}`"));
    }
    let now = ledger::now_millis();
    let lease = now + b.lease_seconds.unwrap_or(DEFAULT_LEASE_SECONDS).max(1) * 1000;
    match db.claim_work_item(&id, &assignee, now, Some(lease)) {
        Ok(true) => {
            // Succeeds or the failure is logged with the item id — never
            // silently dropped, never blocking the claim itself.
            if let Err(e) = ledger::record_work_event(
                &db,
                EventKind::WorkClaim,
                &id,
                Some(&assignee),
                None,
                now,
            ) {
                tracing::warn!(item = %id, error = %e, "work_claim chain append failed");
            }
            match db.get_work_item(&id) {
                Some(item) => Json(json!({ "item": item })).into_response(),
                None => err(StatusCode::INTERNAL_SERVER_ERROR, "claimed item vanished"),
            }
        }
        Ok(false) => err(
            StatusCode::CONFLICT,
            format!("work item `{id}` is not open to claim"),
        ),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseWorkBody {
    /// Why it closed (done / wontfix / superseded-by:… — free text this wave).
    reason: Option<String>,
    /// Who closes it — the ledger author. Defaults to the local author.
    author: Option<String>,
}

/// `POST /v1/work/:id/close` (scope `work.claim`) — close any non-closed
/// item, recording the reason. `closed_at` + `close_reason` are set exactly
/// once; closing an already-closed item is a no-op 409. Child/duplicate/
/// supersede edge bookkeeping on close is a later wave's.
pub async fn handle_work_close(
    State(app): State<crate::AppState>,
    Path(id): Path<String>,
    Json(b): Json<CloseWorkBody>,
) -> axum::response::Response {
    let db = app.store.database();
    let id = id.trim().to_string();
    if db.get_work_item(&id).is_none() {
        return err(StatusCode::NOT_FOUND, format!("no work item `{id}`"));
    }
    let reason = b.reason.as_deref().map(str::trim).filter(|r| !r.is_empty());
    let author = b.author.as_deref().map(str::trim).filter(|a| !a.is_empty());
    let now = ledger::now_millis();
    match db.close_work_item(&id, reason, now) {
        Ok(true) => {
            // Succeeds or the failure is logged with the item id — never
            // silently dropped, never blocking the close itself.
            if let Err(e) =
                ledger::record_work_event(&db, EventKind::WorkClose, &id, author, reason, now)
            {
                tracing::warn!(item = %id, error = %e, "work_close chain append failed");
            }
            match db.get_work_item(&id) {
                Some(item) => Json(json!({ "item": item })).into_response(),
                None => err(StatusCode::INTERNAL_SERVER_ERROR, "closed item vanished"),
            }
        }
        Ok(false) => err(
            StatusCode::CONFLICT,
            format!("work item `{id}` is already closed"),
        ),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Read-only rollup — the Work tab's one read. Still the state plane: this
// command only makes the graph visible (agents consume it over the routes;
// humans inspect it here). No claim, no close, no launch.
// ---------------------------------------------------------------------------

/// The visible graph in one read: every non-closed item, the deduped edges
/// touching them, and the unfiltered ready frontier's ids (the hub view).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkGraphRollup {
    pub items: Vec<WorkItem>,
    pub edges: Vec<WorkEdge>,
    /// Ids from `list_ready_work_items` (no project filter) — the FE marks
    /// these rows "ready" rather than re-deriving the CTE's semantics.
    pub ready_ids: Vec<String>,
}

/// Bounded read: the Work tab is an inspection surface, not a pager.
const GRAPH_ROLLUP_LIMIT: i64 = 1000;

/// Testable core of `get_work_graph`: unclosed list + ready + ONE batched
/// edges read over the `db.rs` helpers. The closed filter sits INSIDE the
/// SQL limit (`list_unclosed_work_items`) — the old list-then-filter read
/// let a backlog of old closed rows (created_at ASC) crowd every live item
/// out of the bound, and the FE's blocked-by view then diverged from the
/// ready CTE. Each edge row returns once from the batched read, so no
/// caller-side dedupe is needed.
pub(crate) fn work_graph_rollup(db: &Database) -> Result<WorkGraphRollup, String> {
    let items: Vec<WorkItem> = db
        .list_unclosed_work_items(GRAPH_ROLLUP_LIMIT)
        .map_err(|e| e.to_string())?;
    let ready_ids: Vec<String> = db
        .list_ready_work_items(None, ledger::now_millis(), GRAPH_ROLLUP_LIMIT)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|i| i.id)
        .collect();
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let edges = db
        .list_work_edges_touching_any(&ids, GRAPH_ROLLUP_LIMIT)
        .map_err(|e| e.to_string())?;
    Ok(WorkGraphRollup {
        items,
        edges,
        ready_ids,
    })
}

/// The Work tab's (and the ambient ready-depth segment's) read-only rollup.
#[tauri::command]
pub fn get_work_graph(
    store: tauri::State<'_, crate::state::SessionStore>,
) -> Result<WorkGraphRollup, String> {
    work_graph_rollup(&store.database())
}

// ---------------------------------------------------------------------------
// "While you were away" — the same state plane, read against a watermark.
//
// The overnight queue runs at 3am, a moot convenes on an item and reaches a
// verdict, an intake arrives from a share: all three land in the work graph
// while nobody is looking at it, and until now the only way to find out was to
// go to the Runs surface and read the graph. The Companion is the conversation
// that spans the app, so it is where "here is what happened" belongs.
//
// Read-only and derived, exactly like the rollup above. It launches nothing,
// claims nothing, and closes nothing.
// ---------------------------------------------------------------------------

/// One thing that happened while the user was elsewhere.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayCard {
    /// `arrived` — a work item was filed (an intake, a triage, a queue park).
    /// `closed` — an item finished. `moot` — a moot turn was recorded on one.
    pub kind: String,
    /// The work item this is about, so the FE can route a tap at the graph.
    pub item_id: String,
    pub title: String,
    /// The close reason, the origin, or the speaking seat — whatever makes the
    /// line say something. Never required.
    pub detail: Option<String>,
    pub at: i64,
}

/// How many of each kind to read. A feed, not a pager: past a couple of dozen
/// the honest summary is "and 40 more", which the FE renders from the count.
const AWAY_LIMIT: i64 = 40;

/// Classify one work-item row against the watermark.
///
/// The row carries both timestamps, so a single list read answers both
/// questions. A closure WINS over an arrival when both fall inside the window:
/// an item that was filed and finished while the user was away is news because
/// it is *done*, and reporting it as "arrived" would send them looking for
/// work that no longer exists.
pub(crate) fn away_card_for(item: &WorkItem, since_ms: i64) -> Option<AwayCard> {
    if let Some(closed) = item.closed_at.filter(|c| *c >= since_ms) {
        return Some(AwayCard {
            kind: "closed".to_string(),
            item_id: item.id.clone(),
            title: item.title.clone(),
            detail: item.close_reason.clone(),
            at: closed,
        });
    }
    if item.created_at >= since_ms {
        return Some(AwayCard {
            kind: "arrived".to_string(),
            item_id: item.id.clone(),
            title: item.title.clone(),
            detail: item.origin_kind.clone(),
            at: item.created_at,
        });
    }
    None
}

/// The speaking seat inside a `moot_turn` event's namespaced author
/// (`moot:<seat>`), or `None` for anything else. The namespace exists so a
/// seat name can never collide with a human author identity (`ledger.rs`).
pub(crate) fn moot_seat(author: &str) -> Option<String> {
    author.strip_prefix("moot:").map(|s| s.to_string())
}

/// Testable core of `work_since`: the item rows and the moot turns, merged
/// newest-first. A moot turn names its item by `ref_id`; the title comes from
/// the item row when it is still there, and the event stands on its own when
/// it is not — a decision outlives the row it was about, which is the whole
/// point of recording it in the ledger.
pub(crate) fn away_feed(db: &Database, since_ms: i64) -> Result<Vec<AwayCard>, String> {
    let items = db
        .list_work_items_since(since_ms, AWAY_LIMIT)
        .map_err(|e| e.to_string())?;
    let mut cards: Vec<AwayCard> = items
        .iter()
        .filter_map(|i| away_card_for(i, since_ms))
        .collect();
    for ev in db
        .list_ledger_events_of_kind_since("moot_turn", since_ms, AWAY_LIMIT)
        .map_err(|e| e.to_string())?
    {
        let Some(item_id) = ev.ref_id.clone() else {
            continue;
        };
        let title = items
            .iter()
            .find(|i| i.id == item_id)
            .map(|i| i.title.clone())
            .or_else(|| db.get_work_item(&item_id).map(|i| i.title))
            .unwrap_or_else(|| item_id.clone());
        cards.push(AwayCard {
            kind: "moot".to_string(),
            item_id,
            title,
            detail: moot_seat(&ev.author),
            at: ev.ts,
        });
    }
    cards.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(cards)
}

/// What the work graph did since `sinceMs`. Read-only.
#[tauri::command]
pub fn work_since(
    store: tauri::State<'_, crate::state::SessionStore>,
    since_ms: i64,
) -> Result<Vec<AwayCard>, String> {
    away_feed(&store.database(), since_ms)
}

// ---------------------------------------------------------------------------
// Tests — id minting, vocabularies, and the handlers' row plumbing. The
// deep-logic battery (ready CTE, claim race, lease expiry, ledger chain,
// origin-outliving, boundary guard) lives beside the SQL in `db.rs`'s
// work-graph tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(db: &Database, id: &str, title: &str, status: &str) -> WorkItem {
        let now = ledger::now_millis();
        let item = WorkItem {
            id: id.to_string(),
            title: title.to_string(),
            body: None,
            status: status.to_string(),
            priority: 2,
            kind: "task".to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at: None,
            close_reason: None,
            defer_until: None,
            origin_kind: None,
            origin_id: None,
            project_path: None,
            pinned: false,
            created_at: now,
            updated_at: now,
        };
        db.insert_work_item(&item).unwrap();
        item
    }

    /// A work item with explicit timestamps — the away feed is entirely about
    /// which side of the watermark they fall on.
    fn stamped(
        db: &Database,
        id: &str,
        title: &str,
        created_at: i64,
        closed_at: Option<i64>,
    ) -> WorkItem {
        let item = WorkItem {
            id: id.to_string(),
            title: title.to_string(),
            body: None,
            status: if closed_at.is_some() { "closed" } else { "open" }.to_string(),
            priority: 2,
            kind: "task".to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at,
            close_reason: closed_at.map(|_| "shipped".to_string()),
            defer_until: None,
            origin_kind: Some("intake".to_string()),
            origin_id: None,
            project_path: None,
            pinned: false,
            created_at,
            updated_at: closed_at.unwrap_or(created_at),
        };
        db.insert_work_item(&item).unwrap();
        item
    }

    #[test]
    fn away_card_reports_a_closure_over_an_arrival() {
        // Filed AND finished while the user was away: the news is that it is
        // done. Calling it an arrival would send them looking for open work.
        let item = stamped(&Database::open_in_memory().unwrap(), "rl-a", "Ship it", 200, Some(300));
        let card = away_card_for(&item, 100).unwrap();
        assert_eq!(card.kind, "closed");
        assert_eq!(card.at, 300);
        assert_eq!(card.detail.as_deref(), Some("shipped"));
    }

    #[test]
    fn away_card_reports_an_arrival_with_its_origin() {
        let item = stamped(&Database::open_in_memory().unwrap(), "rl-b", "Route this", 200, None);
        let card = away_card_for(&item, 100).unwrap();
        assert_eq!(card.kind, "arrived");
        assert_eq!(card.at, 200);
        assert_eq!(card.detail.as_deref(), Some("intake"));
    }

    #[test]
    fn away_card_ignores_what_happened_before_the_watermark() {
        let db = Database::open_in_memory().unwrap();
        // Old and still open: not news.
        assert!(away_card_for(&stamped(&db, "rl-c", "Old", 10, None), 100).is_none());
        // Old and closed BEFORE the watermark: also not news.
        assert!(away_card_for(&stamped(&db, "rl-d", "Older", 10, Some(20)), 100).is_none());
        // …but an old item closed after it is exactly what the feed is for.
        let card = away_card_for(&stamped(&db, "rl-e", "Long-running", 10, Some(300)), 100).unwrap();
        assert_eq!(card.kind, "closed");
    }

    #[test]
    fn the_watermark_instant_itself_counts_as_news() {
        // `>=`, not `>`: a run that landed on the same millisecond the user
        // last looked is on the far side of "while you were away".
        let item = stamped(&Database::open_in_memory().unwrap(), "rl-f", "Edge", 100, None);
        assert!(away_card_for(&item, 100).is_some());
    }

    #[test]
    fn moot_seat_reads_the_namespaced_author_only() {
        assert_eq!(moot_seat("moot:skeptic").as_deref(), Some("skeptic"));
        // A human author is never mistaken for a seat — that namespace is why
        // the prefix exists.
        assert_eq!(moot_seat("skeptic"), None);
        assert_eq!(moot_seat(""), None);
    }

    #[test]
    fn away_feed_merges_items_and_moot_turns_newest_first() {
        let db = Database::open_in_memory().unwrap();
        stamped(&db, "rl-old", "Before the watermark", 10, None);
        stamped(&db, "rl-new", "Arrived overnight", 200, None);
        stamped(&db, "rl-done", "Finished overnight", 50, Some(400));
        ledger::record_moot_turn(&db, "rl-new", "moot-1", 1, "skeptic", "digest-1", 300)
            .unwrap()
            .expect("the turn is recorded");

        let feed = away_feed(&db, 100).unwrap();
        // A ledger event carries the instant it was RECORDED (`record_decision`
        // stamps `ts` itself; the `at` argument goes into the payload hash), so
        // the turn just written is the newest thing here — which is also why
        // the reader filters on `ts`.
        assert_eq!(
            feed.iter().map(|c| (c.kind.as_str(), c.item_id.as_str())).collect::<Vec<_>>(),
            vec![("moot", "rl-new"), ("closed", "rl-done"), ("arrived", "rl-new")],
            "newest first, and nothing from before the watermark"
        );
        // The moot card borrows the item's title rather than showing an id.
        assert_eq!(feed[0].title, "Arrived overnight");
        assert_eq!(feed[0].detail.as_deref(), Some("skeptic"));
    }

    #[test]
    fn a_moot_verdict_outlives_the_item_row_it_was_about() {
        // The ledger is the record; a decision does not vanish because the
        // work item was deleted. The card falls back to naming the id.
        let db = Database::open_in_memory().unwrap();
        ledger::record_moot_turn(&db, "rl-gone", "moot-2", 1, "builder", "digest-2", 300)
            .unwrap()
            .expect("the turn is recorded");
        let feed = away_feed(&db, 100).unwrap();
        assert_eq!(feed.len(), 1);
        assert_eq!(feed[0].kind, "moot");
        assert_eq!(feed[0].title, "rl-gone");
    }

    #[test]
    fn a_quiet_night_is_an_empty_feed() {
        let db = Database::open_in_memory().unwrap();
        stamped(&db, "rl-x", "Filed last week", 10, None);
        assert!(away_feed(&db, 100).unwrap().is_empty());
    }

    #[test]
    fn root_ids_are_hash_based_and_lengthen_on_collision() {
        let db = Database::open_in_memory().unwrap();
        let id = mint_root_id(&db, "fix the widget", 1000);
        assert!(id.starts_with("rl-"), "{id}");
        assert_eq!(id.len(), "rl-".len() + 4);
        // Same seed → same 4-char prefix; occupy it and the mint lengthens.
        mk(&db, &id, "occupier", "open");
        let id2 = mint_root_id(&db, "fix the widget", 1000);
        assert_ne!(id, id2);
        assert_eq!(id2.len(), "rl-".len() + 8);
        assert!(id2.starts_with(&id), "longer prefix of the same hash");
    }

    #[test]
    fn child_ids_take_the_next_ordinal_and_never_reuse_a_freed_one() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-ab12", "parent", "open");
        assert_eq!(mint_child_id(&db, "rl-ab12"), "rl-ab12.1");
        mk(&db, "rl-ab12.1", "child one", "open");
        mk(&db, "rl-ab12.3", "child three", "open");
        // A grandchild must not disturb the parent's ordinal walk.
        mk(&db, "rl-ab12.1.1", "grandchild", "open");
        assert_eq!(mint_child_id(&db, "rl-ab12"), "rl-ab12.4");
        assert_eq!(mint_child_id(&db, "rl-ab12.1"), "rl-ab12.1.2");
    }

    #[test]
    fn ready_excludes_held_deferred_and_claimed_items() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-open", "ready", "open");
        mk(&db, "rl-held", "parked", "held");
        mk(&db, "rl-clm", "taken", "open");
        let now = ledger::now_millis();
        assert!(db.claim_work_item("rl-clm", "agent-a", now, None).unwrap());
        let mut deferred = mk(&db, "rl-dfr", "later", "open");
        deferred.defer_until = Some(now + 60_000);
        // Re-insert with the defer set (plumbing test — no update helper yet).
        db.close_work_item("rl-dfr", None, now).unwrap();
        db.insert_work_item(&WorkItem {
            id: "rl-dfr2".to_string(),
            ..deferred
        })
        .unwrap();
        let ready = db.list_ready_work_items(None, now, 50).unwrap();
        let ids: Vec<&str> = ready.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["rl-open"]);
    }

    #[test]
    fn claim_is_guarded_and_close_records_the_reason() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-x1", "one", "open");
        let now = ledger::now_millis();
        assert!(db.claim_work_item("rl-x1", "agent-a", now, Some(now + 1000)).unwrap());
        // Second claim finds it not-open and refuses.
        assert!(!db.claim_work_item("rl-x1", "agent-b", now, None).unwrap());
        let item = db.get_work_item("rl-x1").unwrap();
        assert_eq!(item.status, "claimed");
        assert_eq!(item.assignee.as_deref(), Some("agent-a"));
        assert_eq!(item.lease_expires_at, Some(now + 1000));

        assert!(db.close_work_item("rl-x1", Some("done"), now).unwrap());
        assert!(!db.close_work_item("rl-x1", Some("again"), now).unwrap());
        let item = db.get_work_item("rl-x1").unwrap();
        assert_eq!(item.status, "closed");
        assert_eq!(item.close_reason.as_deref(), Some("done"));
        assert_eq!(item.closed_at, Some(now));
    }

    #[test]
    fn edges_are_idempotent_and_listed_from_both_ends() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-a", "a", "open");
        mk(&db, "rl-b", "b", "open");
        let now = ledger::now_millis();
        assert!(db.insert_work_edge("rl-a", "rl-b", "blocks", Some("me"), now).unwrap());
        assert!(!db.insert_work_edge("rl-a", "rl-b", "blocks", Some("me"), now).unwrap());
        // A different type between the same pair is a distinct edge.
        assert!(db
            .insert_work_edge("rl-a", "rl-b", "relates-to", None, now)
            .unwrap());
        let from_a = db.list_work_edges_touching("rl-a").unwrap();
        let from_b = db.list_work_edges_touching("rl-b").unwrap();
        assert_eq!(from_a.len(), 2);
        assert_eq!(from_b.len(), 2);
        assert_eq!(from_a[0].edge_type, "blocks");
        // Deleting an item must NOT silently drop its edges (the schema law:
        // no FK cascade; edge cleanup is an explicit recorded act).
        // There is no delete helper this wave, which is itself the guarantee.
    }

    #[test]
    fn work_events_chain_and_dedupe_per_act() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-ev", "evented", "open");
        let seq = ledger::record_work_event(&db, EventKind::WorkFile, "rl-ev", None, None, 111)
            .unwrap();
        assert!(seq.is_some());
        // The identical act dedupes…
        let again =
            ledger::record_work_event(&db, EventKind::WorkFile, "rl-ev", None, None, 111).unwrap();
        assert!(again.is_none());
        // …while a later act of a different kind records, and the chain stays
        // verifiable end-to-end.
        let claim = ledger::record_work_event(
            &db,
            EventKind::WorkClaim,
            "rl-ev",
            Some("agent-a"),
            None,
            222,
        )
        .unwrap();
        assert!(claim.is_some());
        let events = db.list_ledger_events(10).unwrap();
        assert!(events.iter().any(|e| e.kind == "work_file"
            && e.ref_kind.as_deref() == Some("work_item")
            && e.ref_id.as_deref() == Some("rl-ev")));
        assert!(events.iter().any(|e| e.kind == "work_claim"));
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
    }

    #[test]
    fn vocabularies_are_closed_and_consistent() {
        // The lifecycle the handlers enforce is exactly the schema's.
        assert_eq!(WORK_STATUSES, &["open", "claimed", "closed", "held"]);
        assert_eq!(WORK_KINDS, &["task", "bug", "question", "message"]);
        assert_eq!(WORK_EDGE_TYPES.len(), 7);
        // The one edge type this wave writes is in the closed vocabulary.
        assert!(WORK_EDGE_TYPES.contains(&"parent-child"));
        for v in WORK_STATUSES.iter().chain(WORK_KINDS).chain(WORK_EDGE_TYPES) {
            assert_eq!(*v, v.to_lowercase(), "vocab is lowercase");
            assert!(!v.contains(' '), "vocab is space-free");
        }
    }

    #[test]
    fn list_filters_by_status_and_project_facets() {
        let db = Database::open_in_memory().unwrap();
        let mut a = mk(&db, "rl-p1", "in project", "open");
        a.id = "rl-p2".to_string();
        a.project_path = Some("/tmp/proj".to_string());
        db.insert_work_item(&a).unwrap();
        mk(&db, "rl-p3", "held one", "held");

        let open = db.list_work_items(Some("open"), None, 50).unwrap();
        assert_eq!(open.len(), 2);
        let held = db.list_work_items(Some("held"), None, 50).unwrap();
        assert_eq!(held.len(), 1);
        let all = db.list_work_items(None, None, 50).unwrap();
        assert_eq!(all.len(), 3);
        // project_path is a facet: filtering by it narrows, deleting nothing.
        let proj = db.list_work_items(None, Some("/tmp/proj"), 50).unwrap();
        assert_eq!(proj.len(), 1);
        assert_eq!(proj[0].id, "rl-p2");
    }

    #[test]
    fn graph_rollup_excludes_closed_dedupes_edges_and_names_the_frontier() {
        let db = Database::open_in_memory().unwrap();
        mk(&db, "rl-r1", "ready", "open");
        mk(&db, "rl-b1", "blocker", "open");
        mk(&db, "rl-t1", "blocked", "open");
        mk(&db, "rl-c1", "finished", "open");
        let now = ledger::now_millis();
        db.insert_work_edge("rl-b1", "rl-t1", "blocks", None, now)
            .unwrap();
        db.close_work_item("rl-c1", Some("done"), now).unwrap();

        let g = work_graph_rollup(&db).unwrap();
        let ids: Vec<&str> = g.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"rl-r1"));
        assert!(ids.contains(&"rl-b1"));
        assert!(ids.contains(&"rl-t1"));
        assert!(
            !ids.contains(&"rl-c1"),
            "closed items are not part of the visible graph"
        );
        // The edge touches two surviving items but is read once, not twice.
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].edge_type, "blocks");
        // The frontier: the blocker is itself ready; its target is not.
        assert!(g.ready_ids.contains(&"rl-r1".to_string()));
        assert!(g.ready_ids.contains(&"rl-b1".to_string()));
        assert!(!g.ready_ids.contains(&"rl-t1".to_string()));
        // Wire shape the FE mirrors.
        let j = serde_json::to_string(&g).unwrap();
        assert!(j.contains("\"readyIds\""));
        assert!(j.contains("\"items\""));
        assert!(j.contains("\"edges\""));
    }

    #[test]
    fn graph_rollup_survives_more_closed_rows_than_the_limit() {
        let db = Database::open_in_memory().unwrap();
        let now = ledger::now_millis();
        // More closed rows than the rollup bound, ALL OLDER than the live
        // items — the old list-then-filter read (created_at ASC inside the
        // limit) surfaced only these and dropped every live item.
        for i in 0..(GRAPH_ROLLUP_LIMIT + 1) {
            db.insert_work_item(&WorkItem {
                id: format!("rl-done-{i}"),
                title: format!("finished {i}"),
                body: None,
                status: "closed".to_string(),
                priority: 2,
                kind: "task".to_string(),
                assignee: None,
                claimed_at: None,
                lease_expires_at: None,
                closed_at: Some(now - 10_000 + i),
                close_reason: Some("done".to_string()),
                defer_until: None,
                origin_kind: None,
                origin_id: None,
                project_path: None,
                pinned: false,
                created_at: now - 10_000 + i,
                updated_at: now - 10_000 + i,
            })
            .unwrap();
        }
        mk(&db, "rl-live1", "live one", "open");
        mk(&db, "rl-live2", "live two", "open");
        db.insert_work_edge("rl-live1", "rl-live2", "blocks", None, now)
            .unwrap();

        let g = work_graph_rollup(&db).unwrap();
        let ids: Vec<&str> = g.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"rl-live1"), "live item crowded out: {ids:?}");
        assert!(ids.contains(&"rl-live2"), "live item crowded out");
        assert!(g.items.iter().all(|i| i.status != "closed"));
        // The batched edges read still finds the live pair's edge.
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].edge_type, "blocks");
        assert!(g.ready_ids.contains(&"rl-live1".to_string()));
        assert!(!g.ready_ids.contains(&"rl-live2".to_string()), "blocked");
    }

    #[test]
    fn item_json_is_camel_case_and_edge_type_serializes_as_type() {
        let db = Database::open_in_memory().unwrap();
        let item = mk(&db, "rl-js", "shape", "open");
        let j = serde_json::to_string(&item).unwrap();
        assert!(j.contains("\"originKind\""));
        assert!(j.contains("\"leaseExpiresAt\""));
        let edge = WorkEdge {
            from_id: "rl-a".into(),
            to_id: "rl-b".into(),
            edge_type: "blocks".into(),
            created_by: None,
            created_at: 0,
        };
        let j = serde_json::to_string(&edge).unwrap();
        assert!(j.contains("\"type\":\"blocks\""));
        assert!(j.contains("\"fromId\""));
    }
}

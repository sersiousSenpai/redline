// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use crate::state::{
    AttachState, BrowseList, BrowseListItem, BrowseMessage, CodeReviewSession,
    Comment, CommentAttachment,
    CommentKind, CommentOffer,
    CommentScope, CommentSelection, CommentStatus, EditPayload, Linked, LinkedMessage, Mission,
    MissionFinding, MissionMessage, PushRecord, Resolution, ReviewAnnotation, ReviewQuestion,
    ReviewSession, Revision, RoundHistoryEntry, SessionStatus, SourceFeedback, StructuralPayload,
    ThreadMessage, VoiceMessage,
};

/// Reduce a URL to a bare host for feedback aggregation: strip scheme, any path/
/// query, a leading `www.`, and lowercase it. Best-effort — a URL we can't parse
/// falls back to the trimmed input so a row is never lost.
pub fn domain_of(url: &str) -> String {
    let s = url.trim();
    let after_scheme = s.split("://").nth(1).unwrap_or(s);
    let host = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Drop any userinfo@ and :port.
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host.trim_start_matches("www.").to_ascii_lowercase()
}

/// Serialize a comment's reopen-round history for the `reopen_history` column.
/// Empty history stores NULL (keeps pre-feature and never-reopened rows clean).
fn reopen_history_to_json(history: &[RoundHistoryEntry]) -> Option<String> {
    if history.is_empty() {
        return None;
    }
    serde_json::to_string(history).ok()
}

/// Serialize a comment's (or thread turn's) attachment metadata. Same rule as
/// `reopen_history_to_json`: no attachments stores NULL, so every pre-feature
/// row and every comment without a file keeps a clean column.
fn attachments_to_json(attachments: &[CommentAttachment]) -> Option<String> {
    if attachments.is_empty() {
        return None;
    }
    serde_json::to_string(attachments).ok()
}

/// Read attachment metadata back. A NULL, or JSON this build can't parse,
/// degrades to "no attachments" rather than failing the whole row — losing a
/// chip is recoverable; losing the comment is not.
fn attachments_from_json(json: Option<String>) -> Vec<CommentAttachment> {
    json.as_deref()
        .and_then(|s| serde_json::from_str::<Vec<CommentAttachment>>(s).ok())
        .unwrap_or_default()
}

/// One lexical hit from the browse-events FTS index (Dojo P3). `score` is the
/// BM25 relevance (SQLite returns it negative-lower-is-better; we sort ascending
/// and pass it through). `snippet` shows the matched span with `[...]` markers.
/// One minted Review Request share link (owner-local, non-secret metadata —
/// the encryption key only ever rides the link fragment).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRecord {
    pub request_id: String,
    pub session_id: String,
    pub reviewer_name: String,
    #[serde(default)]
    pub note: String,
    pub base_version: u32,
    pub created_at: i64,
}

/// One imported return. `landed_version` is where the comments re-anchored at
/// import (the then-current revision) — navigation targets it, never the
/// share's base_version.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareReturnRecord {
    pub id: String,
    pub request_id: String,
    pub session_id: String,
    pub reviewer_name: String,
    pub imported_at: i64,
    pub landed_version: u32,
    pub placed: u32,
    pub orphans: u32,
    #[serde(default)]
    pub comment_ids: Vec<String>,
}

// The read-side hit rows live in `polis-core` (Session A1 of the Polis
// extraction); re-exported so every `crate::db::BrowseHit` / `GrepHit` site is
// unchanged.
#[allow(unused_imports)]
pub use polis_core::types::{BrowseHit, GrepHit, GrepScope};
// Session A3: the grep + archive vocabulary lives with the store's methods.
#[allow(unused_imports)]
pub use polis_store::{GrepError, ARCHIVE_ALGO, GREP_MIN_LITERAL, PROMPT_TEXT};

/// One context-journal row — a meaningful app activity the Companion folds into
/// its "while you were away" delta (surface switch, revision, nav, pin, …).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub surface_kind: Option<String>,
    pub surface_id: Option<String>,
    pub label: Option<String>,
    pub detail: Option<String>,
}

/// One orchestrated run's durable record: the orchestrator's exit report
/// (its *claims* — Redline pairs them against independently observed ground
/// truth in the report GUI), the workflow script path, and the human
/// resolution that closes the run.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRunRow {
    pub plan_session_id: String,
    pub report_json: String,
    pub script_path: Option<String>,
    pub workflow_ran: bool,
    /// resolved | needs_follow_up | abandoned; None = awaiting the human mark.
    pub resolution: Option<String>,
    pub resolution_note: Option<String>,
    pub resolved_at: Option<i64>,
    pub created_at: i64,
}

/// One orchestrated launch's live-monitor anchor: where the orchestrator's
/// transcript lives, written at the ingest-claim beacon. The discovery
/// columns are NULL until the run watcher finds the Workflow launch line
/// (or falls back to sequential mode) in that transcript.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationRow {
    pub plan_session_id: String,
    pub claude_session_id: String,
    pub transcript_path: String,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub run_id: Option<String>,
    pub transcript_dir: Option<String>,
    pub script_path: Option<String>,
    /// 'workflow' | 'sequential'; None until the watcher knows.
    pub mode: Option<String>,
    /// The dock terminal tab the run was launched into (captured at launch,
    /// folded in at the ingest claim) — lets "stand down" name the tab to
    /// close. None for runs launched before the column existed.
    pub terminal_id: Option<String>,
    /// Joined from `sessions.run_state` (never stored here).
    pub run_state: Option<String>,
}

/// One seat's roster stats (P3): facts about what the seat actually did.
/// Facts live here in the DB — the seat config JSON records intent
/// (model/effort/charter), never history.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatStatRow {
    pub seat: String,
    pub last_run_at: Option<i64>,
    pub items_filed: i64,
    pub updated_at: i64,
}

/// One seat's accumulated burn (P8) — either a single `(seat, day)` row or a
/// rollup with the other axis aggregated away (`day`/`seat` = None then).
/// Tokens only: money is computed at render time elsewhere.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatBurnRow {
    pub seat: Option<String>,
    pub day: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub spawns: i64,
}

/// One remembered dev server — a `(project_path, port)` pair we have seen
/// listening at least once. Rows outlive the process, so the Localhost surface
/// can offer "run it again" for a server that is no longer up.
#[derive(Debug, Clone, PartialEq)]
pub struct DevServerRow {
    pub id: i64,
    pub project_path: String,
    pub project_name: String,
    pub port: u16,
    pub url: String,
    pub stack: String,
    pub run_command: String,
    pub last_seen_at: i64,
    pub thumb_path: Option<String>,
}

/// One turn from a generic thread read (`/v1/context/threads/:kind/:id`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericThreadMsg {
    pub role: String,
    pub body: String,
    pub created_at: i64,
}

/// One Agent Seat's observed workload, from `Database::seat_activity` —
/// the behavioural half of the Seat Assignment agent's digest.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatActivity {
    pub seat: String,
    /// Agent turns inside the caller's window (the digest uses 30 days).
    pub turns_window: i64,
    pub turns_total: i64,
    /// Epoch millis of the seat's most recent turn; `None` = never ran.
    pub last_ts: Option<i64>,
}

/// One shelf item: a document, with the counts the shelf list renders. The
/// document body itself (`doc_json`) is deliberately absent — the list must
/// stay cheap however many documents accumulate.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookshelfDraft {
    pub draft_id: String,
    pub title: Option<String>,
    pub project_path: Option<String>,
    pub folder_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_count: i64,
    /// Whether the document body has ever been written. A row created only by
    /// the markdown mirror (or a pre-Bookshelf draft awaiting migration) has
    /// none, and the shelf shouldn't pretend otherwise.
    pub has_doc: bool,
    /// Marked as a template: an ordinary document the dropdown offers under
    /// "New from template" — instantiating deep-copies its body into a fresh
    /// ordinary document.
    pub is_template: bool,
    /// Times this document has been opened (once per open, never per
    /// keystroke) — ranks the dropdown's FREQUENT section.
    pub open_count: i64,
    /// Epoch millis of the most recent open; `None` = never opened since the
    /// column existed. Tie-breaks FREQUENT.
    pub last_opened_at: Option<i64>,
}

/// One user-authored agent on the shelf (harness program A2). The instruction
/// IS the agent: plain English, composed into a prompt at run time — never a
/// skill (a7be07f stands).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAgent {
    pub agent_id: String,
    pub name: String,
    pub instruction: String,
    pub folder_id: Option<String>,
    pub starred: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Epoch millis of the most recent run; `None` = never run.
    pub last_run_at: Option<i64>,
    pub run_count: i64,
}

/// One folder in the shelf's adjacency list. `parent_id = None` is the root.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookshelfFolder {
    pub folder_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub created_at: i64,
}

/// One source attached to a document (a captured page, a mission finding, a
/// URL, an uploaded file, a digest). Always hangs off a document, never a
/// folder.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSource {
    pub id: String,
    pub draft_id: String,
    pub kind: String,
    pub ref_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub file_path: Option<String>,
    pub created_at: i64,
}

/// What a `delete_draft` / `delete_folder` would actually destroy, so the
/// confirm dialog can name it. These two commands are the only Bookshelf
/// commands that aren't idempotent and they cascade with no undo.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteImpact {
    pub drafts: i64,
    pub folders: i64,
    pub comments: i64,
    pub pending_suggestions: i64,
    pub sources: i64,
    pub chat_messages: i64,
}

/// Process-global friction sink, installed once at boot.
///
/// Most call sites already hold a `Database`. Two don't and can't reasonably be
/// given one: the axum auth middleware (`auth::require_daemon_auth` is a pure
/// function over the route table plus thin glue) and anything reached from a
/// context with no Tauri state. They record through here instead.
static FRICTION_SINK: std::sync::OnceLock<Arc<Database>> = std::sync::OnceLock::new();

/// Install the sink. Idempotent — a second call is ignored, so tests that build
/// their own `Database` can't hijack the running app's.
pub fn install_friction_sink(db: Arc<Database>) {
    let _ = FRICTION_SINK.set(db);
}

/// Record friction from a context with no `Database` in hand. Silently does
/// nothing before the sink is installed, which is the correct behaviour for
/// telemetry: never block, never fail, never panic a caller's path.
pub fn note_friction(kind: &str, surface: Option<&str>, session_id: Option<&str>, detail: Option<&str>) {
    if let Some(db) = FRICTION_SINK.get() {
        let _ = db.record_friction(kind, surface, session_id, detail);
    }
}

/// One `friction_events` kind, aggregated: how often it fired in the window and
/// when it last did. The digest ranks by both — 14 overflows in three days is a
/// different signal from 14 spread over three months.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionCount {
    pub kind: String,
    pub count: i64,
    pub last_ts: i64,
    /// The most recent `detail`, truncated at write time. Illustrative only.
    pub last_detail: Option<String>,
}

/// One thing the Shipwright found, and what you did with it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipwrightFinding {
    pub id: String,
    pub run_id: String,
    pub category: String,
    pub summary: String,
    pub evidence: Option<String>,
    pub proposal: Option<String>,
    pub guard: Option<String>,
    /// JSON array of repo-relative paths. Shipped-detection reads this.
    pub files: Option<String>,
    pub status: String,
    pub dismissed: bool,
    pub draft_id: Option<String>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

/// How the Shipwright has actually been doing, per category — accept-rate and
/// dismiss-rate straight off `shipwright_findings`, so the next digest carries
/// its own track record instead of the agent asserting one.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryScore {
    pub category: String,
    pub total: i64,
    pub accepted: i64,
    pub dismissed: i64,
    pub shipped: i64,
}

/// Every folder in `root`'s subtree, `root` included. Walked breadth-first over
/// the adjacency edges, with a visited set so a pre-existing cycle (a DB written
/// by an older build, say) terminates instead of hanging. Pure.
pub fn folder_subtree(edges: &[(String, Option<String>)], root: &str) -> Vec<String> {
    let mut out = vec![root.to_string()];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(root.to_string());
    let mut i = 0;
    while i < out.len() {
        let parent = out[i].clone();
        i += 1;
        for (id, p) in edges {
            if p.as_deref() == Some(parent.as_str()) && seen.insert(id.clone()) {
                out.push(id.clone());
            }
        }
    }
    out
}

/// Why a folder move must be refused, or `None` if it's legal. The load-bearing
/// case is reparenting a folder **into its own subtree**: adjacency has no
/// structural guard against it, and the resulting cycle would silently orphan
/// the whole subtree from the root walk. Pure, so the rule is tested directly.
pub fn folder_move_rejection(
    edges: &[(String, Option<String>)],
    folder_id: &str,
    new_parent: Option<&str>,
) -> Option<String> {
    let Some(parent) = new_parent else {
        return None; // the shelf root is always a legal destination
    };
    if parent == folder_id {
        return Some("a folder can't be its own parent".to_string());
    }
    if !edges.iter().any(|(id, _)| id == parent) {
        return Some(format!("no such folder `{parent}`"));
    }
    if folder_subtree(edges, folder_id)
        .iter()
        .any(|id| id == parent)
    {
        return Some("can't move a folder into its own subtree".to_string());
    }
    None
}

// The lexical layer's constants and the version keys moved to `polis-store`
// with the DDL (Session A2 of the Polis extraction); re-exported for path
// stability — `#[allow(unused_imports)]` because a shim's names are used
// elsewhere or in tests, not here.
#[allow(unused_imports)]
pub use polis_store::{
    schema::MEMORY_TABLES, CORPUS_ROLE_VERSION, LEXICAL_VERSION, PREFIX_SIZES, SYSTEM_INDEX_CHARS,
    TOKENIZER,
};
use polis_store::{AttachOptions, PolisStore};

pub struct Database {
    /// Shared with the attached `PolisStore` — ONE connection, one lock, so
    /// the memory tables and the app's own live in one transaction domain.
    conn: Arc<Mutex<Connection>>,
    /// Polis Memory's store, attached to the same connection (Session A2 of
    /// the Polis extraction, docs/polis-extraction.md). Reached through
    /// `Deref`, so `db.<store method>()` reads as it always has once the
    /// memory methods move there (A3). `polis_store_guard.rs` pins that the
    /// two never share a method name — Deref precedence would hide it.
    polis: Arc<PolisStore>,
}

impl std::ops::Deref for Database {
    type Target = PolisStore;
    fn deref(&self) -> &PolisStore {
        self.polis.as_ref()
    }
}

/// `StoreError` → the `rusqlite::Error` the `open` signatures already return.
fn store_err(e: polis_store::StoreError) -> rusqlite::Error {
    match e {
        polis_store::StoreError::Sqlite(e) => e,
        other => rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(other.to_string()),
        ),
    }
}

/// Latches the one-time poison report. The report itself writes a
/// `friction_events` row, which re-enters `lock_conn` — without this the first
/// poisoned lock would recurse forever.
static POISON_REPORTED: AtomicBool = AtomicBool::new(false);

// How many migration steps have executed **on this thread**. The fast path's
// contract — an already-current database runs no schema SQL — is otherwise
// unobservable from outside, and "it felt fast" is not a test.
//
// Thread-local, not a global atomic: the test suite runs in parallel and every
// other test that opens an in-memory database runs the v1 step, so a
// process-wide counter would measure the suite rather than the case. One test
// thread per test makes this exact.
#[cfg(test)]
thread_local! {
    pub(crate) static MIGRATION_STEPS_RUN: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}

impl Database {
    /// The ONLY way production code takes the connection.
    ///
    /// The crate builds with `panic = "unwind"` deliberately, so a panic inside
    /// any closure that holds this guard unwinds and poisons the mutex. With a
    /// bare `.unwrap()` every subsequent lock — that is, every Tauri command and
    /// every bridge route in the app — panics forever while the window stays up
    /// and looks alive. Recovering the guard is the house pattern already used
    /// for the PTY registry (`pty::lock_ok`), the grant registry (`auth.rs`) and
    /// the seat store (`seat.rs`).
    ///
    /// Recovery is safe here for the same reason it is safe there: the guarded
    /// value stays coherent. rusqlite rolls an open transaction back when the
    /// `Transaction` is dropped during the unwind, so the `Connection` a
    /// poisoned lock hands back is a connection with no half-applied write on
    /// it — the panicking statement is simply undone.
    fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        match self.conn.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let guard = poisoned.into_inner();
                if !POISON_REPORTED.swap(true, Ordering::SeqCst) {
                    // `note_friction` writes through this same non-reentrant
                    // mutex, so the guard has to be released before reporting
                    // and re-taken after. The latch above stops the report's
                    // own `lock_conn` from reporting again.
                    drop(guard);
                    tracing::error!(
                        "db connection mutex was poisoned by a panic inside a db closure; \
                         recovering the guard so commands keep working"
                    );
                    note_friction(
                        "db_lock_poisoned",
                        Some("db"),
                        None,
                        Some("recovered a poisoned Mutex<Connection>"),
                    );
                    return self.conn.lock().unwrap_or_else(|e| e.into_inner());
                }
                guard
            }
        }
    }

    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        // Connection pragmas, best-effort (a pragma an older SQLite doesn't
        // know must never fail the open). WAL is the load-bearing one: readers
        // no longer block behind the writer, which is what made an agent's
        // retrieval curls queue behind a browse capture on the single
        // `Mutex<Connection>`. `synchronous=NORMAL` is WAL's safe companion —
        // durable across process crash, only at risk on OS/power loss, and the
        // crown-jewels protection here is the `VACUUM INTO` backup, not fsync
        // per commit. `foreign_keys` is deliberately untouched.
        for pragma in [
            "PRAGMA journal_mode = WAL",
            "PRAGMA synchronous = NORMAL",
            "PRAGMA busy_timeout = 5000",
            "PRAGMA cache_size = -64000",
            "PRAGMA mmap_size = 268435456",
        ] {
            let _ = conn.execute_batch(pragma);
        }
        Self::migrate(&conn)?;
        let conn = Arc::new(Mutex::new(conn));
        // The host's own schema first, then the memory store attaches to the
        // same connection and brings its tables current under its OWN version
        // key (`polis_meta`) — never `PRAGMA user_version`, which this app
        // shares with another lineage.
        let polis = PolisStore::attach(
            Arc::clone(&conn),
            AttachOptions::redline().with_author(crate::ledger::local_author()),
        )
            .map_err(store_err)?;
        let db = Self { conn, polis: Arc::new(polis) };
        // The send queues are in-memory: any row still `queued` now belongs
        // to a previous run and will never fire.
        db.sweep_queued_to_unsent()?;
        Ok(db)
    }

    /// Not `#[cfg(test)]` (it was, until Session A1): `memory_schema_sql` needs a
    /// fresh database from the NON-test lib, because `tests/schema_golden.rs`
    /// is an integration test and links the library as shipped.
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        let conn = Arc::new(Mutex::new(conn));
        let polis = PolisStore::attach(
            Arc::clone(&conn),
            AttachOptions::redline().with_author(crate::ledger::local_author()),
        )
            .map_err(store_err)?;
        Ok(Self { conn, polis: Arc::new(polis) })
    }

    /// The planner's chosen strategy for a statement, joined into one line —
    /// the substrate for the query-plan guard tests. A hot read that regresses
    /// to `SCAN <table>` is the failure this catches; parameters are never
    /// bound (the plan doesn't depend on their values here).
    #[cfg(test)]
    pub fn explain_query_plan(&self, sql: &str) -> rusqlite::Result<String> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(3))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.join(" | "))
    }

    /// The schema version this build writes and expects.
    ///
    /// Bump it and add a step to `MIGRATIONS` in the same diff; never edit a
    /// step that has shipped. Higher stamps are verified without migrations
    /// or restamping; only an unusable forward schema is refused.
    const SCHEMA_VERSION: i64 = 3;

    /// Ordered migration steps. `(target_version, step)`: running `step` takes
    /// a database from `target_version - 1` to `target_version`.
    const MIGRATIONS: &'static [(i64, fn(&Connection) -> rusqlite::Result<()>)] =
        &[(1, Self::migrate_v1), (2, Self::migrate_v2), (3, Self::migrate_v3)];

    /// Bring the database to `SCHEMA_VERSION`, or return an error.
    ///
    /// The point of versioning is the **fast path**: an already-current
    /// database uses read-only schema checks and executes no DDL. Before
    /// this, every single launch replayed the entire schema — ~60
    /// `CREATE TABLE IF NOT EXISTS`, ~50 `CREATE INDEX IF NOT EXISTS`, and 68
    /// `ALTER TABLE ADD COLUMN` statements that were *expected to fail*, each
    /// one parsed, planned, and turned into an error object, on the critical
    /// path in front of the window.
    ///
    /// **A step owns its own atomicity, and the stamp is written only after it
    /// returns `Ok`.** The runner deliberately does not wrap steps in a
    /// transaction: the v1 step contains its own `BEGIN`/`COMMIT` (the legacy
    /// `comments` primary-key rebuild is a create-copy-drop-rename that has to
    /// be atomic on its own terms), and SQLite has no nested transactions. The
    /// invariant that makes stamp-after safe is that every step is written to
    /// be **idempotent** — a step that dies half-way leaves the version where
    /// it was, and the next launch simply runs it again from the top. That is
    /// exactly what the pre-versioning code did on every single launch.
    fn migrate(conn: &Connection) -> rusqlite::Result<()> {
        let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if current == Self::SCHEMA_VERSION {
            // Another migration lineage has used this same integer before.
            // Never let a matching stamp hide missing history-read columns.
            Self::verify_schema(conn)?;
            crate::boot_trace::mark(crate::boot_trace::DB_MIGRATE);
            return Ok(());
        }
        if current > Self::SCHEMA_VERSION {
            // A HIGHER stamp is not automatically a newer Redline.
            //
            // `PRAGMA user_version` is ONE 32-bit slot in the file, and this
            // app has had more than one migration lineage claim it: the
            // `cockpit` branch shipped its own versioned runner years before
            // this one, so a developer machine that ever ran a cockpit build
            // carries a stamp from a numbering space that has nothing to do
            // with `MIGRATIONS` below. Refusing on the integer alone bricked
            // exactly that database — a hard panic in Tauri's setup, no
            // window, no message.
            //
            // So the integer is a hint and the SCHEMA is the authority. If
            // everything this build reads and writes is present, the file is
            // usable: run NO steps (that is the real protection — an older
            // build must never replay additive steps over a newer schema),
            // leave the stamp alone (never downgrade someone else's marker),
            // and carry on. Only a forward stamp whose schema is genuinely
            // missing something we need is refused.
            Self::verify_schema(conn).map_err(|_| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                    Some(format!(
                        "database schema version {current} is newer than this build \
                         understands ({}), and it is missing columns this build needs. \
                         Update Redline, or point it at a different data directory.",
                        Self::SCHEMA_VERSION
                    )),
                )
            })?;
            tracing::warn!(
                stamped = current,
                understood = Self::SCHEMA_VERSION,
                "database carries a newer/foreign schema stamp; schema verified, \
                 running no migrations and leaving the stamp untouched"
            );
            crate::boot_trace::mark(crate::boot_trace::DB_MIGRATE);
            return Ok(());
        }

        for (version, step) in Self::MIGRATIONS {
            if *version <= current {
                continue;
            }
            tracing::info!(from = current, to = *version, "migrating database schema");
            step(conn)?;
            conn.pragma_update(None, "user_version", *version)?;
        }

        // The stamp says the columns are there; this checks. A v0 database
        // that hit a partial failure in an earlier build's best-effort
        // migration would otherwise get stamped as current and then fail at
        // read time, one query at a time, forever.
        Self::verify_schema(conn)?;
        crate::boot_trace::mark(crate::boot_trace::DB_MIGRATE);
        Ok(())
    }

    /// Is this database usable by this build?
    ///
    /// Three callers share the same shape check:
    ///   * on a CURRENT stamp — does the shape agree with the marker?
    ///   * after a migration runs — did the best-effort `ALTER TABLE`s
    ///     actually happen, or would we stamp a half-migrated file as current?
    ///   * on a FORWARD/foreign stamp — the integer says "newer", but is the
    ///     schema actually missing anything we need? (See `migrate`: the
    ///     `cockpit` lineage stamps the same slot with unrelated numbers.)
    ///
    /// Deliberately a spot check, not a full schema diff. It covers the core
    /// tables' existence plus the columns added by `ALTER TABLE` — the
    /// statements that were best-effort and could silently not have happened —
    /// on the tables every launch reads. A schema that passes this and is still
    /// missing something exotic will fail at that feature's first query, which
    /// is the same failure mode the app had before versioning existed.
    fn verify_schema(conn: &Connection) -> rusqlite::Result<()> {
        // Present at all, or nothing works. Cheap: one `sqlite_master` read.
        const CORE_TABLES: &[&str] = &[
            "sessions",
            "revisions",
            "comments",
            "app_settings",
            "thread_messages",
            "drafts",
            "run_graphs", "run_nodes", "run_edges", "run_claims",
        ];
        let mut stmt =
            conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")?;
        let present: std::collections::HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for table in CORE_TABLES {
            if !present.contains(*table) {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                    Some(format!("schema check: table {table} is missing")),
                ));
            }
        }
        const REQUIRED: &[(&str, &[&str])] = &[
            (
                "sessions",
                &["attach_state", "updated_at", "run_state", "backend", "model", "effort"],
            ),
            ("revisions", &["thread_start", "restored"]),
            (
                "comments",
                &[
                    "resolution_body",
                    "resolution_version",
                    "block_id",
                    "structural_json",
                    "actionable",
                    "author",
                    "attachments",
                ],
            ),
        ];
        for (table, columns) in REQUIRED {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let present: std::collections::HashSet<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<_>>()?;
            for column in *columns {
                if !present.contains(*column) {
                    return Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                        Some(format!(
                            "schema migration finished but {table}.{column} is missing \
                             — the database is only partly migrated"
                        )),
                    ));
                }
            }
        }
        Ok(())
    }

    /// The execution plane is deliberately separate from backlog provenance.
    fn migrate_v2(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS run_graphs (
                run_id TEXT PRIMARY KEY, plan_session_id TEXT, project_path TEXT NOT NULL,
                status TEXT NOT NULL, doc_json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
                max_write_parallel INTEGER NOT NULL DEFAULT 3,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_run_graphs_plan ON run_graphs(plan_session_id);
            CREATE TABLE IF NOT EXISTS run_nodes (
                run_id TEXT NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
                title TEXT NOT NULL, brief TEXT NOT NULL, plan_block_id TEXT,
                seat TEXT, backend TEXT, model TEXT, effort TEXT, scope_hint TEXT,
                enforce_scope INTEGER NOT NULL DEFAULT 0, verify_cmd TEXT,
                status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 2, child_session_id TEXT,
                started_at INTEGER, ended_at INTEGER, meter_json TEXT,
                PRIMARY KEY(run_id,node_id));
            CREATE TABLE IF NOT EXISTS run_edges (
                run_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                type TEXT NOT NULL, PRIMARY KEY(run_id,from_id,to_id,type));
            CREATE TABLE IF NOT EXISTS run_claims (
                run_id TEXT NOT NULL, path TEXT NOT NULL, node_id TEXT NOT NULL,
                claimed_at INTEGER NOT NULL, released_at INTEGER,
                PRIMARY KEY(run_id,path,node_id));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_run_claims_live ON run_claims(run_id,path)
                WHERE released_at IS NULL;
        "#,
        )?;
        let mut stmt = conn.prepare("PRAGMA table_info(sessions)")?;
        let columns = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !columns.iter().any(|c| c == "effort") {
            conn.execute("ALTER TABLE sessions ADD COLUMN effort TEXT", [])?;
        }
        Ok(())
    }

    /// v2 → v3: repair the stamp collision with the older cockpit lineage.
    /// Its version 2 had neither sessions.effort nor the native run tables.
    /// Reusing the additive, idempotent step preserves all existing history
    /// and is also safe for databases that already received our version 2.
    fn migrate_v3(conn: &Connection) -> rusqlite::Result<()> {
        Self::migrate_v2(conn)?;
        // Verify before the caller writes version 3, including on a partial
        // legacy schema whose unrelated required columns are still missing.
        Self::verify_schema(conn)
    }

    /// v0 → v1: the whole schema as of this build.
    ///
    /// This is the pre-versioning migration, moved wholesale and now run
    /// **once** instead of on every launch. It is written to be idempotent
    /// (`IF NOT EXISTS` everywhere, `ALTER TABLE` results discarded), which is
    /// what makes it correct both as "create a fresh database" and as "bring a
    /// legacy one up to date" — the two paths therefore cannot diverge, which
    /// is the usual failure of hand-transcribing a fresh-install schema
    /// alongside a migration chain.
    ///
    /// Do not edit this to add new columns. Add a v2 step.
    fn migrate_v1(conn: &Connection) -> rusqlite::Result<()> {
        // The fast path's only observable claim is "this did not run", so it
        // needs something to observe. Counted in test builds only.
        #[cfg(test)]
        MIGRATION_STEPS_RUN.with(|c| c.set(c.get() + 1));
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                project_name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'in_review'
            );

            CREATE TABLE IF NOT EXISTS revisions (
                session_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                received_at INTEGER NOT NULL,
                raw_plan_markdown TEXT NOT NULL,
                PRIMARY KEY (session_id, version_number),
                FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS comments (
                id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                type TEXT NOT NULL,
                scope TEXT,
                anchor_id TEXT NOT NULL,
                body TEXT NOT NULL,
                edit_original TEXT,
                edit_revised TEXT,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                PRIMARY KEY (session_id, id),
                FOREIGN KEY (session_id, version_number)
                    REFERENCES revisions(session_id, version_number) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS thread_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                comment_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_thread_messages
                ON thread_messages (session_id, comment_id, created_at);

            -- Browser browse-agent discussion threads. Scoped to a per-tab
            -- `browse_id` (frontend-persisted UUID), independent of any plan
            -- session. `browse_threads` holds the agent's resumable claude
            -- session id so a tab's follow-ups resume rather than re-spawn.
            CREATE TABLE IF NOT EXISTS browse_messages (
                id TEXT PRIMARY KEY,
                browse_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_browse_messages
                ON browse_messages (browse_id, created_at);

            CREATE TABLE IF NOT EXISTS browse_threads (
                browse_id TEXT PRIMARY KEY,
                claude_session_id TEXT
            );

            -- A tab's working list: the punch list a user builds while looking
            -- at their own dev server. Keyed on `browse_id`, the same durable
            -- per-tab key as the discussion above, so the list reattaches to
            -- its tab exactly the way the conversation does — across a reload,
            -- a surface round-trip, and the recreated native webview.
            --
            -- `template` is a frontend id (see src/lib/browseList.ts), not a
            -- schema: adding a template must never require a migration, and an
            -- unknown string falls back rather than stranding the row.
            CREATE TABLE IF NOT EXISTS browse_lists (
                browse_id  TEXT PRIMARY KEY,
                template   TEXT NOT NULL,
                title      TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            -- `page_url` / `page_title` are the page the item was written ON,
            -- captured at add time. The list row's own title records where the
            -- LIST was started, which answers the wrong question: a walkthrough
            -- crosses many screens, and "line spacing is off" is unactionable
            -- without the one it was seen on. Nullable — rows written before
            -- this existed have no page, and a capture can fail.
            --
            -- `locator` is the resolved pointer to the component the note is
            -- about ("Search bar"): written deterministically from the element
            -- the user highlighted, then refined in the background by the
            -- `browse_locator` seat. Null is the ordinary case (no highlight).
            CREATE TABLE IF NOT EXISTS browse_list_items (
                id         TEXT PRIMARY KEY,
                browse_id  TEXT NOT NULL,
                kind       TEXT NOT NULL,
                body       TEXT NOT NULL,
                done       INTEGER NOT NULL DEFAULT 0,
                sort_idx   INTEGER NOT NULL,
                page_url   TEXT,
                page_title TEXT,
                locator    TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_browse_list_items
                ON browse_list_items (browse_id, sort_idx);

            -- The voice agent's per-plan memory: the forked `claude` session id
            -- that holds the spoken discussion, keyed by the plan's session id.
            -- Re-entering voice mode resumes the same conversation, and it
            -- survives app restarts. The live process is disposable; this row
            -- is the memory. See src-tauri/src/voice.rs.
            CREATE TABLE IF NOT EXISTS voice_sessions (
                session_id TEXT PRIMARY KEY,
                fork_session_id TEXT NOT NULL
            );

            -- The *visible* half of that memory: the discussion panel's
            -- transcript. `voice_sessions` above keeps the agent's recollection
            -- across restarts; without this table the screen did not match it —
            -- the panel held its lines in component state, so an incoming plan,
            -- a session switch, or a relaunch wiped the thread the user was
            -- reading. Keyed by the same voice key `voice.rs` uses (a plan
            -- session id, or `drafter:<draft_id>`). Written from Rust so a
            -- reply lands even while the panel is unmounted.
            CREATE TABLE IF NOT EXISTS voice_messages (
                id TEXT PRIMARY KEY,
                session_key TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_voice_messages
                ON voice_messages (session_key, created_at);

            -- Offered (not yet written) plan action items. The voice agent
            -- stages one mid-turn when it proposes a concrete change; the panel
            -- renders it as a `＋ Add as item` chip under the reply it came
            -- from, and only the user's tap creates the real comment. Nothing
            -- here is visible on the plan. `message_id` is filled in once the
            -- reply is persisted (see `bind_comment_offers`) — the offer's curl
            -- necessarily precedes its own turn's `result` line.
            CREATE TABLE IF NOT EXISTS comment_offers (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                message_id TEXT,
                block_id TEXT NOT NULL,
                body TEXT NOT NULL,
                label TEXT,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_comment_offers
                ON comment_offers (session_id, status, created_at);

            -- Research Missions: an orchestrator that holds one shared goal
            -- across the whole browser pane, a tier above the per-tab browse
            -- agents. The orchestrator's resumable claude session id lives on
            -- the row, so re-opening a mission resumes its conversation.
            -- `mission_findings` are the user's pins (curated findings pulled
            -- from any tab); `mission_messages` are the orchestrator chat turns
            -- (terminal rows, mirroring browse_messages). See mission.rs.
            CREATE TABLE IF NOT EXISTS missions (
                mission_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                goal TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT,
                tabs_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS mission_findings (
                id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                browse_id TEXT,
                source_url TEXT,
                source_title TEXT,
                body TEXT NOT NULL,
                note TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mission_findings
                ON mission_findings (mission_id, created_at);

            CREATE TABLE IF NOT EXISTS mission_messages (
                id TEXT PRIMARY KEY,
                mission_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mission_messages
                ON mission_messages (mission_id, created_at);

            -- Linked discussions: ONE continuous conversation that follows the
            -- user across every browser tab (no goal, unlike a mission). The
            -- resumable `claude` session id lives on the row; `linked_messages`
            -- are the chat turns (terminal rows, mirroring mission_messages) and
            -- carry a per-turn tab tag (which tab the user was on). Consults into
            -- a tab's context reuse that tab's own browse thread. See linked.rs.
            CREATE TABLE IF NOT EXISTS linked_sessions (
                linked_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT,
                tabs_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS linked_messages (
                id TEXT PRIMARY KEY,
                linked_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                tab_browse_id TEXT,
                tab_n INTEGER,
                tab_title TEXT,
                tab_url TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_linked_messages
                ON linked_messages (linked_id, created_at);

            -- Tandem agent mode: per-source thumbs the user gives on the sources
            -- the browse agent surfaces. One row per (browse_id, source_url); a
            -- re-click updates `verdict` (+1 up / -1 down) and `updated_at`.
            -- `domain` is derived from the url so learning can aggregate by host.
            CREATE TABLE IF NOT EXISTS source_feedback (
                id TEXT PRIMARY KEY,
                browse_id TEXT NOT NULL,
                source_url TEXT NOT NULL,
                source_title TEXT,
                domain TEXT NOT NULL,
                verdict INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE (browse_id, source_url)
            );

            CREATE INDEX IF NOT EXISTS idx_source_feedback_domain
                ON source_feedback (domain);

            -- Code Review surface: the diff-review analog of plan sessions.
            -- Parallel tables (NOT the plan-review `comments` contract, which
            -- is byte-frozen): honest line-anchor columns plus `quoted_text`,
            -- the durable content anchor that re-locates across review rounds.
            CREATE TABLE IF NOT EXISTS review_sessions (
                review_id TEXT PRIMARY KEY,
                repo_path TEXT NOT NULL,
                source TEXT NOT NULL,
                base_ref TEXT,
                commit_sha TEXT,
                terminal_id TEXT,
                round INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS review_annotations (
                id TEXT NOT NULL,
                review_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                suggestion_replacement TEXT,
                quoted_text TEXT NOT NULL,
                status TEXT NOT NULL,
                resolution TEXT,
                created_at INTEGER NOT NULL,
                fork_session_id TEXT,
                scope TEXT NOT NULL DEFAULT 'line',
                label TEXT,
                blocking TEXT,
                source TEXT NOT NULL DEFAULT 'user',
                PRIMARY KEY (review_id, id)
            );

            CREATE INDEX IF NOT EXISTS idx_review_annotations
                ON review_annotations (review_id, file_path, start_line);

            CREATE TABLE IF NOT EXISTS review_viewed (
                review_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                viewed_at INTEGER NOT NULL,
                PRIMARY KEY (review_id, file_path)
            );

            CREATE TABLE IF NOT EXISTS review_questions (
                id TEXT NOT NULL,
                review_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                side TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                quoted_text TEXT NOT NULL,
                fork_session_id TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (review_id, id)
            );

            -- Commit-and-push actions taken from the review pane, one row per
            -- push. The latest row per review is reported to the waiting agent
            -- as the feedback payload's PUSHED: block.
            CREATE TABLE IF NOT EXISTS review_pushes (
                id TEXT PRIMARY KEY,
                review_id TEXT,
                repo_path TEXT NOT NULL,
                remote TEXT NOT NULL,
                branch TEXT NOT NULL,
                commit_sha TEXT,
                pr_url TEXT,
                pr_number INTEGER,
                files INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            -- Companion passive awareness: an append-only journal of meaningful
            -- app activity (surface switches, revisions, verdicts, navs, pins,
            -- launches, agent turns). NOT part of the tamper-evident record —
            -- a bounded working set (pruned on insert) the Companion reads as
            -- its "while you were away" delta.
            CREATE TABLE IF NOT EXISTS context_journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                surface_kind TEXT,
                surface_id TEXT,
                label TEXT,
                detail TEXT
            );

            -- Companion (global cross-surface discussion agent): the spanning
            -- conversation's resumable claude session id + per-turn surface
            -- tags, mirroring linked_sessions/linked_messages. last_journal_seq
            -- is the high-water mark of journal rows already folded into the
            -- conversation.
            CREATE TABLE IF NOT EXISTS companion_sessions (
                companion_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                claude_session_id TEXT,
                last_journal_seq INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                -- Per-conversation seat override: a chat can sit on a bigger
                -- model than the `companion` seat's default without moving the
                -- seat. NULL on both = the seat's own flags, unchanged.
                model TEXT,
                effort TEXT,
                -- Completed assistant turns as of this thread's last CLI-session
                -- rotation. A COLUMN rather than an app_settings key on purpose:
                -- chats are not a singleton, and a per-thread mark that dies with
                -- its row can never be inherited by a recreated thread (the bug
                -- memchat's `memchat_clear` has to clear by hand).
                rotated_at_turns INTEGER NOT NULL DEFAULT 0,
                -- A user rename from the Chats dropdown wins permanently: the
                -- auto-titling pass must never overwrite a name they chose.
                title_is_user_set INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS companion_messages (
                id TEXT PRIMARY KEY,
                companion_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                surface_kind TEXT,
                surface_id TEXT,
                surface_label TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_companion_messages
                ON companion_messages (companion_id, created_at);

            -- Prompt Drafter durable identity, and as of the Bookshelf the
            -- **primary storage** for the document itself. `doc_json` is the
            -- TipTap fidelity source (it used to live in localStorage, where a
            -- cache clear wiped it); `doc_markdown` stays exactly what it was —
            -- the derived, agent-readable mirror behind /v1/drafter/:id/doc.
            -- Alongside: the draft's discussion thread, comment sidecar, queued
            -- agent suggestions, and its attached sources.
            CREATE TABLE IF NOT EXISTS drafts (
                draft_id TEXT PRIMARY KEY,
                title TEXT,
                project_path TEXT,
                doc_markdown TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            -- The shelf's folder tree, as an **adjacency list**: move and rename
            -- are a single row update, where materialized paths would be
            -- O(subtree) for no gain at this size. Building the tree from
            -- adjacency is the house pattern (ClassMemoryPane's buildTree,
            -- lib/reviewTree.ts). A move must walk parents first — reparenting a
            -- folder into its own subtree is rejected (`would_cycle`).
            CREATE TABLE IF NOT EXISTS bookshelf_folders (
                folder_id TEXT PRIMARY KEY,
                parent_id TEXT,                 -- NULL = shelf root
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_bookshelf_folders_parent
                ON bookshelf_folders (parent_id, name);

            -- Sources attach to a DOCUMENT, never to a folder. Folders hold
            -- documents only: a dropped PDF attaches *to* the document it
            -- informs, so every shelf item stays reviewable, agent-attached and
            -- launch-into-plan. Allowing loose files would forfeit all three.
            CREATE TABLE IF NOT EXISTS draft_sources (
                id TEXT PRIMARY KEY,
                draft_id TEXT NOT NULL,
                kind TEXT NOT NULL,      -- browse_event | mission_finding | url | file | digest
                ref_id TEXT,             -- browse_events rowid / mission_findings id
                url TEXT, title TEXT, excerpt TEXT,
                file_path TEXT,          -- relative to <app_data_dir>/bookshelf/<draft_id>/
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_draft_sources
                ON draft_sources (draft_id, created_at);

            -- The app's own failures. Each of these was already *computed* at
            -- runtime and thrown away — no row, no counter, and the tracing
            -- subscriber writes to stderr, which goes nowhere when Redline is
            -- launched from /Applications. This is TELEMETRY, deliberately NOT
            -- hash-chained into the ledger: the ledger records decisions, and a
            -- stall-kill is not a decision. Local-only (docs/local-only-audit).
            CREATE TABLE IF NOT EXISTS friction_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                surface TEXT, session_id TEXT, detail TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_friction_events
                ON friction_events (kind, ts);

            -- What the Shipwright found, and what you did with it. The plan
            -- mines your corrections of the agent, so it must also record your
            -- corrections of IT — that is what makes run five smarter than run
            -- one. Dedupe follows class_observations exactly: on
            -- (category, summary) REGARDLESS of `dismissed`, so a dismissed
            -- finding never resurfaces under the same wording.
            --
            -- `shipped` is DETECTED, not self-declared: a later commit touching
            -- a file this finding's `files` array named flips it. Self-declared
            -- success is the one number an agent will always report favourably.
            CREATE TABLE IF NOT EXISTS shipwright_findings (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                category TEXT NOT NULL,
                summary TEXT NOT NULL,          -- dedupe key with category
                evidence TEXT, proposal TEXT, guard TEXT,
                files TEXT,                     -- JSON array; shipped-detection reads this
                status TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted|dismissed|shipped
                dismissed INTEGER NOT NULL DEFAULT 0,
                draft_id TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_shipwright_dedupe
                ON shipwright_findings (category, summary);

            CREATE TABLE IF NOT EXISTS draft_chat_threads (
                draft_id TEXT PRIMARY KEY,
                claude_session_id TEXT,
                last_doc_hash TEXT
            );

            CREATE TABLE IF NOT EXISTS draft_chat_messages (
                id TEXT PRIMARY KEY,
                draft_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_draft_chat_messages
                ON draft_chat_messages (draft_id, created_at);

            -- The Memory surface's Ask thread (Second Brain P4). One global
            -- conversation over the lake + catalog, keyed by a constant thread
            -- id ("memchat") so the schema stays multi-thread-ready without
            -- the GUI having to manage thread identity. `last_seq` is the
            -- ledger high-water mark the agent last saw — the memchat analog
            -- of draft_chat's doc hash (the record grows between turns).
            CREATE TABLE IF NOT EXISTS mem_chat_threads (
                thread_id TEXT PRIMARY KEY,
                claude_session_id TEXT,
                last_seq INTEGER
            );

            CREATE TABLE IF NOT EXISTS mem_chat_messages (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                role TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_mem_chat_messages
                ON mem_chat_messages (thread_id, created_at);

            CREATE TABLE IF NOT EXISTS draft_comments (
                id TEXT PRIMARY KEY,
                draft_id TEXT NOT NULL,
                block_id TEXT,
                sel_char_start INTEGER,
                sel_char_end INTEGER,
                sel_quoted_text TEXT,
                body TEXT NOT NULL,
                author TEXT,
                created_at INTEGER NOT NULL,
                fork_session_id TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_draft_comments
                ON draft_comments (draft_id, created_at);

            -- Agent write-suggestions against a draft, queued so a proposal
            -- made while the drafter pane is closed is drained on mount rather
            -- than dropped. status: pending | applied | rejected.
            CREATE TABLE IF NOT EXISTS draft_suggestions (
                id TEXT PRIMARY KEY,
                draft_id TEXT NOT NULL,
                op TEXT NOT NULL,
                block_id TEXT,
                original TEXT,
                markdown TEXT NOT NULL,
                agent_id TEXT,
                body TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_draft_suggestions
                ON draft_suggestions (draft_id, status, created_at);

            -- The agent shelf (harness program A2): user-authored agents as
            -- ROWS, never skills — each is a plain-English instruction composed
            -- into a live prompt at run time (compose.rs) and run against the
            -- open Drafter document, its output landing through the tracked-
            -- suggestion contract above. Modeled on drafts + is_template
            -- (named, foldered, starrable, duplicable), minus "instantiate as
            -- a new doc", plus "run against the open doc". Spawn config comes
            -- from the `harness` template seat, or a per-agent
            -- `custom:<agent_id>` seat row (seat.rs).
            CREATE TABLE IF NOT EXISTS harness_agents (
                agent_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                instruction TEXT NOT NULL,
                folder_id TEXT,
                starred INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_run_at INTEGER,
                run_count INTEGER NOT NULL DEFAULT 0
            );

            -- Review Request registry: one row per minted share link. Durable
            -- (replaces the per-webview localStorage list) and joinable with
            -- the comments a return produces (comments.share_request_id).
            CREATE TABLE IF NOT EXISTS shares (
                request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                reviewer_name TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                base_version INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_shares_session ON shares (session_id);

            -- One row per imported return. landed_version is the revision the
            -- comments actually re-anchored onto at import time (the CURRENT
            -- revision then) — navigation must target it, not base_version.
            CREATE TABLE IF NOT EXISTS share_returns (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                reviewer_name TEXT NOT NULL,
                imported_at INTEGER NOT NULL,
                landed_version INTEGER NOT NULL,
                placed INTEGER NOT NULL,
                orphans INTEGER NOT NULL,
                comment_ids TEXT NOT NULL DEFAULT '[]'
            );

            CREATE INDEX IF NOT EXISTS idx_share_returns_session
                ON share_returns (session_id, imported_at);

            -- Localhost dashboard: one row per dev server we have ever seen
            -- listening out of a known project. The key is (project_path, port)
            -- — "the same server" as a card. Keying on the run command instead
            -- would fragment the row every time a lockfile churn changed the
            -- package manager; keying on the project alone would merge a repo's
            -- web and api servers into one card.
            CREATE TABLE IF NOT EXISTS dev_servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                project_name TEXT NOT NULL,
                port INTEGER NOT NULL,
                url TEXT NOT NULL,
                stack TEXT NOT NULL DEFAULT '',
                run_command TEXT NOT NULL DEFAULT '',
                last_pid INTEGER,
                last_args TEXT,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                thumb_path TEXT,
                UNIQUE (project_path, port)
            );

            CREATE INDEX IF NOT EXISTS idx_dev_servers_seen
                ON dev_servers (last_seen_at DESC);
            "#,
        )?;
        // Best-effort additive migrations (errors on existing columns are ignored)
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_body TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_version INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN resolution_accepted_at INTEGER",
            [],
        );
        // A mission's saved tab workspace (JSON `[{id,url,title,browseId}]`), so
        // re-entering a mission reopens its exact tabs with their discussions.
        let _ = conn.execute("ALTER TABLE missions ADD COLUMN tabs_json TEXT", []);
        // Chat (the Companion's unbound room): the per-conversation model/effort
        // override, the per-thread rotation mark, and the user-rename latch.
        let _ = conn.execute("ALTER TABLE companion_sessions ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE companion_sessions ADD COLUMN effort TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE companion_sessions ADD COLUMN rotated_at_turns INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE companion_sessions ADD COLUMN title_is_user_set INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Review-annotation discussion forks (P3.5) — for review_annotations
        // tables created before the column landed on this branch.
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN fork_session_id TEXT",
            [],
        );
        // Parity sprint: annotation scope (line|file|general), conventional
        // labels + blocking decoration, and the authoring source (user|ai|tool).
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN scope TEXT NOT NULL DEFAULT 'line'",
            [],
        );
        let _ = conn.execute("ALTER TABLE review_annotations ADD COLUMN label TEXT", []);
        let _ = conn.execute("ALTER TABLE review_annotations ADD COLUMN blocking TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE review_annotations ADD COLUMN source TEXT NOT NULL DEFAULT 'user'",
            [],
        );

        // Per-item page + component pointer (see the table comment above). Three
        // nullable adds, so an existing list keeps every item and simply reports
        // "no page recorded" for the ones written before Redline was capturing
        // one — an item the panel can't place is still an item it must draw.
        let _ = conn.execute("ALTER TABLE browse_list_items ADD COLUMN page_url TEXT", []);
        let _ = conn.execute("ALTER TABLE browse_list_items ADD COLUMN page_title TEXT", []);
        let _ = conn.execute("ALTER TABLE browse_list_items ADD COLUMN locator TEXT", []);

        // Pictures of Redline's OWN surfaces, keyed by the ledger event they
        // record. Its own table rather than a column, because these hang off
        // events that carry no `browse_events` row (an approval, a revision).
        //
        // `theme` is stamped at capture: a shot taken under a theme the user has
        // since changed can then be LABELLED as historical instead of silently
        // looking like a rendering bug. That is the mitigation for the one real
        // objection to shooting our own surfaces — they age badly.
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS surface_shots (
                seq INTEGER PRIMARY KEY,
                surface TEXT NOT NULL,
                shot_key TEXT NOT NULL,
                theme TEXT,
                created_at INTEGER NOT NULL
            )",
            [],
        );

        // Convert-to-Linked provenance: a linked discussion created FROM a
        // per-tab browse chat records where it came from. `fork_from_session_id`
        // is consumed by the first turn (`--resume <sid> --fork-session`) and
        // only read while `claude_session_id` is still NULL, so a failed first
        // turn re-forks safely.
        let _ = conn.execute(
            "ALTER TABLE linked_sessions ADD COLUMN converted_from_browse_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE linked_sessions ADD COLUMN converted_origin TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE linked_sessions ADD COLUMN fork_from_session_id TEXT",
            [],
        );

        // Migration: comment ids are session-scoped (`c-001` restarts per
        // session), but legacy databases declared `id TEXT PRIMARY KEY`
        // (globally unique), which made every new session fail with
        // "UNIQUE constraint failed: comments.id" on its first comment.
        // Rebuild the table with a composite primary key `(session_id, id)`.
        // The additive ALTERs above run first, so the legacy table is
        // guaranteed to have all 14 columns before we copy.
        let legacy_pk: bool = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|sql| sql.contains("id TEXT PRIMARY KEY"))
            .unwrap_or(false);
        if legacy_pk {
            conn.execute_batch(
                r#"
                BEGIN;
                CREATE TABLE comments_new (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    scope TEXT,
                    anchor_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    edit_original TEXT,
                    edit_revised TEXT,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    resolution_body TEXT,
                    resolution_version INTEGER,
                    resolution_accepted_at INTEGER,
                    PRIMARY KEY (session_id, id),
                    FOREIGN KEY (session_id, version_number)
                        REFERENCES revisions(session_id, version_number) ON DELETE CASCADE
                );
                INSERT INTO comments_new (
                    id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at
                )
                SELECT
                    id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at
                FROM comments;
                DROP TABLE comments;
                ALTER TABLE comments_new RENAME TO comments;
                COMMIT;
                "#,
            )?;
        }
        // Stable block identity for editor-originated comments (Milestone C).
        // Added after the legacy rebuild so both fresh and rebuilt `comments`
        // tables gain it; idempotent (error on existing column ignored).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN block_id TEXT", []);
        // Whole-block structural payload, JSON-encoded (Milestone D).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN structural_json TEXT", []);
        // Review-thread boundary. Legacy rows default to 1 (thread start) so an
        // upgraded DB renders prior plans clean rather than as spurious redline.
        let _ = conn.execute(
            "ALTER TABLE revisions ADD COLUMN thread_start INTEGER NOT NULL DEFAULT 1",
            [],
        );
        // Restore marker. Legacy rows default to 0 (not a restore) so an
        // upgraded DB renders exactly as before.
        let _ = conn.execute(
            "ALTER TABLE revisions ADD COLUMN restored INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Selection-anchor columns for the Word-style comment-highlight
        // feature (Part B). All three are NULL for pre-feature rows so the
        // editor simply skips painting a highlight — the comment still
        // appears in the sidebar with its block anchor.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_char_start INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_char_end INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_quoted_text TEXT",
            [],
        );
        // Fork-agent discussion threads (Phase 2): the Claude Code session id
        // of the comment's forked discussion, NULL until its first "Discuss"
        // turn. Added in the post-rebuild ALTER group so a rebuilt `comments`
        // table gains it too — the legacy rebuild's explicit-column
        // `INSERT … SELECT` runs earlier and would otherwise drop it.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN fork_session_id TEXT",
            [],
        );
        // Which harness owns that fork id — `claude-code` | `codex`. NULL on
        // every row written before plan sessions could run on Codex, which
        // reads as `claude-code` because Claude was then the only
        // implementation. Load-bearing rather than descriptive: the two id
        // spaces are both UUIDs and neither CLI errors on the other's id
        // (`claude --resume <codex thread>` silently starts a FRESH session),
        // so the id alone cannot say which binary can resume it.
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN fork_backend TEXT", []);
        // Sub-block-grained selection anchor (e.g. `blk-X.s3.w2-w4`). NULL
        // for pre-feature rows and for any selection that doesn't land on a
        // clean word / line / sentence boundary — the comment still has
        // `sel_char_start` / `sel_char_end` as its primary anchor, and the
        // resolver tiers through this id first when present.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN sel_sub_block_id TEXT",
            [],
        );
        // Reopen continuity: the reviewer's pending follow-up note attached on
        // reopen, and a JSON array of archived prior reopen rounds. Both NULL/
        // empty for pre-feature rows. Post-rebuild ALTER group, same reasoning
        // as `fork_session_id` above.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN reopen_note TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN reopen_history TEXT",
            [],
        );
        // A [question] the reviewer promoted into a plan-driving directive.
        // 0/NULL for every pre-feature row and every non-promoted comment.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // Agent-in-doc (M4): the agent id that proposed the comment (NULL for
        // every user-originated comment) and the in-place resolution of a
        // still-draft agent suggestion ("accepted"). Post-rebuild ALTER group,
        // same reasoning as `fork_session_id` above.
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN author TEXT", []);
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN agent_state TEXT", []);
        // Live-collab / Review Request attribution: the human reviewer a
        // comment came from ("John Doe"). NULL for every owner-originated
        // comment and every pre-collab row. Distinct from `author` (agent id).
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN reviewer TEXT", []);
        // Review Request return provenance: when the external reviewer wrote
        // the comment (their clock) and which share (request_id) it arrived
        // on. NULL for every owner-originated comment and every legacy row.
        let _ = conn.execute(
            "ALTER TABLE comments ADD COLUMN external_created_at INTEGER",
            [],
        );
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN share_request_id TEXT", []);
        // Files the reviewer attached to a comment: JSON `[{path, name, mime,
        // bytes}]`, same additive shape as `reopen_history`. The column holds
        // METADATA only — the files themselves live under
        // `<app_data_dir>/attachments/<session_id>/`. NULL for every comment
        // without one.
        let _ = conn.execute("ALTER TABLE comments ADD COLUMN attachments TEXT", []);
        // The same, per sidecar-discussion turn: a reviewer can drop an image
        // into a follow-up inside a comment's Discuss thread.
        let _ = conn.execute(
            "ALTER TABLE thread_messages ADD COLUMN attachments TEXT",
            [],
        );
        // Persisted attach state: lets detachment survive app restarts and be
        // visible for background sessions (the live `held` flag is recomputed
        // from in-memory senders and tells nothing after a crash).
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN attach_state TEXT NOT NULL DEFAULT 'idle'",
            [],
        );
        // Last-activity timestamp: the sidebar orders sessions by it. Bumped
        // on every revision/comment/thread message/status change. Legacy rows
        // (updated_at = 0) are backfilled from their latest revision — the
        // best recency proxy already on disk. Both statements are idempotent.
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "UPDATE sessions SET updated_at = MAX(
                created_at,
                COALESCE((SELECT MAX(received_at) FROM revisions r
                          WHERE r.session_id = sessions.session_id), created_at)
             ) WHERE updated_at = 0",
            [],
        );
        // Bookshelf: the document's fidelity source moves off localStorage and
        // into the DB, and every document gains a shelf location. Both additive,
        // both nullable — an existing draft keeps its markdown mirror and is
        // backfilled with its TipTap JSON by the one-time frontend migration
        // (only the webview can read localStorage).
        let _ = conn.execute("ALTER TABLE drafts ADD COLUMN doc_json TEXT", []);
        let _ = conn.execute("ALTER TABLE drafts ADD COLUMN folder_id TEXT", []);
        // Templates + the documents dropdown. A template is an ordinary shelf
        // document carrying a flag — it keeps folders, sources, the editor and
        // the launch path for free. `open_count`/`last_opened_at` feed the
        // dropdown's FREQUENT section; bumped once per open, never per
        // keystroke, and deliberately independent of `updated_at` (which means
        // "content changed" and orders the shelf).
        let _ = conn.execute(
            "ALTER TABLE drafts ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE drafts ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute("ALTER TABLE drafts ADD COLUMN last_opened_at INTEGER", []);
        // Whether the title was *pinned* by a rename or is still derived from
        // the markdown's first heading. Derived-vs-pinned is a property of the
        // row, not of the call site: five separate writers mirror the document
        // and every one of them re-derives a title and passes it, so a call-site
        // contract ("pass None to keep the name") loses to entropy — `voice.rs`
        // proved it by hand-rolling the same preservation for `project_path`
        // and not generalizing it. With the flag here, `upsert_draft` keeps a
        // renamed title no matter who writes, and zero call sites change.
        if conn
            .execute(
                "ALTER TABLE drafts ADD COLUMN title_is_user_set INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .is_ok()
        {
            // Backfill, once: a stored title that does *not* match what the
            // body would derive can only have come from a rename. Without this
            // every rename made before the flag shipped stays broken. A false
            // positive costs only auto-follow, so the comparison errs safe.
            let pinned: Vec<String> = conn
                .prepare("SELECT draft_id, title, doc_markdown FROM drafts WHERE title IS NOT NULL")
                .and_then(|mut st| {
                    st.query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })
                    .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                })
                .map(|rows| {
                    rows.into_iter()
                        .filter(|(_, title, md)| {
                            crate::draft_title_from_markdown(md).as_deref() != Some(title.as_str())
                        })
                        .map(|(id, _, _)| id)
                        .collect()
                })
                .unwrap_or_default();
            for id in pinned {
                let _ = conn.execute(
                    "UPDATE drafts SET title_is_user_set = 1 WHERE draft_id = ?1",
                    params![id],
                );
            }
        }
        // Run lifecycle (orchestrated executions): the run-state machine rides
        // in nullable columns beside the frozen three-value `status`, so
        // reconciliation and the liveness watchdog never see it. Only
        // orchestrated runs populate it — a plain Approve leaves both NULL.
        // Values: orchestrating | running | awaiting_review (the run finished
        // its work and parked for the human's morning review — NOT live, no
        // watcher; transition wiring is a later unit) | in_code_review |
        // landed | stalled | abandoned (a stand-down; terminal). NULL = no
        // run (a plain Approve, or a reset after a failed handoff).
        // Which harness authored the plan, and at what model. `redline_provider`
        // has ridden the normalized Codex payload since the receive side was
        // built, but nothing ever read it. Not cosmetic: RESTORE branches on
        // the backend, because `claude --resume` handed a Codex thread id
        // fails into a *fresh* session rather than an error.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN backend TEXT", []);
        // The PTY plan session's arm of the token meter. `transcript_path` is
        // stamped from the hook payload (the ONE authoritative source — a
        // `--resume` is scoped by the STARTUP cwd, so the path cannot be
        // derived from the working directory); `meter_json` is the tailer's
        // running read of what that session has spent, so the numbers survive
        // a relaunch instead of restarting at zero.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN transcript_path TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN meter_json TEXT", []);
        // Per-message provenance + economics (Phase 3). ONE json column per
        // message table rather than eight numeric ones: forward-compatible
        // (a new meter field needs no migration) and cheap. Without it the
        // model badge and the footer vanish the moment a turn settles — which
        // is the state the user looks at most.
        for table in [
            "browse_messages",
            "linked_messages",
            "mission_messages",
            "companion_messages",
            "mem_chat_messages",
            "draft_chat_messages",
            "thread_messages",
            "voice_messages",
        ] {
            let _ = conn.execute(&format!("ALTER TABLE {table} ADD COLUMN meter_json TEXT"), []);
        }
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN model TEXT", []);
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN run_state TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN run_updated_at INTEGER",
            [],
        );
        // The run's durable record: the orchestrator's exit report (claims),
        // the workflow script path, and the human resolution. One row per
        // plan session — a re-run overwrites the report, the resolution is a
        // later human act.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS plan_runs (
                plan_session_id TEXT PRIMARY KEY,
                report_json TEXT NOT NULL,
                script_path TEXT,
                workflow_ran INTEGER NOT NULL DEFAULT 0,
                resolution TEXT,
                resolution_note TEXT,
                resolved_at INTEGER,
                created_at INTEGER NOT NULL
            );
            "#,
        )?;
        // The live-monitor anchor, written at the ingest-claim beacon — the one
        // moment the orchestrator's transcript path is in hand. Separate from
        // `plan_runs` deliberately: that row exists only from exit-report time
        // and its upsert resets every column. The discovery columns (run_id,
        // transcript_dir, script_path, mode) start NULL and are backfilled by
        // the run watcher as the artifacts appear on disk.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS orchestrations (
                plan_session_id  TEXT PRIMARY KEY,
                claude_session_id TEXT NOT NULL,
                transcript_path  TEXT NOT NULL,
                cwd              TEXT,
                started_at       INTEGER NOT NULL,
                run_id           TEXT,
                transcript_dir   TEXT,
                script_path      TEXT,
                mode             TEXT
            );
            "#,
        )?;
        // The dock terminal tab the run was launched into — captured at launch
        // (stashed in `LaunchedTerminals`, folded in at the ingest claim), so
        // "stand down" can name the tab to close and a retry can reuse the tab
        // the user is already looking at. Best-effort additive migration.
        let _ = conn.execute(
            "ALTER TABLE orchestrations ADD COLUMN terminal_id TEXT",
            [],
        );
        // The work graph (`work.rs` state plane): durable work items and the
        // typed edges between them.
        //
        // SCHEMA LAW — provenance, not ownership: `origin_kind`/`origin_id`
        // are TEXT breadcrumbs recording where an item came from (a plan run,
        // a session, an orchestration, an agent's discovery mid-run, …). They
        // are deliberately NOT foreign keys to `plan_runs`, `sessions`,
        // `orchestrations`, or any other table — deleting the origin row must
        // leave the item standing, exactly as the ledger references rows it
        // describes without owning them. Likewise `project_path` is a
        // filterable facet, never an owner: nullable, no FK, and nothing may
        // cascade through it. Do NOT "fix" this in a later migration by
        // adding FKs, and never add `branch` / `worktree_path` / `attempts`
        // columns here — those are execution-engine state and are banned from
        // this row: an item describes WHAT is to be done and its lifecycle,
        // never HOW an engine is currently executing it.
        //
        // `id` is hash-based and hierarchical: roots mint `rl-xxxx` (hex from
        // a content hash, lengthened on collision), children append `.N`
        // ordinals (`rl-xxxx.3`). status: open|claimed|closed|held. kind:
        // task|bug|question|message. priority is P0-style: 0 = drop
        // everything, larger = calmer; default 2 = normal.
        //
        // `work_edges.type`: blocks | parent-child | discovered-from |
        // relates-to | duplicates | supersedes | replies-to. Same law: no FK
        // to any run table, and no FK between items either — an item delete
        // must never cascade into silent edge loss; edge cleanup is an
        // explicit, recordable act (next-wave close semantics own it).
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS work_items (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT,
                status TEXT NOT NULL DEFAULT 'open',
                priority INTEGER NOT NULL DEFAULT 2,
                kind TEXT NOT NULL DEFAULT 'task',
                assignee TEXT,
                claimed_at INTEGER,
                lease_expires_at INTEGER,
                closed_at INTEGER,
                close_reason TEXT,
                defer_until INTEGER,
                origin_kind TEXT,
                origin_id TEXT,
                project_path TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_work_items_status
                ON work_items (status, priority, created_at);
            CREATE INDEX IF NOT EXISTS idx_work_items_project
                ON work_items (project_path);

            CREATE TABLE IF NOT EXISTS work_edges (
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                type TEXT NOT NULL,
                created_by TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (from_id, to_id, type)
            );
            CREATE INDEX IF NOT EXISTS idx_work_edges_to
                ON work_edges (to_id, type);
            "#,
        )?;
        // Seat roster stats (P3): facts about what each agent seat actually
        // did, so they live in the DB — never in the seat config JSON, which
        // records intent (model/effort/charter), not history.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS seat_stats (
                seat TEXT PRIMARY KEY,
                last_run_at INTEGER,
                items_filed INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            "#,
        )?;
        // Per-seat burn (P8): token/spawn counters accumulated per seat per
        // local day. Tokens ONLY — money is a display-time computation
        // elsewhere (prices move; recorded facts don't).
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS seat_burn (
                seat TEXT NOT NULL,
                day TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                spawns INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (seat, day)
            );
            "#,
        )?;
        // One-time data repair, gated on its own marker (T1.2). It runs here,
        // in startup migration, rather than as a maintenance action the user
        // presses: the polluted rows feed automated ranking (Librarian,
        // Shipwright, `build_digest`) on EVERY run, so leaving them in place
        // until somebody remembers to clean up means every ranking in between
        // is wrong.
        Self::repair_superseded_agent_comments(conn)?;
        Ok(())
    }

    /// The `submitted` half of an agent replay, retired.
    ///
    /// Before `add_comment` converged agent-authored duplicates (T1.1), a
    /// replayed agent submission minted a second copy of every finding. The
    /// live record's clearest case is session `5f85766f`: fourteen
    /// `author='voice'` comments sit `submitted` on v4, and the byte-identical
    /// fourteen sit `resolved` on v5, written minutes later after a restored
    /// revision hid the originals from the UI. The v4 rows are answered work
    /// that no longer knows it — pure noise in every open-comment count.
    ///
    /// The repair is deliberately the narrowest thing that fixes it:
    ///
    /// - `withdrawn` already exists in the lifecycle and already drops out of
    ///   open counts, so nothing downstream needs to learn a new state;
    /// - no resolution data is touched, so the answered copy stays the record;
    /// - **agent authors only** — two identical human comments are legitimate
    ///   (verified in the live DB: zero human rows match this predicate);
    /// - the surviving copy must be strictly LATER and actually answered
    ///   (`resolved`/`accepted`), which is what makes the earlier row
    ///   superseded rather than merely similar.
    ///
    /// Exactly-once via the `repair_ghost_comments_v1` marker, so a restart
    /// can't re-withdraw a comment the reviewer deliberately reopened.
    /// (Rotating `VACUUM INTO` backups already cover the escape hatch.)
    fn repair_superseded_agent_comments(conn: &Connection) -> rusqlite::Result<()> {
        const MARKER: &str = "repair_ghost_comments_v1";
        let already: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![MARKER],
                |r| r.get(0),
            )
            .optional()?;
        if already.is_some() {
            return Ok(());
        }

        // One predicate, used for both the log and the update, so what gets
        // reported can never drift from what gets changed.
        const SUPERSEDED: &str = "status = 'submitted'
               AND author IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM comments c2
                    WHERE c2.session_id = comments.session_id
                      AND c2.author = comments.author
                      AND c2.body = comments.body
                      AND c2.id <> comments.id
                      AND c2.status IN ('resolved', 'accepted')
                      AND c2.created_at > comments.created_at
               )";

        let affected = {
            let mut stmt =
                conn.prepare(&format!("SELECT session_id, id FROM comments WHERE {SUPERSEDED}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        let changed = conn.execute(
            &format!("UPDATE comments SET status = 'withdrawn' WHERE {SUPERSEDED}"),
            [],
        )?;
        // A silent data repair is not a repair — name every row that moved.
        for (session_id, id) in &affected {
            tracing::info!(
                session_id = %session_id,
                comment_id = %id,
                "ghost repair: withdrew a superseded agent comment"
            );
        }
        if changed > 0 {
            tracing::info!(count = changed, "ghost repair: done");
        }
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MARKER, changed.to_string()],
        )?;
        Ok(())
    }

    /// Bump a session's last-activity timestamp. Takes the already-locked
    /// connection (the `Mutex` is not reentrant — never call `self.conn.lock()`
    /// here). `MAX` keeps the value monotonic under out-of-order events.
    fn touch_session(conn: &Connection, session_id: &str, at: i64) {
        let _ = conn.execute(
            "UPDATE sessions SET updated_at = MAX(updated_at, ?1) WHERE session_id = ?2",
            params![at, session_id],
        );
    }

    /// Test-only: force a session's `updated_at` back to 0 to simulate a row
    /// written by a pre-`updated_at` build (the migration backfill's target).
    #[cfg(test)]
    pub(crate) fn zero_updated_at(&self, session_id: &str) {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE sessions SET updated_at = 0 WHERE session_id = ?1",
            params![session_id],
        )
        .unwrap();
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn upsert_session(&self, session: &ReviewSession) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO sessions (session_id, project_path, project_name, created_at, status, attach_state, updated_at, backend, model, effort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(session_id) DO UPDATE SET
                project_path = excluded.project_path,
                project_name = excluded.project_name,
                status = excluded.status,
                attach_state = excluded.attach_state,
                updated_at = MAX(sessions.updated_at, excluded.updated_at),
                -- COALESCE, not overwrite: most upserts carry no provenance
                -- (they exist to move `status` or `attach_state`), and letting
                -- one of those blank the backend would send the NEXT restore
                -- down the claude arm with a Codex thread id.
                backend = COALESCE(excluded.backend, sessions.backend),
                model = COALESCE(excluded.model, sessions.model),
                effort = COALESCE(excluded.effort, sessions.effort)",
            params![
                session.session_id,
                session.project_path,
                session.project_name,
                session.created_at,
                session_status_str(session.status),
                session.attach_state.as_str(),
                session.updated_at,
                session.backend,
                session.model,
                session.effort,
            ],
        )?;
        Ok(())
    }

    pub fn insert_revision(
        &self,
        session_id: &str,
        revision: &Revision,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO revisions (session_id, version_number, received_at, raw_plan_markdown, thread_start, restored)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(session_id, version_number) DO UPDATE SET
                received_at = excluded.received_at,
                raw_plan_markdown = excluded.raw_plan_markdown,
                thread_start = excluded.thread_start,
                restored = excluded.restored",
            params![
                session_id,
                revision.version_number,
                revision.received_at,
                revision.raw_plan_markdown,
                revision.thread_start as i64,
                revision.restored as i64,
            ],
        )?;
        Self::touch_session(&conn, session_id, revision.received_at);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Polis ledger (Phase 1): prompt store + hash chain
    // ------------------------------------------------------------------

    // --- the picture store (Phase 7) ---------------------------------------

    /// Every shot key the database still points at — the retention sweep's
    /// ground truth. DB-driven, never caller-driven.
    ///
    /// BOTH stores, because a key missing from this set is deleted: leaving out
    /// `surface_shots` would have made every Redline-surface picture
    /// "unreferenced" and swept on the first pass, which is precisely the
    /// one-writer-erases-another's-files bug this design exists to avoid.
    /// The store, shared — what the owned `PolisHandle` (the router's and the
    /// MCP mount's `MemoryApi`) holds beside the app's own handle.
    pub fn polis_store(&self) -> Arc<PolisStore> {
        Arc::clone(&self.polis)
    }

    /// The pictures of Redline's OWN surfaces for these ledger seqs — the host
    /// half of the Timeline's join (`HostResolver::surface_shot_keys`).
    pub fn surface_shot_keys(&self, seqs: &[i64]) -> rusqlite::Result<Vec<(i64, String)>> {
        if seqs.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock_conn();
        let marks = vec!["?"; seqs.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT seq, shot_key FROM surface_shots WHERE seq IN ({marks})"
        ))?;
        let refs: Vec<&dyn rusqlite::ToSql> = seqs.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect()
    }

    pub fn referenced_shot_keys(&self) -> rusqlite::Result<std::collections::HashSet<String>> {
        let conn = self.lock_conn();
        let mut out = std::collections::HashSet::new();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT shot_key FROM browse_events WHERE shot_key IS NOT NULL
             UNION
             SELECT DISTINCT shot_key FROM surface_shots",
        )?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            out.insert(row?);
        }
        Ok(out)
    }

    /// Record a picture of one of Redline's own surfaces.
    pub fn record_surface_shot(
        &self,
        seq: i64,
        surface: &str,
        shot_key: &str,
        theme: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO surface_shots (seq, surface, shot_key, theme, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(seq) DO UPDATE SET
                shot_key = excluded.shot_key, theme = excluded.theme",
            params![seq, surface, shot_key, theme, crate::ledger::now_millis()],
        )?;
        Ok(())
    }

    /// Surface shots for a page of seqs — one query, joined onto the Timeline.
    /// The batched read; the Timeline joins inline on its own connection.
    #[allow(dead_code)]
    pub fn surface_shots_for_seqs(
        &self,
        seqs: &[i64],
    ) -> rusqlite::Result<std::collections::HashMap<i64, (String, Option<String>)>> {
        if seqs.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.lock_conn();
        let marks = vec!["?"; seqs.len()].join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT seq, shot_key, theme FROM surface_shots WHERE seq IN ({marks})"
        ))?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            seqs.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?),
            ))
        })?;
        rows.collect()
    }

    /// Clearing a surface shot removes its row too.
    pub fn clear_surface_shot(&self, key: &str) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM surface_shots WHERE shot_key = ?1", params![key])
    }

    // --- semantic index (derived; see the `embeddings` DDL) ----------------

    /// Drop every vector. The index is derived, so this is always safe and
    /// always recoverable — the keeper's watch rebuilds it.
    pub fn clear_embeddings(&self) -> rusqlite::Result<usize> {
        let n = self.delete_all_embeddings()?;
        if let Ok(mut guard) = crate::embed::cache().write() {
            *guard = None;
        }
        Ok(n)
    }

    /// `(hits, total)` for the Ask prefetch, over whatever `context_journal`
    /// still holds (it self-prunes at 2,000 rows / 14 days, which is the right
    /// window: this is a "is it working NOW" number, not a lifetime statistic).
    ///
    /// A hit is a turn where the agent was handed a prefetch and made no memory
    /// curl at all. That is the honest A/B for the whole one-turn design, and
    /// it self-reports a planner regression — which is the only way a retrieval
    /// change shows up as anything other than "Ask feels slower again".
    pub fn prefetch_hit_rate(&self) -> rusqlite::Result<(i64, i64)> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT COALESCE(SUM(CASE WHEN label = 'hit' THEN 1 ELSE 0 END), 0), COUNT(*)
             FROM context_journal WHERE kind = 'memchat_prefetch'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    // -----------------------------------------------------------------------
    // Memory-by-session: session tree + context journal
    // -----------------------------------------------------------------------

    /// Append a context-journal row (the Companion's passive-awareness feed),
    /// pruning the working set on insert: keep the newest `JOURNAL_KEEP_ROWS`
    /// and nothing older than `JOURNAL_KEEP_MS`. Best-effort at call sites.
    pub fn append_journal(
        &self,
        kind: &str,
        surface_kind: Option<&str>,
        surface_id: Option<&str>,
        label: Option<&str>,
        detail: Option<&str>,
    ) -> rusqlite::Result<i64> {
        const JOURNAL_KEEP_ROWS: i64 = 2000;
        const JOURNAL_KEEP_MS: i64 = 14 * 24 * 60 * 60 * 1000;
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO context_journal (ts, kind, surface_kind, surface_id, label, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![now, kind, surface_kind, surface_id, label, detail],
        )?;
        let id = conn.last_insert_rowid();
        let _ = conn.execute(
            "DELETE FROM context_journal
             WHERE id <= ?1 - ?2 OR ts < ?3 - ?4",
            params![id, JOURNAL_KEEP_ROWS, now, JOURNAL_KEEP_MS],
        );
        Ok(id)
    }

    /// Journal rows strictly after `since_id`, oldest-first, capped at `limit` —
    /// the Companion's "while you were away" delta.
    pub fn list_journal_since(
        &self,
        since_id: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<JournalRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, ts, kind, surface_kind, surface_id, label, detail
             FROM context_journal WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since_id.max(0), limit.max(1)], |r| {
            Ok(JournalRow {
                id: r.get(0)?,
                ts: r.get(1)?,
                kind: r.get(2)?,
                surface_kind: r.get(3)?,
                surface_id: r.get(4)?,
                label: r.get(5)?,
                detail: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// The newest journal row id (0 when empty) — the seq a reader can resume
    /// its delta from.
    pub fn journal_head(&self) -> rusqlite::Result<i64> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT COALESCE(MAX(id), 0) FROM context_journal",
            [],
            |r| r.get(0),
        )
    }

    // -----------------------------------------------------------------------
    // Companion: the global cross-surface discussion
    // -----------------------------------------------------------------------

    pub fn insert_companion(&self, c: &crate::state::Companion) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO companion_sessions
                (companion_id, title, status, created_at, updated_at, model, effort)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                c.companion_id,
                c.title,
                c.status,
                c.created_at,
                c.updated_at,
                c.model,
                c.effort
            ],
        )?;
        Ok(())
    }

    /// All companion sessions, most recently active first.
    pub fn list_companions(&self) -> rusqlite::Result<Vec<crate::state::Companion>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT companion_id, title, status, created_at, updated_at, model, effort,
                    title_is_user_set
             FROM companion_sessions ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::state::Companion {
                companion_id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                model: r.get(5)?,
                effort: r.get(6)?,
                title_is_user_set: r.get::<_, i64>(7)? != 0,
            })
        })?;
        rows.collect()
    }

    /// One chat's per-conversation seat override, as `(model, effort)`. Both
    /// `None` means "use the `companion` seat's own flags" — the override is
    /// additive, never a second source of truth for the seat.
    pub fn get_companion_seat(&self, companion_id: &str) -> (Option<String>, Option<String>) {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT model, effort FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .unwrap_or((None, None))
    }

    /// Set (or clear, with `None`) a chat's model/effort override.
    pub fn set_companion_seat(
        &self,
        companion_id: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE companion_sessions SET model = ?2, effort = ?3 WHERE companion_id = ?1",
            params![companion_id, model, effort],
        )?;
        Ok(())
    }

    /// Rename a chat. `by_user` latches `title_is_user_set`, which the
    /// auto-titling pass reads as "never touch this again" — a name the user
    /// chose outranks anything a model would propose, permanently.
    pub fn set_companion_title(
        &self,
        companion_id: &str,
        title: &str,
        by_user: bool,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let sql = if by_user {
            "UPDATE companion_sessions SET title = ?2, title_is_user_set = 1
             WHERE companion_id = ?1"
        } else {
            // The auto-title never overwrites a user-set name.
            "UPDATE companion_sessions SET title = ?2
             WHERE companion_id = ?1 AND title_is_user_set = 0"
        };
        Ok(conn.execute(sql, params![companion_id, title])? > 0)
    }

    /// Completed assistant turns as of this chat's last CLI-session rotation.
    pub fn get_companion_rotated_at(&self, companion_id: &str) -> i64 {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT rotated_at_turns FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Move the rotation mark. Paired with `clear_companion_session` by
    /// `reset_companion_session` so the two can never drift.
    pub fn set_companion_rotated_at(
        &self,
        companion_id: &str,
        at_turns: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE companion_sessions SET rotated_at_turns = ?2 WHERE companion_id = ?1",
            params![companion_id, at_turns],
        )?;
        Ok(())
    }

    pub fn delete_companion(&self, companion_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM companion_messages WHERE companion_id = ?1",
            params![companion_id],
        )?;
        conn.execute(
            "DELETE FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
        )?;
        Ok(())
    }

    pub fn get_companion_session(&self, companion_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_companion_session(
        &self,
        companion_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE companion_sessions SET claude_session_id = ?2 WHERE companion_id = ?1",
            params![companion_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget an over-limit companion session so the next turn starts fresh.
    pub fn clear_companion_session(&self, companion_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE companion_sessions SET claude_session_id = NULL WHERE companion_id = ?1",
            params![companion_id],
        )?;
        Ok(())
    }

    /// The journal high-water mark this companion has already absorbed.
    pub fn get_companion_journal_seq(&self, companion_id: &str) -> i64 {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT last_journal_seq FROM companion_sessions WHERE companion_id = ?1",
            params![companion_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn set_companion_journal_seq(
        &self,
        companion_id: &str,
        seq: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE companion_sessions SET last_journal_seq = MAX(last_journal_seq, ?2)
             WHERE companion_id = ?1",
            params![companion_id, seq],
        )?;
        Ok(())
    }

    pub fn insert_companion_message(
        &self,
        msg: &crate::state::CompanionMessage,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO companion_messages
                (id, companion_id, role, body, status, surface_kind, surface_id,
                 surface_label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                msg.id,
                msg.companion_id,
                msg.role,
                msg.body,
                msg.status,
                msg.surface_kind,
                msg.surface_id,
                msg.surface_label,
                msg.created_at
            ],
        )?;
        Self::touch_companion_locked(&conn, &msg.companion_id, msg.created_at);
        Ok(())
    }

    fn touch_companion_locked(conn: &Connection, companion_id: &str, at: i64) {
        let _ = conn.execute(
            "UPDATE companion_sessions SET updated_at = MAX(updated_at, ?2)
             WHERE companion_id = ?1",
            params![companion_id, at],
        );
    }

    pub fn load_companion_thread(
        &self,
        companion_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::CompanionMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, companion_id, role, body, status, surface_kind, surface_id,
                    surface_label, created_at
             FROM companion_messages WHERE companion_id = ?1
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![companion_id], |r| {
            Ok(crate::state::CompanionMessage {
                id: r.get(0)?,
                companion_id: r.get(1)?,
                role: r.get(2)?,
                body: r.get(3)?,
                status: r.get(4)?,
                surface_kind: r.get(5)?,
                surface_id: r.get(6)?,
                surface_label: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // Prompt Drafter / Bookshelf: the document itself, plus its shelf location
    // -----------------------------------------------------------------------

    /// Upsert a draft. `doc_json` is the TipTap **fidelity source** — the real
    /// document, which the Bookshelf now owns; `doc_markdown` is the derived,
    /// agent-readable mirror behind `/v1/drafter/:id/doc`.
    ///
    /// `doc_json = None` means "mirror only, don't touch the document" — the
    /// server-side flush in `draft_chat` passes it, and `COALESCE` keeps the
    /// stored JSON intact. A markdown-only writer must never be able to blank
    /// the only copy of the document.
    pub fn upsert_draft(
        &self,
        draft_id: &str,
        title: Option<&str>,
        project_path: Option<&str>,
        doc_markdown: &str,
        doc_json: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO drafts (draft_id, title, project_path, doc_markdown, doc_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(draft_id) DO UPDATE SET
                title = CASE WHEN drafts.title_is_user_set = 1 THEN drafts.title
                             ELSE COALESCE(excluded.title, drafts.title) END,
                project_path = excluded.project_path,
                doc_markdown = excluded.doc_markdown,
                doc_json = COALESCE(excluded.doc_json, drafts.doc_json),
                updated_at = excluded.updated_at",
            params![draft_id, title, project_path, doc_markdown, doc_json, now],
        )?;
        Ok(())
    }

    /// A draft's `(title, project_path, doc_markdown, updated_at)`.
    pub fn get_draft(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Option<(Option<String>, Option<String>, String, i64)>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT title, project_path, doc_markdown, updated_at
             FROM drafts WHERE draft_id = ?1",
            params![draft_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
    }

    /// The document itself: `(doc_json, doc_markdown, project_path)`. `doc_json`
    /// is `None` for a row that has only ever been mirrored — the drafter then
    /// opens blank rather than inventing a body.
    pub fn get_draft_doc(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Option<(Option<String>, String, Option<String>)>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT doc_json, doc_markdown, project_path FROM drafts WHERE draft_id = ?1",
            params![draft_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
    }

    // --- Bookshelf: documents ---

    /// Every shelf document, most-recently-updated first.
    pub fn list_drafts(&self) -> rusqlite::Result<Vec<BookshelfDraft>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT d.draft_id, d.title, d.project_path, d.folder_id, d.created_at, d.updated_at,
                    (SELECT COUNT(*) FROM draft_sources s WHERE s.draft_id = d.draft_id),
                    (d.doc_json IS NOT NULL AND d.doc_json <> ''),
                    d.is_template, d.open_count, d.last_opened_at
             FROM drafts d
             WHERE d.draft_id NOT LIKE 'preview-%'
             ORDER BY d.updated_at DESC, d.draft_id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(BookshelfDraft {
                draft_id: r.get(0)?,
                title: r.get(1)?,
                project_path: r.get(2)?,
                folder_id: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                source_count: r.get(6)?,
                has_doc: r.get::<_, i64>(7)? != 0,
                is_template: r.get::<_, i64>(8)? != 0,
                open_count: r.get(9)?,
                last_opened_at: r.get(10)?,
            })
        })?;
        rows.collect()
    }

    /// Flip a document's template flag. Content is untouched — a template is an
    /// ordinary document the dropdown offers to instantiate.
    pub fn set_draft_template(&self, draft_id: &str, is_template: bool) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE drafts SET is_template = ?2 WHERE draft_id = ?1",
            params![draft_id, is_template as i64],
        )?;
        Ok(())
    }

    /// Deep-copy a document's body — `title`, `doc_json`, `doc_markdown`,
    /// `project_path` — into `dest` (template instantiation, or duplicating
    /// any document). Sources, comments, suggestions and chat threads are
    /// deliberately NOT copied, and the copy is always an ordinary document
    /// (`is_template` stays 0). Returns `false` when `src` doesn't exist.
    pub fn copy_draft_body(
        &self,
        src: &str,
        dest: &str,
        fallback_project: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let Some((json, markdown, src_project)) = self.get_draft_doc(src)? else {
            return Ok(false);
        };
        let title = self.get_draft(src)?.and_then(|(t, _, _, _)| t);
        self.upsert_draft(
            dest,
            title.as_deref().or(Some("Untitled document")),
            src_project.as_deref().or(fallback_project),
            &markdown,
            json.as_deref(),
        )?;
        Ok(true)
    }

    /// Count an open of this document (the dropdown's FREQUENT signal).
    /// Deliberately does NOT bump `updated_at` — that means "content changed"
    /// and orders the shelf; opening a document must not reorder it.
    pub fn touch_draft(&self, draft_id: &str) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE drafts SET open_count = open_count + 1, last_opened_at = ?2
             WHERE draft_id = ?1",
            params![draft_id, now],
        )?;
        Ok(())
    }

    /// Rename a document. The title is normally derived from the markdown's
    /// first heading; this is the explicit override the shelf offers. Pinning
    /// `title_is_user_set` here is what makes the override survive the next
    /// keystroke — every document mirror writer re-derives a title and passes
    /// it, and `upsert_draft` reads this flag rather than trusting them.
    pub fn rename_draft(&self, draft_id: &str, title: &str) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE drafts SET title = ?2, title_is_user_set = 1, updated_at = ?3
             WHERE draft_id = ?1",
            params![draft_id, title, now],
        )?;
        Ok(())
    }

    /// Move a document to a folder (`None` = shelf root). A single row update —
    /// the whole reason the tree is an adjacency list.
    pub fn move_draft(&self, draft_id: &str, folder_id: Option<&str>) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE drafts SET folder_id = ?2, updated_at = ?3 WHERE draft_id = ?1",
            params![draft_id, folder_id, now],
        )?;
        Ok(())
    }

    /// What deleting this document destroys — for the confirm dialog.
    pub fn draft_delete_impact(&self, draft_id: &str) -> rusqlite::Result<DeleteImpact> {
        let conn = self.lock_conn();
        Self::draft_impact_locked(&conn, draft_id)
    }

    fn draft_impact_locked(conn: &Connection, draft_id: &str) -> rusqlite::Result<DeleteImpact> {
        let count = |sql: &str| -> rusqlite::Result<i64> {
            conn.query_row(sql, params![draft_id], |r| r.get(0))
        };
        Ok(DeleteImpact {
            drafts: count("SELECT COUNT(*) FROM drafts WHERE draft_id = ?1")?,
            folders: 0,
            comments: count("SELECT COUNT(*) FROM draft_comments WHERE draft_id = ?1")?,
            pending_suggestions: count(
                "SELECT COUNT(*) FROM draft_suggestions WHERE draft_id = ?1 AND status = 'pending'",
            )?,
            sources: count("SELECT COUNT(*) FROM draft_sources WHERE draft_id = ?1")?,
            chat_messages: count("SELECT COUNT(*) FROM draft_chat_messages WHERE draft_id = ?1")?,
        })
    }

    /// Delete a document and everything hanging off it — the chat thread, its
    /// comments, its queued suggestions, its sources. There is no undo, and as
    /// of the Bookshelf this destroys the only copy of the document, which is
    /// why the caller gates it behind a typed-title confirm.
    pub fn delete_draft(&self, draft_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        Self::delete_draft_locked(&conn, draft_id)
    }

    fn delete_draft_locked(conn: &Connection, draft_id: &str) -> rusqlite::Result<()> {
        for sql in [
            "DELETE FROM draft_sources WHERE draft_id = ?1",
            "DELETE FROM draft_suggestions WHERE draft_id = ?1",
            "DELETE FROM draft_comments WHERE draft_id = ?1",
            "DELETE FROM draft_chat_messages WHERE draft_id = ?1",
            "DELETE FROM draft_chat_threads WHERE draft_id = ?1",
            "DELETE FROM drafts WHERE draft_id = ?1",
        ] {
            conn.execute(sql, params![draft_id])?;
        }
        Ok(())
    }

    // --- Bookshelf: folders ---

    /// Every folder, parent-then-name ordered (the tree is built client-side by
    /// the same `buildTree` pattern the memory and review trees use).
    pub fn list_folders(&self) -> rusqlite::Result<Vec<BookshelfFolder>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT folder_id, parent_id, name, created_at FROM bookshelf_folders
             ORDER BY parent_id IS NOT NULL, parent_id, name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(BookshelfFolder {
                folder_id: r.get(0)?,
                parent_id: r.get(1)?,
                name: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_folder(
        &self,
        folder_id: &str,
        parent_id: Option<&str>,
        name: &str,
    ) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO bookshelf_folders (folder_id, parent_id, name, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![folder_id, parent_id, name, now],
        )?;
        Ok(())
    }

    pub fn rename_folder(&self, folder_id: &str, name: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE bookshelf_folders SET name = ?2 WHERE folder_id = ?1",
            params![folder_id, name],
        )?;
        Ok(())
    }

    /// Reparent a folder (`None` = shelf root). **Rejects a move into the
    /// folder's own subtree** — the adjacency list has no structural guard
    /// against a cycle, and a cycle would orphan the whole subtree from the
    /// root walk. Returns `Err` with a readable reason so the UI can show it.
    pub fn move_folder(
        &self,
        folder_id: &str,
        new_parent: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.lock_conn();
        let edges = Self::folder_edges_locked(&conn).map_err(|e| e.to_string())?;
        if let Some(reason) = folder_move_rejection(&edges, folder_id, new_parent) {
            return Err(reason);
        }
        conn.execute(
            "UPDATE bookshelf_folders SET parent_id = ?2 WHERE folder_id = ?1",
            params![folder_id, new_parent],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// `(folder_id, parent_id)` for every folder — the adjacency edges the
    /// cycle guard walks.
    fn folder_edges_locked(conn: &Connection) -> rusqlite::Result<Vec<(String, Option<String>)>> {
        let mut stmt = conn.prepare("SELECT folder_id, parent_id FROM bookshelf_folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// What deleting this folder destroys, counting its whole subtree.
    pub fn folder_delete_impact(&self, folder_id: &str) -> rusqlite::Result<DeleteImpact> {
        let conn = self.lock_conn();
        let edges = Self::folder_edges_locked(&conn)?;
        let subtree = folder_subtree(&edges, folder_id);
        let mut impact = DeleteImpact {
            folders: subtree.len() as i64,
            ..Default::default()
        };
        for fid in &subtree {
            let mut stmt = conn.prepare("SELECT draft_id FROM drafts WHERE folder_id = ?1")?;
            let ids: Vec<String> = stmt
                .query_map(params![fid], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            drop(stmt);
            for id in ids {
                let d = Self::draft_impact_locked(&conn, &id)?;
                impact.drafts += d.drafts;
                impact.comments += d.comments;
                impact.pending_suggestions += d.pending_suggestions;
                impact.sources += d.sources;
                impact.chat_messages += d.chat_messages;
            }
        }
        Ok(impact)
    }

    /// Delete a folder, its subtree, and every document inside — with the same
    /// cascade `delete_draft` performs. No undo; gated by a typed-title confirm.
    /// Returns the ids of the documents that went, so the caller can remove
    /// their source directories too.
    pub fn delete_folder(&self, folder_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock_conn();
        let edges = Self::folder_edges_locked(&conn)?;
        let subtree = folder_subtree(&edges, folder_id);
        let mut deleted: Vec<String> = Vec::new();
        for fid in &subtree {
            let mut stmt = conn.prepare("SELECT draft_id FROM drafts WHERE folder_id = ?1")?;
            let ids: Vec<String> = stmt
                .query_map(params![fid], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            drop(stmt);
            for id in ids {
                Self::delete_draft_locked(&conn, &id)?;
                deleted.push(id);
            }
            conn.execute(
                "DELETE FROM bookshelf_folders WHERE folder_id = ?1",
                params![fid],
            )?;
        }
        Ok(deleted)
    }

    // --- Bookshelf: sources (attached to a document, never to a folder) ---

    #[allow(clippy::too_many_arguments)]
    pub fn add_draft_source(
        &self,
        id: &str,
        draft_id: &str,
        kind: &str,
        ref_id: Option<&str>,
        url: Option<&str>,
        title: Option<&str>,
        excerpt: Option<&str>,
        file_path: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_sources
                (id, draft_id, kind, ref_id, url, title, excerpt, file_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, draft_id, kind, ref_id, url, title, excerpt, file_path, now],
        )?;
        Ok(())
    }

    pub fn list_draft_sources(&self, draft_id: &str) -> rusqlite::Result<Vec<DraftSource>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, draft_id, kind, ref_id, url, title, excerpt, file_path, created_at
             FROM draft_sources WHERE draft_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| {
            Ok(DraftSource {
                id: r.get(0)?,
                draft_id: r.get(1)?,
                kind: r.get(2)?,
                ref_id: r.get(3)?,
                url: r.get(4)?,
                title: r.get(5)?,
                excerpt: r.get(6)?,
                file_path: r.get(7)?,
                created_at: r.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Delete one source row, returning its `file_path` so the caller can
    /// remove the backing file under `<app_data_dir>/bookshelf/<draft_id>/`.
    pub fn delete_draft_source(&self, id: &str) -> rusqlite::Result<Option<(String, String)>> {
        let conn = self.lock_conn();
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT draft_id, file_path FROM draft_sources WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        conn.execute("DELETE FROM draft_sources WHERE id = ?1", params![id])?;
        Ok(row.and_then(|(draft_id, file)| file.map(|f| (draft_id, f))))
    }

    // -----------------------------------------------------------------------
    // Friction telemetry + the Shipwright's own outcomes
    // -----------------------------------------------------------------------

    /// Append a friction event, pruning the table in the same statement as the
    /// insert — modelled directly on `append_journal`'s prune-on-insert, so
    /// there is no sweeper task and no unbounded growth. 90 days is long enough
    /// that a digest can say "14 overflows in the last three days" against a
    /// real baseline.
    ///
    /// Call sites use `let _ = …`: this is fire-and-forget by contract and must
    /// never block or fail the path it observes.
    pub fn record_friction(
        &self,
        kind: &str,
        surface: Option<&str>,
        session_id: Option<&str>,
        detail: Option<&str>,
    ) -> rusqlite::Result<i64> {
        const FRICTION_KEEP_ROWS: i64 = 5000;
        const FRICTION_KEEP_MS: i64 = 90 * 24 * 60 * 60 * 1000;
        /// `detail` is free-form error text from a model or a subprocess —
        /// capped here so one pathological message can't dominate the table.
        const MAX_DETAIL: usize = 500;
        let detail = detail.map(|d| {
            if d.len() <= MAX_DETAIL {
                d.to_string()
            } else {
                d.chars().take(MAX_DETAIL).collect()
            }
        });
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO friction_events (ts, kind, surface, session_id, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![now, kind, surface, session_id, detail],
        )?;
        let id = conn.last_insert_rowid();
        let _ = conn.execute(
            "DELETE FROM friction_events
             WHERE id <= ?1 - ?2 OR ts < ?3 - ?4",
            params![id, FRICTION_KEEP_ROWS, now, FRICTION_KEEP_MS],
        );
        Ok(id)
    }

    /// Friction kinds inside `window_ms`, most-frequent first.
    pub fn friction_summary(&self, window_ms: i64) -> rusqlite::Result<Vec<FrictionCount>> {
        let cutoff = crate::ledger::now_millis() - window_ms.max(0);
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT kind, COUNT(*), MAX(ts),
                    (SELECT detail FROM friction_events f2
                     WHERE f2.kind = f1.kind AND f2.ts >= ?1
                     ORDER BY f2.ts DESC LIMIT 1)
             FROM friction_events f1 WHERE ts >= ?1
             GROUP BY kind ORDER BY COUNT(*) DESC, MAX(ts) DESC",
        )?;
        let rows = stmt.query_map(params![cutoff], |r| {
            Ok(FrictionCount {
                kind: r.get(0)?,
                count: r.get(1)?,
                last_ts: r.get(2)?,
                last_detail: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Insert one finding, deduping on `(category, summary)` **regardless of
    /// `dismissed`** — the property (copied from `insert_class_observation`)
    /// that makes a dismissed finding never resurface under the same wording.
    /// Returns `None` when the finding was a duplicate and nothing was written.
    pub fn insert_shipwright_finding(
        &self,
        f: &ShipwrightFinding,
    ) -> rusqlite::Result<Option<String>> {
        if f.summary.trim().is_empty() || f.category.trim().is_empty() {
            return Ok(None);
        }
        let conn = self.lock_conn();
        let dup: i64 = conn.query_row(
            "SELECT COUNT(*) FROM shipwright_findings WHERE category = ?1 AND summary = ?2",
            params![f.category, f.summary],
            |r| r.get(0),
        )?;
        if dup > 0 {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO shipwright_findings
                (id, run_id, category, summary, evidence, proposal, guard, files,
                 status, dismissed, draft_id, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, ?9, ?10, NULL)",
            params![
                f.id,
                f.run_id,
                f.category,
                f.summary,
                f.evidence,
                f.proposal,
                f.guard,
                f.files,
                f.draft_id,
                f.created_at,
            ],
        )?;
        Ok(Some(f.id.clone()))
    }

    /// Findings, newest first. `include_dismissed = false` is what the digest
    /// carries as "open"; the dismissed *summaries* go in separately so the
    /// agent is told not to re-word them.
    pub fn list_shipwright_findings(
        &self,
        include_dismissed: bool,
    ) -> rusqlite::Result<Vec<ShipwrightFinding>> {
        let conn = self.lock_conn();
        let sql = if include_dismissed {
            "SELECT id, run_id, category, summary, evidence, proposal, guard, files,
                    status, dismissed, draft_id, created_at, resolved_at
             FROM shipwright_findings ORDER BY created_at DESC, id ASC"
        } else {
            "SELECT id, run_id, category, summary, evidence, proposal, guard, files,
                    status, dismissed, draft_id, created_at, resolved_at
             FROM shipwright_findings WHERE dismissed = 0
             ORDER BY created_at DESC, id ASC"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(ShipwrightFinding {
                id: r.get(0)?,
                run_id: r.get(1)?,
                category: r.get(2)?,
                summary: r.get(3)?,
                evidence: r.get(4)?,
                proposal: r.get(5)?,
                guard: r.get(6)?,
                files: r.get(7)?,
                status: r.get(8)?,
                dismissed: r.get::<_, i64>(9)? != 0,
                draft_id: r.get(10)?,
                created_at: r.get(11)?,
                resolved_at: r.get(12)?,
            })
        })?;
        rows.collect()
    }

    /// Record what you did with a finding. `accepted` is set when it survives
    /// your trim into the launched document; `dismissed` also sets the flag the
    /// dedupe reads, which is what makes a dismissal stick.
    pub fn resolve_shipwright_finding(
        &self,
        id: &str,
        status: &str,
        draft_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let dismissed = i64::from(status == "dismissed");
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE shipwright_findings
             SET status = ?2,
                 dismissed = MAX(dismissed, ?3),
                 draft_id = COALESCE(?4, draft_id),
                 resolved_at = ?5
             WHERE id = ?1",
            params![id, status, dismissed, draft_id, now],
        )?;
        Ok(())
    }

    /// Accepted findings that haven't shipped yet, as `(id, files_json)` — the
    /// input to shipped-**detection**. The caller compares each `files` entry
    /// against the paths a later commit touched; nothing here is self-declared.
    pub fn shipwright_unshipped(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(files, '[]') FROM shipwright_findings
             WHERE status = 'accepted'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Accept/dismiss/ship rates per category — the agent's own track record.
    pub fn shipwright_scores(&self) -> rusqlite::Result<Vec<CategoryScore>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT category, COUNT(*),
                    SUM(status IN ('accepted','shipped')),
                    SUM(dismissed),
                    SUM(status = 'shipped')
             FROM shipwright_findings GROUP BY category ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CategoryScore {
                category: r.get(0)?,
                total: r.get(1)?,
                accepted: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                dismissed: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                shipped: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        })?;
        rows.collect()
    }

    // -----------------------------------------------------------------------
    // Recorded correction (the Shipwright's Tier A) — scoped to one repo
    // -----------------------------------------------------------------------
    //
    // Everything here already existed on disk and nobody mined it. It is a
    // labeled corpus of "the agent got this wrong and I corrected it," in the
    // user's own words, with round counts — and it needs no schema change to
    // read. It is also the highest-signal input the Shipwright has: a 4-round
    // reopen is evidence of real pain, where a long file is only a hypothesis.

    /// Comments reopened at least once on this repo's sessions, most rounds
    /// first: `(session_id, rounds, body, reopen_note)`. `rounds` counts the
    /// entries in `reopen_history` — N entries means "we went N rounds on this
    /// one point".
    pub fn reopen_rounds_for_repo(
        &self,
        project_path: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(String, i64, String, Option<String>)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT c.session_id, c.reopen_history, c.body, c.reopen_note
             FROM comments c JOIN sessions s ON s.session_id = c.session_id
             WHERE s.project_path = ?1 AND c.reopen_history IS NOT NULL
             ORDER BY c.created_at DESC",
        )?;
        let rows = stmt.query_map(params![project_path], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut out: Vec<(String, i64, String, Option<String>)> = Vec::new();
        for row in rows {
            let (session_id, history, body, note) = row?;
            let rounds = history
                .as_deref()
                .and_then(|h| serde_json::from_str::<serde_json::Value>(h).ok())
                .and_then(|v| v.as_array().map(|a| a.len() as i64))
                .unwrap_or(0);
            if rounds > 0 {
                out.push((session_id, rounds, body, note));
            }
        }
        out.sort_by(|a, b| b.1.cmp(&a.1));
        out.truncate(limit.max(0) as usize);
        Ok(out)
    }

    /// Verbatim before/after pairs where the user rewrote the agent's prose on
    /// this repo: `(session_id, original, revised)`, newest first.
    pub fn edit_pairs_for_repo(
        &self,
        project_path: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(String, String, String)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT c.session_id, c.edit_original, c.edit_revised
             FROM comments c JOIN sessions s ON s.session_id = c.session_id
             WHERE s.project_path = ?1
               AND c.edit_original IS NOT NULL AND c.edit_revised IS NOT NULL
               AND c.edit_original <> c.edit_revised
             ORDER BY c.created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_path, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect()
    }

    /// Code reviews on this repo that took more than one round:
    /// `(review_id, round, source)`, most rounds first.
    pub fn review_rounds_for_repo(
        &self,
        repo_path: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(String, i64, String)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT review_id, round, source FROM review_sessions
             WHERE repo_path = ?1 AND round > 1
             ORDER BY round DESC, created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![repo_path, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect()
    }

    /// Re-anchoring success on returned review requests for this repo:
    /// `(placed, orphans)` summed across every return.
    pub fn share_anchoring_for_repo(&self, project_path: &str) -> rusqlite::Result<(i64, i64)> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT COALESCE(SUM(r.placed), 0), COALESCE(SUM(r.orphans), 0)
             FROM share_returns r JOIN sessions s ON s.session_id = r.session_id
             WHERE s.project_path = ?1",
            params![project_path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    /// Agent write-suggestions the user rejected: `(count, most_recent_op)`.
    /// Not repo-scoped — drafts carry a `project_path` only when one was picked.
    pub fn rejected_suggestion_summary(
        &self,
        project_path: &str,
    ) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT g.op, COUNT(*) FROM draft_suggestions g
             JOIN drafts d ON d.draft_id = g.draft_id
             WHERE g.status = 'rejected' AND d.project_path = ?1
             GROUP BY g.op ORDER BY COUNT(*) DESC",
        )?;
        let rows = stmt.query_map(params![project_path], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Approved plans on this repo whose code never went through a review:
    /// `(session_id, project_name, created_at)`. The Tier D "a plan shipped
    /// without its code being reviewed" signal.
    pub fn approved_unreviewed_for_repo(
        &self,
        project_path: &str,
        limit: i64,
    ) -> rusqlite::Result<Vec<(String, String, i64)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.project_name, s.created_at
             FROM sessions s
             WHERE s.project_path = ?1 AND s.status = 'approved'
               AND NOT EXISTS (
                   SELECT 1 FROM review_sessions v
                   WHERE v.repo_path = s.project_path AND v.created_at >= s.created_at
               )
             ORDER BY s.created_at ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![project_path, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect()
    }

    /// Persist a draft-chat turn (terminal row; streaming is frontend-only).
    pub fn insert_draft_chat_message(
        &self,
        msg: &crate::state::DraftChatMessage,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_chat_messages (id, draft_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.draft_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at
            ],
        )?;
        Ok(())
    }

    /// A draft's discussion history, oldest-first.
    pub fn load_draft_chat_thread(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::DraftChatMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, draft_id, role, body, status, created_at
             FROM draft_chat_messages WHERE draft_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| {
            Ok(crate::state::DraftChatMessage {
                id: r.get(0)?,
                draft_id: r.get(1)?,
                role: r.get(2)?,
                body: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// The draft chat's resumable claude session id, if any.
    pub fn get_draft_chat_session(&self, draft_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM draft_chat_threads WHERE draft_id = ?1",
            params![draft_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_draft_chat_session(
        &self,
        draft_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_chat_threads (draft_id, claude_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(draft_id) DO UPDATE SET claude_session_id = excluded.claude_session_id",
            params![draft_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget an over-limit draft-chat session so the next turn starts fresh.
    pub fn clear_draft_chat_session(&self, draft_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE draft_chat_threads SET claude_session_id = NULL WHERE draft_id = ?1",
            params![draft_id],
        )?;
        Ok(())
    }

    /// The doc hash the draft's agent last saw (drives the "the draft has
    /// changed — re-read it" follow-up header).
    pub fn get_draft_chat_doc_hash(&self, draft_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT last_doc_hash FROM draft_chat_threads WHERE draft_id = ?1",
            params![draft_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_draft_chat_doc_hash(&self, draft_id: &str, hash: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_chat_threads (draft_id, last_doc_hash)
             VALUES (?1, ?2)
             ON CONFLICT(draft_id) DO UPDATE SET last_doc_hash = excluded.last_doc_hash",
            params![draft_id, hash],
        )?;
        Ok(())
    }

    /// Drop a draft's discussion thread + resumable session (explicit draft
    /// delete only — "New draft" keeps history).
    pub fn delete_draft_chat(&self, draft_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM draft_chat_messages WHERE draft_id = ?1",
            params![draft_id],
        )?;
        conn.execute(
            "DELETE FROM draft_chat_threads WHERE draft_id = ?1",
            params![draft_id],
        )?;
        Ok(())
    }

    // --- Memory Ask thread (Second Brain P4) — the draft_chat shape, keyed by
    // the constant memchat thread id. See memchat.rs.

    pub fn insert_mem_chat_message(
        &self,
        msg: &crate::state::MemChatMessage,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO mem_chat_messages (id, thread_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.thread_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at
            ],
        )?;
        Ok(())
    }

    pub fn load_mem_chat_thread(
        &self,
        thread_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::MemChatMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, thread_id, role, body, status, created_at
             FROM mem_chat_messages WHERE thread_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![thread_id], |r| {
            Ok(crate::state::MemChatMessage {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                role: r.get(2)?,
                body: r.get(3)?,
                status: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_mem_chat_session(&self, thread_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM mem_chat_threads WHERE thread_id = ?1",
            params![thread_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_mem_chat_session(&self, thread_id: &str, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO mem_chat_threads (thread_id, claude_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(thread_id) DO UPDATE SET claude_session_id = excluded.claude_session_id",
            params![thread_id, session_id],
        )?;
        Ok(())
    }

    pub fn clear_mem_chat_session(&self, thread_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE mem_chat_threads SET claude_session_id = NULL WHERE thread_id = ?1",
            params![thread_id],
        )?;
        Ok(())
    }

    /// The ledger high-water mark the Ask agent last saw (its follow-up header
    /// says whether the record grew since). `None` before the first turn.
    pub fn get_mem_chat_last_seq(&self, thread_id: &str) -> Option<i64> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT last_seq FROM mem_chat_threads WHERE thread_id = ?1",
            params![thread_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_mem_chat_last_seq(&self, thread_id: &str, seq: i64) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO mem_chat_threads (thread_id, last_seq)
             VALUES (?1, ?2)
             ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq",
            params![thread_id, seq],
        )?;
        Ok(())
    }

    /// Drop the Ask thread + its resumable session — the "New conversation"
    /// reset. The turns already captured in the lake stay there (the thread
    /// rows are presentation, not the record).
    pub fn delete_mem_chat(&self, thread_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM mem_chat_messages WHERE thread_id = ?1",
            params![thread_id],
        )?;
        conn.execute(
            "DELETE FROM mem_chat_threads WHERE thread_id = ?1",
            params![thread_id],
        )?;
        Ok(())
    }

    /// Insert a draft comment (the drafter sidecar).
    pub fn insert_draft_comment(&self, c: &crate::state::DraftComment) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_comments
                (id, draft_id, block_id, sel_char_start, sel_char_end, sel_quoted_text,
                 body, author, created_at, fork_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                c.id,
                c.draft_id,
                c.block_id,
                c.sel_char_start,
                c.sel_char_end,
                c.sel_quoted_text,
                c.body,
                c.author,
                c.created_at,
                c.fork_session_id
            ],
        )?;
        Ok(())
    }

    /// A draft's comments, oldest-first.
    pub fn list_draft_comments(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::DraftComment>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, draft_id, block_id, sel_char_start, sel_char_end, sel_quoted_text,
                    body, author, created_at, fork_session_id
             FROM draft_comments WHERE draft_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| {
            Ok(crate::state::DraftComment {
                id: r.get(0)?,
                draft_id: r.get(1)?,
                block_id: r.get(2)?,
                sel_char_start: r.get(3)?,
                sel_char_end: r.get(4)?,
                sel_quoted_text: r.get(5)?,
                body: r.get(6)?,
                author: r.get(7)?,
                created_at: r.get(8)?,
                fork_session_id: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    /// One draft comment by id (scope checks + fork grounding).
    pub fn get_draft_comment(
        &self,
        id: &str,
    ) -> rusqlite::Result<Option<crate::state::DraftComment>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT id, draft_id, block_id, sel_char_start, sel_char_end, sel_quoted_text,
                    body, author, created_at, fork_session_id
             FROM draft_comments WHERE id = ?1",
            params![id],
            |r| {
                Ok(crate::state::DraftComment {
                    id: r.get(0)?,
                    draft_id: r.get(1)?,
                    block_id: r.get(2)?,
                    sel_char_start: r.get(3)?,
                    sel_char_end: r.get(4)?,
                    sel_quoted_text: r.get(5)?,
                    body: r.get(6)?,
                    author: r.get(7)?,
                    created_at: r.get(8)?,
                    fork_session_id: r.get(9)?,
                })
            },
        )
        .optional()
    }

    /// Delete a draft comment + its discussion thread rows.
    pub fn delete_draft_comment(&self, draft_id: &str, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM draft_comments WHERE id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![draft_id, id],
        )?;
        Ok(())
    }

    /// The draft comment's resumable discussion-fork session id.
    pub fn get_draft_comment_fork_session(&self, id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT fork_session_id FROM draft_comments WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_draft_comment_fork_session(
        &self,
        id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE draft_comments SET fork_session_id = ?2 WHERE id = ?1",
            params![id, fork_session_id],
        )?;
        Ok(())
    }

    /// Forget the stored fork so the next turn starts a fresh discussion. The
    /// recovery half of an over-limit turn (`fork::describe_fork_error`):
    /// re-`--resume`-ing a context that already overflowed just fails again.
    pub fn clear_draft_comment_fork_session(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE draft_comments SET fork_session_id = NULL WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Queue an agent write-suggestion (status `pending`).
    pub fn insert_draft_suggestion(
        &self,
        s: &crate::state::DraftSuggestion,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO draft_suggestions
                (id, draft_id, op, block_id, original, markdown, agent_id, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                s.id,
                s.draft_id,
                s.op,
                s.block_id,
                s.original,
                s.markdown,
                s.agent_id,
                s.body,
                s.status,
                s.created_at
            ],
        )?;
        Ok(())
    }

    /// A draft's pending suggestions, oldest-first — drained by the drafter on
    /// mount so proposals made while the pane was closed aren't lost.
    pub fn list_pending_draft_suggestions(
        &self,
        draft_id: &str,
    ) -> rusqlite::Result<Vec<crate::state::DraftSuggestion>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, draft_id, op, block_id, original, markdown, agent_id, body, status, created_at
             FROM draft_suggestions
             WHERE draft_id = ?1 AND status = 'pending'
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| {
            Ok(crate::state::DraftSuggestion {
                id: r.get(0)?,
                draft_id: r.get(1)?,
                op: r.get(2)?,
                block_id: r.get(3)?,
                original: r.get(4)?,
                markdown: r.get(5)?,
                agent_id: r.get(6)?,
                body: r.get(7)?,
                status: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    /// Resolve a suggestion: `applied` or `rejected`. Returns whether a pending
    /// row was actually transitioned.
    pub fn resolve_draft_suggestion(&self, id: &str, status: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let changed = conn.execute(
            "UPDATE draft_suggestions SET status = ?2
             WHERE id = ?1 AND status = 'pending'",
            params![id, status],
        )?;
        Ok(changed > 0)
    }

    /// Undo-after-accept (harness program A3): an ACCEPTED suggestion goes
    /// back to the pending queue when the user undoes the accept in the
    /// drafter. Applied-only on purpose — a rejected suggestion's marks were
    /// removed from the document, so there is nothing an undo could return
    /// to pending.
    pub fn unresolve_draft_suggestion(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let changed = conn.execute(
            "UPDATE draft_suggestions SET status = 'pending'
             WHERE id = ?1 AND status = 'applied'",
            params![id],
        )?;
        Ok(changed > 0)
    }

    /// Preview drafts (`preview-…`, harness program A3) that outlived their
    /// builder — a crash or a closed window skipped the discard. Swept at the
    /// start of every new preview.
    pub fn list_stale_preview_drafts(&self, cutoff_ms: i64) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT draft_id FROM drafts
             WHERE draft_id LIKE 'preview-%' AND updated_at < ?1",
        )?;
        let rows = stmt.query_map(params![cutoff_ms], |r| r.get(0))?;
        rows.collect()
    }

    // --- Agent shelf (harness program A2) ---

    pub fn insert_harness_agent(&self, a: &HarnessAgent) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO harness_agents
                (agent_id, name, instruction, folder_id, starred, created_at, updated_at,
                 last_run_at, run_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                a.agent_id,
                a.name,
                a.instruction,
                a.folder_id,
                a.starred as i64,
                a.created_at,
                a.updated_at,
                a.last_run_at,
                a.run_count
            ],
        )?;
        Ok(())
    }

    pub fn get_harness_agent(&self, agent_id: &str) -> rusqlite::Result<Option<HarnessAgent>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT agent_id, name, instruction, folder_id, starred, created_at, updated_at,
                    last_run_at, run_count
             FROM harness_agents WHERE agent_id = ?1",
            params![agent_id],
            Self::harness_agent_row,
        )
        .optional()
    }

    /// Every shelf agent, most-recently-updated first (the drafts ordering).
    pub fn list_harness_agents(&self) -> rusqlite::Result<Vec<HarnessAgent>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT agent_id, name, instruction, folder_id, starred, created_at, updated_at,
                    last_run_at, run_count
             FROM harness_agents ORDER BY updated_at DESC, agent_id ASC",
        )?;
        let rows = stmt.query_map([], Self::harness_agent_row)?;
        rows.collect()
    }

    fn harness_agent_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HarnessAgent> {
        Ok(HarnessAgent {
            agent_id: r.get(0)?,
            name: r.get(1)?,
            instruction: r.get(2)?,
            folder_id: r.get(3)?,
            starred: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            last_run_at: r.get(7)?,
            run_count: r.get(8)?,
        })
    }

    /// Rename / re-instruct. Bumps `updated_at` — the shelf orders by it.
    /// Returns whether the row exists.
    pub fn update_harness_agent(
        &self,
        agent_id: &str,
        name: &str,
        instruction: &str,
    ) -> rusqlite::Result<bool> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        let changed = conn.execute(
            "UPDATE harness_agents SET name = ?2, instruction = ?3, updated_at = ?4
             WHERE agent_id = ?1",
            params![agent_id, name, instruction, now],
        )?;
        Ok(changed > 0)
    }

    /// Star/unstar. Deliberately does NOT bump `updated_at` — starring isn't
    /// editing and must not reorder the shelf (the `touch_draft` discipline).
    pub fn set_harness_agent_starred(
        &self,
        agent_id: &str,
        starred: bool,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE harness_agents SET starred = ?2 WHERE agent_id = ?1",
            params![agent_id, starred as i64],
        )?;
        Ok(())
    }

    /// Move to a folder (`None` = shelf root). Does not bump `updated_at`.
    pub fn set_harness_agent_folder(
        &self,
        agent_id: &str,
        folder_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE harness_agents SET folder_id = ?2 WHERE agent_id = ?1",
            params![agent_id, folder_id],
        )?;
        Ok(())
    }

    pub fn delete_harness_agent(&self, agent_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let changed = conn.execute(
            "DELETE FROM harness_agents WHERE agent_id = ?1",
            params![agent_id],
        )?;
        Ok(changed > 0)
    }

    /// Deep-copy an agent into a fresh row (`<name> copy`, never starred, no
    /// run history) — the `copy_draft_body` discipline. Returns the copy, or
    /// `None` when `src` doesn't exist.
    pub fn duplicate_harness_agent(
        &self,
        src: &str,
        dest: &str,
    ) -> rusqlite::Result<Option<HarnessAgent>> {
        let Some(orig) = self.get_harness_agent(src)? else {
            return Ok(None);
        };
        let now = crate::ledger::now_millis();
        let copy = HarnessAgent {
            agent_id: dest.to_string(),
            name: format!("{} copy", orig.name),
            instruction: orig.instruction,
            folder_id: orig.folder_id,
            starred: false,
            created_at: now,
            updated_at: now,
            last_run_at: None,
            run_count: 0,
        };
        self.insert_harness_agent(&copy)?;
        Ok(Some(copy))
    }

    /// Count a run. Deliberately does NOT bump `updated_at` — running isn't
    /// editing, and must not reorder the shelf.
    pub fn touch_harness_agent_run(&self, agent_id: &str) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE harness_agents SET run_count = run_count + 1, last_run_at = ?2
             WHERE agent_id = ?1",
            params![agent_id, now],
        )?;
        Ok(())
    }

    /// Resolve a thread kind to its `(table, key column, body column, status
    /// column)`. The one place the generic thread routes map the app's
    /// disjoint id-spaces; `session`/`fork` reads a plan session's comment
    /// threads.
    ///
    /// The third element exists for exactly one table: `voice_messages` names
    /// its body column `text` where every other thread table uses `body`. Three
    /// prompts advertise `/v1/context/threads/voice/<id>` — `routes_block()`
    /// (which the voice agent itself embeds), the consult 422, and
    /// `/v1/global/agents`'s notes — so the route has to resolve, and a `voice`
    /// arm alone would have produced `no such column: body` instead of a 404.
    ///
    /// The fourth is `None` for exactly that same table, for the mirror-image
    /// reason: `voice_messages` has no `status` column at all. Everywhere else
    /// it names the column `load_thread_generic` filters error rows out by.
    fn thread_table(
        kind: &str,
    ) -> Option<(&'static str, &'static str, &'static str, Option<&'static str>)> {
        match kind {
            "browse" => Some(("browse_messages", "browse_id", "body", Some("status"))),
            "linked" => Some(("linked_messages", "linked_id", "body", Some("status"))),
            "mission" => Some(("mission_messages", "mission_id", "body", Some("status"))),
            "companion" => Some((
                "companion_messages",
                "companion_id",
                "body",
                Some("status"),
            )),
            "voice" => Some(("voice_messages", "session_key", "text", None)),
            "drafter" | "drafter_chat" => {
                Some(("draft_chat_messages", "draft_id", "body", Some("status")))
            }
            "memchat" => Some(("mem_chat_messages", "thread_id", "body", Some("status"))),
            "session" | "fork" => Some(("thread_messages", "session_id", "body", Some("status"))),
            _ => None,
        }
    }

    /// Flip one thread message's `status` (queue lifecycle: `queued` →
    /// `complete` when its turn starts, `queued` → `unsent` when the drain's
    /// spawn fails). Status vocabulary across the thread tables:
    /// `complete | error | queued | unsent`. Returns whether a row changed;
    /// table/column names come from the fixed `thread_table` map.
    pub fn set_thread_message_status(
        &self,
        kind: &str,
        message_id: &str,
        status: &str,
    ) -> rusqlite::Result<bool> {
        let Some((table, _, _, _)) = Self::thread_table(kind) else {
            return Ok(false);
        };
        let conn = self.lock_conn();
        let sql = format!("UPDATE {table} SET status = ?2 WHERE id = ?1");
        Ok(conn.execute(&sql, params![message_id, status])? > 0)
    }

    /// Attach a settled turn's meter to its message row. One JSON blob, keyed
    /// through the same `thread_table` map every surface already shares, so
    /// all eight get persistence uniformly rather than one at a time.
    pub fn set_thread_message_meter(
        &self,
        kind: &str,
        message_id: &str,
        meter_json: &str,
    ) -> rusqlite::Result<bool> {
        let Some((table, _, _, _)) = Self::thread_table(kind) else {
            return Ok(false);
        };
        let conn = self.lock_conn();
        let sql = format!("UPDATE {table} SET meter_json = ?2 WHERE id = ?1");
        Ok(conn.execute(&sql, params![message_id, meter_json])? > 0)
    }

    /// One message row's stored meter, if it has one.
    pub fn thread_message_meter(&self, kind: &str, message_id: &str) -> Option<String> {
        let (table, _, _, _) = Self::thread_table(kind)?;
        let conn = self.lock_conn();
        let sql = format!("SELECT meter_json FROM {table} WHERE id = ?1");
        conn.query_row(&sql, params![message_id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten()
    }

    /// Every message row's meter for one thread, as `(id, meter_json)`. The
    /// surfaces load a thread in one call, so the meters come back the same
    /// way rather than one round-trip per bubble.
    pub fn thread_meters(&self, kind: &str, thread_id: &str) -> Vec<(String, String)> {
        let Some((table, key, _, _)) = Self::thread_table(kind) else {
            return Vec::new();
        };
        let conn = self.lock_conn();
        let sql = format!(
            "SELECT id, meter_json FROM {table}
             WHERE {key} = ?1 AND meter_json IS NOT NULL"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![thread_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Stamp a plan session's transcript path (from the hook payload) and its
    /// tailed meter. Both idempotent no-op updates when unchanged.
    pub fn set_session_transcript_path(&self, sid: &str, path: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        Ok(conn.execute(
            "UPDATE sessions SET transcript_path = ?2
             WHERE session_id = ?1 AND COALESCE(transcript_path, '') <> ?2",
            params![sid, path],
        )? > 0)
    }

    pub fn set_session_meter(&self, sid: &str, meter_json: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        Ok(conn.execute(
            "UPDATE sessions SET meter_json = ?2 WHERE session_id = ?1",
            params![sid, meter_json],
        )? > 0)
    }

    pub fn session_meter(&self, sid: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT meter_json FROM sessions WHERE session_id = ?1",
            params![sid],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Plan sessions whose transcript is known, newest activity first — the
    /// tailer's work list. Bounded: an old, settled session's transcript stops
    /// growing, so re-walking the whole history buys nothing.
    pub fn plan_transcripts(&self, limit: i64) -> Vec<(String, String)> {
        let conn = self.lock_conn();
        let Ok(mut stmt) = conn.prepare(
            "SELECT session_id, transcript_path FROM sessions
             WHERE transcript_path IS NOT NULL AND transcript_path <> ''
             ORDER BY updated_at DESC LIMIT ?1",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Delete one thread message by id — backs `*_unqueue` (the queued user
    /// row disappears with its queue entry). Returns whether a row existed.
    pub fn delete_thread_message(&self, kind: &str, message_id: &str) -> rusqlite::Result<bool> {
        let Some((table, _, _, _)) = Self::thread_table(kind) else {
            return Ok(false);
        };
        let conn = self.lock_conn();
        let sql = format!("DELETE FROM {table} WHERE id = ?1");
        Ok(conn.execute(&sql, params![message_id])? > 0)
    }

    /// Startup hygiene: the send queues live in memory, so rows still marked
    /// `queued` after a relaunch belong to sends that will never fire. Flip
    /// them to `unsent` so the UI offers "wasn't sent — resend" instead of a
    /// phantom chip. Swept across every queue-capable surface.
    pub fn sweep_queued_to_unsent(&self) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        let mut flipped = 0;
        for kind in ["browse", "linked", "mission", "memchat", "companion"] {
            let (table, _, _, _) =
                Self::thread_table(kind).expect("queue-capable kinds are mapped");
            let sql = format!("UPDATE {table} SET status = 'unsent' WHERE status = 'queued'");
            flipped += conn.execute(&sql, [])?;
        }
        Ok(flipped)
    }

    /// Generic read-only thread fetch across the per-surface `*_messages`
    /// tables — the tail `limit` turns, oldest-first. `None` for an unknown
    /// kind (the route 404s). Table/column names come from the fixed
    /// `thread_table` map, never from the caller.
    ///
    /// **Error rows are excluded.** This backs
    /// `GET /v1/context/threads/:kind/:id`, which is how the Companion and
    /// every consult agent read a peer thread — and an `error` row is an
    /// assistant-role row Redline wrote, not something the model said. Serving
    /// one is silent context poisoning: a peer agent reads "the model replied
    /// X" and reasons from it. The UI still shows them (that is where the
    /// Retry button lives); only the machine-readable route drops them.
    pub fn load_thread_generic(
        &self,
        kind: &str,
        id: &str,
        limit: i64,
    ) -> rusqlite::Result<Option<Vec<GenericThreadMsg>>> {
        let Some((table, key, body, status)) = Self::thread_table(kind) else {
            return Ok(None);
        };
        let conn = self.lock_conn();
        // Appended only where there IS a status column — `voice_messages` has
        // none, and a bare filter would 500 that route instead of answering it.
        let drop_errors = status
            .map(|c| format!(" AND {c} <> 'error'"))
            .unwrap_or_default();
        // `{body} AS body` is the alias that lets `voice_messages.text` ride the
        // same reader as every `body` column.
        let sql = format!(
            "SELECT role, {body} AS body, created_at FROM {table}
             WHERE {key} = ?1{drop_errors} ORDER BY created_at DESC, id DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![id, limit.max(1)], |r| {
            Ok(GenericThreadMsg {
                role: r.get(0)?,
                body: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        let mut msgs: Vec<GenericThreadMsg> = rows.collect::<Result<_, _>>()?;
        msgs.reverse(); // oldest-first
        Ok(Some(msgs))
    }

    /// Message count + newest timestamp for a thread, for the tree route's
    /// child digests. `(0, None)` for an unknown kind or empty thread.
    pub fn thread_stats(&self, kind: &str, id: &str) -> rusqlite::Result<(i64, Option<i64>)> {
        let Some((table, key, _, _)) = Self::thread_table(kind) else {
            return Ok((0, None));
        };
        let conn = self.lock_conn();
        let sql = format!("SELECT COUNT(*), MAX(created_at) FROM {table} WHERE {key} = ?1");
        conn.query_row(&sql, params![id], |r| Ok((r.get(0)?, r.get(1)?)))
    }

    /// Best-effort human label for a thread id (a linked/mission/companion/draft
    /// title; plan sessions resolve through `sessions.project_name`).
    pub fn thread_label(&self, kind: &str, id: &str) -> Option<String> {
        let (sql, key) = match kind {
            "linked" => ("SELECT title FROM linked_sessions WHERE linked_id = ?1", id),
            "mission" => ("SELECT title FROM missions WHERE mission_id = ?1", id),
            "companion" => (
                "SELECT title FROM companion_sessions WHERE companion_id = ?1",
                id,
            ),
            "drafter" | "drafter_chat" => ("SELECT title FROM drafts WHERE draft_id = ?1", id),
            // `plan_run` is a work-item origin breadcrumb whose id IS a plan
            // session id (the orchestrator's exit report files under it), so
            // it resolves through the same row a `session` ref does.
            "session" | "plan_run" => (
                "SELECT project_name FROM sessions WHERE session_id = ?1",
                id,
            ),
            // Work-item origin breadcrumbs from the producer wave: a code
            // review resolves to the repo it reviewed, a Shipwright finding to
            // its own headline. (`librarian_run` / `friction` origins carry no
            // resolvable row on purpose — no arm.)
            "review" => (
                "SELECT repo_path FROM review_sessions WHERE review_id = ?1",
                id,
            ),
            "shipwright_finding" => (
                "SELECT summary FROM shipwright_findings WHERE id = ?1",
                id,
            ),
            _ => return None,
        };
        let conn = self.lock_conn();
        conn.query_row(sql, params![key], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten()
    }

    // -----------------------------------------------------------------------
    // Phase 4 — context access + portability (routes / export / mirror)
    // -----------------------------------------------------------------------

    /// The raw markdown of one revision (the body a `revision` ledger event
    /// references but does not own) — for snapshotting into a mirror note /
    /// export bundle at write time.
    pub fn revision_markdown(
        &self,
        session_id: &str,
        version_number: i64,
    ) -> rusqlite::Result<Option<String>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT raw_plan_markdown FROM revisions WHERE session_id = ?1 AND version_number = ?2",
            params![session_id, version_number],
            |r| r.get(0),
        )
        .optional()
    }

    /// One Agent Seat's observed workload: agent turns inside the recent
    /// window, all-time turns, and when the seat last produced anything.
    /// Feeds the Seat Assignment agent's ground-truth digest (`seatassign.rs`).
    pub fn seat_activity(&self, since_ts: i64) -> Vec<SeatActivity> {
        // (seat, FROM clause, timestamp column, extra predicate, distinct-on).
        // Every per-surface message table shares `(role, created_at)`, so the
        // shape is mostly uniform; `distinct_on` is for sources where one run
        // writes many rows and counting rows would overstate the seat.
        //
        // Seats deliberately absent report zero, which the digest states
        // explicitly:
        //   * `librarian` / `seatassign` — neither persists its runs.
        //   * `keeper` — `compaction` ledger events are written **per prompt**
        //     (up to 40 per pass), and the deterministic fallback writes them
        //     even when the summarizer agent never spawned. Counting them would
        //     report hundreds of "turns" for an agent that may never have run,
        //     inside a block labelled GROUND TRUTH. No per-run record exists,
        //     so the honest answer is to report nothing and say so.
        const SOURCES: &[(&str, &str, &str, &str, &str)] = &[
            ("companion", "companion_messages", "created_at", "role = 'assistant'", ""),
            ("browse", "browse_messages", "created_at", "role = 'assistant'", ""),
            ("linked", "linked_messages", "created_at", "role = 'assistant'", ""),
            ("mission", "mission_messages", "created_at", "role = 'assistant'", ""),
            ("voice", "voice_messages", "created_at", "role = 'assistant'", ""),
            ("drafter", "draft_chat_messages", "created_at", "role = 'assistant'", ""),
            ("memory", "mem_chat_messages", "created_at", "role = 'assistant'", ""),
            // Plan sidecar threads and Drafter comment threads BOTH write to
            // `thread_messages`; the only thing separating them is whether the
            // `comment_id` resolves to a `draft_comments` row.
            (
                "fork_plan",
                "thread_messages tm LEFT JOIN draft_comments dc ON dc.id = tm.comment_id",
                "tm.created_at",
                "tm.role = 'assistant' AND dc.id IS NULL",
                "",
            ),
            (
                "fork_drafter",
                "thread_messages tm JOIN draft_comments dc ON dc.id = tm.comment_id",
                "tm.created_at",
                "tm.role = 'assistant'",
                "",
            ),
            ("fork_review", "review_questions", "created_at", "1", ""),
            // AI review is opt-in per review, so `review_sessions` would count
            // every code review the user *opened* — including the ones they
            // never pointed the agent at. Its findings are the only real trace:
            // one run writes many annotations, hence DISTINCT.
            (
                "ai_review",
                "review_annotations",
                "created_at",
                "source = 'ai'",
                "review_id",
            ),
            ("classifier", "class_runs", "started_at", "1", ""),
        ];
        let conn = self.lock_conn();
        SOURCES
            .iter()
            .map(|(seat, from, ts, pred, distinct_on)| {
                let (window_expr, total_expr) = if distinct_on.is_empty() {
                    (
                        format!("COALESCE(SUM(CASE WHEN {ts} >= ?1 THEN 1 ELSE 0 END), 0)"),
                        "COUNT(*)".to_string(),
                    )
                } else {
                    (
                        format!(
                            "COUNT(DISTINCT CASE WHEN {ts} >= ?1 THEN {distinct_on} END)"
                        ),
                        format!("COUNT(DISTINCT {distinct_on})"),
                    )
                };
                // Best-effort per seat, exactly as `context::build_digest` is:
                // a table this build doesn't have yields zero, never an error
                // that sinks the whole digest.
                let (turns_window, turns_total, last_ts) = conn
                    .query_row(
                        &format!(
                            "SELECT {window_expr}, {total_expr}, MAX({ts})
                             FROM {from} WHERE {pred}"
                        ),
                        params![since_ts],
                        |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, i64>(1)?,
                                r.get::<_, Option<i64>>(2)?,
                            ))
                        },
                    )
                    .unwrap_or((0, 0, None));
                SeatActivity {
                    seat: (*seat).to_string(),
                    turns_window,
                    turns_total,
                    last_ts,
                }
            })
            .collect()
    }

    /// Approved sessions that have never been exported as a bundle — the
    /// Librarian's deferred F6 "un-exported approved plan" friction, now real.
    /// Returns `(session_id, project_name, approved_at)`, oldest first.
    pub fn un_exported_approved_sessions(&self) -> rusqlite::Result<Vec<(String, String, i64)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.project_name, s.created_at
             FROM sessions s
             WHERE s.status = 'approved'
               AND NOT EXISTS (
                   SELECT 1 FROM plan_exports e
                   WHERE e.session_id = s.session_id
               )
             ORDER BY s.created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        })?;
        rows.collect()
    }

    // `snapshot_to` (VACUUM INTO) is `PolisStore`'s since Polis E1
    // (`polis_store::PolisStore::snapshot_to`, reached through `Deref`); the
    // Redline copy that lived here was byte-equivalent minus its
    // remove-the-destination-first line, which `snapshot_database` in lib.rs
    // now does before the call. Kept off this impl so the two never collide
    // (`tests/polis_store_guard.rs`).

    // ------------------------------------------------------------------
    // Polis ClassMemory (Phase 2): the catalog over the lake
    // ------------------------------------------------------------------

    pub fn reject_class_proposal(&self, id: i64) -> rusqlite::Result<()> {
        {
            let conn = self.lock_conn();
            // Reject just drops the row — so without this, every rejection of a
            // classifier proposal left no trace at all of the agent having been
            // wrong. Read the op first, while the row still exists.
            let op = PolisStore::delete_class_proposal(&conn, id)?;
            drop(conn);
            let _ = self.record_friction(
                "proposal_rejected",
                Some("memory"),
                None,
                op.as_deref(),
            );
        }
        Ok(())
    }

    // --- supersession (temporal validity over decisions) ---

    // --- user notes (Second Brain P3) ---

    // --- class observations (agent-derived patterns) ---

    // --- class runs + lake delta ---

    /// Friction rows for the Orchestration digest: every `in_review` session with
    /// its **open**-comment count and `created_at`, oldest first. Returns
    /// `(session_id, project_name, created_at, unresolved_count)`. Pure read;
    /// the orchestrator ranks these.
    ///
    /// Open means the comment is still waiting on somebody: `draft` (written,
    /// not submitted), `submitted` (sent, no resolution back yet), `reopened`
    /// (resolution rejected, going round again). `resolved` and `accepted` are
    /// answered; `withdrawn` is gone.
    ///
    /// This deliberately does NOT key off `resolution_accepted_at`. That column
    /// is written only by an explicit reviewer Accept (`accept_resolution`), so
    /// counting `IS NULL` scored every answered-but-never-formally-accepted
    /// comment as friction — which is most of them, and it drowned every
    /// downstream ranking (Librarian, Shipwright, `build_digest`) in noise.
    pub fn in_review_friction(&self) -> rusqlite::Result<Vec<(String, String, i64, i64)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT s.session_id, s.project_name, s.created_at,
                (SELECT COUNT(*) FROM comments c
                   WHERE c.session_id = s.session_id
                     AND c.status IN ('draft', 'submitted', 'reopened')) AS unresolved
             FROM sessions s
             WHERE s.status = 'in_review'
             ORDER BY s.created_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // --- memory map (Second Brain P5) ---

    /// Best-effort evidence bundle for one decision event — what the supersede
    /// verifier agent reads to adjudicate "does the newer decision genuinely
    /// replace the older one?". Resolves the referenced comment body, review
    /// annotation, and/or the session's plan heading when available; a decision
    /// whose referents were deleted still yields its ledger facts.
    pub fn decision_event_context(&self, seq: i64) -> rusqlite::Result<Option<String>> {
        let conn = self.lock_conn();
        let row: Option<(String, i64, Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT kind, ts, session_id, ref_kind, ref_id
                 FROM ledger_events WHERE seq = ?1",
                params![seq],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((kind, ts, session_id, ref_kind, ref_id)) = row else {
            return Ok(None);
        };
        let snip = |s: &str| -> String {
            let one = s.replace('\n', " ");
            let cut: String = one.chars().take(200).collect();
            if one.chars().count() > 200 { format!("{cut}…") } else { cut }
        };
        let mut out = format!("event #{seq} kind={kind} ts={ts}");
        match (ref_kind.as_deref(), ref_id.as_deref()) {
            (Some("comment"), Some(cid)) => {
                let c: Option<(String, String)> = conn
                    .query_row(
                        "SELECT body, status FROM comments WHERE id = ?1 LIMIT 1",
                        params![cid],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if let Some((body, status)) = c {
                    out.push_str(&format!(" | comment[{status}]: {}", snip(&body)));
                }
            }
            (Some("review_annotation"), Some(aid)) => {
                let a: Option<(String, String, Option<String>)> = conn
                    .query_row(
                        "SELECT body, status, resolution
                         FROM review_annotations WHERE id = ?1 LIMIT 1",
                        params![aid],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                if let Some((body, status, resolution)) = a {
                    out.push_str(&format!(" | annotation[{status}]: {}", snip(&body)));
                    if let Some(res) = resolution.as_deref().filter(|s| !s.is_empty()) {
                        out.push_str(&format!(" | resolution: {}", snip(res)));
                    }
                }
            }
            _ => {}
        }
        if let Some(sid) = session_id.as_deref().filter(|s| !s.is_empty()) {
            let plan: Option<String> = conn
                .query_row(
                    "SELECT raw_plan_markdown FROM revisions
                     WHERE session_id = ?1 ORDER BY version_number DESC LIMIT 1",
                    params![sid],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(md) = plan {
                let heading = md
                    .lines()
                    .find(|l| l.trim_start().starts_with('#'))
                    .unwrap_or_default()
                    .trim();
                if !heading.is_empty() {
                    out.push_str(&format!(" | plan: {}", snip(heading)));
                }
            }
        }
        Ok(Some(out))
    }

    pub fn insert_comment(
        &self,
        session_id: &str,
        version_number: u32,
        comment: &Comment,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let (edit_original, edit_revised) = match &comment.edit {
            Some(e) => (Some(e.original.as_str()), Some(e.revised.as_str())),
            None => (None, None),
        };
        let (res_body, res_version, res_accepted) = match &comment.resolution {
            Some(r) => (Some(r.body.as_str()), Some(r.appeared_in_version), r.accepted_at),
            None => (None, None, None),
        };
        let structural_json = comment
            .structural
            .as_ref()
            .and_then(|s| serde_json::to_string(s).ok());
        let (sel_char_start, sel_char_end, sel_quoted_text, sel_sub_block_id) =
            match &comment.selection {
                Some(s) => (
                    Some(s.char_start as i64),
                    Some(s.char_end as i64),
                    Some(s.quoted_text.as_str()),
                    s.sub_block_id.as_deref(),
                ),
                None => (None, None, None, None),
            };
        let reopen_history_json = reopen_history_to_json(&comment.reopen_history);
        conn.execute(
            "INSERT INTO comments (
                id, session_id, version_number, type, scope, anchor_id,
                body, edit_original, edit_revised, created_at, status,
                resolution_body, resolution_version, resolution_accepted_at,
                block_id, structural_json,
                sel_char_start, sel_char_end, sel_quoted_text,
                sel_sub_block_id, reopen_note, reopen_history, actionable,
                author, agent_state, reviewer,
                external_created_at, share_request_id, attachments
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
            params![
                comment.id,
                session_id,
                version_number,
                comment.kind.as_str(),
                comment.scope.map(|s| s.as_str()),
                comment.anchor_id,
                comment.body,
                edit_original,
                edit_revised,
                comment.created_at,
                comment.status.as_str(),
                res_body,
                res_version,
                res_accepted,
                comment.block_id,
                structural_json,
                sel_char_start,
                sel_char_end,
                sel_quoted_text,
                sel_sub_block_id,
                comment.reopen_note,
                reopen_history_json,
                comment.actionable as i64,
                comment.author,
                comment.agent_state,
                comment.reviewer,
                comment.external_created_at,
                comment.share_request_id,
                attachments_to_json(&comment.attachments),
            ],
        )?;
        Self::touch_session(&conn, session_id, comment.created_at);
        Ok(())
    }

    pub fn update_comment(&self, session_id: &str, comment: &Comment) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let (edit_original, edit_revised) = match &comment.edit {
            Some(e) => (Some(e.original.as_str()), Some(e.revised.as_str())),
            None => (None, None),
        };
        let (res_body, res_version, res_accepted) = match &comment.resolution {
            Some(r) => (Some(r.body.as_str()), Some(r.appeared_in_version), r.accepted_at),
            None => (None, None, None),
        };
        let structural_json = comment
            .structural
            .as_ref()
            .and_then(|s| serde_json::to_string(s).ok());
        let (sel_char_start, sel_char_end, sel_quoted_text, sel_sub_block_id) =
            match &comment.selection {
                Some(s) => (
                    Some(s.char_start as i64),
                    Some(s.char_end as i64),
                    Some(s.quoted_text.as_str()),
                    s.sub_block_id.as_deref(),
                ),
                None => (None, None, None, None),
            };
        let reopen_history_json = reopen_history_to_json(&comment.reopen_history);
        conn.execute(
            "UPDATE comments SET
                scope = ?1,
                body = ?2,
                edit_original = ?3,
                edit_revised = ?4,
                status = ?5,
                resolution_body = ?6,
                resolution_version = ?7,
                resolution_accepted_at = ?8,
                block_id = ?9,
                structural_json = ?10,
                sel_char_start = ?11,
                sel_char_end = ?12,
                sel_quoted_text = ?13,
                sel_sub_block_id = ?14,
                reopen_note = ?15,
                reopen_history = ?16,
                actionable = ?17,
                author = ?18,
                agent_state = ?19,
                reviewer = ?20,
                external_created_at = ?21,
                share_request_id = ?22,
                attachments = ?23
             WHERE session_id = ?24 AND id = ?25",
            params![
                comment.scope.map(|s| s.as_str()),
                comment.body,
                edit_original,
                edit_revised,
                comment.status.as_str(),
                res_body,
                res_version,
                res_accepted,
                comment.block_id,
                structural_json,
                sel_char_start,
                sel_char_end,
                sel_quoted_text,
                sel_sub_block_id,
                comment.reopen_note,
                reopen_history_json,
                comment.actionable as i64,
                comment.author,
                comment.agent_state,
                comment.reviewer,
                comment.external_created_at,
                comment.share_request_id,
                attachments_to_json(&comment.attachments),
                session_id,
                comment.id,
            ],
        )?;
        Ok(())
    }

    /// Record a minted share link (idempotent on request_id — a re-record
    /// from the localStorage migration overwrites with identical data).
    pub fn record_share(&self, share: &ShareRecord) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT OR REPLACE INTO shares (
                request_id, session_id, reviewer_name, note, base_version, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                share.request_id,
                share.session_id,
                share.reviewer_name,
                share.note,
                share.base_version,
                share.created_at,
            ],
        )?;
        Ok(())
    }

    /// Forget a share. Its returns (and their imported comments) stay — they
    /// are the session's history, not the link's.
    pub fn delete_share(&self, request_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM shares WHERE request_id = ?1", params![request_id])?;
        Ok(())
    }

    pub fn list_shares(&self, session_id: &str) -> rusqlite::Result<Vec<ShareRecord>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT request_id, session_id, reviewer_name, note, base_version, created_at
             FROM shares WHERE session_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ShareRecord {
                request_id: row.get(0)?,
                session_id: row.get(1)?,
                reviewer_name: row.get(2)?,
                note: row.get(3)?,
                base_version: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn record_share_return(&self, ret: &ShareReturnRecord) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        let comment_ids_json =
            serde_json::to_string(&ret.comment_ids).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO share_returns (
                id, request_id, session_id, reviewer_name, imported_at,
                landed_version, placed, orphans, comment_ids
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                ret.id,
                ret.request_id,
                ret.session_id,
                ret.reviewer_name,
                ret.imported_at,
                ret.landed_version,
                ret.placed,
                ret.orphans,
                comment_ids_json,
            ],
        )?;
        Ok(())
    }

    pub fn list_share_returns(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Vec<ShareReturnRecord>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, request_id, session_id, reviewer_name, imported_at,
                    landed_version, placed, orphans, comment_ids
             FROM share_returns WHERE session_id = ?1 ORDER BY imported_at DESC",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            let comment_ids_json: String = row.get(8)?;
            Ok(ShareReturnRecord {
                id: row.get(0)?,
                request_id: row.get(1)?,
                session_id: row.get(2)?,
                reviewer_name: row.get(3)?,
                imported_at: row.get(4)?,
                landed_version: row.get(5)?,
                placed: row.get(6)?,
                orphans: row.get(7)?,
                comment_ids: serde_json::from_str(&comment_ids_json).unwrap_or_default(),
            })
        })?;
        rows.collect()
    }

    /// Targeted attach-state write — callable from the detach drop-guard with
    /// just a session id, no session clone needed.
    pub fn set_session_attach_state(
        &self,
        session_id: &str,
        state: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE sessions SET attach_state = ?1 WHERE session_id = ?2",
            params![state, session_id],
        )?;
        Self::touch_session(&conn, session_id, crate::state::now_millis());
        Ok(())
    }

    /// Run-lifecycle transition (orchestrated executions). Stamps
    /// `run_updated_at` and journals the transition (the Companion feed gets
    /// a per-plan timeline for free). Returns whether the state actually
    /// changed — callers emit the chip event only on a real transition.
    /// A later beacon simply overwrites `stalled`; there is no ordering
    /// enforcement, the beacons are the truth.
    pub fn set_run_state(&self, session_id: &str, state: &str) -> rusqlite::Result<bool> {
        let changed = {
            let conn = self.lock_conn();
            let prev: Option<Option<String>> = conn
                .query_row(
                    "SELECT run_state FROM sessions WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(prev) = prev else {
                return Ok(false); // unknown session — no row, no journal
            };
            if prev.as_deref() == Some(state) {
                false
            } else {
                conn.execute(
                    "UPDATE sessions SET run_state = ?1, run_updated_at = ?2
                     WHERE session_id = ?3",
                    params![state, crate::ledger::now_millis(), session_id],
                )?;
                true
            }
        };
        if changed {
            // Outside the conn lock — append_journal locks it again.
            let _ = self.append_journal(
                "run_state",
                Some("session"),
                Some(session_id),
                Some(state),
                None,
            );
        }
        Ok(changed)
    }

    /// A session's current run state (orchestrated runs only; `None` for a
    /// plain Approve or an unknown session).
    pub fn get_run_state(&self, session_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT run_state FROM sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Insert-or-replace a run's exit report. The resolution columns are
    /// preserved-by-reset deliberately: a re-run's fresh report reopens the
    /// human verdict (the previous resolution described a previous run).
    pub fn upsert_plan_run(
        &self,
        plan_session_id: &str,
        report_json: &str,
        script_path: Option<&str>,
        workflow_ran: bool,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO plan_runs (plan_session_id, report_json, script_path, workflow_ran,
                                    resolution, resolution_note, resolved_at, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5)
             ON CONFLICT(plan_session_id) DO UPDATE SET
                report_json = excluded.report_json,
                script_path = excluded.script_path,
                workflow_ran = excluded.workflow_ran,
                resolution = NULL,
                resolution_note = NULL,
                resolved_at = NULL,
                created_at = excluded.created_at",
            params![
                plan_session_id,
                report_json,
                script_path,
                workflow_ran as i64,
                crate::ledger::now_millis()
            ],
        )?;
        Ok(())
    }

    /// The human verdict on a run: resolved / needs_follow_up / abandoned.
    /// Returns false when no report row exists to resolve.
    pub fn resolve_plan_run(
        &self,
        plan_session_id: &str,
        resolution: &str,
        note: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE plan_runs SET resolution = ?1, resolution_note = ?2, resolved_at = ?3
             WHERE plan_session_id = ?4",
            params![resolution, note, crate::ledger::now_millis(), plan_session_id],
        )?;
        Ok(n > 0)
    }

    pub fn get_plan_run(&self, plan_session_id: &str) -> Option<PlanRunRow> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT plan_session_id, report_json, script_path, workflow_ran,
                    resolution, resolution_note, resolved_at, created_at
             FROM plan_runs WHERE plan_session_id = ?1",
            params![plan_session_id],
            |row| {
                Ok(PlanRunRow {
                    plan_session_id: row.get(0)?,
                    report_json: row.get(1)?,
                    script_path: row.get(2)?,
                    workflow_ran: row.get::<_, i64>(3)? != 0,
                    resolution: row.get(4)?,
                    resolution_note: row.get(5)?,
                    resolved_at: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .ok()
    }

    /// Anchor a fresh orchestrated launch. A re-run overwrites the anchor and
    /// resets the discovery columns — the previous run's artifacts describe a
    /// previous run, and the watcher re-discovers from the new transcript.
    pub fn upsert_orchestration(
        &self,
        plan_session_id: &str,
        claude_session_id: &str,
        transcript_path: &str,
        cwd: Option<&str>,
        terminal_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO orchestrations (plan_session_id, claude_session_id, transcript_path,
                                         cwd, started_at, run_id, transcript_dir, script_path, mode,
                                         terminal_id)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6)
             ON CONFLICT(plan_session_id) DO UPDATE SET
                claude_session_id = excluded.claude_session_id,
                transcript_path = excluded.transcript_path,
                cwd = excluded.cwd,
                started_at = excluded.started_at,
                run_id = NULL,
                transcript_dir = NULL,
                script_path = NULL,
                mode = NULL,
                terminal_id = COALESCE(excluded.terminal_id, terminal_id)",
            params![
                plan_session_id,
                claude_session_id,
                transcript_path,
                cwd,
                crate::ledger::now_millis(),
                terminal_id
            ],
        )?;
        Ok(())
    }

    /// Backfill discovery columns as the watcher learns them. COALESCE-style
    /// partial update: a passed value wins, an omitted (None) column keeps
    /// what was already discovered. New-value-wins matters for `mode` — a
    /// premature sequential fallback upgrades to `workflow` the moment the
    /// launch line appears.
    pub fn update_orchestration_discovery(
        &self,
        plan_session_id: &str,
        run_id: Option<&str>,
        transcript_dir: Option<&str>,
        script_path: Option<&str>,
        mode: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE orchestrations SET
                run_id = COALESCE(?2, run_id),
                transcript_dir = COALESCE(?3, transcript_dir),
                script_path = COALESCE(?4, script_path),
                mode = COALESCE(?5, mode)
             WHERE plan_session_id = ?1",
            params![plan_session_id, run_id, transcript_dir, script_path, mode],
        )?;
        Ok(())
    }

    pub fn get_orchestration(&self, plan_session_id: &str) -> Option<OrchestrationRow> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT o.plan_session_id, o.claude_session_id, o.transcript_path, o.cwd,
                    o.started_at, o.run_id, o.transcript_dir, o.script_path, o.mode,
                    o.terminal_id, s.run_state
             FROM orchestrations o
             LEFT JOIN sessions s ON s.session_id = o.plan_session_id
             WHERE o.plan_session_id = ?1",
            params![plan_session_id],
            Self::orchestration_from_row,
        )
        .ok()
    }

    /// Every anchored run, newest launch first, with the live run-state joined
    /// in (the History tab's data source and the rehydration sweep's input).
    pub fn list_orchestrations(&self) -> rusqlite::Result<Vec<OrchestrationRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT o.plan_session_id, o.claude_session_id, o.transcript_path, o.cwd,
                    o.started_at, o.run_id, o.transcript_dir, o.script_path, o.mode,
                    o.terminal_id, s.run_state
             FROM orchestrations o
             LEFT JOIN sessions s ON s.session_id = o.plan_session_id
             ORDER BY o.started_at DESC, o.rowid DESC",
        )?;
        let rows = stmt
            .query_map([], Self::orchestration_from_row)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// `plan_session_id → mode` for every run whose mode the watcher has
    /// settled. Its own tiny query rather than a `list_orchestrations` walk
    /// because the sidebar's run chip needs one string per session and
    /// nothing else — and it needs it on every summary refresh.
    ///
    /// The mode matters at chip scale because `sequential` is not a
    /// configuration, it is a DEGRADATION: `runwatch` writes it when no
    /// Workflow run was found and the orchestrator fell back to running the
    /// plan one subtask at a time. Rendered neutrally (or not at all) it is
    /// indistinguishable from the multi-agent run the user asked for.
    pub fn run_modes(&self) -> std::collections::HashMap<String, String> {
        let conn = self.lock_conn();
        let mut out = std::collections::HashMap::new();
        let Ok(mut stmt) = conn.prepare(
            "SELECT plan_session_id, mode FROM orchestrations WHERE mode IS NOT NULL",
        ) else {
            return out;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return out;
        };
        for (sid, mode) in rows.filter_map(Result::ok) {
            out.insert(sid, mode);
        }
        out
    }

    fn orchestration_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrchestrationRow> {
        Ok(OrchestrationRow {
            plan_session_id: row.get(0)?,
            claude_session_id: row.get(1)?,
            transcript_path: row.get(2)?,
            cwd: row.get(3)?,
            started_at: row.get(4)?,
            run_id: row.get(5)?,
            transcript_dir: row.get(6)?,
            script_path: row.get(7)?,
            mode: row.get(8)?,
            terminal_id: row.get(9)?,
            run_state: row.get(10)?,
        })
    }

    /// Clear a session's run columns back to NULL — "this session has no run".
    /// Exists because `set_run_state` takes `&str` and structurally cannot
    /// write NULL; the click-is-not-evidence rollback needs exactly that.
    /// Returns whether anything was cleared. Journals as `run_state: cleared`.
    pub fn clear_run_state(&self, session_id: &str) -> rusqlite::Result<bool> {
        let changed = {
            let conn = self.lock_conn();
            conn.execute(
                "UPDATE sessions SET run_state = NULL, run_updated_at = NULL
                 WHERE session_id = ?1 AND run_state IS NOT NULL",
                params![session_id],
            )? > 0
        };
        if changed {
            // Outside the conn lock — append_journal locks it again.
            let _ = self.append_journal(
                "run_state",
                Some("session"),
                Some(session_id),
                Some("cleared"),
                None,
            );
        }
        Ok(changed)
    }

    /// Drop a run's monitor anchor. `reset_run` uses this so the Runs surface
    /// shows nothing rather than a stale corpse (a re-run's upsert would reset
    /// the columns anyway; the delete is about honest emptiness).
    pub fn delete_orchestration(&self, plan_session_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "DELETE FROM orchestrations WHERE plan_session_id = ?1",
            params![plan_session_id],
        )?;
        Ok(n > 0)
    }

    /// Drop a run's exit report (the `reset_run` counterpart for `plan_runs`).
    pub fn delete_plan_run(&self, plan_session_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "DELETE FROM plan_runs WHERE plan_session_id = ?1",
            params![plan_session_id],
        )?;
        Ok(n > 0)
    }

    /// Startup sweep: a held POST never survives a restart, so every session
    /// persisted as 'held' was orphaned by the previous instance.
    pub fn detach_held_sessions(&self) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE sessions SET attach_state = 'detached' WHERE attach_state = 'held'",
            [],
        )?;
        Ok(())
    }

    /// Move a comment to another revision. `update_comment` deliberately never
    /// touches `version_number`; carrying drafts onto a restored revision is
    /// the one place that re-homes a comment.
    pub fn set_comment_revision(
        &self,
        session_id: &str,
        comment_id: &str,
        version_number: u32,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE comments SET version_number = ?1 WHERE session_id = ?2 AND id = ?3",
            params![version_number, session_id, comment_id],
        )?;
        Ok(())
    }

    pub fn delete_comment(&self, session_id: &str, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        // Cascade the comment's discussion thread. Comment ids are reused
        // (`c-{max+1}`), so leaving these rows would resurface a deleted
        // comment's answer under the next comment that inherits its id.
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![session_id, comment_id],
        )?;
        conn.execute(
            "DELETE FROM comments WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    /// Delete a session and its revisions/comments. Explicit child deletes so
    /// this is correct regardless of the `foreign_keys` PRAGMA.
    /// Move every row for `old_id` to `new_id` across the session-scoped tables.
    /// Used to rebind a held plan onto the live session when a restore handshake
    /// lands under a different id than the plan it names (resume forks the id, or
    /// the command was pasted into a running Claude REPL). Foreign keys aren't
    /// enforced on this connection (see `delete_session`, which deletes each
    /// table by hand), so a straight per-table column UPDATE is safe and
    /// order-independent. Caller guarantees `new_id` holds no session yet.
    pub fn rekey_session(&self, old_id: &str, new_id: &str) -> rusqlite::Result<()> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        // Foreign keys are enforced on this connection, and the session-scoped
        // tables form a chain (comments/briefs → revisions → sessions). Renaming
        // them one at a time transiently dangles a child, so defer FK checks to
        // commit, by which point every table is consistent again.
        tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        // `briefs` is created lazily and absent from fresh (test) DBs; skip any
        // table that doesn't exist. Order is irrelevant under deferred checks.
        for table in ["thread_messages", "comments", "briefs", "revisions", "sessions"] {
            let present: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                params![table],
                |r| r.get(0),
            )?;
            if present == 0 {
                continue;
            }
            tx.execute(
                &format!("UPDATE {table} SET session_id = ?1 WHERE session_id = ?2"),
                params![new_id, old_id],
            )?;
        }
        tx.commit()
    }

    /// Rewrite stored attachment paths after a session was re-keyed.
    ///
    /// Attachment `path`s are absolute and embed the session id
    /// (`…/attachments/<session_id>/<file>`), so moving the directory without
    /// this leaves every comment pointing at a directory that no longer exists
    /// — and the failure would only surface later, when Claude tried to read
    /// the file named in a payload. Runs AFTER `rekey_session`, so the rows
    /// already carry the new id.
    pub fn rekey_attachment_paths(&self, old_id: &str, new_id: &str) -> rusqlite::Result<()> {
        let from = format!("/attachments/{old_id}/");
        let to = format!("/attachments/{new_id}/");
        let conn = self.lock_conn();
        for table in ["comments", "thread_messages"] {
            conn.execute(
                &format!(
                    "UPDATE {table} SET attachments = REPLACE(attachments, ?1, ?2)
                     WHERE session_id = ?3 AND attachments IS NOT NULL"
                ),
                params![from, to, new_id],
            )?;
        }
        Ok(())
    }

    pub fn delete_session(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM comments WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM revisions WHERE session_id = ?1",
            params![session_id],
        )?;
        // Staged (never-written) offers go with the session that produced them.
        // NOTE: `voice_messages` / `voice_sessions` are *not* cleared here —
        // pre-existing, and out of scope for this change.
        conn.execute(
            "DELETE FROM comment_offers WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    // --- Fork-agent discussion threads (Phase 2) ---------------------------
    // `thread_messages` rows are terminal: written only when a turn finishes.
    // `comments.fork_session_id` is a DB-only column (not on the `Comment`
    // struct) so resuming a fork never reads a stale in-memory value.

    pub fn insert_thread_message(&self, msg: &ThreadMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO thread_messages
                (id, session_id, comment_id, role, body, status, created_at,
                 attachments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                msg.id,
                msg.session_id,
                msg.comment_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
                attachments_to_json(&msg.attachments),
            ],
        )?;
        Self::touch_session(&conn, &msg.session_id, msg.created_at);
        Ok(())
    }

    pub fn load_thread(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> rusqlite::Result<Vec<ThreadMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, comment_id, role, body, status, created_at,
                    attachments
             FROM thread_messages
             WHERE session_id = ?1 AND comment_id = ?2
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![session_id, comment_id], |row| {
            Ok(ThreadMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                comment_id: row.get(2)?,
                role: row.get(3)?,
                body: row.get(4)?,
                status: row.get(5)?,
                created_at: row.get(6)?,
                attachments: attachments_from_json(row.get(7)?),
            })
        })?;
        rows.collect()
    }

    pub fn delete_thread(&self, session_id: &str, comment_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM thread_messages WHERE session_id = ?1 AND comment_id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    /// A plan comment's discussion fork as `(fork_session_id, backend)`.
    ///
    /// The pair is read TOGETHER because neither half is usable alone: the id
    /// says what to resume and the backend says which binary can resume it,
    /// and handing one CLI the other's id does not error — it silently starts
    /// a fresh conversation. A legacy row (non-null id, null backend) is a
    /// Claude fork, because Claude was the only implementation when it was
    /// written.
    pub fn get_comment_fork(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> Option<(String, String)> {
        let conn = self.lock_conn();
        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT fork_session_id, fork_backend FROM comments
                 WHERE session_id = ?1 AND id = ?2",
                params![session_id, comment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        let (fork, backend) = row?;
        let fork = fork.filter(|f| !f.trim().is_empty())?;
        let backend = backend
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "claude-code".to_string());
        Some((fork, backend))
    }

    pub fn set_comment_fork(
        &self,
        session_id: &str,
        comment_id: &str,
        fork_session_id: &str,
        backend: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE comments SET fork_session_id = ?1, fork_backend = ?2
             WHERE session_id = ?3 AND id = ?4",
            params![fork_session_id, backend, session_id, comment_id],
        )?;
        Ok(())
    }

    /// Discarding a thread clears BOTH fields. Leaving a stale backend behind
    /// would make the next fork look like a mismatch against a fork id that no
    /// longer exists.
    pub fn clear_comment_fork(
        &self,
        session_id: &str,
        comment_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE comments SET fork_session_id = NULL, fork_backend = NULL
             WHERE session_id = ?1 AND id = ?2",
            params![session_id, comment_id],
        )?;
        Ok(())
    }

    /// True if `session_id` is the forked session of any comment *or* the voice
    /// agent — used by `handle_plan` to ignore stray `ExitPlanMode` POSTs from a
    /// fork agent.
    pub fn is_known_fork_session(&self, session_id: &str) -> bool {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT 1 FROM comments WHERE fork_session_id = ?1
             UNION ALL
             SELECT 1 FROM voice_sessions WHERE fork_session_id = ?1
             LIMIT 1",
            params![session_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    // --- Browser browse-agent threads --------------------------------------
    // Mirrors the fork-thread helpers above, keyed by a per-tab `browse_id`
    // instead of (session_id, comment_id). The agent's resumable claude
    // session id is tracked in `browse_threads`, not on any in-memory struct.

    pub fn insert_browse_message(&self, msg: &BrowseMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO browse_messages
                (id, browse_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.browse_id,
                msg.role,
                msg.body,
                msg.status,
                msg.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn load_browse_thread(&self, browse_id: &str) -> rusqlite::Result<Vec<BrowseMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, browse_id, role, body, status, created_at
             FROM browse_messages
             WHERE browse_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![browse_id], |row| {
            Ok(BrowseMessage {
                id: row.get(0)?,
                browse_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Delete a tab's whole thread: its turns and its persisted agent session.
    pub fn delete_browse_thread(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM browse_messages WHERE browse_id = ?1",
            params![browse_id],
        )?;
        conn.execute(
            "DELETE FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    pub fn get_browse_session(&self, browse_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_browse_session(
        &self,
        browse_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO browse_threads (browse_id, claude_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(browse_id) DO UPDATE SET claude_session_id = ?2",
            params![browse_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget a tab's resumable `claude` session id WITHOUT touching its message
    /// history. Used to recover from a *poisoned* session — one whose accumulated
    /// tool-output context (page snapshots, WebFetch, code reads, git diffs) grew
    /// past the model's window and now throws on every `--resume`. Dropping the id
    /// makes the next turn start a fresh session (re-embedding a snapshot) instead
    /// of re-sending the over-limit context forever. The visible thread is kept.
    pub fn clear_browse_session(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM browse_threads WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    // --- Browse working lists ----------------------------------------------
    // A tab's punch list, keyed on the same `browse_id` as its discussion. No
    // agent and no thread, so — unlike every fork/sidecar surface — this
    // deliberately does NOT join `thread_table`: a list item is a private note,
    // not a curation decision, and filing it as one would pollute the lake.
    // See browse_list.rs.

    pub fn get_browse_list(&self, browse_id: &str) -> rusqlite::Result<Option<BrowseList>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT browse_id, template, title, created_at, updated_at
             FROM browse_lists WHERE browse_id = ?1",
            params![browse_id],
            |row| {
                Ok(BrowseList {
                    browse_id: row.get(0)?,
                    template: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
    }

    /// Create the list row, or re-point an existing one at a new template. The
    /// upsert keeps `created_at` — switching template is an edit of the same
    /// list, not a new one, and the items carry over.
    pub fn upsert_browse_list(&self, l: &BrowseList) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO browse_lists (browse_id, template, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(browse_id) DO UPDATE SET
                 template = ?2, title = ?3, updated_at = ?5",
            params![l.browse_id, l.template, l.title, l.created_at, l.updated_at],
        )?;
        Ok(())
    }

    pub fn list_browse_list_items(
        &self,
        browse_id: &str,
    ) -> rusqlite::Result<Vec<BrowseListItem>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, browse_id, kind, body, done, sort_idx,
                    page_url, page_title, locator, created_at, updated_at
             FROM browse_list_items
             WHERE browse_id = ?1
             ORDER BY sort_idx, created_at, id",
        )?;
        let rows = stmt.query_map(params![browse_id], row_to_browse_list_item)?;
        rows.collect()
    }

    pub fn insert_browse_list_item(&self, it: &BrowseListItem) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO browse_list_items
                (id, browse_id, kind, body, done, sort_idx,
                 page_url, page_title, locator, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                it.id,
                it.browse_id,
                it.kind,
                it.body,
                it.done as i64,
                it.sort_idx,
                it.page_url,
                it.page_title,
                it.locator,
                it.created_at,
                it.updated_at,
            ],
        )?;
        Ok(())
    }

    /// The next append slot. `MAX(sort_idx)` over the tab's items, so an append
    /// lands after everything the user can see — including after a reorder that
    /// rewrote the indices.
    pub fn next_browse_list_sort(&self, browse_id: &str) -> rusqlite::Result<i64> {
        let conn = self.lock_conn();
        let max: Option<i64> = conn.query_row(
            "SELECT MAX(sort_idx) FROM browse_list_items WHERE browse_id = ?1",
            params![browse_id],
            |row| row.get(0),
        )?;
        Ok(max.unwrap_or(-1) + 1)
    }

    pub fn get_browse_list_item(&self, id: &str) -> rusqlite::Result<Option<BrowseListItem>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT id, browse_id, kind, body, done, sort_idx,
                    page_url, page_title, locator, created_at, updated_at
             FROM browse_list_items WHERE id = ?1",
            params![id],
            row_to_browse_list_item,
        )
        .optional()
    }

    /// Write back a whole item. The partial-edit shape lives in browse_list.rs,
    /// which reads the row, applies the patch and calls this — so there is one
    /// place that knows which fields an edit may touch.
    pub fn update_browse_list_item(&self, it: &BrowseListItem) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE browse_list_items
                SET kind = ?2, body = ?3, done = ?4, sort_idx = ?5,
                    page_url = ?6, page_title = ?7, locator = ?8, updated_at = ?9
             WHERE id = ?1",
            params![
                it.id,
                it.kind,
                it.body,
                it.done as i64,
                it.sort_idx,
                it.page_url,
                it.page_title,
                it.locator,
                it.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Write ONLY the component pointer.
    ///
    /// The background locator agent finishes long after the item was written,
    /// and the user has very likely edited the body in the meantime — a
    /// read-modify-write of the whole row here would silently restore the text
    /// they just changed. `updated_at` is deliberately left alone too: the
    /// agent refining a pointer is not the user touching the item.
    ///
    /// Returns whether a row was actually hit, so the caller can stay quiet
    /// about an item the user deleted while the agent was thinking.
    pub fn set_browse_list_item_locator(
        &self,
        id: &str,
        locator: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE browse_list_items SET locator = ?2 WHERE id = ?1",
            params![id, locator],
        )?;
        Ok(n > 0)
    }

    pub fn delete_browse_list_item(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute("DELETE FROM browse_list_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Rewrite the order from the given ids, in one transaction. Ids that do
    /// not belong to this tab are ignored rather than reassigned — a reorder
    /// must never be able to steal another tab's item.
    pub fn reorder_browse_list(&self, browse_id: &str, ids: &[String]) -> rusqlite::Result<()> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE browse_list_items SET sort_idx = ?1
                 WHERE id = ?2 AND browse_id = ?3",
                params![i as i64, id, browse_id],
            )?;
        }
        tx.commit()
    }

    /// Drop the whole list — items and the row itself. Mirrors
    /// `delete_browse_thread`: clearing means the list is gone, not emptied,
    /// so the next open lands back on the template chooser.
    pub fn delete_browse_list(&self, browse_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM browse_list_items WHERE browse_id = ?1",
            params![browse_id],
        )?;
        conn.execute(
            "DELETE FROM browse_lists WHERE browse_id = ?1",
            params![browse_id],
        )?;
        Ok(())
    }

    // --- Missions ----------------------------------------------------------
    // The research-mission orchestrator: one shared goal across the browser
    // pane, with curated pins (`mission_findings`) and a resumable chat
    // (`mission_messages` + the `claude_session_id` on the row). Mirrors the
    // browse helpers above but keyed by `mission_id`. See mission.rs.

    pub fn insert_mission(&self, m: &Mission) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO missions
                (mission_id, title, goal, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![m.mission_id, m.title, m.goal, m.status, m.created_at, m.updated_at],
        )?;
        Ok(())
    }

    pub fn get_mission(&self, mission_id: &str) -> rusqlite::Result<Option<Mission>> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT mission_id, title, goal, status, created_at, updated_at
             FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| {
                Ok(Mission {
                    mission_id: row.get(0)?,
                    title: row.get(1)?,
                    goal: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
    }

    /// Missions newest-first (active before archived, then by recency), for the
    /// start/switch/resume menu.
    pub fn list_missions(&self) -> rusqlite::Result<Vec<Mission>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT mission_id, title, goal, status, created_at, updated_at
             FROM missions
             ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Mission {
                mission_id: row.get(0)?,
                title: row.get(1)?,
                goal: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Update a mission's goal (and/or title) and bump `updated_at`.
    pub fn update_mission_goal(
        &self,
        mission_id: &str,
        title: &str,
        goal: &str,
        updated_at: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE missions SET title = ?2, goal = ?3, updated_at = ?4
             WHERE mission_id = ?1",
            params![mission_id, title, goal, updated_at],
        )?;
        Ok(())
    }

    pub fn get_mission_session(&self, mission_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_mission_session(
        &self,
        mission_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE missions SET claude_session_id = ?2 WHERE mission_id = ?1",
            params![mission_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget a mission's `claude` session so the next turn starts fresh —
    /// the context-overflow recovery (an overflowed session would otherwise be
    /// resumed, and fail, forever).
    pub fn clear_mission_session(&self, mission_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE missions SET claude_session_id = NULL WHERE mission_id = ?1",
            params![mission_id],
        )?;
        Ok(())
    }

    /// Save a mission's tab workspace (JSON). Deliberately does NOT bump
    /// `updated_at` — tab churn shouldn't reorder the mission list.
    pub fn set_mission_tabs(&self, mission_id: &str, tabs_json: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE missions SET tabs_json = ?2 WHERE mission_id = ?1",
            params![mission_id, tabs_json],
        )?;
        Ok(())
    }

    pub fn get_mission_tabs(&self, mission_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT tabs_json FROM missions WHERE mission_id = ?1",
            params![mission_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Hard-delete a mission and all its data (pins + orchestrator chat). The
    /// caller purges the saved tabs' browse threads first (those are keyed by
    /// `browse_id`, independent of the mission row).
    pub fn delete_mission(&self, mission_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM mission_findings WHERE mission_id = ?1",
            params![mission_id],
        )?;
        conn.execute(
            "DELETE FROM mission_messages WHERE mission_id = ?1",
            params![mission_id],
        )?;
        conn.execute("DELETE FROM missions WHERE mission_id = ?1", params![mission_id])?;
        Ok(())
    }

    // --- Mission findings (pins) -------------------------------------------

    pub fn insert_finding(&self, f: &MissionFinding) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO mission_findings
                (id, mission_id, browse_id, source_url, source_title, body, note, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                f.id,
                f.mission_id,
                f.browse_id,
                f.source_url,
                f.source_title,
                f.body,
                f.note,
                f.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_findings(&self, mission_id: &str) -> rusqlite::Result<Vec<MissionFinding>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, mission_id, browse_id, source_url, source_title, body, note, created_at
             FROM mission_findings
             WHERE mission_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![mission_id], |row| {
            Ok(MissionFinding {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                browse_id: row.get(2)?,
                source_url: row.get(3)?,
                source_title: row.get(4)?,
                body: row.get(5)?,
                note: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_finding(&self, finding_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM mission_findings WHERE id = ?1",
            params![finding_id],
        )?;
        Ok(())
    }

    // --- Source feedback (tandem mode thumbs) ------------------------------

    /// Record (or update) a thumbs verdict for a surfaced source. Upserts on
    /// `(browse_id, source_url)`: a second click flips `verdict` and bumps
    /// `updated_at` while keeping the original `created_at`.
    pub fn upsert_source_feedback(&self, f: &SourceFeedback) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO source_feedback
                (id, browse_id, source_url, source_title, domain, verdict, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(browse_id, source_url) DO UPDATE SET
                verdict = excluded.verdict,
                source_title = excluded.source_title,
                domain = excluded.domain,
                updated_at = excluded.updated_at",
            params![
                f.id,
                f.browse_id,
                f.source_url,
                f.source_title,
                f.domain,
                f.verdict,
                f.created_at,
                f.updated_at,
            ],
        )?;
        Ok(())
    }

    /// All verdicts recorded on a tab's thread, so the sources strip can restore
    /// its up/down state after a reload.
    pub fn get_source_feedback(&self, browse_id: &str) -> rusqlite::Result<Vec<SourceFeedback>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, browse_id, source_url, source_title, domain, verdict, created_at, updated_at
             FROM source_feedback
             WHERE browse_id = ?1
             ORDER BY updated_at, id",
        )?;
        let rows = stmt.query_map(params![browse_id], |row| {
            Ok(SourceFeedback {
                id: row.get(0)?,
                browse_id: row.get(1)?,
                source_url: row.get(2)?,
                source_title: row.get(3)?,
                domain: row.get(4)?,
                verdict: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    /// Net thumbs score per domain across ALL tabs (sum of +1/-1), most-liked
    /// first. Feeds the learned "preferred / avoided sources" line injected into
    /// the tandem agent prompt.
    pub fn domain_feedback_summary(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT domain, SUM(verdict) AS score
             FROM source_feedback
             GROUP BY domain
             ORDER BY score DESC, domain",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect()
    }

    // --- Mission chat turns ------------------------------------------------

    pub fn insert_mission_message(&self, msg: &MissionMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO mission_messages
                (id, mission_id, role, body, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![msg.id, msg.mission_id, msg.role, msg.body, msg.status, msg.created_at],
        )?;
        Ok(())
    }

    pub fn load_mission_thread(&self, mission_id: &str) -> rusqlite::Result<Vec<MissionMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, mission_id, role, body, status, created_at
             FROM mission_messages
             WHERE mission_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![mission_id], |row| {
            Ok(MissionMessage {
                id: row.get(0)?,
                mission_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    // --- Linked discussions ------------------------------------------------
    // One continuous conversation spanning all browser tabs (no goal). Mirrors
    // the mission helpers above but keyed by `linked_id`; turns carry a tab tag.
    // See linked.rs.

    pub fn insert_linked(&self, l: &Linked) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO linked_sessions
                (linked_id, title, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![l.linked_id, l.title, l.status, l.created_at, l.updated_at],
        )?;
        Ok(())
    }

    /// Linked discussions newest-first (active before archived, then recency),
    /// for the start/switch/resume menu.
    pub fn list_linked(&self) -> rusqlite::Result<Vec<Linked>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT linked_id, title, status, created_at, updated_at
             FROM linked_sessions
             ORDER BY (status = 'active') DESC, updated_at DESC, created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Linked {
                linked_id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_linked_session(&self, linked_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT claude_session_id FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_linked_session(
        &self,
        linked_id: &str,
        claude_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE linked_sessions SET claude_session_id = ?2 WHERE linked_id = ?1",
            params![linked_id, claude_session_id],
        )?;
        Ok(())
    }

    /// Forget a linked discussion's `claude` session so the next turn starts
    /// fresh — the context-overflow recovery. Also nulls the conversion fork
    /// source: re-forking a browse session AFTER the linked chat has lived its
    /// own life would resurrect a stale context, not recover this one.
    pub fn clear_linked_session(&self, linked_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE linked_sessions
                SET claude_session_id = NULL, fork_from_session_id = NULL
              WHERE linked_id = ?1",
            params![linked_id],
        )?;
        Ok(())
    }

    /// Insert a linked discussion converted from a per-tab browse chat,
    /// recording its provenance and the browse `claude` session its first turn
    /// will fork from (`--resume <sid> --fork-session`).
    pub fn insert_linked_converted(
        &self,
        l: &Linked,
        browse_id: &str,
        origin: &str,
        fork_from_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO linked_sessions
                (linked_id, title, status, created_at, updated_at,
                 converted_from_browse_id, converted_origin, fork_from_session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                l.linked_id,
                l.title,
                l.status,
                l.created_at,
                l.updated_at,
                browse_id,
                origin,
                fork_from_session_id
            ],
        )?;
        Ok(())
    }

    /// The browse session the linked chat's FIRST turn should fork from, plus
    /// the human origin descriptor for the prompt ("tab 2 — Title") — `Some`
    /// only while that first turn hasn't landed (`claude_session_id` still
    /// NULL), so a failed first turn re-forks and an established chat never
    /// re-forks.
    pub fn get_linked_fork_from(&self, linked_id: &str) -> Option<(String, Option<String>)> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT fork_from_session_id, converted_origin FROM linked_sessions
              WHERE linked_id = ?1 AND claude_session_id IS NULL",
            params![linked_id],
            |row| {
                Ok(row
                    .get::<_, Option<String>>(0)?
                    .map(|sid| (sid, row.get::<_, Option<String>>(1).unwrap_or(None))))
            },
        )
        .ok()
        .flatten()
    }

    /// Save a linked discussion's tab workspace (JSON). Like the mission helper,
    /// this does NOT bump `updated_at` — tab churn shouldn't reorder the list.
    pub fn set_linked_tabs(&self, linked_id: &str, tabs_json: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE linked_sessions SET tabs_json = ?2 WHERE linked_id = ?1",
            params![linked_id, tabs_json],
        )?;
        Ok(())
    }

    pub fn get_linked_tabs(&self, linked_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT tabs_json FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Hard-delete a linked discussion and its chat. Does NOT touch any tab's
    /// browse thread — consults live in those tabs' own discussions, which the
    /// user may still want.
    pub fn delete_linked(&self, linked_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM linked_messages WHERE linked_id = ?1",
            params![linked_id],
        )?;
        conn.execute(
            "DELETE FROM linked_sessions WHERE linked_id = ?1",
            params![linked_id],
        )?;
        Ok(())
    }

    pub fn insert_linked_message(&self, msg: &LinkedMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO linked_messages
                (id, linked_id, role, body, status, tab_browse_id, tab_n, tab_title, tab_url, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                msg.id,
                msg.linked_id,
                msg.role,
                msg.body,
                msg.status,
                msg.tab_browse_id,
                msg.tab_n,
                msg.tab_title,
                msg.tab_url,
                msg.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn load_linked_thread(&self, linked_id: &str) -> rusqlite::Result<Vec<LinkedMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, linked_id, role, body, status, tab_browse_id, tab_n, tab_title, tab_url, created_at
             FROM linked_messages
             WHERE linked_id = ?1
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map(params![linked_id], |row| {
            Ok(LinkedMessage {
                id: row.get(0)?,
                linked_id: row.get(1)?,
                role: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                tab_browse_id: row.get(5)?,
                tab_n: row.get(6)?,
                tab_title: row.get(7)?,
                tab_url: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect()
    }

    /// Distinct working directories the user has worked in, most-recent first —
    /// every `sessions.project_path` (a plan review). This is Redline's de-facto
    /// "projects" registry: it backs the browse agent's `/v1/code/projects` map
    /// and is the allowlist the read-only git route validates a `repo` against.
    /// Paths are returned verbatim (may no longer exist on disk — the caller
    /// filters).
    pub fn list_project_paths(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT project_path AS path FROM sessions
             WHERE project_path IS NOT NULL AND project_path <> ''
             GROUP BY project_path
             ORDER BY MAX(created_at) DESC",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    // --- localhost dashboard (dev servers) -----------------------------------

    /// Record that this `(project_path, port)` is (or just was) serving. On
    /// conflict the volatile facts refresh — but NEVER `first_seen_at` (the
    /// "known since" fact) and NEVER `thumb_path` (a fresh scan must not blank
    /// a card's screenshot; only `set_dev_server_thumb` writes it).
    #[allow(clippy::too_many_arguments)]
    pub fn upsert_dev_server(
        &self,
        project_path: &str,
        project_name: &str,
        port: u16,
        url: &str,
        stack: &str,
        run_command: &str,
        last_pid: Option<u32>,
        last_args: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO dev_servers
                 (project_path, project_name, port, url, stack, run_command,
                  last_pid, last_args, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
             ON CONFLICT (project_path, port) DO UPDATE SET
                 project_name = excluded.project_name,
                 url          = excluded.url,
                 stack        = excluded.stack,
                 run_command  = excluded.run_command,
                 last_pid     = excluded.last_pid,
                 last_args    = excluded.last_args,
                 last_seen_at = excluded.last_seen_at",
            params![
                project_path,
                project_name,
                port as i64,
                url,
                stack,
                run_command,
                last_pid.map(|p| p as i64),
                last_args,
                now,
            ],
        )?;
        Ok(())
    }

    /// Remembered dev servers, most-recently-seen first. Rows are returned
    /// verbatim — the caller filters out the ones that are live right now and
    /// the ones whose project directory has since disappeared.
    pub fn list_dev_servers(&self, limit: i64) -> rusqlite::Result<Vec<DevServerRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, project_path, project_name, port, url, stack, run_command,
                    last_seen_at, thumb_path
             FROM dev_servers
             ORDER BY last_seen_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(DevServerRow {
                id: row.get(0)?,
                project_path: row.get(1)?,
                project_name: row.get(2)?,
                port: row.get::<_, i64>(3)? as u16,
                url: row.get(4)?,
                stack: row.get(5)?,
                run_command: row.get(6)?,
                last_seen_at: row.get(7)?,
                thumb_path: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Drop all but the `keep` most-recently-seen rows. Deliberately a COUNT
    /// prune and not an existence prune: an unmounted volume or a repo that is
    /// briefly moved must not destroy its history.
    pub fn prune_dev_servers(&self, keep: i64) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM dev_servers WHERE id NOT IN (
                 SELECT id FROM dev_servers ORDER BY last_seen_at DESC LIMIT ?1
             )",
            params![keep],
        )
    }

    /// `first_seen_at` is deliberately not part of `DevServerRow` (nothing in
    /// the UI shows it) — but the invariant that an upsert never rewrites it is
    /// worth a test, so tests can read it directly.
    #[cfg(test)]
    pub fn dev_server_first_seen(&self, id: i64) -> rusqlite::Result<i64> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT first_seen_at FROM dev_servers WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
    }

    /// Attach a freshly-captured thumbnail to a row — the only writer of
    /// `thumb_path`. Keyed on `(project_path, port)` rather than the row id
    /// because that pair IS a card's identity everywhere else in this feature;
    /// keying on the id would mean carrying one through the capture pipeline for
    /// no other reason. A capture for a row that has since been pruned is a
    /// silent no-op.
    pub fn set_dev_server_thumb(
        &self,
        project_path: &str,
        port: u16,
        path: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE dev_servers SET thumb_path = ?3
             WHERE project_path = ?1 AND port = ?2",
            params![project_path, port as i64, path],
        )?;
        Ok(())
    }

    // --- code-review surface -------------------------------------------------

    const REVIEW_SESSION_COLS: &'static str =
        "review_id, repo_path, source, base_ref, commit_sha, terminal_id, round, created_at";

    fn map_code_review(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeReviewSession> {
        Ok(CodeReviewSession {
            review_id: row.get(0)?,
            repo_path: row.get(1)?,
            source: row.get(2)?,
            base_ref: row.get(3)?,
            commit_sha: row.get(4)?,
            terminal_id: row.get(5)?,
            round: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    pub fn upsert_code_review(&self, r: &CodeReviewSession) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO review_sessions
                 (review_id, repo_path, source, base_ref, commit_sha, terminal_id, round, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(review_id) DO UPDATE SET
                 repo_path = excluded.repo_path,
                 source = excluded.source,
                 base_ref = excluded.base_ref,
                 commit_sha = excluded.commit_sha,
                 terminal_id = excluded.terminal_id,
                 round = excluded.round",
            params![
                r.review_id,
                r.repo_path,
                r.source,
                r.base_ref,
                r.commit_sha,
                r.terminal_id,
                r.round,
                r.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_code_review(&self, review_id: &str) -> Option<CodeReviewSession> {
        let conn = self.lock_conn();
        conn.query_row(
            &format!(
                "SELECT {} FROM review_sessions WHERE review_id = ?1",
                Self::REVIEW_SESSION_COLS
            ),
            params![review_id],
            Self::map_code_review,
        )
        .ok()
    }

    pub fn list_code_reviews(&self) -> rusqlite::Result<Vec<CodeReviewSession>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_sessions ORDER BY created_at DESC",
            Self::REVIEW_SESSION_COLS
        ))?;
        let rows = stmt.query_map([], Self::map_code_review)?;
        rows.collect()
    }

    /// The most recent review session for a repo — how a re-run of
    /// `/redline-code-review` in the same repo continues the SAME review (next
    /// round) instead of minting a parallel one.
    pub fn latest_code_review_for_repo(&self, repo_path: &str) -> Option<CodeReviewSession> {
        let conn = self.lock_conn();
        conn.query_row(
            &format!(
                "SELECT {} FROM review_sessions WHERE repo_path = ?1
                 ORDER BY created_at DESC LIMIT 1",
                Self::REVIEW_SESSION_COLS
            ),
            params![repo_path],
            Self::map_code_review,
        )
        .ok()
    }

    pub fn delete_code_review(&self, review_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM review_annotations WHERE review_id = ?1",
            params![review_id],
        )?;
        conn.execute(
            "DELETE FROM review_viewed WHERE review_id = ?1",
            params![review_id],
        )?;
        conn.execute(
            "DELETE FROM review_pushes WHERE review_id = ?1",
            params![review_id],
        )?;
        conn.execute(
            "DELETE FROM review_sessions WHERE review_id = ?1",
            params![review_id],
        )?;
        Ok(())
    }

    const REVIEW_PUSH_COLS: &'static str = "id, review_id, repo_path, remote, branch, \
         commit_sha, pr_url, pr_number, files, created_at";

    fn map_review_push(row: &rusqlite::Row<'_>) -> rusqlite::Result<PushRecord> {
        Ok(PushRecord {
            id: row.get(0)?,
            review_id: row.get(1)?,
            repo_path: row.get(2)?,
            remote: row.get(3)?,
            branch: row.get(4)?,
            commit_sha: row.get(5)?,
            pr_url: row.get(6)?,
            pr_number: row.get(7)?,
            files: row.get(8)?,
            created_at: row.get(9)?,
        })
    }

    pub fn insert_review_push(&self, p: &PushRecord) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            &format!(
                "INSERT INTO review_pushes ({})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                Self::REVIEW_PUSH_COLS
            ),
            params![
                p.id,
                p.review_id,
                p.repo_path,
                p.remote,
                p.branch,
                p.commit_sha,
                p.pr_url,
                p.pr_number,
                p.files,
                p.created_at,
            ],
        )?;
        Ok(())
    }

    /// The newest push recorded for a review — the one the feedback payload
    /// reports.
    pub fn latest_push_for_review(&self, review_id: &str) -> Option<PushRecord> {
        let conn = self.lock_conn();
        conn.query_row(
            &format!(
                "SELECT {} FROM review_pushes WHERE review_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                Self::REVIEW_PUSH_COLS
            ),
            params![review_id],
            Self::map_review_push,
        )
        .ok()
    }

    const REVIEW_ANNOTATION_COLS: &'static str =
        "id, review_id, round, file_path, side, start_line, end_line, kind, body, \
         suggestion_replacement, quoted_text, status, resolution, created_at, \
         scope, label, blocking, source";

    fn map_review_annotation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewAnnotation> {
        Ok(ReviewAnnotation {
            id: row.get(0)?,
            review_id: row.get(1)?,
            round: row.get(2)?,
            file_path: row.get(3)?,
            side: row.get(4)?,
            start_line: row.get(5)?,
            end_line: row.get(6)?,
            kind: row.get(7)?,
            body: row.get(8)?,
            suggestion_replacement: row.get(9)?,
            quoted_text: row.get(10)?,
            status: row.get(11)?,
            resolution: row.get(12)?,
            created_at: row.get(13)?,
            scope: row.get(14)?,
            label: row.get(15)?,
            blocking: row.get(16)?,
            source: row.get(17)?,
        })
    }

    pub fn insert_review_annotation(&self, a: &ReviewAnnotation) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            &format!(
                "INSERT INTO review_annotations ({})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                         ?15, ?16, ?17, ?18)",
                Self::REVIEW_ANNOTATION_COLS
            ),
            params![
                a.id,
                a.review_id,
                a.round,
                a.file_path,
                a.side,
                a.start_line,
                a.end_line,
                a.kind,
                a.body,
                a.suggestion_replacement,
                a.quoted_text,
                a.status,
                a.resolution,
                a.created_at,
                a.scope,
                a.label,
                a.blocking,
                a.source,
            ],
        )?;
        Ok(())
    }

    /// Full-row update (except identity + created_at + source). The
    /// carry-forward pass re-homes an annotation's round/lines/status through
    /// this same path.
    pub fn update_review_annotation(&self, a: &ReviewAnnotation) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE review_annotations SET
                 round = ?1, file_path = ?2, side = ?3, start_line = ?4, end_line = ?5,
                 kind = ?6, body = ?7, suggestion_replacement = ?8, quoted_text = ?9,
                 status = ?10, resolution = ?11, scope = ?12, label = ?13, blocking = ?14
             WHERE review_id = ?15 AND id = ?16",
            params![
                a.round,
                a.file_path,
                a.side,
                a.start_line,
                a.end_line,
                a.kind,
                a.body,
                a.suggestion_replacement,
                a.quoted_text,
                a.status,
                a.resolution,
                a.scope,
                a.label,
                a.blocking,
                a.review_id,
                a.id,
            ],
        )?;
        Ok(())
    }

    pub fn delete_review_annotation(&self, review_id: &str, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM review_annotations WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    pub fn list_review_annotations(
        &self,
        review_id: &str,
    ) -> rusqlite::Result<Vec<ReviewAnnotation>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_annotations WHERE review_id = ?1
             ORDER BY file_path, start_line, created_at",
            Self::REVIEW_ANNOTATION_COLS
        ))?;
        let rows = stmt.query_map(params![review_id], Self::map_review_annotation)?;
        rows.collect()
    }

    /// The annotation's discussion-fork claude session id (resume target).
    /// Deliberately NOT on `ReviewAnnotation` — always read fresh from disk,
    /// mirroring `comments.fork_session_id`.
    pub fn get_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT fork_session_id FROM review_annotations
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE review_annotations SET fork_session_id = ?3
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id, fork_session_id],
        )?;
        Ok(())
    }

    pub fn clear_review_annotation_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE review_annotations SET fork_session_id = NULL
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    pub fn mark_review_viewed(
        &self,
        review_id: &str,
        file_path: &str,
        viewed_at: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO review_viewed (review_id, file_path, viewed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(review_id, file_path) DO UPDATE SET viewed_at = excluded.viewed_at",
            params![review_id, file_path, viewed_at],
        )?;
        Ok(())
    }

    pub fn unmark_review_viewed(&self, review_id: &str, file_path: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM review_viewed WHERE review_id = ?1 AND file_path = ?2",
            params![review_id, file_path],
        )?;
        Ok(())
    }

    pub fn list_review_viewed(&self, review_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT file_path FROM review_viewed WHERE review_id = ?1 ORDER BY file_path",
        )?;
        let rows = stmt.query_map(params![review_id], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    /// Remove a source's DRAFT annotations only — submitted/carried history is
    /// feedback the agent already saw and must stay auditable.
    pub fn clear_review_annotations_by_source(
        &self,
        review_id: &str,
        source: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM review_annotations
             WHERE review_id = ?1 AND source = ?2 AND status = 'draft'",
            params![review_id, source],
        )
    }

    // --- Ask-AI questions ----------------------------------------------------

    const REVIEW_QUESTION_COLS: &'static str =
        "id, review_id, file_path, side, start_line, end_line, quoted_text, created_at";

    fn map_review_question(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewQuestion> {
        Ok(ReviewQuestion {
            id: row.get(0)?,
            review_id: row.get(1)?,
            file_path: row.get(2)?,
            side: row.get(3)?,
            start_line: row.get(4)?,
            end_line: row.get(5)?,
            quoted_text: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    pub fn insert_review_question(&self, q: &ReviewQuestion) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            &format!(
                "INSERT INTO review_questions ({})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                Self::REVIEW_QUESTION_COLS
            ),
            params![
                q.id,
                q.review_id,
                q.file_path,
                q.side,
                q.start_line,
                q.end_line,
                q.quoted_text,
                q.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_review_questions(&self, review_id: &str) -> rusqlite::Result<Vec<ReviewQuestion>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM review_questions WHERE review_id = ?1
             ORDER BY file_path, start_line, created_at",
            Self::REVIEW_QUESTION_COLS
        ))?;
        let rows = stmt.query_map(params![review_id], Self::map_review_question)?;
        rows.collect()
    }

    pub fn delete_review_question(&self, review_id: &str, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM review_questions WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    /// The question's Ask-AI claude session id (resume target) — read fresh
    /// from disk, mirroring `review_annotations.fork_session_id`.
    pub fn get_review_question_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT fork_session_id FROM review_questions WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_review_question_fork_session(
        &self,
        review_id: &str,
        id: &str,
        session: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE review_questions SET fork_session_id = ?1 WHERE review_id = ?2 AND id = ?3",
            params![session, review_id, id],
        )?;
        Ok(())
    }

    /// Forget the stored fork so the next turn starts a fresh discussion —
    /// the over-limit recovery, mirroring `clear_review_annotation_fork_session`.
    pub fn clear_review_question_fork_session(
        &self,
        review_id: &str,
        id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE review_questions SET fork_session_id = NULL
             WHERE review_id = ?1 AND id = ?2",
            params![review_id, id],
        )?;
        Ok(())
    }

    // --- Voice-agent session (per-plan memory) -----------------------------
    // The voice agent's conversation is a forked claude session, persisted by
    // the plan's session id so re-entering voice mode resumes it. The live
    // process is disposable (`voice.rs`); this row is the memory.

    pub fn get_voice_fork_session(&self, session_id: &str) -> Option<String> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT fork_session_id FROM voice_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_voice_fork_session(
        &self,
        session_id: &str,
        fork_session_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO voice_sessions (session_id, fork_session_id)
             VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET fork_session_id = ?2",
            params![session_id, fork_session_id],
        )?;
        Ok(())
    }

    pub fn clear_voice_fork_session(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM voice_sessions WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    // --- Voice-agent transcript (the visible half of that memory) -----------
    // Mirrors the browse-thread helpers, keyed by the same voice key. See
    // `VoiceMessage` for why these rows exist at all.

    pub fn insert_voice_message(&self, msg: &VoiceMessage) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO voice_messages (id, session_key, role, text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![msg.id, msg.session_key, msg.role, msg.text, msg.created_at],
        )?;
        Ok(())
    }

    /// A voice key's transcript, oldest-first — the order the panel replays it
    /// in. Ties on `created_at` break by `rowid` (insertion order): a "you" line
    /// and the marker that follows it can land in the same millisecond, and a
    /// uuid tiebreak would invert them.
    pub fn list_voice_messages(&self, session_key: &str) -> rusqlite::Result<Vec<VoiceMessage>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_key, role, text, created_at
             FROM voice_messages
             WHERE session_key = ?1
             ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![session_key], |row| {
            Ok(VoiceMessage {
                id: row.get(0)?,
                session_key: row.get(1)?,
                role: row.get(2)?,
                text: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Wipe a voice key's visible transcript. Paired with
    /// `clear_voice_fork_session` by `voice_forget`, so "forget" is a true
    /// reset: neither the agent's recollection nor the screen survives it.
    pub fn clear_voice_messages(&self, session_key: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM voice_messages WHERE session_key = ?1",
            params![session_key],
        )?;
        Ok(())
    }

    // --- Offered plan items (staged, not written) ---------------------------
    // See `CommentOffer`. Rows here are proposals: nothing reaches the plan
    // until `claim_comment_offer` wins and `add_feedback_from_offer` writes the
    // comment.

    /// `stale` is not a column — it is computed against the current plan by
    /// `comment_offers_pending`, so every row reads back as fresh.
    fn map_comment_offer(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommentOffer> {
        Ok(CommentOffer {
            id: row.get(0)?,
            session_id: row.get(1)?,
            message_id: row.get(2)?,
            block_id: row.get(3)?,
            body: row.get(4)?,
            label: row.get(5)?,
            agent_id: row.get(6)?,
            status: row.get(7)?,
            created_at: row.get(8)?,
            stale: false,
        })
    }

    pub fn insert_comment_offer(&self, offer: &CommentOffer) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO comment_offers
                (id, session_id, message_id, block_id, body, label, agent_id, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                offer.id,
                offer.session_id,
                offer.message_id,
                offer.block_id,
                offer.body,
                offer.label,
                offer.agent_id,
                offer.status,
                offer.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_comment_offer(&self, id: &str) -> rusqlite::Result<Option<CommentOffer>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, message_id, block_id, body, label, agent_id, status, created_at
             FROM comment_offers WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::map_comment_offer)?;
        rows.next().transpose()
    }

    /// A session's still-open offers, oldest-first. Same `created_at, rowid`
    /// tiebreak as `list_voice_messages`: two offers staged in one turn can land
    /// in the same millisecond, and a uuid tiebreak would invert them.
    pub fn list_open_comment_offers(&self, session_id: &str) -> rusqlite::Result<Vec<CommentOffer>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, message_id, block_id, body, label, agent_id, status, created_at
             FROM comment_offers
             WHERE session_id = ?1 AND status = 'pending'
             ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![session_id], Self::map_comment_offer)?;
        rows.collect()
    }

    /// Attach this turn's still-unbound offers to the reply they came from.
    ///
    /// The floor is the newest persisted `"you"` line: `voice_send` writes it
    /// immediately after the stdin write, therefore strictly before the child
    /// can issue any curl. So everything staged at or after it belongs to the
    /// turn that just finished — no per-turn counter on `VoiceProc` needed.
    /// Returns how many rows were bound.
    pub fn bind_comment_offers(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE comment_offers SET message_id = ?2
              WHERE session_id = ?1 AND message_id IS NULL AND status = 'pending'
                AND created_at >= (SELECT COALESCE(MAX(created_at), 0) FROM voice_messages
                                    WHERE session_key = ?1 AND role = 'you')",
            params![session_id, message_id],
        )
    }

    /// How many offers this turn has already staged — the server-side cap. Same
    /// `"you"`-line floor as `bind_comment_offers`.
    pub fn count_open_offers_this_turn(&self, session_id: &str) -> rusqlite::Result<i64> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT COUNT(*) FROM comment_offers
              WHERE session_id = ?1 AND message_id IS NULL AND status = 'pending'
                AND created_at >= (SELECT COALESCE(MAX(created_at), 0) FROM voice_messages
                                    WHERE session_key = ?1 AND role = 'you')",
            params![session_id],
            |r| r.get(0),
        )
    }

    /// Take ownership of an offer before writing its comment. A compare-and-set:
    /// only the first caller sees `true`, which is what makes a double-tap
    /// (or a tap racing a dismiss) land exactly one comment.
    pub fn claim_comment_offer(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let changed = conn.execute(
            "UPDATE comment_offers SET status = 'added' WHERE id = ?1 AND status = 'pending'",
            params![id],
        )?;
        Ok(changed > 0)
    }

    /// Undo a claim whose write then failed, so the chip survives a transient
    /// error instead of vanishing with nothing to show for it.
    pub fn release_comment_offer(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE comment_offers SET status = 'pending' WHERE id = ?1 AND status = 'added'",
            params![id],
        )?;
        Ok(())
    }

    /// Resolve an offer without writing it (`dismissed`). Returns whether a
    /// pending row was actually transitioned — mirrors `resolve_draft_suggestion`.
    pub fn resolve_comment_offer(&self, id: &str, status: &str) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let changed = conn.execute(
            "UPDATE comment_offers SET status = ?2 WHERE id = ?1 AND status = 'pending'",
            params![id, status],
        )?;
        Ok(changed > 0)
    }

    /// Wipe a session's offers. Paired with `clear_voice_messages` by
    /// `voice_forget` — a chip outliving the conversation it came from would be
    /// an offer with no visible provenance.
    pub fn clear_comment_offers(&self, session_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "DELETE FROM comment_offers WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Durable history totals for diagnostics; query failure is never an
    /// empty-history result. One lock and one read cover all three tables.
    pub fn plan_history_counts(&self) -> rusqlite::Result<(i64, i64, i64)> {
        self.lock_conn().query_row(
            "SELECT (SELECT COUNT(*) FROM sessions),
                    (SELECT COUNT(*) FROM revisions),
                    (SELECT COUNT(*) FROM comments)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
    }

    /// Every session, fully reparsed — the startup read that populates
    /// `SessionStore`. Cost scales with the whole review history, so callers
    /// wanting ONE session must use `load_session`.
    pub fn load_all(&self) -> rusqlite::Result<HashMap<String, ReviewSession>> {
        self.load_sessions(None)
    }

    /// One session, reparsed alone. `/v1/context/sessions/:id/history` used to
    /// call `load_all` and throw away everything but one entry — every
    /// revision of every session in the database, re-sectioned through the
    /// markdown parser, to serve a single id.
    pub fn load_session(&self, session_id: &str) -> rusqlite::Result<Option<ReviewSession>> {
        Ok(self.load_sessions(Some(session_id))?.remove(session_id))
    }

    /// Shared body of `load_all` / `load_session`: the same three queries, with
    /// an optional `session_id` narrowing on each, so the two readers cannot
    /// drift in what they reconstruct.
    fn load_sessions(&self, only: Option<&str>) -> rusqlite::Result<HashMap<String, ReviewSession>> {
        let conn = self.lock_conn();
        let mut sessions: HashMap<String, ReviewSession> = HashMap::new();
        let binds: Vec<String> = only.map(str::to_string).into_iter().collect();
        let refs = || -> Vec<&dyn rusqlite::ToSql> {
            binds.iter().map(|s| s as &dyn rusqlite::ToSql).collect()
        };
        let narrow = |sql: &str, order: &str| -> String {
            match only {
                Some(_) => format!("{sql} WHERE session_id = ?1 {order}"),
                None => format!("{sql} {order}"),
            }
        };

        let mut stmt = conn.prepare(&narrow(
            "SELECT session_id, project_path, project_name, created_at, status, attach_state, updated_at, run_state, backend, model, effort FROM sessions",
            "",
        ))?;
        let rows = stmt.query_map(refs().as_slice(), |row| {
            let status_str: String = row.get(4)?;
            let attach_str: String = row.get(5)?;
            Ok(ReviewSession {
                session_id: row.get(0)?,
                project_path: row.get(1)?,
                project_name: row.get(2)?,
                created_at: row.get(3)?,
                revisions: Vec::new(),
                status: session_status_from(&status_str),
                attach_state: AttachState::from_str(&attach_str).unwrap_or(AttachState::Idle),
                updated_at: row.get(6)?,
                run_state: row.get(7)?,
                backend: row.get(8)?,
                model: row.get(9)?,
                effort: row.get(10)?,
            })
        })?;
        for row in rows {
            let s = row?;
            sessions.insert(s.session_id.clone(), s);
        }
        drop(stmt);

        let mut stmt = conn.prepare(&narrow(
            "SELECT session_id, version_number, received_at, raw_plan_markdown, thread_start, restored
             FROM revisions",
            "ORDER BY session_id, version_number",
        ))?;
        let revs = stmt.query_map(refs().as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? != 0,
                row.get::<_, i64>(5)? != 0,
            ))
        })?;
        for r in revs {
            let (session_id, version_number, received_at, raw_plan_markdown, thread_start, restored) = r?;
            if let Some(s) = sessions.get_mut(&session_id) {
                // NO `reparse_sections` here. This loop runs once per revision
                // of every session ever reviewed, at startup, in front of the
                // window — and the parse it used to do was thrown away for
                // every session the user did not open. `raw_plan_markdown` is
                // the record; `SessionStore` materializes the tree on the
                // first read that needs one. See `Revision::sections`.
                s.revisions.push(Revision {
                    version_number,
                    received_at,
                    raw_plan_markdown,
                    sections: Vec::new(),
                    comments: Vec::new(),
                    thread_start,
                    restored,
                });
            }
        }
        drop(stmt);

        let mut stmt = conn.prepare(&narrow(
            "SELECT id, session_id, version_number, type, scope, anchor_id,
                    body, edit_original, edit_revised, created_at, status,
                    resolution_body, resolution_version, resolution_accepted_at,
                    block_id, structural_json,
                    sel_char_start, sel_char_end, sel_quoted_text,
                    sel_sub_block_id, reopen_note, reopen_history, actionable,
                    author, agent_state, reviewer,
                    external_created_at, share_request_id, attachments
             FROM comments",
            "ORDER BY session_id, version_number, created_at",
        ))?;
        let comments = stmt.query_map(refs().as_slice(), |row| {
            let kind_str: String = row.get(3)?;
            let scope_str: Option<String> = row.get(4)?;
            let status_str: String = row.get(10)?;
            let edit_original: Option<String> = row.get(7)?;
            let edit_revised: Option<String> = row.get(8)?;
            let edit = match (edit_original, edit_revised) {
                (Some(o), Some(r)) => Some(EditPayload {
                    original: o,
                    revised: r,
                }),
                _ => None,
            };
            let res_body: Option<String> = row.get(11)?;
            let res_version: Option<u32> = row.get(12)?;
            let res_accepted: Option<i64> = row.get(13)?;
            let block_id: Option<String> = row.get(14)?;
            let structural_json: Option<String> = row.get(15)?;
            let structural = structural_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<StructuralPayload>(s).ok());
            let resolution = match (res_body, res_version) {
                (Some(b), Some(v)) => Some(Resolution {
                    body: b,
                    appeared_in_version: v,
                    accepted_at: res_accepted,
                }),
                _ => None,
            };
            let sel_char_start: Option<i64> = row.get(16)?;
            let sel_char_end: Option<i64> = row.get(17)?;
            let sel_quoted_text: Option<String> = row.get(18)?;
            let sel_sub_block_id: Option<String> = row.get(19)?;
            let selection = match (sel_char_start, sel_char_end, sel_quoted_text) {
                (Some(start), Some(end), Some(text)) => Some(CommentSelection {
                    char_start: start.max(0) as u32,
                    char_end: end.max(0) as u32,
                    quoted_text: text,
                    sub_block_id: sel_sub_block_id,
                }),
                _ => None,
            };
            let reopen_note: Option<String> = row.get(20)?;
            let reopen_history_json: Option<String> = row.get(21)?;
            let reopen_history = reopen_history_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<RoundHistoryEntry>>(s).ok())
                .unwrap_or_default();
            let actionable: bool = row.get::<_, i64>(22)? != 0;
            let author: Option<String> = row.get(23)?;
            let agent_state: Option<String> = row.get(24)?;
            let reviewer: Option<String> = row.get(25)?;
            let external_created_at: Option<i64> = row.get(26)?;
            let share_request_id: Option<String> = row.get(27)?;
            let attachments = attachments_from_json(row.get(28)?);
            Ok((
                row.get::<_, String>(1)?, // session_id
                row.get::<_, u32>(2)?,    // version_number
                Comment {
                    id: row.get(0)?,
                    kind: CommentKind::from_str(&kind_str).unwrap_or(CommentKind::Feedback),
                    scope: scope_str.and_then(|s| CommentScope::from_str(&s)),
                    anchor_id: row.get(5)?,
                    block_id,
                    body: row.get(6)?,
                    structural,
                    edit,
                    created_at: row.get(9)?,
                    status: CommentStatus::from_str(&status_str).unwrap_or(CommentStatus::Draft),
                    resolution,
                    selection,
                    reopen_note,
                    reopen_history,
                    actionable,
                    author,
                    agent_state,
                    reviewer,
                    external_created_at,
                    share_request_id,
                    attachments,
                },
            ))
        })?;
        for c in comments {
            let (session_id, version_number, comment) = c?;
            if let Some(s) = sessions.get_mut(&session_id) {
                if let Some(r) = s
                    .revisions
                    .iter_mut()
                    .find(|r| r.version_number == version_number)
                {
                    r.comments.push(comment);
                }
            }
        }

        Ok(sessions)
    }

    // --- work graph (the `work.rs` state plane) ------------------------------
    //
    // Provenance, not ownership (see the schema comment in `migrate`):
    // `origin_kind`/`origin_id`/`project_path` are breadcrumbs and facets,
    // never joins. Nothing in this section touches any run table.

    fn row_to_work_item(row: &rusqlite::Row) -> rusqlite::Result<crate::work::WorkItem> {
        Ok(crate::work::WorkItem {
            id: row.get(0)?,
            title: row.get(1)?,
            body: row.get(2)?,
            status: row.get(3)?,
            priority: row.get(4)?,
            kind: row.get(5)?,
            assignee: row.get(6)?,
            claimed_at: row.get(7)?,
            lease_expires_at: row.get(8)?,
            closed_at: row.get(9)?,
            close_reason: row.get(10)?,
            defer_until: row.get(11)?,
            origin_kind: row.get(12)?,
            origin_id: row.get(13)?,
            project_path: row.get(14)?,
            pinned: row.get::<_, i64>(15)? != 0,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
        })
    }

    const WORK_ITEM_COLS: &'static str =
        "id, title, body, status, priority, kind, assignee, claimed_at,
         lease_expires_at, closed_at, close_reason, defer_until, origin_kind,
         origin_id, project_path, pinned, created_at, updated_at";

    /// Insert a freshly minted work item. The caller (`work.rs`) owns id
    /// minting and vocabulary validation; this is the dumb row write.
    pub fn insert_work_item(&self, item: &crate::work::WorkItem) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO work_items (id, title, body, status, priority, kind,
                assignee, claimed_at, lease_expires_at, closed_at, close_reason,
                defer_until, origin_kind, origin_id, project_path, pinned,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18)",
            params![
                item.id,
                item.title,
                item.body,
                item.status,
                item.priority,
                item.kind,
                item.assignee,
                item.claimed_at,
                item.lease_expires_at,
                item.closed_at,
                item.close_reason,
                item.defer_until,
                item.origin_kind,
                item.origin_id,
                item.project_path,
                item.pinned as i64,
                item.created_at,
                item.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_work_item(&self, id: &str) -> Option<crate::work::WorkItem> {
        let conn = self.lock_conn();
        conn.query_row(
            &format!(
                "SELECT {} FROM work_items WHERE id = ?1",
                Self::WORK_ITEM_COLS
            ),
            params![id],
            Self::row_to_work_item,
        )
        .ok()
    }

    /// Filterable list over the graph. `status`/`project` are facets, both
    /// optional; ordered urgent-first (pinned, then P0-style priority, then
    /// age). Bounded by `limit`.
    pub fn list_work_items(
        &self,
        status: Option<&str>,
        project: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkItem>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM work_items
             WHERE (?1 IS NULL OR status = ?1)
               AND (?2 IS NULL OR project_path = ?2)
             ORDER BY pinned DESC, priority ASC, created_at ASC
             LIMIT ?3",
            Self::WORK_ITEM_COLS
        ))?;
        let rows = stmt.query_map(params![status, project, limit.max(1)], |r| {
            Self::row_to_work_item(r)
        })?;
        rows.collect()
    }

    /// The rollup's item read: every NON-CLOSED item, with the closed filter
    /// INSIDE the limit — a graph carrying more than `limit` old closed rows
    /// must still surface every live one (`list_work_items` + a caller-side
    /// filter would let the closed backlog crowd the bound, its ORDER BY
    /// created_at ASC being oldest-first). Ordering matches `list_work_items`.
    pub fn list_unclosed_work_items(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkItem>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM work_items
             WHERE status != 'closed'
             ORDER BY pinned DESC, priority ASC, created_at ASC
             LIMIT ?1",
            Self::WORK_ITEM_COLS
        ))?;
        let rows = stmt.query_map(params![limit.max(1)], |r| Self::row_to_work_item(r))?;
        rows.collect()
    }

    /// Everything the work graph did while the user was elsewhere: items that
    /// ARRIVED or CLOSED at or after `since_ms`.
    ///
    /// One read rather than two because the feed shows them interleaved in
    /// time, and paging two lists to a shared bound would drop the older half
    /// of whichever moved more. The caller classifies each row by comparing
    /// `closed_at`/`created_at` against the same `since_ms` — the row carries
    /// both, so no second query is needed to tell an arrival from a closure.
    ///
    /// Newest-first (unlike the urgent-first graph reads): this is a feed, and
    /// the most recent thing is the one worth reading.
    pub fn list_work_items_since(
        &self,
        since_ms: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkItem>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM work_items
             WHERE created_at >= ?1 OR (closed_at IS NOT NULL AND closed_at >= ?1)
             ORDER BY MAX(created_at, COALESCE(closed_at, 0)) DESC
             LIMIT ?2",
            Self::WORK_ITEM_COLS
        ))?;
        let rows = stmt.query_map(params![since_ms, limit.max(1)], |r| {
            Self::row_to_work_item(r)
        })?;
        rows.collect()
    }

    /// The claimable frontier — READY SEMANTICS (the law of this query).
    /// An item is ready iff ALL of:
    ///   1. `status = 'open'` — `claimed` / `closed` / `held` are out;
    ///   2. its own defer time has passed (`defer_until IS NULL OR <= now`);
    ///   3. no ancestor up the `parent-child` chain is deferred. The
    ///      recursive CTE `deferred_down` seeds every item whose
    ///      `defer_until` is still in the future and walks DOWN through
    ///      `parent-child` edges (`from` = parent, `to` = child), so the set
    ///      is exactly "deferred items plus everything beneath one" —
    ///      membership covers rules 2 and 3 in one exclusion. `UNION` (not
    ///      `UNION ALL`) dedupes, so an edge cycle still terminates;
    ///   4. no unclosed blocker: no `blocks` edge pointing AT the item whose
    ///      from-item exists and is not `closed`. A dangling `blocks` edge
    ///      (from-item row gone) does NOT block — there is no item left to
    ///      close, and edges never own rows (schema law: no FK anywhere).
    /// `project` stays a facet filter (exact `project_path` match); ordering
    /// stays urgent-first (pinned, then P0-style priority, then age),
    /// bounded by `limit`.
    pub fn list_ready_work_items(
        &self,
        project: Option<&str>,
        now: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkItem>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(&format!(
            "WITH RECURSIVE deferred_down(id) AS (
                 SELECT id FROM work_items
                  WHERE defer_until IS NOT NULL AND defer_until > ?2
                 UNION
                 SELECT e.to_id FROM work_edges e
                  JOIN deferred_down d ON e.from_id = d.id
                  WHERE e.type = 'parent-child'
             )
             SELECT {} FROM work_items w
             WHERE w.status = 'open'
               AND (?1 IS NULL OR w.project_path = ?1)
               AND w.id NOT IN (SELECT id FROM deferred_down)
               AND NOT EXISTS (
                   SELECT 1 FROM work_edges e
                    JOIN work_items b ON b.id = e.from_id
                   WHERE e.to_id = w.id AND e.type = 'blocks'
                     AND b.status != 'closed'
               )
             ORDER BY w.pinned DESC, w.priority ASC, w.created_at ASC
             LIMIT ?3",
            Self::WORK_ITEM_COLS
        ))?;
        let rows = stmt.query_map(params![project, now, limit.max(1)], |r| {
            Self::row_to_work_item(r)
        })?;
        rows.collect()
    }

    /// Atomic claim: flip `open` → `claimed` in ONE guarded UPDATE
    /// (`WHERE id = ?1 AND status = 'open'`), setting assignee / claimed_at /
    /// lease_expires_at together. SQLite's single writer makes the guard the
    /// whole race: of any number of competing claimers exactly one sees
    /// `affected == 1` (true); every other outcome is a clean conflict
    /// (false) the handler surfaces as HTTP 409. A lapsed lease is NOT
    /// reclaimed here — `expire_work_leases` (run on every keeper tick)
    /// flips the row back to `open` first, and the next claim races
    /// normally.
    pub fn claim_work_item(
        &self,
        id: &str,
        assignee: &str,
        now: i64,
        lease_expires_at: Option<i64>,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE work_items
             SET status = 'claimed', assignee = ?2, claimed_at = ?3,
                 lease_expires_at = ?4, updated_at = ?3
             WHERE id = ?1 AND status = 'open'",
            params![id, assignee, now, lease_expires_at],
        )?;
        Ok(n > 0)
    }

    /// Lease expiry — the reclaim half of the claim contract: every `claimed`
    /// item whose `lease_expires_at` has passed flips back to `open` with the
    /// claim columns cleared (assignee / claimed_at / lease_expires_at), so
    /// it re-enters the ready frontier for anyone to claim. Returns how many
    /// rows flipped. Called on EVERY keeper tick, before the memory
    /// idle/growth/debounce gates — leases lapse on wall-clock, not on lake
    /// growth. An item claimed with `lease_expires_at = NULL` never expires
    /// (an explicit open-ended claim).
    pub fn expire_work_leases(&self, now: i64) -> rusqlite::Result<usize> {
        let conn = self.lock_conn();
        conn.execute(
            "UPDATE work_items
             SET status = 'open', assignee = NULL, claimed_at = NULL,
                 lease_expires_at = NULL, updated_at = ?1
             WHERE status = 'claimed'
               AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1",
            params![now],
        )
    }

    /// Guarded close: `closed_at` + `close_reason` are set exactly once — the
    /// UPDATE only touches a row whose status is not already `closed`, so a
    /// second close is a no-op (false) the handler surfaces as HTTP 409.
    /// Child/duplicate/supersede edge bookkeeping on close is a later wave's.
    pub fn close_work_item(
        &self,
        id: &str,
        reason: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "UPDATE work_items
             SET status = 'closed', closed_at = ?3, close_reason = ?2,
                 updated_at = ?3
             WHERE id = ?1 AND status != 'closed'",
            params![id, reason, now],
        )?;
        Ok(n > 0)
    }

    /// Close every still-open item whose origin is `(origin_kind, origin_id)`,
    /// returning the ids that moved.
    ///
    /// The counterpart to `close_work_item` for a transition that retires a
    /// whole batch at once. `work_items` had 595 rows and zero ever closed —
    /// not because closing was unimplemented (all of it is right here) but
    /// because nothing in the app ever called it, so the graph only ever grew
    /// and "open work" stopped meaning anything.
    ///
    /// Origin is provenance, not ownership (see the schema law): this is a
    /// facet query over breadcrumbs, never a join.
    pub fn close_open_work_items_for_origin(
        &self,
        origin_kind: &str,
        origin_id: &str,
        reason: &str,
        now: i64,
    ) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock_conn();
        let ids = {
            let mut stmt = conn.prepare(
                "SELECT id FROM work_items
                  WHERE origin_kind = ?1 AND origin_id = ?2 AND status != 'closed'",
            )?;
            let rows = stmt
                .query_map(params![origin_kind, origin_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            rows
        };
        if ids.is_empty() {
            return Ok(ids);
        }
        conn.execute(
            "UPDATE work_items
                SET status = 'closed', closed_at = ?4, close_reason = ?3,
                    updated_at = ?4
              WHERE origin_kind = ?1 AND origin_id = ?2 AND status != 'closed'",
            params![origin_kind, origin_id, reason, now],
        )?;
        Ok(ids)
    }

    /// Insert a typed edge; idempotent on the `(from, to, type)` identity.
    /// Returns whether a new row landed. No FK anywhere — see the schema law.
    pub fn insert_work_edge(
        &self,
        from_id: &str,
        to_id: &str,
        edge_type: &str,
        created_by: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock_conn();
        let n = conn.execute(
            "INSERT OR IGNORE INTO work_edges (from_id, to_id, type, created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![from_id, to_id, edge_type, created_by, now],
        )?;
        Ok(n > 0)
    }

    /// Every edge touching an item, either direction — the item-detail read.
    pub fn list_work_edges_touching(
        &self,
        id: &str,
    ) -> rusqlite::Result<Vec<crate::work::WorkEdge>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT from_id, to_id, type, created_by, created_at FROM work_edges
             WHERE from_id = ?1 OR to_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![id], |r| {
            Ok(crate::work::WorkEdge {
                from_id: r.get(0)?,
                to_id: r.get(1)?,
                edge_type: r.get(2)?,
                created_by: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// ONE batched read of every edge touching ANY of `ids` (either end) —
    /// the rollup's replacement for a per-item N+1 loop. Each edge row
    /// returns once (the table's `(from, to, type)` identity is unique), so
    /// no caller-side dedupe is needed. Bounded by `limit`, like the item
    /// read it accompanies.
    pub fn list_work_edges_touching_any(
        &self,
        ids: &[String],
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::work::WorkEdge>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock_conn();
        let ph = (1..=ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT from_id, to_id, type, created_by, created_at FROM work_edges
             WHERE from_id IN ({ph}) OR to_id IN ({ph})
             ORDER BY created_at ASC
             LIMIT ?{}",
            ids.len() + 1
        ))?;
        let lim = limit.max(1);
        let mut args: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        args.push(&lim);
        let rows = stmt.query_map(&args[..], |r| {
            Ok(crate::work::WorkEdge {
                from_id: r.get(0)?,
                to_id: r.get(1)?,
                edge_type: r.get(2)?,
                created_by: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Direct child ids of a hierarchical item id (`<parent>.N` — one more
    /// dotted level only, not grandchildren). Feeds child-ordinal minting.
    pub fn work_child_ids(&self, parent: &str) -> Vec<String> {
        let conn = self.lock_conn();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM work_items
             WHERE id LIKE ?1 || '.%' AND id NOT LIKE ?1 || '.%.%'",
        ) else {
            return Vec::new();
        };
        stmt.query_map(params![parent], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    // --- seat stats (P3) + seat burn (P8) ------------------------------------

    /// Upsert one seat's stats: `last_run_at` advances only when given (and
    /// never backwards), `items_filed` accumulates by the given delta.
    pub fn upsert_seat_stat(
        &self,
        seat: &str,
        last_run_at: Option<i64>,
        items_filed_delta: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO seat_stats (seat, last_run_at, items_filed, updated_at)
             VALUES (?1, ?2, MAX(0, ?3), ?4)
             ON CONFLICT(seat) DO UPDATE SET
                last_run_at = CASE
                    WHEN excluded.last_run_at IS NULL THEN last_run_at
                    ELSE MAX(excluded.last_run_at, COALESCE(last_run_at, 0))
                END,
                items_filed = MAX(0, items_filed + ?3),
                updated_at = excluded.updated_at",
            params![seat, last_run_at, items_filed_delta, crate::ledger::now_millis()],
        )?;
        Ok(())
    }

    pub fn get_seat_stat(&self, seat: &str) -> Option<SeatStatRow> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT seat, last_run_at, items_filed, updated_at
             FROM seat_stats WHERE seat = ?1",
            params![seat],
            |r| {
                Ok(SeatStatRow {
                    seat: r.get(0)?,
                    last_run_at: r.get(1)?,
                    items_filed: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            },
        )
        .ok()
    }

    pub fn list_seat_stats(&self) -> rusqlite::Result<Vec<SeatStatRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT seat, last_run_at, items_filed, updated_at
             FROM seat_stats ORDER BY seat",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SeatStatRow {
                seat: r.get(0)?,
                last_run_at: r.get(1)?,
                items_filed: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Additive burn upsert: every counter accumulates onto the `(seat, day)`
    /// row (`day` = local `YYYY-MM-DD`, the caller formats it). Tokens only —
    /// money is computed at render time elsewhere.
    #[allow(clippy::too_many_arguments)]
    pub fn add_seat_burn(
        &self,
        seat: &str,
        day: &str,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        spawns: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO seat_burn (seat, day, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, spawns, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(seat, day) DO UPDATE SET
                input_tokens = input_tokens + ?3,
                output_tokens = output_tokens + ?4,
                cache_read_tokens = cache_read_tokens + ?5,
                cache_creation_tokens = cache_creation_tokens + ?6,
                spawns = spawns + ?7,
                updated_at = excluded.updated_at",
            params![
                seat,
                day,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                spawns,
                crate::ledger::now_millis()
            ],
        )?;
        Ok(())
    }

    /// Per-seat totals across all days (`day` = None in the rollup rows).
    pub fn seat_burn_totals_by_seat(&self) -> rusqlite::Result<Vec<SeatBurnRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT seat, SUM(input_tokens), SUM(output_tokens),
                    SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(spawns)
             FROM seat_burn GROUP BY seat ORDER BY seat",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SeatBurnRow {
                seat: Some(r.get(0)?),
                day: None,
                input_tokens: r.get(1)?,
                output_tokens: r.get(2)?,
                cache_read_tokens: r.get(3)?,
                cache_creation_tokens: r.get(4)?,
                spawns: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Per-day totals across all seats (`seat` = None), newest day first,
    /// bounded by `limit`.
    pub fn seat_burn_totals_by_day(&self, limit: i64) -> rusqlite::Result<Vec<SeatBurnRow>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT day, SUM(input_tokens), SUM(output_tokens),
                    SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(spawns)
             FROM seat_burn GROUP BY day ORDER BY day DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.max(1)], |r| {
            Ok(SeatBurnRow {
                seat: None,
                day: Some(r.get(0)?),
                input_tokens: r.get(1)?,
                output_tokens: r.get(2)?,
                cache_read_tokens: r.get(3)?,
                cache_creation_tokens: r.get(4)?,
                spawns: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    // --- overnight queue (P0) -------------------------------------------------

    /// The ready plan queue IS this query: sessions the human approved that
    /// were never run — `status = 'approved' AND run_state IS NULL` (a plain
    /// Approve leaves `run_state` NULL; every launch beacon sets it, and a
    /// queued run that parks lands in `awaiting_review`, so nothing re-queues).
    /// Oldest first (FIFO); returns `(session_id, project_path, project_name)`.
    pub fn list_queue_ready_sessions(&self) -> rusqlite::Result<Vec<(String, String, String)>> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT session_id, project_path, project_name FROM sessions
             WHERE status = 'approved' AND run_state IS NULL
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    // =======================================================================
    // PRODUCER FILING SEAM (unique anchor: producers-wave-work-filing)
    //
    // The one shared helper pair behind every to-do *producer* (plan approval,
    // review landing, exit report, Librarian, Shipwright, friction watch):
    // an idempotency lookup plus a mint-and-file that mirrors `work.rs`'s id
    // law. Kept here beside the work-graph SQL because `work.rs` is a sealed
    // state plane (its minting is private by design — the intake precedent
    // already blessed mirroring it rather than opening the plane).
    // =======================================================================

    /// Idempotency lookup for work-item producers: the newest NON-CLOSED item
    /// matching `origin_kind` and, when given, `origin_id` / `title` exactly.
    /// A producer re-deriving the same backlog checks here and skips — closed
    /// items deliberately do NOT match, so finished work can honestly recur.
    /// `Ok(None)` is a REAL no-match; a DB/I-O fault surfaces as `Err` so a
    /// producer can refuse to file rather than degrade its idempotency to
    /// best-effort and duplicate under faults.
    pub fn find_unclosed_work_item(
        &self,
        origin_kind: &str,
        origin_id: Option<&str>,
        title: Option<&str>,
    ) -> rusqlite::Result<Option<crate::work::WorkItem>> {
        let conn = self.lock_conn();
        match conn.query_row(
            &format!(
                "SELECT {} FROM work_items
                 WHERE status != 'closed'
                   AND origin_kind = ?1
                   AND (?2 IS NULL OR origin_id = ?2)
                   AND (?3 IS NULL OR title = ?3)
                 ORDER BY created_at DESC LIMIT 1",
                Self::WORK_ITEM_COLS
            ),
            params![origin_kind, origin_id, title],
            Self::row_to_work_item,
        ) {
            Ok(item) => Ok(Some(item)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// File one produced work item: dedupe on the `(origin_kind, origin_id?,
    /// title)` provenance triple (an unclosed match skips the write and
    /// returns `Ok(None)`), mint the id under `work.rs`'s law (root `rl-` +
    /// sha256 prefix lengthened on collision; child `<parent>.N`, never
    /// reusing a freed ordinal), insert the row, record the `parent-child`
    /// edge when parented, and append the `work_file` chain event via the
    /// existing helper (logged-not-dropped on failure, never blocking the row
    /// write). Origin stays PROVENANCE, never ownership — TEXT breadcrumbs
    /// only, exactly as the schema law above demands. Unknown `kind`/`status`
    /// normalize (`task` / `open`) instead of failing: a producer must never
    /// turn its host path fragile.
    #[allow(clippy::too_many_arguments)]
    pub fn file_produced_work_item(
        &self,
        title: &str,
        body: Option<&str>,
        kind: &str,
        status: &str,
        priority: i64,
        origin_kind: &str,
        origin_id: Option<&str>,
        project_path: Option<&str>,
        parent: Option<&str>,
        actor: &str,
    ) -> Result<Option<String>, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("a produced work item needs a title".to_string());
        }
        let origin_kind = origin_kind.trim();
        if origin_kind.is_empty() {
            return Err("a produced work item needs an origin_kind".to_string());
        }
        let origin_id = origin_id.map(str::trim).filter(|s| !s.is_empty());
        match self.find_unclosed_work_item(origin_kind, origin_id, Some(title)) {
            Ok(Some(_)) => return Ok(None), // already standing — the producer is re-running
            Ok(None) => {}
            Err(e) => {
                // Without the idempotency answer, filing could duplicate —
                // SKIP (the producer re-derives next pass) rather than guess.
                tracing::warn!(
                    origin_kind = %origin_kind, title = %title, error = %e,
                    "work-item idempotency lookup failed; skipping the filing"
                );
                return Err(format!("idempotency lookup failed: {e}"));
            }
        }
        let kind = if crate::work::WORK_KINDS.contains(&kind) {
            kind
        } else {
            "task"
        };
        let status = if matches!(status, "open" | "held") {
            status
        } else {
            "open"
        };
        let now = crate::ledger::now_millis();
        let id = match parent.map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => {
                if self.get_work_item(p).is_none() {
                    return Err(format!("no parent work item `{p}`"));
                }
                // `<parent>.N`, one past the highest existing direct-child
                // ordinal — mirrors `work.rs::mint_child_id` exactly.
                let next = self
                    .work_child_ids(p)
                    .iter()
                    .filter_map(|id| id.rsplit('.').next()?.parse::<i64>().ok())
                    .max()
                    .unwrap_or(0)
                    + 1;
                format!("{p}.{next}")
            }
            None => {
                // `rl-` + sha256 prefix, lengthened (4, 8, 12, 16) until it
                // misses every row — mirrors `work.rs::mint_root_id` exactly.
                let mut minted = None;
                'mint: for salt in 0u32.. {
                    let hash = crate::ledger::sha256_hex(
                        format!("{title}\n{now}\n{salt}").as_bytes(),
                    );
                    for len in [4usize, 8, 12, 16] {
                        let cand = format!("rl-{}", &hash[..len]);
                        if self.get_work_item(&cand).is_none() {
                            minted = Some(cand);
                            break 'mint;
                        }
                    }
                }
                minted.expect("the salt walk always finds a free id")
            }
        };
        let item = crate::work::WorkItem {
            id: id.clone(),
            title: title.to_string(),
            body: body.map(str::to_string).filter(|s| !s.trim().is_empty()),
            status: status.to_string(),
            priority,
            kind: kind.to_string(),
            assignee: None,
            claimed_at: None,
            lease_expires_at: None,
            closed_at: None,
            close_reason: None,
            defer_until: None,
            origin_kind: Some(origin_kind.to_string()),
            origin_id: origin_id.map(str::to_string),
            project_path: project_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            pinned: false,
            created_at: now,
            updated_at: now,
        };
        self.insert_work_item(&item).map_err(|e| e.to_string())?;
        if let Some(p) = parent.map(str::trim).filter(|p| !p.is_empty()) {
            // Mirrors the record_work_event pattern below: the failure is
            // logged WITH both ids — never silently dropped, never blocking
            // the filed item.
            if let Err(e) = self.insert_work_edge(p, &id, "parent-child", Some(actor), now) {
                tracing::warn!(parent = %p, item = %id, error = %e, "produced parent-child edge insert failed");
            }
        }
        let detail = match origin_id {
            Some(oid) => format!("{origin_kind}:{oid}"),
            None => origin_kind.to_string(),
        };
        if let Err(e) = crate::ledger::record_work_event(
            self,
            crate::ledger::EventKind::WorkFile,
            &id,
            Some(actor),
            Some(&detail),
            now,
        ) {
            tracing::warn!(item = %id, error = %e, "produced work_file chain append failed");
        }
        Ok(Some(id))
    }

    /// Moot-only upsert (see `moot::land_doc`): like [`Database::upsert_draft`]
    /// but RESETS `doc_json` to NULL alongside the fresh markdown mirror.
    /// `upsert_draft`'s COALESCE deliberately protects a TipTap body from
    /// markdown-only writers — the right law for every one-shot landing path
    /// (intake triage, Shipwright, draft_chat's flush). The moot is the one
    /// writer that re-renders the WHOLE document on every land: a human
    /// Drafter save between rounds stores a `doc_json` that would otherwise
    /// win on open forever (the Drafter prefers the TipTap body), hiding
    /// every later round behind a stale body. Clearing it makes the mirror
    /// the document again; the frontend rebuilds the body from it on next
    /// open. The tradeoff — TipTap-only detail in the human's save is
    /// dropped — is documented and accepted at the moot call site, which
    /// folds the human's mirror delta into the transcript BEFORE landing.
    /// Keep this out of every other landing path.
    pub fn upsert_draft_reset_doc(
        &self,
        draft_id: &str,
        title: Option<&str>,
        project_path: Option<&str>,
        doc_markdown: &str,
    ) -> rusqlite::Result<()> {
        let now = crate::ledger::now_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO drafts (draft_id, title, project_path, doc_markdown, doc_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
             ON CONFLICT(draft_id) DO UPDATE SET
                title = CASE WHEN drafts.title_is_user_set = 1 THEN drafts.title
                             ELSE COALESCE(excluded.title, drafts.title) END,
                project_path = excluded.project_path,
                doc_markdown = excluded.doc_markdown,
                doc_json = NULL,
                updated_at = excluded.updated_at",
            params![draft_id, title, project_path, doc_markdown, now],
        )?;
        Ok(())
    }
}

/// One `browse_list_items` row → a `BrowseListItem`.
///
/// Shared by the by-id read and the per-tab list so the two can never drift on
/// column order — the failure mode of duplicating an 11-column mapping is a
/// silent field swap, not a compile error.
fn row_to_browse_list_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrowseListItem> {
    Ok(BrowseListItem {
        id: row.get(0)?,
        browse_id: row.get(1)?,
        kind: row.get(2)?,
        body: row.get(3)?,
        done: row.get::<_, i64>(4)? != 0,
        sort_idx: row.get(5)?,
        page_url: row.get(6)?,
        page_title: row.get(7)?,
        locator: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn session_status_str(s: SessionStatus) -> &'static str {
    match s {
        SessionStatus::InReview => "in_review",
        SessionStatus::Approved => "approved",
        SessionStatus::Aborted => "aborted",
    }
}

fn session_status_from(s: &str) -> SessionStatus {
    match s {
        "approved" => SessionStatus::Approved,
        "aborted" => SessionStatus::Aborted,
        _ => SessionStatus::InReview,
    }
}

/// The batched-read rewrites from the retrieval latency work. Each of these
/// replaced an N+1 (one query per page row, or per link) with one query per
/// page — so the assertions are about RESULTS being identical to what the
/// per-row probes produced, since the plan-level win is guarded separately in
/// `query_plan_guards`.
#[cfg(test)]
mod batched_read_tests {
    use super::*;

    fn seed_prompt(db: &Database, body: &str) -> i64 {
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty_plan".to_string(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("s1".to_string()),
                claude_session_id: Some(format!("cs-{body}")),
                mission_id: None,
                project_path: Some("/repo".to_string()),
                body: body.to_string(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .expect("the prompt must have been recorded")
    }

    /// The Timeline's filing column, batched. The precedence rule survives:
    /// the EARLIEST accepted link wins, exactly as `ORDER BY cl.id LIMIT 1`
    /// used to give.
    #[test]
    fn batched_filing_keeps_earliest_link_precedence() {
        let db = Database::open_in_memory().unwrap();
        let seq = seed_prompt(&db, "wire the loop executor");
        db.seed_class_roots(&[
            ("n-first".into(), "First Home".into(), None),
            ("n-second".into(), "Second Home".into(), None),
        ])
        .unwrap();
        // Two accepted filings on the SAME target; the earlier link id wins.
        for node in ["n-first", "n-second"] {
            db.stage_proposal(
                None,
                &crate::classmem::Proposal::File {
                    parent_id: node.into(),
                    sub_class: None,
                    target_kind: "prompt".into(),
                    target_id: seq.to_string(),
                    note: None,
                    rationale: None,
                },
            )
            .unwrap();
        }
        db.accept_all_pending("yusuf").unwrap();

        let items = db
            .query_ledger_events(&crate::context::LedgerFilters::default())
            .unwrap();
        let row = items.iter().find(|i| i.event.seq == seq).unwrap();
        assert_eq!(row.class_node_id.as_deref(), Some("n-first"));
        assert_eq!(row.class_title.as_deref(), Some("First Home"));
    }

    /// The batched link decorations must match what the per-link probes gave.
    #[test]
    fn link_previews_and_supersessions_batch_correctly() {
        let db = Database::open_in_memory().unwrap();
        let a = seed_prompt(&db, "first body");
        let b = seed_prompt(&db, "second body");
        let labels = db.link_previews_for_seqs(&[a, b, 9_999]).unwrap();
        assert_eq!(labels.get(&a).map(String::as_str), Some("first body"));
        assert_eq!(labels.get(&b).map(String::as_str), Some("second body"));
        assert!(labels.get(&9_999).is_none(), "absent seqs are absent");
        // Empty in, empty out — no query, no panic.
        assert!(db.link_previews_for_seqs(&[]).unwrap().is_empty());
        assert!(db.supersessions_for_seqs(&[]).unwrap().is_empty());
    }

    /// `load_session` must reconstruct exactly what `load_all` did for that
    /// one id — the whole point is that the route stopped paying for the rest.
    #[test]
    fn load_session_matches_load_all_for_one_id() {
        use crate::state::{AttachState, ReviewSession, SessionStatus};
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str| ReviewSession {
            session_id: id.to_string(),
            project_path: "/repo".to_string(),
            project_name: "repo".to_string(),
            created_at: 500,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 500,
            run_state: None,
            backend: None,
            model: None,
        effort: None,
        };
        for id in ["wanted", "other"] {
            db.upsert_session(&mk(id)).unwrap();
            db.insert_revision(
                id,
                &crate::state::Revision {
                    version_number: 1,
                    received_at: 600,
                    raw_plan_markdown: format!("# Plan {id}\n\nDo the thing."),
                    sections: Vec::new(),
                    comments: Vec::new(),
                    thread_start: false,
                    restored: false,
                },
            )
            .unwrap();
        }

        let all = db.load_all().unwrap();
        let one = db.load_session("wanted").unwrap().expect("session exists");
        let from_all = all.get("wanted").unwrap();
        assert_eq!(one.session_id, from_all.session_id);
        assert_eq!(one.revisions.len(), from_all.revisions.len());
        assert_eq!(
            one.revisions[0].raw_plan_markdown,
            from_all.revisions[0].raw_plan_markdown
        );
        assert_eq!(one.revisions[0].sections.len(), from_all.revisions[0].sections.len());
        // …and it does NOT drag the other session along.
        assert_eq!(all.len(), 2);
        assert!(db.load_session("nope").unwrap().is_none());
    }

    /// The incremental verify must agree with the full walk, keep agreeing as
    /// the chain grows, and fall back to the full walk when its anchor can't
    /// be trusted.
    #[test]
    fn incremental_chain_verify_tracks_the_full_walk() {
        let db = Database::open_in_memory().unwrap();
        // Empty chain: both agree, and the anchor is established.
        assert!(db.verify_ledger_chain_incremental().unwrap().ok);

        seed_prompt(&db, "one");
        seed_prompt(&db, "two");
        let full = db.verify_ledger_chain().unwrap();
        let inc = db.verify_ledger_chain_incremental().unwrap();
        assert!(inc.ok);
        assert_eq!(inc.head_hash, full.head_hash);
        assert_eq!(inc.checked, full.checked);

        // Grow it; the suffix walk keeps up.
        seed_prompt(&db, "three");
        let full = db.verify_ledger_chain().unwrap();
        let inc = db.verify_ledger_chain_incremental().unwrap();
        assert!(inc.ok);
        assert_eq!(inc.head_hash, full.head_hash);
        assert_eq!(inc.checked, full.checked);

        // A no-growth call is a pure anchor hit and still reports the head.
        let again = db.verify_ledger_chain_incremental().unwrap();
        assert!(again.ok);
        assert_eq!(again.head_hash, full.head_hash);

        // Corruption in the SUFFIX — the part the incremental walk actually
        // reads — must be caught exactly as the full walk catches it.
        seed_prompt(&db, "four");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE ledger_events SET ts = ts + 1 WHERE seq = 4", [])
                .unwrap();
        }
        assert!(!db.verify_ledger_chain().unwrap().ok);
        let broken = db.verify_ledger_chain_incremental().unwrap();
        assert!(!broken.ok);
        assert_eq!(broken.first_bad_seq, Some(4));
    }

    /// The documented blind spot, pinned as a test so nobody later mistakes
    /// the incremental verify for the full one: a retroactive edit to an
    /// ALREADY-VERIFIED row slips past it. The 6h `ledger-backup` deep walk is
    /// what catches that, which is why it stays wired up.
    #[test]
    fn incremental_verify_cannot_see_retroactive_tampering() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "one");
        seed_prompt(&db, "two");
        seed_prompt(&db, "three");
        // Anchor on the verified head.
        assert!(db.verify_ledger_chain_incremental().unwrap().ok);

        // Tamper with an old row, leaving its stored entry_hash alone.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE ledger_events SET ts = ts + 1 WHERE seq = 1", [])
                .unwrap();
        }
        assert!(
            !db.verify_ledger_chain().unwrap().ok,
            "the deep walk catches it"
        );
        assert!(
            db.verify_ledger_chain_incremental().unwrap().ok,
            "the incremental walk does NOT — this is the stated trade, not a bug"
        );
    }

    /// A garbage anchor must not be trusted — the verify falls back to the
    /// full walk and re-anchors rather than reporting a chain it never read.
    #[test]
    fn incremental_verify_falls_back_on_a_bad_anchor() {
        let db = Database::open_in_memory().unwrap();
        seed_prompt(&db, "one");
        seed_prompt(&db, "two");
        assert!(db.verify_ledger_chain_incremental().unwrap().ok);

        // An anchor pointing past the head (a rewound chain) and one whose
        // hash no longer matches both have to re-verify from scratch.
        // The anchor lives in the store's own `polis_meta` since Session A3.
        db.set_meta(PolisStore::VERIFY_LAST_SEQ, "9999").unwrap();
        assert!(db.verify_ledger_chain_incremental().unwrap().ok);
        assert_eq!(
            db.meta(PolisStore::VERIFY_LAST_SEQ).unwrap().as_deref(),
            Some("2"),
            "the fallback re-anchors on the real head"
        );

        db.set_meta(PolisStore::VERIFY_HEAD_HASH, &"0".repeat(64))
            .unwrap();
        let v = db.verify_ledger_chain_incremental().unwrap();
        assert!(v.ok);
        assert_eq!(v.checked, 2, "it walked the whole chain, not a suffix");
    }
}

/// The prompt lake's FTS index. `prompts` is not insert-only — compaction and
/// explicit forget rewrite rows in place — so these cover the trigger set that
/// `browse_events_fts` never needed.
#[cfg(test)]
mod prompt_fts_tests {
    use super::*;

    fn seed(db: &Database, body: &str) -> i64 {
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty_plan".to_string(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("s1".to_string()),
                claude_session_id: Some(format!("cs-{body}")),
                mission_id: None,
                project_path: Some("/repo".to_string()),
                body: body.to_string(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap()
    }

    fn prompt_id_for(db: &Database, seq: i64) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT prompt_id FROM ledger_events WHERE seq = ?1",
            params![seq],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The index must follow a body through its whole life: indexed on write,
    /// re-indexed to the gist on compaction (released words genuinely stop
    /// matching), and dropped on delete.
    #[test]
    fn prompts_fts_survives_compaction_and_forget() {
        let db = Database::open_in_memory().unwrap();
        let seq = seed(&db, "wire the loop executor before the demo");
        seed(&db, "an unrelated widget migration");

        // Insert trigger: searchable immediately.
        let hits = db.search_prompts_fts("executor", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].seq, seq);

        // Compaction: the gist becomes the searchable text…
        let pid = prompt_id_for(&db, seq);
        db.compact_prompt_body(pid, "gist: the loop executor decision", "cold", "agent", "keeper")
            .unwrap();
        assert_eq!(
            db.search_prompts_fts("decision", 10).unwrap().len(),
            1,
            "the gist's words are searchable after compaction"
        );
        // …and the RELEASED words are gone from the index. "executor" survives
        // only because the gist happens to repeat it; "demo" did not.
        assert!(
            db.search_prompts_fts("demo", 10).unwrap().is_empty(),
            "released words must stop matching — that is what forgetting means"
        );

        // Explicit forget replaces the body with the sentinel.
        let pid2 = prompt_id_for(&db, 2);
        db.compact_prompt_body(pid2, "[forgotten]", "forget", "deterministic", "yusuf")
            .unwrap();
        assert!(db.search_prompts_fts("widget", 10).unwrap().is_empty());

        // The index agrees with itself.
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO prompts_fts(prompts_fts) VALUES('integrity-check')", [])
            .expect("prompts_fts integrity-check must pass");
    }

    /// The `?q=` route filters through FTS when the query tokenizes, and falls
    /// back to a bound LIKE when it doesn't — either way it returns rows, in
    /// the route's own seq order.
    #[test]
    fn context_prompts_selects_fts_or_falls_back_to_like() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, "wire the loop executor");
        seed(&db, "unrelated widget migration");
        seed(&db, "a second loop change");

        let find = |q: &str| {
            db.list_context_prompts(&crate::context::PromptFilters {
                substring: Some(q.to_string()),
                limit: 50,
                ..Default::default()
            })
            .unwrap()
        };
        // FTS path: token match, and the route's ascending seq order holds.
        let loops = find("loop");
        assert_eq!(loops.len(), 2);
        assert!(loops[0].seq < loops[1].seq, "seq ordering is unchanged");
        // FTS is word-based: a query of pure punctuation has no tokens and
        // must fall through to LIKE rather than erroring.
        assert!(find("!!!").is_empty(), "the LIKE fallback matched nothing");
        assert_eq!(find("widget").len(), 1);
        // A term that only appears mid-word is an honest FTS miss, not a crash.
        assert!(find("idge").is_empty());
    }

    /// An injection-shaped query can only ever fail to match.
    #[test]
    fn prompt_search_neutralizes_fts_operators() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, "wire the loop executor");
        // FTS5 operators are quoted into literals by `sanitize_fts_query`.
        assert!(db.search_prompts_fts("loop OR widget*", 10).unwrap().len() <= 1);
        assert!(db.search_prompts_fts("\"", 10).unwrap().is_empty());
        assert!(db.search_prompts_fts("loop NEAR(x)", 10).unwrap().len() <= 1);
    }
}

/// Query-plan guards for the retrieval hot path. A perf regression here is
/// invisible in behavior — every one of these queries returns the same rows
/// whether it uses an index or scans the table — so the assertion is on the
/// PLAN, not the result. If one of these starts failing, an index was dropped
/// or a WHERE clause was rewritten past the index it was shaped for.
///
/// The rule: a hot read may not `SCAN` a table that grows with the record
/// (`ledger_events`, `prompts`, `class_links`, `user_notes`).
#[cfg(test)]
mod query_plan_guards {
    use super::*;

    /// Assert the planner reaches every named table through an index. The
    /// table name is matched to a word boundary — `SCAN prompts_fts VIRTUAL
    /// TABLE INDEX` is an FTS MATCH lookup, not a scan of `prompts`.
    fn assert_indexed(db: &Database, what: &str, sql: &str, tables: &[&str]) {
        let plan = db.explain_query_plan(sql).expect("EXPLAIN failed");
        for t in tables {
            let scanned = plan.split(" | ").any(|step| {
                step == format!("SCAN {t}") || step.starts_with(&format!("SCAN {t} "))
            });
            assert!(
                !scanned,
                "{what}: `{t}` is a full table SCAN — the retrieval hot path must \
                 stay indexed.\n  plan: {plan}"
            );
        }
        assert!(
            plan.contains("USING INDEX") || plan.contains("USING COVERING INDEX"),
            "{what}: the planner picked no index at all.\n  plan: {plan}"
        );
    }

    /// The Timeline's filing probe — "which accepted class is this target filed
    /// under?" — runs once per page row. It reads `class_links` in the
    /// target→node direction, which `idx_class_links_node` cannot serve.
    #[test]
    fn timeline_filing_probe_uses_the_target_index() {
        let db = Database::open_in_memory().unwrap();
        assert_indexed(
            &db,
            "timeline filing probe",
            "SELECT cl.node_id, cn.title, MIN(cl.id) FROM class_links cl
             JOIN class_nodes cn ON cn.id = cl.node_id
             WHERE cl.status = 'accepted'
               AND cl.target_kind IN ('prompt', 'decision', 'revision', 'note')
               AND cl.target_id IN ('1', '2')
             GROUP BY cl.target_id",
            &["class_links"],
        );
    }

    /// `/v1/context/prompts?q=` — the exact statement the route builds. The FTS
    /// filter narrows `prompts` first, so the join runs prompts→ledger, and
    /// without `idx_ledger_prompt` that direction scans the whole chain per
    /// matching prompt. This is the query that used to be a LIKE cross-scan.
    #[test]
    fn context_prompts_search_uses_fts_and_the_prompt_index() {
        let db = Database::open_in_memory().unwrap();
        let sql = "SELECT le.seq FROM prompts p
             JOIN ledger_events le ON le.prompt_id = p.id
             WHERE 1 = 1
               AND p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH '\"x\"')
             ORDER BY le.seq ASC LIMIT 10";
        assert_indexed(&db, "context prompts search", sql, &["ledger_events", "prompts"]);
        let plan = db.explain_query_plan(sql).unwrap();
        assert!(
            plan.contains("prompts_fts"),
            "the search must go through the FTS index, not a body scan.\n  plan: {plan}"
        );
    }

    /// The answer pack's bm25 arm drives from the FTS index.
    #[test]
    fn prompt_search_drives_from_the_fts_index() {
        let db = Database::open_in_memory().unwrap();
        let plan = db
            .explain_query_plan(
                "SELECT le.seq FROM prompts_fts
                 JOIN prompts p ON p.id = prompts_fts.rowid
                 JOIN ledger_events le ON le.prompt_id = p.id
                 WHERE prompts_fts MATCH '\"x\"' AND le.kind = 'prompt'
                 ORDER BY bm25(prompts_fts) LIMIT 10",
            )
            .unwrap();
        assert!(
            !plan.split(" | ").any(|s| s.starts_with("SCAN prompts ")),
            "the prompt table must be reached by rowid from the index.\n  plan: {plan}"
        );
        assert!(plan.contains("prompts_fts"), "plan: {plan}");
    }

    /// The Timeline's own search box — the last `LIKE '%…%'` full scan on the
    /// surface, and the one the user drives directly.
    ///
    /// What must be true: the match set comes from the index (once, as a
    /// materialized list), and `prompts` is reached by rowid rather than
    /// scanned. What must NOT be asserted: that `ledger_events` is untouched.
    /// The Timeline is `ORDER BY le.seq DESC LIMIT n` over the whole chain, so
    /// SQLite walks the seq b-tree backwards and stops at the limit — that walk
    /// IS the ordering, and driving from the FTS index instead would mean
    /// sorting by relevance, which is precisely the thing the design law
    /// forbids here. The win is that the walk no longer reads a 6.3 KB body per
    /// row to run a LIKE against it.
    #[test]
    fn timeline_q_drives_from_the_fts_index() {
        let db = Database::open_in_memory().unwrap();
        let sql = "SELECT le.seq FROM ledger_events le
             LEFT JOIN prompts p ON p.id = le.prompt_id
             WHERE 1 = 1
               AND p.id IN (SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH '\"x\"')
             ORDER BY le.seq DESC LIMIT 100";
        let plan = db.explain_query_plan(sql).unwrap();
        assert!(
            plan.contains("prompts_fts"),
            "the Timeline's ?q= must ride the index, not scan every body.\n  plan: {plan}"
        );
        assert!(
            plan.contains("LIST SUBQUERY"),
            "the index probe must be materialized once, not re-run per row.\n  plan: {plan}"
        );
        assert!(
            !plan.split(" | ").any(|s| s == "SCAN p" || s.starts_with("SCAN p ")),
            "`prompts` must be reached by rowid, never scanned.\n  plan: {plan}"
        );
        assert!(
            !plan.contains("USE TEMP B-TREE"),
            "the seq order must come from the index, never a sort.\n  plan: {plan}"
        );
    }

    /// The grep arm must ride the trigram index. Without one there is no
    /// candidate set at all and `LIKE '%…%'` degenerates into a 7 MB scan under
    /// the connection lock — which is exactly why a bare `regexp` function was
    /// rejected in favour of this shape.
    #[test]
    fn grep_drives_from_the_trigram_index() {
        let db = Database::open_in_memory().unwrap();
        let plan = db
            .explain_query_plan(
                "SELECT le.seq FROM prompts_grep
                 JOIN prompts p ON p.id = prompts_grep.rowid
                 JOIN ledger_events le ON le.prompt_id = p.id AND le.kind = 'prompt'
                 WHERE prompts_grep.fts_text LIKE '%needle%' ESCAPE '\\'
                 ORDER BY le.seq DESC LIMIT 30",
            )
            .unwrap();
        assert!(
            plan.contains("prompts_grep VIRTUAL TABLE INDEX"),
            "the LIKE must be answered by the trigram index.\n  plan: {plan}"
        );
        assert!(
            !plan.split(" | ").any(|s| s == "SCAN p" || s.starts_with("SCAN p ")),
            "`prompts` must be reached by rowid, never scanned.\n  plan: {plan}"
        );
    }

    /// Node resolution rides `class_nodes_fts`, not a LIKE over the catalog.
    #[test]
    fn class_node_match_drives_from_the_fts_index() {
        let db = Database::open_in_memory().unwrap();
        let plan = db
            .explain_query_plan(
                "SELECT n.id FROM class_nodes_fts
                 JOIN class_nodes n ON n.rowid = class_nodes_fts.rowid
                 WHERE class_nodes_fts MATCH '\"loop\"'
                 ORDER BY -bm25(class_nodes_fts, 5.0, 1.0) DESC LIMIT 5",
            )
            .unwrap();
        assert!(plan.contains("class_nodes_fts"), "plan: {plan}");
        assert!(
            !plan.split(" | ").any(|s| s.starts_with("SCAN class_nodes ")
                || s == "SCAN class_nodes"),
            "the catalog must be reached by rowid from its index.\n  plan: {plan}"
        );
    }

    /// The session spine (`/v1/context/sessions/:id/history`).
    #[test]
    fn session_events_use_the_session_index() {
        let db = Database::open_in_memory().unwrap();
        assert_indexed(
            &db,
            "session events",
            "SELECT seq FROM ledger_events WHERE session_id = 'abc' ORDER BY seq ASC",
            &["ledger_events"],
        );
    }

    /// The activity ribbon's date range.
    #[test]
    fn ledger_ts_range_uses_the_ts_index() {
        let db = Database::open_in_memory().unwrap();
        assert_indexed(
            &db,
            "ledger ts range",
            "SELECT seq FROM ledger_events WHERE ts >= 1 AND ts <= 2",
            &["ledger_events"],
        );
    }

    /// `compaction_stats` runs on every memory-status poll; the partial index
    /// turns it into an index-only scan over the compacted set instead of a
    /// walk of every prompt body in the lake.
    #[test]
    fn compaction_stats_uses_the_partial_index() {
        let db = Database::open_in_memory().unwrap();
        let plan = db
            .explain_query_plan(
                "SELECT COUNT(*), COALESCE(SUM(original_bytes), 0), MAX(compacted_at)
                 FROM prompts WHERE gist IS NOT NULL",
            )
            .unwrap();
        assert!(
            plan.contains("idx_prompts_compacted"),
            "compaction_stats must ride the partial index.\n  plan: {plan}"
        );
    }

    /// The Timeline's two `user_notes` probes carry no `target_kind <> 'none'`
    /// predicate, so the pre-existing PARTIAL unique index could not serve them.
    #[test]
    fn user_note_probe_uses_the_unfiltered_target_index() {
        let db = Database::open_in_memory().unwrap();
        assert_indexed(
            &db,
            "user note probe",
            "SELECT text FROM user_notes WHERE target_kind = 'ledger_event' AND target_id = '7'",
            &["user_notes"],
        );
    }
}

/// The work-graph deep-logic battery: ready-CTE semantics, the claim race,
/// lease expiry, ledger-chain integrity, origin-outliving, and the state-plane
/// boundary guard. Lives beside the SQL it verifies (the work-graph region of
/// `impl Database` above).
#[cfg(test)]
mod work_graph_tests {
    use super::*;
    use crate::ledger::EventKind;
    use crate::work::WorkItem;
    use std::sync::Arc;

    fn item(id: &str, now: i64) -> WorkItem {
        WorkItem {
            id: id.to_string(),
            title: format!("item {id}"),
            body: None,
            status: "open".to_string(),
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
        }
    }

    fn ready_ids(db: &Database, now: i64) -> Vec<String> {
        let mut ids: Vec<String> = db
            .list_ready_work_items(None, now, 50)
            .unwrap()
            .into_iter()
            .map(|i| i.id)
            .collect();
        ids.sort();
        ids
    }

    // --- (a) ready-CTE semantics -----------------------------------------

    #[test]
    fn ready_hides_a_blocked_item_until_its_blocker_closes() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        db.insert_work_item(&item("rl-blkr", now)).unwrap();
        db.insert_work_item(&item("rl-tgt", now)).unwrap();
        db.insert_work_edge("rl-blkr", "rl-tgt", "blocks", None, now)
            .unwrap();
        // The unclosed blocker hides the target; the blocker itself is ready.
        assert_eq!(ready_ids(&db, now), vec!["rl-blkr"]);
        // Blocker closes → the target appears.
        assert!(db.close_work_item("rl-blkr", Some("done"), now).unwrap());
        assert_eq!(ready_ids(&db, now), vec!["rl-tgt"]);
        // A dangling blocks edge (from-item row never existed) does NOT
        // block: there is no item left to close (schema law — no FKs).
        db.insert_work_edge("rl-ghost", "rl-tgt", "blocks", None, now)
            .unwrap();
        assert_eq!(ready_ids(&db, now), vec!["rl-tgt"]);
        // A non-blocks edge from an open item does not block either.
        db.insert_work_item(&item("rl-rel", now)).unwrap();
        db.insert_work_edge("rl-rel", "rl-tgt", "relates-to", None, now)
            .unwrap();
        assert_eq!(ready_ids(&db, now), vec!["rl-rel", "rl-tgt"]);
        // CLAIMED and HELD blockers still block — the CTE rule is
        // `b.status != 'closed'`, not `== 'open'`.
        db.insert_work_item(&item("rl-cblk", now)).unwrap();
        db.insert_work_item(&item("rl-tgt2", now)).unwrap();
        db.insert_work_edge("rl-cblk", "rl-tgt2", "blocks", None, now)
            .unwrap();
        assert!(db
            .claim_work_item("rl-cblk", "agent-a", now, Some(now + 10_000))
            .unwrap());
        let mut held = item("rl-hblk", now);
        held.status = "held".to_string();
        db.insert_work_item(&held).unwrap();
        db.insert_work_edge("rl-hblk", "rl-tgt2", "blocks", None, now)
            .unwrap();
        assert!(
            !ready_ids(&db, now).contains(&"rl-tgt2".to_string()),
            "a claimed + a held blocker both stand — the target stays hidden"
        );
        // Closing the claimed one is not enough: the held one still blocks.
        assert!(db.close_work_item("rl-cblk", Some("done"), now).unwrap());
        assert!(
            !ready_ids(&db, now).contains(&"rl-tgt2".to_string()),
            "the held blocker alone still hides the target"
        );
        // Both closed → the target appears.
        assert!(db.close_work_item("rl-hblk", Some("done"), now).unwrap());
        assert!(ready_ids(&db, now).contains(&"rl-tgt2".to_string()));
    }

    #[test]
    fn ready_terminates_and_answers_sanely_on_a_parent_child_cycle() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        // Two items in a parent-child CYCLE, one of them deferred.
        let mut a = item("rl-cyc-a", now);
        a.defer_until = Some(now + 60_000);
        db.insert_work_item(&a).unwrap();
        db.insert_work_item(&item("rl-cyc-b", now)).unwrap();
        db.insert_work_edge("rl-cyc-a", "rl-cyc-b", "parent-child", None, now)
            .unwrap();
        db.insert_work_edge("rl-cyc-b", "rl-cyc-a", "parent-child", None, now)
            .unwrap();
        db.insert_work_item(&item("rl-solo", now)).unwrap();
        // The query RETURNS (`UNION` dedupes, so the recursive walk
        // terminates on the cycle) with sane content: both cycle members sit
        // beneath the deferred one, the free item is ready.
        assert_eq!(ready_ids(&db, now), vec!["rl-solo"]);
        // The defer passes → the whole cycle surfaces.
        assert_eq!(
            ready_ids(&db, now + 60_000),
            vec!["rl-cyc-a", "rl-cyc-b", "rl-solo"]
        );
    }

    #[test]
    fn unclosed_list_filters_inside_the_limit_and_edges_read_in_one_batch() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        // More OLD closed rows than the bound, then live items created later.
        for i in 0..60i64 {
            let mut it = item(&format!("rl-old{i}"), now - 1_000 + i);
            it.status = "closed".to_string();
            it.closed_at = Some(now);
            db.insert_work_item(&it).unwrap();
        }
        db.insert_work_item(&item("rl-live-a", now)).unwrap();
        db.insert_work_item(&item("rl-live-b", now + 1)).unwrap();
        db.insert_work_edge("rl-live-a", "rl-live-b", "blocks", None, now)
            .unwrap();
        // The closed filter sits INSIDE the limit: a bound smaller than the
        // closed backlog still returns every live item, no closed ones.
        let items = db.list_unclosed_work_items(50).unwrap();
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["rl-live-a", "rl-live-b"]);
        // ONE batched edges read over those ids returns each edge once.
        let owned: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        let edges = db.list_work_edges_touching_any(&owned, 50).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].edge_type, "blocks");
        assert_eq!(edges[0].from_id, "rl-live-a");
        // No ids → no read at all.
        assert!(db.list_work_edges_touching_any(&[], 50).unwrap().is_empty());
    }

    #[test]
    fn find_unclosed_distinguishes_no_match_from_a_db_fault() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        // A real no-match is Ok(None), never an error.
        assert!(db
            .find_unclosed_work_item("ghost", None, None)
            .unwrap()
            .is_none());
        let mut it = item("rl-idem", now);
        it.origin_kind = Some("test".to_string());
        db.insert_work_item(&it).unwrap();
        assert!(db
            .find_unclosed_work_item("test", None, None)
            .unwrap()
            .is_some());
        // A genuine DB fault surfaces as Err — and the producer path SKIPS
        // the filing on it instead of degrading idempotency to best-effort.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("ALTER TABLE work_items RENAME TO work_items_gone")
                .unwrap();
        }
        assert!(db.find_unclosed_work_item("test", None, None).is_err());
        assert!(
            db.file_produced_work_item(
                "t", None, "task", "open", 2, "test", None, None, None, "tester",
            )
            .is_err(),
            "filing must refuse (not duplicate) when the lookup faults"
        );
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch("ALTER TABLE work_items_gone RENAME TO work_items")
                .unwrap();
        }
        // The fault healed → nothing was filed during it.
        assert_eq!(db.list_work_items(None, None, 50).unwrap().len(), 1);
    }

    #[test]
    fn ready_hides_a_deferred_item_until_its_time_arrives() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        let mut d = item("rl-dfr", now);
        d.defer_until = Some(now + 5_000);
        db.insert_work_item(&d).unwrap();
        assert!(ready_ids(&db, now).is_empty(), "still deferred");
        // Boundary: `defer_until <= now` is ready.
        assert_eq!(ready_ids(&db, now + 5_000), vec!["rl-dfr"]);
    }

    #[test]
    fn ready_hides_descendants_of_a_deferred_ancestor() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        // Deferred parent → open child → open grandchild, plus a free sibling.
        let mut p = item("rl-par", now);
        p.defer_until = Some(now + 60_000);
        db.insert_work_item(&p).unwrap();
        db.insert_work_item(&item("rl-par.1", now)).unwrap();
        db.insert_work_item(&item("rl-par.1.1", now)).unwrap();
        db.insert_work_item(&item("rl-free", now)).unwrap();
        db.insert_work_edge("rl-par", "rl-par.1", "parent-child", None, now)
            .unwrap();
        db.insert_work_edge("rl-par.1", "rl-par.1.1", "parent-child", None, now)
            .unwrap();
        // The child is open and undeferred itself, but its ANCESTOR is
        // deferred — the recursive walk hides the whole subtree.
        assert_eq!(ready_ids(&db, now), vec!["rl-free"]);
        // The parent's defer passes → the whole chain surfaces at once.
        assert_eq!(
            ready_ids(&db, now + 60_000),
            vec!["rl-free", "rl-par", "rl-par.1", "rl-par.1.1"]
        );
    }

    // --- (b) the claim race ----------------------------------------------

    #[test]
    fn competing_claims_yield_exactly_one_winner() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let now = 1_000_000;
        db.insert_work_item(&item("rl-race", now)).unwrap();
        let mut handles = Vec::new();
        for agent in ["agent-a", "agent-b"] {
            let db = Arc::clone(&db);
            handles.push(std::thread::spawn(move || {
                db.claim_work_item("rl-race", agent, now, Some(now + 10_000))
                    .unwrap()
            }));
        }
        let wins: Vec<bool> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            wins.iter().filter(|w| **w).count(),
            1,
            "exactly one competing claim may win"
        );
        let it = db.get_work_item("rl-race").unwrap();
        assert_eq!(it.status, "claimed");
        assert!(
            matches!(it.assignee.as_deref(), Some("agent-a") | Some("agent-b")),
            "the row belongs to whichever claimer won"
        );
        assert_eq!(it.lease_expires_at, Some(now + 10_000));
    }

    // --- (c) lease expiry ------------------------------------------------

    #[test]
    fn an_expired_lease_returns_the_item_to_open_and_ready() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        db.insert_work_item(&item("rl-lease", now)).unwrap();
        assert!(db
            .claim_work_item("rl-lease", "agent-a", now, Some(now + 1_000))
            .unwrap());
        assert!(ready_ids(&db, now).is_empty(), "claimed ⇒ not ready");
        // Lease still live → nothing expires.
        assert_eq!(db.expire_work_leases(now + 500).unwrap(), 0);
        // Boundary is STRICT (`lease_expires_at < now`, not `<=`): at
        // exactly t == lease_expires_at nothing expires either.
        assert_eq!(db.expire_work_leases(now + 1_000).unwrap(), 0);
        assert_eq!(db.get_work_item("rl-lease").unwrap().status, "claimed");
        // Lease lapsed → the claim clears wholesale.
        let later = now + 2_000;
        assert_eq!(db.expire_work_leases(later).unwrap(), 1);
        let it = db.get_work_item("rl-lease").unwrap();
        assert_eq!(it.status, "open");
        assert!(it.assignee.is_none());
        assert!(it.claimed_at.is_none());
        assert!(it.lease_expires_at.is_none());
        assert_eq!(it.updated_at, later);
        // …and the item is ready + claimable again (far-future lease so the
        // sweep below only ever considers the open-ended claim).
        assert_eq!(ready_ids(&db, later), vec!["rl-lease"]);
        assert!(db
            .claim_work_item("rl-lease", "agent-b", later, Some(later + 10_000_000))
            .unwrap());
        // An open-ended claim (NULL lease) never expires.
        db.insert_work_item(&item("rl-forever", now)).unwrap();
        assert!(db.claim_work_item("rl-forever", "agent-c", now, None).unwrap());
        assert_eq!(db.expire_work_leases(now + 1_000_000).unwrap(), 0);
        assert_eq!(db.get_work_item("rl-forever").unwrap().status, "claimed");
    }

    // --- (d) lifecycle events keep the chain green ------------------------

    #[test]
    fn file_claim_close_events_append_and_keep_chain_green() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        db.insert_work_item(&item("rl-led", now)).unwrap();
        assert!(crate::ledger::record_work_event(
            &db,
            EventKind::WorkFile,
            "rl-led",
            Some("filer"),
            None,
            now
        )
        .unwrap()
        .is_some());
        assert!(db
            .claim_work_item("rl-led", "agent-a", now + 1, Some(now + 3_600_000))
            .unwrap());
        assert!(crate::ledger::record_work_event(
            &db,
            EventKind::WorkClaim,
            "rl-led",
            Some("agent-a"),
            None,
            now + 1
        )
        .unwrap()
        .is_some());
        assert!(db.close_work_item("rl-led", Some("done"), now + 2).unwrap());
        assert!(crate::ledger::record_work_event(
            &db,
            EventKind::WorkClose,
            "rl-led",
            Some("agent-a"),
            Some("done"),
            now + 2
        )
        .unwrap()
        .is_some());
        // The whole lifecycle is on the chain and the chain verifies.
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM ledger_events
                 WHERE kind IN ('work_file', 'work_claim', 'work_close')
                   AND ref_kind = 'work_item' AND ref_id = 'rl-led'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(n, 3);
        assert!(db.verify_ledger_chain().unwrap().ok, "chain intact");
        // Close-exactly-once: a second close is a no-op conflict and the row
        // keeps its first close_reason/closed_at.
        assert!(!db.close_work_item("rl-led", Some("again"), now + 9).unwrap());
        let it = db.get_work_item("rl-led").unwrap();
        assert_eq!(it.closed_at, Some(now + 2));
        assert_eq!(it.close_reason.as_deref(), Some("done"));
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    // --- (e) provenance outlives the origin -------------------------------

    #[test]
    fn deleting_the_origin_row_leaves_the_item_standing_and_ready() {
        let db = Database::open_in_memory().unwrap();
        let now = 1_000_000;
        db.upsert_plan_run("X", "{}", None, false).unwrap();
        let mut it = item("rl-orph", now);
        it.origin_kind = Some("plan_run".to_string());
        it.origin_id = Some("X".to_string());
        db.insert_work_item(&it).unwrap();
        // The origin dies — provenance is a TEXT breadcrumb, never a foreign
        // key, so nothing may cascade (the direct regression test for the
        // old CASCADE defect).
        assert!(db.delete_plan_run("X").unwrap());
        assert!(db.get_plan_run("X").is_none());
        let survivor = db.get_work_item("rl-orph").expect("item outlives origin");
        assert_eq!(survivor.origin_kind.as_deref(), Some("plan_run"));
        assert_eq!(survivor.origin_id.as_deref(), Some("X"));
        assert_eq!(ready_ids(&db, now), vec!["rl-orph"], "still ready");
    }

    // --- (f) the state-plane boundary guard --------------------------------

    /// BOUNDARY GUARD — mirrors the include_str! style of
    /// `every_known_event_has_a_tap_beside_its_emit_site`: the work graph is
    /// a state plane (tables, queries, route handlers). `work.rs` may never
    /// name the seat-spawn chokepoint symbol nor spawn a process; execution
    /// engines live elsewhere and talk to the plane over the routes. The
    /// needles live HERE so the scanned file stays clean.
    #[test]
    fn work_state_plane_never_names_the_spawn_chokepoint_or_spawns() {
        let work = include_str!("work.rs");
        for needle in ["claude_command_for_seat", "Command::new", "spawn("] {
            assert_eq!(
                work.matches(needle).count(),
                0,
                "work.rs must contain zero occurrences of `{needle}` — \
                 the work graph is a state plane, never an execution engine"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    // The parse helper: no longer a `db` dependency (loading deliberately
    // does NOT parse), but the fixtures still build revisions the way the
    // interception path does.
    use crate::state::reparse_sections;
    use super::*;
    use crate::state::{NewCommentRequest, SessionStore};
    use std::sync::Arc;

    fn make_store() -> SessionStore {
        let db = Arc::new(Database::open_in_memory().unwrap());
        SessionStore::new(db)
    }

    // --- Backend provenance (which harness authored the plan) --------------

    #[test]
    fn session_backend_and_model_survive_a_reload() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("thr_1", "/repo/x", md.to_string(), Vec::new(), true, false);
        store.set_backend("thr_1", Some("codex"), Some("gpt-5.6-sol"));

        let reloaded = SessionStore::new(db);
        let s = reloaded.get("thr_1").expect("session");
        assert_eq!(s.backend.as_deref(), Some("codex"));
        assert_eq!(s.model.as_deref(), Some("gpt-5.6-sol"));
        // …and the accessor restore branches on.
        assert_eq!(reloaded.backend_of("thr_1"), "codex");
    }

    #[test]
    fn a_status_only_upsert_cannot_blank_the_backend() {
        // This is the whole reason the column is COALESCEd: most upserts exist
        // to move `status` or `attach_state` and carry no provenance at all.
        // One of them blanking the backend would send the NEXT restore down
        // the claude arm holding a Codex thread id — which does not error, it
        // silently starts a fresh session.
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("thr_1", "/repo/x", md.to_string(), Vec::new(), true, false);
        store.set_backend("thr_1", Some("codex"), Some("gpt-5.6-sol"));

        // A caller that knows nothing about backends writes the row back.
        let mut blind = store.get("thr_1").unwrap();
        blind.backend = None;
        blind.model = None;
        blind.status = crate::state::SessionStatus::Approved;
        db.upsert_session(&blind).unwrap();

        let reloaded = SessionStore::new(db);
        assert_eq!(reloaded.backend_of("thr_1"), "codex");
        assert_eq!(
            reloaded.get("thr_1").unwrap().model.as_deref(),
            Some("gpt-5.6-sol")
        );
    }

    #[test]
    fn an_unstamped_session_reads_as_claude_code() {
        // Every pre-backend row, and every Claude session whose hook payload
        // carried no provider.
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/repo/x", md.to_string(), Vec::new(), true, false);
        assert!(store.get("s1").unwrap().backend.is_none());
        assert_eq!(store.backend_of("s1"), "claude-code");
        assert_eq!(store.backend_of("no-such-session"), "claude-code");
        // Blank/whitespace is not an answer either.
        store.set_backend("s1", Some("   "), None);
        assert_eq!(store.backend_of("s1"), "claude-code");
    }

    // --- Agent shelf (harness program A2) ----------------------------------

    fn shelf_agent(id: &str, name: &str) -> HarnessAgent {
        HarnessAgent {
            agent_id: id.to_string(),
            name: name.to_string(),
            instruction: "Tighten every heading.".to_string(),
            folder_id: None,
            starred: false,
            created_at: 1000,
            updated_at: 1000,
            last_run_at: None,
            run_count: 0,
        }
    }

    #[test]
    fn harness_agent_crud_round_trip() {
        let db = Database::open_in_memory().unwrap();
        db.insert_harness_agent(&shelf_agent("ha-1", "Header tightener")).unwrap();

        let got = db.get_harness_agent("ha-1").unwrap().expect("row exists");
        assert_eq!(got.name, "Header tightener");
        assert_eq!(got.instruction, "Tighten every heading.");
        assert!(!got.starred);
        assert_eq!(got.run_count, 0);

        assert!(db.update_harness_agent("ha-1", "Tightener", "Shorter.").unwrap());
        let got = db.get_harness_agent("ha-1").unwrap().unwrap();
        assert_eq!(got.name, "Tightener");
        assert_eq!(got.instruction, "Shorter.");
        assert!(got.updated_at >= 1000, "update bumps updated_at");

        db.set_harness_agent_starred("ha-1", true).unwrap();
        assert!(db.get_harness_agent("ha-1").unwrap().unwrap().starred);

        db.set_harness_agent_folder("ha-1", Some("f-1")).unwrap();
        assert_eq!(
            db.get_harness_agent("ha-1").unwrap().unwrap().folder_id.as_deref(),
            Some("f-1")
        );

        assert!(!db.update_harness_agent("nope", "x", "y").unwrap(), "missing row updates nothing");
        assert!(db.delete_harness_agent("ha-1").unwrap());
        assert!(db.get_harness_agent("ha-1").unwrap().is_none());
        assert!(!db.delete_harness_agent("ha-1").unwrap(), "second delete is a no-op");
    }

    /// A duplicate is `<name> copy`, never starred, with no run history — and
    /// the run counter never reorders the shelf (`updated_at` untouched).
    #[test]
    fn harness_agent_duplicate_and_run_touch() {
        let db = Database::open_in_memory().unwrap();
        let mut a = shelf_agent("ha-1", "Summarizer");
        a.starred = true;
        a.folder_id = Some("f-9".to_string());
        db.insert_harness_agent(&a).unwrap();

        let copy = db
            .duplicate_harness_agent("ha-1", "ha-2")
            .unwrap()
            .expect("source exists");
        assert_eq!(copy.name, "Summarizer copy");
        assert_eq!(copy.instruction, a.instruction, "instruction deep-copied");
        assert_eq!(copy.folder_id.as_deref(), Some("f-9"), "stays in the folder");
        assert!(!copy.starred, "a copy is never starred");
        assert_eq!(copy.run_count, 0);
        assert!(db.duplicate_harness_agent("nope", "ha-3").unwrap().is_none());

        let before = db.get_harness_agent("ha-1").unwrap().unwrap().updated_at;
        db.touch_harness_agent_run("ha-1").unwrap();
        let after = db.get_harness_agent("ha-1").unwrap().unwrap();
        assert_eq!(after.run_count, 1);
        assert!(after.last_run_at.is_some());
        assert_eq!(after.updated_at, before, "a run must not reorder the shelf");
    }

    fn suggestion_row(id: &str, draft_id: &str) -> crate::state::DraftSuggestion {
        crate::state::DraftSuggestion {
            id: id.to_string(),
            draft_id: draft_id.to_string(),
            op: "replace_block".to_string(),
            block_id: Some("blk-1".to_string()),
            original: Some("old".to_string()),
            markdown: "new".to_string(),
            agent_id: Some("shelf:ha-1".to_string()),
            body: Some("Tightened.".to_string()),
            status: "pending".to_string(),
            created_at: 1000,
        }
    }

    /// Undo-after-accept (A3): only an APPLIED suggestion returns to the
    /// pending queue. Rejected marks left the document, and a pending row has
    /// nothing to undo — both must be no-ops.
    #[test]
    fn unresolve_returns_only_applied_suggestions_to_pending() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft("d-1", Some("Doc"), None, "# Doc", None).unwrap();
        db.insert_draft_suggestion(&suggestion_row("s-applied", "d-1")).unwrap();
        db.insert_draft_suggestion(&suggestion_row("s-rejected", "d-1")).unwrap();
        db.insert_draft_suggestion(&suggestion_row("s-pending", "d-1")).unwrap();
        assert!(db.resolve_draft_suggestion("s-applied", "applied").unwrap());
        assert!(db.resolve_draft_suggestion("s-rejected", "rejected").unwrap());

        assert!(db.unresolve_draft_suggestion("s-applied").unwrap());
        assert!(!db.unresolve_draft_suggestion("s-rejected").unwrap());
        assert!(!db.unresolve_draft_suggestion("s-pending").unwrap());
        assert!(!db.unresolve_draft_suggestion("nope").unwrap());

        let pending = db.list_pending_draft_suggestions("d-1").unwrap();
        let ids: Vec<&str> = pending.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s-applied", "s-pending"], "undo re-queues; reject stays settled");
    }

    /// Preview copies (A3) are real `drafts` rows — the write contract needs
    /// one — but they must never surface on the shelf, and the age-based
    /// lister must offer only genuinely stale ones to the sweep.
    #[test]
    fn preview_drafts_stay_off_the_shelf_and_list_stale_by_age() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_draft("d-real", Some("Real"), None, "# Real", None).unwrap();
        db.upsert_draft("preview-1", Some("Copy"), None, "# Real", None).unwrap();

        let listed = db.list_drafts().unwrap();
        let ids: Vec<&str> = listed.iter().map(|d| d.draft_id.as_str()).collect();
        assert_eq!(ids, ["d-real"], "a preview copy never reaches the shelf");

        // Fresh previews survive the sweep cutoff; stale ones are offered.
        let now = crate::ledger::now_millis();
        assert!(db.list_stale_preview_drafts(now - 60_000).unwrap().is_empty());
        let stale = db.list_stale_preview_drafts(now + 60_000).unwrap();
        assert_eq!(stale, ["preview-1"]);
        assert!(
            !db.list_stale_preview_drafts(now + 60_000).unwrap().contains(&"d-real".to_string()),
            "the sweep can only ever see the preview id-space"
        );
    }

    fn prompt_row<'a>(body: &'a str, bh: &'a str, sid: Option<&'a str>) -> crate::ledger::PromptRow<'a> {
        crate::ledger::PromptRow {
            ts: 1000,
            source: "hook",
            origin: "redline",
            surface: "pty",
            role: "user",
            user_text: None,
            session_id: None,
            claude_session_id: sid,
            mission_id: None,
            project_path: Some("/proj"),
            body,
            body_hash: bh,
            thread_kind: None,
            thread_id: None,
            parent_session_id: None,
                model: None,
            model_source: None,
        }
    }

    fn append<'a>(db: &Database, kind: &'a str, ph: &'a str) -> crate::ledger::LedgerEventRow {
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind,
            author: "tester",
            ts: 1000,
            prompt_id: None,
            session_id: Some("s"),
            version_number: None,
            ref_kind: Some("session"),
            ref_id: Some("s"),
            payload_hash: ph,
        })
        .unwrap()
    }

    #[test]
    fn ledger_chain_builds_and_verifies() {
        let db = Database::open_in_memory().unwrap();
        let e1 = append(&db, "prompt", "h1");
        let e2 = append(&db, "approval", "h2");
        let e3 = append(&db, "revision", "h3");
        // seq is monotonic, and each row commits to its predecessor's hash.
        assert_eq!((e1.seq, e2.seq, e3.seq), (1, 2, 3));
        assert_eq!(e1.prev_hash, crate::ledger::GENESIS_PREV);
        assert_eq!(e2.prev_hash, e1.entry_hash);
        assert_eq!(e3.prev_hash, e2.entry_hash);

        let v = db.verify_ledger_chain().unwrap();
        assert!(v.ok);
        assert_eq!(v.checked, 3);
        assert_eq!(v.first_bad_seq, None);
        assert_eq!(v.head_hash.as_deref(), Some(e3.entry_hash.as_str()));
    }

    // --- ClassMemory (Phase 2) --------------------------------------------

    use crate::classmem::{Proposal, SplitPart};

    fn accepted_node(db: &Database, id: &str, parent: Option<&str>, title: &str) {
        let now = crate::ledger::now_millis();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO class_nodes
                (id, parent_id, kind, title, summary, project_path, ip_name,
                 status, pinned, curated_by, created_at, updated_at)
             VALUES (?1, ?2, 'node', ?3, NULL, NULL, NULL, 'accepted', 0, 'user', ?4, ?4)",
            params![id, parent, title, now],
        )
        .unwrap();
    }

    fn add_link(db: &Database, node: &str, kind: &str, target: &str) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO class_links (node_id, target_kind, target_id, note, status, created_at)
             VALUES (?1, ?2, ?3, NULL, 'accepted', 1000)",
            params![node, kind, target],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // --- Supersession + observations (temporal validity / patterns) --------

    use crate::classmem::SupersessionOutcome;

    fn assert_rejected(out: SupersessionOutcome) -> String {
        match out {
            SupersessionOutcome::Rejected(msg) => msg,
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn supersession_guardrails() {
        let db = Database::open_in_memory().unwrap();
        let _p = append(&db, "prompt", "h1"); // seq 1 — not a decision
        let r1 = append(&db, "resolution", "h2"); // seq 2
        let a1 = append(&db, "approval", "h3"); // seq 3
        let r2 = append(&db, "review_verdict", "h4"); // seq 4

        // Non-decision kinds are never superseded (either side).
        assert_rejected(db.apply_supersession(1, r1.seq, "", "tester").unwrap());
        assert_rejected(db.apply_supersession(r1.seq, 1, "", "tester").unwrap());
        // Unknown seqs reject.
        assert_rejected(db.apply_supersession(r1.seq, 999, "", "tester").unwrap());
        // Old must precede new.
        assert_rejected(db.apply_supersession(a1.seq, r1.seq, "", "tester").unwrap());

        // Happy path: r1 → a1.
        match db.apply_supersession(r1.seq, a1.seq, "reversed", "tester").unwrap() {
            SupersessionOutcome::Applied { effective_old, new_seq, event_seq } => {
                assert_eq!((effective_old, new_seq), (r1.seq, a1.seq));
                // The supersede event landed on the chain, referencing old.
                let ev = db
                    .list_ledger_events(1)
                    .unwrap()
                    .into_iter()
                    .next()
                    .unwrap();
                assert_eq!(ev.seq, event_seq);
                assert_eq!(ev.kind, "supersede");
                assert_eq!(ev.ref_kind.as_deref(), Some("ledger_event"));
                assert_eq!(ev.ref_id.as_deref(), Some(r1.seq.to_string().as_str()));
            }
            other => panic!("expected Applied, got {other:?}"),
        }

        // "At most once": superseding r1 again redirects to the chain head
        // (a1), so r1 → r2 records a1 → r2, not a second edge from r1.
        match db.apply_supersession(r1.seq, r2.seq, "newer again", "tester").unwrap() {
            SupersessionOutcome::Applied { effective_old, new_seq, .. } => {
                assert_eq!((effective_old, new_seq), (a1.seq, r2.seq));
            }
            other => panic!("expected Applied, got {other:?}"),
        }
        // The idempotent duplicate lands on "already the head" and rejects.
        assert_rejected(db.apply_supersession(r1.seq, r2.seq, "", "tester").unwrap());

        // The index answers both hops.
        let map = db.supersessions_for_seqs(&[r1.seq, a1.seq, r2.seq]).unwrap();
        assert_eq!(map.get(&r1.seq), Some(&a1.seq));
        assert_eq!(map.get(&a1.seq), Some(&r2.seq));
        assert_eq!(map.get(&r2.seq), None);
    }

    #[test]
    fn supersede_and_observation_keep_chain_green() {
        // The hash-invariant tripwire: the two new event kinds coexist with
        // the old ones on one chain, and verification stays green — proof
        // that CanonicalEvent was untouched.
        let db = Database::open_in_memory().unwrap();
        append(&db, "prompt", "h1");
        let r = append(&db, "resolution", "h2");
        let a = append(&db, "approval", "h3");
        match db.apply_supersession(r.seq, a.seq, "why", "keeper").unwrap() {
            SupersessionOutcome::Applied { .. } => {}
            other => panic!("expected Applied, got {other:?}"),
        }
        accepted_node(&db, "cn-x", None, "X");
        assert!(db
            .insert_class_observation("cn-x", "a pattern", &[1, 2], "keeper")
            .unwrap()
            .is_some());
        let v = db.verify_ledger_chain().unwrap();
        assert!(v.ok, "chain must stay green: {v:?}");
        assert_eq!(v.checked, 5); // 3 seeds + supersede + observation
    }

    #[test]
    fn insert_class_observation_sets_created_seq_and_dedups() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "cn-x", None, "X");

        // Uncited / empty-summary / unknown-node inserts are rejected.
        assert!(db.insert_class_observation("cn-x", "s", &[], "keeper").unwrap().is_none());
        assert!(db.insert_class_observation("cn-x", "  ", &[1], "keeper").unwrap().is_none());
        assert!(db.insert_class_observation("ghost", "s", &[1], "keeper").unwrap().is_none());

        let id = db
            .insert_class_observation("cn-x", "deploys follow auth changes", &[4, 9], "keeper")
            .unwrap()
            .expect("first insert lands");
        let obs = db.list_class_observations("cn-x", false).unwrap();
        assert_eq!(obs.len(), 1);
        assert_eq!(obs[0].id, id);
        assert_eq!(obs[0].cite_seqs, vec![4, 9]);
        // The row points at its own `observation` ledger event.
        let seq = obs[0].created_seq.expect("created_seq backfilled");
        let ev = db.list_ledger_events(10).unwrap();
        let ev = ev.iter().find(|e| e.seq == seq).unwrap();
        assert_eq!(ev.kind, "observation");
        assert_eq!(ev.ref_id.as_deref(), Some("cn-x"));

        // Identical summary dedups — including after a retirement (B3's
        // re-validation replaces dismiss), so a retired pattern never
        // resurfaces under the same wording.
        assert!(db
            .insert_class_observation("cn-x", "deploys follow auth changes", &[4], "keeper")
            .unwrap()
            .is_none());
        let node = db.retire_observation(id, "the items moved on", "keeper").unwrap();
        assert_eq!(node.as_deref(), Some("cn-x"));
        assert!(db.list_class_observations("cn-x", false).unwrap().is_empty());
        // The old `include_dismissed` flag is ignored: retired rows are never served.
        assert!(db.list_class_observations("cn-x", true).unwrap().is_empty());
        assert!(db
            .insert_class_observation("cn-x", "deploys follow auth changes", &[4, 9], "keeper")
            .unwrap()
            .is_none());
        // Retiring twice is a no-op, and the retirement is on the chain.
        assert!(db.retire_observation(id, "again", "keeper").unwrap().is_none());
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn collapse_retires_subtree_observations_but_keeps_their_events() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "cn-root", None, "root");
        accepted_node(&db, "cn-cold", Some("cn-root"), "cold branch");
        append(&db, "prompt", "h1");
        db.insert_class_observation("cn-cold", "some pattern", &[1], "keeper")
            .unwrap()
            .expect("observation lands");

        // Stage + apply a collapse of the branch.
        let staged = db
            .stage_proposal(
                None,
                &Proposal::Collapse {
                    node_id: "cn-cold".into(),
                    summary: "digest".into(),
                    cite_seqs: vec![1],
                    rationale: None,
                },
            )
            .unwrap();
        assert!(matches!(staged, crate::classmem::StagedOutcome::Structural));
        let pid = db.list_class_proposals().unwrap()[0].id;
        assert!(db.apply_class_proposal(pid, "tester").unwrap().is_some());

        // The rows retired with the branch…
        assert!(db.list_class_observations("cn-cold", true).unwrap().is_empty());
        // …but the tamper-evident history remains and the chain stays green.
        assert!(db
            .list_ledger_events(10)
            .unwrap()
            .iter()
            .any(|e| e.kind == "observation"));
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn supersede_proposal_stages_and_applies_through_the_review_machinery() {
        let db = Database::open_in_memory().unwrap();
        append(&db, "prompt", "h1");
        let r = append(&db, "resolution", "h2");
        let a = append(&db, "approval", "h3");

        // Stage-time screen: non-decision or unknown seqs are skipped.
        let skipped = db
            .stage_proposal(None, &Proposal::Supersede { old_seq: 1, new_seq: a.seq, rationale: None })
            .unwrap();
        assert!(matches!(skipped, crate::classmem::StagedOutcome::Skipped));

        let staged = db
            .stage_proposal(
                None,
                &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: Some("why".into()) },
            )
            .unwrap();
        assert!(matches!(staged, crate::classmem::StagedOutcome::Structural));
        // Identical pending proposal doesn't re-stage.
        let dup = db
            .stage_proposal(
                None,
                &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: Some("again".into()) },
            )
            .unwrap();
        assert!(matches!(dup, crate::classmem::StagedOutcome::Skipped));

        let props = db.list_class_proposals().unwrap();
        assert_eq!(props.len(), 1);
        assert_eq!(props[0].op, "supersede");
        let applied = db.apply_class_proposal(props[0].id, "tester").unwrap().expect("applies");
        assert_eq!(applied.op, "supersede");
        assert_eq!(applied.detail, format!("#{} → #{}", r.seq, a.seq));
        assert!(db.list_class_proposals().unwrap().is_empty());
        assert_eq!(
            db.supersessions_for_seqs(&[r.seq]).unwrap().get(&r.seq),
            Some(&a.seq)
        );
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn pending_proposal_count_tracks_staging_and_resolution() {
        let db = Database::open_in_memory().unwrap();
        append(&db, "prompt", "h1");
        let r = append(&db, "resolution", "h2");
        let a = append(&db, "approval", "h3");
        assert_eq!(db.count_pending_class_proposals().unwrap(), 0);

        db.stage_proposal(
            None,
            &Proposal::Supersede { old_seq: r.seq, new_seq: a.seq, rationale: None },
        )
        .unwrap();
        assert_eq!(db.count_pending_class_proposals().unwrap(), 1);

        let pid = db.list_class_proposals().unwrap()[0].id;
        db.reject_class_proposal(pid).unwrap();
        assert_eq!(db.count_pending_class_proposals().unwrap(), 0);
    }

    fn count_reorg_events(db: &Database) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM ledger_events WHERE kind = 'taxonomy_reorg'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn class_tables_exist_and_seed_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let rows = crate::classmem::seed_root_rows(&[
            "/x/redline".to_string(),
            "/x/muslimlegalconnect".to_string(),
        ]);
        assert_eq!(db.seed_class_roots(&rows).unwrap(), 3); // 2 repos + ~general
        assert_eq!(db.seed_class_roots(&rows).unwrap(), 0); // idempotent
        let nodes = db.list_class_nodes().unwrap();
        assert_eq!(nodes.len(), 3);
        // Live on creation since B3 (there is no `proposed` state any more).
        assert!(nodes.iter().all(|n| n.status == "accepted" && n.parent_id.is_none()));
    }

    #[test]
    fn stage_create_writes_a_live_node_and_one_curate_event_records_it() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        let create = Proposal::Create {
            parent_id: "root-r".into(),
            title: "Loop Engineering".into(),
            rationale: None,
        };
        let out = db.stage_proposal(None, &create).unwrap();
        assert!(matches!(out, crate::classmem::StagedOutcome::Node));
        let staged = db.list_class_nodes().unwrap();
        let node = staged.iter().find(|n| n.title == "Loop Engineering").unwrap();
        // B3: staging writes the row LIVE — nothing waits for an accept.
        assert_eq!(node.status, "accepted");
        crate::classmem::record_curate(&db, "tester", &node.id, "create", "");
        // Re-staging the same create is a skip, not a duplicate.
        assert!(matches!(db.stage_proposal(None, &create).unwrap(), crate::classmem::StagedOutcome::Skipped));
        // The legacy flip finds nothing on a current store.
        assert!(db.accept_all_pending("classifier").unwrap().is_empty());
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM ledger_events WHERE kind = 'class_curate'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(n, 1);
    }

    #[test]
    fn browse_event_records_dedups_and_keeps_chain_green() {
        let db = Database::open_in_memory().unwrap();
        let ev = |browse_id: &str, text: &str| crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some(browse_id.into()),
            url: "https://example.com".into(),
            title: Some("Example".into()),
            text: text.into(),
            from_event_id: None,
            author: None,
        };
        // First page records → a browse_event ledger row + a browse_events row.
        assert!(crate::ledger::record_browse_event(&db, ev("t1", "page one")).unwrap().is_some());
        // Same content back-to-back in the same tab is deduped (nothing written).
        assert!(crate::ledger::record_browse_event(&db, ev("t1", "page one")).unwrap().is_none());
        // A different page in the same tab records.
        assert!(crate::ledger::record_browse_event(&db, ev("t1", "page two")).unwrap().is_some());
        // The SAME content in a DIFFERENT tab records (content-identity grouping,
        // not global dedup).
        assert!(crate::ledger::record_browse_event(&db, ev("t2", "page one")).unwrap().is_some());

        // The event references its browse_events row; text + hash round-trip.
        let (url, title, text, chash) = db.get_browse_event(1).unwrap().unwrap();
        assert_eq!(url, "https://example.com");
        assert_eq!(title.as_deref(), Some("Example"));
        assert_eq!(text, "page one");
        assert_eq!(chash, crate::ledger::body_hash("page one"));

        // Two distinct pages under 't1' + one under 't2' == 3 stored events.
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM browse_events", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(n, 3);

        // The hash chain still verifies with browse_event rows in it.
        assert!(db.verify_ledger_chain().unwrap().ok);

        // The classifier delta surfaces the page text as `body` under a synthetic
        // `browse_event` surface, so the classifier can file it under a class.
        let items = db.list_lake_items_since(0, 100).unwrap();
        let be = items.iter().find(|i| i.kind == "browse_event").unwrap();
        assert_eq!(be.surface.as_deref(), Some("browse_event"));
        assert_eq!(be.body.as_deref(), Some("page one"));
        assert_eq!(be.ref_kind.as_deref(), Some("browse_event"));
    }

    #[test]
    fn browse_trail_edge_round_trips_and_stays_out_of_the_chain() {
        let db = Database::open_in_memory().unwrap();
        let ev = |text: &str, from: Option<i64>| crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: "https://example.com".into(),
            title: None,
            text: text.into(),
            from_event_id: from,
            author: None,
        };
        // Root, then a follow — the trail edge points at the preceding row.
        assert!(crate::ledger::record_browse_event(&db, ev("origin page", None)).unwrap().is_some());
        assert!(crate::ledger::record_browse_event(&db, ev("followed page", Some(1))).unwrap().is_some());
        let (root_from, follow_from): (Option<i64>, Option<i64>) = {
            let conn = db.conn.lock().unwrap();
            (
                conn.query_row("SELECT from_event_id FROM browse_events WHERE id = 1", [], |r| r.get(0)).unwrap(),
                conn.query_row("SELECT from_event_id FROM browse_events WHERE id = 2", [], |r| r.get(0)).unwrap(),
            )
        };
        assert_eq!(root_from, None, "a trail root has no edge");
        assert_eq!(follow_from, Some(1));
        // Non-hashed: the chain is blind to the edge and stays green.
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn actor_authorship_separates_human_and_agent_events_on_one_chain() {
        let db = Database::open_in_memory().unwrap();
        // Human prompt (author: None → local_author).
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some("cs-h".into()),
                mission_id: None,
                project_path: None,
                body: "a human prompt".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap();
        // Agent-constructed prompt authors as its surface seat.
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::RustFirstTurn,
                origin: crate::ledger::Origin::Redline,
                surface: "browse".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some("cs-a".into()),
                mission_id: None,
                project_path: None,
                body: "a constructed agent prompt".into(),
                thread: None,
                author: Some("browse".into()),
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap();
        // Agent browse capture + agent curation carry their seat names.
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.com".into(),
                title: None,
                text: "driven page".into(),
                from_event_id: None,
                author: Some("browse".into()),
            },
        )
        .unwrap()
        .unwrap();
        accepted_node(&db, "cn-a", None, "A");
        crate::classmem::record_curate(&db, "classifier", "cn-a", "organize", "");
        crate::ledger::record_revision_event(&db, "s1", 1, "# plan", None).unwrap().unwrap();

        let mut authors: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for e in db.list_ledger_events(10).unwrap() {
            authors.insert(e.kind, e.author);
        }
        let local = crate::ledger::local_author();
        assert_eq!(authors["revision"], local);
        assert_eq!(authors["class_curate"], "classifier");
        assert_eq!(authors["browse_event"], "browse");
        // The prompt events: one local, one agent (same kind — check both exist).
        let prompt_authors: Vec<String> = db
            .list_ledger_events(10)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == "prompt")
            .map(|e| e.author)
            .collect();
        assert!(prompt_authors.contains(&local));
        assert!(prompt_authors.contains(&"browse".to_string()));

        // Mixed human/agent authors on ONE chain: verification stays green —
        // the P0 boundary proof (author was always hashed; only its value
        // sharpened).
        let v = db.verify_ledger_chain().unwrap();
        assert!(v.ok, "mixed-author chain must verify: {v:?}");
    }

    // --- Timeline query (Memory surface P1) --------------------------------

    fn tprompt(db: &Database, surface: &str, body: &str, cs: &str, proj: &str, author: &str) {
        crate::ledger::record_prompt(
            db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: surface.into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some(cs.into()),
                mission_id: None,
                project_path: Some(proj.into()),
                body: body.into(),
                thread: None,
                author: Some(author.into()),
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap();
    }

    #[test]
    fn timeline_query_filters_cursor_and_provenance_joins() {
        let db = Database::open_in_memory().unwrap();
        tprompt(&db, "pty", "alpha prompt body", "cs-1", "/proj/a", "human");
        tprompt(&db, "browse", "beta prompt body", "cs-2", "/proj/b", "browse");
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.com/one".into(),
                title: Some("One".into()),
                text: "page one".into(),
                from_event_id: None,
                author: Some("browse".into()),
            },
        )
        .unwrap()
        .unwrap();
        append(&db, "approval", "h-app");

        let f = crate::context::LedgerFilters::default;
        let all = db.query_ledger_events(&f()).unwrap();
        assert_eq!(all.len(), 4);
        assert!(
            all.windows(2).all(|w| w[0].event.seq > w[1].event.seq),
            "pages are newest-first"
        );

        // Kind facet + preview from the prompt join.
        let prompts = db
            .query_ledger_events(&crate::context::LedgerFilters {
                kind: Some("prompt".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(prompts.len(), 2);
        assert!(prompts.iter().all(|i| i.preview.is_some() && !i.compacted));

        // Actor facet spans event kinds (agent prompt + agent browse capture).
        let agent = db
            .query_ledger_events(&crate::context::LedgerFilters {
                author: Some("browse".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(agent.len(), 2);

        // Surface + project facets ride the prompt join.
        let pty = db
            .query_ledger_events(&crate::context::LedgerFilters {
                surface: Some("pty".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(pty.len(), 1);
        assert_eq!(pty[0].project_path.as_deref(), Some("/proj/a"));
        assert_eq!(pty[0].preview.as_deref(), Some("alpha prompt body"));

        // Bound-LIKE body search.
        let hit = db
            .query_ledger_events(&crate::context::LedgerFilters {
                q: Some("beta prompt".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].project_path.as_deref(), Some("/proj/b"));

        // Browse provenance is joined onto the event row.
        let be = db
            .query_ledger_events(&crate::context::LedgerFilters {
                kind: Some("browse_event".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(be.len(), 1);
        assert_eq!(be[0].url.as_deref(), Some("https://example.com/one"));
        assert_eq!(be[0].action.as_deref(), Some("navigate"));
        assert_eq!(be[0].browse_id.as_deref(), Some("t1"));

        // Cursor pages chain without overlap and reach the whole history.
        let page1 = db
            .query_ledger_events(&crate::context::LedgerFilters {
                limit: Some(2),
                ..f()
            })
            .unwrap();
        assert_eq!(page1.len(), 2);
        let page2 = db
            .query_ledger_events(&crate::context::LedgerFilters {
                limit: Some(2),
                before_seq: Some(page1.last().unwrap().event.seq),
                ..f()
            })
            .unwrap();
        assert_eq!(page2.len(), 2);
        assert!(page2[0].event.seq < page1[1].event.seq);
    }

    #[test]
    fn timeline_query_like_filter_is_injection_safe() {
        let db = Database::open_in_memory().unwrap();
        tprompt(&db, "pty", "sale is 100% real", "cs-a", "/p", "human");
        tprompt(&db, "pty", "sale is 100x real", "cs-b", "/p", "human");

        // LIKE metacharacters match literally, not as wildcards.
        let percent = db
            .query_ledger_events(&crate::context::LedgerFilters {
                q: Some("100%".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(percent.len(), 1);
        assert_eq!(percent[0].preview.as_deref(), Some("sale is 100% real"));

        // Hostile text stays a bound value; the table survives.
        let hostile = db
            .query_ledger_events(&crate::context::LedgerFilters {
                q: Some("'; DROP TABLE prompts; --".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(hostile.is_empty());
        assert_eq!(db.query_ledger_events(&Default::default()).unwrap().len(), 2);
    }

    #[test]
    fn timeline_query_class_filing_probes_respect_target_keyspaces() {
        let db = Database::open_in_memory().unwrap();
        // seq 1 = browse event (browse row id 1); seq 2 = prompt.
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.com".into(),
                title: None,
                text: "a page".into(),
                from_event_id: None,
                author: None,
            },
        )
        .unwrap()
        .unwrap();
        tprompt(&db, "pty", "filed prompt", "cs-1", "/p", "human");

        accepted_node(&db, "cn-p", None, "Prompts");
        accepted_node(&db, "cn-b", None, "Pages");
        add_link(&db, "cn-p", "prompt", "2"); // prompt filed by ledger seq
        add_link(&db, "cn-b", "browse_event", "1"); // page filed by browse row id
        // A browse link whose numeric key collides with the prompt's seq must
        // never shadow the seq-keyed filing (`target_kind` splits the keyspaces).
        add_link(&db, "cn-b", "browse_event", "2");

        let all = db.query_ledger_events(&Default::default()).unwrap();
        let prompt = all.iter().find(|i| i.event.kind == "prompt").unwrap();
        assert_eq!(prompt.class_node_id.as_deref(), Some("cn-p"));
        assert_eq!(prompt.class_title.as_deref(), Some("Prompts"));
        let page = all.iter().find(|i| i.event.kind == "browse_event").unwrap();
        assert_eq!(page.class_node_id.as_deref(), Some("cn-b"));
        assert_eq!(page.class_title.as_deref(), Some("Pages"));
    }

    #[test]
    fn timeline_query_citation_focus_filters_by_seqs_and_class_node() {
        let db = Database::open_in_memory().unwrap();
        // seq 1 = browse event (browse row id 1); seq 2, 3 = prompts.
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.com".into(),
                title: None,
                text: "a page".into(),
                from_event_id: None,
                author: None,
            },
        )
        .unwrap()
        .unwrap();
        tprompt(&db, "pty", "first prompt", "cs-1", "/p", "human");
        tprompt(&db, "pty", "second prompt", "cs-2", "/p", "human");

        // The Ask agent's `#seq` chips: exact rows, still newest-first; an
        // unknown seq just doesn't match; an empty list is no filter at all.
        let f = crate::context::LedgerFilters::default;
        let picked = db
            .query_ledger_events(&crate::context::LedgerFilters {
                seqs: Some(vec![1, 3, 999]),
                ..f()
            })
            .unwrap();
        assert_eq!(
            picked.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![3, 1]
        );
        let unfiltered = db
            .query_ledger_events(&crate::context::LedgerFilters {
                seqs: Some(vec![]),
                ..f()
            })
            .unwrap();
        assert_eq!(unfiltered.len(), 3);

        // The class chip: only events filed under the node, across BOTH
        // target keyspaces (prompt by ledger seq, page by browse row id) —
        // and only accepted links count.
        accepted_node(&db, "cn-x", None, "X");
        add_link(&db, "cn-x", "prompt", "2"); // the first prompt, by seq
        add_link(&db, "cn-x", "browse_event", "1"); // the page, by browse row id
        let filed = db
            .query_ledger_events(&crate::context::LedgerFilters {
                class_node: Some("cn-x".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(
            filed.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![2, 1]
        );
        let none = db
            .query_ledger_events(&crate::context::LedgerFilters {
                class_node: Some("cn-missing".into()),
                ..f()
            })
            .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn timeline_query_map_focus_filters_by_thread_and_browse() {
        let db = Database::open_in_memory().unwrap();
        // seq 1 = browse event on tab t1; seq 2 = a linked-thread prompt;
        // seq 3 = a plain pty prompt (matches neither focus).
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.com".into(),
                title: None,
                text: "a page".into(),
                from_event_id: None,
                author: None,
            },
        )
        .unwrap()
        .unwrap();
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::RustFirstTurn,
                origin: crate::ledger::Origin::Redline,
                surface: "linked".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: Some("cs-l".into()),
                mission_id: None,
                project_path: None,
                body: "linked turn".into(),
                thread: Some(crate::ledger::ThreadRef {
                    thread_kind: "linked",
                    thread_id: "L1".into(),
                    parent_session_id: None,
                }),
                author: Some("linked".into()),
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap();
        tprompt(&db, "pty", "plain prompt", "cs-p", "/p", "human");

        let f = crate::context::LedgerFilters::default;
        let by_thread = db
            .query_ledger_events(&crate::context::LedgerFilters {
                thread_id: Some("L1".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(
            by_thread.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![2],
            "thread focus reaches exactly the thread's prompts"
        );
        let by_tab = db
            .query_ledger_events(&crate::context::LedgerFilters {
                browse_id: Some("t1".into()),
                ..f()
            })
            .unwrap();
        assert_eq!(
            by_tab.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![1],
            "browse focus reaches exactly the tab's trail"
        );
        assert!(db
            .query_ledger_events(&crate::context::LedgerFilters {
                browse_id: Some("t-missing".into()),
                ..f()
            })
            .unwrap()
            .is_empty());
    }

    // --- memory map (Second Brain P5) --------------------------------------

    /// Append a ledger event inside a named session — the map fixtures need
    /// distinct session ids (the module-wide `append` hardcodes one).
    fn append_in(
        db: &Database,
        kind: &str,
        session: &str,
        ph: &str,
    ) -> crate::ledger::LedgerEventRow {
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind,
            author: "tester",
            ts: 1000,
            prompt_id: None,
            session_id: Some(session),
            version_number: None,
            ref_kind: Some("session"),
            ref_id: Some(session),
            payload_hash: ph,
        })
        .unwrap()
    }

    #[test]
    fn memory_map_empty_lake_renders_empty_buckets() {
        let db = Database::open_in_memory().unwrap();
        let m = crate::context::build_memory_map(&db);
        assert!(m.nodes.is_empty());
        assert!(m.edges.is_empty());
    }

    #[test]
    fn memory_map_builds_declared_nodes_and_edges_never_raw_prompts() {
        let db = Database::open_in_memory().unwrap();
        // Three events in session s1 (seqs 1–3): two get filed into classes.
        let e1 = append_in(&db, "prompt", "s1", "h1");
        let e2 = append_in(&db, "prompt", "s1", "h2");
        append_in(&db, "prompt", "s1", "h3");

        // Classes: A (root) ⊃ B; C apart; D/E share a project; P proposed.
        accepted_node(&db, "cn-a", None, "A");
        accepted_node(&db, "cn-b", Some("cn-a"), "B");
        accepted_node(&db, "cn-c", None, "C");
        {
            let now = crate::ledger::now_millis();
            let conn = db.conn.lock().unwrap();
            for id in ["cn-d", "cn-e"] {
                conn.execute(
                    "INSERT INTO class_nodes
                        (id, parent_id, kind, title, summary, project_path, ip_name,
                         status, pinned, curated_by, created_at, updated_at)
                     VALUES (?1, NULL, 'node', upper(?1), NULL, '/pp', NULL,
                             'accepted', 0, 'user', ?2, ?2)",
                    params![id, now],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO class_nodes
                    (id, parent_id, kind, title, summary, project_path, ip_name,
                     status, pinned, curated_by, created_at, updated_at)
                 VALUES ('cn-p', NULL, 'node', 'P', NULL, NULL, NULL,
                         'proposed', 0, NULL, ?1, ?1)",
                params![now],
            )
            .unwrap();
        }
        // Filings: A and B reach s1 through seq-keyed links; C by direct
        // session link — all three share s1, but A↔B is parent↔child.
        add_link(&db, "cn-a", "prompt", &e1.seq.to_string());
        add_link(&db, "cn-b", "prompt", &e2.seq.to_string());
        add_link(&db, "cn-c", "session", "s1");

        // Lineage: a browse tab under a plan session.
        db.insert_session_link("browse", "tab-1", "session", "s9", 1000)
            .unwrap();

        let m = crate::context::build_memory_map(&db);

        // Rule 1: classes and sessions only — the three prompts are mass,
        // never dots; the proposed node is not on the record yet.
        assert_eq!(
            m.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec![
                "class:cn-a",
                "class:cn-b",
                "class:cn-c",
                "class:cn-d",
                "class:cn-e",
                "thread:browse:tab-1",
                "thread:session:s9",
            ]
        );
        let node = |id: &str| m.nodes.iter().find(|n| n.id == id).unwrap();
        assert_eq!(node("class:cn-a").mass, 1);
        assert_eq!(node("class:cn-b").parent_id.as_deref(), Some("class:cn-a"));
        assert_eq!(node("thread:browse:tab-1").kind, "thread");
        assert_eq!(node("thread:browse:tab-1").browse_id.as_deref(), Some("tab-1"));
        assert_eq!(
            node("thread:browse:tab-1").parent_id.as_deref(),
            Some("thread:session:s9")
        );
        assert_eq!(node("thread:session:s9").kind, "session");
        assert_eq!(node("thread:session:s9").session_id.as_deref(), Some("s9"));

        // Declared edges, deterministic order: contains, lineage, then the
        // derived co-occurrences — shared session A↔C and B↔C (parent↔child
        // A↔B is `contains`' job), shared project D↔E.
        let flat: Vec<(String, String, String, i64)> = m
            .edges
            .iter()
            .map(|e| (e.kind.clone(), e.from.clone(), e.to.clone(), e.weight))
            .collect();
        assert_eq!(
            flat,
            vec![
                ("co_occurs".into(), "class:cn-a".into(), "class:cn-c".into(), 1),
                ("co_occurs".into(), "class:cn-b".into(), "class:cn-c".into(), 1),
                ("co_occurs".into(), "class:cn-d".into(), "class:cn-e".into(), 1),
                ("contains".into(), "class:cn-a".into(), "class:cn-b".into(), 1),
                ("lineage".into(), "thread:session:s9".into(), "thread:browse:tab-1".into(), 1),
            ]
        );
        let basis = |from: &str, to: &str| {
            m.edges
                .iter()
                .find(|e| e.from == from && e.to == to)
                .and_then(|e| e.basis.as_deref().map(str::to_string))
        };
        assert_eq!(
            basis("class:cn-a", "class:cn-c").as_deref(),
            Some("1 shared session")
        );
        assert_eq!(
            basis("class:cn-d", "class:cn-e").as_deref(),
            Some("shared project")
        );

        // Determinism: the payload (minus the timestamp) is byte-identical
        // across builds — the seeded layout downstream depends on it.
        let again = crate::context::build_memory_map(&db);
        assert_eq!(
            serde_json::to_string(&m.nodes).unwrap(),
            serde_json::to_string(&again.nodes).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&m.edges).unwrap(),
            serde_json::to_string(&again.edges).unwrap()
        );
    }

    #[test]
    fn memory_map_supersedes_edge_resolves_to_class_else_session() {
        let db = Database::open_in_memory().unwrap();
        // The synthetic fixture the empty `supersessions` table demands: a
        // resolution in sA superseded by an approval in sB.
        let r1 = append_in(&db, "resolution", "sA", "h1");
        let a1 = append_in(&db, "approval", "sB", "h2");
        match db.apply_supersession(r1.seq, a1.seq, "newer", "tester").unwrap() {
            crate::classmem::SupersessionOutcome::Applied { .. } => {}
            other => panic!("expected Applied, got {other:?}"),
        }
        // The old decision is filed; the new one is not — so the edge runs
        // class → session, and sB becomes a node just by hosting a decision.
        accepted_node(&db, "cn-x", None, "X");
        add_link(&db, "cn-x", "decision", &r1.seq.to_string());

        let m = crate::context::build_memory_map(&db);
        assert!(m.nodes.iter().any(|n| n.id == "thread:session:sB"));
        let sup: Vec<&crate::context::MapEdge> =
            m.edges.iter().filter(|e| e.kind == "supersedes").collect();
        assert_eq!(sup.len(), 1);
        assert_eq!(sup[0].from, "class:cn-x");
        assert_eq!(sup[0].to, "thread:session:sB");
        assert_eq!(sup[0].weight, 1);
        assert_eq!(
            sup[0].basis.as_deref(),
            Some(format!("#{} → #{}", r1.seq, a1.seq).as_str())
        );
    }

    // --- user notes (Second Brain P3) --------------------------------------

    fn nwrite(
        target: Option<(&str, &str)>,
        note_id: Option<i64>,
        text: Option<&str>,
        starred: Option<bool>,
    ) -> crate::context::NoteWrite {
        crate::context::NoteWrite {
            note_id,
            target_kind: target.map(|(k, _)| k.to_string()),
            target_id: target.map(|(_, id)| id.to_string()),
            text: text.map(str::to_string),
            starred,
        }
    }

    fn written(out: crate::context::NoteOutcome) -> crate::context::UserNote {
        match out {
            crate::context::NoteOutcome::Written(n) => n,
            other => panic!("expected Written, got {other:?}"),
        }
    }

    #[test]
    fn user_note_acts_append_one_event_each_and_keep_the_chain_green() {
        let db = Database::open_in_memory().unwrap();
        tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human");
        let note_events =
            || db.list_ledger_events(50).unwrap().iter().filter(|e| e.kind == "note").count();

        // Write, then edit — same row, one event per act.
        let ev = |t: Option<&str>, s: Option<bool>| nwrite(Some(("ledger_event", "1")), None, t, s);
        let n1 = written(db.write_user_note(&ev(Some("check this against P2"), None), "human").unwrap());
        assert_eq!(n1.text, "check this against P2");
        assert_eq!(note_events(), 1);
        let n2 = written(db.write_user_note(&ev(Some("checked; superseded by P3"), None), "human").unwrap());
        assert_eq!(n2.id, n1.id, "one row per target — edits update it");
        assert_eq!(note_events(), 2);

        // A no-op act appends NOTHING.
        match db.write_user_note(&ev(Some("checked; superseded by P3"), None), "human").unwrap() {
            crate::context::NoteOutcome::Unchanged(_) => {}
            other => panic!("no-op must be Unchanged, got {other:?}"),
        }
        assert_eq!(note_events(), 2);

        // Star / unstar are their own acts on the same row.
        let n3 = written(db.write_user_note(&ev(None, Some(true)), "human").unwrap());
        assert!(n3.starred);
        assert_eq!(n3.id, n1.id);
        assert_eq!(note_events(), 3);
        match db.write_user_note(&ev(None, Some(true)), "human").unwrap() {
            crate::context::NoteOutcome::Unchanged(_) => {}
            other => panic!("re-star must be Unchanged, got {other:?}"),
        }
        let n4 = written(db.write_user_note(&ev(None, Some(false)), "human").unwrap());
        assert!(!n4.starred);
        assert_eq!(note_events(), 4);

        // The row reads back; the event references its target.
        let got = db.get_user_note("ledger_event", "1").unwrap().unwrap();
        assert_eq!(got.text, "checked; superseded by P3");
        assert_eq!(got.seq, n4.seq);
        let ev_row = db
            .list_ledger_events(50)
            .unwrap()
            .into_iter()
            .find(|e| e.kind == "note")
            .unwrap();
        assert_eq!(ev_row.ref_kind.as_deref(), Some("ledger_event"));
        assert_eq!(ev_row.ref_id.as_deref(), Some("1"));

        // Rejections: phantom target, no act, two acts at once.
        let rejected = |out: crate::context::NoteOutcome| {
            matches!(out, crate::context::NoteOutcome::Rejected(_))
        };
        assert!(rejected(
            db.write_user_note(&nwrite(Some(("ledger_event", "999")), None, Some("x"), None), "human")
                .unwrap()
        ));
        assert!(rejected(
            db.write_user_note(&nwrite(Some(("ledger_event", "1")), None, None, None), "human")
                .unwrap()
        ));
        assert!(rejected(
            db.write_user_note(
                &nwrite(Some(("ledger_event", "1")), None, Some("x"), Some(true)),
                "human"
            )
            .unwrap()
        ));
        assert!(rejected(
            db.write_user_note(&nwrite(Some(("diary", "1")), None, Some("x"), None), "human")
                .unwrap()
        ));

        // The one non-negotiable: `CanonicalEvent` untouched, chain green.
        let v = db.verify_ledger_chain().unwrap();
        assert!(v.ok, "note acts must not disturb the chain: {v:?}");
    }

    #[test]
    fn standalone_notes_each_own_a_row_and_edit_by_id() {
        let db = Database::open_in_memory().unwrap();
        let a = written(
            db.write_user_note(&nwrite(None, None, Some("a loose thought"), None), "human").unwrap(),
        );
        let b = written(
            db.write_user_note(&nwrite(None, None, Some("another thought"), None), "human").unwrap(),
        );
        assert_eq!(a.target_kind, "none");
        assert_ne!(a.id, b.id, "each standalone thought is its own row");

        // The event references the ROW (ref_kind='none', ref_id=row id).
        let evs: Vec<_> = db
            .list_ledger_events(10)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == "note")
            .collect();
        assert_eq!(evs.len(), 2);
        assert!(evs.iter().all(|e| e.ref_kind.as_deref() == Some("none")));
        assert!(evs.iter().any(|e| e.ref_id.as_deref() == Some(&a.id.to_string() as &str)));

        // Edits address the row by id; an empty standalone is rejected.
        let a2 = written(
            db.write_user_note(&nwrite(None, Some(a.id), Some("a sharper thought"), None), "human")
                .unwrap(),
        );
        assert_eq!(a2.id, a.id);
        assert!(matches!(
            db.write_user_note(&nwrite(None, None, Some("   "), None), "human").unwrap(),
            crate::context::NoteOutcome::Rejected(_)
        ));

        // Starring one filters the list.
        written(db.write_user_note(&nwrite(None, Some(b.id), None, Some(true)), "human").unwrap());
        let all = db.list_user_notes(false, 100).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, b.id, "most recently touched first");
        let starred = db.list_user_notes(true, 100).unwrap();
        assert_eq!(starred.len(), 1);
        assert_eq!(starred[0].id, b.id);

        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn timeline_carries_star_note_probes_and_facets_filter() {
        let db = Database::open_in_memory().unwrap();
        tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human"); // seq 1
        tprompt(&db, "pty", "beta prompt body", "cs-2", "/p", "human"); // seq 2
        written(
            db.write_user_note(&nwrite(Some(("ledger_event", "1")), None, None, Some(true)), "human")
                .unwrap(),
        ); // seq 3
        written(
            db.write_user_note(
                &nwrite(Some(("ledger_event", "2")), None, Some("remember the beta"), None),
                "human",
            )
            .unwrap(),
        ); // seq 4
        written(
            db.write_user_note(&nwrite(None, None, Some("a loose thought"), None), "human").unwrap(),
        ); // seq 5

        let all = db.query_ledger_events(&Default::default()).unwrap();
        assert_eq!(all.len(), 5);
        let by_seq = |s: i64| all.iter().find(|i| i.event.seq == s).unwrap();
        assert!(by_seq(1).starred && by_seq(1).note.is_none());
        assert_eq!(by_seq(2).note.as_deref(), Some("remember the beta"));
        assert!(!by_seq(2).starred);
        // A note event's list text is its row's current words, not a hash.
        assert_eq!(by_seq(5).preview.as_deref(), Some("a loose thought"));

        // Facets: starred = the annotated event + the star act's own event;
        // noted = the noted event + both text-bearing note events.
        let starred = db
            .query_ledger_events(&crate::context::LedgerFilters {
                starred: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            starred.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![3, 1]
        );
        let noted = db
            .query_ledger_events(&crate::context::LedgerFilters {
                noted: Some(true),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            noted.iter().map(|i| i.event.seq).collect::<Vec<_>>(),
            vec![5, 4, 2]
        );

        // Body search reaches note text.
        let hit = db
            .query_ledger_events(&crate::context::LedgerFilters {
                q: Some("loose thought".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hit.iter().map(|i| i.event.seq).collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn note_events_are_lake_items_with_their_current_words() {
        let db = Database::open_in_memory().unwrap();
        tprompt(&db, "pty", "alpha prompt body", "cs-1", "/p", "human"); // seq 1
        written(
            db.write_user_note(
                &nwrite(Some(("ledger_event", "1")), None, Some("margin note"), None),
                "human",
            )
            .unwrap(),
        ); // seq 2
        let standalone = written(
            db.write_user_note(&nwrite(None, None, Some("a standalone thought"), None), "human")
                .unwrap(),
        ); // seq 3
        // An EDIT after the events were appended: the classifier reads the
        // row's CURRENT words for every act-event of that row.
        written(
            db.write_user_note(&nwrite(None, Some(standalone.id), Some("sharper words"), None), "human")
                .unwrap(),
        ); // seq 4

        let items = db.list_lake_items_since(0, 100).unwrap();
        assert_eq!(items.len(), 4);
        let notes: Vec<_> = items.iter().filter(|i| i.kind == "note").collect();
        assert_eq!(notes.len(), 3);
        assert!(notes.iter().all(|i| i.surface.as_deref() == Some("note")));
        assert_eq!(notes[0].body.as_deref(), Some("margin note"));
        assert!(notes[1..].iter().all(|i| i.body.as_deref() == Some("sharper words")));
    }

    #[test]
    fn revert_link_removes_pointer_appends_compensating_event_and_keeps_chain_green() {
        let db = Database::open_in_memory().unwrap();
        // An accepted class with an accepted link — the gardener's "file" outcome.
        accepted_node(&db, "root-r", None, "redline");
        let link_id = add_link(&db, "root-r", "prompt", "42");
        // Record the accept as a curate event, like the gardener does.
        crate::classmem::record_curate(&db, "classifier", "root-r", "organize", "");
        assert!(db.verify_ledger_chain().unwrap().ok);

        // Revert → the pointer is gone, but the ledger only GREW (a compensating
        // 'revert' class_curate event), so the chain still verifies.
        assert!(crate::classmem::revert_link(&db, "tester", link_id).unwrap());
        assert!(db.list_class_links_for_node("root-r").unwrap().is_empty());
        assert!(db.verify_ledger_chain().unwrap().ok);

        // Two class_curate events exist: the original accept + the revert.
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM ledger_events WHERE kind = 'class_curate'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(n, 2);

        // Reverting a link that no longer exists is a no-op (false), no new event.
        assert!(!crate::classmem::revert_link(&db, "tester", link_id).unwrap());
    }

    #[test]
    fn session_link_records_tree_row_and_event_and_keeps_chain_green() {
        let db = Database::open_in_memory().unwrap();
        append(&db, "prompt", "h1"); // pre-existing history

        // First link: tree row + a session_link ledger event, chain stays green.
        let seq = crate::ledger::record_session_link(&db, "browse", "tab-1", "session", "s9")
            .unwrap();
        assert!(seq.is_some());
        assert_eq!(
            db.session_tree_parent("browse", "tab-1").unwrap(),
            Some(("session".to_string(), "s9".to_string()))
        );
        let verdict = db.verify_ledger_chain().unwrap();
        assert!(verdict.ok, "chain must verify with a session_link event in it");

        // Idempotent: a child has one parent; re-linking is a no-op (no event).
        let again =
            crate::ledger::record_session_link(&db, "browse", "tab-1", "mission", "m1").unwrap();
        assert!(again.is_none());
        assert_eq!(
            db.session_tree_parent("browse", "tab-1").unwrap(),
            Some(("session".to_string(), "s9".to_string())),
            "first write wins"
        );

        // Children walk from the parent side.
        crate::ledger::record_session_link(&db, "voice", "s9", "session", "s9").unwrap();
        let kids = db.session_tree_children("session", "s9").unwrap();
        assert_eq!(kids.len(), 2);
        assert!(db.verify_ledger_chain().unwrap().ok);

        // Blank ids record nothing.
        assert!(crate::ledger::record_session_link(&db, "browse", " ", "session", "s9")
            .unwrap()
            .is_none());
    }

    #[test]
    fn journal_appends_lists_and_prunes() {
        let db = Database::open_in_memory().unwrap();
        let first = db
            .append_journal("surface_switch", Some("plan"), Some("s1"), Some("My plan"), None)
            .unwrap();
        db.append_journal("nav", Some("browser"), None, Some("Example"), Some("https://x"))
            .unwrap();
        let head = db.journal_head().unwrap();
        assert!(head > first);

        // Delta read: strictly after `since`, oldest-first.
        let delta = db.list_journal_since(first, 100).unwrap();
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].kind, "nav");
        assert_eq!(delta[0].detail.as_deref(), Some("https://x"));

        // Prune: rows older than the 2000-row window are dropped on insert.
        for i in 0..2005 {
            db.append_journal("agent_turn", Some("browse"), Some(&format!("t{i}")), None, None)
                .unwrap();
        }
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM context_journal", [], |r| r.get(0))
                .unwrap()
        };
        assert!(n <= 2000, "journal working set stays bounded, got {n}");
    }

    #[test]
    fn friction_events_prune_on_insert_and_summarize_by_kind() {
        let db = Database::open_in_memory().unwrap();
        db.record_friction("stall_kill", Some("review"), Some("r1"), Some("180s"))
            .unwrap();
        for _ in 0..3 {
            db.record_friction("context_overflow", Some("browse"), Some("b1"), Some("too long"))
                .unwrap();
        }
        let summary = db.friction_summary(90 * 24 * 60 * 60 * 1000).unwrap();
        // Most-frequent first, so the digest ranks without re-sorting.
        assert_eq!(summary[0].kind, "context_overflow");
        assert_eq!(summary[0].count, 3);
        assert_eq!(summary[0].last_detail.as_deref(), Some("too long"));
        assert_eq!(summary[1].kind, "stall_kill");

        // `detail` is capped so one pathological error can't dominate the table.
        db.record_friction("transient_fail", None, None, Some(&"x".repeat(5000)))
            .unwrap();
        let long = db
            .friction_summary(i64::MAX / 2)
            .unwrap()
            .into_iter()
            .find(|f| f.kind == "transient_fail")
            .unwrap();
        assert_eq!(long.last_detail.unwrap().len(), 500);

        // Prune-on-insert: the working set stays bounded past the row cap.
        for i in 0..5010 {
            db.record_friction("turn_timeout", None, Some(&format!("t{i}")), None)
                .unwrap();
        }
        let n: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM friction_events", [], |r| r.get(0))
                .unwrap()
        };
        assert!(n <= 5000, "friction working set stays bounded, got {n}");
    }

    #[test]
    fn a_window_older_than_every_row_summarizes_to_nothing() {
        let db = Database::open_in_memory().unwrap();
        db.record_friction("stall_kill", None, None, None).unwrap();
        // A zero-length window excludes everything written before "now".
        assert!(db.friction_summary(0).unwrap().len() <= 1);
    }

    #[test]
    fn shipwright_dedupe_ignores_dismissed_so_a_dismissal_sticks() {
        let db = Database::open_in_memory().unwrap();
        let f = |id: &str, summary: &str| ShipwrightFinding {
            id: id.to_string(),
            run_id: "run-1".to_string(),
            category: "ci_coverage".to_string(),
            summary: summary.to_string(),
            evidence: Some("457 Rust tests, 0 workflows".to_string()),
            proposal: None,
            guard: None,
            files: Some(r#"[".github/workflows/ci.yml"]"#.to_string()),
            status: "pending".to_string(),
            dismissed: false,
            draft_id: None,
            created_at: 1,
            resolved_at: None,
        };
        assert!(db.insert_shipwright_finding(&f("a", "No test workflow")).unwrap().is_some());
        // Same (category, summary) → skipped, even before any dismissal.
        assert!(db.insert_shipwright_finding(&f("b", "No test workflow")).unwrap().is_none());

        db.resolve_shipwright_finding("a", "dismissed", None).unwrap();
        // …and still skipped afterwards: a dismissed finding never resurfaces
        // under the same wording. This is the property the whole loop rests on.
        assert!(db.insert_shipwright_finding(&f("c", "No test workflow")).unwrap().is_none());
        assert!(db.list_shipwright_findings(false).unwrap().is_empty());
        assert_eq!(db.list_shipwright_findings(true).unwrap().len(), 1);

        // A genuinely new summary still lands.
        assert!(db.insert_shipwright_finding(&f("d", "No typecheck script")).unwrap().is_some());
    }

    #[test]
    fn shipped_is_detected_from_files_not_self_declared() {
        let db = Database::open_in_memory().unwrap();
        let f = ShipwrightFinding {
            id: "f1".to_string(),
            run_id: "run-1".to_string(),
            category: "command_hygiene".to_string(),
            summary: "drafter_set_doc is sync".to_string(),
            evidence: None,
            proposal: None,
            guard: None,
            files: Some(r#"["src-tauri/src/lib.rs"]"#.to_string()),
            status: "pending".to_string(),
            dismissed: false,
            draft_id: None,
            created_at: 1,
            resolved_at: None,
        };
        db.insert_shipwright_finding(&f).unwrap();
        // Pending findings aren't candidates — only accepted ones.
        assert!(db.shipwright_unshipped().unwrap().is_empty());

        db.resolve_shipwright_finding("f1", "accepted", Some("d1")).unwrap();
        let unshipped = db.shipwright_unshipped().unwrap();
        assert_eq!(unshipped.len(), 1);
        assert!(unshipped[0].1.contains("lib.rs"));

        db.resolve_shipwright_finding("f1", "shipped", None).unwrap();
        assert!(db.shipwright_unshipped().unwrap().is_empty());
        let scores = db.shipwright_scores().unwrap();
        assert_eq!(scores[0].category, "command_hygiene");
        assert_eq!(scores[0].shipped, 1);
        assert_eq!(scores[0].accepted, 1, "shipped still counts as accepted");
        assert_eq!(scores[0].dismissed, 0);

        // The draft binding survives a later status change (COALESCE, not clobber).
        let rows = db.list_shipwright_findings(true).unwrap();
        assert_eq!(rows[0].draft_id.as_deref(), Some("d1"));
    }

    #[test]
    fn prompt_thread_provenance_round_trips_into_lake_items() {
        let db = Database::open_in_memory().unwrap();
        crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::RustFirstTurn,
                origin: crate::ledger::Origin::Redline,
                surface: "browse".to_string(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: None,
                claude_session_id: None,
                mission_id: None,
                project_path: None,
                body: "discuss this page".to_string(),
                thread: Some(crate::ledger::ThreadRef {
                    thread_kind: "browse",
                    thread_id: "tab-1".to_string(),
                    parent_session_id: Some("s9".to_string()),
                }),
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap();
        let items = db.list_lake_items_since(0, 10).unwrap();
        let it = items.iter().find(|i| i.kind == "prompt").unwrap();
        assert_eq!(it.thread_kind.as_deref(), Some("browse"));
        assert_eq!(it.thread_id.as_deref(), Some("tab-1"));
        assert_eq!(it.parent_session_id.as_deref(), Some("s9"));
        // The chain is body-blind to the new columns: still green.
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn generic_thread_reader_maps_kinds_and_rejects_unknown() {
        let db = Database::open_in_memory().unwrap();
        db.insert_browse_message(&BrowseMessage {
            id: "b1".into(),
            browse_id: "tab-1".into(),
            role: "user".into(),
            body: "hello".into(),
            status: "complete".into(),
            created_at: 10,
        })
        .unwrap();
        db.insert_browse_message(&BrowseMessage {
            id: "b2".into(),
            browse_id: "tab-1".into(),
            role: "assistant".into(),
            body: "hi".into(),
            status: "complete".into(),
            created_at: 20,
        })
        .unwrap();
        let msgs = db.load_thread_generic("browse", "tab-1", 50).unwrap().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user", "oldest-first");
        let (count, last) = db.thread_stats("browse", "tab-1").unwrap();
        assert_eq!(count, 2);
        assert_eq!(last, Some(20));
        assert!(db.load_thread_generic("nope", "x", 10).unwrap().is_none());
    }

    /// The context route is how the Companion and every consult agent read a
    /// peer thread. An `error` row is an assistant-role row REDLINE wrote —
    /// serving it makes a peer agent reason from "the model said
    /// `error_during_execution`". The UI still shows them; the machine route
    /// must not.
    #[test]
    fn generic_thread_reader_hides_error_rows_and_still_serves_voice() {
        use crate::state::VoiceMessage;
        let db = Database::open_in_memory().unwrap();
        let msg = |id: &str, role: &str, body: &str, status: &str, at: i64| BrowseMessage {
            id: id.into(),
            browse_id: "tab-1".into(),
            role: role.into(),
            body: body.into(),
            status: status.into(),
            created_at: at,
        };
        db.insert_browse_message(&msg("b1", "user", "hello", "complete", 10)).unwrap();
        db.insert_browse_message(&msg("b2", "assistant", "error_during_execution", "error", 20))
            .unwrap();
        db.insert_browse_message(&msg("b3", "assistant", "hi", "complete", 30)).unwrap();

        let msgs = db.load_thread_generic("browse", "tab-1", 50).unwrap().unwrap();
        assert_eq!(msgs.len(), 2, "the error row is not served");
        assert!(
            !msgs.iter().any(|m| m.body.contains("error_during_execution")),
            "a machine token reached a peer agent"
        );
        // `thread_stats` is a count, not context — it deliberately still sees
        // every row, so a thread does not appear emptier than it is.
        assert_eq!(db.thread_stats("browse", "tab-1").unwrap().0, 3);

        // `voice_messages` has NO status column: the filter must be omitted
        // there rather than 500-ing a route three prompts advertise.
        db.insert_voice_message(&VoiceMessage {
            id: "v1".into(),
            session_key: "s-1".into(),
            role: "agent".into(),
            text: "spoken".into(),
            created_at: 10,
        })
        .unwrap();
        let voice = db.load_thread_generic("voice", "s-1", 50).unwrap().unwrap();
        assert_eq!(voice.len(), 1);
        assert_eq!(voice[0].body, "spoken");
    }

    #[test]
    fn browse_events_fts_ranks_keyword_hits_and_is_injection_safe() {
        let db = Database::open_in_memory().unwrap();
        let page = |url: &str, title: &str, text: &str| crate::ledger::BrowseEventInput {
            action: crate::ledger::BrowseAction::Navigate,
            browse_id: Some("t1".into()),
            url: url.into(),
            title: Some(title.into()),
            text: text.into(),
            from_event_id: None,
            author: None,
        };
        crate::ledger::record_browse_event(
            &db,
            page("https://a.example", "Clerk auth", "Clerk provides authentication for Next.js apps"),
        )
        .unwrap();
        crate::ledger::record_browse_event(
            &db,
            page("https://b.example", "Postgres tuning", "vacuum and autovacuum settings for large tables"),
        )
        .unwrap();

        // A keyword search returns the matching page, not the other.
        let hits = db.search_browse_events("authentication", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://a.example");
        assert!(hits[0].snippet.contains('[') && hits[0].snippet.contains(']'));

        // A browse hit must be CITABLE. It used to carry `browse_events.id`,
        // which is a different id-space from the ledger `seq` that `#seq` chips
        // and the Timeline's filter both speak — so a page the Ask agent cited
        // pointed the user at some unrelated event. Verified 1:1 and complete
        // on live data (829 events, 829 ledger rows, 0 duplicates).
        let seq = hits[0].seq.expect("a browse hit carries its ledger seq");
        let ev = db.list_ledger_events(10).unwrap();
        let row = ev.iter().find(|e| e.seq == seq).expect("the seq resolves to a real event");
        assert_eq!(row.ref_kind.as_deref(), Some("browse_event"));
        assert_eq!(row.ref_id.as_deref(), Some(hits[0].id.to_string().as_str()));

        // The cascade widens only when the precise reading fails.
        let both = db.search_browse_events("vacuum authentication", 10).unwrap();
        assert_eq!(both.len(), 2, "no page has both terms, so the OR stage answers");
        assert!(both.iter().all(|h| h.stage == "or"));
        assert_eq!(
            db.search_browse_events("clerk authentication", 10).unwrap()[0].stage,
            "and",
            "…and a page with every term is found precisely"
        );

        // An FTS-operator-shaped query can't error out — it matches literally
        // (no such literal here) and simply returns nothing.
        assert!(db.search_browse_events("\"unterminated OR (", 10).unwrap().is_empty());
        // A query with no searchable tokens yields no hits (not an error).
        assert!(db.search_browse_events("   *  ", 10).unwrap().is_empty());
    }

    #[test]
    fn filing_with_a_sub_class_writes_the_node_and_the_link_live() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        // file with a new sub_class → the sub-node and the link, both live (B3).
        let out = db
            .stage_proposal(
                None,
                &Proposal::File {
                    parent_id: "root-r".into(),
                    sub_class: Some("Loop Engineering".into()),
                    target_kind: "prompt".into(),
                    target_id: "42".into(),
                    note: None,
                    rationale: None,
                },
            )
            .unwrap();
        assert!(matches!(out, crate::classmem::StagedOutcome::Link { created_node: true }));
        let sub = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .find(|n| n.title == "Loop Engineering")
            .unwrap();
        assert_eq!(sub.status, "accepted");
        let link = db.list_class_links_for_node(&sub.id).unwrap().remove(0);
        assert_eq!(link.status, "accepted");
        assert_eq!(link.node_id, sub.id);
    }

    #[test]
    fn promotion_preserves_id_links_and_subtree_and_writes_reorg() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-a", None, "A");
        accepted_node(&db, "root-b", None, "B");
        accepted_node(&db, "grown", Some("root-a"), "Grown Topic");
        accepted_node(&db, "child", Some("grown"), "Child");
        let link_id = add_link(&db, "grown", "prompt", "99");

        // Stage + apply a promote of `grown` from root-a to root-b.
        db.stage_proposal(
            None,
            &Proposal::Promote {
                node_id: "grown".into(),
                new_parent_id: Some("root-b".into()),
                rationale: Some("earns its own class".into()),
            },
        )
        .unwrap();
        let prop = db.list_class_proposals().unwrap().remove(0);
        let applied = db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();
        crate::classmem::record_reorg(&db, "tester", &applied.op, &applied.node_id, &applied.detail);

        let g = db.get_class_node("grown").unwrap().unwrap();
        assert_eq!(g.id, "grown"); // id preserved
        assert_eq!(g.parent_id.as_deref(), Some("root-b")); // re-parented
        // links preserved (same id)
        let links = db.list_class_links_for_node("grown").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].id, link_id);
        // subtree preserved
        assert_eq!(
            db.get_class_node("child").unwrap().unwrap().parent_id.as_deref(),
            Some("grown")
        );
        // proposal consumed + a reorg ledger event written
        assert!(db.list_class_proposals().unwrap().is_empty());
        assert_eq!(count_reorg_events(&db), 1);
    }

    #[test]
    fn collapse_creates_digest_with_citations_and_removes_cold_branch() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        accepted_node(&db, "cold", Some("root-r"), "Old Research");
        add_link(&db, "cold", "prompt", "10");
        // Two real ledger rows to cite (so link_preview can resolve them later).
        append(&db, "prompt", "h10");
        append(&db, "approval", "h11");

        db.stage_proposal(
            None,
            &Proposal::Collapse {
                node_id: "cold".into(),
                summary: "Explored X; parked, no position taken.".into(),
                cite_seqs: vec![1, 2],
                rationale: Some("cold, unpinned".into()),
            },
        )
        .unwrap();
        let prop = db.list_class_proposals().unwrap().remove(0);
        let applied = db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();
        crate::classmem::record_reorg(&db, "tester", &applied.op, &applied.node_id, &applied.detail);

        // Original cold branch is gone.
        assert!(db.get_class_node("cold").unwrap().is_none());
        // A digest node exists under the root with the summary + citation links.
        let digest = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .find(|n| n.kind == "digest")
            .unwrap();
        assert_eq!(digest.parent_id.as_deref(), Some("root-r"));
        assert_eq!(digest.summary.as_deref(), Some("Explored X; parked, no position taken."));
        let cites = db.list_class_links_for_node(&digest.id).unwrap();
        assert_eq!(cites.len(), 2);
        assert!(cites.iter().all(|l| l.target_kind == "ledger"));
        assert_eq!(count_reorg_events(&db), 1);
    }

    #[test]
    fn activity_and_envelope_feed_coldness() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        // Two ledger rows at distinct ts, linked under the node.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO ledger_events (seq, ts, kind, author, payload_hash, prev_hash, entry_hash)
                 VALUES (1, 100, 'prompt', 't', 'p', 'x', 'y'), (2, 900, 'approval', 't', 'p2', 'y', 'z')",
                [],
            )
            .unwrap();
        }
        add_link(&db, "root-r", "prompt", "1");
        add_link(&db, "root-r", "decision", "2");
        let direct = db.node_direct_link_activity().unwrap();
        let (count, last) = direct.get("root-r").copied().unwrap();
        assert_eq!(count, 2);
        assert_eq!(last, Some(900)); // newest linked ledger ts
        let env = db.lake_envelope().unwrap();
        assert_eq!((env.oldest, env.newest), (100, 900));
    }

    #[test]
    fn compaction_swaps_body_for_gist_but_keeps_chain_and_hash() {
        let db = Database::open_in_memory().unwrap();
        let seq = crate::ledger::record_prompt(
            &db,
            crate::ledger::PromptInput {
                source: crate::ledger::PromptSource::Hook,
                origin: crate::ledger::Origin::Redline,
                surface: "pty_plan".into(),
                role: crate::ledger::CorpusRole::User,
                user_text: None,
                session_id: Some("s1".into()),
                claude_session_id: Some("cs1".into()),
                mission_id: None,
                project_path: None,
                body: "a long cold prompt body destined to be compacted to a gist".into(),
                thread: None,
                author: None,
                model: None,
                model_source: None,
            },
        )
        .unwrap()
        .unwrap();
        let ev = db.list_ledger_events(10).unwrap();
        let prompt_ev = ev.iter().find(|e| e.seq == seq).unwrap();
        let pid = prompt_ev.prompt_id.unwrap();
        let orig_hash = prompt_ev.payload_hash.clone(); // == prompts.body_hash

        // Chain is intact before.
        assert!(db.verify_ledger_chain().unwrap().ok);

        // Compact it → a new ledger seq is returned.
        let cseq = db.compact_prompt_body(pid, "gist: a cold prompt", "cold", "agent", "keeper").unwrap();
        assert!(cseq.is_some());

        // The body now reads as the gist for every consumer.
        assert_eq!(
            db.get_prompt_body(pid).unwrap().as_deref(),
            Some("gist: a cold prompt")
        );

        // The chain STILL verifies — verification is body-blind.
        assert!(
            db.verify_ledger_chain().unwrap().ok,
            "chain survives a body swap"
        );

        // A `compaction` event referencing the prompt exists…
        let ev2 = db.list_ledger_events(10).unwrap();
        assert!(ev2
            .iter()
            .any(|e| e.kind == "compaction" && e.prompt_id == Some(pid)));

        // …and the ORIGINAL body_hash (dedup key + tamper-evident fact) is untouched.
        let bh: String = {
            let c = db.conn.lock().unwrap();
            c.query_row(
                "SELECT body_hash FROM prompts WHERE id = ?1",
                params![pid],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(bh, orig_hash, "body_hash is never rewritten");

        // Idempotent: compacting again is a no-op.
        assert!(db.compact_prompt_body(pid, "again", "cold", "agent", "keeper").unwrap().is_none());
    }

    #[test]
    fn merge_folds_links_and_children_into_the_target() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        accepted_node(&db, "auth1", Some("root-r"), "Auth");
        accepted_node(&db, "auth2", Some("root-r"), "Authentication");
        accepted_node(&db, "auth2child", Some("auth2"), "Clerk");
        add_link(&db, "auth1", "prompt", "1");
        add_link(&db, "auth2", "prompt", "2");

        db.stage_proposal(
            None,
            &Proposal::Merge {
                node_ids: vec!["auth1".into(), "auth2".into()],
                title: Some("Auth".into()),
                parent_id: None,
                rationale: None,
            },
        )
        .unwrap();
        let prop = db.list_class_proposals().unwrap().remove(0);
        db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();

        // auth2 is gone; its link + child moved onto auth1.
        assert!(db.get_class_node("auth2").unwrap().is_none());
        assert_eq!(db.list_class_links_for_node("auth1").unwrap().len(), 2);
        assert_eq!(
            db.get_class_node("auth2child").unwrap().unwrap().parent_id.as_deref(),
            Some("auth1")
        );
    }

    #[test]
    fn split_moves_named_links_into_new_sibling_nodes() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        accepted_node(&db, "mixed", Some("root-r"), "Mixed");
        let l1 = add_link(&db, "mixed", "prompt", "1");
        let l2 = add_link(&db, "mixed", "prompt", "2");

        db.stage_proposal(
            None,
            &Proposal::Split {
                node_id: "mixed".into(),
                into: vec![
                    SplitPart { title: "Clerk".into(), link_ids: vec![l1] },
                    SplitPart { title: "Sessions".into(), link_ids: vec![l2] },
                ],
                rationale: None,
            },
        )
        .unwrap();
        let prop = db.list_class_proposals().unwrap().remove(0);
        db.apply_class_proposal(prop.id, "tester").unwrap().unwrap();

        let clerk = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .find(|n| n.title == "Clerk")
            .unwrap();
        assert_eq!(clerk.parent_id.as_deref(), Some("root-r")); // sibling of `mixed`
        assert_eq!(db.list_class_links_for_node(&clerk.id).unwrap()[0].id, l1);
    }

    #[test]
    fn staging_writes_live_rows_so_the_legacy_flip_finds_nothing() {
        let db = Database::open_in_memory().unwrap();
        accepted_node(&db, "root-r", None, "redline");
        db.stage_proposal(
            None,
            &Proposal::Create { parent_id: "root-r".into(), title: "Loop".into(), rationale: None },
        )
        .unwrap();
        db.stage_proposal(
            None,
            &Proposal::File {
                parent_id: "root-r".into(),
                sub_class: Some("Collab".into()),
                target_kind: "prompt".into(),
                target_id: "5".into(),
                note: None,
                rationale: None,
            },
        )
        .unwrap();
        // B3: nothing is `proposed`; both nodes and the link are live at once.
        assert!(db.list_class_nodes().unwrap().iter().all(|n| n.status == "accepted"));
        let collab = db
            .list_class_nodes()
            .unwrap()
            .into_iter()
            .find(|n| n.title == "Collab")
            .unwrap();
        assert_eq!(db.list_class_links_for_node(&collab.id).unwrap()[0].status, "accepted");
        // The pre-B3 flip is a no-op on a current store.
        assert!(db.accept_all_pending("classifier").unwrap().is_empty());
    }

    #[test]
    fn lake_items_since_returns_delta_with_bodies() {
        let db = Database::open_in_memory().unwrap();
        // A prompt event (with a body) + a decision event (references a row).
        let pid = db.insert_prompt(&prompt_row("hello world", "bh1", Some("sess"))).unwrap().unwrap();
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind: "prompt",
            author: "t",
            ts: 1,
            prompt_id: Some(pid),
            session_id: None,
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: "bh1",
        })
        .unwrap();
        append(&db, "approval", "ap1");
        let items = db.list_lake_items_since(0, 10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].body.as_deref(), Some("hello world"));
        assert!(items[1].body.is_none()); // decision event has no stored body
        // since_seq filters.
        assert_eq!(db.list_lake_items_since(1, 10).unwrap().len(), 1);
    }

    #[test]
    fn lake_items_exclude_machine_record_kinds() {
        let db = Database::open_in_memory().unwrap();
        append(&db, "approval", "d1");
        // Machine bookkeeping: body-less rows that would otherwise render to
        // the classifier under the "[decision references …]" fallback.
        for kind in ["router_verdict", "moot_turn", "work_file", "work_claim", "work_close"] {
            let ph = format!("m-{kind}");
            append(&db, kind, &ph);
        }
        let items = db.list_lake_items_since(0, 100).unwrap();
        assert_eq!(items.len(), 1, "only the human decision reaches the feed");
        assert_eq!(items[0].kind, "approval");
        // They stay on the chain — excluded from the feed, not from history.
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    /// Redline's own constructed prefaces never reach the classifier. Feeding
    /// them in taught the taxonomy to describe Redline's instruction text
    /// instead of the user's work — 5,809 preface chunks against 752 real ones.
    /// `system` rows STAY: a task notification reports work the user's session
    /// actually did, even though nobody typed it.
    #[test]
    fn classifier_delta_excludes_agent_prompts() {
        let db = Database::open_in_memory().unwrap();
        let seed = |body: &str, bh: &str, role: &str| {
            let mut row = prompt_row(body, bh, Some(bh));
            row.role = role;
            let pid = db.insert_prompt(&row).unwrap().unwrap();
            db.append_ledger_event(&crate::ledger::LedgerAppend {
                kind: "prompt",
                author: "t",
                ts: 1,
                prompt_id: Some(pid),
                session_id: None,
                version_number: None,
                ref_kind: None,
                ref_id: None,
                payload_hash: bh,
            })
            .unwrap();
            pid
        };
        seed("what did I decide about auth", "bh-user", "user");
        seed("You are the browse agent. …6KB of preface…", "bh-agent", "agent");
        seed("<task-notification>the run finished</task-notification>", "bh-sys", "system");

        let items = db.list_lake_items_since(0, 100).unwrap();
        let bodies: Vec<&str> = items.iter().filter_map(|i| i.body.as_deref()).collect();
        assert!(bodies.iter().any(|b| b.contains("what did I decide")));
        assert!(bodies.iter().any(|b| b.contains("task-notification")), "system rows stay");
        assert!(
            !bodies.iter().any(|b| b.contains("browse agent")),
            "an agent preface must never enter classification: {bodies:?}"
        );
    }

    /// A compacted prompt is SUMMARIZED, not empty — but compaction writes
    /// `body = ''` rather than NULL, so `COALESCE(p.body, …)` silently handed
    /// the classifier an empty string for all 224 compacted rows. They read as
    /// content-free and were classified as such. `NULLIF(p.body, '')` is the fix.
    #[test]
    fn classifier_delta_resolves_a_compacted_gist() {
        let db = Database::open_in_memory().unwrap();
        let pid = db
            .insert_prompt(&prompt_row("the original cold body", "bh-cold", Some("s")))
            .unwrap()
            .unwrap();
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind: "prompt",
            author: "t",
            ts: 1,
            prompt_id: Some(pid),
            session_id: None,
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: "bh-cold",
        })
        .unwrap();
        db.compact_prompt_body(pid, "gist: chose Yjs for collab", "cold", "agent", "keeper")
            .unwrap();

        let items = db.list_lake_items_since(0, 100).unwrap();
        let prompt_item = items.iter().find(|i| i.kind == "prompt").expect("the prompt is in the feed");
        assert_eq!(
            prompt_item.body.as_deref(),
            Some("gist: chose Yjs for collab"),
            "the gist stands in for the released body — not an empty string"
        );
    }

    /// A cold compaction is a guess and must be reversible; the archive is
    /// derived data outside the chain, so the inflated bytes are re-hashed
    /// against the recorded hash before they are trusted back into the row.
    #[test]
    fn archived_body_round_trips_and_verifies() {
        let db = Database::open_in_memory().unwrap();
        let body = "the original body, ".repeat(60);
        let bh = crate::ledger::body_hash(&body);
        let pid = db.insert_prompt(&prompt_row(&body, &bh, Some("s"))).unwrap().unwrap();
        db.compact_prompt_body(pid, "gist: a thing", "cold", "agent", "keeper").unwrap();
        assert_eq!(db.get_prompt_body(pid).unwrap().as_deref(), Some("gist: a thing"));
        let (rows, bytes) = db.archive_stats().unwrap();
        assert_eq!(rows, 1);
        assert!(bytes > 0 && bytes < body.len() as i64, "deflated, not stored raw");

        assert!(db.restore_prompt_body(pid).unwrap());
        assert_eq!(db.get_prompt_body(pid).unwrap().as_deref(), Some(body.as_str()));
        assert_eq!(db.archive_stats().unwrap().0, 0, "restore consumes the archive");
        assert!(!db.restore_prompt_body(pid).unwrap(), "nothing left to restore");

        // A corrupted blob is refused, never silently written back.
        db.compact_prompt_body(pid, "gist: again", "cold", "agent", "keeper").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE prompt_archive SET blob = ?2 WHERE prompt_id = ?1",
                params![pid, polis_store::compaction::deflate_body("not the original body at all").unwrap()],
            )
            .unwrap();
        }
        assert!(db.restore_prompt_body(pid).is_err(), "hash mismatch is an error");
    }

    /// Forget must mean forget: no archive row survives it, and a forget over an
    /// earlier cold compaction removes the copy that pass left behind.
    #[test]
    fn forget_leaves_no_archive_row() {
        let db = Database::open_in_memory().unwrap();
        let body = "something private, ".repeat(40);
        let bh = crate::ledger::body_hash(&body);
        let pid = db.insert_prompt(&prompt_row(&body, &bh, Some("s"))).unwrap().unwrap();

        // Direct forget → nothing archived.
        db.compact_prompt_body(pid, "[forgotten]", "forget", "deterministic", "yusuf")
            .unwrap();
        assert_eq!(db.archive_stats().unwrap().0, 0);

        // Cold first, then forget → the cold pass's archive is deleted too.
        let body2 = "also private, ".repeat(40);
        let bh2 = crate::ledger::body_hash(&body2);
        let pid2 = db.insert_prompt(&prompt_row(&body2, &bh2, Some("s2"))).unwrap().unwrap();
        db.compact_prompt_body(pid2, "gist", "cold", "agent", "keeper").unwrap();
        assert_eq!(db.archive_stats().unwrap().0, 1);
        db.restore_prompt_body(pid2).unwrap();
        db.compact_prompt_body(pid2, "[forgotten]", "forget", "deterministic", "yusuf")
            .unwrap();
        assert_eq!(
            db.archive_stats().unwrap().0,
            0,
            "a forget over a cold compaction must remove the recoverable copy"
        );
    }

    /// Insert a lake row AND its ledger event — the search paths join through
    /// `ledger_events`, so a bare `insert_prompt` is invisible to them.
    fn seed_indexed_prompt(
        db: &Database,
        body: &str,
        bh: &str,
        role: &str,
        user_text: Option<&str>,
    ) -> i64 {
        let mut row = prompt_row(body, bh, Some(bh));
        row.role = role;
        row.user_text = user_text;
        let pid = db.insert_prompt(&row).unwrap().unwrap();
        db.append_ledger_event(&crate::ledger::LedgerAppend {
            kind: "prompt",
            author: "tester",
            ts: 1000,
            prompt_id: Some(pid),
            session_id: None,
            version_number: None,
            ref_kind: None,
            ref_id: None,
            payload_hash: bh,
        })
        .unwrap();
        pid
    }

    /// THE FTS LANDMINE, defused before the caption column is ever written.
    ///
    /// `browse_events_fts` is external-content and had only an `AFTER INSERT`
    /// trigger — safe exactly as long as the table was insert-only. The vision
    /// tier's `caption` is written by an UPDATE, and an external-content FTS
    /// table whose content row changes without a matching `'delete'` row does
    /// NOT error: it keeps offsets into text that no longer exists and
    /// `snippet()` returns garbage. The delete/update pair has to exist first,
    /// so it is tested first.
    #[test]
    fn browse_events_fts_survives_an_update() {
        let db = Database::open_in_memory().unwrap();
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://example.test/a".into(),
                title: Some("Original title".into()),
                text: "the original body mentions zeppelins".into(),
                from_event_id: None,
                author: None,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(db.search_browse_events("zeppelins", 10).unwrap().len(), 1);

        // An UPDATE that rewrites the indexed text.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE browse_events SET title = ?1, text = ?2 WHERE id = 1",
                params!["Revised title", "the revised body mentions dirigibles"],
            )
            .unwrap();
        }
        assert!(
            db.search_browse_events("zeppelins", 10).unwrap().is_empty(),
            "the OLD text must leave the index, or it matches forever"
        );
        let hits = db.search_browse_events("dirigibles", 10).unwrap();
        assert_eq!(hits.len(), 1, "the NEW text must be findable");
        // …and `snippet()` must be readable rather than offsets into text that
        // no longer exists — the actual symptom of a missing delete trigger.
        assert!(
            hits[0].snippet.contains("dirigibles"),
            "snippet is garbage: {:?}",
            hits[0].snippet
        );

        // A DELETE removes it from the index too.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM browse_events WHERE id = 1", []).unwrap();
        }
        assert!(db.search_browse_events("dirigibles", 10).unwrap().is_empty());
    }

    /// A picture of one of Redline's own surfaces reaches its Timeline row, is
    /// counted as REFERENCED by the retention sweep, and carries the theme it
    /// was taken under.
    ///
    /// The referenced check is the load-bearing one: the sweep deletes anything
    /// the database doesn't point at, so a surface shot missing from
    /// `referenced_shot_keys` would be captured and then deleted on the next
    /// pass — silently, and only visible as "the pictures never appear". That
    /// is the same one-writer-erases-another's-files shape as the
    /// `thumbs_prune` bug this program already had to fix once.
    #[test]
    fn a_surface_shot_reaches_its_row_and_survives_the_sweep() {
        let db = Database::open_in_memory().unwrap();
        let ev = append(&db, "approval", "ph-approve");
        db.record_surface_shot(ev.seq, "approval", "rl-approval-1", Some("frivolous"))
            .unwrap();

        // It reaches the Timeline row it belongs to.
        let items = crate::context::query_ledger(&db, &crate::context::LedgerFilters::default())
            .unwrap();
        let row = items.iter().find(|i| i.event.seq == ev.seq).expect("the event is listed");
        assert_eq!(row.shot_key.as_deref(), Some("rl-approval-1"));

        // The sweep can see it — otherwise it would be deleted as unreferenced.
        assert!(db.referenced_shot_keys().unwrap().contains("rl-approval-1"));
        let plan = crate::shots::plan_sweep(
            &[("rl-approval-1".to_string(), 40_000, crate::ledger::now_millis())],
            &db.referenced_shot_keys().unwrap(),
            crate::ledger::now_millis(),
            crate::shots::SHOTS_MAX_BYTES,
            crate::shots::SHOTS_MAX_AGE_DAYS,
        );
        assert!(plan.delete.is_empty(), "a referenced surface shot must survive");

        // The theme is stamped, so an old shot can be labelled rather than
        // silently looking like a rendering bug.
        let stored = db.surface_shots_for_seqs(&[ev.seq]).unwrap();
        assert_eq!(stored.get(&ev.seq).unwrap().1.as_deref(), Some("frivolous"));

        // Forgetting it removes the row, and the sweep then reclaims the file.
        assert_eq!(db.clear_surface_shot("rl-approval-1").unwrap(), 1);
        assert!(db.referenced_shot_keys().unwrap().is_empty());
    }

    /// A caption goes in its OWN column. `context_hash = body_hash(text)` is
    /// the identity the shot key, the dedupe and the chain all rest on, so
    /// folding a caption into `text` would silently re-key the page and orphan
    /// its own picture.
    #[test]
    fn a_caption_never_re_keys_the_page_it_describes() {
        let db = Database::open_in_memory().unwrap();
        crate::ledger::record_browse_event(
            &db,
            crate::ledger::BrowseEventInput {
                action: crate::ledger::BrowseAction::Navigate,
                browse_id: Some("t1".into()),
                url: "https://dash.test/".into(),
                title: Some("Dashboard".into()),
                // A dark page: essentially no text after the title/url prefix.
                text: "Dashboard\nhttps://dash.test/\n\n".into(),
                from_event_id: None,
                author: None,
            },
        )
        .unwrap()
        .unwrap();
        let hash_before = db.context_hash_for_browse_id(1).unwrap().unwrap();
        db.set_shot_key_for_hash(&hash_before, "bs-abc123").unwrap();

        // It IS in the dark set, and captioning it takes it out.
        assert_eq!(db.pages_with_a_picture_but_no_text(10).unwrap().len(), 1);
        db.set_caption_for_hash(&hash_before, "A metrics dashboard with four charts")
            .unwrap();
        assert!(db.pages_with_a_picture_but_no_text(10).unwrap().is_empty());

        // The identity is unchanged, so the picture is still its picture.
        let hash_after = db.context_hash_for_browse_id(1).unwrap().unwrap();
        assert_eq!(hash_before, hash_after, "a caption must not re-key the page");
        assert!(db.referenced_shot_keys().unwrap().contains("bs-abc123"));

        // Forgetting the picture clears the pointer everywhere it appears.
        assert_eq!(db.clear_shot_key("bs-abc123").unwrap(), 1);
        assert!(db.referenced_shot_keys().unwrap().is_empty());
    }

    /// Porter earns its place by unifying inflections at no index cost — this
    /// is the "compacting finds compaction" behaviour the Timeline promises.
    #[test]
    fn porter_stems_across_inflections() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(
            &db,
            "the keeper compaction pass released cold bodies",
            "bh-s",
            "user",
            None,
        );
        for q in ["compaction", "compacting", "compacted", "compact"] {
            assert_eq!(
                db.search_prompts_fts(q, 10).unwrap().len(),
                1,
                "{q:?} must reach the same document"
            );
        }
    }

    /// `tokenchars` keeps identifiers, paths and flags whole. Without it,
    /// `src/db.rs` shreds into three tokens and `--allowedTools` into one bare
    /// word, and neither can be searched for as itself.
    #[test]
    fn tokenchars_keep_identifiers_whole() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(
            &db,
            "pass --allowedTools to the spawn in src-tauri/src/db.rs for rl_del",
            "bh-t",
            "user",
            None,
        );
        for q in ["\"--allowedTools\"", "\"src-tauri/src/db.rs\"", "rl_del"] {
            assert_eq!(db.search_prompts_fts(q, 10).unwrap().len(), 1, "for {q}");
        }
    }

    /// Phase 1's corpus work becomes index size here: an agent row contributes
    /// only the human's words, never the preface wrapped around them.
    #[test]
    fn fts_excludes_agent_bodies_but_keeps_user_text() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(
            &db,
            "You are the browse agent. Follow your browse skill. …preface…",
            "bh-agent",
            "agent",
            Some("does clerk charge per MAU"),
        );

        assert!(
            db.search_prompts_fts("preface", 10).unwrap().is_empty(),
            "the preface must not be searchable"
        );
        assert_eq!(
            db.search_prompts_fts("clerk", 10).unwrap().len(),
            1,
            "the question it wrapped must be"
        );
    }

    /// THE caveat this design retires. `'rebuild'` used to be forbidden here:
    /// the triggers indexed `COALESCE(gist, body)` while rebuild re-read
    /// `prompts.body` by column name — `''` for every compacted row — so
    /// rebuilding silently dropped 224 gists out of the index. With the indexed
    /// text as a generated column of the content table, the two paths read the
    /// same expression and cannot disagree.
    #[test]
    fn prompts_fts_rebuild_is_now_correct() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(&db, "the warm body mentions widgets", "bh-warm", "user", None);
        let cold_id = seed_indexed_prompt(
            &db,
            "a long deliberation ending in sprockets, with the throwaway token zzyzx",
            "bh-cold",
            "user",
            None,
        );
        db.compact_prompt_body(cold_id, "gist: chose sprockets over widgets", "cold", "agent", "keeper")
            .unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO prompts_fts(prompts_fts) VALUES('rebuild')", [])
                .unwrap();
        }
        assert_eq!(
            db.search_prompts_fts("widgets", 10).unwrap().len(),
            2,
            "the warm body and the cold row's gist both still match"
        );
        assert_eq!(
            db.search_prompts_fts("sprockets", 10).unwrap().len(),
            1,
            "the compacted row survives a rebuild through its gist"
        );
        assert!(
            db.search_prompts_fts("zzyzx", 10).unwrap().is_empty(),
            "and the RELEASED words stay released — a rebuild must not resurrect them"
        );
    }

    /// The cascade: `AND` is tried first and wins outright when it matches, so
    /// a precise reading is never diluted by one-term-in-five noise.
    #[test]
    fn and_first_then_or_cascade() {
        let db = Database::open_in_memory().unwrap();
        for (i, body) in [
            "the browser tab suspension design",
            "browser windows generally",
            "tab bar styling",
        ]
        .iter()
        .enumerate()
        {
            seed_indexed_prompt(&db, body, &format!("bh-{i}"), "user", None);
        }

        let precise = db.search_prompts_ranked("browser tab suspension", 10).unwrap();
        assert_eq!(precise.len(), 1, "AND wins outright: {precise:?}");
        assert_eq!(precise[0].1, crate::query::MatchStage::And);

        // No document has all three, so the cascade widens — and SAYS it did.
        let widened = db.search_prompts_ranked("browser suspension zebra", 10).unwrap();
        assert!(widened.len() > 1);
        assert!(widened.iter().all(|(_, s)| *s == crate::query::MatchStage::Or));
    }

    /// The bug that made every natural-language question resolve `node: null`:
    /// the whole raw query was one LIKE pattern.
    #[test]
    fn match_class_nodes_resolves_a_question() {
        let db = Database::open_in_memory().unwrap();
        db.seed_class_roots(&[
            ("n-browser".into(), "Embedded browser".into(), None),
            ("n-voice".into(), "Voice agent".into(), None),
        ])
        .unwrap();

        // Verbatim from the live probe that returned `node: null`.
        let hits = db
            .match_class_nodes("what did I decide about the browser tab suspension", 5)
            .unwrap();
        assert_eq!(
            hits.first().map(|n| n.id.as_str()),
            Some("n-browser"),
            "a question must resolve to its class: {hits:?}"
        );
        // A question about nothing in the catalog still resolves nothing —
        // widening must not invent a node.
        assert!(db
            .match_class_nodes("what did I decide about zebras", 5)
            .unwrap()
            .is_empty());
    }

    /// Every read of a prompt body must resolve the gist. `COALESCE(p.body, …)`
    /// returns `''` for a compacted row — a silent content-free read, not an
    /// error — so the invariant is pinned in source across the whole file.
    #[test]
    fn every_prompt_body_read_resolves_the_gist() {
        const SRC: &str = include_str!("db.rs");
        // Assembled at runtime so this test's own source doesn't match itself.
        let needle = format!("COALESCE(p.{}", "body");
        for (ix, _) in SRC.match_indices(&needle) {
            let line_end = SRC[ix..].find('\n').map(|n| ix + n).unwrap_or(SRC.len());
            let line_start = SRC[..ix].rfind('\n').map(|n| n + 1).unwrap_or(0);
            let line = &SRC[line_start..line_end];
            assert!(
                line.trim_start().starts_with("//"),
                "reading `p.body` without NULLIF returns '' for every compacted row — \
                 use PROMPT_TEXT.\n  {line}"
            );
        }
        // And the const itself says the right thing.
        assert_eq!(PROMPT_TEXT, "COALESCE(NULLIF(p.body, ''), p.gist)");
    }

    /// The grep arm's reason for existing: reach what tokenization cannot.
    #[test]
    fn grep_finds_what_fts_cannot() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(
            &db,
            "the spawn passes #[serde(rename_all = \"camelCase\")] and fails with \
             E0308: mismatched types",
            "bh-g",
            "user",
            None,
        );
        // A fragment INSIDE a token: no tokenizer can produce `rename_al`, so
        // this is unreachable through FTS by construction.
        let hits = db
            .grep_memory("rename_al", None, false, GrepScope::Prompts, 10)
            .unwrap();
        assert_eq!(hits.len(), 1, "the trigram index reaches inside a token");
        assert!(hits[0].excerpt.contains("rename_all"), "{}", hits[0].excerpt);
        assert!(hits[0].seq.is_some(), "a grep hit must be citable as #seq");

        // An error string with punctuation the tokenizer eats.
        assert_eq!(
            db.grep_memory("E0308:", None, false, GrepScope::Prompts, 10).unwrap().len(),
            1
        );
    }

    /// A needle shorter than a trigram cannot be answered from the index, so it
    /// is refused BY NAME rather than silently becoming a full scan.
    #[test]
    fn grep_refuses_a_short_literal() {
        let db = Database::open_in_memory().unwrap();
        let err = db.grep_memory("ab", None, false, GrepScope::All, 10).unwrap_err();
        assert!(matches!(err, GrepError::LiteralTooShort { min: 3, got: 2 }));
        // The message has to teach the fix, not just report a failure.
        let msg = err.to_string();
        assert!(msg.contains("at least 3"), "{msg}");
        assert!(msg.contains("trigram"), "{msg}");
        // Whitespace doesn't buy length.
        assert!(db.grep_memory("  a  ", None, false, GrepScope::All, 10).is_err());
    }

    #[test]
    fn grep_case_sensitive_post_filters() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(&db, "pass --allowedTools to the spawn", "bh-c1", "user", None);
        seed_indexed_prompt(&db, "pass --allowedtools to the spawn", "bh-c2", "user", None);
        assert_eq!(
            db.grep_memory("allowedTools", None, false, GrepScope::Prompts, 10).unwrap().len(),
            2,
            "case-insensitive is the default"
        );
        assert_eq!(
            db.grep_memory("allowedTools", None, true, GrepScope::Prompts, 10).unwrap().len(),
            1,
            "case-sensitivity post-filters rather than needing a second index"
        );
    }

    /// The regex is a VERIFIER over what the index returned — it narrows, never
    /// widens, and a bad pattern is rejected before any query runs.
    #[test]
    fn grep_regex_verifies_the_indexed_candidates() {
        let db = Database::open_in_memory().unwrap();
        seed_indexed_prompt(&db, "error code E0308 in the build", "bh-r1", "user", None);
        seed_indexed_prompt(&db, "error code E0061 in the build", "bh-r2", "user", None);
        assert_eq!(
            db.grep_memory("error code", None, false, GrepScope::Prompts, 10).unwrap().len(),
            2
        );
        assert_eq!(
            db.grep_memory("error code", Some(r"E03\d\d"), false, GrepScope::Prompts, 10)
                .unwrap()
                .len(),
            1,
            "the regex filters the candidate set"
        );
        assert!(matches!(
            db.grep_memory("error code", Some("("), false, GrepScope::Prompts, 10).unwrap_err(),
            GrepError::BadRegex(_)
        ));
    }

    /// Run the migration against a COPY of a real database and print what it
    /// did to the corpus. Not a unit test — a measuring instrument, kept in the
    /// tree because "we shrank the index by 2.5 MB" is a claim about one
    /// specific corpus and should be re-checkable on any other.
    ///
    /// ```text
    /// cp ~/Library/Application\ Support/com.redline.app/redline.db /tmp/real.db
    /// REDLINE_REAL_DB=/tmp/real.db cargo test --lib real_db -- --ignored --nocapture
    /// ```
    ///
    /// It asserts only the invariants that must hold for ANY corpus — the chain
    /// still verifies, no ledger event was appended, no body was mutated — and
    /// prints the rest for a human to read.
    #[test]
    #[ignore = "needs REDLINE_REAL_DB pointing at a copy of a live database"]
    fn real_db_migration_report() {
        let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
            eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
            return;
        };
        let path = std::path::PathBuf::from(path);

        // Before: read with a bare connection so nothing migrates yet.
        let raw = rusqlite::Connection::open(&path).unwrap();
        let scalar = |c: &rusqlite::Connection, sql: &str| -> i64 {
            c.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
        };
        let events_before = scalar(&raw, "SELECT COUNT(*) FROM ledger_events");
        let prompts_before = scalar(&raw, "SELECT COUNT(*) FROM prompts");
        let bytes_before = scalar(
            &raw,
            "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB))),0) FROM prompts",
        );
        let fts_before = scalar(
            &raw,
            "SELECT COALESCE(SUM(pgsize),0) FROM dbstat
             WHERE name LIKE '%_fts%' OR name LIKE '%_grep%'",
        );
        drop(raw);

        let db = Database::open(&path).unwrap();
        let conn = db.conn.lock().unwrap();
        println!("\n--- corpus composition ---");
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(role,'unclassified'), COUNT(*),
                        SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB)))
                 FROM prompts GROUP BY 1 ORDER BY 3 DESC",
            )
            .unwrap();
        let rows: Vec<(String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for (role, n, bytes) in &rows {
            println!(
                "  {role:<14} {n:>5} rows  {:>8.1} KB  ({:.1}%)",
                *bytes as f64 / 1024.0,
                100.0 * *bytes as f64 / bytes_before.max(1) as f64
            );
        }
        drop(stmt);

        println!("\n--- index sizes ---");
        let mut stmt = conn
            .prepare(
                "SELECT name, SUM(pgsize) FROM dbstat
                 WHERE name LIKE '%_fts%' OR name LIKE '%_grep%'
                 GROUP BY name ORDER BY 2 DESC",
            )
            .unwrap();
        let idx: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for (name, bytes) in &idx {
            println!("  {name:<32} {:>8.1} KB", *bytes as f64 / 1024.0);
        }
        let fts_after: i64 = idx.iter().map(|(_, b)| *b).sum();
        println!(
            "\n  FTS total: {:.1} KB → {:.1} KB  ({:+.1} KB)",
            fts_before as f64 / 1024.0,
            fts_after as f64 / 1024.0,
            (fts_after - fts_before) as f64 / 1024.0
        );
        drop(stmt);

        // The invariants that must hold for any corpus.
        let events_after = scalar(&conn, "SELECT COUNT(*) FROM ledger_events");
        assert_eq!(
            events_after, events_before,
            "reclassification must append NOTHING to the chain"
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts"), prompts_before);
        assert_eq!(
            scalar(
                &conn,
                "SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(NULLIF(body,''),gist,'') AS BLOB))),0) FROM prompts"
            ),
            bytes_before,
            "no body may be mutated by the migration"
        );
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts WHERE role IS NULL"), 0);
        drop(conn);
        assert!(db.verify_ledger_chain().unwrap().ok, "the chain still verifies");

        // And the retrieval probes from the plan's verification section.
        println!("\n--- retrieval probes ---");
        for q in [
            "what did I decide about the browser tab suspension",
            "keeper compaction",
            "compacting",
        ] {
            let nodes = db.match_class_nodes(q, 3).unwrap();
            let pack = crate::context::build_answer_pack(&db, Some(q), None, 8);
            let bytes = serde_json::to_vec(&pack).unwrap().len();
            // Are any two surviving bodies near-duplicates of each other? This
            // is the "4 of 8 hits were the same boilerplate" check.
            let bodies: Vec<u64> = pack
                .prompt_hits
                .iter()
                .filter_map(|h| h.item.body.as_deref())
                .map(crate::dedup::simhash)
                .collect();
            let dupe_pairs = bodies
                .iter()
                .enumerate()
                .flat_map(|(i, a)| bodies[i + 1..].iter().map(move |b| (*a, *b)))
                .filter(|(a, b)| crate::dedup::near_duplicate(*a, *b))
                .count();
            println!(
                "  {q:?}\n    node: {:?}  bytes: {bytes}  promptHits: {}  browseHits: {}  \
                 notes: {}  dupePairs: {dupe_pairs}  truncated: {:?}  matchedNodes: {}",
                nodes.first().map(|n| n.title.as_str()),
                pack.prompt_hits.len(),
                pack.browse_hits.len(),
                pack.notes.len(),
                pack.truncated,
                pack.matched_nodes.len(),
            );
        }
        println!();
    }

    /// Session A2 of the Polis extraction: attaching the store to a database
    /// the OLD migrations built (every install before A2) must be a no-op on
    /// the record — zero events appended, no body mutated, no object dropped,
    /// recreated or added (so no FTS rebuild), chain green — and must ADOPT the
    /// two legacy version keys rather than re-run their blocks. The second
    /// open must take the fast path.
    ///
    /// ```text
    /// cp ~/Library/Application\ Support/com.redline.app/backups/<newest>.db /tmp/real.db
    /// REDLINE_REAL_DB=/tmp/real.db cargo test --lib real_db_attach -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs REDLINE_REAL_DB pointing at a copy of a live database"]
    fn real_db_attach_is_a_noop() {
        let Ok(path) = std::env::var("REDLINE_REAL_DB") else {
            eprintln!("set REDLINE_REAL_DB to a COPY of a live redline.db");
            return;
        };
        let path = std::path::PathBuf::from(path);
        let scalar = |c: &rusqlite::Connection, sql: &str| -> i64 {
            c.query_row(sql, [], |r| r.get(0)).unwrap_or(-1)
        };
        let text = |c: &rusqlite::Connection, sql: &str| -> String {
            c.query_row(sql, [], |r| r.get(0)).unwrap_or_default()
        };
        // Every schema object except the store's own meta table: (type, name,
        // rootpage) in creation order. A rebuilt FTS table, a dropped index or
        // a newly created object all change this list.
        let objects = |c: &rusqlite::Connection| -> Vec<(String, String, i64)> {
            let mut stmt = c
                .prepare(
                    "SELECT type, name, rootpage FROM sqlite_master
                     WHERE name NOT LIKE '%polis_meta%' ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };

        let raw = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            scalar(&raw, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'polis_meta'"),
            0,
            "the copy must be one the store has never attached to"
        );
        let events_before = scalar(&raw, "SELECT COALESCE(MAX(seq), 0) FROM ledger_events");
        let prompts_before = scalar(&raw, "SELECT COUNT(*) FROM prompts");
        let bytes_before = scalar(
            &raw,
            "SELECT COALESCE(SUM(LENGTH(body)), 0) + COALESCE(SUM(LENGTH(gist)), 0) FROM prompts",
        );
        let head_before = text(&raw, "SELECT entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1");
        let legacy_lexical =
            text(&raw, "SELECT value FROM app_settings WHERE key = 'redline.memory.lexicalVersion'");
        let legacy_role = text(
            &raw,
            "SELECT value FROM app_settings WHERE key = 'redline.memory.corpusRoleVersion'",
        );
        let objects_before = objects(&raw);
        drop(raw);

        let db = Database::open(&path).unwrap();
        let report = db.last_attach().clone();
        assert!(report.adopted_keys >= 2, "both legacy version keys adopted (plus any memory settings the host had): {}", report.adopted_keys);
        assert!(report.migrated, "the first attach runs the idempotent block once");
        assert_eq!(db.meta("lexical_version").unwrap().as_deref(), Some(legacy_lexical.as_str()));
        assert_eq!(db.meta("corpus_role_version").unwrap().as_deref(), Some(legacy_role.as_str()));
        // The store's own version, not a literal: a store schema bump (B1's
        // class_runs columns took it 1 → 2) is a real migration the first
        // attach runs once — still zero events, still the same bodies.
        assert_eq!(db.meta("schema_version").unwrap().as_deref(), Some(polis_store::meta::STORE_SCHEMA_VERSION));
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(
                scalar(&conn, "SELECT COALESCE(MAX(seq), 0) FROM ledger_events"),
                events_before,
                "zero events appended"
            );
            assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM prompts"), prompts_before);
            assert_eq!(
                scalar(
                    &conn,
                    "SELECT COALESCE(SUM(LENGTH(body)), 0) + COALESCE(SUM(LENGTH(gist)), 0) FROM prompts"
                ),
                bytes_before,
                "no body or gist changed"
            );
            assert_eq!(
                text(&conn, "SELECT entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1"),
                head_before
            );
            let after = objects(&conn);
            let missing: Vec<_> = objects_before.iter().filter(|o| !after.contains(o)).collect();
            let added: Vec<_> = after.iter().filter(|o| !objects_before.contains(o)).collect();
            assert!(
                missing.is_empty(),
                "schema objects dropped or rebuilt on attach: {missing:?}"
            );
            // A store schema bump (`polis_store::meta::STORE_SCHEMA_VERSION`) may
            // CREATE objects on first attach — that is the one legitimate
            // "added". The allowance names exactly what each bump introduced,
            // by the version that introduced it, so an unexpected object (a
            // rebuilt FTS table, a stray index) still fails. Columns added by
            // ALTER do not appear here: the list reads type/name/rootpage.
            // 3 (B2): the `class_run_ops` journal (+ its PK autoindex) and the
            // two retire-mark indexes. (The store exposes no list of its own
            // objects yet; when it does, read it from there.)
            const STORE_BUMP_OBJECTS: &[&str] = &[
                // B2
                "class_run_ops",
                "sqlite_autoindex_class_run_ops_1",
                "idx_class_nodes_retired",
                "idx_class_links_retired",
                // E2 (identity): the two tables, their PK autoindexes, the
                // parent index, the scope index per scoped table, and — since
                // the store's f8d5066 fix (its first CREATE named `rowid`,
                // which SQLite refuses; a silent no-op this very check
                // exposed) — the partial `idx_<table>_unscoped` index per
                // scoped table.
                "principals",
                "sqlite_autoindex_principals_1",
                "principal_aliases",
                "sqlite_autoindex_principal_aliases_1",
                "idx_principals_parent",
                "idx_prompts_scope",
                "idx_browse_events_scope",
                "idx_user_notes_scope",
                "idx_class_nodes_scope",
                "idx_class_observations_scope",
                "idx_prompts_unscoped",
                "idx_browse_events_unscoped",
                "idx_user_notes_unscoped",
                "idx_class_nodes_unscoped",
                "idx_class_observations_unscoped",
                // B3 (autonomy): the proposal work queue's index.
                "idx_class_proposals_next",
                // C1 (centroid-first filing).
                "class_centroids",
                "sqlite_autoindex_class_centroids_1",
                // E3 (sharing core): the foreign tables, their PK autoindexes,
                // the chain index, the FTS table with its shadow tables and
                // triggers.
                "foreign_chains",
                "sqlite_autoindex_foreign_chains_1",
                "foreign_principals",
                "sqlite_autoindex_foreign_principals_1",
                "foreign_events",
                "sqlite_autoindex_foreign_events_1",
                "foreign_prompts",
                "sqlite_autoindex_foreign_prompts_1",
                "foreign_notes",
                "sqlite_autoindex_foreign_notes_1",
                "foreign_redactions",
                "sqlite_autoindex_foreign_redactions_1",
                "foreign_acks",
                "sqlite_autoindex_foreign_acks_1",
                "foreign_trust",
                "sqlite_autoindex_foreign_trust_1",
                "foreign_subscriptions",
                "idx_foreign_prompts_chain",
                "foreign_prompts_fts",
                "foreign_prompts_fts_data",
                "foreign_prompts_fts_idx",
                "foreign_prompts_fts_docsize",
                "foreign_prompts_fts_config",
                "foreign_prompts_fts_ai",
                "foreign_prompts_fts_ad",
                "foreign_prompts_fts_au",
                // E4 (the org node): the firm's catalog as a peer sees it, and
                // the relay's per-peer acknowledgements.
                "foreign_class_nodes",
                "sqlite_autoindex_foreign_class_nodes_1",
                "foreign_class_links",
                "sqlite_autoindex_foreign_class_links_1",
                "org_acks",
                "sqlite_autoindex_org_acks_1",
            ];
            let unexpected: Vec<_> = added
                .iter()
                .filter(|(_, name, _)| !STORE_BUMP_OBJECTS.contains(&name.as_str()))
                .collect();
            assert!(
                unexpected.is_empty(),
                "schema objects added on attach beyond the store's own bump: {unexpected:?} \
                 (allowed: {STORE_BUMP_OBJECTS:?}; store schema version {})",
                polis_store::meta::STORE_SCHEMA_VERSION
            );
        }
        assert!(db.verify_ledger_chain().unwrap().ok, "the chain still verifies");
        drop(db);

        let again = Database::open(&path).unwrap();
        assert!(!again.last_attach().migrated, "a current store runs no schema SQL on reopen");
        assert_eq!(again.last_attach().adopted_keys, 0);
        eprintln!(
            "real_db_attach_is_a_noop: events={events_before} prompts={prompts_before} \
             bytes={bytes_before} objects={} lexical={legacy_lexical} role={legacy_role}",
            objects_before.len()
        );
    }

    /// The one-time reclassification runs over rows captured before the column
    /// was filled, leaves them byte-intact, and appends nothing to the chain.
    #[test]
    fn corpus_role_backfill_reclassifies_without_touching_the_chain() {
        let db = Database::open_in_memory().unwrap();
        let seed = |body: &str, bh: &str, source: &str| {
            let mut row = prompt_row(body, bh, Some(bh));
            row.source = source;
            db.insert_prompt(&row).unwrap().unwrap()
        };
        let user = seed("add auth to the app", "bh-a", "hook");
        let sys = seed("<task-notification>done</task-notification>", "bh-b", "hook");
        let agent = seed("first-turn preface", "bh-c", "rust_firstturn");
        let leaked = seed(&format!("You are the browse agent. {}", "x".repeat(2100)), "bh-d", "hook");
        append(&db, "approval", "keep-me");
        let events_before = db.max_ledger_seq().unwrap();

        {
            // Simulate an upgrade: clear the roles and the version key, then
            // re-run the migration.
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE prompts SET role = NULL", []).unwrap();
            conn.execute(
                "DELETE FROM polis_meta WHERE key = ?1",
                params![polis_store::meta::CORPUS_ROLE_VERSION_KEY],
            )
            .unwrap();
        }
        // Run the STEP, not the runner. `attach` is a no-op on an
        // already-current store — that is the whole point of the version
        // stamp — so re-opening would test the fast path, not the backfill
        // this case is about. `run_migrations` is the step, unconditionally.
        db.run_migrations().unwrap();

        let role_of = |id: i64| -> String {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT role FROM prompts WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(role_of(user), "user");
        assert_eq!(role_of(sys), "system");
        assert_eq!(role_of(agent), "agent");
        assert_eq!(role_of(leaked), "agent", "the leaked captures are recognized by shape");

        // Reclassify, don't compact: bodies intact, zero new chain events.
        assert_eq!(db.get_prompt_body(user).unwrap().as_deref(), Some("add auth to the app"));
        assert_eq!(db.max_ledger_seq().unwrap(), events_before, "no events appended");
        assert!(db.verify_ledger_chain().unwrap().ok);

        // Composition is reportable — the number nobody could see.
        let comp = db.corpus_composition().unwrap();
        let rows_for = |r: &str| comp.iter().find(|(k, _, _)| k == r).map(|(_, n, _)| *n).unwrap_or(0);
        assert_eq!(rows_for("user"), 1);
        assert_eq!(rows_for("agent"), 2);
        assert_eq!(rows_for("system"), 1);
    }

    #[test]
    fn ledger_tamper_is_detected_at_first_bad_seq() {
        let db = Database::open_in_memory().unwrap();
        append(&db, "prompt", "h1");
        append(&db, "approval", "h2");
        append(&db, "revision", "h3");
        // Mutate a hashed field on seq 2 directly, as a tamperer would.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE ledger_events SET author = 'mallory' WHERE seq = 2", [])
                .unwrap();
        }
        let v = db.verify_ledger_chain().unwrap();
        assert!(!v.ok);
        assert_eq!(v.first_bad_seq, Some(2));
        assert_eq!(v.checked, 1, "verification stops at the first bad seq");
    }

    #[test]
    fn prompt_insert_dedups_on_body_and_session() {
        let db = Database::open_in_memory().unwrap();
        // Same body + same claude session → deduped.
        assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs1"))).unwrap().is_some());
        assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs1"))).unwrap().is_none());
        // Same body, different session → distinct.
        assert!(db.insert_prompt(&prompt_row("hi", "bh1", Some("cs2"))).unwrap().is_some());
        // NULL sessions are treated as distinct (multiple allowed).
        assert!(db.insert_prompt(&prompt_row("hi", "bh1", None)).unwrap().is_some());
        assert!(db.insert_prompt(&prompt_row("hi", "bh1", None)).unwrap().is_some());
    }

    #[test]
    fn revision_and_decision_events_are_idempotent() {
        let db = Database::open_in_memory().unwrap();
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body", None).unwrap().is_some());
        // Same (session, version, payload) → skipped.
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "plan body", None).unwrap().is_none());
        // Changed body at same version → recorded.
        assert!(crate::ledger::record_revision_event(&db, "s1", 1, "edited", None).unwrap().is_some());

        let dec = |ph: &str| crate::ledger::DecisionInput {
            kind: crate::ledger::EventKind::Approval,
            author: Some("me".to_string()),
            session_id: Some("s1"),
            ref_kind: "session",
            ref_id: "s1",
            payload_hash: ph.to_string(),
        };
        assert!(crate::ledger::record_decision(&db, dec("p")).unwrap().is_some());
        assert!(crate::ledger::record_decision(&db, dec("p")).unwrap().is_none());
        assert!(db.verify_ledger_chain().unwrap().ok);
    }

    #[test]
    fn snapshot_round_trips_and_verifies() {
        let dir = std::env::temp_dir().join(format!("redline-ledger-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("live.db");
        {
            let db = Database::open(&src).unwrap();
            append(&db, "prompt", "h1");
            append(&db, "approval", "h2");
            let dest = dir.join("snap.db");
            db.snapshot_to(&dest).unwrap();
            // Reopen the snapshot independently → chain still verifies green.
            let snap = Database::open(&dest).unwrap();
            let v = snap.verify_ledger_chain().unwrap();
            assert!(v.ok);
            assert_eq!(v.checked, 2);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_review_session_and_annotations_round_trip() {
        let db = Database::open_in_memory().unwrap();

        let r = CodeReviewSession {
            review_id: "rev-1".to_string(),
            repo_path: "/proj".to_string(),
            source: "uncommitted".to_string(),
            base_ref: None,
            commit_sha: None,
            terminal_id: Some("term-1".to_string()),
            round: 1,
            created_at: 100,
        };
        db.upsert_code_review(&r).unwrap();
        assert_eq!(db.get_code_review("rev-1").unwrap().repo_path, "/proj");
        assert_eq!(db.list_code_reviews().unwrap().len(), 1);

        // Re-running in the same repo finds THIS review (round continuity),
        // and the round bump persists through the same upsert path.
        let newer = CodeReviewSession {
            round: 2,
            ..r.clone()
        };
        db.upsert_code_review(&newer).unwrap();
        let latest = db.latest_code_review_for_repo("/proj").unwrap();
        assert_eq!(latest.review_id, "rev-1");
        assert_eq!(latest.round, 2);
        assert!(db.latest_code_review_for_repo("/other").is_none());

        let a = ReviewAnnotation {
            id: "rc-001".to_string(),
            review_id: "rev-1".to_string(),
            round: 1,
            file_path: "src/main.rs".to_string(),
            side: "new".to_string(),
            start_line: 42,
            end_line: 45,
            kind: "suggestion".to_string(),
            body: "tighten this".to_string(),
            suggestion_replacement: Some("let x = y?;".to_string()),
            quoted_text: "let x = y.unwrap();".to_string(),
            status: "draft".to_string(),
            resolution: None,
            created_at: 100,
            scope: "line".to_string(),
            label: Some("nitpick".to_string()),
            blocking: Some("non-blocking".to_string()),
            source: "user".to_string(),
        };
        db.insert_review_annotation(&a).unwrap();
        let listed = db.list_review_annotations("rev-1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].suggestion_replacement.as_deref(), Some("let x = y?;"));
        assert_eq!(listed[0].quoted_text, "let x = y.unwrap();");

        // The carry-forward pass re-homes round/lines/status via update.
        let carried = ReviewAnnotation {
            round: 2,
            start_line: 50,
            end_line: 53,
            status: "carried".to_string(),
            resolution: Some("Applied the ? operator".to_string()),
            ..a.clone()
        };
        db.update_review_annotation(&carried).unwrap();
        let after = db.list_review_annotations("rev-1").unwrap();
        assert_eq!(after[0].round, 2);
        assert_eq!(after[0].start_line, 50);
        assert_eq!(after[0].status, "carried");
        assert_eq!(after[0].resolution.as_deref(), Some("Applied the ? operator"));

        // Per-file viewed tracking: mark, re-mark (upsert), unmark.
        db.mark_review_viewed("rev-1", "src/main.rs", 100).unwrap();
        db.mark_review_viewed("rev-1", "src/main.rs", 200).unwrap();
        db.mark_review_viewed("rev-1", "src/lib.rs", 100).unwrap();
        assert_eq!(
            db.list_review_viewed("rev-1").unwrap(),
            vec!["src/lib.rs".to_string(), "src/main.rs".to_string()]
        );
        db.unmark_review_viewed("rev-1", "src/lib.rs").unwrap();
        assert_eq!(db.list_review_viewed("rev-1").unwrap().len(), 1);

        // Deleting the review sweeps annotations + viewed rows with it.
        db.delete_review_annotation("rev-1", "rc-001").unwrap();
        assert!(db.list_review_annotations("rev-1").unwrap().is_empty());
        db.insert_review_annotation(&a).unwrap();
        db.delete_code_review("rev-1").unwrap();
        assert!(db.get_code_review("rev-1").is_none());
        assert!(db.list_review_annotations("rev-1").unwrap().is_empty());
        assert!(db.list_review_viewed("rev-1").unwrap().is_empty());
    }

    #[test]
    fn mission_round_trips_with_findings_thread_and_session() {
        use crate::state::{Mission, MissionFinding, MissionMessage};
        let db = Database::open_in_memory().unwrap();

        let m = Mission {
            mission_id: "m1".to_string(),
            title: "Data-breach page".to_string(),
            goal: "Draft my firm's data-breach practice page".to_string(),
            status: "active".to_string(),
            created_at: 100,
            updated_at: 100,
        };
        db.insert_mission(&m).unwrap();
        assert_eq!(db.get_mission("m1").unwrap().unwrap().goal, m.goal);
        assert_eq!(db.list_missions().unwrap().len(), 1);

        // Resumable session id lives on the row.
        assert!(db.get_mission_session("m1").is_none());
        db.set_mission_session("m1", "sess-abc").unwrap();
        assert_eq!(db.get_mission_session("m1").as_deref(), Some("sess-abc"));

        // Editing the goal bumps updated_at.
        db.update_mission_goal("m1", "Breach page", "new goal", 200).unwrap();
        let edited = db.get_mission("m1").unwrap().unwrap();
        assert_eq!(edited.goal, "new goal");
        assert_eq!(edited.updated_at, 200);

        // Tab workspace round-trips as an opaque JSON blob (and does not bump
        // updated_at).
        assert!(db.get_mission_tabs("m1").is_none());
        db.set_mission_tabs("m1", r#"[{"id":"t0","url":"https://a","browseId":"b1"}]"#)
            .unwrap();
        assert!(db.get_mission_tabs("m1").unwrap().contains("b1"));
        assert_eq!(db.get_mission("m1").unwrap().unwrap().updated_at, 200);

        // Pins: insert, list (oldest first), delete.
        let f1 = MissionFinding {
            id: "f1".to_string(),
            mission_id: "m1".to_string(),
            browse_id: Some("b1".to_string()),
            source_url: Some("https://acme.example".to_string()),
            source_title: Some("Acme".to_string()),
            body: "great tone".to_string(),
            note: Some("liked this".to_string()),
            created_at: 110,
        };
        let f2 = MissionFinding {
            id: "f2".to_string(),
            created_at: 120,
            ..f1.clone()
        };
        db.insert_finding(&f1).unwrap();
        db.insert_finding(&f2).unwrap();
        let pins = db.list_findings("m1").unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].id, "f1");
        db.delete_finding("f1").unwrap();
        assert_eq!(db.list_findings("m1").unwrap().len(), 1);

        // Orchestrator chat turns round-trip oldest-first.
        db.insert_mission_message(&MissionMessage {
            id: "msg1".to_string(),
            mission_id: "m1".to_string(),
            role: "user".to_string(),
            body: "compare the tabs".to_string(),
            status: "complete".to_string(),
            created_at: 130,
        })
        .unwrap();
        let thread = db.load_mission_thread("m1").unwrap();
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].role, "user");

        // Delete cascades: mission row + its pins + its chat all go.
        db.delete_mission("m1").unwrap();
        assert!(db.get_mission("m1").unwrap().is_none());
        assert_eq!(db.list_missions().unwrap().len(), 0);
        assert_eq!(db.list_findings("m1").unwrap().len(), 0);
        assert_eq!(db.load_mission_thread("m1").unwrap().len(), 0);
    }

    #[test]
    fn restore_flag_is_one_shot_and_persists() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";

        // Nothing to restore before any plan exists.
        assert!(store.restore_latest("s").is_none());

        // v1: a genuine plan.
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        // Arm a restore: one-shot — the second take observes nothing.
        store.arm_restore("s");
        assert!(store.take_restore("s"));
        assert!(!store.take_restore("s"));

        // The restore re-presents the plan the store already holds (cloned —
        // no body resupplied), tagged restored.
        let res = store.restore_latest("s").expect("restored");
        assert_eq!(res.version_number, 2);
        assert!(!res.is_new_session);

        let session = store.get("s").expect("session");
        assert_eq!(session.revisions.len(), 2);
        assert!(!session.revisions[0].restored);
        assert!(session.revisions[1].restored);
        // The clone is byte-for-byte the held latest revision.
        assert_eq!(
            session.revisions[1].raw_plan_markdown,
            session.revisions[0].raw_plan_markdown
        );

        // The restored flag survives a reload from the DB.
        let reloaded = SessionStore::new(db);
        let rs = reloaded.get("s").expect("reloaded session");
        assert!(!rs.revisions[0].restored);
        assert!(rs.revisions[1].restored);
    }

    #[test]
    fn attach_state_persists_and_flips_on_reload() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        for sid in ["held-s", "idle-s", "det-s"] {
            store.upsert_plan(sid, "/tmp/p", md.to_string(), reparse_sections(md), true, false);
        }
        store.set_attach_state("held-s", AttachState::Held);
        store.set_attach_state("det-s", AttachState::Detached);
        assert_eq!(store.get("held-s").unwrap().attach_state, AttachState::Held);
        assert_eq!(store.get("idle-s").unwrap().attach_state, AttachState::Idle);

        // Restart: a held POST can't survive, so Held must load as Detached —
        // in memory and on disk; the other states reload unchanged.
        let reloaded = SessionStore::new(db.clone());
        assert_eq!(
            reloaded.get("held-s").unwrap().attach_state,
            AttachState::Detached,
            "held must flip to detached across a restart"
        );
        assert_eq!(reloaded.get("idle-s").unwrap().attach_state, AttachState::Idle);
        assert_eq!(reloaded.get("det-s").unwrap().attach_state, AttachState::Detached);

        // The flip itself was persisted, not just computed in memory.
        let row: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT attach_state FROM sessions WHERE session_id = 'held-s'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(row, "detached");
    }

    #[test]
    fn add_comment_honors_explicit_id_without_perturbing_sequence() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
        let req = |id: Option<&str>| NewCommentRequest {
            id: id.map(|s| s.to_string()),
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "b".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        // Normal mint starts the c-NNN sequence.
        let a = store.add_comment("s", req(None)).unwrap();
        assert_eq!(a.id, "c-001");
        // A collaborator-minted id (never plain c-NNN) is honored verbatim…
        let b = store.add_comment("s", req(Some("c-1187249-42"))).unwrap();
        assert_eq!(b.id, "c-1187249-42");
        // …and does not perturb the owner's sequence.
        let c = store.add_comment("s", req(None)).unwrap();
        assert_eq!(c.id, "c-002");
        // Re-delivering an existing id is idempotent: the existing comment
        // comes back untouched, nothing new is minted.
        let d = store.add_comment("s", req(Some("c-001"))).unwrap();
        assert_eq!(d.id, "c-001");
        assert_eq!(d.created_at, a.created_at);
        let all = store.get("s").unwrap().revisions.last().unwrap().comments.len();
        assert_eq!(all, 3);
        // Empty string is treated as absent.
        let e = store.add_comment("s", req(Some(""))).unwrap();
        assert_eq!(e.id, "c-003");
    }

    #[test]
    fn restored_revision_carries_open_comments_forward() {
        use crate::state::{CommentKind, CommentStatus};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
        let comment = |body: &str| NewCommentRequest {
                id: None,
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: Some("rl:blk-1".to_string()),
            structural: None,
            body: body.to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        // A submitted comment (stays on v1), a reopened one and a draft (carried).
        let settled = store.add_comment("s", comment("settled")).unwrap();
        store.mark_submitted("s");
        store.reopen_resolution("s", &settled.id, Some("follow-up"), false);
        let submitted = store.add_comment("s", comment("in flight")).unwrap();
        store.mark_submitted("s");
        store.reopen_resolution("s", &settled.id, Some("follow-up"), false);
        let draft = store.add_comment("s", comment("still drafting")).unwrap();

        // Re-presented via "Restore plan session" — the store clones the body
        // it holds; no plan is resupplied.
        store.restore_latest("s").expect("restored");

        let check = |store: &SessionStore, label: &str| {
            let session = store.get("s").expect("session");
            assert_eq!(session.revisions.len(), 2, "{label}");
            let v1 = &session.revisions[0];
            let v2 = &session.revisions[1];
            // Open work moved to the restored revision (the pane shows only
            // the latest revision's comments); settled work stayed put.
            assert_eq!(
                v1.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
                vec![submitted.id.as_str()],
                "{label}: only the in-flight comment stays on v1"
            );
            let carried: Vec<&Comment> = v2.comments.iter().collect();
            assert_eq!(carried.len(), 2, "{label}");
            let reopened = carried.iter().find(|c| c.id == settled.id).unwrap();
            assert!(matches!(reopened.status, CommentStatus::Reopened), "{label}");
            assert_eq!(reopened.reopen_note.as_deref(), Some("follow-up"), "{label}");
            let moved_draft = carried.iter().find(|c| c.id == draft.id).unwrap();
            assert!(matches!(moved_draft.status, CommentStatus::Draft), "{label}");
            // Identical body → anchors resolve unchanged; nothing was rewritten.
            assert_eq!(moved_draft.anchor_id, "A", "{label}");
            assert_eq!(moved_draft.block_id.as_deref(), Some("rl:blk-1"), "{label}");
        };
        check(&store, "in memory");
        check(&SessionStore::new(db), "after reload");
    }

    #[test]
    fn delete_session_removes_memory_and_db() {
        use crate::state::{CommentKind, NewCommentRequest};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("doomed", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        store
            .add_comment(
                "doomed",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "q".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");
        store.upsert_plan("keep", "/tmp/k", md.to_string(), reparse_sections(md), true, false);
        // A staged offer against each — the doomed one must not outlive its plan.
        db.insert_comment_offer(&mk_offer("o-doomed", "doomed", 100))
            .unwrap();
        db.insert_comment_offer(&mk_offer("o-keep", "keep", 100))
            .unwrap();

        assert!(store.delete_session("doomed"));
        assert!(db.list_open_comment_offers("doomed").unwrap().is_empty());
        assert_eq!(db.list_open_comment_offers("keep").unwrap().len(), 1);
        assert!(!store.has_session("doomed"));
        assert!(store.get("doomed").is_none());
        assert!(store.has_session("keep")); // unrelated session untouched
        assert!(!store.delete_session("doomed")); // already gone → false

        // Survives a reload from the same DB (revisions + comments cascaded).
        let reloaded = SessionStore::new(db);
        assert!(reloaded.get("doomed").is_none());
        assert!(reloaded.get("keep").is_some());
    }

    #[test]
    fn rekey_session_moves_plan_and_comments_onto_the_live_id() {
        use crate::state::{CommentKind, NewCommentRequest};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Held Plan\n\nBody.\n";
        // The held plan lives under the original review session id.
        store.upsert_plan("old", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
        let draft = store
            .add_comment(
                "old",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("rl:blk-1".to_string()),
                    structural: None,
                    body: "in flight".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");

        // Restore handshake arrives under a forked/foreign id → rebind onto it.
        assert!(store.rekey_session("old", "new"));
        assert!(!store.has_session("old"));
        assert!(store.has_session("new"));

        // No-op guards: equal ids, missing source, occupied destination.
        assert!(!store.rekey_session("new", "new"));
        assert!(!store.rekey_session("missing", "new2"));
        store.upsert_plan("occupied", "/tmp/o", md.to_string(), reparse_sections(md), true, false);
        assert!(!store.rekey_session("new", "occupied"));

        let check = |store: &SessionStore, label: &str| {
            let s = store.get("new").expect("session under new id");
            assert_eq!(s.session_id, "new", "{label}");
            assert_eq!(s.revisions.len(), 1, "{label}");
            assert_eq!(s.revisions[0].raw_plan_markdown, md, "{label}");
            // The reviewer's open comment rode along with the session.
            let c = &s.revisions[0].comments;
            assert_eq!(c.len(), 1, "{label}");
            assert_eq!(c[0].id, draft.id, "{label}");
        };
        check(&store, "in memory");

        // Survives a reload — the DB rows moved, not just the in-memory map.
        let reloaded = SessionStore::new(db);
        assert!(reloaded.get("old").is_none());
        check(&reloaded, "after reload");

        // And the held plan now restores cleanly under the live id.
        let restored = store.restore_latest("new").expect("restore under new id");
        assert_eq!(restored.version_number, 2);
    }

    // Mirrors the `handle_plan` thread-classification predicate:
    // a plan answers feedback iff it carries resolutions OR a submit_review
    // denial is still outstanding. This pins the `has_outstanding_review`
    // half (the resolutions half is exercised by the round-trip test).
    #[test]
    fn outstanding_review_drives_thread_classification() {
        use crate::state::{CommentKind, SessionStatus};
        let store = make_store();
        let md = "# Plan\n\nBody.\n";

        // Missing session → not outstanding (first plan starts a fresh thread).
        assert!(!store.has_outstanding_review("sess-c"));

        store.upsert_plan("sess-c", "/tmp/c", md.to_string(), reparse_sections(md), true, false);
        // v1 received, no comments yet → nothing outstanding.
        assert!(!store.has_outstanding_review("sess-c"));

        store
            .add_comment(
                "sess-c",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");
        // Draft only — the reviewer hasn't submitted; next plan is still fresh.
        assert!(!store.has_outstanding_review("sess-c"));

        store.mark_submitted("sess-c");
        // Submitted + InReview → the next inbound plan is a revision.
        assert!(store.has_outstanding_review("sess-c"));

        store.set_status("sess-c", SessionStatus::Approved);
        // Approved → a subsequent plan in the same terminal is a fresh thread.
        assert!(!store.has_outstanding_review("sess-c"));
    }

    #[test]
    fn add_and_retrieve_comments() {
        let store = make_store();
        let sections = reparse_sections("# A\n\nIntro paragraph.\n");
        store.upsert_plan("sess-1", "/tmp/proj", "# A\n\nIntro paragraph.\n".to_string(), sections, true, false);

        let req = NewCommentRequest {
                id: None,
            kind: CommentKind::Feedback,
            scope: Some(CommentScope::Structural),
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "rethink this entire section".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        let c1 = store.add_comment("sess-1", req).expect("add");
        assert_eq!(c1.id, "c-001");
        assert!(matches!(c1.kind, CommentKind::Feedback));
        assert!(matches!(c1.scope, Some(CommentScope::Structural)));

        let req2 = NewCommentRequest {
                id: None,
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "why?".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        let c2 = store.add_comment("sess-1", req2).expect("add 2");
        assert_eq!(c2.id, "c-002");
        assert!(c2.scope.is_none());

        let session = store.get("sess-1").expect("get session");
        assert_eq!(session.revisions[0].comments.len(), 2);
    }

    // Agent-in-doc (M4): `author` and `agent_state` survive insert → reload,
    // and `set_agent_state` refuses comments that aren't agent-authored.
    #[test]
    fn agent_author_and_state_round_trip() {
        use crate::state::{CommentKind, EditPayload};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# A\n\nIntro paragraph.\n";
        store.upsert_plan("sess-a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);

        let agent = store
            .add_comment(
                "sess-a",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Edit,
                    scope: None,
                    anchor_id: "A.p1".to_string(),
                    block_id: Some("blk-1".to_string()),
                    structural: None,
                    body: "(edit)".to_string(),
                    edit: Some(EditPayload {
                        original: "Intro paragraph.".to_string(),
                        revised: "Intro sentence.".to_string(),
                    }),
                    selection: None,
                    author: Some("claude-code".to_string()),
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add agent comment");
        assert_eq!(agent.author.as_deref(), Some("claude-code"));
        assert!(agent.agent_state.is_none());

        let user = store
            .add_comment(
                "sess-a",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add user comment");

        assert!(store.set_agent_state("sess-a", &agent.id, Some("accepted".to_string())));
        // Not agent-authored → refused.
        assert!(!store.set_agent_state("sess-a", &user.id, Some("accepted".to_string())));
        // Unknown comment → refused.
        assert!(!store.set_agent_state("sess-a", "c-999", Some("accepted".to_string())));

        let reloaded = SessionStore::new(db);
        let s = reloaded.get("sess-a").expect("session");
        let rc = &s.revisions[0].comments[0];
        assert_eq!(rc.author.as_deref(), Some("claude-code"));
        assert_eq!(rc.agent_state.as_deref(), Some("accepted"));
        let ru = &s.revisions[0].comments[1];
        assert!(ru.author.is_none());
        assert!(ru.agent_state.is_none());
    }

    // Review Request / live-collab attribution: `reviewer` survives insert →
    // reload and stays None for owner-originated comments.
    #[test]
    fn reviewer_attribution_round_trips() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("sess-r", "/tmp/r", md.to_string(), reparse_sections(md), true, false);
        let mk = |reviewer: Option<&str>| NewCommentRequest {
            id: None,
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: Some("blk-1".to_string()),
            structural: None,
            body: "from a return".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: reviewer.map(|s| s.to_string()),
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        let imported = store
            .add_comment("sess-r", mk(Some("John Doe")))
            .expect("add imported comment");
        assert_eq!(imported.reviewer.as_deref(), Some("John Doe"));
        let own = store.add_comment("sess-r", mk(None)).expect("add own comment");
        assert!(own.reviewer.is_none());

        let reloaded = SessionStore::new(db);
        let s = reloaded.get("sess-r").expect("session");
        assert_eq!(
            s.revisions[0].comments[0].reviewer.as_deref(),
            Some("John Doe")
        );
        assert!(s.revisions[0].comments[1].reviewer.is_none());
    }

    // Return provenance: `external_created_at` + `share_request_id` survive
    // insert → reload and stay None for owner-originated comments.
    #[test]
    fn comment_attachments_round_trip_and_survive_a_rekey() {
        use crate::state::{CommentAttachment, CommentKind};
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("old-sid", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
        let att = CommentAttachment {
            path: "/data/attachments/old-sid/ui-mock.png".to_string(),
            name: "ui-mock.png".to_string(),
            mime: "image/png".to_string(),
            bytes: 4096,
        };
        let with_files = store
            .add_comment(
                "old-sid",
                NewCommentRequest {
                    id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("blk-1".to_string()),
                    structural: None,
                    body: "make it look like this".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: vec![att.clone()],
                },
            )
            .expect("add comment with an attachment");
        assert_eq!(with_files.attachments, vec![att.clone()]);

        // A comment with no files stores NULL, not "[]" — the pre-attachment
        // shape is preserved exactly.
        let plain = store
            .add_comment(
                "old-sid",
                NewCommentRequest {
                    id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: Some("blk-1".to_string()),
                    structural: None,
                    body: "just words".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add plain comment");
        assert!(plain.attachments.is_empty());

        // Survives a reload (the column round-trips).
        let reloaded = SessionStore::new(db.clone());
        let s = reloaded.get("old-sid").expect("session");
        let rc = s.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == with_files.id)
            .expect("comment");
        assert_eq!(rc.attachments, vec![att]);

        // A restore handshake re-keys the session; the stored paths must follow
        // the directory, or the payload would name a file that isn't there.
        assert!(reloaded.rekey_session("old-sid", "new-sid"));
        let moved = reloaded.get("new-sid").expect("rekeyed session");
        let mc = moved.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == with_files.id)
            .expect("comment");
        assert_eq!(
            mc.attachments[0].path,
            "/data/attachments/new-sid/ui-mock.png",
            "in-memory path follows the rekey"
        );
        let after = SessionStore::new(db);
        let dc = after.get("new-sid").expect("session after reload");
        assert_eq!(
            dc.revisions[0]
                .comments
                .iter()
                .find(|c| c.id == with_files.id)
                .expect("comment")
                .attachments[0]
                .path,
            "/data/attachments/new-sid/ui-mock.png",
            "the persisted path follows it too"
        );
    }

    #[test]
    fn return_provenance_round_trips() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("sess-p", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
        let mk = |prov: bool| NewCommentRequest {
            id: None,
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: Some("blk-1".to_string()),
            structural: None,
            body: "from a return".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: prov.then(|| "John Doe".to_string()),
            external_created_at: prov.then_some(1_700_000_100_000),
            share_request_id: prov.then(|| "req-abc123".to_string()),
            attachments: Vec::new(),
        };
        let imported = store
            .add_comment("sess-p", mk(true))
            .expect("add imported comment");
        assert_eq!(imported.external_created_at, Some(1_700_000_100_000));
        assert_eq!(imported.share_request_id.as_deref(), Some("req-abc123"));
        let own = store.add_comment("sess-p", mk(false)).expect("add own comment");
        assert!(own.external_created_at.is_none());
        assert!(own.share_request_id.is_none());

        let reloaded = SessionStore::new(db);
        let s = reloaded.get("sess-p").expect("session");
        let rc = &s.revisions[0].comments[0];
        assert_eq!(rc.external_created_at, Some(1_700_000_100_000));
        assert_eq!(rc.share_request_id.as_deref(), Some("req-abc123"));
        let ro = &s.revisions[0].comments[1];
        assert!(ro.external_created_at.is_none());
        assert!(ro.share_request_id.is_none());
    }

    // Shares/returns registry (IV.2): record → list round-trips, session
    // scoping holds, and deleting a share leaves its returns intact.
    #[test]
    fn shares_and_returns_registry_round_trips() {
        let db = Database::open_in_memory().unwrap();
        let share = |req: &str, sess: &str, at: i64| ShareRecord {
            request_id: req.to_string(),
            session_id: sess.to_string(),
            reviewer_name: "Jordan".to_string(),
            note: "please look at §2".to_string(),
            base_version: 3,
            created_at: at,
        };
        db.record_share(&share("req-1", "sess-a", 100)).unwrap();
        db.record_share(&share("req-2", "sess-a", 200)).unwrap();
        db.record_share(&share("req-3", "sess-b", 300)).unwrap();

        let listed = db.list_shares("sess-a").unwrap();
        assert_eq!(listed.len(), 2);
        // Newest first.
        assert_eq!(listed[0].request_id, "req-2");
        assert_eq!(listed[1].request_id, "req-1");
        assert_eq!(listed[1].note, "please look at §2");
        assert_eq!(listed[1].base_version, 3);

        let ret = ShareReturnRecord {
            id: "ret-1".to_string(),
            request_id: "req-1".to_string(),
            session_id: "sess-a".to_string(),
            reviewer_name: "Jordan".to_string(),
            imported_at: 400,
            landed_version: 5,
            placed: 2,
            orphans: 1,
            comment_ids: vec!["c-004".to_string(), "c-005".to_string()],
        };
        db.record_share_return(&ret).unwrap();
        let returns = db.list_share_returns("sess-a").unwrap();
        assert_eq!(returns.len(), 1);
        assert_eq!(returns[0].landed_version, 5);
        assert_eq!(returns[0].comment_ids, vec!["c-004", "c-005"]);
        assert!(db.list_share_returns("sess-b").unwrap().is_empty());

        // Forgetting the share keeps the imported history.
        db.delete_share("req-1").unwrap();
        assert_eq!(db.list_shares("sess-a").unwrap().len(), 1);
        assert_eq!(db.list_share_returns("sess-a").unwrap().len(), 1);
    }

    #[test]
    fn thread_messages_round_trip_and_ordering() {
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str, role: &str, body: &str, at: i64| ThreadMessage {
            id: id.to_string(),
            session_id: "s1".to_string(),
            comment_id: "c-001".to_string(),
            role: role.to_string(),
            body: body.to_string(),
            status: "complete".to_string(),
            created_at: at,
            attachments: Vec::new(),
        };
        // Inserted out of order — load_thread must return them by created_at.
        db.insert_thread_message(&mk("m2", "assistant", "second", 200))
            .unwrap();
        db.insert_thread_message(&mk("m1", "user", "first", 100))
            .unwrap();
        // A message on a different comment must not leak into this thread.
        db.insert_thread_message(&ThreadMessage {
            comment_id: "c-002".to_string(),
            ..mk("m3", "user", "other", 150)
        })
        .unwrap();

        let thread = db.load_thread("s1", "c-001").unwrap();
        assert_eq!(
            thread.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"],
        );
        assert_eq!(thread[0].body, "first");
        assert_eq!(thread[1].role, "assistant");

        db.delete_thread("s1", "c-001").unwrap();
        assert!(db.load_thread("s1", "c-001").unwrap().is_empty());
        // The scoped delete left the other comment's message intact.
        assert_eq!(db.load_thread("s1", "c-002").unwrap().len(), 1);
    }

    #[test]
    fn voice_fork_session_round_trip_and_is_known() {
        let db = Database::open_in_memory().unwrap();
        // No memory yet → re-entry would fork fresh.
        assert!(db.get_voice_fork_session("plan-1").is_none());
        assert!(!db.is_known_fork_session("voice-xyz"));

        // First turn persists the fork id; re-entry resumes the same id.
        db.set_voice_fork_session("plan-1", "voice-xyz").unwrap();
        assert_eq!(
            db.get_voice_fork_session("plan-1").as_deref(),
            Some("voice-xyz"),
        );
        // A stray ExitPlanMode from the voice fork is recognized and ignored.
        assert!(db.is_known_fork_session("voice-xyz"));

        // Upsert replaces (e.g. a revision keeps one thread under a new id).
        db.set_voice_fork_session("plan-1", "voice-2").unwrap();
        assert_eq!(
            db.get_voice_fork_session("plan-1").as_deref(),
            Some("voice-2"),
        );

        db.clear_voice_fork_session("plan-1").unwrap();
        assert!(db.get_voice_fork_session("plan-1").is_none());
        assert!(!db.is_known_fork_session("voice-2"));
    }

    #[test]
    fn voice_messages_round_trip_and_are_scoped_per_key() {
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str, key: &str, role: &str, text: &str, at: i64| VoiceMessage {
            id: id.to_string(),
            session_key: key.to_string(),
            role: role.to_string(),
            text: text.to_string(),
            created_at: at,
        };
        assert!(db.list_voice_messages("plan-1").unwrap().is_empty());

        // Inserted out of order — the read must come back oldest-first, which is
        // the order the panel replays them in.
        db.insert_voice_message(&mk("v2", "plan-1", "agent", "second", 200))
            .unwrap();
        db.insert_voice_message(&mk("v1", "plan-1", "you", "first", 100))
            .unwrap();
        db.insert_voice_message(&mk("v3", "plan-1", "note", "▶ Read the plan", 300))
            .unwrap();
        // A different voice key (here a drafter session) must not leak in.
        db.insert_voice_message(&mk("v4", "drafter:d-9", "you", "other", 150))
            .unwrap();

        let thread = db.list_voice_messages("plan-1").unwrap();
        assert_eq!(
            thread.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["v1", "v2", "v3"],
        );
        assert_eq!(thread[0].role, "you");
        assert_eq!(thread[0].text, "first");
        assert_eq!(thread[2].role, "note", "markers are part of the transcript");
        assert_eq!(db.list_voice_messages("drafter:d-9").unwrap().len(), 1);

        // "Forget" is a true reset for this key only.
        db.clear_voice_messages("plan-1").unwrap();
        assert!(db.list_voice_messages("plan-1").unwrap().is_empty());
        assert_eq!(db.list_voice_messages("drafter:d-9").unwrap().len(), 1);
    }

    fn mk_offer(id: &str, session: &str, at: i64) -> CommentOffer {
        CommentOffer {
            id: id.to_string(),
            session_id: session.to_string(),
            message_id: None,
            block_id: "rl:blk-abc".to_string(),
            body: "Make the retry budget configurable".to_string(),
            label: Some("Configurable retry budget".to_string()),
            agent_id: "voice".to_string(),
            status: "pending".to_string(),
            created_at: at,
            stale: false,
        }
    }

    #[test]
    fn comment_offers_round_trip_and_are_scoped_per_session() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.list_open_comment_offers("plan-1").unwrap().is_empty());

        db.insert_comment_offer(&mk_offer("o2", "plan-1", 200)).unwrap();
        db.insert_comment_offer(&mk_offer("o1", "plan-1", 100)).unwrap();
        db.insert_comment_offer(&mk_offer("o3", "plan-2", 150)).unwrap();

        let open = db.list_open_comment_offers("plan-1").unwrap();
        assert_eq!(
            open.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            vec!["o1", "o2"],
            "oldest-first, and another session's offers never leak in",
        );
        assert_eq!(open[0].label.as_deref(), Some("Configurable retry budget"));
        assert!(open[0].message_id.is_none(), "unbound until the reply lands");
        assert!(!open[0].stale, "staleness is computed on read, never stored");

        let one = db.get_comment_offer("o1").unwrap().unwrap();
        assert_eq!(one.body, "Make the retry budget configurable");
        assert!(db.get_comment_offer("nope").unwrap().is_none());

        // Dismissal takes a row out of the open list without deleting it.
        assert!(db.resolve_comment_offer("o2", "dismissed").unwrap());
        assert!(
            !db.resolve_comment_offer("o2", "dismissed").unwrap(),
            "only a pending row transitions",
        );
        assert_eq!(db.list_open_comment_offers("plan-1").unwrap().len(), 1);

        // Scoped wipe, for `voice_forget`.
        db.clear_comment_offers("plan-1").unwrap();
        assert!(db.list_open_comment_offers("plan-1").unwrap().is_empty());
        assert_eq!(db.list_open_comment_offers("plan-2").unwrap().len(), 1);
    }

    #[test]
    fn bind_comment_offers_respects_the_you_line_floor() {
        let db = Database::open_in_memory().unwrap();
        let you = |id: &str, at: i64| VoiceMessage {
            id: id.to_string(),
            session_key: "plan-1".to_string(),
            role: "you".to_string(),
            text: "…".to_string(),
            created_at: at,
        };
        // Turn 1 asked at t=100 and staged an offer; turn 2 asked at t=300.
        db.insert_voice_message(&you("y1", 100)).unwrap();
        db.insert_comment_offer(&mk_offer("old", "plan-1", 150)).unwrap();
        db.insert_voice_message(&you("y2", 300)).unwrap();
        db.insert_comment_offer(&mk_offer("new", "plan-1", 350)).unwrap();

        assert_eq!(db.count_open_offers_this_turn("plan-1").unwrap(), 1);
        assert_eq!(db.bind_comment_offers("plan-1", "msg-2").unwrap(), 1);
        assert_eq!(
            db.get_comment_offer("new").unwrap().unwrap().message_id.as_deref(),
            Some("msg-2"),
        );
        assert!(
            db.get_comment_offer("old").unwrap().unwrap().message_id.is_none(),
            "a turn that errored out leaves its offer loose, not mis-attributed",
        );
        // Already-bound rows are skipped by the next turn's bind.
        db.insert_voice_message(&you("y3", 500)).unwrap();
        assert_eq!(db.bind_comment_offers("plan-1", "msg-3").unwrap(), 0);
        assert_eq!(
            db.get_comment_offer("new").unwrap().unwrap().message_id.as_deref(),
            Some("msg-2"),
        );
        // Bound rows also stop counting against the per-turn cap.
        assert_eq!(db.count_open_offers_this_turn("plan-1").unwrap(), 0);
    }

    #[test]
    fn claiming_an_offer_is_a_compare_and_set() {
        let db = Database::open_in_memory().unwrap();
        db.insert_comment_offer(&mk_offer("o1", "plan-1", 100)).unwrap();

        assert!(db.claim_comment_offer("o1").unwrap());
        assert!(
            !db.claim_comment_offer("o1").unwrap(),
            "a double-tap must not write two comments",
        );
        assert!(db.list_open_comment_offers("plan-1").unwrap().is_empty());

        // A failed write puts the chip back.
        db.release_comment_offer("o1").unwrap();
        assert_eq!(db.list_open_comment_offers("plan-1").unwrap().len(), 1);
        assert!(db.claim_comment_offer("o1").unwrap());
    }

    #[test]
    fn deleting_comment_cascades_its_thread() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s1", "/tmp/x", md.to_string(), reparse_sections(md), true, false);
        let mk_q = || NewCommentRequest {
                id: None,
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: "why?".to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        store.add_comment("s1", mk_q()).expect("add comment");
        let db = store.database();
        db.insert_thread_message(&ThreadMessage {
            id: "m1".to_string(),
            session_id: "s1".to_string(),
            comment_id: "c-001".to_string(),
            role: "assistant".to_string(),
            body: "old answer".to_string(),
            status: "complete".to_string(),
            created_at: 100,
            attachments: Vec::new(),
        })
        .unwrap();

        store.delete_comment("s1", "c-001");
        assert!(db.load_thread("s1", "c-001").unwrap().is_empty());

        // A new comment reuses the id `c-001` — it must start with an empty
        // thread, not resurface the deleted comment's answer.
        let reused = store.add_comment("s1", mk_q()).expect("re-add comment");
        assert_eq!(reused.id, "c-001");
        assert!(db.load_thread("s1", "c-001").unwrap().is_empty());
    }

    #[test]
    fn comment_fork_session_set_get_clear() {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s-fork", "/tmp/f", md.to_string(), reparse_sections(md), true, false);
        store
            .add_comment(
                "s-fork",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "why?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");
        let db = store.database();

        // Fresh comment: no fork yet.
        assert!(db.get_comment_fork("s-fork", "c-001").is_none());
        assert!(!db.is_known_fork_session("fork-xyz"));

        db.set_comment_fork("s-fork", "c-001", "fork-xyz", "claude-code")
            .unwrap();
        assert_eq!(
            db.get_comment_fork("s-fork", "c-001"),
            Some(("fork-xyz".to_string(), "claude-code".to_string())),
        );
        assert!(db.is_known_fork_session("fork-xyz"));

        // Provenance survives a re-fork onto the other harness, and the pair
        // moves together — a stale backend beside a fresh id is the bug this
        // column exists to prevent.
        db.set_comment_fork("s-fork", "c-001", "thr-codex", "codex")
            .unwrap();
        assert_eq!(
            db.get_comment_fork("s-fork", "c-001"),
            Some(("thr-codex".to_string(), "codex".to_string())),
        );

        // A legacy row — fork id written before the backend column existed —
        // reads as Claude rather than as "unknown".
        {
            let conn = db.lock_conn();
            conn.execute(
                "UPDATE comments SET fork_backend = NULL
                 WHERE session_id = 's-fork' AND id = 'c-001'",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            db.get_comment_fork("s-fork", "c-001"),
            Some(("thr-codex".to_string(), "claude-code".to_string())),
        );

        db.clear_comment_fork("s-fork", "c-001").unwrap();
        assert!(db.get_comment_fork("s-fork", "c-001").is_none());
        assert!(!db.is_known_fork_session("fork-xyz"));
        // Both halves went, not just the id.
        let leftover: Option<String> = {
            let conn = db.lock_conn();
            conn.query_row(
                "SELECT fork_backend FROM comments WHERE session_id = 's-fork' AND id = 'c-001'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(leftover, None, "clear must null the backend too");
    }

    #[test]
    fn attach_discussion_matrix_and_rider_consumption() {
        use std::collections::HashMap;

        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s-disc", "/tmp/d", md.to_string(), reparse_sections(md), true, false);
        for (kind, body) in [
            (CommentKind::Question, "Should we ship Beta?"),
            (CommentKind::Feedback, "Beta needs a rollback story."),
        ] {
            store
                .add_comment(
                    "s-disc",
                    NewCommentRequest {
                id: None,
                        kind,
                        scope: None,
                        anchor_id: "A".to_string(),
                        block_id: None,
                        structural: None,
                        body: body.to_string(),
                        edit: None,
                        selection: None,
                        author: None,
                        reviewer: None,
                        external_created_at: None,
                        share_request_id: None,
                        attachments: Vec::new(),
                    },
                )
                .expect("add comment");
        }
        let get = |id: &str| {
            store
                .get("s-disc")
                .unwrap()
                .revisions
                .into_iter()
                .flat_map(|r| r.comments)
                .find(|c| c.id == id)
                .unwrap()
        };

        // Draft + as_change: rider set in place, question promoted, status
        // unchanged (the rider rides with the next submit).
        store
            .attach_discussion("s-disc", "c-001", Some("Decision: yes."), true)
            .expect("draft attach");
        let q = get("c-001");
        assert!(matches!(q.status, CommentStatus::Draft));
        assert_eq!(q.reopen_note.as_deref(), Some("Decision: yes."));
        assert!(q.actionable);

        // Blank note detaches the rider and demotes the draft question.
        store
            .attach_discussion("s-disc", "c-001", None, false)
            .expect("detach");
        let q = get("c-001");
        assert!(matches!(q.status, CommentStatus::Draft));
        assert_eq!(q.reopen_note, None);
        assert!(!q.actionable);

        // Feedback rider attaches without promotion, then the batch goes out:
        // attaching to an in-flight comment is rejected.
        store
            .attach_discussion("s-disc", "c-002", Some("Claude: flag + revert."), false)
            .expect("feedback attach");
        store.mark_submitted("s-disc");
        assert!(store
            .attach_discussion("s-disc", "c-002", Some("late"), false)
            .is_err());

        // Resolution arrives: the draft rider is consumed with NO history
        // entry (there was no prior resolution to archive).
        let mut res = HashMap::new();
        res.insert("c-002".to_string(), "Added the rollback section.".to_string());
        store.attach_resolutions("s-disc", &res, 2);
        let f = get("c-002");
        assert!(matches!(f.status, CommentStatus::Resolved));
        assert_eq!(f.reopen_note, None);
        assert!(f.reopen_history.is_empty());
        assert_eq!(f.resolution.as_ref().unwrap().body, "Added the rollback section.");

        // Post-resolution attach delegates to the reopen path.
        store
            .attach_discussion("s-disc", "c-002", Some("Not quite — see §A."), false)
            .expect("post-resolution attach");
        let f = get("c-002");
        assert!(matches!(f.status, CommentStatus::Reopened));
        assert_eq!(f.reopen_note.as_deref(), Some("Not quite — see §A."));
        assert!(f.resolution.is_some());
    }

    #[test]
    fn attach_resolutions_archives_round_for_submitted_reopen() {
        // Production flow: a reopened comment is flipped to Submitted by
        // mark_submitted BEFORE Claude's next plan attaches the re-resolution.
        // The archive must key on the prior resolution, not on `Reopened`.
        use std::collections::HashMap;

        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s-arch", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
        store
            .add_comment(
                "s-arch",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Tighten this.".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");
        store.mark_submitted("s-arch");
        let mut r1 = HashMap::new();
        r1.insert("c-001".to_string(), "Tightened.".to_string());
        store.attach_resolutions("s-arch", &r1, 2);
        assert!(store.reopen_resolution("s-arch", "c-001", Some("Go further."), false));
        store.mark_submitted("s-arch"); // reopened → submitted, as in the real flow
        let mut r2 = HashMap::new();
        r2.insert("c-001".to_string(), "Cut it to one line.".to_string());
        store.attach_resolutions("s-arch", &r2, 3);

        let c = store
            .get("s-arch")
            .unwrap()
            .revisions
            .into_iter()
            .flat_map(|r| r.comments)
            .find(|c| c.id == "c-001")
            .unwrap();
        assert!(matches!(c.status, CommentStatus::Resolved));
        assert_eq!(c.resolution.as_ref().unwrap().body, "Cut it to one line.");
        assert_eq!(c.reopen_note, None);
        assert_eq!(c.reopen_history.len(), 1);
        assert_eq!(c.reopen_history[0].resolution_body, "Tightened.");
        assert_eq!(c.reopen_history[0].reopen_note.as_deref(), Some("Go further."));
    }

    #[test]
    fn full_round_trip_state_machine() {
        use crate::feedback::serialize_revise_payload;
        use crate::resolutions::extract_resolutions;
        use crate::state::CommentScope;
        use std::collections::HashMap;

        let store = make_store();

        // v1 arrives
        let v1_md = "# Plan\n\nIntro paragraph.\n\n## Detail\n\nDetailed body.\n";
        store.upsert_plan(
            "sess-rt",
            "/tmp/proj",
            v1_md.to_string(),
            reparse_sections(v1_md),
            true,
            false,
        );

        // Reviewer adds two comments
        store.add_comment(
            "sess-rt",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Feedback,
                scope: Some(CommentScope::Structural),
                anchor_id: "A.1".to_string(),
                block_id: None,
                structural: None,
                body: "Rethink the detail section.".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
            },
        )
        .expect("add comment");
        store.add_comment(
            "sess-rt",
            NewCommentRequest {
                id: None,
                kind: CommentKind::Question,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                structural: None,
                body: "Why this order?".to_string(),
                edit: None,
                selection: None,
                author: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
            },
        )
        .expect("add comment");

        // Build the feedback payload and submit
        let (sections, draft_comments, body_markdown) = store
            .drafts_and_reopens_for_payload("sess-rt")
            .expect("session exists");
        assert_eq!(draft_comments.len(), 2);
        let payload = serialize_revise_payload(&sections, &draft_comments, &body_markdown);
        assert!(payload.contains("\"c-001\":"));
        assert!(payload.contains("\"c-002\":"));

        let submitted = store.mark_submitted("sess-rt");
        assert_eq!(submitted.len(), 2);

        // Verify comments are now submitted
        let session = store.get("sess-rt").unwrap();
        for c in session.revisions[0].comments.iter() {
            assert!(matches!(c.status, CommentStatus::Submitted));
        }

        // v2 arrives with REDLINE_RESOLUTIONS
        let v2_md = r#"<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Restructured §A.1 to address the concern.",
  "c-002": "Reordered for clarity."
}
-->

# Plan v2

Refined intro.

## Detail

Restructured detail body.
"#;
        let extracted = extract_resolutions(v2_md);
        assert!(extracted.parse_error.is_none());
        assert_eq!(extracted.resolutions.len(), 2);

        let stripped = extracted.stripped_markdown.clone();
        let v2_sections = reparse_sections(&stripped);
        let report: HashMap<_, _> = extracted.resolutions.into_iter().collect();
        let attach_report = store.attach_resolutions("sess-rt", &report, 2);
        store.upsert_plan("sess-rt", "/tmp/proj", stripped, v2_sections, false, false);

        assert!(attach_report.unmatched_ids.is_empty());
        assert!(attach_report.unresolved_submitted_ids.is_empty());

        // v1 comments should now be resolved with attached bodies
        let session = store.get("sess-rt").unwrap();
        let c1 = session.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == "c-001")
            .unwrap();
        assert!(matches!(c1.status, CommentStatus::Resolved));
        let res1 = c1.resolution.as_ref().expect("resolution attached");
        assert!(res1.body.contains("Restructured"));
        assert_eq!(res1.appeared_in_version, 2);

        // Accept c-001, reopen c-002 with a follow-up note
        assert!(store.accept_resolution("sess-rt", "c-001"));
        assert!(store.reopen_resolution("sess-rt", "c-002", Some("still wrong — see §B"), false));

        let session = store.get("sess-rt").unwrap();
        let c1 = session.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == "c-001")
            .unwrap();
        assert!(matches!(c1.status, CommentStatus::Accepted));
        assert!(c1.resolution.as_ref().unwrap().accepted_at.is_some());

        let c2 = session.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == "c-002")
            .unwrap();
        assert!(matches!(c2.status, CommentStatus::Reopened));
        // The note rode through the DB round-trip; the prior resolution stays
        // attached (continuity) but is no longer accepted.
        assert_eq!(c2.reopen_note.as_deref(), Some("still wrong — see §B"));
        assert!(c2.resolution.is_some());
        assert!(c2.resolution.as_ref().unwrap().accepted_at.is_none());

        // Submitting again should include the reopened c-002 but not the accepted c-001
        let (_, comments_for_round_2, _) = store
            .drafts_and_reopens_for_payload("sess-rt")
            .expect("session exists");
        let ids: Vec<&str> = comments_for_round_2.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["c-002"]);

        // Claude re-resolves the reopened comment: the round is archived to
        // history and the consumed note is cleared.
        let mut round2 = HashMap::new();
        round2.insert("c-002".to_string(), "Now fixed in v3.".to_string());
        store.attach_resolutions("sess-rt", &round2, 3);

        let session = store.get("sess-rt").unwrap();
        let c2 = session.revisions[0]
            .comments
            .iter()
            .find(|c| c.id == "c-002")
            .unwrap();
        assert!(matches!(c2.status, CommentStatus::Resolved));
        assert_eq!(c2.reopen_note, None);
        assert_eq!(c2.resolution.as_ref().unwrap().body, "Now fixed in v3.");
        assert_eq!(c2.reopen_history.len(), 1);
        assert_eq!(
            c2.reopen_history[0].reopen_note.as_deref(),
            Some("still wrong — see §B")
        );
    }

    #[test]
    fn ask_round_trip_attaches_resolutions_without_version_bump() {
        // Mirrors handle_plan's Ask path: prior submit was an all-question
        // batch, Claude returned the same plan with answers in the
        // resolution sidecar. The store side of that path must attach
        // resolutions to the CURRENT revision (appeared_in_version =
        // latest, not next) and NOT upsert a new revision row.
        use crate::resolutions::extract_resolutions;
        use std::collections::HashMap;

        let store = make_store();

        let v1_md = "# Plan\n\nIntro paragraph.\n\n# Beta\n\nbody.\n";
        store.upsert_plan(
            "sess-ask",
            "/tmp/proj",
            v1_md.to_string(),
            reparse_sections(v1_md),
            true,
            false,
        );

        store
            .add_comment(
                "sess-ask",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Why this order?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add q1");
        store
            .add_comment(
                "sess-ask",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "B".to_string(),
                    block_id: None,
                    structural: None,
                    body: "Why is Beta last?".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add q2");

        store.mark_submitted("sess-ask");

        // Ask round-trip: Claude returns the plan body unchanged + answers.
        let same_md_with_answers = r#"<!-- REDLINE_RESOLUTIONS
{
  "c-001": "Alphabetical, no narrative reason.",
  "c-002": "Same — alphabetical."
}
-->

# Plan

Intro paragraph.

# Beta

body.
"#;
        let extracted = extract_resolutions(same_md_with_answers);
        assert!(extracted.parse_error.is_none());
        assert_eq!(extracted.resolutions.len(), 2);

        // The current latest version is 1 — Ask path uses that, not 2.
        let latest_version = store
            .get("sess-ask")
            .and_then(|s| s.revisions.last().map(|r| r.version_number))
            .unwrap();
        assert_eq!(latest_version, 1);

        let report: HashMap<_, _> = extracted.resolutions.into_iter().collect();
        let attach_report = store.attach_resolutions("sess-ask", &report, latest_version);

        // Crucially: NO upsert_plan call here. The Ask path keeps the
        // same revision row.
        assert!(attach_report.unmatched_ids.is_empty());
        assert!(attach_report.unresolved_submitted_ids.is_empty());

        let session = store.get("sess-ask").unwrap();
        assert_eq!(
            session.revisions.len(),
            1,
            "Ask round-trip must not create a new revision"
        );

        for id in ["c-001", "c-002"] {
            let c = session.revisions[0]
                .comments
                .iter()
                .find(|c| c.id == id)
                .unwrap();
            assert!(matches!(c.status, CommentStatus::Resolved));
            let res = c.resolution.as_ref().expect("resolution attached");
            assert_eq!(
                res.appeared_in_version, 1,
                "answers belong to the current (unchanged) revision"
            );
        }

        // has_outstanding_review flips false now that all questions
        // resolved — a subsequent unrelated plan would correctly classify
        // as a thread_start.
        assert!(!store.has_outstanding_review("sess-ask"));
    }

    #[test]
    fn interception_mode_setting_persists() {
        use crate::state::InterceptionMode;

        let tmpfile = tempfile_path();
        {
            let db = Database::open(&tmpfile).unwrap();
            assert!(db.get_setting("interception_mode").is_none());
            db.set_setting("interception_mode", InterceptionMode::Ambient.as_str())
                .unwrap();
            // Overwrite to confirm upsert semantics.
            db.set_setting("interception_mode", InterceptionMode::Paused.as_str())
                .unwrap();
        }
        let db2 = Database::open(&tmpfile).unwrap();
        let restored = db2
            .get_setting("interception_mode")
            .and_then(|s| InterceptionMode::from_str(&s));
        assert!(matches!(restored, Some(InterceptionMode::Paused)));
        let _ = std::fs::remove_file(&tmpfile);
    }

    #[test]
    fn persistence_survives_restart() {
        let tmpfile = tempfile_path();
        {
            let db = Arc::new(Database::open(&tmpfile).unwrap());
            let store = SessionStore::new(db);
            let md = "# Title\n\nBody.\n";
            store.upsert_plan("sess-x", "/tmp/p", md.to_string(), reparse_sections(md), true, false);
            store.add_comment(
                "sess-x",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Edit,
                    scope: None,
                    anchor_id: "A.p1".to_string(),
                    block_id: None,
                    structural: None,
                    body: "swap wording".to_string(),
                    edit: Some(EditPayload {
                        original: "Body.".to_string(),
                        revised: "Substance.".to_string(),
                    }),
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add comment");
        }
        let db2 = Arc::new(Database::open(&tmpfile).unwrap());
        let store2 = SessionStore::new(db2);
        let session = store2.get("sess-x").expect("session reloaded");
        assert_eq!(session.revisions.len(), 1);
        assert_eq!(session.revisions[0].comments.len(), 1);
        let comment = &session.revisions[0].comments[0];
        assert_eq!(comment.id, "c-001");
        assert_eq!(comment.body, "swap wording");
        assert!(matches!(comment.kind, CommentKind::Edit));
        let _ = std::fs::remove_file(&tmpfile);
    }

    #[test]
    fn comment_block_id_persists_and_updates() {
        use crate::state::UpdateCommentRequest;

        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# T\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        let c = store
            .add_comment(
                "s",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Edit,
                    scope: None,
                    anchor_id: "A.p1".to_string(),
                    block_id: Some("blk-abc123".to_string()),
                    structural: None,
                    body: "tighten".to_string(),
                    edit: Some(EditPayload {
                        original: "Body.".to_string(),
                        revised: "Prose.".to_string(),
                    }),
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add");
        assert_eq!(c.block_id.as_deref(), Some("blk-abc123"));

        // Survives a reload from disk-backed state.
        let reloaded = SessionStore::new(db.clone());
        assert_eq!(
            reloaded.get("s").unwrap().revisions[0].comments[0]
                .block_id
                .as_deref(),
            Some("blk-abc123")
        );

        // update_comment can re-key the block id (block re-identification).
        store
            .update_comment(
                "s",
                "c-001",
                UpdateCommentRequest {
                    body: None,
                    scope: None,
                    block_id: Some("blk-def456".to_string()),
                    structural: None,
                    edit: None,
                    selection: None,
                },
            )
            .expect("update");
        let reloaded2 = SessionStore::new(db);
        assert_eq!(
            reloaded2.get("s").unwrap().revisions[0].comments[0]
                .block_id
                .as_deref(),
            Some("blk-def456")
        );
    }

    #[test]
    fn structural_payload_round_trips_through_db() {
        use crate::state::{CommentKind, NewCommentRequest, StructuralPayload};

        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# T\n\nAlpha.\n\nBeta.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        let c = store
            .add_comment(
                "s",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::BlockMove,
                    scope: None,
                    anchor_id: "A.p1".to_string(),
                    block_id: Some("blk-x".to_string()),
                    structural: Some(StructuralPayload {
                        op: "move".to_string(),
                        block_id: "blk-x".to_string(),
                        from_anchor: Some("A.p1".to_string()),
                        to_anchor: Some("A.p2".to_string()),
                        markdown: Some("Alpha.".to_string()),
                    }),
                    body: "reordered for flow".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("add structural");
        assert!(matches!(c.kind, CommentKind::BlockMove));
        let sp = c.structural.as_ref().expect("payload set");
        assert_eq!(sp.op, "move");
        assert_eq!(sp.to_anchor.as_deref(), Some("A.p2"));

        // Survives reload from the backing DB.
        let reloaded = SessionStore::new(db);
        let rc = &reloaded.get("s").unwrap().revisions[0].comments[0];
        assert!(matches!(rc.kind, CommentKind::BlockMove));
        let rsp = rc.structural.as_ref().expect("payload survived");
        assert_eq!(rsp.op, "move");
        assert_eq!(rsp.block_id, "blk-x");
        assert_eq!(rsp.from_anchor.as_deref(), Some("A.p1"));
        assert_eq!(rsp.to_anchor.as_deref(), Some("A.p2"));
        assert_eq!(rsp.markdown.as_deref(), Some("Alpha."));
    }

    fn tempfile_path() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("redline-test-{}.db", uuid::Uuid::new_v4()));
        p
    }

    // ── Schema versioning ────────────────────────────────────────────────
    //
    // The fast path is the whole point of `PRAGMA user_version`, so it is the
    // thing under test: an already-current database must execute NO schema
    // SQL. Everything else here guards the ways a version stamp can lie.

    fn user_version(path: &std::path::Path) -> i64 {
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_fresh_database_lands_on_the_current_version() {
        let path = tempfile_path();
        {
            let store = SessionStore::new(Arc::new(Database::open(&path).unwrap()));
            // The schema is real, not just stamped: a write that touches the
            // tables and the ALTER-added columns has to succeed.
            let md = "# Fresh\n\nBody.\n";
            store.upsert_plan(
                "s-fresh",
                "/tmp/f",
                md.to_string(),
                crate::state::reparse_sections(md),
                true,
                false,
            );
            store.set_backend("s-fresh", Some("codex"), Some("gpt-5"));
        }
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_current_database_runs_no_migration_sql() {
        // The regression this exists to catch: reintroducing per-launch schema
        // replay. Before versioning, EVERY launch executed ~60
        // `CREATE TABLE IF NOT EXISTS`, ~50 `CREATE INDEX IF NOT EXISTS` and
        // 68 `ALTER TABLE ADD COLUMN` statements that were expected to fail,
        // in front of the window.
        let steps = || MIGRATION_STEPS_RUN.with(|c| c.get());
        let path = tempfile_path();
        MIGRATION_STEPS_RUN.with(|c| c.set(0));
        drop(Database::open(&path).unwrap());
        assert_eq!(steps(), 1, "the first open must build the schema exactly once");
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);

        // Every subsequent launch verifies shape using only read queries;
        // it never replays the schema migration steps.
        for _ in 0..3 {
            drop(Database::open(&path).unwrap());
        }
        assert_eq!(steps(), 1, "a current-schema launch re-ran a migration step");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_legacy_version_zero_database_migrates_and_keeps_its_rows() {
        // The shape every existing install is in: a full schema written by a
        // pre-versioning build, with `user_version` never set.
        let path = tempfile_path();
        {
            let store = SessionStore::new(Arc::new(Database::open(&path).unwrap()));
            let md = "# Legacy\n\nBody.\n";
            store.upsert_plan(
                "legacy",
                "/tmp/l",
                md.to_string(),
                crate::state::reparse_sections(md),
                true,
                false,
            );
            store.set_backend("legacy", Some("codex"), Some("gpt-5"));
        }
        // Rewind the stamp: this is now indistinguishable from a database
        // written before versioning existed.
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 0i64).unwrap();
        }
        assert_eq!(user_version(&path), 0);

        let db = Database::open(&path).unwrap();
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
        let sessions = db.load_all().unwrap();
        let legacy = sessions.get("legacy").expect("legacy session survived");
        assert_eq!(legacy.revisions.len(), 1);
        assert_eq!(legacy.revisions[0].raw_plan_markdown, "# Legacy\n\nBody.\n");
        // The provenance columns are part of the migration sequence, not
        // something a later build bolts on outside it.
        assert_eq!(legacy.backend.as_deref(), Some("codex"));
        assert_eq!(legacy.model.as_deref(), Some("gpt-5"));
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn foreign_version_two_history_shape_repairs_additively() {
        let path = tempfile_path();
        {
            let conn = Connection::open(&path).unwrap();
            // Exact collision: the pre-runner shape carrying cockpit's 2.
            Database::migrate_v1(&conn).unwrap();
            conn.execute_batch(
                "INSERT INTO sessions(session_id,project_path,project_name,created_at)
                 VALUES('foreign-history','/tmp/history','history',1);
                 INSERT INTO revisions(session_id,version_number,received_at,raw_plan_markdown)
                 VALUES('foreign-history',1,2,'# Kept plan');
                 INSERT INTO comments(id,session_id,version_number,type,anchor_id,body,created_at,status)
                 VALUES('kept-comment','foreign-history',1,'feedback','blk-kept','Keep this feedback',3,'draft');
                 PRAGMA user_version=2;"
            ).unwrap();
            assert!(conn.prepare("SELECT effort FROM sessions").is_err());
            assert!(conn.prepare("SELECT * FROM run_graphs").is_err());
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
        let sessions = db.load_all().unwrap();
        assert_eq!(db.plan_history_counts().unwrap(), (1, 1, 1));
        assert_eq!(sessions.len(), 1);
        let kept = &sessions["foreign-history"];
        assert_eq!(kept.effort, None);
        assert_eq!(kept.revisions.len(), 1);
        assert_eq!(kept.revisions[0].raw_plan_markdown, "# Kept plan");
        assert_eq!(kept.revisions[0].comments[0].body, "Keep this feedback");
        assert!(db.runner_list().unwrap().is_empty());
        drop(db);
        // A second open must remain readable and avoid another migration.
        assert_eq!(Database::open(&path).unwrap().load_all().unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_matching_stamp_with_missing_history_shape_is_refused_without_ddl() {
        for ddl in ["ALTER TABLE sessions DROP COLUMN effort", "DROP TABLE run_graphs"] {
            let path = tempfile_path();
            drop(Database::open(&path).unwrap());
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(ddl).unwrap();
            let schema_before: i64 = conn.query_row("PRAGMA schema_version", [], |r|r.get(0)).unwrap();
            drop(conn);
            // Even a current stamp must check shape; a read-only connection
            // demonstrates that this branch cannot try additive repair.
            let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            assert!(Database::migrate(&conn).is_err());
            assert_eq!(conn.query_row("PRAGMA schema_version", [], |r|r.get::<_,i64>(0)).unwrap(), schema_before);
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), Database::SCHEMA_VERSION);
            drop(conn);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn version_three_repair_does_not_stamp_an_unusable_legacy_shape() {
        let conn = Connection::open_in_memory().unwrap();
        Database::migrate_v1(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version=2; ALTER TABLE sessions DROP COLUMN model;").unwrap();
        assert!(Database::migrate(&conn).is_err());
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
    }

    fn history_snapshot(conn: &Connection) -> Vec<(Vec<String>, Vec<Vec<rusqlite::types::Value>>)> {
        [("sessions","session_id"),("revisions","session_id,version_number"),("comments","session_id,id")]
            .into_iter().map(|(table,order)| {
                let columns: Vec<String> = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap()
                    .query_map([],|r|r.get::<_,String>(1)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
                    .into_iter().filter(|c|table!="sessions" || c!="effort").collect();
                let projection=columns.iter().map(|c|format!("\"{}\"",c.replace('"',"\"\""))).collect::<Vec<_>>().join(",");
                let rows=conn.prepare(&format!("SELECT {projection} FROM {table} ORDER BY {order}")).unwrap()
                    .query_map([],|r|(0..columns.len()).map(|i|r.get(i)).collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()).unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>().unwrap();
                (columns,rows)
            }).collect()
    }

    #[test]
    #[ignore = "requires a separately created SQLite recovery copy via REDLINE_HISTORY_RECOVERY_COPY"]
    fn recovery_copy_opens_and_loads_all_history_without_changing_rows() {
        let path = std::path::PathBuf::from(std::env::var("REDLINE_HISTORY_RECOVERY_COPY").expect("set recovery COPY path"));
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("redline-history-copy-"), "only a disposable recovery copy may be opened");
        let before = {
            let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
            history_snapshot(&conn)
        };
        let db = Database::open(&path).unwrap();
        let sessions = db.load_all().unwrap();
        let counts = (sessions.len(), sessions.values().map(|s|s.revisions.len()).sum::<usize>(), sessions.values().flat_map(|s|&s.revisions).map(|r|r.comments.len()).sum::<usize>());
        assert_eq!(counts, (before[0].1.len(),before[1].1.len(),before[2].1.len()));
        assert_eq!(db.plan_history_counts().unwrap(), (counts.0 as i64,counts.1 as i64,counts.2 as i64));
        assert!(history_snapshot(&db.lock_conn()) == before, "existing history cells changed during recovery migration");
        assert_eq!(db.lock_conn().query_row("PRAGMA quick_check", [], |r|r.get::<_,String>(0)).unwrap(), "ok");
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
        println!("Recovery copy preserved and loaded {} sessions, {} revisions, {} comments; quick_check ok",counts.0,counts.1,counts.2);
    }

    #[test]
    fn a_forward_stamp_with_a_usable_schema_opens_and_runs_no_migrations() {
        // THE regression. `PRAGMA user_version` is one 32-bit slot, and this
        // app has had two migration lineages claim it — the `cockpit` branch
        // shipped its own runner long before this one, so a developer machine
        // that ever ran a cockpit build carries a stamp (2) from an unrelated
        // numbering space. Refusing on the integer alone bricked exactly that
        // database: a hard panic in Tauri's setup, no window, no message.
        //
        // The schema is the authority. A forward stamp whose schema has
        // everything we need opens, runs NO steps, and — critically — does not
        // restamp: an older build replaying additive steps over a newer schema
        // is the corruption the refusal existed to prevent, and that is still
        // prevented.
        let path = tempfile_path();
        drop(Database::open(&path).unwrap());
        let foreign = Database::SCHEMA_VERSION + 1;
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", foreign).unwrap();
        }

        let steps = || MIGRATION_STEPS_RUN.with(|c| c.get());
        MIGRATION_STEPS_RUN.with(|c| c.set(0));
        let db = match Database::open(&path) {
            Ok(db) => db,
            Err(e) => panic!("a usable schema must open whatever the stamp says: {e}"),
        };
        assert_eq!(steps(), 0, "a forward stamp must run no migration steps");
        assert_eq!(
            user_version(&path),
            foreign,
            "the other lineage's stamp must be left exactly as found"
        );
        // And it is genuinely usable, not merely open.
        let store = SessionStore::new(Arc::new(db));
        let md = "# Forward\n\nBody.\n";
        store.upsert_plan("fwd", "/tmp/f", md.to_string(), reparse_sections(md), true, false);
        assert!(store.get("fwd").is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_forward_stamp_missing_columns_we_need_is_refused() {
        // The protection that must survive the fix above: "newer" plus a
        // schema that genuinely lacks something this build reads is still a
        // refusal, with a message that names the fix.
        let path = tempfile_path();
        drop(Database::open(&path).unwrap());
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("DROP TABLE IF EXISTS drafts;").unwrap();
            conn.pragma_update(None, "user_version", Database::SCHEMA_VERSION + 7)
                .unwrap();
        }
        let err = match Database::open(&path) {
            Ok(_) => panic!("a forward stamp missing our columns must be refused"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("newer than this build"),
            "unhelpful refusal: {err}"
        );
        // And the file is untouched — refusing is not corrupting.
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION + 7);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_partly_migrated_database_fails_verification_instead_of_being_stamped() {
        // A v0 database whose earlier best-effort migration lost a column: the
        // stamp would say "current" and every read of that column would then
        // fail forever, one query at a time. `verify_schema` is what turns
        // that into one loud failure at open.
        let path = tempfile_path();
        drop(Database::open(&path).unwrap());
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            // Rebuild `sessions` without the provenance columns, then rewind
            // the stamp — and neuter the ALTER that would re-add them by
            // leaving a legacy-shaped table the batch cannot fix, which is
            // what a genuinely partial migration looks like.
            conn.execute_batch(
                "DROP TABLE IF EXISTS sessions;
                 CREATE TABLE sessions (
                     session_id TEXT PRIMARY KEY,
                     project_path TEXT NOT NULL,
                     project_name TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     status TEXT NOT NULL DEFAULT 'in_review'
                 );",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 0i64).unwrap();
        }
        // The v1 step's own ALTERs repair this one, which is the correct
        // outcome — so assert the repair happened AND the version advanced.
        match Database::open(&path) {
            Ok(db) => drop(db),
            Err(e) => panic!("a repairable legacy shape must open: {e}"),
        }
        assert_eq!(user_version(&path), Database::SCHEMA_VERSION);
        let conn = rusqlite::Connection::open(&path).unwrap();
        let mut stmt = conn.prepare("PRAGMA table_info(sessions)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        for required in ["attach_state", "updated_at", "run_state", "backend", "model"] {
            assert!(columns.contains(&required.to_string()), "{required} not restored");
        }
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn verify_schema_rejects_a_missing_table() {
        // The cheap half of the guard: a core table absent entirely.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE revisions (session_id TEXT);
             CREATE TABLE comments (id TEXT);",
        )
        .unwrap();
        let err = Database::verify_schema(&conn).expect_err("must reject");
        assert!(
            err.to_string().contains("table app_settings is missing"),
            "{err}"
        );
    }

    #[test]
    fn verify_schema_rejects_a_missing_column() {
        // The half that catches a genuinely PARTIAL migration: every table
        // present, but an `ALTER TABLE ADD COLUMN` that silently didn't
        // happen. Built by opening a real database and then removing one
        // column, so the fixture cannot drift from the real schema.
        let path = tempfile_path();
        drop(Database::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        // SQLite ≥3.35 can drop a column; the bundled build is well past that.
        conn.execute_batch("ALTER TABLE sessions DROP COLUMN model;")
            .unwrap();
        let err = Database::verify_schema(&conn).expect_err("must reject");
        assert!(
            err.to_string().contains("sessions.model is missing"),
            "{err}"
        );
        assert!(err.to_string().contains("only partly migrated"), "{err}");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_migration_list_is_ordered_and_ends_at_the_current_version() {
        let versions: Vec<i64> = Database::MIGRATIONS.iter().map(|(v, _)| *v).collect();
        let mut sorted = versions.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(versions, sorted, "migrations must be ordered and unique");
        assert_eq!(
            versions.last().copied(),
            Some(Database::SCHEMA_VERSION),
            "SCHEMA_VERSION must match the last migration step"
        );
        assert_eq!(versions.first().copied(), Some(1), "steps start at 1");
    }

    #[test]
    fn comment_ids_are_session_scoped() {
        use crate::state::UpdateCommentRequest;

        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# A\n\nIntro.\n";
        store.upsert_plan("sess-a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
        store.upsert_plan("sess-b", "/tmp/b", md.to_string(), reparse_sections(md), true, false);

        let mk = |body: &str| NewCommentRequest {
                id: None,
            kind: CommentKind::Question,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: None,
            structural: None,
            body: body.to_string(),
            edit: None,
            selection: None,
            author: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };

        let a = store
            .add_comment("sess-a", mk("from a"))
            .expect("persist in sess-a");
        // Before the composite PK fix this collided on the global
        // `comments.id` PRIMARY KEY and failed to persist.
        let b = store
            .add_comment("sess-b", mk("from b"))
            .expect("persist in sess-b");
        assert_eq!(a.id, "c-001");
        assert_eq!(b.id, "c-001");

        // Updating sess-a's c-001 must not touch sess-b's c-001.
        store
            .update_comment(
                "sess-a",
                "c-001",
                UpdateCommentRequest {
                    body: Some("a edited".to_string()),
                    scope: None,
                    block_id: None,
                    structural: None,
                    edit: None,
                    selection: None,
                },
            )
            .expect("update sess-a c-001");
        // Reload from the DB so we assert on what was actually persisted,
        // not just in-memory state.
        let store2 = SessionStore::new(db.clone());
        assert_eq!(
            store2.get("sess-a").unwrap().revisions[0].comments[0].body,
            "a edited"
        );
        assert_eq!(
            store2.get("sess-b").unwrap().revisions[0].comments[0].body,
            "from b"
        );

        // Deleting sess-a's c-001 must leave sess-b's c-001 intact.
        assert!(store.delete_comment("sess-a", "c-001"));
        let store3 = SessionStore::new(db.clone());
        assert!(store3.get("sess-a").unwrap().revisions[0]
            .comments
            .is_empty());
        assert_eq!(
            store3.get("sess-b").unwrap().revisions[0].comments.len(),
            1
        );
    }

    #[test]
    fn legacy_global_pk_db_migrates_to_composite() {
        let tmpfile = tempfile_path();

        // Build a database with the OLD schema: `comments.id` is a global
        // PRIMARY KEY, with one pre-existing comment.
        {
            let conn = Connection::open(&tmpfile).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    project_name TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'in_review'
                );
                CREATE TABLE revisions (
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    received_at INTEGER NOT NULL,
                    raw_plan_markdown TEXT NOT NULL,
                    PRIMARY KEY (session_id, version_number)
                );
                CREATE TABLE comments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    scope TEXT,
                    anchor_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    edit_original TEXT,
                    edit_revised TEXT,
                    created_at INTEGER NOT NULL,
                    status TEXT NOT NULL
                );
                INSERT INTO sessions VALUES ('old', '/tmp/old', 'old', 1, 'in_review');
                INSERT INTO revisions VALUES ('old', 1, 1, '# Title\n\nBody.\n');
                INSERT INTO comments
                    (id, session_id, version_number, type, scope, anchor_id,
                     body, edit_original, edit_revised, created_at, status)
                VALUES
                    ('c-001', 'old', 1, 'question', NULL, 'A',
                     'legacy body', NULL, NULL, 1, 'submitted');
                "#,
            )
            .unwrap();
        }

        // Opening through Database::open runs migrate(), which must rebuild
        // `comments` with a composite (session_id, id) primary key.
        let db = Arc::new(Database::open(&tmpfile).unwrap());

        // Composite primary key: exactly two columns participate in the PK.
        {
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn.prepare("PRAGMA table_info(comments)").unwrap();
            let pk_cols: i64 = stmt
                .query_map([], |row| row.get::<_, i64>(5))
                .unwrap()
                .map(|r| r.unwrap())
                .filter(|pk| *pk > 0)
                .count() as i64;
            assert_eq!(pk_cols, 2, "comments should have a composite primary key");
        }

        // The legacy comment is preserved.
        let store = SessionStore::new(db);
        let old = store.get("old").expect("legacy session reloaded");
        assert_eq!(old.revisions[0].comments.len(), 1);
        assert_eq!(old.revisions[0].comments[0].id, "c-001");
        assert_eq!(old.revisions[0].comments[0].body, "legacy body");

        // A brand-new session can now persist its own `c-001` without a
        // UNIQUE constraint violation (the original bug).
        let md = "# T\n\nP.\n";
        store.upsert_plan("fresh", "/tmp/fresh", md.to_string(), reparse_sections(md), true, false);
        let c = store
            .add_comment(
                "fresh",
                NewCommentRequest {
                id: None,
                    kind: CommentKind::Question,
                    scope: None,
                    anchor_id: "T".to_string(),
                    block_id: None,
                    structural: None,
                    body: "new session comment".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .expect("fresh session c-001 persists");
        assert_eq!(c.id, "c-001");

        // The post-rebuild fork_session_id / fork_backend columns landed on
        // the rebuilt legacy `comments` table — set/get round-trips on the
        // legacy row.
        let db = store.database();
        assert!(db.get_comment_fork("old", "c-001").is_none());
        db.set_comment_fork("old", "c-001", "fork-legacy", "claude-code")
            .unwrap();
        assert_eq!(
            db.get_comment_fork("old", "c-001"),
            Some(("fork-legacy".to_string(), "claude-code".to_string())),
        );

        let _ = std::fs::remove_file(&tmpfile);
    }

    // --- Session recency (updated_at) ----------------------------------

    #[test]
    fn migration_backfills_legacy_updated_at() {
        use crate::state::{AttachState, ReviewSession, SessionStatus};
        let db = Database::open_in_memory().unwrap();
        let mk = |id: &str, created: i64| ReviewSession {
            session_id: id.to_string(),
            project_path: "/repo".to_string(),
            project_name: "repo".to_string(),
            created_at: created,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 0,
            run_state: None,
            backend: None,
            model: None,
        effort: None,
        };
        db.upsert_session(&mk("with-rev", 500)).unwrap();
        db.insert_revision(
            "with-rev",
            &crate::state::Revision {
                version_number: 1,
                received_at: 700,
                raw_plan_markdown: "# P".to_string(),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: true,
                restored: false,
            },
        )
        .unwrap();
        db.upsert_session(&mk("bare", 300)).unwrap();
        // Simulate rows written by a pre-updated_at build…
        db.zero_updated_at("with-rev");
        db.zero_updated_at("bare");
        // …and re-run the idempotent step: only 0-rows are backfilled. The
        // STEP, not the runner — `migrate()` is a no-op on an already-current
        // database, which is what the version stamp buys.
        {
            let conn = db.conn.lock().unwrap();
            Database::migrate_v1(&conn).unwrap();
        }
        let all = db.load_all().unwrap();
        assert_eq!(all["with-rev"].updated_at, 700); // latest revision time
        assert_eq!(all["bare"].updated_at, 300); // falls back to created_at
    }

    #[test]
    fn thread_message_bumps_session_recency_ordering() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("a", "/tmp/a", md.to_string(), reparse_sections(md), true, false);
        store.upsert_plan("b", "/tmp/b", md.to_string(), reparse_sections(md), true, false);
        // Discussion activity lands on the DB directly (fork threads write
        // through Database, not the store); a strictly later stamp must float
        // "a" above "b" after a restart-shaped reload.
        let later = crate::state::now_millis() + 10_000;
        db.insert_thread_message(&ThreadMessage {
            id: "m1".to_string(),
            session_id: "a".to_string(),
            comment_id: "c-001".to_string(),
            role: "user".to_string(),
            body: "hi".to_string(),
            status: "complete".to_string(),
            created_at: later,
            attachments: Vec::new(),
        })
        .unwrap();
        let reloaded = SessionStore::new(db.clone());
        let list = reloaded.list();
        assert_eq!(list[0].session_id, "a");
        assert_eq!(list[0].updated_at, later);
    }

    #[test]
    fn comment_bumps_in_memory_updated_at() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db);
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
        let before = store.get("s").unwrap().updated_at;
        let c = store
            .add_comment(
                "s",
                NewCommentRequest {
                    id: None,
                    kind: CommentKind::Feedback,
                    scope: None,
                    anchor_id: "A".to_string(),
                    block_id: None,
                    structural: None,
                    body: "b".to_string(),
                    edit: None,
                    selection: None,
                    author: None,
                    reviewer: None,
                    external_created_at: None,
                    share_request_id: None,
                    attachments: Vec::new(),
                },
            )
            .unwrap();
        let after = store.get("s").unwrap().updated_at;
        assert!(after >= before);
        assert!(after >= c.created_at);
    }

    // --- Queue-status lifecycle (send-while-busy) ------------------------

    /// One queue-capable row per surface, so the generic helpers are proven
    /// against every table in the kind map they claim to cover.
    fn seed_queueable_rows(db: &Database) {
        db.insert_browse_message(&crate::state::BrowseMessage {
            id: "qb".to_string(),
            browse_id: "tab-1".to_string(),
            role: "user".to_string(),
            body: "queued browse".to_string(),
            status: "queued".to_string(),
            created_at: 10,
        })
        .unwrap();
        db.insert_linked_message(&crate::state::LinkedMessage {
            id: "ql".to_string(),
            linked_id: "l-1".to_string(),
            role: "user".to_string(),
            body: "queued linked".to_string(),
            status: "queued".to_string(),
            tab_browse_id: None,
            tab_n: None,
            tab_title: None,
            tab_url: None,
            created_at: 10,
        })
        .unwrap();
        db.insert_mission_message(&crate::state::MissionMessage {
            id: "qm".to_string(),
            mission_id: "m-1".to_string(),
            role: "user".to_string(),
            body: "queued mission".to_string(),
            status: "queued".to_string(),
            created_at: 10,
        })
        .unwrap();
        db.insert_mem_chat_message(&crate::state::MemChatMessage {
            id: "qc".to_string(),
            thread_id: "memchat".to_string(),
            role: "user".to_string(),
            body: "queued memchat".to_string(),
            status: "queued".to_string(),
            created_at: 10,
        })
        .unwrap();
    }

    #[test]
    fn set_thread_message_status_flips_across_the_kind_map() {
        let db = Database::open_in_memory().unwrap();
        seed_queueable_rows(&db);
        for (kind, id) in [
            ("browse", "qb"),
            ("linked", "ql"),
            ("mission", "qm"),
            ("memchat", "qc"),
        ] {
            assert!(
                db.set_thread_message_status(kind, id, "complete").unwrap(),
                "{kind} row must flip"
            );
        }
        assert_eq!(db.load_browse_thread("tab-1").unwrap()[0].status, "complete");
        assert_eq!(db.load_linked_thread("l-1").unwrap()[0].status, "complete");
        assert_eq!(db.load_mission_thread("m-1").unwrap()[0].status, "complete");
        assert_eq!(db.load_mem_chat_thread("memchat").unwrap()[0].status, "complete");
        // A miss and an unknown kind both report false, never error.
        assert!(!db.set_thread_message_status("browse", "nope", "unsent").unwrap());
        assert!(!db.set_thread_message_status("martian", "qb", "unsent").unwrap());
    }

    #[test]
    fn delete_thread_message_removes_the_unqueued_row() {
        let db = Database::open_in_memory().unwrap();
        seed_queueable_rows(&db);
        assert!(db.delete_thread_message("browse", "qb").unwrap());
        assert!(db.load_browse_thread("tab-1").unwrap().is_empty());
        assert!(!db.delete_thread_message("browse", "qb").unwrap(), "already gone");
        assert!(!db.delete_thread_message("martian", "ql").unwrap());
        // The other surfaces' rows are untouched.
        assert_eq!(db.load_linked_thread("l-1").unwrap().len(), 1);
    }

    #[test]
    fn startup_sweep_flips_only_queued_rows_to_unsent() {
        let db = Database::open_in_memory().unwrap();
        seed_queueable_rows(&db);
        // A settled row that the sweep must not touch.
        db.insert_browse_message(&crate::state::BrowseMessage {
            id: "done".to_string(),
            browse_id: "tab-1".to_string(),
            role: "assistant".to_string(),
            body: "landed".to_string(),
            status: "complete".to_string(),
            created_at: 20,
        })
        .unwrap();
        assert_eq!(db.sweep_queued_to_unsent().unwrap(), 4);
        let browse = db.load_browse_thread("tab-1").unwrap();
        assert_eq!(browse[0].status, "unsent");
        assert_eq!(browse[1].status, "complete");
        assert_eq!(db.load_linked_thread("l-1").unwrap()[0].status, "unsent");
        assert_eq!(db.load_mission_thread("m-1").unwrap()[0].status, "unsent");
        assert_eq!(db.load_mem_chat_thread("memchat").unwrap()[0].status, "unsent");
        // Idempotent: nothing left to flip.
        assert_eq!(db.sweep_queued_to_unsent().unwrap(), 0);
    }

    #[test]
    fn thread_loads_return_queued_rows_in_send_order() {
        let db = Database::open_in_memory().unwrap();
        for (id, status, ts) in [
            ("u1", "complete", 1),
            ("a1", "complete", 2),
            ("q1", "queued", 3),
            ("q2", "queued", 4),
        ] {
            db.insert_browse_message(&crate::state::BrowseMessage {
                id: id.to_string(),
                browse_id: "tab-1".to_string(),
                role: "user".to_string(),
                body: id.to_string(),
                status: status.to_string(),
                created_at: ts,
            })
            .unwrap();
        }
        let rows = db.load_browse_thread("tab-1").unwrap();
        assert_eq!(
            rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["u1", "a1", "q1", "q2"],
            "queued rows load with the thread, oldest-first"
        );
    }

    // --- Agent Seat activity (Seat Assignment digest) -------------------

    #[test]
    fn seat_activity_counts_assistant_turns_in_and_out_of_window() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            let mut msg = |table: &str, id: &str, owner: &str, role: &str, ts: i64| {
                conn.execute(
                    &format!(
                        "INSERT INTO {table} (id, {owner_col}, role, body, status, created_at)
                         VALUES (?1, ?2, ?3, 'x', 'done', ?4)",
                        owner_col = owner
                    ),
                    params![id, "o1", role, ts],
                )
                .unwrap();
            };
            // Two assistant turns inside the window, one outside, one user turn
            // that must never count.
            msg("browse_messages", "b1", "browse_id", "assistant", 5_000);
            msg("browse_messages", "b2", "browse_id", "assistant", 6_000);
            msg("browse_messages", "b3", "browse_id", "assistant", 100);
            msg("browse_messages", "b4", "browse_id", "user", 5_500);
            msg("mission_messages", "m1", "mission_id", "assistant", 7_000);
        }
        let acts = db.seat_activity(1_000);
        let by = |seat: &str| {
            acts.iter()
                .find(|a| a.seat == seat)
                .unwrap_or_else(|| panic!("no {seat} row"))
                .clone()
        };
        let browse = by("browse");
        assert_eq!(browse.turns_window, 2, "only in-window assistant turns");
        assert_eq!(browse.turns_total, 3, "all-time excludes the user turn");
        assert_eq!(browse.last_ts, Some(6_000));
        assert_eq!(by("mission").turns_total, 1);
        // A seat with no rows reports zero rather than vanishing — the digest
        // needs the explicit "never ran" signal.
        let voice = by("voice");
        assert_eq!((voice.turns_window, voice.turns_total), (0, 0));
        assert_eq!(voice.last_ts, None);
    }

    #[test]
    fn seat_activity_splits_plan_threads_from_drafter_comment_threads() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // A drafter comment thread: its comment_id resolves to draft_comments.
            conn.execute(
                "INSERT INTO draft_comments (id, draft_id, body, created_at)
                 VALUES ('dc1', 'd1', 'note', 100)",
                [],
            )
            .unwrap();
            let mut tm = |id: &str, comment: &str, ts: i64| {
                conn.execute(
                    "INSERT INTO thread_messages
                       (id, session_id, comment_id, role, body, status, created_at)
                     VALUES (?1, 's1', ?2, 'assistant', 'x', 'done', ?3)",
                    params![id, comment, ts],
                )
                .unwrap();
            };
            tm("t1", "dc1", 5_000); // drafter comment thread
            tm("t2", "plan-c1", 5_000); // plan sidecar thread
            tm("t3", "plan-c2", 5_000);
        }
        let acts = db.seat_activity(1_000);
        let count = |seat: &str| acts.iter().find(|a| a.seat == seat).unwrap().turns_total;
        assert_eq!(count("fork_drafter"), 1);
        assert_eq!(count("fork_plan"), 2, "unmatched comment_ids are plan threads");
    }

    #[test]
    fn ai_review_activity_counts_agent_runs_not_reviews_the_user_opened() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // Three code reviews opened by hand…
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO review_sessions (review_id, repo_path, source, round, created_at)
                     VALUES (?1, '/repo', 'diff', 1, 5000)",
                    params![format!("r{i}")],
                )
                .unwrap();
            }
            // …but the AI reviewer only ever ran on one of them, writing four
            // findings. Counting rows would say 4; counting reviews says 1.
            let mut ann = |id: &str, review: &str, source: &str, ts: i64| {
                conn.execute(
                    "INSERT INTO review_annotations
                       (id, review_id, round, file_path, side, start_line, end_line,
                        kind, body, quoted_text, status, created_at, source)
                     VALUES (?1, ?2, 1, 'a.rs', 'new', 1, 1, 'comment', 'b', 'q', 'open', ?3, ?4)",
                    params![id, review, ts, source],
                )
                .unwrap();
            };
            ann("a1", "r0", "ai", 5_000);
            ann("a2", "r0", "ai", 5_100);
            ann("a3", "r0", "ai", 5_200);
            ann("a4", "r0", "ai", 5_300);
            // A human comment on another review must never count as an AI run.
            ann("a5", "r1", "user", 5_400);
        }
        let acts = db.seat_activity(1_000);
        let ai = acts.iter().find(|a| a.seat == "ai_review").unwrap();
        assert_eq!(ai.turns_total, 1, "one AI run, not four findings or three reviews");
        assert_eq!(ai.turns_window, 1);
        assert_eq!(ai.last_ts, Some(5_300));
    }

    #[test]
    fn keeper_is_not_inferred_from_per_prompt_compaction_events() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // Compaction events are written one per prompt — and the
            // deterministic fallback writes them even when no agent spawned.
            for i in 0..40 {
                conn.execute(
                    "INSERT INTO ledger_events
                       (seq, ts, kind, author, payload_hash, prev_hash, entry_hash)
                     VALUES (?1, 5000, 'compaction', 'redline', 'p', 'x', ?2)",
                    params![i + 1, format!("h{i}")],
                )
                .unwrap();
            }
        }
        // The seat must NOT claim 40 turns for an agent that may never have run.
        assert!(
            !db.seat_activity(1_000).iter().any(|a| a.seat == "keeper"),
            "keeper has no per-run record, so it must report nothing at all"
        );
    }

    #[test]
    fn prompt_length_by_surface_reports_median_and_p90() {
        let db = Database::open_in_memory().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            for (i, len) in [10usize, 20, 30, 40, 100].iter().enumerate() {
                conn.execute(
                    "INSERT INTO prompts (ts, source, origin, surface, role, body, body_hash)
                     VALUES (1, 'hook', 'internal', 'browse', 'user', ?1, ?2)",
                    params!["x".repeat(*len), format!("h{i}")],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO prompts (ts, source, origin, surface, role, body, body_hash)
                 VALUES (1, 'hook', 'internal', 'plan', 'user', 'xxx', 'hplan')",
                [],
            )
            .unwrap();
        }
        let rows = db.prompt_length_by_surface().unwrap();
        // Heaviest surface first.
        assert_eq!(rows[0].0, "browse");
        assert_eq!(rows[0].1, 5);
        assert_eq!(rows[0].2, 30, "median of 10/20/30/40/100");
        assert_eq!(rows[0].3, 100, "p90 lands on the long tail");
        assert_eq!(rows[1].0, "plan");
    }

    #[test]
    fn seat_stats_upsert_accumulates_and_never_regresses_last_run() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_seat_stat("browse").is_none());
        db.upsert_seat_stat("browse", Some(1_000), 2).unwrap();
        let s = db.get_seat_stat("browse").unwrap();
        assert_eq!(s.last_run_at, Some(1_000));
        assert_eq!(s.items_filed, 2);
        // Deltas accumulate; a None run timestamp leaves the old one standing.
        db.upsert_seat_stat("browse", None, 3).unwrap();
        let s = db.get_seat_stat("browse").unwrap();
        assert_eq!(s.last_run_at, Some(1_000));
        assert_eq!(s.items_filed, 5);
        // An out-of-order (older) run must not move last_run_at backwards.
        db.upsert_seat_stat("browse", Some(500), 0).unwrap();
        assert_eq!(db.get_seat_stat("browse").unwrap().last_run_at, Some(1_000));
        db.upsert_seat_stat("browse", Some(2_000), 0).unwrap();
        assert_eq!(db.get_seat_stat("browse").unwrap().last_run_at, Some(2_000));
        // A stats-only seat with no run yet keeps a NULL last_run_at.
        db.upsert_seat_stat("keeper", None, 1).unwrap();
        assert_eq!(db.get_seat_stat("keeper").unwrap().last_run_at, None);
        assert_eq!(db.list_seat_stats().unwrap().len(), 2);
    }

    #[test]
    fn seat_burn_adds_per_day_and_rolls_up_both_axes() {
        let db = Database::open_in_memory().unwrap();
        db.add_seat_burn("browse", "2026-08-11", 100, 50, 10, 5, 1).unwrap();
        db.add_seat_burn("browse", "2026-08-11", 20, 10, 2, 1, 1).unwrap();
        db.add_seat_burn("browse", "2026-08-12", 7, 3, 0, 0, 1).unwrap();
        db.add_seat_burn("voice", "2026-08-12", 1, 1, 1, 1, 1).unwrap();

        let by_seat = db.seat_burn_totals_by_seat().unwrap();
        assert_eq!(by_seat.len(), 2);
        let browse = by_seat.iter().find(|r| r.seat.as_deref() == Some("browse")).unwrap();
        assert_eq!(browse.input_tokens, 127);
        assert_eq!(browse.output_tokens, 63);
        assert_eq!(browse.cache_read_tokens, 12);
        assert_eq!(browse.cache_creation_tokens, 6);
        assert_eq!(browse.spawns, 3);
        assert_eq!(browse.day, None, "seat rollup aggregates the day axis");

        let by_day = db.seat_burn_totals_by_day(30).unwrap();
        assert_eq!(by_day.len(), 2);
        assert_eq!(by_day[0].day.as_deref(), Some("2026-08-12"), "newest first");
        assert_eq!(by_day[0].input_tokens, 8, "both seats' burn folds in");
        assert_eq!(by_day[0].spawns, 2);
        assert_eq!(by_day[1].day.as_deref(), Some("2026-08-11"));
        assert_eq!(by_day[1].input_tokens, 120);
    }

    /// The overnight queue's ready frontier: approved AND never run. Every
    /// other combination — in review, aborted, or any `run_state` at all
    /// (including the parked `awaiting_review`) — stays out, so a queued run
    /// can never re-queue itself.
    #[test]
    fn queue_ready_sessions_are_approved_and_unrun_fifo() {
        use crate::state::{AttachState, ReviewSession, SessionStatus};
        let db = Database::open_in_memory().unwrap();
        let mk = |sid: &str, status: SessionStatus, at: i64| ReviewSession {
            session_id: sid.to_string(),
            project_path: format!("/repo/{sid}"),
            project_name: sid.to_string(),
            created_at: at,
            revisions: Vec::new(),
            status,
            attach_state: AttachState::Idle,
            updated_at: at,
            run_state: None,
            backend: None,
            model: None,
        effort: None,
        };
        // Approved + unrun (the queue's targets), out of insertion order.
        db.upsert_session(&mk("b-approved", SessionStatus::Approved, 200)).unwrap();
        db.upsert_session(&mk("a-approved", SessionStatus::Approved, 100)).unwrap();
        // Approved but already run (any run_state value excludes).
        db.upsert_session(&mk("ran", SessionStatus::Approved, 50)).unwrap();
        db.set_run_state("ran", "landed").unwrap();
        // Approved but parked overnight — must NOT re-queue.
        db.upsert_session(&mk("parked", SessionStatus::Approved, 60)).unwrap();
        db.set_run_state("parked", "awaiting_review").unwrap();
        // Not approved at all.
        db.upsert_session(&mk("reviewing", SessionStatus::InReview, 10)).unwrap();
        db.upsert_session(&mk("dead", SessionStatus::Aborted, 20)).unwrap();

        let ready = db.list_queue_ready_sessions().unwrap();
        assert_eq!(
            ready.iter().map(|(sid, _, _)| sid.as_str()).collect::<Vec<_>>(),
            vec!["a-approved", "b-approved"],
            "approved+unrun only, oldest first"
        );
        assert_eq!(ready[0].1, "/repo/a-approved", "repo path rides along");
        assert_eq!(ready[0].2, "a-approved", "project name rides along");
    }

    // --- T0.1: the friction metric measures OPEN comments -------------------

    /// A shared fixture for the friction metric: one `in_review` session
    /// carrying one comment in each of the six lifecycle states, with the
    /// `resolution_accepted_at` column deliberately populated the way the live
    /// DB populates it (only on an explicit reviewer Accept).
    fn friction_fixture() -> Database {
        use crate::state::{
            AttachState, Comment, CommentKind, CommentStatus, Resolution, ReviewSession, Revision,
            SessionStatus,
        };
        let db = Database::open_in_memory().unwrap();
        db.upsert_session(&ReviewSession {
            session_id: "s-friction".to_string(),
            project_path: "/repo/friction".to_string(),
            project_name: "friction".to_string(),
            created_at: 1_000,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 1_000,
            run_state: None,
            backend: None,
            model: None,
        effort: None,
        })
        .unwrap();
        db.insert_revision(
            "s-friction",
            &Revision {
                version_number: 1,
                received_at: 1_000,
                raw_plan_markdown: "# plan".to_string(),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: true,
                restored: false,
            },
        )
        .unwrap();

        let mk = |id: &str, status: CommentStatus, resolution: Option<Resolution>| Comment {
            id: id.to_string(),
            kind: CommentKind::Feedback,
            scope: None,
            anchor_id: "A.1".to_string(),
            block_id: None,
            body: format!("body for {id}"),
            structural: None,
            edit: None,
            created_at: 1_000,
            status,
            resolution,
            selection: None,
            reopen_note: None,
            reopen_history: Vec::new(),
            actionable: false,
            author: None,
            agent_state: None,
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        };
        let answered = |accepted_at: Option<i64>| {
            Some(Resolution {
                body: "done".to_string(),
                appeared_in_version: 2,
                accepted_at,
            })
        };

        // Open — each of these is still waiting on somebody.
        db.insert_comment("s-friction", 1, &mk("c-001", CommentStatus::Draft, None)).unwrap();
        db.insert_comment("s-friction", 1, &mk("c-002", CommentStatus::Submitted, None)).unwrap();
        db.insert_comment("s-friction", 1, &mk("c-003", CommentStatus::Reopened, None)).unwrap();
        // Closed. `c-004` is the population that broke the old metric: Claude
        // answered it, the reviewer never pressed Accept, so
        // `resolution_accepted_at` stays NULL forever.
        db.insert_comment("s-friction", 1, &mk("c-004", CommentStatus::Resolved, answered(None)))
            .unwrap();
        db.insert_comment(
            "s-friction",
            1,
            &mk("c-005", CommentStatus::Accepted, answered(Some(2_000))),
        )
        .unwrap();
        db.insert_comment("s-friction", 1, &mk("c-006", CommentStatus::Withdrawn, None)).unwrap();
        db
    }

    /// The metric counts comments whose STATUS is open, not comments the
    /// reviewer never formally accepted. Six comments, one per state, must
    /// score 3 — draft + submitted + reopened.
    #[test]
    fn in_review_friction_counts_open_statuses_not_acceptance() {
        let db = friction_fixture();

        let rows = db.in_review_friction().unwrap();
        assert_eq!(rows.len(), 1, "one in_review session");
        let (session_id, project_name, created_at, unresolved) = rows[0].clone();
        assert_eq!(session_id, "s-friction");
        assert_eq!(project_name, "friction");
        assert_eq!(created_at, 1_000);
        assert_eq!(
            unresolved, 3,
            "draft + submitted + reopened are open; resolved, accepted and \
             withdrawn are not"
        );

        // The regression this test exists for: with the old
        // `resolution_accepted_at IS NULL` rule the same fixture scored 5,
        // because everything except the explicitly-accepted `c-005` matched.
        let by_never_accepted: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM comments
                   WHERE session_id = 's-friction' AND resolution_accepted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(by_never_accepted, 5, "the old rule over-counted by 2");
        assert!(
            unresolved < by_never_accepted,
            "the open-status rule must be strictly tighter than the acceptance rule"
        );
    }

    /// A resolved comment the reviewer never accepted is answered, not
    /// friction — the single most common shape in the live DB.
    #[test]
    fn in_review_friction_ignores_resolved_but_never_accepted() {
        use crate::state::CommentStatus;
        let db = friction_fixture();

        // Withdraw the three open ones; nothing open is left.
        for id in ["c-001", "c-002", "c-003"] {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE comments SET status = ?2 WHERE session_id = 's-friction' AND id = ?1",
                params![id, CommentStatus::Withdrawn.as_str()],
            )
            .unwrap();
        }

        let rows = db.in_review_friction().unwrap();
        assert_eq!(
            rows[0].3, 0,
            "a session whose only remaining comments are resolved/accepted/withdrawn \
             carries no friction"
        );
    }

    // --- T0.2: the connection mutex survives a panic ------------------------

    /// The failure this guard exists for, reproduced end to end. A panic
    /// inside a closure that holds the connection guard poisons the mutex;
    /// before `lock_conn()` every later lock unwrapped that `PoisonError` and
    /// panicked — forever — while the window stayed up and looked alive.
    ///
    /// The source invariant that keeps production off the bare `.unwrap()`
    /// lives in `tests/poison_guard.rs`.
    #[test]
    fn poisoned_conn_recovers() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.set_setting("before", "written").unwrap();

        // Exactly the production shape: the guard is live while the stack
        // unwinds, which is what poisons the mutex.
        let poisoner = Arc::clone(&db);
        let joined = std::thread::spawn(move || {
            let _guard = poisoner.conn.lock().unwrap();
            panic!("deliberate panic inside a db closure");
        })
        .join();
        assert!(joined.is_err(), "the helper thread must actually have panicked");
        assert!(db.conn.is_poisoned(), "and the mutex must actually be poisoned");

        // Every one of these goes through lock_conn().
        assert_eq!(
            db.get_setting("before").as_deref(),
            Some("written"),
            "data written before the poison is still readable"
        );
        db.set_setting("after", "still writable").unwrap();
        assert_eq!(
            db.get_setting("after").as_deref(),
            Some("still writable"),
            "and writes still land"
        );

        // A method with a different shape (prepare + query_map), to prove the
        // recovery is at the lock and not in one lucky code path.
        assert!(
            db.in_review_friction().is_ok(),
            "prepared-statement reads work on a recovered connection too"
        );
    }

    // --- T1.1: agent-authored comments converge instead of duplicating -------

    /// Fixture shared by the convergence tests: a one-revision session and a
    /// request builder whose author is the only thing that varies.
    fn convergence_store() -> SessionStore {
        let store = make_store();
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);
        store
    }

    fn agent_req(
        author: Option<&str>,
        kind: crate::state::CommentKind,
        body: &str,
    ) -> NewCommentRequest {
        NewCommentRequest {
            id: None,
            kind,
            scope: None,
            anchor_id: "A".to_string(),
            block_id: Some("rl:blk-1".to_string()),
            structural: None,
            body: body.to_string(),
            edit: None,
            selection: None,
            author: author.map(|a| a.to_string()),
            reviewer: None,
            external_created_at: None,
            share_request_id: None,
            attachments: Vec::new(),
        }
    }

    /// A replayed agent finding returns the comment that already exists —
    /// same id, same timestamp — instead of minting a ghost. Everything that
    /// makes it a *different* finding still mints.
    #[test]
    fn agent_duplicate_feedback_converges_to_existing_comment() {
        use crate::state::CommentKind;
        let store = convergence_store();

        let first = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        assert_eq!(first.id, "c-001");

        // The replay: byte-identical, and with incidental whitespace, since
        // the payload is re-serialized on the way back in.
        let replay = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        assert_eq!(replay.id, "c-001", "a replayed agent finding must converge");
        assert_eq!(replay.created_at, first.created_at, "and keep its identity");
        let padded = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "  anchor drifts \n"))
            .unwrap();
        assert_eq!(padded.id, "c-001", "convergence is on the trimmed body");

        // Different body, different author, different kind — all new work.
        let other_body = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "other point"))
            .unwrap();
        assert_eq!(other_body.id, "c-002");
        let other_author = store
            .add_comment(
                "s",
                agent_req(Some("claude-code"), CommentKind::Feedback, "anchor drifts"),
            )
            .unwrap();
        assert_eq!(other_author.id, "c-003", "two agents can raise the same point");
        let other_kind = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Question, "anchor drifts"))
            .unwrap();
        assert_eq!(other_kind.id, "c-004", "a question is not the feedback");

        let total = store.get("s").unwrap().revisions.last().unwrap().comments.len();
        assert_eq!(total, 4);
    }

    /// The exact `5f85766f` shape: submit, restore the session, then let the
    /// agent replay its feedback against the restored revision. The originals
    /// were carried forward, not deleted, so the replay must find them.
    #[test]
    fn agent_duplicate_across_restored_revision_converges() {
        use crate::state::CommentKind;
        let store = convergence_store();

        let original = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        store.mark_submitted("s");
        store.restore_latest("s").expect("restored");

        let replay = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        assert_eq!(
            replay.id, original.id,
            "the restored revision hides the original from the UI, not from the store"
        );

        let session = store.get("s").unwrap();
        let ghosts = session
            .revisions
            .iter()
            .flat_map(|r| r.comments.iter())
            .filter(|c| c.body == "anchor drifts")
            .count();
        assert_eq!(ghosts, 1, "one finding, one comment, across every revision");
    }

    /// Once a finding is answered it is finished business — an agent raising
    /// the same point afterwards is genuinely new, and must not be swallowed.
    #[test]
    fn agent_duplicate_after_resolution_mints_a_new_comment() {
        use crate::state::CommentKind;
        let store = convergence_store();

        let first = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        store.mark_submitted("s");
        let mut resolutions = HashMap::new();
        resolutions.insert(first.id.clone(), "fixed in v2".to_string());
        store.attach_resolutions("s", &resolutions, 1);

        let again = store
            .add_comment("s", agent_req(Some("voice"), CommentKind::Feedback, "anchor drifts"))
            .unwrap();
        assert_ne!(again.id, first.id, "a resolved comment does not absorb a fresh raise");
    }

    /// Human comments keep minting. A reviewer typing the same correction on
    /// two blocks is legitimate and happens in the live record — the
    /// convergence rule is scoped to agent authors on purpose.
    #[test]
    fn human_identical_edits_still_mint_new_ids() {
        use crate::state::{CommentKind, EditPayload};
        let store = convergence_store();

        let mut req = || {
            let mut r = agent_req(None, CommentKind::Edit, "tighten this");
            r.edit = Some(EditPayload {
                original: "the thing".to_string(),
                revised: "this".to_string(),
            });
            r
        };
        let a = store.add_comment("s", req()).unwrap();
        let b = store.add_comment("s", req()).unwrap();
        assert_eq!(a.id, "c-001");
        assert_eq!(b.id, "c-002", "identical human edits stay distinct comments");

        // And an agent edit with a DIFFERENT payload is different work even
        // when the prose body matches.
        let mut agent_edit = || {
            let mut r = agent_req(Some("claude-code"), CommentKind::Edit, "tighten this");
            r.edit = Some(EditPayload {
                original: "the thing".to_string(),
                revised: "this".to_string(),
            });
            r
        };
        let c = store.add_comment("s", agent_edit()).unwrap();
        let c_replay = store.add_comment("s", agent_edit()).unwrap();
        assert_eq!(c_replay.id, c.id, "an identical agent edit converges");
        let mut different = agent_edit();
        different.edit = Some(EditPayload {
            original: "the thing".to_string(),
            revised: "that".to_string(),
        });
        let d = store.add_comment("s", different).unwrap();
        assert_ne!(d.id, c.id, "a different revised text is a different edit");
    }

    // --- T1.3: the resolution ledger emits stay wired -----------------------

    /// Accepting a resolution is a decision, and the ledger row must point at
    /// the COMMENT — not the session — or the Timeline can't tell which
    /// finding was accepted.
    #[test]
    fn accepting_a_resolution_records_a_comment_scoped_ledger_event() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        let c = store
            .add_comment("s", agent_req(None, CommentKind::Feedback, "narrow this"))
            .unwrap();
        store.mark_submitted("s");
        let mut resolutions = HashMap::new();
        resolutions.insert(c.id.clone(), "narrowed".to_string());
        store.attach_resolutions("s", &resolutions, 2);
        assert!(store.accept_resolution("s", &c.id));

        let events = db.list_session_events("s").unwrap();
        let resolution: Vec<_> = events.iter().filter(|e| e.kind == "resolution").collect();
        assert_eq!(resolution.len(), 1, "exactly one resolution event");
        assert_eq!(resolution[0].ref_kind.as_deref(), Some("comment"));
        assert_eq!(
            resolution[0].ref_id.as_deref(),
            Some(c.id.as_str()),
            "the event names the accepted comment"
        );
        assert_eq!(resolution[0].session_id.as_deref(), Some("s"));
    }

    /// Reopening is the other half of the loop and is scoped the same way.
    #[test]
    fn reopening_records_a_comment_scoped_reopen_event() {
        use crate::state::CommentKind;
        let db = Arc::new(Database::open_in_memory().unwrap());
        let store = SessionStore::new(db.clone());
        let md = "# Plan\n\nBody.\n";
        store.upsert_plan("s", "/tmp/s", md.to_string(), reparse_sections(md), true, false);

        let c = store
            .add_comment("s", agent_req(None, CommentKind::Feedback, "narrow this"))
            .unwrap();
        store.mark_submitted("s");
        let mut resolutions = HashMap::new();
        resolutions.insert(c.id.clone(), "narrowed".to_string());
        store.attach_resolutions("s", &resolutions, 2);
        assert!(store.reopen_resolution("s", &c.id, Some("still too broad"), false));

        let events = db.list_session_events("s").unwrap();
        let reopen: Vec<_> = events.iter().filter(|e| e.kind == "reopen").collect();
        assert_eq!(reopen.len(), 1, "exactly one reopen event");
        assert_eq!(reopen[0].ref_kind.as_deref(), Some("comment"));
        assert_eq!(
            reopen[0].ref_id.as_deref(),
            Some(c.id.as_str()),
            "a session-scoped reopen would lose which finding came back"
        );
    }

    // --- T1.2: the one-time ghost repair ------------------------------------

    /// Reproduces the live `5f85766f` shape and every near miss it must leave
    /// alone: the ghost flips, a human duplicate doesn't, an agent duplicate
    /// with no answered twin doesn't, and a second run is a no-op.
    #[test]
    fn ghost_repair_withdraws_only_superseded_agent_rows() {
        use crate::state::{
            AttachState, Comment, CommentKind, CommentStatus, Resolution, ReviewSession, Revision,
            SessionStatus,
        };
        let db = Database::open_in_memory().unwrap();
        db.upsert_session(&ReviewSession {
            session_id: "s-ghost".to_string(),
            project_path: "/repo/ghost".to_string(),
            project_name: "ghost".to_string(),
            created_at: 1,
            revisions: Vec::new(),
            status: SessionStatus::InReview,
            attach_state: AttachState::Idle,
            updated_at: 1,
            run_state: None,
            backend: None,
            model: None,
        effort: None,
        })
        .unwrap();
        db.insert_revision(
            "s-ghost",
            &Revision {
                version_number: 1,
                received_at: 1,
                raw_plan_markdown: "# plan".to_string(),
                sections: Vec::new(),
                comments: Vec::new(),
                thread_start: true,
                restored: false,
            },
        )
        .unwrap();

        let mk = |id: &str, author: Option<&str>, status: CommentStatus, body: &str, at: i64| {
            Comment {
                id: id.to_string(),
                kind: CommentKind::Feedback,
                scope: None,
                anchor_id: "A".to_string(),
                block_id: None,
                body: body.to_string(),
                structural: None,
                edit: None,
                created_at: at,
                status,
                resolution: matches!(status, CommentStatus::Resolved | CommentStatus::Accepted)
                    .then(|| Resolution {
                        body: "answered".to_string(),
                        appeared_in_version: 1,
                        accepted_at: None,
                    }),
                selection: None,
                reopen_note: None,
                reopen_history: Vec::new(),
                actionable: false,
                author: author.map(|a| a.to_string()),
                agent_state: None,
                reviewer: None,
                external_created_at: None,
                share_request_id: None,
                attachments: Vec::new(),
            }
        };
        let insert = |c: &Comment| db.insert_comment("s-ghost", 1, c).unwrap();

        // The ghost: agent-authored, submitted, answered later by an identical
        // row. This is the exact 5f85766f pair.
        insert(&mk("c-001", Some("voice"), CommentStatus::Submitted, "anchor drifts", 100));
        insert(&mk("c-002", Some("voice"), CommentStatus::Resolved, "anchor drifts", 200));
        // A human duplicate in the same shape — must survive untouched.
        insert(&mk("c-003", None, CommentStatus::Submitted, "same problem here", 100));
        insert(&mk("c-004", None, CommentStatus::Resolved, "same problem here", 200));
        // An agent duplicate with no ANSWERED twin — still open work.
        insert(&mk("c-005", Some("voice"), CommentStatus::Submitted, "still open", 100));
        insert(&mk("c-006", Some("voice"), CommentStatus::Submitted, "still open", 200));
        // A different agent said the same thing — not the same finding.
        insert(&mk("c-007", Some("claude-code"), CommentStatus::Submitted, "anchor drifts", 100));
        // And the ANSWERED row itself is never touched, in either direction:
        // the later copy is the one that carries the resolution.

        let status_of = |id: &str| -> String {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT status FROM comments WHERE session_id = 's-ghost' AND id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };

        // `open_in_memory` already ran the migration once and latched the
        // marker, so clear it to exercise the repair against these rows.
        let run_repair = || {
            let conn = db.conn.lock().unwrap();
            Database::repair_superseded_agent_comments(&conn).unwrap();
        };
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM app_settings WHERE key = 'repair_ghost_comments_v1'",
                [],
            )
            .unwrap();
        }
        run_repair();

        assert_eq!(status_of("c-001"), "withdrawn", "the ghost is retired");
        assert_eq!(status_of("c-002"), "resolved", "the answered copy is the record");
        assert_eq!(status_of("c-003"), "submitted", "human duplicates are legitimate");
        assert_eq!(status_of("c-004"), "resolved");
        assert_eq!(status_of("c-005"), "submitted", "no answered twin, still open work");
        assert_eq!(status_of("c-006"), "submitted");
        assert_eq!(
            status_of("c-007"),
            "submitted",
            "a different agent raising the same point is a different finding"
        );

        // Resolution data is untouched — the repair only moves `status`.
        let res: Option<String> = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT resolution_body FROM comments WHERE session_id = 's-ghost' AND id = 'c-002'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(res.as_deref(), Some("answered"));

        // Exactly-once: a fresh ghost appearing after the marker is latched is
        // NOT swept — T1.1 is what stops new ones, not a recurring sweep.
        insert(&mk("c-008", Some("voice"), CommentStatus::Submitted, "late ghost", 300));
        insert(&mk("c-009", Some("voice"), CommentStatus::Resolved, "late ghost", 400));
        run_repair();
        assert_eq!(status_of("c-008"), "submitted", "the second run is a no-op");

        // And the marker records how many rows moved.
        assert_eq!(
            db.get_setting("repair_ghost_comments_v1").as_deref(),
            Some("1"),
            "the marker carries the repair's own count"
        );
    }
}

// Native execution graph transactions. doc_json is the rehydration artifact;
// normalized rows and its revision are written in the SAME transaction.
impl Database {
    fn runner_read(
        conn: &Connection,
        run_id: &str,
    ) -> Result<crate::runner_graph::RunGraph, String> {
        let json: String = conn
            .query_row(
                "SELECT doc_json FROM run_graphs WHERE run_id=?1",
                [run_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }
    fn runner_claim_rows(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<crate::runner_graph::RunClaim>, String> {
        let mut stmt = conn.prepare("SELECT path,node_id,claimed_at,released_at FROM run_claims WHERE run_id=?1 ORDER BY path,node_id").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([run_id], |r| {
                Ok(crate::runner_graph::RunClaim {
                    path: r.get(0)?,
                    node_id: r.get(1)?,
                    claimed_at: r.get(2)?,
                    released_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }
    fn runner_write(
        conn: &Connection,
        graph: &crate::runner_graph::RunGraph,
    ) -> Result<(), String> {
        crate::runner_graph::validate(graph)?;
        let json = serde_json::to_string(graph).map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO run_graphs(run_id,plan_session_id,project_path,status,doc_json,rev,max_write_parallel,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,doc_json=excluded.doc_json,rev=excluded.rev,max_write_parallel=excluded.max_write_parallel,updated_at=excluded.updated_at", params![graph.run_id,graph.plan_session_id,graph.project_path,graph.status,json,graph.rev,graph.max_write_parallel,graph.created_at,graph.updated_at]).map_err(|e|e.to_string())?;
        conn.execute("DELETE FROM run_nodes WHERE run_id=?1", [&graph.run_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM run_edges WHERE run_id=?1", [&graph.run_id])
            .map_err(|e| e.to_string())?;
        for n in &graph.nodes {
            conn.execute("INSERT INTO run_nodes(run_id,node_id,kind,title,brief,plan_block_id,seat,backend,model,effort,scope_hint,enforce_scope,verify_cmd,status,attempt,max_attempts,child_session_id,started_at,ended_at,meter_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",params![graph.run_id,n.id,n.kind,n.title,n.brief,n.plan_block_id,n.seat,n.backend,n.model,n.effort,serde_json::to_string(&n.scope_hint).unwrap(),n.enforce_scope,n.verify_cmd,n.status,n.attempt,n.max_attempts,n.child_session_id,n.started_at,n.ended_at,n.meter.as_ref().map(serde_json::Value::to_string)]).map_err(|e|e.to_string())?;
            if crate::runner_graph::terminal(&n.status) {
                conn.execute("UPDATE run_claims SET released_at=?3 WHERE run_id=?1 AND node_id=?2 AND released_at IS NULL",params![graph.run_id,n.id,graph.updated_at]).map_err(|e|e.to_string())?;
            }
        }
        for e in &graph.edges {
            conn.execute(
                "INSERT INTO run_edges(run_id,from_id,to_id,type) VALUES(?1,?2,?3,?4)",
                params![graph.run_id, e.from, e.to, e.edge_type],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn runner_create(&self, graph: &crate::runner_graph::RunGraph) -> Result<(), String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if tx
            .query_row(
                "SELECT 1 FROM run_graphs WHERE run_id=?1",
                [&graph.run_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("run already exists".into());
        }
        Self::runner_write(&tx, graph)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn runner_get(&self, run_id: &str) -> Result<crate::runner_graph::RunGraph, String> {
        Self::runner_read(&self.lock_conn(), run_id)
    }
    pub fn runner_list(&self) -> Result<Vec<crate::runner_graph::RunGraph>, String> {
        let conn = self.lock_conn();
        let mut stmt = conn
            .prepare("SELECT doc_json FROM run_graphs ORDER BY updated_at DESC LIMIT 100")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .collect()
    }
    pub fn runner_claims(
        &self,
        run_id: &str,
    ) -> Result<Vec<crate::runner_graph::RunClaim>, String> {
        Self::runner_claim_rows(&self.lock_conn(), run_id)
    }
    /// Check, mutate, normalize, and release terminal claims under one DB lock.
    pub fn runner_update(
        &self,
        run_id: &str,
        base_rev: Option<i64>,
        change: impl FnOnce(
            &mut crate::runner_graph::RunGraph,
            &[crate::runner_graph::RunClaim],
        ) -> Result<(), String>,
    ) -> Result<crate::runner_graph::RunGraph, String> {
        // Keep the transaction machinery shared across the runner's many
        // distinct closures while preserving the public single-use contract.
        let mut change = Some(change);
        self.runner_update_inner(run_id, base_rev, &mut |graph, claims| {
            change.take().expect("runner update callback called once")(graph, claims)
        })
    }
    #[inline(never)]
    fn runner_update_inner(
        &self,
        run_id: &str,
        base_rev: Option<i64>,
        change: &mut dyn FnMut(
            &mut crate::runner_graph::RunGraph,
            &[crate::runner_graph::RunClaim],
        ) -> Result<(), String>,
    ) -> Result<crate::runner_graph::RunGraph, String> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut graph = Self::runner_read(&tx, run_id)?;
        let previous = graph.rev;
        if base_rev.is_some_and(|r| r != previous) {
            return Err(format!(
                "409: stale revision; current revision is {previous}"
            ));
        }
        let claims = Self::runner_claim_rows(&tx, run_id)?;
        change(&mut graph, &claims)?;
        graph.rev = previous + 1;
        graph.updated_at = crate::state::now_millis();
        Self::runner_write(&tx, &graph)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(graph)
    }
    /// A claim is both a permission decision and a durable write. The partial
    /// unique index is the final invariant; the lock also serializes barriers.
    pub fn runner_claim(&self, run_id: &str, node_id: &str, path: &str, attempt: u32) -> Result<(), String> {
        use crate::runner_graph::{check_coverage, live, scope_matches};
        let mut conn = self.lock_conn();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let g = Self::runner_read(&tx, run_id)?;
        if !["running", "paused"].contains(&g.status.as_str()) {
            return Err("run is not active".into());
        }
        let node = g
            .nodes
            .iter()
            .find(|n| n.id == node_id && n.kind == "task" && live(&n.status))
            .ok_or("node has no active write-capable turn")?;
        if attempt == 0 || node.attempt != attempt {
            return Err("stale run attempt cannot claim writes".into());
        }
        if node.enforce_scope && !node.scope_hint.iter().any(|p| scope_matches(p, path)) {
            return Err(format!("{path} is outside this node's enforced scope"));
        }
        let claims = Self::runner_claim_rows(&tx, run_id)?;
        for check in g
            .nodes
            .iter()
            .filter(|n| matches!(n.kind.as_str(), "check" | "review") && live(&n.status))
        {
            if check.kind == "review" || check.check_global || check_coverage(&g, check, &claims).contains(path) {
                return Err(format!("{path} is busy: check {} holds a verification barrier; continue other work and retry after it finishes",check.id));
            }
        }
        if let Some(c) = claims
            .iter()
            .find(|c| c.path == path && c.node_id != node_id && c.released_at.is_none())
        {
            return Err(format!("{path} is busy: node {} owns it; continue other work and retry after that node finishes",c.node_id));
        }
        tx.execute("INSERT INTO run_claims(run_id,path,node_id,claimed_at,released_at) VALUES(?1,?2,?3,?4,NULL) ON CONFLICT(run_id,path,node_id) DO UPDATE SET released_at=NULL",params![run_id,path,node_id,crate::state::now_millis()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    /// Never pretend a process survived an application restart. Claims remain
    /// held until the human explicitly retries or skips their interrupted node.
    pub fn runner_recover(&self) -> Result<Vec<crate::runner_graph::RunGraph>, String> {
        let candidates = {
            let conn = self.lock_conn();
            let mut stmt=conn.prepare("SELECT doc_json FROM run_graphs WHERE status='running' OR run_id IN (SELECT run_id FROM run_nodes WHERE status IN ('running','verifying'))").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows.into_iter()
                .map(|s| {
                    serde_json::from_str::<crate::runner_graph::RunGraph>(&s)
                        .map_err(|e| e.to_string())
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = Vec::new();
        for g in candidates {
            if g.status == "running" || g.nodes.iter().any(|n| crate::runner_graph::live(&n.status))
            {
                recovered.push(self.runner_update(&g.run_id,None,|g,_| {
                    g.status="paused".into();g.pause_reason=Some("restart".into());
                    for n in &mut g.nodes { if crate::runner_graph::live(&n.status) { n.status="awaiting_human".into(); n.output.push_str("\nRedline restarted during this turn. Retry with the saved session or skip this node."); } }
                    Ok(())
                })?);
            }
        }
        Ok(recovered)
    }
}

#[cfg(test)]
mod runner_tests {
    use super::*;
    use crate::runner_graph::RunGraph;
    fn fixture() -> RunGraph {
        serde_json::from_str(include_str!("../../src/lib/runner/fixtures/basic.json")).unwrap()
    }
    fn setup() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.runner_create(&fixture()).unwrap();
        db
    }
    fn running(db: &Database) -> RunGraph {
        db.runner_update("run-fixture", None, |g, _| {
            g.status = "running".into();
            g.nodes[0].status = "running".into();
            g.nodes[1].status = "running".into();
            g.nodes[0].attempt = 1;
            g.nodes[1].attempt = 1;
            Ok(())
        })
        .unwrap()
    }
    #[test]
    fn graph_revision_rejects_lost_updates_and_keeps_normalized_rows() {
        let db = setup();
        let g = running(&db);
        assert_eq!(g.rev, 1);
        assert!(db
            .runner_update("run-fixture", Some(0), |g, _| {
                g.status = "done".into();
                Ok(())
            })
            .unwrap_err()
            .starts_with("409"));
        assert_eq!(db.runner_get("run-fixture").unwrap().status, "running");
        let conn = db.lock_conn();
        let status: String = conn
            .query_row(
                "SELECT status FROM run_nodes WHERE node_id='n-api'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "running");
    }
    #[test]
    fn single_use_update_error_preserves_graph_rows_revision_and_claims() {
        let db = setup();
        let before = running(&db);
        db.runner_claim("run-fixture", "n-api", "claimed.rs", 1).unwrap();
        let replacement = String::from("passed");
        let mut calls = 0;
        let result = db.runner_update("run-fixture", Some(before.rev), |g, _| {
            calls += 1;
            // Moving this String out makes the callback FnOnce, not FnMut.
            g.nodes[0].status = replacement;
            g.status = "done".into();
            Err("mutation failed".into())
        });
        assert_eq!(calls, 1);
        assert_eq!(result.unwrap_err(), "mutation failed");
        assert_eq!(db.runner_get("run-fixture").unwrap(), before);
        assert!(db.runner_claims("run-fixture").unwrap()[0].released_at.is_none());
        let status: String = db.lock_conn().query_row(
            "SELECT status FROM run_nodes WHERE node_id='n-api'", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(status, "running");
    }
    #[test]
    fn first_write_claims_and_terminal_release_serialize_real_paths() {
        let db = setup();
        running(&db);
        db.runner_claim("run-fixture", "n-api", "shared.ts", 1)
            .unwrap();
        assert!(db
            .runner_claim("run-fixture", "n-ui", "shared.ts", 1)
            .unwrap_err()
            .contains("n-api"));
        db.runner_update("run-fixture", None, |g, _| {
            g.nodes[0].status = "passed".into();
            Ok(())
        })
        .unwrap();
        db.runner_claim("run-fixture", "n-ui", "shared.ts", 1).unwrap();
        assert_eq!(
            db.runner_claims("run-fixture")
                .unwrap()
                .iter()
                .filter(|c| c.released_at.is_none())
                .count(),
            1
        );
    }
    #[test]
    fn hints_are_not_authority_but_enforced_scope_is() {
        let db = setup();
        running(&db);
        db.runner_claim("run-fixture", "n-api", "outside.rs", 1)
            .unwrap();
        db.runner_update("run-fixture", None, |g, _| {
            g.nodes[1].enforce_scope = true;
            Ok(())
        })
        .unwrap();
        assert!(db
            .runner_claim("run-fixture", "n-ui", "not-ui.rs", 1)
            .unwrap_err()
            .contains("enforced scope"));
        db.runner_claim("run-fixture", "n-ui", "ui/view.ts", 1)
            .unwrap();
    }
    #[test]
    fn scoped_and_global_checks_veto_covered_writes() {
        let db = setup();
        running(&db);
        db.runner_claim("run-fixture", "n-api", "api/x.rs", 1).unwrap();
        db.runner_update("run-fixture", None, |g, _| {
            g.nodes[0].status = "passed".into();
            g.nodes[2].status = "verifying".into();
            g.nodes[2].check_global = false;
            Ok(())
        })
        .unwrap();
        assert!(db
            .runner_claim("run-fixture", "n-ui", "api/x.rs", 1)
            .unwrap_err()
            .contains("verification barrier"));
        db.runner_claim("run-fixture", "n-ui", "ui/free.ts", 1)
            .unwrap();
        db.runner_update("run-fixture", None, |g, _| {
            g.nodes[2].check_global = true;
            Ok(())
        })
        .unwrap();
        assert!(db.runner_claim("run-fixture", "n-ui", "other.rs", 1).is_err());
    }
    #[test]
    fn live_review_vetoes_every_write_even_when_marked_scoped() {
        let db=setup();running(&db);
        db.runner_claim("run-fixture","n-api","api/x.rs", 1).unwrap();
        db.runner_update("run-fixture",None,|g,_| {
            g.nodes[0].status="passed".into();
            g.nodes[2].kind="review".into();g.nodes[2].status="running".into();g.nodes[2].check_global=false;
            Ok(())
        }).unwrap();
        for path in ["api/x.rs","unrelated/new.rs"] {
            assert!(db.runner_claim("run-fixture","n-ui",path, 1).unwrap_err().contains("verification barrier"));
        }
        db.runner_update("run-fixture",None,|g,_|{g.nodes[2].status="passed".into();Ok(())}).unwrap();
        db.runner_claim("run-fixture","n-ui","api/x.rs", 1).unwrap();
    }
    #[test]
    fn recovered_old_attempt_cannot_write_after_successor_starts() {
        let db=setup();running(&db);
        db.runner_claim("run-fixture","n-api","before.rs",1).unwrap();
        db.runner_recover().unwrap();
        assert!(db.runner_claim("run-fixture","n-api","recovered.rs",1).is_err());
        db.runner_update("run-fixture",None,|g,_| {
            g.status="running".into();g.nodes[0].status="running".into();g.nodes[0].attempt=2;Ok(())
        }).unwrap();
        assert!(db.runner_claim("run-fixture","n-api","stale.rs",1).unwrap_err().contains("stale run attempt"));
        assert!(db.runner_claim("run-fixture","n-api","missing.rs",0).is_err());
        db.runner_claim("run-fixture","n-api","successor.rs",2).unwrap();
        assert!(!db.runner_claims("run-fixture").unwrap().iter().any(|c|c.path=="stale.rs"));
    }
    #[test]
    fn restart_retains_claims_and_resume_handles_but_never_lies_about_processes() {
        let db = setup();
        running(&db);
        db.runner_claim("run-fixture", "n-api", "x.rs", 1).unwrap();
        db.runner_update("run-fixture", None, |g, _| {
            g.nodes[0].child_session_id = Some("resume-id".into());
            Ok(())
        })
        .unwrap();
        let recovered = db.runner_recover().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, "paused");
        assert_eq!(recovered[0].nodes[0].status, "awaiting_human");
        assert_eq!(
            recovered[0].nodes[0].child_session_id.as_deref(),
            Some("resume-id")
        );
        assert_eq!(
            db.runner_claims("run-fixture").unwrap()[0].released_at,
            None
        );
        assert!(db.runner_claim("run-fixture", "n-api", "new.rs", 1).is_err());
        assert!(db.runner_recover().unwrap().is_empty());
    }
    #[test]
    fn concurrent_claims_have_one_winner() {
        let db = Arc::new(setup());
        running(&db);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = ["n-api", "n-ui"]
            .into_iter()
            .map(|id| {
                let db = db.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    db.runner_claim("run-fixture", id, "same.ts", 1)
                })
            })
            .collect();
        barrier.wait();
        let wins = handles
            .into_iter()
            .filter(|h| h.thread().id() != std::thread::current().id())
            .map(|h| h.join().unwrap().is_ok())
            .filter(|v| *v)
            .count();
        assert_eq!(wins, 1);
    }
}

#[cfg(test)]
mod runner_persistence_tests {
    use super::*;
    #[test]
    fn effort_survives_status_upserts_and_disk_reload() {
        let path =
            std::env::temp_dir().join(format!("redline-effort-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let db = Database::open(&path).unwrap();
            let mut session = ReviewSession {
                session_id: "effort-session".into(),
                project_path: "/tmp".into(),
                project_name: "tmp".into(),
                created_at: 1,
                status: SessionStatus::InReview,
                attach_state: AttachState::Idle,
                updated_at: 1,
                run_state: None,
                backend: Some("codex".into()),
                model: Some("gpt-test".into()),
                effort: Some("high".into()),
                revisions: Vec::new(),
            };
            db.upsert_session(&session).unwrap();
            session.backend = None;
            session.model = None;
            session.effort = None;
            session.updated_at = 2;
            db.upsert_session(&session).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let session = db.load_session("effort-session").unwrap().unwrap();
        assert_eq!(session.backend.as_deref(), Some("codex"));
        assert_eq!(session.model.as_deref(), Some("gpt-test"));
        assert_eq!(session.effort.as_deref(), Some("high"));
        drop(db);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn disk_restart_rehydrates_graph_and_rearms_interrupted_gate() {
        let path = std::env::temp_dir().join(format!(
            "redline-run-restart-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        {
            let db = Database::open(&path).unwrap();
            let mut graph: crate::runner_graph::RunGraph =
                serde_json::from_str(include_str!("../../src/lib/runner/fixtures/basic.json"))
                    .unwrap();
            graph.status = "running".into();
            graph.nodes[0].status = "running".into();
            graph.nodes[0].attempt = 1;
            graph.nodes[0].child_session_id = Some("saved-context".into());
            db.runner_create(&graph).unwrap();
            db.runner_claim(&graph.run_id, "n-api", "api/durable.rs", 1)
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let recovered = db.runner_recover().unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].nodes[0].status, "awaiting_human");
        assert_eq!(
            recovered[0].nodes[0].child_session_id.as_deref(),
            Some("saved-context")
        );
        assert_eq!(
            db.runner_claims("run-fixture").unwrap()[0].released_at,
            None
        );
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
